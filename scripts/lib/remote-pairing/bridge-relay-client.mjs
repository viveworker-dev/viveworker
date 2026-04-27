/**
 * bridge-relay-client.mjs — Bridge-side glue between RemotePairingTransport
 * and the application's request dispatcher.
 *
 * Role in the system:
 *   The bridge runs ONE WebSocket per paired phone (one per `pairingId`),
 *   each holding a long-lived RemotePairingTransport in **responder** role.
 *   When a phone connects through the relay, the Noise IK handshake runs to
 *   completion and the static pubkey on the wire is checked against the
 *   on-disk paired-phones allowlist (`pairings.mjs`). Anything not in the
 *   allowlist gets dropped — Noise IK only proves "the peer holds this
 *   private key", it does not by itself say "we want to talk to this peer".
 *
 *   Once a session is up, every encrypted DATA plaintext is decoded as an
 *   RPC frame (`rpc.mjs`) and routed to a caller-supplied `dispatch()`
 *   function. The dispatcher's response is encoded, encrypted, and written
 *   back over the same channel. Cancel frames abort in-flight requests via
 *   AbortSignal. The bridge can also push events (`broadcast(topic, data)`)
 *   to all connected sessions for SSE-style notifications.
 *
 * Lifetime:
 *   `client.start()` loads the pairings list and opens one
 *   `BridgePairingSession` per pairing. Later, `client.reload()` re-reads
 *   the file and reconciles: new entries get a fresh session, removed
 *   entries are torn down, untouched entries keep their live connection.
 *
 * Concurrency model:
 *   Requests are dispatched fire-and-forget. Multiple long-running ones can
 *   be in flight per pairing. A defensive cap (`MAX_INFLIGHT_PER_SESSION`)
 *   protects the bridge from a misbehaving (or compromised) phone flooding
 *   the dispatcher; past the cap the bridge replies 503 immediately.
 *
 * Error handling:
 *   Per-frame errors are logged and dropped — one bad RPC frame doesn't
 *   tear down the session. Per-session fatal errors (handshake mismatch,
 *   pubkey not in allowlist) close that session but leave others running.
 *   The transport itself handles reconnect/RESUME internally; this module
 *   doesn't second-guess it.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

import { RemotePairingTransport, STATE } from "../../../web/remote-pairing/transport.js";
import { bytesToHex, hexToBytes } from "./keys-core.mjs";
import {
  loadPairings,
  REMOTE_PAIRINGS_FILE,
  findByPairingId,
  findByPub,
} from "./pairings.mjs";
import {
  RPC,
  decode as decodeRpc,
  encodeResponse,
  encodeEvent,
} from "./rpc.mjs";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Per-session in-flight RPC cap. Beyond this we 503 immediately so a
 * runaway client can't exhaust bridge memory by piling up open handlers.
 * Real PWA traffic is dominated by a handful of concurrent requests
 * (long-poll + a few short ones), so 64 is way above the working set.
 */
export const MAX_INFLIGHT_PER_SESSION = 64;

// ---------------------------------------------------------------------------
// BridgeRelayClient — coordinates many BridgePairingSessions
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BridgeRelayClientOptions
 * @property {string} relayUrl                     wss URL, e.g. "wss://pairing.viveworker.com"
 * @property {{priv: Uint8Array, pub: Uint8Array}} identityKeypair  bridge's own static keypair
 * @property {string} [pairingsFile]               path to pairings JSON; defaults to REMOTE_PAIRINGS_FILE
 * @property {Pairing[]} [pairings]                pre-loaded list (skips file read on start)
 * @property {DispatchFn} dispatch                 request handler — see typedef below
 * @property {OnSeenFn} [onSeen]                   stamp last-seen on a pairing (caller decides persistence)
 * @property {OnSessionStateFn} [onSessionState]   per-session state-change observer
 * @property {OnErrorFn} [onError]                 error sink (logs / metrics)
 * @property {{debug?: Function, warn?: Function, error?: Function}} [logger]
 * @property {typeof WebSocket} [WebSocketImpl]    injected `ws` for Node
 * @property {number} [pingIntervalMs]             forwarded to the transport
 * @property {number[]} [backoffMs]                forwarded to the transport
 * @property {number} [handshakeTimeoutMs]         forwarded to the transport
 * @property {Uint8Array} [prologue]               forwarded to the transport
 */

