# `worker-pairing/` — viveworker remote-pairing relay

Cloudflare Worker + Hibernatable Durable Object that brokers WSS
connections between a phone PWA and a PC bridge. The Worker terminates
only the outer WebSocket frame; payloads inside the envelope are
end-to-end encrypted by `scripts/lib/remote-pairing/noise.mjs` and the
relay never sees plaintext.

Status: **Phase 1 — relay scaffold**. Routing, replay buffer, and resume
flow verified by unit tests against a mocked CF runtime. Real-runtime
integration (wrangler dev / a deployed Worker) and PWA wiring are next.

## Why a separate Worker

Existing workers (`worker/` for A2A relay, `share-worker/` for files)
are stateless / KV-backed. Remote pairing needs:

- A long-lived rendezvous that two peers can find by `pairingId` (deterministic
  via `idFromName`),
- In-memory state per pairing for the replay buffer / seq counters,
- WebSocket support with hibernation (cost-critical: most pairings idle
  most of the time).

That's a Durable Object, and to keep blast radius small we put the DO
in its own Worker rather than retrofit it into one of the existing
single-file workers.

## Wire model (matches `scripts/lib/remote-pairing/envelope.mjs`)

```
WSS frame body
└── envelope                    ← visible to relay (this Worker)
    ├── type     1 byte         ← DATA / ACK / PING / PONG / RESUME_*
    ├── seq      4 bytes BE u32 ← per-direction monotonic counter
    ├── mid      16 bytes UUID  ← dedup key (DATA frames only)
    └── payload  N bytes        ← Noise transport message (opaque)
```

The DO routes by `type`, buffers DATA frames for short-window replay,
GCs on ACK, answers PING with PONG, and handles RESUME_REQ. It never
inspects `payload`.

## Routes

| Route | Purpose |
|-------|---------|
| `GET /v1/pairing/:pairingId/ws?role=phone\|bridge` | WS upgrade → DO |
| `GET /healthz` | health probe |
| `GET /` | human-readable banner |

`pairingId` is `[A-Za-z0-9_-]{8,64}`. Any client-generated unguessable
identifier works; we'll standardise on a 22-char base64url UUID once the
Phase 0 LAN-bootstrap pairing flow is hooked up.

## Frame routing summary

```
Sender → DO                  DO action
─────────────────────────    ─────────────────────────────────────────
DATA(seq, mid, payload)      buffer in sender's outbox; forward to peer
ACK(seq)                     drop counterparty's outbox where seq ≤ N
PING                         send PONG back to sender
PONG                         drop (was just keepalive)
RESUME_REQ(lastSeenSeq)      replay counterparty's outbox > lastSeenSeq
                             OR: RESUME_FAIL(BUFFER_EXPIRED|HIBERNATED)
RESUME_OK / RESUME_FAIL      reject — these are server-emitted only
```

Buffer policy:

- 5-minute TTL per outbox entry
- 1024-frame hard cap per direction
- ACKs are the primary GC trigger; the TTL is a safety net for stuck peers

## Hibernation

The DO uses `state.acceptWebSocket()` so CF unloads the JS instance
between messages. Sockets stay attached and tags persist; the in-memory
replay buffer does **not**. On a cold wake, every reconnecting peer that
sends `RESUME_REQ(lastSeenSeq > 0)` gets `RESUME_FAIL(HIBERNATED)` and
redoes the Noise handshake.

This is intentional. Persisting every frame to DO storage would burn
writes on what is already a forward-secret transport — the cheaper move
is to make re-handshake correct + fast and accept that long idle gaps
mean a fresh session.

## Files

- `wrangler.toml` — Worker name, DO binding, SQLite DO migration.
- `worker.js` — entry: route validation + `idFromName` → DO stub forward.
- `pairing-do.js` — `PairingChannel` class with the full routing/buffer logic.

The DO imports the canonical envelope module via relative path
(`../scripts/lib/remote-pairing/envelope.mjs`) so PC bridge, PWA, and
Worker are all guaranteed to see the same wire format. Wrangler/esbuild
bundles the import at deploy time.

## Testing

```bash
# Unit tests — routing state machine against mocked CF runtime (15 tests)
node --test scripts/test/remote-pairing-do.test.mjs

# Envelope wire format (18 tests, shared with bridge + PWA)
node --test scripts/test/remote-pairing-envelope.test.mjs

# Noise IK protocol (15 tests, transport-agnostic)
node --test scripts/test/remote-pairing-noise.test.mjs
```

## Deployment (one-time)

```bash
cd worker-pairing

# 1. Apply the DO migration + deploy. The migration block in wrangler.toml
#    declares PairingChannel; first deploy creates the SQLite-backed class.
wrangler deploy

# 2. (Optional) Bind a custom domain when ready — uncomment the routes
#    block in wrangler.toml after creating the DNS record.
```

## Local iteration

```bash
# Start a local Worker + DO instance with WS support.
wrangler dev --local

# Connect a phone client (in another shell):
#   ws://localhost:8787/v1/pairing/test-001/ws?role=phone
# Connect a bridge client similarly with role=bridge.
```

The Phase 0 demo (`scripts/test/remote-pairing-demo.mjs`) currently uses
stdio pipes for transport. The Phase 1 hand-off step is to add a
WS-transport variant of the demo that connects through `wrangler dev`,
proving the same Noise session survives a real CF Worker hop.

## Phase 1 → Phase 2 hand-off

What this Worker guarantees today:

- ✅ Two-peer rendezvous by `pairingId` (DO `idFromName`).
- ✅ DATA frame routing without payload inspection.
- ✅ Replay buffer with ACK-driven GC and TTL safety net.
- ✅ RESUME flow (OK + replay / FAIL on gap or hibernation).
- ✅ PING/PONG keepalive support (relay-local).
- ✅ Connection replacement on reconnect (old socket gets WS code 4003).
- ✅ Hibernatable DO — no $$ for idle pairings.

What still needs to land before the PWA can use this for real:

- 🔜 **WS-transport adapter** in the PC bridge (replaces stdio pipes).
- 🔜 **Browser WS client** in the PWA bundle.
- 🔜 **Per-pairing bearer token** (Phase 1 leaves the WS open; Noise
  layer is the real auth, but a dumb-bot rate-limit at the relay edge is
  cheap and worth adding before public deploy).
- 🔜 **Real-runtime smoke test** against `wrangler dev` (driving two
  Noise peers through the live Worker).
- 🔜 **Hibernation timing measurement** — confirm CF actually unloads
  the DO under expected idle patterns; tune ping interval if not.

## References

- [Hibernatable WebSockets API](https://developers.cloudflare.com/durable-objects/api/websockets/) — `state.acceptWebSocket`, lifecycle handlers, attachment serialization.
- [SQLite-backed Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/) — modern DO storage backing (we don't write to it in Phase 1, but the migration is future-proofed).
- [WebSockets idle timeout](https://developers.cloudflare.com/workers/platform/limits/#duration-limits) — ~100s default, hence the PING/PONG schedule from the PC bridge / PWA side.
