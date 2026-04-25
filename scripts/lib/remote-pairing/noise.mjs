/**
 * noise.mjs — Noise_IK_25519_ChaChaPoly_SHA256 implementation for viveworker
 * remote pairing.
 *
 * Why IK:
 *   - Initiator (phone) knows responder's (PC bridge's) static public key
 *     a priori, established during LAN-bootstrap pairing. This lets us do a
 *     1-RTT handshake with mutual authentication (both sides' static keys
 *     are bound into the transcript).
 *   - The relay (CF Worker + Durable Object) carries Noise messages opaquely;
 *     it cannot decrypt anything, only route by an outer envelope's `pairingId`.
 *
 * Wire layout (this module's responsibility ends at "Noise transport message"):
 *
 *   WSS frame body
 *   └─ outer envelope (relay sees this; defined elsewhere)
 *       ├─ seq, mid, type, ...   ← routing-only metadata
 *       └─ payload: bytes        ← Noise transport message (this module)
 *           └─ ciphertext + 16-byte Poly1305 tag
 *
 * Handshake:
 *   pre-message:        <- s   (responder's static public key, OOB at pairing)
 *   message 1 (i→r):    -> e, es, s, ss   (initiator sends ephemeral, encrypts its static)
 *   message 2 (r→i):    <- e, ee, se      (responder sends ephemeral, completes auth)
 *   then Split() yields cs1 (i→r) and cs2 (r→i) for transport.
 *
 * Reference: https://noiseprotocol.org/noise.html (revision 34)
 */

import { x25519 } from "@noble/curves/ed25519";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { sha256 } from "@noble/hashes/sha256";
import { hkdf } from "@noble/hashes/hkdf";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_SHA256";
export const HASHLEN = 32;
export const KEYLEN = 32;
export const DHLEN = 32;
export const TAGLEN = 16;
export const NONCE_MAX = 0xffff_ffff_ffff_ffffn; // 2^64 - 1; reserved as "rekey" in Noise

const PROTOCOL_NAME_BYTES = new TextEncoder().encode(PROTOCOL_NAME);

// ---------------------------------------------------------------------------
// Byte helpers (Uint8Array everywhere — no Buffer leakage so PWA can share)
// ---------------------------------------------------------------------------

