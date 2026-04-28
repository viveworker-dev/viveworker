/**
 * web/remote-pairing/api-router.js — LAN-first / relay-fallback fetch router.
 *
 * The PWA's `apiGet` / `apiPost` helpers used to call `fetch()` directly
 * against the bridge's same-origin LAN URL. That's the right thing as long
 * as the phone is on LAN. When the phone is off-LAN we want the same call
 * sites to transparently route through the encrypted relay tunnel
 * (Cloudflare Worker + Durable Object → bridge) instead.
 *
 * Strategy: probe-on-failure with sticky relay window.
 *
 *   1. By default, try LAN `fetch()` first.
 *   2. If LAN throws a `TypeError` (network failure, DNS, connect refused —
 *      i.e. the bridge isn't reachable), fall back to the relay's
 *      `RemotePairingRpcClient.fetch()`.
 *   3. After a LAN failure, enter a STICKY_RELAY_MS window where subsequent
 *      requests skip LAN and go straight to relay. Avoids paying the LAN
 *      timeout cost on every call after we've already learned LAN is dead.
 *   4. When the window expires, the next request re-probes LAN. If LAN is
 *      back, the sticky window is left dormant and we return to the happy
 *      path. If LAN is still dead, the window resets.
 *   5. AbortError (caller cancelled) is never treated as a LAN failure —
 *      we re-throw immediately rather than waste a relay attempt.
 *
 * Singleton RpcClient lifecycle:
 *
 *   - Lazy-created on the first relay attempt that has a valid pairing
 *     record in localStorage (`pairing-state.js`).
 *   - Reused across every subsequent relay fetch — opening a Noise IK
 *     handshake per call would be absurd.
 *   - Torn down + rebuilt when `pairingId` changes (re-pair under a
 *     different bridge identity). Detected by comparing the current
 *     localStorage record's pairingId to the one the live client was
 *     built for.
 *   - Tied to platform wake events (`visibilitychange`, `online`,
 *     `pageshow` w/ persisted, SW push of type "remote-pairing-wake")
 *     via `bindWakeEvents()` — those nudge `client.kick()` so a phone
 *     that just came out of background reconnects instead of waiting
 *     for the next outbound fetch to discover the dead WS.
 *
 * Response shape:
 *
 *   The router returns a *minimal Fetch-Response-compatible* object on
 *   success — `{ ok, status, statusText, headers, json(), text(),
 *   arrayBuffer() }` — so the existing `apiGet` / `apiPost` code paths in
 *   `app.js` work unchanged, and binary assets such as timeline images can
 *   also ride the relay. HTTP error statuses (4xx/5xx) are NOT thrown; the
 *   caller checks `response.ok` exactly as with native fetch.
 *
 * Out of scope for this module:
 *
 *   - Streaming uploads. FormData uploads are supported by serializing
 *     them to a buffered multipart body before handing them to the RPC
 *     layer; truly streaming request bodies remain out of scope.
 *   - Server-Sent Events / streaming responses. The RpcClient delivers
 *     whole bodies; long-poll endpoints work fine, but `text/event-stream`
 *     does not.
 *   - Bridge-side relay request authorization. The bridge is assumed to
 *     unwrap incoming Noise frames and dispatch them to the same HTTP
 *     handlers, with the channel binding standing in for cookie auth.
 *     If a relayed request comes back as 401, that's a bridge gap to
 *     fix on that side, not here.
 */

import {
  RemotePairingRpcClient,
  RpcTransportError,
  RpcTransportFailedError,
} from "./rpc-client.js";
import { bindWakeEvents } from "./wake.js";
import { ensureIdentityKeypair, hexToBytes } from "./keys.js";
import { loadPairingState } from "./pairing-state.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * After a LAN failure we prefer relay for this long before re-probing LAN.
 * 5 minutes is a coarse pick: long enough that a phone that fell off LAN
 * (cellular handoff, WiFi drop) doesn't pay LAN connect timeouts on every
 * outbound call, short enough that "I just walked back into wifi range"
 * recovers without the user noticing.
 */
const STICKY_RELAY_MS = 5 * 60 * 1000;