/**
 * @callback DispatchFn
 * @param {{
 *   method: string,
 *   path: string,
 *   headers: Record<string,string>,
 *   body: string | undefined,
 *   bodyEncoding: "utf8" | "base64" | undefined,
 *   signal: AbortSignal,
 *   pairing: Pairing,
 *   channelBinding: Uint8Array,
 * }} req
 * @returns {Promise<{
 *   status: number,
 *   headers?: Record<string,string>,
 *   body?: string,
 *   bodyEncoding?: "utf8" | "base64",
 * }>}
 */

/**
 * @callback OnSeenFn
 * @param {{ pairing: Pairing, atMs: number, channelBinding: Uint8Array }} info
 * @returns {void | Promise<void>}
 */

/** @callback OnSessionStateFn @param {{ pairingId: string, state: string, prev: string, info?: object }} ev */
/** @callback OnErrorFn @param {Error} err @param {{ pairingId?: string }} [ctx] */

/**
 * @typedef {import("./pairings.mjs").Pairing} Pairing
 */

export class BridgeRelayClient {
  /** @param {BridgeRelayClientOptions} opts */
  constructor(opts) {
    if (!opts?.relayUrl) throw new TypeError("relayUrl required");
    if (!opts.identityKeypair?.priv || !opts.identityKeypair?.pub) {
      throw new TypeError("identityKeypair { priv, pub } required");
    }
    if (typeof opts.dispatch !== "function") {
      throw new TypeError("dispatch function required");
    }

    this._opts = opts;
    this._relayUrl = opts.relayUrl.replace(/\/+$/, "");
    this._identityKeypair = opts.identityKeypair;
    this._pairingsFile = opts.pairingsFile ?? REMOTE_PAIRINGS_FILE;
    this._dispatch = opts.dispatch;
    this._onSeen = opts.onSeen ?? noop;
    this._onSessionState = opts.onSessionState ?? noop;
    this._onError = opts.onError ?? noop;
    this._log = normalizeLogger(opts.logger);

    /** @type {Map<string, BridgePairingSession>} */
    this._sessions = new Map();
    /** @type {Pairing[] | null} */
    this._initialPairings = opts.pairings ?? null;
    this._started = false;
    this._closed = false;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Load the pairings list (from disk or the constructor override) and open
   * a session for each entry. Idempotent: calling again is a no-op.
   */
  async start() {
    if (this._closed) throw new Error("client already closed");
    if (this._started) return;
    this._started = true;

    const list =
      this._initialPairings ??
      (await loadPairings(this._pairingsFile).catch((err) => {
        this._log.warn?.(`pairings load failed (${err.message}) — starting with empty list`);
        this._onError(err, { phase: "start" });
        return [];
      }));

    for (const p of list) {
      this._spawnSession(p);
    }
  }

  /**
   * Re-read the pairings file and reconcile sessions:
   *   - new entry → start a session
   *   - removed entry → close its session
   *   - modified entry (label change, etc.) → leave the live session alone
   *     (we track sessions by `pairingId` + `phonePub`; either changing
   *     means it's effectively a new entry)
   */
  async reload() {
    if (!this._started || this._closed) return;
    const list = await loadPairings(this._pairingsFile).catch((err) => {
      this._log.warn?.(`pairings reload failed: ${err.message}`);
      this._onError(err, { phase: "reload" });
      return null;
    });
    if (list === null) return;
    this._reconcile(list);
  }

  /** Force an immediate reconnect attempt on every session. */
  kick() {
    for (const s of this._sessions.values()) s.kick();
  }

  /**
   * Push an event to every connected session.
   *
   * @param {string} topic
   * @param {unknown} [data]
   */
  broadcast(topic, data) {
    const wire = encodeEvent({ topic, data });
    for (const s of this._sessions.values()) s.sendEncoded(wire);
  }

  /**
   * Push an event to a single session by pairingId. Returns true iff the
   * session was found AND currently connected.
   *
   * @param {string} pairingId
   * @param {string} topic
   * @param {unknown} [data]
   */
  sendEvent(pairingId, topic, data) {
    const s = this._sessions.get(pairingId);
    if (!s) return false;
    return s.sendEncoded(encodeEvent({ topic, data }));
  }

  /**
   * Snapshot of the current sessions for introspection / a debug page.
   * @returns {Array<{ pairingId: string, label: string, phonePub: string, state: string,
   *   lastSeenAtMs: number | null, channelBindingHex: string | null,
   *   phoneFingerprint: string }>}
   */
  getSessions() {
    return [...this._sessions.values()].map((s) => s.snapshot());
  }

  /** Tear down every session and stop accepting new ones. */
  close() {
    if (this._closed) return;
    this._closed = true;
    for (const s of this._sessions.values()) s.close();
    this._sessions.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** @param {Pairing} pairing */
  _spawnSession(pairing) {
    if (this._sessions.has(pairing.pairingId)) {
      this._log.warn?.(`duplicate ${pairingLogLabel(pairing)} — replacing`);
      this._sessions.get(pairing.pairingId)?.close();
    }
    const session = new BridgePairingSession({
      relayUrl: this._relayUrl,
      pairing,
      identityKeypair: this._identityKeypair,
      dispatch: this._dispatch,
      onSeen: this._onSeen,
      onStateChange: (state, prev, info) =>
        this._onSessionState({ pairingId: pairing.pairingId, state, prev, info }),
      onError: (err) => this._onError(err, { pairingId: pairing.pairingId }),
      logger: this._log,
      WebSocketImpl: this._opts.WebSocketImpl,
      pingIntervalMs: this._opts.pingIntervalMs,
      backoffMs: this._opts.backoffMs,
      handshakeTimeoutMs: this._opts.handshakeTimeoutMs,
      prologue: this._opts.prologue,
    });
    this._sessions.set(pairing.pairingId, session);
    session.start().catch((err) => {
      this._onError(err, { pairingId: pairing.pairingId });
    });
  }

  /** @param {Pairing[]} list */
  _reconcile(list) {
    const byId = new Map(list.map((p) => [p.pairingId, p]));

    // Drop sessions whose pairing was removed OR whose pubkey was reassigned
    // to a different pairingId in the new list.
    for (const [pairingId, session] of this._sessions) {
      const next = byId.get(pairingId);
      if (!next || next.phonePub !== session.pairing.phonePub || next.relayToken !== session.pairing.relayToken) {
        this._log.debug?.(`closing ${pairingLogLabel(session.pairing)} (removed or credentials rotated)`);
        session.close();
        this._sessions.delete(pairingId);
      }
    }

    // Spawn sessions for any new pairings.
    for (const p of list) {
      if (!this._sessions.has(p.pairingId)) {
        this._spawnSession(p);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// BridgePairingSession — one transport + RPC dispatch for a single pairing
// ---------------------------------------------------------------------------

class BridgePairingSession {
  constructor({
    relayUrl,
    pairing,
    identityKeypair,
    dispatch,
    onSeen,
    onStateChange,
    onError,
    logger,
    WebSocketImpl,
    pingIntervalMs,
    backoffMs,
    handshakeTimeoutMs,
    prologue,
  }) {
    this.pairing = pairing;
    this._dispatch = dispatch;
    this._onSeen = onSeen;
    this._onStateChange = onStateChange;
    this._onError = onError;
    this._log = logger;

    /** @type {Map<string, AbortController>} */
    this._inFlight = new Map();
    /** @type {Uint8Array | null} */
    this._channelBinding = null;
    /** @type {number | null} */
    this._lastSeenAtMs = null;
    this._closed = false;
    this._restartTimer = null;
    this._restartAttempt = 0;
    this._transportOpts = {
      relayUrl,
      pairingId: pairing.pairingId,
      relayToken: pairing.relayToken,
      role: "bridge",
      initiator: false,
      identityKeypair,
      // Responder doesn't need to know the remoteStatic ahead of time —
      // Noise IK reveals it during the handshake. We then validate against
      // the allowlist in `_handleHandshakeComplete`.
      onMessage: (pt) => this._handleMessage(pt),
      onStateChange: (state, prev, info) => this._handleTransportState(state, prev, info),
      onError: (err) => this._onError(err),
      onHandshakeComplete: (info) => this._handleHandshakeComplete(info),
      WebSocketImpl,
      pingIntervalMs,
      backoffMs,
      handshakeTimeoutMs,
      prologue,
      logger: logger,
    };
    this._transport = this._createTransport();
  }

  async start() {
    if (this._closed) return;
    try {
      await this._transport.connect();
    } catch (err) {
      // The first connect failed (likely couldn't open the WS at all). The
      // transport will keep retrying internally; the rejection here is just
      // the first-attempt promise. Log and keep going.
      this._log.debug?.(`initial connect rejected for ${this._logLabel()}: ${err.message}`);
    }
  }

  kick() {
    if (!this._closed) this._transport.kick();
  }

  /**
   * Send an already-encoded RPC frame (encoded by the caller, e.g. for
   * `broadcast`). Returns true iff the transport was connected and the
   * call didn't throw.
   *
   * @param {Uint8Array} bytes
   */
  sendEncoded(bytes) {
    if (this._closed || !this._transport.isConnected) return false;
    try {
      this._transport.send(bytes);
      return true;
    } catch (err) {
      this._log.warn?.(`send failed on ${this._logLabel()}: ${err.message}`);
      return false;
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._clearRestartTimer();
    // Abort any in-flight request handlers so awaited dispatchers can return
    // promptly. We don't bother sending responses for these — the peer
    // already lost the connection.
    for (const ctrl of this._inFlight.values()) ctrl.abort(new Error("session closing"));
    this._inFlight.clear();
    this._transport.close();
  }

  snapshot() {
    return {
      pairingId: this.pairing.pairingId,
      label: this.pairing.label,
      phonePub: this.pairing.phonePub,
      state: this._transport.state,
      lastSeenAtMs: this._lastSeenAtMs,
      channelBindingHex: this._channelBinding ? bytesToHex(this._channelBinding) : null,
      phoneFingerprint: this.pairing.phoneFingerprint,
    };
  }

  // -------------------------------------------------------------------------
  // Handshake completion — verify allowlist
  // -------------------------------------------------------------------------

  _createTransport() {
    return new RemotePairingTransport(this._transportOpts);
  }

  _handleTransportState(state, prev, info) {
    this._onStateChange(state, prev, info);
    if (state === STATE.CONNECTED) {
      this._restartAttempt = 0;
      return;
    }
    if (state === STATE.FAILED && !this._closed) {
      this._scheduleTransportRestart(info?.error);
    }
  }

  _scheduleTransportRestart(error) {
    if (this._restartTimer || this._closed) return;
    for (const ctrl of this._inFlight.values()) ctrl.abort(new Error("transport restarting"));
    this._inFlight.clear();
    this._channelBinding = null;

    const delays = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
    const delay = delays[Math.min(this._restartAttempt, delays.length - 1)];
    this._restartAttempt += 1;
    this._log.warn?.(
      `transport failed for ${this._logLabel()}; rebuilding in ${delay}ms` +
      `${error?.message ? ` (${error.message})` : ""}`,
    );
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this._closed) return;
      try {
        this._transport.close();
      } catch {
        // Failed transports may already have closed their socket.
      }
      this._transport = this._createTransport();
      this.start().catch((err) => {
        this._onError(err);
      });
    }, delay);
  }

  _clearRestartTimer() {
    if (this._restartTimer != null) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
  }

  _handleHandshakeComplete({ channelBinding, remoteStatic }) {
    if (this._closed) return;
    if (!remoteStatic) {
      this._fatal(new Error("handshake completed without revealing remoteStatic"));
      return;
    }
    // Constant-time pubkey check. The previous `peerPubHex !== ...` form
    // short-circuits on the first mismatching hex char, leaking how far
    // an attacker's guess matched via WS handshake-completion latency. The
    // attack window is narrow (relay jitter dominates) but the fix is
    // mechanical, so the prudent default is timing-safe equality.
    const expected = hexToBytes(this.pairing.phonePub);
    if (
      remoteStatic.length !== expected.length ||
      !nodeTimingSafeEqual(remoteStatic, expected)
    ) {
      // Possible causes:
      //   - The relay routed the wrong phone here (server bug).
      //   - The phone rotated keys without updating the LAN-side allowlist.
      //   - Someone with stolen credentials is impersonating the slot.
      // None are recoverable by waiting; close the session.
      this._fatal(new Error(
        `peer pubkey mismatch for ${this._logLabel()}`,
      ));
      return;
    }
    this._channelBinding = new Uint8Array(channelBinding);
    this._lastSeenAtMs = Date.now();
    try {
      const maybe = this._onSeen({
        pairing: this.pairing,
        atMs: this._lastSeenAtMs,
        channelBinding: this._channelBinding,
      });
      if (maybe && typeof maybe.then === "function") {
        maybe.catch((err) => this._log.warn?.(`onSeen rejected: ${err?.message}`));
      }
    } catch (err) {
      this._log.warn?.(`onSeen threw: ${err?.message}`);
    }
  }

  _fatal(err) {
    this._onError(err);
    // close() also cancels reconnects so this session stays down rather than
    // re-handshaking into the same failure on the next backoff tick.
    this.close();
  }

  // -------------------------------------------------------------------------
  // Inbound RPC dispatch
  // -------------------------------------------------------------------------

  _handleMessage(plaintext) {
    if (this._closed) return;
    let frame;
    try {
      frame = decodeRpc(plaintext);
    } catch (err) {
      // A malformed RPC frame inside an authenticated channel is suspicious
      // but recoverable — log and drop, don't tear the session down.
      this._log.warn?.(`rpc decode failed on ${this._logLabel()}: ${err.message}`);
      return;
    }
    switch (frame.type) {
      case RPC.REQUEST:
        this._handleRequest(frame);
        break;
      case RPC.CANCEL:
        this._handleCancel(frame);
        break;
      case RPC.RESPONSE:
      case RPC.EVENT:
        // Bridge is the responder of RPC requests and the producer of events.
        // Receiving these from the phone means the phone confused roles —
        // log and drop.
        this._log.warn?.(`unexpected rpc type ${frame.type} from ${this._logLabel()}`);
        break;
      default:
        this._log.warn?.(`unhandled rpc type ${frame.type}`);
    }
  }

  _handleRequest(req) {
    if (this._inFlight.size >= MAX_INFLIGHT_PER_SESSION) {
      // Defensive: avoid runaway dispatcher pile-up.
      this._sendResponse({
        id: req.id,
        status: 503,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "too many in-flight requests" }),
      });
      return;
    }

    const ctrl = new AbortController();
    this._inFlight.set(req.id, ctrl);

    // Fire-and-forget — the dispatcher runs concurrently with other
    // requests on the same session.
    Promise.resolve()
      .then(() => this._dispatch({
        method: req.method,
        path: req.path,
        headers: req.headers,
        body: req.body,
        bodyEncoding: req.bodyEncoding,
        signal: ctrl.signal,
        pairing: this.pairing,
        channelBinding: this._channelBinding,
      }))
      .then((result) => {
        if (this._closed) return;
        if (ctrl.signal.aborted) {
          // Cancelled mid-flight; don't send a response — the peer
          // explicitly told us not to. Cleanup happens in finally().
          return;
        }
        const { status, headers, body, bodyEncoding } = validateDispatchResult(result);
        this._sendResponse({ id: req.id, status, headers, body, bodyEncoding });
      })
      .catch((err) => {
        if (this._closed) return;
        if (ctrl.signal.aborted) {
          // The dispatcher likely threw because of the abort. Don't bother
          // sending a response — see comment above.
          return;
        }
        this._log.warn?.(
          `dispatch error on ${this._logLabel()} ${requestLogLabel(req)}: ${err?.message}`,
        );
        this._sendResponse({
          id: req.id,
          status: 500,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: "internal error" }),
        });
      })
      .finally(() => {
        this._inFlight.delete(req.id);
      });
  }

