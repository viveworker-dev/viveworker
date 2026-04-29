# `worker-pairing/` — viveworker remote-pairing relay

Cloudflare Worker + Hibernatable Durable Object that brokers WSS
connections between a phone PWA and a PC bridge. The Worker terminates
only the outer WebSocket frame; payloads inside the envelope are
end-to-end encrypted by `scripts/lib/remote-pairing/noise.mjs` and the
relay never sees plaintext.

Status: **Remote relay beta**. Routing, replay buffer, resume, relay
capability tokens, and PWA/bridge wiring are in place; abuse hardening
continues as the public relay sees real traffic.

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
| `GET /v1/pairing/:pairingId/ws?role=phone\|bridge&token=...` | WS upgrade → DO |
| `GET /stats/remote` | private operator relay counters for `viveworker stats` (`Authorization: Bearer <STATS_ADMIN_TOKEN>`) |
| `GET /stats/remote/public` | coarse, delayed public adoption counters |
| `GET /healthz` | health probe |
| `GET /` | human-readable banner |

`pairingId` is `[A-Za-z0-9_-]{8,64}`. The `token` is a per-pairing relay
capability generated during LAN enrollment. The Worker verifies a small
proof-of-work on the token before allocating a DO and derives the DO name
from `pairingId + token`, so a leaked pairingId alone cannot reach the
real rendezvous room.

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
- `analytics-do.js` — aggregate server-side counters for connection health and adoption.

The DO imports the canonical envelope module via relative path
(`../scripts/lib/remote-pairing/envelope.mjs`) so PC bridge, PWA, and
Worker are all guaranteed to see the same wire format. Wrangler/esbuild
bundles the import at deploy time.

## Analytics

`/stats/remote` exposes private aggregate server-side counters used by
operators via `viveworker stats`: WS upgrades, phone/bridge connection
counts, relay success, reconnects, invalid-token attempts, rate-limit hits,
resume outcomes, and close codes. The route requires
`Authorization: Bearer <STATS_ADMIN_TOKEN>` and returns `404` when the token
is missing or invalid.

`/stats/remote/public` exposes only coarse, delayed adoption counters. It
does not publish invalid-token counters, rate-limit counters, close codes,
protocol errors, or low-volume daily rows.

The analytics DO stores only daily counters plus a non-reversible hash of
the random `pairingId` for unique-pairing estimates. It never stores
prompt/reply text, file contents, file paths, command text, relay tokens,
public keys, request bodies, or IP addresses.

## Testing

```bash
# Unit tests — routing state machine against mocked CF runtime (15 tests)
node --test scripts/test/remote-pairing-do.test.mjs

# Remote relay aggregate counters
node --test scripts/test/remote-pairing-analytics-do.test.mjs

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

# Connect a phone client (in another shell, using a generated relay token):
#   ws://localhost:8787/v1/pairing/test-001/ws?role=phone&token=<relay-token>
# Connect a bridge client similarly with role=bridge.
```

The legacy Phase 0 demo (`scripts/test/remote-pairing-demo.mjs`) still uses
stdio pipes for transport. The Worker-backed smoke demos live in
`scripts/test/remote-pairing-relay-demo.mjs` and
`scripts/test/remote-pairing-transport-demo.mjs`.

## Phase 1 → Phase 2 hand-off

What this Worker guarantees today:

- ✅ Two-peer rendezvous by `pairingId + relayToken` (DO `idFromName`).
- ✅ Per-pairing relay capability token with edge proof-of-work check.
- ✅ Cloudflare-managed throttling for invalid tokens and valid WS upgrades.
- ✅ DATA frame routing without payload inspection.
- ✅ Replay buffer with ACK-driven GC and TTL safety net.
- ✅ RESUME flow (OK + replay / FAIL on gap or hibernation).
- ✅ PING/PONG keepalive support (relay-local).
- ✅ Same-role reconnects perform controlled `4003 replaced` handoff for iOS/PWA recovery.
- ✅ Hibernatable DO — no $$ for idle pairings.

What still needs to land before the PWA can use this for real:

- 🔜 **Real-runtime smoke test stability** against `wrangler dev` in CI.
- 🔜 **Hibernation timing measurement** — confirm CF actually unloads
  the DO under expected idle patterns; tune ping interval if not.

## References

- [Hibernatable WebSockets API](https://developers.cloudflare.com/durable-objects/api/websockets/) — `state.acceptWebSocket`, lifecycle handlers, attachment serialization.
- [SQLite-backed Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/) — modern DO storage backing (we don't write to it in Phase 1, but the migration is future-proofed).
- [WebSockets idle timeout](https://developers.cloudflare.com/workers/platform/limits/#duration-limits) — ~100s default, hence the PING/PONG schedule from the PC bridge / PWA side.