/**
 * Default timeout for a single relay fetch. Matches RpcClient's own default
 * (60s) — long-poll inboxes need this much; ordinary mutating calls return
 * sub-second.
 */
const DEFAULT_RELAY_TIMEOUT_MS = 60_000;

/**
 * Default timeout for the LAN probe before falling back to relay.
 * Off-LAN `.local` fetches can hang for a long time on iOS instead of failing
 * quickly, which leaves boot() stuck on the splash screen. Keep this short:
 * LAN is the fast path, and slow/unreachable LAN should become relay.
 */
const DEFAULT_LAN_TIMEOUT_MS = 2_500;
const PAIRING_STATE_STORAGE_KEY = "viveworker.remote-pairing.state";
const PAIRING_STATE_SCHEMA_VERSION = 2;
const PAIRING_STATE_LEGACY_SCHEMA_VERSION = 1;
const ROUTING_STATUS_EVENT = "viveworker:remote-routing-status";

// ---------------------------------------------------------------------------
// Module state (singleton client + telemetry)
// ---------------------------------------------------------------------------

/** @type {import("./rpc-client.js").RemotePairingRpcClient | null} */
let _client = null;

/** pairing capability the live `_client` was built for. Used to detect re-pair. */
let _clientPairingKey = null;

/** Returned by `bindWakeEvents`; called on client teardown. */
let _wakeUnbind = null;

/** Until this timestamp (ms), prefer relay over LAN. 0 = no preference. */
let _stickyRelayUntilMs = 0;

/** Counters for the diagnostics overlay / tests. */
let _telemetry = newTelemetry();

/** Last reason getOrInitClient could not build a relay client. */
let _lastPairingStateStatus = null;

/** Last transport route that completed successfully. */
let _lastSuccessfulRoute = null;

function newTelemetry() {
  return {
    lanOk: 0,
    lanFail: 0,
    relayOk: 0,
    relayFail: 0,
    lastLanFailAt: 0,
    lastRelayFailAt: 0,
    clientResets: 0,
  };
}

function emitRoutingStatus(phase, opts = {}, detail = {}) {
  if (opts.suppressRoutingStatus === true) {
    return;
  }
  const payload = {
    phase,
    ...detail,
    atMs: nowMs(opts),
  };
  if (typeof opts.onRouteStatus === "function") {
    try {
      opts.onRouteStatus(payload);
    } catch {
      // Status updates must never affect network routing.
    }
  }
  const target = globalThis;
  if (
    typeof target?.dispatchEvent === "function" &&
    typeof target?.CustomEvent === "function"
  ) {
    try {
      target.dispatchEvent(new target.CustomEvent(ROUTING_STATUS_EVENT, { detail: payload }));
    } catch {
      // Ignore non-browser/test environments.
    }
  }
}

// ---------------------------------------------------------------------------
// RpcClient lifecycle
// ---------------------------------------------------------------------------

/**
 * Build a fresh `RemotePairingRpcClient` for the given pairing record.
 * Returns null if we can't (no IndexedDB, no identity keypair, etc.).
 *
 * Does NOT await `connect()` — the rpc layer queues the first `fetch()`
 * until the transport is up, so callers don't block here on a slow
 * relay handshake.
 *
 * @param {ReturnType<typeof loadPairingState>} record
 * @param {{
 *   logger?: object,
 *   RemotePairingRpcClient?: typeof RemotePairingRpcClient,
 *   ensureIdentityKeypair?: typeof ensureIdentityKeypair,
 * }} opts
 */
