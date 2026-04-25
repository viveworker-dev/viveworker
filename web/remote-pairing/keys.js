/**
 * web/remote-pairing/keys.js — IndexedDB-backed identity key store (browser).
 *
 * Mirrors the Node-side `scripts/lib/remote-pairing/keys.mjs` API
 * (load / save / ensure / clear) so the rest of the remote-pairing
 * client can consume the same shape regardless of platform. Pure crypto
 * helpers (`generateIdentityKeypair`, `publicFromPrivate`,
 * `fingerprintIdentity`, hex helpers) are re-exported from the shared
 * bundle.
 *
 * Storage model:
 *   DB:    viveworker-remote-pairing
 *   Store: keys
 *   Key:   "identity"
 *   Value: { priv: Uint8Array(32), pub: Uint8Array(32), createdAtMs: number }
 *
 * Threat model (Phase 2 MVP):
 *   - IndexedDB is origin-scoped and survives PWA restarts. A user
 *     "clear site data" wipes it; we treat that as the device losing
 *     its pairing identity (re-pair from LAN required).
 *   - Private bytes are stored extractable. Migrating to Web Crypto
 *     non-extractable CryptoKey requires switching the handshake's DH
 *     calls to Web Crypto's X25519 (Chrome 100+, Safari 17+, Firefox 100+).
 *     That's tracked as a future hardening pass — for now filesystem-style
 *     origin scoping is what we lean on.
 *
 * The async API tolerates "no IndexedDB" (e.g., Safari private mode in
 * some configs): callers get a thrown error with a clear message and can
 * decide whether to surface it to the user or fall back to in-memory only.
 */

// Relative path so the same source resolves correctly under both the bridge
// (which serves /remote-pairing/keys.js → /remote-pairing.bundle.js) and
// Node-driven unit tests (which load it from the filesystem).
import {
  generateIdentityKeypair as bundleGenerateIdentityKeypair,
  publicFromPrivate,
  fingerprintIdentity,
  bytesToHex,
  hexToBytes,
  IDENTITY_KEY_BYTES,
} from "../remote-pairing.bundle.js";

// Re-export the pure helpers so callers don't have to import the bundle
// directly for everyday operations.
export {
  publicFromPrivate,
  fingerprintIdentity,
  bytesToHex,
  hexToBytes,
  IDENTITY_KEY_BYTES,
};

const DB_NAME = "viveworker-remote-pairing";
const DB_VERSION = 1;
const STORE_NAME = "keys";
const RECORD_KEY = "identity";

// ---------------------------------------------------------------------------
// IndexedDB plumbing
// ---------------------------------------------------------------------------

/**
 * Open (or upgrade) the database. Cached after first open; safe to call
 * concurrently — only one upgrade transaction will run.
 *
 * @param {{ indexedDB?: IDBFactory }} [options]
 * @returns {Promise<IDBDatabase>}
 */
function openDB({ indexedDB = globalThis.indexedDB } = {}) {
  if (!indexedDB) {
    return Promise.reject(new Error("IndexedDB not available in this environment"));
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
    req.onblocked = () => reject(new Error("indexedDB.open blocked by another tab"));
  });
}

/**
 * Run a single object-store transaction. The callback receives the store
 * and returns the IDBRequest whose `result` we should resolve with.
 */
function runTx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    let req;
    try {
      req = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error ?? new Error("transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a fresh keypair (does NOT persist; pair with `saveIdentityKeypair`
 * or use `ensureIdentityKeypair` for the load-or-create path).
 *
 * @returns {{ priv: Uint8Array, pub: Uint8Array }}
 */
export function generateIdentityKeypair() {
  return bundleGenerateIdentityKeypair();
}

/**
 * Load the persisted keypair, or null if none has been saved yet.
 *
 * @param {{ indexedDB?: IDBFactory }} [options]
 * @returns {Promise<{ priv: Uint8Array, pub: Uint8Array, createdAtMs: number } | null>}
 */
export async function loadIdentityKeypair(options) {
  const db = await openDB(options);
  try {
    const record = await runTx(db, "readonly", (store) => store.get(RECORD_KEY));
    if (!record) return null;
    const priv = coerceBytes(record.priv);
    const pub = coerceBytes(record.pub);
    if (priv.length !== IDENTITY_KEY_BYTES || pub.length !== IDENTITY_KEY_BYTES) {
      return null; // corrupt; let caller decide whether to reset
    }
    // Sanity check: derived pub should match stored pub. If it diverges
    // (shouldn't happen barring storage corruption), trust the priv.
    const derivedPub = publicFromPrivate(priv);
    if (!equalBytes(derivedPub, pub)) {
      // Best we can do client-side; surface via a console warning so devs
      // notice during testing. Production callers will eventually want to
      // wipe + regenerate.
      console.warn("[remote-pairing/keys] stored pub disagrees with derived pub; trusting private key");
      return { priv, pub: derivedPub, createdAtMs: numberOr(record.createdAtMs, Date.now()) };
    }
    return { priv, pub, createdAtMs: numberOr(record.createdAtMs, Date.now()) };
  } finally {
    db.close();
  }
}

/**
 * Persist a keypair. Overwrites any existing record.
 *
 * @param {{ priv: Uint8Array, pub: Uint8Array }} keypair
 * @param {{ indexedDB?: IDBFactory }} [options]
 */
export async function saveIdentityKeypair(keypair, options) {
  if (!keypair?.priv || !keypair?.pub) throw new TypeError("keypair { priv, pub } required");
  if (keypair.priv.length !== IDENTITY_KEY_BYTES) throw new RangeError("priv must be 32 bytes");
  if (keypair.pub.length !== IDENTITY_KEY_BYTES) throw new RangeError("pub must be 32 bytes");

  const db = await openDB(options);
  try {
    const record = {
      priv: copyBytes(keypair.priv),
      pub: copyBytes(keypair.pub),
      createdAtMs: Date.now(),
    };
    await runTx(db, "readwrite", (store) => store.put(record, RECORD_KEY));
  } finally {
    db.close();
  }
}

/**
 * Load the persisted keypair, generating + saving a fresh one if none exists.
 *
 * @param {{ indexedDB?: IDBFactory }} [options]
 * @returns {Promise<{ priv: Uint8Array, pub: Uint8Array, createdAtMs: number }>}
 */
export async function ensureIdentityKeypair(options) {
  const existing = await loadIdentityKeypair(options);
  if (existing) return existing;
  const fresh = generateIdentityKeypair();
  await saveIdentityKeypair(fresh, options);
  return { ...fresh, createdAtMs: Date.now() };
}

/**
 * Wipe the persisted keypair. Used by the "unpair this device" flow.
 *
 * @param {{ indexedDB?: IDBFactory }} [options]
 */
export async function clearIdentityKeypair(options) {
  const db = await openDB(options);
  try {
    await runTx(db, "readwrite", (store) => store.delete(RECORD_KEY));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function coerceBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return new Uint8Array(value);
  throw new TypeError(`unsupported byte container: ${typeof value}`);
}

function copyBytes(bytes) {
  // Defensive copy so a caller mutating its array after save doesn't
  // poison the persisted record. (IndexedDB structured-clones, so this
  // is partially redundant — but it costs ~64B and removes a footgun.)
  const u8 = coerceBytes(bytes);
  const out = new Uint8Array(u8.length);
  out.set(u8);
  return out;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}
