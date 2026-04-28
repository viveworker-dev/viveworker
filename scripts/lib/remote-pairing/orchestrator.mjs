/**
 * orchestrator.mjs — High-level startup glue for remote pairing on the bridge.
 *
 * Wires the four pieces:
 *   1. ensureIdentityKeypair (`keys.mjs`)        — bridge's static X25519 key
 *   2. loadPairings (`pairings.mjs`)             — paired-phones allowlist
 *   3. createHttpDispatch (`http-dispatch.mjs`)  — adapt RPC → bridge listener
 *   4. BridgeRelayClient (`bridge-relay-client.mjs`) — open relay connections
 *
 * Plus a cheap fs.watch on the pairings file so adding/removing a pairing
 * via the LAN-pairing flow is picked up live (no bridge restart needed).
 *
 * Usage from `viveworker-bridge.mjs`:
 *
 *   import { startRemotePairingRelay } from "./lib/remote-pairing/orchestrator.mjs";
 *
 *   const remotePairingHandle = await startRemotePairingRelay({
 *     relayUrl: process.env.REMOTE_PAIRING_RELAY_URL,
 *     requestListener: bridgeRequestHandler,
 *     logger: console,
 *   });
 *
 *   // …on shutdown:
 *   remotePairingHandle.close();
 *
 * The handle exposes `.getStatus()` for the bridge's `/health` or settings
 * UI, and `.reloadNow()` for explicit reloads (e.g. right after the LAN
 * pairing flow writes to the file — saves waiting on the fs.watch debounce).
 */

import { promises as fs } from "node:fs";
import { watch as fsWatch } from "node:fs";

import { ensureIdentityKeypair, REMOTE_PAIRING_ENV_FILE } from "./keys.mjs";
import { loadPairings, markSeenPersisted, REMOTE_PAIRINGS_FILE } from "./pairings.mjs";
import { createHttpDispatch } from "./http-dispatch.mjs";
import { BridgeRelayClient } from "./bridge-relay-client.mjs";
import { bytesToHex } from "./keys-core.mjs";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default relay URL — overridable via env or option. */
export const DEFAULT_RELAY_URL = "wss://pairing.viveworker.com";

/** Debounce for fs.watch — multiple events per save are common on macOS. */
const RELOAD_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} StartRemotePairingRelayOptions
 * @property {string} [relayUrl]                  defaults to DEFAULT_RELAY_URL or env
 * @property {import("./http-dispatch.mjs").RequestListener} requestListener
 * @property {string} [identityKeypairFile]       overrides REMOTE_PAIRING_ENV_FILE
 * @property {string} [pairingsFile]              overrides REMOTE_PAIRINGS_FILE
 * @property {boolean} [enabled]                  if false, returns a dormant handle
 *           that does nothing. Useful for "feature-flag off" without callers
 *           having to scatter `if` checks.
 * @property {string} [remoteAddressPrefix]       forwarded to http-dispatch
 * @property {number} [responseTimeoutMs]         forwarded to http-dispatch
 * @property {{debug?:Function, warn?:Function, error?:Function, info?:Function}} [logger]
 * @property {typeof WebSocket} [WebSocketImpl]   defaults to require("ws")
 * @property {number} [pingIntervalMs]            forwarded to BridgeRelayClient
 * @property {number[]} [backoffMs]               forwarded to BridgeRelayClient
 * @property {number} [handshakeTimeoutMs]        forwarded to BridgeRelayClient
 * @property {Uint8Array} [prologue]              forwarded to BridgeRelayClient
 * @property {boolean} [watchPairingsFile]        defaults to true
 * @property {(event: object) => void | Promise<void>} [auditEventSink]
 */

/**
 * @typedef {Object} RemotePairingHandle
 * @property {BridgeRelayClient | null} client
 * @property {{priv: Uint8Array, pub: Uint8Array} | null} identityKeypair
 * @property {() => Promise<void>} reloadNow
 * @property {() => void} kick
 * @property {(topic: string, data?: unknown) => void} broadcast
 * @property {() => RemotePairingStatus} getStatus
 * @property {() => void} close
 */

/**
 * @typedef {Object} RemotePairingStatus
 * @property {boolean} enabled
 * @property {string} relayUrl
 * @property {string | null} identityFingerprint
 * @property {string | null} identityPubHex
 * @property {Array<{ pairingId: string, label: string, phonePub: string, state: string,
 *   lastSeenAtMs: number | null, channelBindingHex: string | null,
 *   phoneFingerprint: string }>} sessions
 */

