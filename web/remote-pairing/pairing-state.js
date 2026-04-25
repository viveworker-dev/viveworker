/**
 * web/remote-pairing/pairing-state.js — localStorage-backed pairing record.
 *
 * After a successful LAN pairing the phone calls
 * `POST /api/remote-pairing/lan-enroll` and gets back enough information
 * to reach the same bridge over the relay when off-LAN:
 *
 *   - pairingId         (relay slot identifier; opaque to the phone)
 *   - bridgePubHex      (bridge's X25519 static pubkey — the phone uses
 *                        it as the responder static for Noise IK)
 *   - bridgeFingerprint (canonical "AB:CD:EF…" form for display)
 *   - relayUrl          (wss://… — destination of the WebSocket dial)
 *   - phonePub          (echoed; useful for "is this still my keypair?"
 *                        sanity checks against IndexedDB on bootstrap)
 *   - label             (whatever the phone sent at enroll time)
 *   - addedAtMs         (server-side timestamp; phones with skewed clocks
 *                        still see a coherent "added on" date)
 *
 * Why localStorage and not IndexedDB:
 *   - The X25519 *private* key lives in IndexedDB (keys.js) because
 *     it's the secret half of the identity. This file is metadata —
 *     pairingId, bridge pubkey, relay URL, label — and the security
 *     story is identical to "the phone can read its own session cookie":
 *     localStorage is origin-scoped to the bridge URL, and there's
 *     nothing here that wouldn't already be visible to a malicious
 *     script on the same origin.
 *   - localStorage is synchronous, which is convenient on the bootstrap
 *     hot path where we want to know "is this phone enrolled?" before
 *     we even have a chance to await anything.
 *
 * Single-record assumption:
 *   The phone is paired with at most ONE bridge at a time (current PWA
 *   design — `bridge URL = origin`). If we later support multi-bridge
 *   bookmarking, this becomes an array keyed by origin and the helpers
 *   grow a `bridgeOrigin` parameter. Keep callers using the helpers
 *   here so that future migration is local.
 *
 * Schema versioning:
 *   `version: 1` lets us reject + clear unknown shapes on bootstrap.
 *   When the format evolves, bump the constant and write a migrator.
 */

const STORAGE_KEY = "viveworker.remote-pairing.state";
const SCHEMA_VERSION = 1;

/**
 * @typedef {Object} RemotePairingState
 * @property {number} version            schema version (== SCHEMA_VERSION)
 * @property {string} pairingId          relay slot identifier
 * @property {string} phonePub           lowercase 64-hex of the phone's X25519 pub
 * @property {string} phoneFingerprint   canonical "AB:CD:EF…" of phonePub
 * @property {string} bridgePubHex       lowercase 64-hex of the bridge's X25519 pub
 * @property {string} bridgeFingerprint  canonical fingerprint of bridgePubHex
 * @property {string} relayUrl           ws:// or wss:// URL the bridge is on
 * @property {string} label              user-visible device label
 * @property {number} addedAtMs          server-side enroll time
 */

/**
 * Resolve the localStorage instance. Wrapped so tests can pass a stub
 * (e.g. a fake { getItem, setItem, removeItem } object) without monkey-
 * patching globalThis.
 *
 * @returns {Storage | null}
 */
function getStorage(opts) {
  if (opts?.storage) return opts.storage;
  if (typeof globalThis === "undefined") return null;
  // localStorage may be missing entirely (older Node-based test contexts)
  // or throw on access (some private-mode browsers). Treat both as "no
  // persistent storage" — the caller can decide whether to surface the
  // failure or fall back to in-memory only.
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the persisted pairing state, or null if there isn't one (or it's
 * malformed / wrong version — both treated identically: caller should
 * re-enroll).
 *
 * @param {{ storage?: Storage }} [opts]
 * @returns {RemotePairingState | null}
 */
export function loadPairingState(opts) {
  const store = getStorage(opts);
  if (!store) return null;
  let raw;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.version !== SCHEMA_VERSION) return null;
  // Light shape validation — every required string field must be present
  // and non-empty. We don't re-validate hex format here; the bridge owns
  // that and any garbage we'd find here came from a corrupted localStorage.
  const required = [
    "pairingId",
    "phonePub",
    "phoneFingerprint",
    "bridgePubHex",
    "bridgeFingerprint",
    "relayUrl",
  ];
  for (const key of required) {
    if (typeof parsed[key] !== "string" || parsed[key].length === 0) {
      return null;
    }
  }
  return {
    version: SCHEMA_VERSION,
    pairingId: parsed.pairingId,
    phonePub: parsed.phonePub.toLowerCase(),
    phoneFingerprint: parsed.phoneFingerprint,
    bridgePubHex: parsed.bridgePubHex.toLowerCase(),
    bridgeFingerprint: parsed.bridgeFingerprint,
    relayUrl: parsed.relayUrl,
    label: typeof parsed.label === "string" ? parsed.label : "",
    addedAtMs: Number.isFinite(parsed.addedAtMs) ? parsed.addedAtMs : 0,
  };
}

/**
 * Persist a pairing state record. Overwrites any existing record (the
 * single-record assumption above — re-enrolling under the same origin
 * replaces the previous bridge).
 *
 * @param {Omit<RemotePairingState, "version"> & { version?: number }} record
 * @param {{ storage?: Storage }} [opts]
 * @returns {boolean} true if written, false if storage is unavailable.
 */
export function savePairingState(record, opts) {
  const store = getStorage(opts);
  if (!store) return false;
  if (!record || typeof record !== "object") {
    throw new TypeError("savePairingState: record must be an object");
  }
  // Validate inputs synchronously so a buggy caller fails loudly rather
  // than persisting "undefined" strings.
  for (const key of [
    "pairingId",
    "phonePub",
    "phoneFingerprint",
    "bridgePubHex",
    "bridgeFingerprint",
    "relayUrl",
  ]) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
      throw new TypeError(`savePairingState: ${key} must be a non-empty string`);
    }
  }
  const out = {
    version: SCHEMA_VERSION,
    pairingId: record.pairingId,
    phonePub: record.phonePub.toLowerCase(),
    phoneFingerprint: record.phoneFingerprint,
    bridgePubHex: record.bridgePubHex.toLowerCase(),
    bridgeFingerprint: record.bridgeFingerprint,
    relayUrl: record.relayUrl,
    label: typeof record.label === "string" ? record.label : "",
    addedAtMs: Number.isFinite(record.addedAtMs) ? record.addedAtMs : Date.now(),
  };
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(out));
    return true;
  } catch {
    // Storage quota / disabled-by-user / private-mode-throws → swallow.
    // The user can re-trigger enrollment from the settings page later.
    return false;
  }
}

/**
 * Clear the pairing state. Use cases:
 *   - User logged out / unpaired the phone
 *   - Bridge identity changed (we detect it via bridgePubHex mismatch
 *     and need to force a re-enroll)
 *   - localStorage held a malformed record (shouldn't happen but
 *     `loadPairingState` returning null while `getItem` returns
 *     non-empty is a signal we want gone)
 *
 * @param {{ storage?: Storage }} [opts]
 */
export function clearPairingState(opts) {
  const store = getStorage(opts);
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

// Test-visible constants for tests that want to assert raw key shape.
export const __STORAGE_KEY = STORAGE_KEY;
export const __SCHEMA_VERSION = SCHEMA_VERSION;