async function buildRpcClient(record, opts = {}) {
  const ensureKp = opts.ensureIdentityKeypair ?? ensureIdentityKeypair;
  let kp;
  try {
    kp = await ensureKp();
  } catch (err) {
    console.warn("[api-router] ensureIdentityKeypair failed:", err?.message || err);
    return null;
  }
  if (!kp || !kp.priv || !kp.pub) {
    console.warn("[api-router] no identity keypair available");
    return null;
  }

  let remoteStatic;
  try {
    remoteStatic = hexToBytes(record.bridgePubHex);
  } catch (err) {
    console.warn("[api-router] bad bridgePubHex on pairing record:", err?.message);
    return null;
  }

  const ClientCtor = opts.RemotePairingRpcClient ?? RemotePairingRpcClient;
  const logger = opts.logger ?? console;

  let client;
  try {
    client = new ClientCtor({
      relayUrl: record.relayUrl,
      pairingId: record.pairingId,
      relayToken: record.relayToken,
      identityKeypair: { priv: kp.priv, pub: kp.pub },
      remoteStatic,
      logger,
      onStateChange: (next, previous, info = {}) => {
        emitRoutingStatus("remote-transport-state", opts, {
          state: String(next || ""),
          previousState: String(previous || ""),
          reason: String(info?.reason || ""),
          code: Number(info?.code) || undefined,
          resumed: typeof info?.resumed === "boolean" ? info.resumed : undefined,
        });
      },
      onError: (err) => {
        emitRoutingStatus("remote-transport-error", opts, {
          reason: err?.message || String(err || ""),
        });
        logger.warn?.("[api-router] rpc onError:", err?.message || err);
      },
    });
  } catch (err) {
    console.warn("[api-router] RpcClient construction failed:", err?.message);
    return null;
  }

  // Kick off the connection in the background. The first fetch() call
  // blocks on the transport state machine internally, so awaiting here
  // would just delay the caller without changing behavior.
  client.connect().catch((err) => {
    logger.warn?.("[api-router] rpc connect failed:", err?.message || err);
  });

  return client;
}

/**
 * Return the singleton `RemotePairingRpcClient`, lazy-creating it if
 * needed and resetting it if the local pairing record has changed.
 * Returns null if no pairing exists or client construction failed.
 *
 * @param {object} [opts]  forwarded to `buildRpcClient`
 */
async function getOrInitClient(opts = {}) {
  const record = (opts.loadPairingState ?? loadPairingState)();
  if (!record) {
    // No pairing → nothing to do. Tear down any stale client (e.g. user
    // unpaired between calls).
    if (_client) {
      _telemetry.clientResets++;
      try { _client.close(); } catch { /* ignore */ }
      _client = null;
      _clientPairingKey = null;
      if (_wakeUnbind) { try { _wakeUnbind(); } catch { /* ignore */ } _wakeUnbind = null; }
    }
    _lastPairingStateStatus = inspectPairingStateForRelay(opts);
    return null;
  }
  _lastPairingStateStatus = { status: "ready", needsEnrollment: false };

  const pairingKey = `${record.pairingId}:${record.relayToken}`;

  // Re-pair under a different bridge/token → throw away the old client so we
  // re-handshake with the new bridge static key and relay capability.
  if (_client && _clientPairingKey && _clientPairingKey !== pairingKey) {
    _telemetry.clientResets++;
    try { _client.close(); } catch { /* ignore */ }
    _client = null;
    if (_wakeUnbind) { try { _wakeUnbind(); } catch { /* ignore */ } _wakeUnbind = null; }
  }

  if (_client) return _client;

  _client = await buildRpcClient(record, opts);
  if (!_client) {
    _lastPairingStateStatus = { status: "client-unavailable", needsEnrollment: false };
    return null;
  }
  _clientPairingKey = pairingKey;

  // Wire wake events. If `bindWakeEvents` throws (e.g. weird test env),
  // log and continue — we'd rather have a working client without
  // automatic wake than no client at all.
  const bind = opts.bindWakeEvents ?? bindWakeEvents;
  try {
    _wakeUnbind = bind(_client, {
      onWake: (reason) => {
        (opts.logger ?? console).debug?.("[api-router] wake:", reason);
      },
    });
  } catch (err) {
    console.warn("[api-router] bindWakeEvents failed:", err?.message);
    _wakeUnbind = null;
  }

  return _client;
}

function inspectPairingStateForRelay(opts) {
  const inspect = opts.inspectPairingState ?? inspectBrowserPairingState;
  try {
    return inspect();
  } catch {
    return { status: "malformed", needsEnrollment: true };
  }
}