  _handleCancel(frame) {
    const ctrl = this._inFlight.get(frame.id);
    if (!ctrl) return;
    ctrl.abort(new Error("cancel from peer"));
    // We do NOT delete from _inFlight here — the dispatcher's `.finally`
    // owns that. Otherwise a slow handler could collide with a future
    // request that reuses the same id.
  }

  /** @param {{id:string,status:number,headers?:object,body?:string,bodyEncoding?:string}} res */
  _sendResponse(res) {
    let bytes;
    try {
      bytes = encodeResponse(res);
    } catch (err) {
      this._log.error?.(
        `failed to encode response for ${this._logLabel()} id=${res.id}: ${err.message}`,
      );
      return;
    }
    if (!this._transport.isConnected) {
      // Lost the channel between dispatch start and response. The phone-side
      // RPC client is expected to time out and retry; we drop silently.
      this._log.debug?.(
        `dropped response id=${res.id} on ${this._logLabel()} — transport not connected`,
      );
      return;
    }
    try {
      this._transport.send(bytes);
    } catch (err) {
      this._log.warn?.(`response send failed on ${this._logLabel()}: ${err.message}`);
    }
  }

  _logLabel() {
    return pairingLogLabel(this.pairing);
  }
}

// Re-export so callers can `import { STATE } from "./bridge-relay-client.mjs"`
// without separately reaching into transport.js.
export { STATE };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noop() {}

