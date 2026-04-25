/**
 * keys-core.mjs — Identity key helpers that run in both Node and the browser.
 *
 * Sibling of `keys.mjs` (Node-only persistence). Anything that touches
 * `node:fs`, `node:os`, or `node:path` belongs in keys.mjs; anything pure
 * (encoding, fingerprinting, key derivation) belongs here so the same
 * code path serves the PWA bundle and the bridge.
 *
 * Layered key model (recap — see keys.mjs comment for the full table):
 *
 *   Wallet (secp256k1) — wallet UI                    [other module]
 *   Identity (X25519 long-term) — Noise IK static `s` [this file + keys.mjs]
 *   Session  (X25519 ephemeral) — derived in Noise    [noise.mjs]
 *
 * The browser implementation (`web/remote-pairing/keys.js`) layers
 * IndexedDB / non-extractable CryptoKey storage *over* this module.
 */

import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const IDENTITY_KEY_BYTES = 32;

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

const HEX_RE = /^[0-9a-fA-F]+$/;

export function bytesToHex(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("bytesToHex expects Uint8Array");
  }
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0 || !HEX_RE.test(hex)) {
    throw new TypeError(`invalid hex: ${typeof hex === "string" ? hex.slice(0, 16) : typeof hex}…`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Generate a fresh X25519 identity keypair. Caller owns persistence.
 */
export function generateIdentityKeypair() {
  const priv = x25519.utils.randomPrivateKey();
  const pub = x25519.getPublicKey(priv);
  return { priv, pub };
}

/**
 * Derive the public key from a stored private key. Microseconds — fine to
 * call on every load instead of persisting `pub` separately.
 */
export function publicFromPrivate(priv) {
  return x25519.getPublicKey(priv);
}

// ---------------------------------------------------------------------------
// Fingerprint — short user-visible identifier for the pub key
// ---------------------------------------------------------------------------

/**
 * 12-character base32-ish fingerprint of the public key, formatted as
 * `XXXX-XXXX-XXXX`. Designed for the pairing screen so the human can
 * eyeball-confirm both sides see the same key (defends against MitM
 * during pairing-code flows).
 *
 * Encoding: SHA-256(pub) → first 60 bits → 12 chars from a Crockford-like
 * alphabet (no easily-confused glyphs).
 */
export function fingerprintIdentity(pub) {
  if (!(pub instanceof Uint8Array)) throw new TypeError("pub must be Uint8Array");
  if (pub.length !== IDENTITY_KEY_BYTES) throw new RangeError("pub must be 32 bytes");

  const digest = sha256(pub);
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford-ish (no I/L/O/U)

  let acc = 0n;
  for (let i = 0; i < 8; i++) acc = (acc << 8n) | BigInt(digest[i]);
  // Take the high 60 bits → 12 base32 chars
  acc >>= 4n;

  let out = "";
  for (let i = 0; i < 12; i++) {
    const idx = Number(acc & 31n);
    out = alphabet[idx] + out;
    acc >>= 5n;
  }
  // Insert a dash every 4 chars for legibility: XXXX-XXXX-XXXX
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}