function concat(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function asBytes(input) {
  if (input == null) return new Uint8Array(0);
  if (input instanceof Uint8Array) return input;
  if (typeof input === "string") return new TextEncoder().encode(input);
  if (Array.isArray(input)) return new Uint8Array(input);
  throw new TypeError(`unsupported input type: ${typeof input}`);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Noise primitives
// ---------------------------------------------------------------------------

function noiseHash(data) {
  return sha256(data);
}

/** HKDF with `n_outputs` 32-byte outputs, per Noise spec §4.3. */
function noiseHkdf(ck, ikm, nOutputs) {
  const length = nOutputs * HASHLEN;
  const out = hkdf(sha256, ikm, ck, new Uint8Array(0), length);
  const slices = [];
  for (let i = 0; i < nOutputs; i++) {
    slices.push(out.slice(i * HASHLEN, (i + 1) * HASHLEN));
  }
  return slices;
}

function generateKeypair() {
  const priv = x25519.utils.randomPrivateKey();
  const pub = x25519.getPublicKey(priv);
  return { priv, pub };
}

function dh(priv, pub) {
  return x25519.getSharedSecret(priv, pub);
}

/**
 * Format the AEAD nonce as 4 zero bytes (big-endian) followed by an 8-byte
 * little-endian counter. This matches the Noise spec §5.1.
 */
function formatNonce(counter) {
  const out = new Uint8Array(12);
  let v = BigInt(counter);
  for (let i = 4; i < 12; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function aeadEncrypt(key, counter, ad, plaintext) {
  const cipher = chacha20poly1305(key, formatNonce(counter), asBytes(ad));
  return cipher.encrypt(asBytes(plaintext));
}

function aeadDecrypt(key, counter, ad, ciphertext) {
  const cipher = chacha20poly1305(key, formatNonce(counter), asBytes(ad));
  return cipher.decrypt(asBytes(ciphertext));
}

// ---------------------------------------------------------------------------
// CipherState
// ---------------------------------------------------------------------------

/**
 * A single-direction symmetric cipher with a counter nonce. Used as building
 * block for SymmetricState (during handshake) and standalone for transport
 * messages after Split().
 */
class CipherState {
  constructor(key = null) {
    /** @type {Uint8Array | null} */
    this.k = key;
    this.n = 0n;
  }

  hasKey() {
    return this.k != null;
  }

  setKey(key) {
    this.k = key;
    this.n = 0n;
  }

  encryptWithAd(ad, plaintext) {
    if (!this.hasKey()) return asBytes(plaintext);
    if (this.n >= NONCE_MAX) throw new Error("nonce exhausted");
    const ct = aeadEncrypt(this.k, this.n, ad, plaintext);
    this.n += 1n;
    return ct;
  }

  decryptWithAd(ad, ciphertext) {
    if (!this.hasKey()) return asBytes(ciphertext);
    if (this.n >= NONCE_MAX) throw new Error("nonce exhausted");
    const pt = aeadDecrypt(this.k, this.n, ad, ciphertext);
    this.n += 1n;
    return pt;
  }
}

// ---------------------------------------------------------------------------
// SymmetricState
// ---------------------------------------------------------------------------

/**
 * Wraps a CipherState plus a chaining key (`ck`) and handshake hash (`h`).
 * Drives MixKey / MixHash / EncryptAndHash / DecryptAndHash.
 */
class SymmetricState {
  constructor(protocolName) {
    const nameBytes = asBytes(protocolName);
    if (nameBytes.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN);
      this.h.set(nameBytes, 0);
    } else {
      this.h = noiseHash(nameBytes);
    }
    this.ck = this.h.slice();
    this.cipher = new CipherState();
  }

  mixKey(ikm) {
    const [ck, tempK] = noiseHkdf(this.ck, ikm, 2);
    this.ck = ck;
    // Per Noise §5.2: truncate temp_k to KEYLEN (32). With SHA256 these are
    // already equal so this is a no-op, but keep the slice for clarity.
    this.cipher.setKey(tempK.slice(0, KEYLEN));
  }

  mixHash(data) {
    this.h = noiseHash(concat(this.h, asBytes(data)));
  }

  encryptAndHash(plaintext) {
    const ct = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext) {
    const pt = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  /** Final step: produce two CipherStates for transport (initiator→responder, responder→initiator). */
  split() {
    const [k1, k2] = noiseHkdf(this.ck, new Uint8Array(0), 2);
    return [new CipherState(k1.slice(0, KEYLEN)), new CipherState(k2.slice(0, KEYLEN))];
  }
}

// ---------------------------------------------------------------------------
// HandshakeState — Noise IK
// ---------------------------------------------------------------------------

/**
 * Drive an IK handshake. Caller wires the `writeMessage` / `readMessage` calls
 * to the underlying transport (WSS, in our production path; stdio pipes in
 * the Phase 0 test harness).
 *
 * @param {object} opts
 * @param {boolean} opts.initiator       - True for phone, false for PC bridge.
 * @param {{priv: Uint8Array, pub: Uint8Array}} opts.staticKeypair - Long-term identity keypair.
 * @param {Uint8Array} [opts.remoteStatic] - Required if initiator; remote's identity public key.
 * @param {Uint8Array} [opts.prologue]   - Pre-handshake context bytes hashed into both transcripts. Empty by default.
 */
export class HandshakeState {
  constructor({ initiator, staticKeypair, remoteStatic, prologue = new Uint8Array(0) }) {
    if (typeof initiator !== "boolean") throw new TypeError("initiator must be boolean");
    if (!staticKeypair?.priv || !staticKeypair?.pub) throw new TypeError("staticKeypair required");
    if (initiator && !remoteStatic) throw new Error("initiator requires remoteStatic (responder's public key)");

    this.initiator = initiator;
    this.s = staticKeypair;
    this.rs = remoteStatic ? asBytes(remoteStatic) : null;
    /** @type {{priv: Uint8Array, pub: Uint8Array} | null} */
    this.e = null;
    /** @type {Uint8Array | null} */
    this.re = null;

    this.symmetric = new SymmetricState(PROTOCOL_NAME);
    this.symmetric.mixHash(prologue);

    // Pre-message: <- s    (responder's static public key, both sides hash it)
    if (initiator) {
      this.symmetric.mixHash(this.rs);
    } else {
      this.symmetric.mixHash(this.s.pub);
    }

    /** @type {0|1|2} - 0 = waiting to send/recv message 1, 1 = ready for message 2, 2 = done */
    this.step = 0;
    /** @type {[CipherState, CipherState] | null} */
    this.transportCiphers = null;
    /** @type {Uint8Array | null} - Final h, can be used as channel binding */
    this.handshakeHash = null;
  }

  /** Write the next handshake message and return the bytes to put on the wire. */
  writeMessage(payload = new Uint8Array(0)) {
    const pt = asBytes(payload);
    if (this.step === 0 && this.initiator) {
      // -> e, es, s, ss
      this.e = generateKeypair();
      const buf = [];
      buf.push(this.e.pub);
      this.symmetric.mixHash(this.e.pub);
      this.symmetric.mixKey(dh(this.e.priv, this.rs)); // es
      buf.push(this.symmetric.encryptAndHash(this.s.pub)); // s (encrypted)
      this.symmetric.mixKey(dh(this.s.priv, this.rs));     // ss
      buf.push(this.symmetric.encryptAndHash(pt));          // payload
      this.step = 1;
      return concat(...buf);
    }
    if (this.step === 1 && !this.initiator) {
      // <- e, ee, se
      // Token names use Noise's "first letter = initiator's key, second = responder's key"
      // convention. So `se` = DH(initiator.s, responder.e). On the responder
      // side we compute that as DH(responder.e.priv, initiator.s.pub).
      this.e = generateKeypair();
      const buf = [];
      buf.push(this.e.pub);
      this.symmetric.mixHash(this.e.pub);
      this.symmetric.mixKey(dh(this.e.priv, this.re)); // ee = DH(responder.e.priv, initiator.e.pub)
      this.symmetric.mixKey(dh(this.e.priv, this.rs)); // se = DH(responder.e.priv, initiator.s.pub)
      buf.push(this.symmetric.encryptAndHash(pt));      // payload
      this._finalize();
      return concat(...buf);
    }
    throw new Error(`writeMessage called in unexpected state (step=${this.step}, initiator=${this.initiator})`);
  }

  /** Consume a received handshake message and return the decrypted payload. */
  readMessage(bytes) {
    const data = asBytes(bytes);
    let offset = 0;
    if (this.step === 0 && !this.initiator) {
      // -> e, es, s, ss   (responder receiving)
      const re = data.slice(offset, offset + DHLEN);
      offset += DHLEN;
      this.re = re;
      this.symmetric.mixHash(re);
      this.symmetric.mixKey(dh(this.s.priv, re)); // es (responder uses its static)
      const sCiphertext = data.slice(offset, offset + DHLEN + TAGLEN);
      offset += DHLEN + TAGLEN;
      const remoteStatic = this.symmetric.decryptAndHash(sCiphertext);
      this.rs = remoteStatic;
      this.symmetric.mixKey(dh(this.s.priv, remoteStatic)); // ss
      const payload = this.symmetric.decryptAndHash(data.slice(offset));
      this.step = 1;
      return payload;
    }
    if (this.step === 1 && this.initiator) {
      // <- e, ee, se   (initiator receiving)
      // `se` = DH(initiator.s, responder.e). On the initiator side we have
      // our own static priv plus responder's ephemeral pub from this message.
      const re = data.slice(offset, offset + DHLEN);
      offset += DHLEN;
      this.re = re;
      this.symmetric.mixHash(re);
      this.symmetric.mixKey(dh(this.e.priv, re)); // ee = DH(initiator.e.priv, responder.e.pub)
      this.symmetric.mixKey(dh(this.s.priv, re)); // se = DH(initiator.s.priv, responder.e.pub)
      const payload = this.symmetric.decryptAndHash(data.slice(offset));
      this._finalize();
      return payload;
    }
    throw new Error(`readMessage called in unexpected state (step=${this.step}, initiator=${this.initiator})`);
  }

  _finalize() {
    this.handshakeHash = this.symmetric.h.slice();
    const [cs1, cs2] = this.symmetric.split();
    // cs1 = initiator → responder, cs2 = responder → initiator
    this.transportCiphers = [cs1, cs2];
    this.step = 2;
  }

  isHandshakeFinished() {
    return this.step === 2;
  }

  /** After handshake, return a NoiseSession for transport messages. */
  intoSession() {
    if (!this.isHandshakeFinished()) throw new Error("handshake not finished");
    const [cs1, cs2] = this.transportCiphers;
    return new NoiseSession({
      initiator: this.initiator,
      sendCipher: this.initiator ? cs1 : cs2,
      recvCipher: this.initiator ? cs2 : cs1,
      handshakeHash: this.handshakeHash,
      remoteStatic: this.initiator ? this.rs : this.rs, // for both, populated after handshake
    });
  }
}

// ---------------------------------------------------------------------------
// NoiseSession — post-handshake transport
// ---------------------------------------------------------------------------

/**
 * Bidirectional encrypted session. Each direction has its own counter.
 *
 * Application-layer ad (associated data) is supported on every send/recv —
 * upper layers (envelope) bind their routing metadata into the AEAD by
 * passing it as `ad` so a tampered envelope can't pair with valid ciphertext.
 */
export class NoiseSession {
  constructor({ initiator, sendCipher, recvCipher, handshakeHash, remoteStatic }) {
    this.initiator = initiator;
    this.sendCipher = sendCipher;
    this.recvCipher = recvCipher;
    this.handshakeHash = handshakeHash;
    this.remoteStatic = remoteStatic;
  }

  send(plaintext, ad = new Uint8Array(0)) {
    return this.sendCipher.encryptWithAd(asBytes(ad), plaintext);
  }

  recv(ciphertext, ad = new Uint8Array(0)) {
    return this.recvCipher.decryptWithAd(asBytes(ad), ciphertext);
  }

  /** Channel binding token suitable for pinning to higher-level auth (e.g. WebAuthn challenge). */
  getChannelBinding() {
    return this.handshakeHash.slice();
  }
}

// ---------------------------------------------------------------------------
// Convenience factories
// ---------------------------------------------------------------------------

export function createInitiator({ staticKeypair, remoteStatic, prologue }) {
  return new HandshakeState({ initiator: true, staticKeypair, remoteStatic, prologue });
}

export function createResponder({ staticKeypair, prologue }) {
  return new HandshakeState({ initiator: false, staticKeypair, prologue });
}

// ---------------------------------------------------------------------------
// Identity keypair helpers (low-level — see keys.mjs for the persistence layer)
// ---------------------------------------------------------------------------

export function generateIdentityKeypair() {
  return generateKeypair();
}

// Re-exports for tests / debug tooling
export const _internals = {
  concat,
  asBytes,
  timingSafeEqual,
  noiseHkdf,
  noiseHash,
  formatNonce,
  aeadEncrypt,
  aeadDecrypt,
  CipherState,
  SymmetricState,
};
