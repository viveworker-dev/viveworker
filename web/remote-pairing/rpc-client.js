/**
 * web/remote-pairing/rpc-client.js — Phone-side fetch-shaped client over the
 * Noise+envelope transport.
 *
 * The phone PWA used to talk to the bridge over LAN HTTP. Now, when the
 * phone is off-LAN, the same calls go through `RemotePairingTransport`
 * (Noise + envelope over a relay WebSocket). This module is the application
 * layer that turns transport.send/onMessage into a fetch-like API:
 *
 *   const client = new RemotePairingRpcClient({
 *     relayUrl: "wss://pairing.viveworker.com",
 *     pairingId,
 *     identityKeypair,        // phone's static X25519 keypair
 *     remoteStatic,           // bridge's static pub (from LAN pairing)
 *     onConnected: () => {},
 *     onDisconnected: ({ reason }) => {},
 *     onEvent: (topic, data) => {},   // optional global event handler
 *   });
 *   await client.connect();
 *   const res = await client.fetch({
 *     method: "POST",
 *     path: "/api/foo",
 *     headers: { "content-type": "application/json" },
 *     body: JSON.stringify({...}),
 *     signal: ac.signal,            // cancels via cancel-frame
 *     timeoutMs: 30_000,             // optional override
 *   });
 *   // res = { status, headers, text, json, bytes, arrayBuffer }
 *
 * Design choices:
 *   - Composition, not inheritance. The client owns a RemotePairingTransport
 *     internally; callers don't construct one themselves. This keeps the
 *     onMessage/onStateChange callbacks tightly bound to id-correlation
 *     bookkeeping.
 *   - In-flight pending requests survive transient reconnects. The transport
 *     handles RESUME — the relay replays missed frames — so a response that
 *     arrives after a disconnect/reconnect still lands on the right id.
 *   - On *fatal* (FAILED) state the client rejects every pending request.
 *     The transport considers RESUME_FAIL "permanent" and pushes itself to
 *     FAILED; we mirror that by failing all pending fetches.
 *   - Body encoding is auto-detected: string → utf8, Uint8Array/ArrayBuffer
 *     → base64. Response bodies preserve their bodyEncoding and the result
 *     object exposes `.text()` / `.json()` / `.bytes()` / `.arrayBuffer()`
 *     helpers so callers don't have to think about it.
 */

import {
  RemotePairingTransport,
  STATE,
} from "./transport.js";
import {
  encodeRequest,
  encodeCancel,
  decodeRpc,
  RPC,
  MAX_RPC_ID_LEN,
} from "../remote-pairing.bundle.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for an individual fetch — 60s covers long-poll inboxes. */
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// RemotePairingRpcClient
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RpcClientOptions
 * Mostly forwarded to RemotePairingTransport (see transport.js for details).
 *
 * @property {string} relayUrl
 * @property {string} pairingId
 * @property {{priv: Uint8Array, pub: Uint8Array}} identityKeypair
 * @property {Uint8Array} remoteStatic              bridge's static pub
 * @property {"phone" | "bridge"} [role]            defaults "phone"
 * @property {boolean} [initiator]                  defaults true (phone is initiator)
 * @property {Uint8Array} [prologue]
 * @property {number} [pingIntervalMs]
 * @property {number[]} [backoffMs]
 * @property {number} [handshakeTimeoutMs]
 * @property {typeof WebSocket} [WebSocketImpl]
 *
 * Application hooks (optional):
 * @property {() => void} [onConnected]             fires every time CONNECTED is reached
 * @property {(info: object) => void} [onDisconnected] fires when leaving CONNECTED
 * @property {(state: string, prev: string, info?: object) => void} [onStateChange]
 * @property {(err: Error) => void} [onError]
 * @property {(topic: string, data: unknown) => void} [onEvent]
 *
 * Other:
 * @property {number} [defaultTimeoutMs]            default per-fetch timeout
 * @property {{debug?:Function, warn?:Function, error?:Function}} [logger]
 *
 * Test seam:
 * @property {(transportOpts: object) => TransportLike} [transportFactory]
 *           Override the default `RemotePairingTransport` constructor with
 *           a fake. The factory is invoked with the same options shape the
 *           transport accepts, including `onMessage` / `onStateChange` /
 *           `onError` callbacks bound to the client's internal handlers.
 *           Used by unit tests to drive the RPC layer without a real WS.
 */