function normalizeLogger(logger) {
  if (!logger) return {};
  return {
    debug: typeof logger.debug === "function" ? logger.debug.bind(logger) : undefined,
    warn: typeof logger.warn === "function" ? logger.warn.bind(logger) : undefined,
    error: typeof logger.error === "function" ? logger.error.bind(logger) : undefined,
  };
}

function pairingLogLabel(pairing) {
  if (pairing?.phoneFingerprint) {
    return `phone:${pairing.phoneFingerprint}`;
  }
  return redactPairingId(pairing?.pairingId);
}

function redactPairingId(pairingId) {
  const value = String(pairingId || "");
  return value ? `pairing:${value.slice(0, 6)}…` : "pairing:unknown";
}

function requestLogLabel(req) {
  const method = String(req?.method || "REQUEST").toUpperCase();
  try {
    const pathname = new URL(String(req?.path || "/"), "http://viveworker.local").pathname;
    const parts = pathname.split("/").filter(Boolean).slice(0, 2);
    return `${method} /${parts.join("/")}`;
  } catch {
    return method;
  }
}

function validateDispatchResult(result) {
  if (!result || typeof result !== "object") {
    throw new TypeError("dispatch must return { status, headers?, body?, bodyEncoding? }");
  }
  const status = result.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new RangeError(`dispatch result.status must be in [100, 599] (got ${status})`);
  }
  return {
    status,
    headers: result.headers ?? undefined,
    body: result.body ?? undefined,
    bodyEncoding: result.bodyEncoding ?? undefined,
  };
}