function inspectBrowserPairingState() {
  let store;
  try {
    store = globalThis.localStorage ?? null;
  } catch {
    return { status: "storage-unavailable", needsEnrollment: false };
  }
  if (!store) {
    return { status: "storage-unavailable", needsEnrollment: false };
  }
  let raw;
  try {
    raw = store.getItem(PAIRING_STATE_STORAGE_KEY);
  } catch {
    return { status: "storage-unavailable", needsEnrollment: false };
  }
  if (!raw) {
    return { status: "missing", needsEnrollment: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "malformed", needsEnrollment: true };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "malformed", needsEnrollment: true };
  }
  if (parsed.version === PAIRING_STATE_LEGACY_SCHEMA_VERSION) {
    return { status: "legacy-v1", needsEnrollment: true };
  }
  if (parsed.version !== PAIRING_STATE_SCHEMA_VERSION) {
    return { status: "unsupported-version", needsEnrollment: true };
  }
  if (typeof parsed.relayToken !== "string" || parsed.relayToken.length === 0) {
    return { status: "missing-token", needsEnrollment: true };
  }
  return { status: "ready", needsEnrollment: false };
}

function remotePairingEnrollmentRequiredError(info) {
  const status = info?.status || "missing";
  const err = new Error(
    "Remote connection needs to be refreshed. Open viveworker once on the same Wi-Fi as your PC, then try again off-LAN.",
  );
  err.name = "RemotePairingEnrollmentRequiredError";
  err.code = "remote-pairing-enrollment-required";
  err.reason = status;
  return err;
}

function relayClientUnavailableError(info) {
  if (info?.needsEnrollment !== false) {
    return remotePairingEnrollmentRequiredError(info);
  }
  const err = new Error("remote relay client unavailable");
  err.name = "RemotePairingUnavailableError";
  err.code = "remote-pairing-unavailable";
  err.reason = info?.status || "client-unavailable";
  return err;
}

function isRemotePairingEnrollmentRequiredError(err) {
  return err?.code === "remote-pairing-enrollment-required" ||
    err?.name === "RemotePairingEnrollmentRequiredError";
}

function resetRelayClientForRetry() {
  if (_client) {
    _telemetry.clientResets++;
    try { _client.close(); } catch { /* ignore */ }
  }
  _client = null;
  _clientPairingKey = null;
  if (_wakeUnbind) {
    try { _wakeUnbind(); } catch { /* ignore */ }
  }
  _wakeUnbind = null;
}

// ---------------------------------------------------------------------------
// Response adapter — RpcResponse → minimal Fetch-Response shape
// ---------------------------------------------------------------------------

/**
 * Adapt an `RpcResponse` (from rpc-client.js) into the subset of fetch's
 * Response interface that `apiGet` / `apiPost` actually touch:
 *
 *   - `ok`           bool, derived from status
 *   - `status`       number
 *   - `statusText`   string (rpc layer doesn't carry one — empty)
 *   - `headers`      plain object (rpc carries headers as a Record)
 *   - `json()`       async, throws on non-JSON body
 *   - `text()`       async
 *   - `arrayBuffer()` async
 *
 * Other Fetch-Response APIs (Body.bodyUsed, Body.body stream, redirected,
 * type, url, clone()) are deliberately not provided — none of them are
 * used by apiGet/apiPost, and faking them would just hide bugs.
 *
 * @param {import("./rpc-client.js").RpcResponse} rpcRes
 */
function adaptRpcResponse(rpcRes) {
  const status = Number(rpcRes.status) || 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: rpcRes.headers ?? {},
    json: async () => rpcRes.json(),
    text: async () => rpcRes.text(),
    arrayBuffer: async () => rpcRes.arrayBuffer(),
  };
}

/**
 * Convert a same-origin URL (as written in app.js, e.g. "/api/items/foo"
 * or "https://localhost:8810/api/items/foo") into the path+query string
 * the relay protocol expects (e.g. "/api/items/foo?bar=baz").
 */
function urlToRelayPath(url) {
  if (typeof url !== "string") {
    throw new TypeError("url must be a string");
  }
  // URL constructor needs an absolute base. In the browser we have one
  // via location; in tests we accept relative URLs and synthesize a base.
  const base = (typeof location !== "undefined" && location.origin)
    ? location.origin
    : "https://localhost";
  const u = new URL(url, base);
  return u.pathname + u.search;
}