/**
 * @typedef {Object} TransportLike
 * Minimal subset of RemotePairingTransport the RPC client uses.
 * @property {string} state
 * @property {boolean} isConnected
 * @property {Uint8Array | null} channelBinding
 * @property {() => Promise<void>} connect
 * @property {(plaintext: Uint8Array) => void} send
 * @property {() => void} close
 * @property {() => void} kick
 */

/**
 * @typedef {Object} RpcResponse
 * @property {number} status
 * @property {Record<string,string>} headers
 * @property {() => string} text
 * @property {() => unknown} json                  throws if body isn't JSON
 * @property {() => Uint8Array} bytes
 * @property {() => ArrayBuffer} arrayBuffer
 * @property {string} bodyRaw                      raw body string (utf8 or base64)
 * @property {"utf8" | "base64"} bodyEncoding
 */

export class RemotePairingRpcClient {
  /** @param {RpcClientOptions} opts */
  constructor(opts) {
    if (!opts) throw new TypeError("RemotePairingRpcClient: opts required");

    this._log = normalizeLogger(opts.logger);
    this._defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

    // Hooks
    this._onConnected = opts.onConnected ?? noop;
    this._onDisconnected = opts.onDisconnected ?? noop;
    this._onStateChange = opts.onStateChange ?? noop;
    this._onError = opts.onError ?? noop;
    this._onEvent = opts.onEvent ?? noop;

    /** @type {Map<string, PendingSlot>} pending fetches by id */
    this._pending = new Map();
    /** @type {Map<string, Set<(data: unknown) => void>>} per-topic listeners */
    this._listeners = new Map();
    this._closed = false;

    /**
     * Counter for request id generation. Combined with a random prefix per
     * client instance, this keeps ids unique across instances without
     * needing a heavyweight UUID. The relay won't see ids (they're inside
     * the encrypted channel), so collision risk is purely client-internal.
     */
    this._idCounter = 0;
    this._idPrefix = randHex(6); // 12 hex chars

    // Build the transport with our callbacks wired in. A test-only
    // `transportFactory` option lets unit tests substitute a fake.
    const factory = typeof opts.transportFactory === "function"
      ? opts.transportFactory
      : (transportOpts) => new RemotePairingTransport(transportOpts);

    this._transport = factory({
      relayUrl: opts.relayUrl,
      pairingId: opts.pairingId,
      role: opts.role ?? "phone",
      initiator: opts.initiator,
      identityKeypair: opts.identityKeypair,
      remoteStatic: opts.remoteStatic,
      prologue: opts.prologue,
      pingIntervalMs: opts.pingIntervalMs,
      backoffMs: opts.backoffMs,
      handshakeTimeoutMs: opts.handshakeTimeoutMs,
      WebSocketImpl: opts.WebSocketImpl,
      logger: opts.logger,

      onMessage: (pt) => this._onMessage(pt),
      onStateChange: (next, prev, info) => this._handleStateChange(next, prev, info),
      onError: (err) => this._onError(err),
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Current transport state (one of STATE.*). */
  get state() {
    return this._transport.state;
  }

  /** True iff the encrypted channel is up and `fetch()` will actually send. */
  get isConnected() {
    return this._transport.isConnected;
  }

  /** Channel binding (null until the first handshake completes). */
  get channelBinding() {
    return this._transport.channelBinding;
  }

  /** Number of currently in-flight fetch() calls. */
  get pendingCount() {
    return this._pending.size;
  }

  /**
   * Open the relay WebSocket and run the Noise handshake. Resolves when the
   * encrypted channel is up; reconnects after that are handled by the
   * transport automatically.
   */
  async connect() {
    if (this._closed) throw new RpcClientClosedError("rpc client closed");
    return this._transport.connect();
  }

  /**
   * Force an immediate reconnect attempt (skip backoff). Useful for
   * visibilitychange / Web Push wake events.
   */
  kick() {
    if (this._closed) return;
    this._transport.kick();
  }

  /**
   * Tear down. Rejects every pending fetch with `RpcClientClosedError`,
   * closes the transport, and stops accepting new fetches/connects.
   * Idempotent.
   */
  close() {
    if (this._closed) return;
    this._closed = true;

    // Fail every in-flight request.
    const err = new RpcClientClosedError("rpc client closed");
    for (const slot of this._pending.values()) {
      this._cleanupSlot(slot);
      slot.reject(err);
    }
    this._pending.clear();

    // Drop topic listeners — they aren't pending requests but callers
    // shouldn't keep getting events post-close.
    this._listeners.clear();

    try { this._transport.close(); } catch (e) {
      this._log.warn?.(`transport.close threw: ${e?.message}`);
    }
  }

  /**
   * Send a fetch-shaped request. The promise resolves with an `RpcResponse`
   * once the bridge's response arrives, or rejects on timeout / abort /
   * transport failure / cancel-by-peer.
   *
   * @param {{
   *   method: string,
   *   path: string,
   *   headers?: Record<string,string>,
   *   body?: string | Uint8Array | ArrayBuffer | null,
   *   bodyEncoding?: "utf8" | "base64",
   *   signal?: AbortSignal,
   *   timeoutMs?: number,
   * }} req
   * @returns {Promise<RpcResponse>}
   */
  fetch(req) {
    if (this._closed) {
      return Promise.reject(new RpcClientClosedError("rpc client closed"));
    }
    if (!req || typeof req !== "object") {
      return Promise.reject(new TypeError("fetch: req object required"));
    }
    if (typeof req.method !== "string" || typeof req.path !== "string") {
      return Promise.reject(new TypeError("fetch: method + path required (strings)"));
    }
    if (req.signal?.aborted) {
      return Promise.reject(abortError(req.signal));
    }

    const id = this._nextId();
    let body, bodyEncoding;
    try {
      ({ body, bodyEncoding } = normalizeBody(req.body, req.bodyEncoding));
    } catch (err) {
      return Promise.reject(err);
    }

    let frame;
    try {
      frame = encodeRequest({
        id,
        method: req.method,
        path: req.path,
        headers: req.headers,
        body,
        bodyEncoding,
      });
    } catch (err) {
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      const timeoutMs = req.timeoutMs ?? this._defaultTimeoutMs;
      /** @type {ReturnType<typeof setTimeout> | null} */
      const timer = timeoutMs > 0
        ? setTimeout(() => this._timeoutSlot(id), timeoutMs)
        : null;

      /** @type {(() => void) | null} */
      let abortHandler = null;
      if (req.signal) {
        abortHandler = () => this._abortSlot(id, req.signal);
        req.signal.addEventListener("abort", abortHandler, { once: true });
      }

      /** @type {PendingSlot} */
      const slot = {
        id,
        resolve,
        reject,
        timer,
        signal: req.signal ?? null,
        abortHandler,
        sent: false,
      };
      this._pending.set(id, slot);

      // Send. If the transport rejects synchronously (not connected),
      // surface that as a fetch error.
      try {
        this._transport.send(frame);
        slot.sent = true;
      } catch (err) {
        this._cleanupSlot(slot);
        this._pending.delete(id);
        reject(wrapTransportError(err));
      }
    });
  }

  /**
   * Subscribe to server-pushed events on a given topic. Returns an
   * unsubscribe function. The constructor's `onEvent` hook also receives
   * every event — `on()` is for topic-scoped subscribers.
   *
   * @param {string} topic
   * @param {(data: unknown) => void} handler
   * @returns {() => void}
   */
  on(topic, handler) {
    if (typeof topic !== "string" || topic.length === 0) {
      throw new TypeError("on: topic required (non-empty string)");
    }
    if (typeof handler !== "function") {
      throw new TypeError("on: handler required (function)");
    }
    let set = this._listeners.get(topic);
    if (!set) {
      set = new Set();
      this._listeners.set(topic, set);
    }
    set.add(handler);
    return () => this.off(topic, handler);
  }

  /** @param {string} topic @param {(data: unknown) => void} handler */
  off(topic, handler) {
    const set = this._listeners.get(topic);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this._listeners.delete(topic);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** @returns {string} new request id */
  _nextId() {
    // Format: "<prefix>-<counter-base36>" — short, unique per client instance.
    const id = `${this._idPrefix}-${(this._idCounter++).toString(36)}`;
    if (id.length > MAX_RPC_ID_LEN) {
      // Counter wraparound is wildly improbable (would need 36^N requests in
      // one client) but defensively reset rather than blow past the cap.
      this._idPrefix = randHex(6);
      this._idCounter = 0;
      return `${this._idPrefix}-0`;
    }
    return id;
  }

  /** @param {Uint8Array} plaintext */
  _onMessage(plaintext) {
    /** @type {ReturnType<typeof decodeRpc>} */
    let frame;
    try {
      frame = decodeRpc(plaintext);
    } catch (err) {
      this._log.warn?.(`rpc decode failed: ${err?.message}`);
      this._onError(new Error(`rpc decode failed: ${err?.message}`));
      return;
    }

    switch (frame.type) {
      case RPC.RESPONSE: {
        const slot = this._pending.get(frame.id);
        if (!slot) {
          // Late or unknown response — bridge cancelled but we already
          // gave up locally, or the id is from an older client run that
          // RESUMEd into us. Either way, drop quietly.
          this._log.debug?.(`rpc: dropping response for unknown id ${frame.id}`);
          return;
        }
        this._pending.delete(frame.id);
        this._cleanupSlot(slot);
        slot.resolve(makeResponse(frame));
        return;
      }
      case RPC.EVENT: {
        // Per-topic subscribers
        const set = this._listeners.get(frame.topic);
        if (set) {
          for (const fn of [...set]) {
            try { fn(frame.data); }
            catch (err) {
              this._log.warn?.(`event handler for ${frame.topic} threw: ${err?.message}`);
            }
          }
        }
        // Global hook — every event regardless of topic
        try { this._onEvent(frame.topic, frame.data); }
        catch (err) {
          this._log.warn?.(`onEvent hook threw: ${err?.message}`);
        }
        return;
      }
      case RPC.CANCEL: {
        // Server-initiated cancel for a request the bridge previously
        // answered with a streaming/incremental response. Our v1 only
        // supports unary req/res, so a cancel from the bridge means the
        // bridge is telling us it gave up — fail the matching slot.
        const slot = this._pending.get(frame.id);
        if (slot) {
          this._pending.delete(frame.id);
          this._cleanupSlot(slot);
          slot.reject(new RpcCancelledByPeerError(`bridge cancelled request ${frame.id}`));
        }
        return;
      }
      case RPC.REQUEST:
        // Phone shouldn't receive RPC requests from the bridge today —
        // dispatch is one-directional (phone → bridge). Log and drop.
        this._log.warn?.("rpc: ignoring unexpected request from bridge");
        return;
    }
  }

  /** @param {string} state @param {string} prev @param {object} [info] */
  _handleStateChange(state, prev, info) {
    // Surface to caller's general state-change hook first.
    try { this._onStateChange(state, prev, info); }
    catch (err) {
      this._log.warn?.(`onStateChange hook threw: ${err?.message}`);
    }

    // Specific entry/exit hooks.
    if (state === STATE.CONNECTED && prev !== STATE.CONNECTED) {
      try { this._onConnected(); } catch (err) {
        this._log.warn?.(`onConnected hook threw: ${err?.message}`);
      }
    }
    if (prev === STATE.CONNECTED && state !== STATE.CONNECTED) {
      try { this._onDisconnected(info ?? {}); } catch (err) {
        this._log.warn?.(`onDisconnected hook threw: ${err?.message}`);
      }
    }

    // FAILED is terminal — fail every pending request immediately. The
    // transport won't reconnect from FAILED so the response would never
    // arrive, and callers want a real error rather than a stuck promise.
    if (state === STATE.FAILED) {
      const err = new RpcTransportFailedError(
        `transport entered FAILED state (${describeInfo(info)})`,
      );
      for (const [id, slot] of this._pending) {
        this._cleanupSlot(slot);
        slot.reject(err);
        this._pending.delete(id);
      }
    }
  }

  _timeoutSlot(id) {
    const slot = this._pending.get(id);
    if (!slot) return;
    this._pending.delete(id);
    this._cleanupSlot(slot);
    // Best-effort cancel to free bridge-side resources.
    this._safeSendCancel(id);
    slot.reject(new RpcTimeoutError(`rpc timed out (id=${id})`));
  }

  /** @param {string} id @param {AbortSignal} signal */
  _abortSlot(id, signal) {
    const slot = this._pending.get(id);
    if (!slot) return;
    this._pending.delete(id);
    this._cleanupSlot(slot);
    this._safeSendCancel(id);
    slot.reject(abortError(signal));
  }

  /** @param {string} id */
  _safeSendCancel(id) {
    if (!this._transport.isConnected) return; // can't send; bridge will GC anyway
    try {
      this._transport.send(encodeCancel(id));
    } catch (err) {
      this._log.debug?.(`cancel-send failed (id=${id}): ${err?.message}`);
    }
  }

  /** @param {PendingSlot} slot */
  _cleanupSlot(slot) {
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    if (slot.signal && slot.abortHandler) {
      try { slot.signal.removeEventListener("abort", slot.abortHandler); } catch {}
      slot.abortHandler = null;
    }
  }
}

// ===========================================================================
// Error types — typed so callers can `instanceof` and react accordingly.
// ===========================================================================

export class RpcTimeoutError extends Error {
  constructor(message) { super(message); this.name = "RpcTimeoutError"; }
}

export class RpcClientClosedError extends Error {
  constructor(message) { super(message); this.name = "RpcClientClosedError"; }
}

export class RpcTransportFailedError extends Error {
  constructor(message) { super(message); this.name = "RpcTransportFailedError"; }
}

export class RpcCancelledByPeerError extends Error {
  constructor(message) { super(message); this.name = "RpcCancelledByPeerError"; }
}

export class RpcTransportError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "RpcTransportError";
    if (cause) this.cause = cause;
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * @typedef {Object} PendingSlot
 * @property {string} id
 * @property {(value: RpcResponse) => void} resolve
 * @property {(reason: Error) => void} reject
 * @property {ReturnType<typeof setTimeout> | null} timer
 * @property {AbortSignal | null} signal
 * @property {(() => void) | null} abortHandler
 * @property {boolean} sent
 */

function noop() {}

function normalizeLogger(l) {
  if (!l) return {};
  return {
    debug: typeof l.debug === "function" ? l.debug.bind(l) : undefined,
    warn: typeof l.warn === "function" ? l.warn.bind(l) : undefined,
    error: typeof l.error === "function" ? l.error.bind(l) : undefined,
  };
}

function abortError(signal) {
  // Browser DOMException("Aborted", "AbortError") matches fetch() semantics.
  if (typeof DOMException === "function") {
    return new DOMException(signal?.reason?.message ?? "Aborted", "AbortError");
  }
  // Node fallback (DOMException is a global in modern Node but be safe).
  const err = new Error(signal?.reason?.message ?? "Aborted");
  err.name = "AbortError";
  return err;
}

function wrapTransportError(err) {
  if (err instanceof RpcTransportError) return err;
  return new RpcTransportError(`transport.send failed: ${err?.message ?? err}`, err);
}

/**
 * Normalize body input: accept string / Uint8Array / ArrayBuffer / null /
 * undefined, and emit `{ body: string | undefined, bodyEncoding: "utf8" | "base64" | undefined }`
 * suitable for `encodeRequest`.
 */
function normalizeBody(body, bodyEncoding) {
  if (body == null || body === "") return { body: undefined, bodyEncoding: undefined };
  if (typeof body === "string") {
    return { body, bodyEncoding: bodyEncoding ?? "utf8" };
  }
  // Binary inputs → base64
  let bytes;
  if (body instanceof Uint8Array) {
    bytes = body;
  } else if (body instanceof ArrayBuffer) {
    bytes = new Uint8Array(body);
  } else if (ArrayBuffer.isView(body)) {
    bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  } else {
    throw new TypeError(
      "fetch: body must be string, Uint8Array, ArrayBuffer, or null",
    );
  }
  return { body: bytesToBase64(bytes), bodyEncoding: "base64" };
}

/**
 * Build the {status, headers, text(), json(), bytes(), arrayBuffer(), bodyRaw,
 * bodyEncoding} response object from a decoded RPC response frame.
 */
function makeResponse(frame) {
  const bodyRaw = frame.body ?? "";
  const bodyEncoding = frame.bodyEncoding ?? "utf8";
  /** @type {Uint8Array | null} */
  let cachedBytes = null;
  /** @type {string | null} */
  let cachedText = null;

  function bytes() {
    if (cachedBytes) return cachedBytes;
    if (bodyEncoding === "base64") {
      cachedBytes = base64ToBytes(bodyRaw);
    } else {
      cachedBytes = new TextEncoder().encode(bodyRaw);
    }
    return cachedBytes;
  }

  function text() {
    if (cachedText !== null) return cachedText;
    if (bodyEncoding === "utf8") {
      cachedText = bodyRaw;
    } else {
      cachedText = new TextDecoder("utf-8", { fatal: false }).decode(bytes());
    }
    return cachedText;
  }

  function arrayBuffer() {
    const b = bytes();
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }

  function json() {
    const t = text();
    if (t === "") return undefined;
    return JSON.parse(t);
  }

  return {
    status: frame.status,
    headers: { ...(frame.headers ?? {}) },
    bodyRaw,
    bodyEncoding,
    text,
    json,
    bytes,
    arrayBuffer,
  };
}

/**
 * Best-effort description of a state-change `info` payload for error
 * messages. Pulls the first useful field rather than dumping JSON.
 */
function describeInfo(info) {
  if (!info || typeof info !== "object") return "no info";
  if (typeof info.reason === "string") return `reason=${info.reason}`;
  if (info.error && typeof info.error.message === "string") {
    return `error=${info.error.message}`;
  }
  return "no info";
}

/** @param {number} bytes @returns {string} hex string */
function randHex(bytes) {
  const buf = new Uint8Array(bytes);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < bytes; i++) buf[i] = (Math.random() * 256) | 0;
  }
  let out = "";
  for (let i = 0; i < buf.length; i++) out += buf[i].toString(16).padStart(2, "0");
  return out;
}

// ---------------------------------------------------------------------------
// Base64 — small browser/Node-safe helpers, shared with the bridge response
// path. We can't use Node's Buffer in the browser and atob/btoa are
// browser-only, so handle both.
// ---------------------------------------------------------------------------

function bytesToBase64(bytes) {
  // btoa path (browser)
  if (typeof btoa === "function") {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  // Node path
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(b64) {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// Re-export STATE so consumers don't need a separate import for state checks.
export { STATE };
