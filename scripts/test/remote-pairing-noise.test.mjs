/**
 * remote-pairing-noise.test.mjs — Phase 0 verification for the Noise IK
 * implementation under scripts/lib/remote-pairing/noise.mjs.
 *
 * Run:
 *   node --test scripts/test/remote-pairing-noise.test.mjs
 *
 * What we're proving:
 *   1. The handshake completes (both sides reach step=2, same handshakeHash).
 *   2. Transport messages encrypt/decrypt in both directions.
 *   3. Associated data is bound into AEAD (tampering with it fails).
 *   4. Wire bytes contain no plaintext substring (relay POV).
 *   5. Tampered ciphertext is rejected.
 *   6. A wrong responder static key causes handshake failure.
 *   7. Out-of-order delivery breaks (counter-based nonce, no re-ordering).
 *   8. Identity key persistence round-trips and the fingerprint is stable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  HandshakeState,
  NoiseSession,
  PROTOCOL_NAME,
  TAGLEN,
  DHLEN,
  generateIdentityKeypair as noiseGenIdentity,
  createInitiator,
  createResponder,
  _internals,
} from "../lib/remote-pairing/noise.mjs";

import {
  bytesToHex,
  hexToBytes,
  ensureIdentityKeypair,
  loadIdentityKeypair,
  saveIdentityKeypair,
  generateIdentityKeypair,
  fingerprintIdentity,
  IDENTITY_KEY_BYTES,
} from "../lib/remote-pairing/keys.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

/** Run a complete IK handshake and return both NoiseSessions. */
function runHandshake({
  initiatorStatic = noiseGenIdentity(),
  responderStatic = noiseGenIdentity(),
  prologue = enc("viveworker/remote-pairing/v1"),
  initialPayload1 = enc(""),
  initialPayload2 = enc(""),
  remoteStaticOverride = null, // for negative tests
} = {}) {
  const initiator = createInitiator({
    staticKeypair: initiatorStatic,
    remoteStatic: remoteStaticOverride ?? responderStatic.pub,
    prologue,
  });
  const responder = createResponder({
    staticKeypair: responderStatic,
    prologue,
  });

  const msg1 = initiator.writeMessage(initialPayload1);
  const recv1 = responder.readMessage(msg1);
  const msg2 = responder.writeMessage(initialPayload2);
  const recv2 = initiator.readMessage(msg2);

  return {
    initiator,
    responder,
    msg1,
    msg2,
    recv1,
    recv2,
    sessionI: initiator.intoSession(),
    sessionR: responder.intoSession(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("Noise IK handshake completes with matching channel binding", () => {
  const { initiator, responder, sessionI, sessionR, recv1, recv2 } = runHandshake({
    initialPayload1: enc("hello-from-phone"),
    initialPayload2: enc("hello-from-pc"),
  });

  assert.equal(initiator.isHandshakeFinished(), true);
  assert.equal(responder.isHandshakeFinished(), true);

  // Payloads piggybacked on handshake messages decrypt correctly.
  assert.equal(dec(recv1), "hello-from-phone");
  assert.equal(dec(recv2), "hello-from-pc");

  // Both sides converge on the same handshake hash → channel binding works.
  const bindingI = sessionI.getChannelBinding();
  const bindingR = sessionR.getChannelBinding();
  assert.equal(bytesToHex(bindingI), bytesToHex(bindingR));
  assert.equal(bindingI.length, 32);
});

test("Transport messages flow both directions independently", () => {
  const { sessionI, sessionR } = runHandshake();

  // Initiator → Responder
  const c1 = sessionI.send(enc("approve task #42"));
  const p1 = sessionR.recv(c1);
  assert.equal(dec(p1), "approve task #42");

  const c2 = sessionI.send(enc("approve task #43"));
  const p2 = sessionR.recv(c2);
  assert.equal(dec(p2), "approve task #43");

  // Responder → Initiator
  const c3 = sessionR.send(enc("task #42 done"));
  const p3 = sessionI.recv(c3);
  assert.equal(dec(p3), "task #42 done");

  // Counters are independent: I→R and R→I both started at 0.
  // (Implicitly verified by the fact that the four messages above each
  //  decrypted; if counters were shared, one direction would desync.)
});

test("Associated data is bound into AEAD", () => {
  const { sessionI, sessionR } = runHandshake();

  const ad = enc("envelope:seq=42,mid=abc123");
  const ct = sessionI.send(enc("payload"), ad);

  // Correct AD → decrypts.
  const pt = sessionR.recv(ct, ad);
  assert.equal(dec(pt), "payload");

  // Modified AD → MAC failure (need fresh session because send counter advanced).
  const fresh = runHandshake();
  const ct2 = fresh.sessionI.send(enc("payload"), ad);
  const tamperedAd = enc("envelope:seq=43,mid=abc123");
  assert.throws(() => fresh.sessionR.recv(ct2, tamperedAd), /invalid|tag|mac|auth/i);
});

test("Wire bytes contain no plaintext substring (relay POV)", () => {
  // Plaintext explicitly chosen as ASCII so the search is meaningful.
  const plaintext = "USER_APPROVED_PAYMENT_TO_0xDEADBEEF_AMOUNT_100USDC";
  const ptBytes = enc(plaintext);

  // Run two handshakes so we have multiple wire samples (handshake + transport).
  const a = runHandshake({ initialPayload1: ptBytes });
  assert.deepEqual(dec(a.recv1), plaintext); // sanity: it did get through

  // The handshake message bytes (msg1) carry the encrypted initial payload.
  // Search those bytes for the plaintext — should not appear.
  const plaintextBytes = ptBytes;
  function containsSubstring(haystack, needle) {
    if (needle.length === 0 || needle.length > haystack.length) return false;
    for (let i = 0; i <= haystack.length - needle.length; i++) {
      let match = true;
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) { match = false; break; }
      }
      if (match) return true;
    }
    return false;
  }
  assert.equal(
    containsSubstring(a.msg1, plaintextBytes),
    false,
    "plaintext leaked into handshake message",
  );

  // And a transport message:
  const transportCt = a.sessionI.send(ptBytes);
  assert.equal(
    containsSubstring(transportCt, plaintextBytes),
    false,
    "plaintext leaked into transport message",
  );

  // Transport ciphertext length = plaintext + 16 byte tag (Poly1305).
  assert.equal(transportCt.length, plaintextBytes.length + TAGLEN);
});

test("Tampered ciphertext is rejected", () => {
  const { sessionI, sessionR } = runHandshake();
  const ct = sessionI.send(enc("approve transfer 100USDC"));
  // Flip one byte in the middle of the ciphertext.
  const tampered = new Uint8Array(ct);
  tampered[5] ^= 0x01;
  assert.throws(() => sessionR.recv(tampered), /invalid|tag|mac|auth/i);
});

test("Wrong responder static key causes handshake failure", () => {
  const wrong = noiseGenIdentity();
  // Initiator believes the responder's static is `wrong.pub` but the
  // responder is using its real keypair. The es DH won't match, so
  // EncryptAndHash on the responder side produces nonsense which
  // DecryptAndHash will reject.
  assert.throws(() => {
    runHandshake({ remoteStaticOverride: wrong.pub });
  }, /invalid|tag|mac|auth/i);
});

test("Out-of-order delivery breaks (counters are strict)", () => {
  const { sessionI, sessionR } = runHandshake();
  const c1 = sessionI.send(enc("first"));
  const c2 = sessionI.send(enc("second"));

  // Receive in order: ok.
  const fresh = runHandshake();
  assert.equal(dec(fresh.sessionR.recv(fresh.sessionI.send(enc("ok")))), "ok");

  // On the original sessionR, try to recv c2 first — counter will advance to
  // 1 expecting nonce 0 ciphertext, but c2 was sealed under nonce 1 → fails.
  assert.throws(() => sessionR.recv(c2), /invalid|tag|mac|auth/i);
});

test("Channel binding is deterministic given same prologue+keys", () => {
  const initiatorStatic = noiseGenIdentity();
  const responderStatic = noiseGenIdentity();
  // Note: ephemerals differ per run, so binding hashes will differ between
  // runs even with the same statics. We assert the *consistency* between
  // both sides of a single run instead.
  const a = runHandshake({ initiatorStatic, responderStatic });
  const b = runHandshake({ initiatorStatic, responderStatic });
  assert.equal(
    bytesToHex(a.sessionI.getChannelBinding()),
    bytesToHex(a.sessionR.getChannelBinding()),
  );
  assert.equal(
    bytesToHex(b.sessionI.getChannelBinding()),
    bytesToHex(b.sessionR.getChannelBinding()),
  );
  assert.notEqual(
    bytesToHex(a.sessionI.getChannelBinding()),
    bytesToHex(b.sessionI.getChannelBinding()),
    "channel binding should differ across runs (ephemeral keys)",
  );
});

test("Identity keypair: hex round-trip", () => {
  const kp = generateIdentityKeypair();
  assert.equal(kp.priv.length, IDENTITY_KEY_BYTES);
  assert.equal(kp.pub.length, IDENTITY_KEY_BYTES);
  const hex = bytesToHex(kp.priv);
  assert.match(hex, /^[0-9a-f]{64}$/);
  const back = hexToBytes(hex);
  assert.deepEqual(back, kp.priv);
});

test("Identity keypair: persistence round-trip", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vw-rp-keys-"));
  const envPath = path.join(tmpDir, "remote-pairing.env");
  try {
    const fresh = await ensureIdentityKeypair(envPath);
    assert.equal(fresh.priv.length, IDENTITY_KEY_BYTES);

    // Mode bits should be 0o600.
    const stat = await fs.stat(envPath);
    assert.equal(stat.mode & 0o777, 0o600, `env file mode is ${(stat.mode & 0o777).toString(8)}, expected 600`);

    // Re-load returns the same key.
    const loaded = await loadIdentityKeypair(envPath);
    assert.deepEqual(loaded.priv, fresh.priv);
    assert.deepEqual(loaded.pub, fresh.pub);

    // ensureIdentityKeypair on the same path returns existing (no churn).
    const again = await ensureIdentityKeypair(envPath);
    assert.deepEqual(again.priv, fresh.priv);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Identity keypair: fingerprint is stable and well-formed", () => {
  const kp = generateIdentityKeypair();
  const fp = fingerprintIdentity(kp.pub);
  // Format: XXXX-XXXX-XXXX, 14 chars total
  assert.match(fp, /^[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/);
  assert.equal(fingerprintIdentity(kp.pub), fp); // stable
  // Different keys → different fingerprints (overwhelmingly likely)
  const other = generateIdentityKeypair();
  assert.notEqual(fingerprintIdentity(other.pub), fp);
});

test("Internal: nonce formatter matches Noise §5.1", () => {
  const { formatNonce } = _internals;
  // Noise spec example: counter=0 → 12 zero bytes
  assert.deepEqual(formatNonce(0), new Uint8Array(12));
  // counter=1 → 4 zero bytes + 0x01 0x00 0x00 0x00 0x00 0x00 0x00 0x00 (LE u64)
  const expected1 = new Uint8Array(12);
  expected1[4] = 1;
  assert.deepEqual(formatNonce(1), expected1);
  // counter=256 → 4 zero, then 0x00 0x01 0x00 0x00 0x00 0x00 0x00 0x00
  const expected256 = new Uint8Array(12);
  expected256[5] = 1;
  assert.deepEqual(formatNonce(256), expected256);
});

test("Internal: HKDF returns the requested number of 32-byte outputs", () => {
  const { noiseHkdf } = _internals;
  const ck = new Uint8Array(32).fill(7);
  const ikm = new Uint8Array(32).fill(11);
  const [a, b] = noiseHkdf(ck, ikm, 2);
  assert.equal(a.length, 32);
  assert.equal(b.length, 32);
  // Outputs should be distinct (probability of collision is negligible).
  assert.notDeepEqual(a, b);
  // Calling again with same inputs is deterministic.
  const [a2, b2] = noiseHkdf(ck, ikm, 2);
  assert.deepEqual(a, a2);
  assert.deepEqual(b, b2);
});

test("Public protocol name matches Noise spec", () => {
  assert.equal(PROTOCOL_NAME, "Noise_IK_25519_ChaChaPoly_SHA256");
});

test("DHLEN constant is 32 (X25519)", () => {
  assert.equal(DHLEN, 32);
});
