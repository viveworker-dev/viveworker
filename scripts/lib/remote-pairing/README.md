# `scripts/lib/remote-pairing/` — viveworker remote pairing crypto

End-to-end encryption layer for connecting phone PWA ↔ PC bridge over an
**untrusted relay** (Cloudflare Worker + Durable Object). Status: **Phase 0**
— crypto primitives + handshake + identity key persistence verified by
unit tests and a two-process E2E demo. Transport (WSS), envelope (replay
buffer / sequence numbers), and PWA wiring are tracked separately.

## Why this exists

viveworker today pairs a phone PWA and a Mac bridge over the local LAN
(`https://<lan-ip>:8810` with mkcert). For users away from the LAN we
want the same UX without:

- shipping a phone-side app (PWA constraint),
- terminating TLS at a third party (no Cloudflare Tunnel),
- exposing a public HTTPS endpoint to the internet at large.

The chosen architecture is a Cloudflare Worker + Durable Object that
brokers WSS connections between phone and PC. This module is the
**E2EE layer that runs on top of that relay**. The relay carries
ciphertext and routing metadata; it never sees decrypted application
data and never holds long-term keys.

## Protocol choice: `Noise_IK_25519_ChaChaPoly_SHA256`

Why IK specifically:

- The phone (initiator) knows the PC bridge's static public key from the
  pairing flow that happened over LAN. With that prior knowledge IK
  gives **mutual authentication in 1 round-trip** (msg 1: phone → PC,
  msg 2: PC → phone, then transport).
- Both sides' static keys are bound into the handshake hash, so a MitM
  who tampers with either side fails to produce a valid AEAD tag.
- The chosen DH (`X25519`), AEAD (`ChaCha20-Poly1305`), and hash (`SHA256`)
  all map cleanly to Web Crypto / libsodium.js / `@noble/*` so the same
  protocol is implementable in the PWA without a polyfill audit.

What we **explicitly didn't pick**:

- **Static-static ECDH with a long-term symmetric key**: would lose
  forward secrecy. A relay snapshot + future identity-key compromise
  would decrypt all past sessions.
- **Signal Double Ratchet**: per-message rotation, but for a request/
  response control plane the cost (more state, more code, more
  failure modes on resume) doesn't earn its keep.
- **Noise XX**: would work too, but adds a round trip for static-key
  exchange that IK avoids.

## Layered key model

Three keys, kept strictly separated. Mixing them is a confused-deputy
hazard (e.g., a wallet-signed device-pairing message becoming a wallet
authorization).

| Layer    | Algo                | Lifetime                 | Where             | Used for                                  |
| -------- | ------------------- | ------------------------ | ----------------- | ----------------------------------------- |
| Wallet   | `secp256k1`         | Long-term                | hazBase / wallet  | EVM signing, USDC x402 payments           |
| Identity | `X25519`            | Long-term, per device    | This module       | Noise IK static `s`, device-pair auth     |
| Session  | `X25519` ephemeral  | Per WS connection        | Derived in Noise  | AEAD `k`/`n`, **per-session forward sec** |

The session key never touches disk. Each new WSS connection runs a fresh
IK handshake → fresh ephemeral DH → fresh `CipherState`. A relay
compromise plus future identity-key leak still cannot decrypt past
recordings.

## Files

- `noise.mjs` — Noise IK state machine. `HandshakeState`, `CipherState`,
  `SymmetricState`, `NoiseSession`. Pure Uint8Array I/O so the same
  module runs in Node and browser bundlers (no `Buffer` leakage).
- `keys.mjs` — Identity key generation, hex encoding, persistence to
  `~/.viveworker/remote-pairing.env` (file mode `0o600`, dir `0o700`).
  Includes `fingerprintIdentity()` for human-readable verification
  strings (`XXXX-XXXX-XXXX`, Crockford-ish alphabet).

## Wire layout (Phase 0)