// ---------------------------------------------------------------------------
// Inner LAN / relay fetch attempts
// ---------------------------------------------------------------------------

async function attemptLanFetch(url, init, opts) {
  emitRoutingStatus("lan-checking", opts, { url: String(url || "") });
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.lanTimeoutMs ?? DEFAULT_LAN_TIMEOUT_MS;
  const timeoutEnabled = Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof AbortController !== "undefined";
  let didTimeout = false;
  let timer = null;
  let controller = null;
  let externalAbortHandler = null;
  let fetchInit = init;
  let timeoutPromise = null;

  if (timeoutEnabled) {
    if (init.signal?.aborted) {
      throw abortError(init.signal);
    }
    controller = new AbortController();
    if (init.signal) {
      externalAbortHandler = () => controller.abort(init.signal.reason);
      init.signal.addEventListener("abort", externalAbortHandler, { once: true });
    }
    timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        didTimeout = true;
        const err = new TypeError("LAN fetch timed out");
        try { controller.abort(err); } catch { /* ignore */ }
        reject(err);
      }, timeoutMs);
    });
    fetchInit = { ...init, signal: controller.signal };
  }

  try {
    const fetchPromise = fetchImpl(url, fetchInit);
    const response = timeoutPromise
      ? await Promise.race([fetchPromise, timeoutPromise])
      : await fetchPromise;
    _telemetry.lanOk++;
    _lastSuccessfulRoute = "lan";
    emitRoutingStatus("lan-connected", opts, { url: String(url || "") });
    return { ok: true, response };
  } catch (err) {
    // Caller cancelled → re-throw so we don't keep wasting time on relay.
    if (err && err.name === "AbortError" && !didTimeout) {
      throw err;
    }
    const lanErr = didTimeout ? new TypeError("LAN fetch timed out") : err;
    _telemetry.lanFail++;
    _telemetry.lastLanFailAt = nowMs(opts);
    _stickyRelayUntilMs = _telemetry.lastLanFailAt + STICKY_RELAY_MS;
    emitRoutingStatus("lan-failed", opts, {
      url: String(url || ""),
      reason: lanErr?.message || String(lanErr),
    });
    return { ok: false, err: lanErr };
  } finally {
    if (timer) clearTimeout(timer);
    if (init.signal && externalAbortHandler) {
      init.signal.removeEventListener("abort", externalAbortHandler);
    }
  }
}

function abortError(signal) {
  if (signal?.reason instanceof Error) {
    const err = signal.reason;
    if (!err.name) err.name = "AbortError";
    return err;
  }
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Whether the request body is a shape the relay's RPC layer can carry.
 * The rpc layer accepts string / Uint8Array / ArrayBuffer / null.
 * FormData is handled separately by serializing it to multipart bytes.
 */
function isRelayCompatibleBody(body) {
  if (body === null || body === undefined) return true;
  if (typeof body === "string") return true;
  if (body instanceof Uint8Array) return true;
  if (body instanceof ArrayBuffer) return true;
  return false;
}

function isFormDataBody(body) {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

function headersToPlainObject(headers) {
  const out = {};
  if (!headers) return out;

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value);
    });
    return out;
  }

  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (!pair || pair.length < 2) continue;
      out[String(pair[0]).toLowerCase()] = String(pair[1]);
    }
    return out;
  }

  if (typeof headers[Symbol.iterator] === "function" && typeof headers !== "string") {
    for (const [key, value] of headers) {
      out[String(key).toLowerCase()] = String(value);
    }
    return out;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    out[String(key).toLowerCase()] = String(value);
  }
  return out;
}

function setRelayHeader(headers, name, value) {
  headers[String(name).toLowerCase()] = String(value);
}

function escapeMultipartHeaderValue(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/[\r\n]/g, " ");
}

function safeMultipartContentType(value) {
  const type = String(value || "application/octet-stream").replace(/[\r\n]/g, "").trim();
  return type || "application/octet-stream";
}