/**
 * @param {StartRemotePairingRelayOptions} opts
 * @returns {Promise<RemotePairingHandle>}
 */
export async function startRemotePairingRelay(opts) {
  const log = normalizeLogger(opts.logger);
  const enabled = opts.enabled !== false;

  const handle = {
    client: null,
    identityKeypair: null,
    reloadNow: async () => {},
    kick: () => {},
    broadcast: () => {},
    getStatus: () => ({
      enabled: false,
      relayUrl: "",
      identityFingerprint: null,
      identityPubHex: null,
      sessions: [],
    }),
    close: () => {},
  };

  if (!enabled) {
    log.info?.("[remote-pairing] disabled — orchestrator returning dormant handle");
    return handle;
  }

  if (typeof opts.requestListener !== "function") {
    throw new TypeError("startRemotePairingRelay: requestListener required");
  }

  const relayUrl = (opts.relayUrl ?? process.env.REMOTE_PAIRING_RELAY_URL ?? DEFAULT_RELAY_URL).trim();
  if (!relayUrl) throw new Error("startRemotePairingRelay: empty relayUrl");
  const audit = createAuditEmitter(opts.auditEventSink, log);

  const identityKeypairFile = opts.identityKeypairFile ?? REMOTE_PAIRING_ENV_FILE;
  const pairingsFile = opts.pairingsFile ?? REMOTE_PAIRINGS_FILE;

  // 1. Ensure the bridge has a static keypair.
  const identityKeypair = await ensureIdentityKeypair(identityKeypairFile);
  log.info?.(`[remote-pairing] identity pub=${bytesToHex(identityKeypair.pub)}`);

  // 2. Build the dispatch (adapter from RPC → bridge HTTP handler).
  const dispatch = createHttpDispatch({
    requestListener: opts.requestListener,
    remoteAddressPrefix: opts.remoteAddressPrefix,
    responseTimeoutMs: opts.responseTimeoutMs,
    logger: log,
  });

  // 3. Resolve a default WebSocketImpl if the caller didn't pass one.
  const WebSocketImpl = opts.WebSocketImpl ?? (await defaultWebSocketImpl());

  // 4. Construct the relay client. We pre-load the pairings here so the
  //    initial sessions spawn at start() time without the client doing its
  //    own (potentially-throwing) load.
  const initialPairings = await loadPairings(pairingsFile).catch((err) => {
    log.warn?.(`[remote-pairing] failed to load ${pairingsFile}: ${err.message}`);
    return [];
  });
  log.info?.(`[remote-pairing] loaded ${initialPairings.length} paired phone(s) from ${pairingsFile}`);

  const client = new BridgeRelayClient({
    relayUrl,
    identityKeypair,
    pairings: initialPairings,
    pairingsFile, // for reload()
    dispatch,
    onSessionState: ({ pairingId, phoneFingerprint, label, deviceId, state, prev }) => {
      if (state === prev) return;
      log.debug?.(`[remote-pairing] ${redactPairingId(pairingId)} ${prev} → ${state}`);
      if (state === "connected") {
        audit({
          type: "session_connected",
          outcome: "success",
          pairingId: redactPairingId(pairingId),
          phoneFingerprint,
          label,
          deviceId,
          state,
          previousState: prev,
        });
      } else if (state === "failed") {
        audit({
          type: "session_failed",
          outcome: "failure",
          pairingId: redactPairingId(pairingId),
          phoneFingerprint,
          label,
          deviceId,
          state,
          previousState: prev,
        });
      } else if (prev === "connected" && state === "disconnected") {
        audit({
          type: "session_disconnected",
          outcome: "info",
          pairingId: redactPairingId(pairingId),
          phoneFingerprint,
          label,
          deviceId,
          state,
          previousState: prev,
        });
      }
    },
    onError: (err, ctx) => {
      log.warn?.(
        `[remote-pairing] error${ctx?.pairingId ? ` (${redactPairingId(ctx.pairingId)})` : ""}: ${err?.message}`,
      );
      audit({
        type: "session_error",
        outcome: "failure",
        pairingId: ctx?.pairingId ? redactPairingId(ctx.pairingId) : "",
        phoneFingerprint: ctx?.phoneFingerprint,
        label: ctx?.label,
        deviceId: ctx?.deviceId,
        reason: err?.message || "remote pairing error",
      });
    },
    onSeen: ({ pairing, atMs, channelBinding }) => {
      log.debug?.(`[remote-pairing] ${redactPairingId(pairing.pairingId)} seen at ${new Date(atMs).toISOString()}`);
      markSeenPersisted(pairing.phonePub, { atMs, channelBinding }, pairingsFile).catch((err) => {
        log.warn?.(`[remote-pairing] last-seen persist failed for ${redactPairingId(pairing.pairingId)}: ${err?.message}`);
      });
    },
    WebSocketImpl,
    pingIntervalMs: opts.pingIntervalMs,
    backoffMs: opts.backoffMs,
    handshakeTimeoutMs: opts.handshakeTimeoutMs,
    prologue: opts.prologue,
    logger: log,
  });

  await client.start();

  // 5. Optional fs.watch. Some filesystems / Docker volumes don't fire
  //    events; the LAN-pair handler should still call reloadNow() after
  //    writing. fs.watch is just a convenience for interactive editing.
  let watcher = null;
  let reloadTimer = null;
  const triggerReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      reloadTimer = null;
      try {
        await client.reload();
        log.debug?.(`[remote-pairing] reloaded — ${client.getSessions().length} session(s) live`);
      } catch (err) {
        log.warn?.(`[remote-pairing] reload failed: ${err?.message}`);
      }
    }, RELOAD_DEBOUNCE_MS);
  };

  if (opts.watchPairingsFile !== false) {
    try {
      watcher = fsWatch(pairingsFile, { persistent: false }, () => triggerReload());
      // Some platforms fire ENOENT on first events; a no-op error handler
      // keeps the bridge from crashing if the file is rotated mid-run.
      watcher.on?.("error", (err) => {
        log.warn?.(`[remote-pairing] pairings watcher error: ${err?.message}`);
      });
    } catch (err) {
      log.debug?.(`[remote-pairing] fs.watch unavailable for ${pairingsFile}: ${err?.message}`);
    }
  }

  // ---- Populate the handle now that everything's wired ----

  handle.client = client;
  handle.identityKeypair = identityKeypair;
  handle.reloadNow = async () => {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
      reloadTimer = null;
    }
    await client.reload();
  };
  handle.kick = () => client.kick();
  handle.broadcast = (topic, data) => client.broadcast(topic, data);
  handle.getStatus = () => ({
    enabled: true,
    relayUrl,
    identityFingerprint: identityKeypair ? fingerprintPub(identityKeypair.pub) : null,
    identityPubHex: identityKeypair ? bytesToHex(identityKeypair.pub) : null,
    sessions: client.getSessions(),
  });
  handle.close = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    if (watcher) {
      try { watcher.close(); } catch {}
    }
    client.close();
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function defaultWebSocketImpl() {
  // Lazy-import `ws` so consumers that supply their own implementation (or
  // run in environments without the package — like tests) don't pay the
  // resolution cost.
  try {
    const mod = await import("ws");
    return mod.default ?? mod.WebSocket ?? mod;
  } catch (err) {
    throw new Error(
      `startRemotePairingRelay: couldn't load 'ws' (${err.message}). ` +
      `Install it (npm i ws) or pass WebSocketImpl explicitly.`,
    );
  }
}

