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
 *   success — `{ ok, status, statusText, headers, json(), text() }` — so
 *   the existing `apiGet` / `apiPost` code paths in `app.js` work
 *   unchanged. HTTP error statuses (4xx/5xx) are NOT thrown; the caller
 *   checks `response.ok` exactly as with native fetch.
 *
 * Out of scope for this module:
 *
 *   - FormData uploads through the relay (would need multipart-aware
 *     RPC body handling). Throws a clear error so the call site can
 *     fall back to a different upload path.
 *   - Server-Sent Events / streaming responses. The RpcClient delivers
 *     whole bodies; long-poll endpoints work fine, but `text/event-stream`
 *     does not.
 *   - Bridge-side relay request authorization. The bridge is assumed to
 *     unwrap incoming Noise frames and dispatch them to the same HTTP
 *     handlers, with the channel binding standing in for cookie auth.
 *     If a relayed request comes back as 401, that's a bridge gap to
 *     fix on that side, not here.
 */

import { RemotePairingRpcClient } from "./rpc-client.js";
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

// ---------------------------------------------------------------------------
// Module state (singleton client + telemetry)
// ---------------------------------------------------------------------------

/** @type {import("./rpc-client.js").RemotePairingRpcClient | null} */
let _client = null;

/** pairingId the live `_client` was built for. Used to detect re-pair. */
let _clientPairingId = null;

/** Returned by `bindWakeEvents`; called on client teardown. */
let _wakeUnbind = null;

/** Until this timestamp (ms), prefer relay over LAN. 0 = no preference. */
let _stickyRelayUntilMs = 0;

/** Counters for the diagnostics overlay / tests. */
let _telemetry = newTelemetry();

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
      identityKeypair: { priv: kp.priv, pub: kp.pub },
      remoteStatic,
      logger,
      onError: (err) => {
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
      _clientPairingId = null;
      if (_wakeUnbind) { try { _wakeUnbind(); } catch { /* ignore */ } _wakeUnbind = null; }
    }
    return null;
  }

  // Re-pair under a different bridge → throw away the old client so we
  // re-handshake with the new bridge static key.
  if (_client && _clientPairingId && _clientPairingId !== record.pairingId) {
    _telemetry.clientResets++;
    try { _client.close(); } catch { /* ignore */ }
    _client = null;
    if (_wakeUnbind) { try { _wakeUnbind(); } catch { /* ignore */ } _wakeUnbind = null; }
  }

  if (_client) return _client;

  _client = await buildRpcClient(record, opts);
  if (!_client) return null;
  _clientPairingId = record.pairingId;

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
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const response = await fetchImpl(url, init);
    _telemetry.lanOk++;
    return { ok: true, response };
  } catch (err) {
    // Caller cancelled → re-throw so we don't keep wasting time on relay.
    if (err && err.name === "AbortError") {
      throw err;
    }
    _telemetry.lanFail++;
    _telemetry.lastLanFailAt = nowMs(opts);
    _stickyRelayUntilMs = _telemetry.lastLanFailAt + STICKY_RELAY_MS;
    return { ok: false, err };
  }
}

/**
 * Whether the request body is a shape the relay's RPC layer can carry.
 * The rpc layer accepts string / Uint8Array / ArrayBuffer / null. FormData
 * (multipart upload) and Blob/ReadableStream (raw binary) need explicit
 * encoding work that's out of scope for Phase 7 — see `routedFetch` for
 * how those are surfaced to the caller.
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

async function attemptRelayFetch(url, init, opts) {
  const client = await getOrInitClient(opts);
  if (!client) {
    return { ok: false, err: new Error("no-relay-client") };
  }

  let body = init.body ?? null;
  if (!isRelayCompatibleBody(body)) {
    // Defensive — `routedFetch` already filters FormData / etc. before
    // we get here, so reaching this branch means a programmer error
    // upstream. Surface synchronously so the bug is loud.
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
      headers: init.headers ?? {},
      body,
      signal: init.signal,
      timeoutMs: opts.timeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS,
    });
    _telemetry.relayOk++;
    return { ok: true, response: adaptRpcResponse(rpcRes) };
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    _telemetry.relayFail++;
    _telemetry.lastRelayFailAt = nowMs(opts);
    return { ok: false, err };
  }
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
 *   loadPairingState?: typeof loadPairingState,
 *   ensureIdentityKeypair?: typeof ensureIdentityKeypair,
 *   RemotePairingRpcClient?: typeof RemotePairingRpcClient,
 *   bindWakeEvents?: typeof bindWakeEvents,
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
  const bodyIsFormData = isFormDataBody(init.body);

  // Sticky-relay path: LAN just failed, prefer relay for a while.
  if (_stickyRelayUntilMs > t) {
    if (bodyIsFormData) {
      // FormData can't ride the relay (no multipart in the RPC layer).
      // Skip relay entirely and try LAN; if LAN's also down, surface a
      // specific error instead of pretending the relay would have worked.
      const lan = await attemptLanFetch(url, init, opts);
      if (lan.ok) return lan.response;
      throw new Error("formdata-over-relay-unsupported");
    }
    const r = await attemptRelayFetch(url, init, opts);
    if (r.ok) return r.response;
    // Relay also failed. Drop sticky preference and try LAN once — maybe
    // we're back on the network.
    _stickyRelayUntilMs = 0;
    const lan = await attemptLanFetch(url, init, opts);
    if (lan.ok) return lan.response;
    // Both dead. Surface LAN error since it's typically the more
    // actionable one ("Failed to fetch" → "obviously offline").
    throw lan.err;
  }

  // Happy path: LAN first.
  const lan = await attemptLanFetch(url, init, opts);
  if (lan.ok) return lan.response;

  // LAN failed (entered sticky-relay window inside attemptLanFetch).
  // FormData can't fall back to the relay — fail loudly so the caller
  // can route the upload another way (or wait for LAN to come back).
  if (bodyIsFormData) {
    throw new Error("formdata-over-relay-unsupported");
  }

  // Try relay once before giving up.
  const r = await attemptRelayFetch(url, init, opts);
  if (r.ok) return r.response;

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
    hasClient: Boolean(_client),
    clientPairingId: _clientPairingId,
  };
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
  _clientPairingId = null;
  if (_wakeUnbind) {
    try { _wakeUnbind(); } catch { /* ignore */ }
  }
  _wakeUnbind = null;
  _stickyRelayUntilMs = 0;
  _telemetry = newTelemetry();
}

// Test-visible constants for tests that want to assert behavior at the
// sticky-window boundary without hard-coding 5 minutes in two places.
export const __STICKY_RELAY_MS = STICKY_RELAY_MS;
export const __DEFAULT_RELAY_TIMEOUT_MS = DEFAULT_RELAY_TIMEOUT_MS;