function randomBoundary() {
  const bytes = new Uint8Array(12);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return `----viveworker-relay-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function concatBytes(chunks, totalLength) {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isBlobLike(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.arrayBuffer === "function" &&
    typeof value.type === "string",
  );
}

async function encodeFormDataForRelay(formData, signal) {
  if (!formData || typeof formData.entries !== "function") {
    throw new TypeError("relay FormData body must be iterable");
  }

  const boundary = randomBoundary();
  const encoder = new TextEncoder();
  const chunks = [];
  let totalLength = 0;
  const pushText = (text) => {
    const bytes = encoder.encode(text);
    chunks.push(bytes);
    totalLength += bytes.byteLength;
  };
  const pushBytes = (bytes) => {
    chunks.push(bytes);
    totalLength += bytes.byteLength;
  };

  for (const [name, value] of formData.entries()) {
    if (signal?.aborted) throw abortError(signal);

    pushText(`--${boundary}\r\n`);
    if (isBlobLike(value)) {
      const filename = value.name || "blob";
      pushText(
        `Content-Disposition: form-data; name="${escapeMultipartHeaderValue(name)}"; filename="${escapeMultipartHeaderValue(filename)}"\r\n`,
      );
      pushText(`Content-Type: ${safeMultipartContentType(value.type)}\r\n\r\n`);
      pushBytes(new Uint8Array(await value.arrayBuffer()));
      pushText("\r\n");
    } else {
      pushText(`Content-Disposition: form-data; name="${escapeMultipartHeaderValue(name)}"\r\n\r\n`);
      pushText(String(value));
      pushText("\r\n");
    }
  }

  pushText(`--${boundary}--\r\n`);
  return {
    body: concatBytes(chunks, totalLength),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function attemptRelayFetch(url, init, opts) {
  emitRoutingStatus("remote-connecting", opts, { url: String(url || "") });
  const client = await getOrInitClient(opts);
  if (!client) {
    return { ok: false, err: relayClientUnavailableError(_lastPairingStateStatus) };
  }

  let body = init.body ?? null;
  const headers = headersToPlainObject(init.headers ?? {});
  if (isFormDataBody(body)) {
    try {
      const encoded = await encodeFormDataForRelay(body, init.signal);
      body = encoded.body;
      setRelayHeader(headers, "content-type", encoded.contentType);
      setRelayHeader(headers, "content-length", String(encoded.body.byteLength));
    } catch (err) {
      return { ok: false, err };
    }
  }
  if (!isRelayCompatibleBody(body)) {
    // Defensive — FormData is encoded above, so reaching this branch means
    // a programmer handed us a body shape the RPC layer still cannot carry.
    return {
      ok: false,
      err: new TypeError("relay body must be string, Uint8Array, ArrayBuffer, or null"),
    };
  }

  let path;
  try {
    path = urlToRelayPath(url);
  } catch (err) {
    return { ok: false, err };
  }

  try {
    const rpcRes = await client.fetch({
      method: (init.method || "GET").toUpperCase(),
      path,
      headers,
      body,
      signal: init.signal,
      timeoutMs: opts.timeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS,
    });
    _telemetry.relayOk++;
    _lastSuccessfulRoute = "relay";
    emitRoutingStatus("remote-connected", opts, { url: String(url || "") });
    return { ok: true, response: adaptRpcResponse(rpcRes) };
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    if (!opts.__relayRetried && shouldResetRelayClient(err)) {
      resetRelayClientForRetry();
      return attemptRelayFetch(url, init, { ...opts, __relayRetried: true });
    }
    _telemetry.relayFail++;
    _telemetry.lastRelayFailAt = nowMs(opts);
    emitRoutingStatus("remote-failed", opts, {
      url: String(url || ""),
      reason: err?.message || String(err),
    });
    return { ok: false, err };
  }
}

function shouldResetRelayClient(err) {
  return err instanceof RpcTransportError ||
    err instanceof RpcTransportFailedError ||
    err?.name === "RpcTransportError" ||
    err?.name === "RpcTransportFailedError";
}

function nowMs(opts) {
  return (opts.now ?? Date.now)();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch-shaped router. Returns a Fetch-Response-compatible object on
 * success; throws on transport-level failure of *both* paths.
 *
 * HTTP error statuses (4xx/5xx) are NOT thrown — the caller checks
 * `response.ok`, exactly as with native fetch.
 *
 * `opts` is for tests / advanced callers; production code calls with a
 * single `init` like normal fetch.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{
 *   fetch?: typeof globalThis.fetch,
 *   now?: () => number,
 *   logger?: object,
 *   timeoutMs?: number,
 *   lanTimeoutMs?: number,
 *   loadPairingState?: typeof loadPairingState,
 *   inspectPairingState?: () => { status?: string, needsEnrollment?: boolean },
 *   ensureIdentityKeypair?: typeof ensureIdentityKeypair,
 *   RemotePairingRpcClient?: typeof RemotePairingRpcClient,
 *   bindWakeEvents?: typeof bindWakeEvents,
 *   onRouteStatus?: (event: { phase: string, atMs: number, url?: string, sticky?: boolean, reason?: string, state?: string, previousState?: string, code?: number, resumed?: boolean }) => void,
 *   suppressRoutingStatus?: boolean,
 *   preferRelayError?: boolean,
 * }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   status: number,
 *   statusText: string,
 *   headers: Record<string,string>,
 *   json: () => Promise<unknown>,
 *   text: () => Promise<string>,
 * }>}
 */
export async function routedFetch(url, init = {}, opts = {}) {
  const t = nowMs(opts);

  // Sticky-relay path: LAN just failed, prefer relay for a while.
  if (_stickyRelayUntilMs > t) {
    emitRoutingStatus("remote-switching", opts, { url: String(url || ""), sticky: true });
    const r = await attemptRelayFetch(url, init, opts);
    if (r.ok) return r.response;
    // Relay also failed. Drop sticky preference and try LAN once — maybe
    // we're back on the network.
    _stickyRelayUntilMs = 0;
    const lan = await attemptLanFetch(url, init, opts);
    if (lan.ok) return lan.response;
    if (isRemotePairingEnrollmentRequiredError(r.err)) throw r.err;
    if (opts.preferRelayError && r.err) throw r.err;
    // Both dead. Surface LAN error since it's typically the more
    // actionable one ("Failed to fetch" → "obviously offline").
    throw lan.err;
  }

  // Happy path: LAN first.
  const lan = await attemptLanFetch(url, init, opts);
  if (lan.ok) return lan.response;

  // Try relay once before giving up.
  emitRoutingStatus("remote-switching", opts, { url: String(url || ""), sticky: false });
  const r = await attemptRelayFetch(url, init, opts);
  if (r.ok) return r.response;
  if (isRemotePairingEnrollmentRequiredError(r.err)) throw r.err;
  if (opts.preferRelayError && r.err) throw r.err;

  throw lan.err;
}

/**
 * For tests + the diagnostics overlay. Reads internal counters and the
 * sticky-relay window expiry. Does not allocate fresh objects on the hot
 * path — only invoke from instrumentation code.
 */
export function __getTelemetry() {
  return {
    ..._telemetry,
    stickyRelayUntilMs: _stickyRelayUntilMs,
    lastRoute: _lastSuccessfulRoute,
    hasClient: Boolean(_client),
    clientPairingKey: _clientPairingKey,
  };
}

export function getRoutingTelemetry() {
  return __getTelemetry();
}

/**
 * Reset all internal state. Used by tests; safe but pointless in
 * production. Closes the live RpcClient and unbinds wake events.
 */
export function __resetForTest() {
  if (_client) {
    try { _client.close(); } catch { /* ignore */ }
  }
  _client = null;
  _clientPairingKey = null;
  if (_wakeUnbind) {
    try { _wakeUnbind(); } catch { /* ignore */ }
  }
  _wakeUnbind = null;
  _stickyRelayUntilMs = 0;
  _telemetry = newTelemetry();
  _lastPairingStateStatus = null;
  _lastSuccessfulRoute = null;
}

// Test-visible constants for tests that want to assert behavior at the
// sticky-window boundary without hard-coding 5 minutes in two places.
export const __STICKY_RELAY_MS = STICKY_RELAY_MS;
export const __DEFAULT_RELAY_TIMEOUT_MS = DEFAULT_RELAY_TIMEOUT_MS;
export const __DEFAULT_LAN_TIMEOUT_MS = DEFAULT_LAN_TIMEOUT_MS;