function normalizeLogger(logger) {
  if (!logger) return {};
  return {
    debug: typeof logger.debug === "function" ? logger.debug.bind(logger) : undefined,
    warn: typeof logger.warn === "function" ? logger.warn.bind(logger) : undefined,
    error: typeof logger.error === "function" ? logger.error.bind(logger) : undefined,
    info: typeof logger.info === "function" ? logger.info.bind(logger) : undefined,
  };
}

function redactPairingId(pairingId) {
  const value = String(pairingId || "");
  return value ? `pairing:${value.slice(0, 6)}…` : "pairing:unknown";
}

function createAuditEmitter(sink, log) {
  if (typeof sink !== "function") return () => {};
  return (event) => {
    try {
      const maybe = sink(event);
      if (maybe && typeof maybe.then === "function") {
        maybe.catch((err) => {
          log.warn?.(`[remote-pairing] audit write failed: ${err?.message}`);
        });
      }
    } catch (err) {
      log.warn?.(`[remote-pairing] audit write failed: ${err?.message}`);
    }
  };
}

function fingerprintPub(pub) {
  // Reuse the existing fingerprint helper — keeps the hex form consistent
  // with how pairings.mjs labels phones.
  // (Kept inline to avoid a circular import via keys.mjs which itself uses
  // it; orchestrator.mjs is a top-level wiring module so it's fine.)
  return bytesToHex(pub).slice(0, 12).toUpperCase().replace(/(.{4})/g, "$1-").replace(/-$/, "");
}

// Expose this so unit tests can poke at the debounce without sleeping.
export const __RELOAD_DEBOUNCE_MS = RELOAD_DEBOUNCE_MS;
