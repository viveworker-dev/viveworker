/**
 * keys.mjs — Identity key persistence for the PC bridge (Node-side).
 *
 * Pure helpers (encoding, fingerprint, key derivation) live in keys-core.mjs
 * so the browser bundle can use them without dragging in `node:fs`. This
 * file adds the file-backed `loadIdentityKeypair` / `saveIdentityKeypair`
 * / `ensureIdentityKeypair` trio the bridge uses.
 *
 * Layered key model (see review notes — three layers, intentionally separated):
 *
 *   ┌────────────────────────┬──────────────────────┬─────────────────────────┐
 *   │ Wallet                 │ Identity (this file) │ Session                 │
 *   ├────────────────────────┼──────────────────────┼─────────────────────────┤
 *   │ secp256k1 (existing)   │ X25519 long-term     │ X25519 ephemeral → AEAD │
 *   │ EVM signing / USDC     │ Device-pair auth     │ Per-connection forward  │
 *   │                        │ (Noise IK static s)  │ secrecy (CipherState)   │
 *   │ hazBase / wallet UI    │ Generated here       │ Derived during Noise    │
 *   │                        │                      │ handshake; never stored │
 *   └────────────────────────┴──────────────────────┴─────────────────────────┘
 *
 * Storage model (Phase 0 — minimum viable):
 *   - PC bridge: ~/.viveworker/remote-pairing.env
 *     - REMOTE_PAIRING_IDENTITY_PRIV: hex-encoded 32-byte X25519 private key
 *     - REMOTE_PAIRING_IDENTITY_PUB:  hex-encoded 32-byte X25519 public key
 *     File mode 0o600. macOS Keychain / Secure Enclave integration is a
 *     follow-up (tracked separately) — for now we lean on filesystem perms.
 *   - Phone PWA: see web/remote-pairing/keys.js (IndexedDB-backed). The PWA
 *     side reuses keys-core.mjs for the pure parts (fingerprint, hex, etc).
 *
 * Encoding choice: hex (lowercase, no separators). Matches the existing
 * a2a.env style of secrets so users see one consistent format.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  IDENTITY_KEY_BYTES,
  bytesToHex,
  hexToBytes,
  generateIdentityKeypair,
  publicFromPrivate,
  fingerprintIdentity,
} from "./keys-core.mjs";

import { upsertEnvText } from "../pairing.mjs";

// Re-export the pure helpers so existing callers (and tests) that import
// from `keys.mjs` keep working without churn.
export {
  IDENTITY_KEY_BYTES,
  bytesToHex,
  hexToBytes,
  generateIdentityKeypair,
  publicFromPrivate,
  fingerprintIdentity,
};

// ---------------------------------------------------------------------------
// Persistence (Node-only)
// ---------------------------------------------------------------------------

export const REMOTE_PAIRING_ENV_FILE = path.join(
  os.homedir(),
  ".viveworker",
  "remote-pairing.env",
);

const ENV_KEY_PRIV = "REMOTE_PAIRING_IDENTITY_PRIV";
const ENV_KEY_PUB = "REMOTE_PAIRING_IDENTITY_PUB";

/**
 * Load the bridge's identity keypair from disk. Returns null if the file
 * doesn't exist or doesn't contain the expected keys (caller decides whether
 * to generate a fresh one).
 *
 * @param {string} [envPath]
 * @returns {Promise<{priv: Uint8Array, pub: Uint8Array} | null>}
 */
export async function loadIdentityKeypair(envPath = REMOTE_PAIRING_ENV_FILE) {
  let text;
  try {
    text = await fs.readFile(envPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  const map = parseEnv(text);
  const privHex = map.get(ENV_KEY_PRIV);
  if (!privHex) return null;

  let priv;
  try {
    priv = hexToBytes(privHex);
  } catch {
    return null;
  }
  if (priv.length !== IDENTITY_KEY_BYTES) return null;

  const pub = publicFromPrivate(priv);
  // If a stored pub disagrees, prefer the derived one but warn.
  const pubHex = map.get(ENV_KEY_PUB);
  if (pubHex) {
    try {
      const stored = hexToBytes(pubHex);
      if (stored.length === pub.length) {
        let differs = false;
        for (let i = 0; i < pub.length; i++) {
          if (stored[i] !== pub[i]) { differs = true; break; }
        }
        if (differs) {
          console.warn(`[remote-pairing/keys] ${ENV_KEY_PUB} disagrees with derived pub; trusting private key`);
        }
      }
    } catch {
      // ignore garbage pub line
    }
  }

  return { priv, pub };
}

/**
 * Persist an identity keypair to disk with mode 0o600 / dir mode 0o700.
 * Existing file content is preserved (other keys in the env survive).
 */
export async function saveIdentityKeypair(keypair, envPath = REMOTE_PAIRING_ENV_FILE) {
  if (!keypair?.priv || !keypair?.pub) throw new TypeError("keypair {priv, pub} required");
  if (keypair.priv.length !== IDENTITY_KEY_BYTES) throw new RangeError("priv must be 32 bytes");
  if (keypair.pub.length !== IDENTITY_KEY_BYTES) throw new RangeError("pub must be 32 bytes");

  const dir = path.dirname(envPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  let current = "";
  try {
    current = await fs.readFile(envPath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const updated = upsertEnvText(current, {
    [ENV_KEY_PRIV]: bytesToHex(keypair.priv),
    [ENV_KEY_PUB]: bytesToHex(keypair.pub),
  });

  await fs.writeFile(envPath, updated, { mode: 0o600 });
}

/**
 * Load existing keypair, generating + persisting a new one if absent. The
 * "ensure" pattern matches what we already do for A2A_RELAY_SECRET in
 * a2a-relay-client.mjs.
 */
export async function ensureIdentityKeypair(envPath = REMOTE_PAIRING_ENV_FILE) {
  const existing = await loadIdentityKeypair(envPath);
  if (existing) return existing;
  const fresh = generateIdentityKeypair();
  await saveIdentityKeypair(fresh, envPath);
  return fresh;
}

// ---------------------------------------------------------------------------
// Internal: env file parser (independent from upsertEnvText which is write-only)
// ---------------------------------------------------------------------------

function parseEnv(text) {
  const map = new Map();
  for (const rawLine of String(text || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) map.set(key, value);
  }
  return map;
}