This module produces and consumes **Noise transport messages only**.
Envelope-level fields (sequence numbers, message IDs, replay buffer
indexing) are deliberately not part of this layer — they're added by
the Phase 1 envelope module so the relay can route without seeing
ciphertext. End-state target:

```
WSS frame body (binary)
└── outer envelope                    ← visible to relay; routing-only
    ├── seq: u32                      ← replay buffer ordering
    ├── mid: 16 bytes (UUID)          ← deduplication
    ├── type: data | ack | ping | resume
    └── payload: bytes                ← Noise transport message (this module)
        └── ciphertext + 16-byte Poly1305 tag
```

Message sizes today:

- **Handshake msg 1** (initiator → responder, `e, es, s, ss + payload`):
  `32 + 32 + 16 + payload_len + 16` bytes (e pub, encrypted s pub, AEAD tag,
  encrypted payload, AEAD tag).
- **Handshake msg 2** (responder → initiator, `e, ee, se + payload`):
  `32 + payload_len + 16` bytes.
- **Transport message**: `payload_len + 16` bytes.

## Channel binding

After handshake both sides agree on a 32-byte hash of the handshake
transcript. `NoiseSession.getChannelBinding()` returns it. Higher
layers can pin sensitive operations to this binding — e.g., a
**WebAuthn challenge that the PWA derives from the channel binding**,
so a passkey assertion is bound to the specific Noise session, not
just to "any browser session at this origin."

This is how we'll wire Phase 5's "passkey-confirm before USDC payment"
flow without inventing a separate challenge nonce.

## Testing

```bash
# Unit tests — protocol semantics (15 tests)
node --test scripts/test/remote-pairing-noise.test.mjs

# End-to-end demo — two real processes over stdio pipes (Phase 0 DoD)
node scripts/test/remote-pairing-demo.mjs
```

The demo prints a transcript of both sides' wire frames in hex; eyeball
that no plaintext (e.g. `"approve task #42"`) appears anywhere outside
the decrypted payloads.

## Phase 0 → Phase 1 hand-off

What this module guarantees today:

- ✅ Handshake completes with 1 round-trip given a pre-shared responder static key.
- ✅ Mutual authentication (wrong responder static key fails handshake).
- ✅ Forward secrecy per session (ephemeral DH keys, dropped on session end).
- ✅ AEAD-bound associated data (envelope tampering breaks decryption).
- ✅ Channel binding for higher-layer auth pinning.
- ✅ Identity keys persist to disk with strict perms; round-trip verified.

What Phase 1 still needs to add (not this module's job):

- 🔜 **Envelope** with `seq` / `mid` / `type` for routing + dedup.
- 🔜 **Replay buffer** in the Durable Object (5-min TTL by default).
- 🔜 **Reconnect resume** via `RESUME { lastSeq }` → DO drains buffer.
- 🔜 **At-least-once delivery** with explicit `ACK { mid }` frames.
- 🔜 **Hibernatable WS** in the Durable Object (cost-critical from day 1).
- 🔜 **Ping/pong** every 30–45 s to defeat CF's ~100 s WS idle timeout.

What Phase 2 still needs to add (PWA side):

- 🔜 PWA bundle of `noise.mjs` (already Uint8Array-clean, should JustWork).
- 🔜 Identity key persistence in browser (IndexedDB; non-extractable
  CryptoKey if the platform supports it, else raw bytes with a passkey
  unlock).
- 🔜 `visibilitychange` → reconnect-with-resume flow.
- 🔜 Web Push wake → re-establish WS pipe.

## References

- Noise spec rev 34: <https://noiseprotocol.org/noise.html>
- IK pattern security: § 7.4 "Pattern security properties"
- HKDF: RFC 5869, used as `MixKey` per Noise § 4.3
- ChaCha20-Poly1305 nonce format: 4 zero bytes + 8-byte LE counter (Noise § 5.1)
