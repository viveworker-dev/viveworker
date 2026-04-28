/**
 * remote-pairing-do.test.mjs — Unit tests for PairingChannel routing.
 *
 * The DO depends on Cloudflare runtime APIs (DurableObjectState, WebSocketPair,
 * the hibernatable acceptWebSocket method, etc.). Rather than spin up
 * `wrangler dev` for every assertion, we mock the surface area with two
 * tiny fakes — FakeState + FakeWS — and drive `webSocketMessage` directly.
 * That covers the routing state machine which is what we actually want to
 * lock down here. End-to-end against the real runtime is a separate
 * integration test (Phase 1 hand-off).
 *
 * Run:
 *   node --test scripts/test/remote-pairing-do.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PairingChannel } from "../../worker-pairing/pairing-do.js";
import {
  FRAME_RESUME_OK,
  FRAME_RESUME_FAIL,
  FRAME_PONG,
  RESUME_FAIL_BUFFER_EXPIRED,
  RESUME_FAIL_HIBERNATED,
  encodeData,
  encodeAck,
  encodePing,
  encodeResumeReq,
  encodeResumeOk,
  decode,
  generateMid,
} from "../lib/remote-pairing/envelope.mjs";

// ---------------------------------------------------------------------------
// Minimal CF runtime fakes
// ---------------------------------------------------------------------------

class FakeWS {
  constructor() {
    this.sent = [];        // Array<Uint8Array>
    this.closed = null;    // { code, reason } | null
    this.attachment = null;
    this.readyState = 1;   // OPEN
  }
  send(data) {
    if (this.closed) throw new Error("send on closed socket");
    this.sent.push(toU8(data));
  }
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3; // CLOSED
  }
  serializeAttachment(v) { this.attachment = v; }
  deserializeAttachment() { return this.attachment; }
}

class FakeState {
  constructor() {
    /** @type {Array<{ws: FakeWS, tags: string[]}>} */
    this.accepted = [];
  }
  acceptWebSocket(ws, tags = []) {
    // Mirror the real API: idempotent attach + tag binding.
    this.accepted.push({ ws, tags });
  }
  getWebSockets(tag) {
    if (tag == null) return this.accepted.map((a) => a.ws);
    return this.accepted.filter((a) => a.tags.includes(tag)).map((a) => a.ws);
  }
}

function toU8(d) {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return new Uint8Array(d);
}

const enc = (s) => new TextEncoder().encode(s);

/**
 * Build a Uint8Array of exactly the given byte length, filled with bytes that
 * match a recognisable pattern (hex `0xAA`). Used to fake a Noise IK msg1 in
 * tests — pairing-do.js only checks the wire size, never the contents.
 */
const fakeBytes = (n, fill = 0xaa) => new Uint8Array(n).fill(fill);

/**
 * Build a Uint8Array shaped like a Noise IK msg1 with empty payload:
 *   ephemeral pub (32) + encrypted static (32 + 16) + payload tag (16) = 96 B.
 * pairing-do.js's fresh-handshake gate accepts only this exact size from a
 * brand-new phone socket; junk-sized DATA frames must not evict the bridge.
 */
const fakeNoiseIkMsg1 = () => fakeBytes(96, 0xab);

/**
 * Hook a fake WS into a freshly-built PairingChannel as `role`. Mirrors what
 * `fetch()` does when a peer connects, minus the WebSocketPair/upgrade dance.
 */
function connect(channel, role, ws) {
  const existing = channel.peers.get(role);
  if (existing?.socket?.readyState === 1) {
    existing.socket.close(4003, "replaced");
  }
  channel.state.acceptWebSocket(ws, [role]);
  ws.serializeAttachment({ role });
  const existingOutbox = existing?.outbox ?? [];
  const existingLastSent = existing?.lastSent ?? 0;
  const existingColdWake = existing?.coldWake === true;
  channel.peers.set(role, {
    socket: ws,
    outbox: existingOutbox,
    lastSent: existingLastSent,
    coldWake: existingColdWake,
    awaitingFirstFrame: true,
  });
  // Replay on attach is no longer triggered by the DO at upgrade time.
  // Tests that need to drive replay should send an explicit RESUME_REQ
  // after `connect(...)` to mirror what the real transport does.
  return true;
}

/**
 * Convenience: do `connect()` plus an immediate RESUME_REQ(0). Mirrors what
 * a real transport does in `_handleOpen` — without this, the DO's
 * "don't direct-forward to a peer that hasn't sent its first frame yet"
 * gate keeps frames buffered and tests that exercise post-attach DATA
 * forwarding never see anything delivered.
 *
 * Use the bare `connect(...)` for tests that explicitly want to assert
 * pre-RESUME_REQ behaviour.
 */
async function connectAndAnnounce(channel, role, ws, lastSeenSeq = 0) {
  if (!connect(channel, role, ws)) return false;
  await channel.webSocketMessage(ws, encodeResumeReq(lastSeenSeq).buffer);
  return true;
}

/**
 * Hook a fake WS in as if we'd just woken from hibernation: socket present,
 * outbox empty, coldWake=true.
 */
function reattachAfterHibernation(channel, role, ws) {
  channel.state.acceptWebSocket(ws, [role]);
  ws.serializeAttachment({ role });
  channel.peers.set(role, {
    socket: ws,
    outbox: [],
    lastSent: 0,
    coldWake: true,
    awaitingFirstFrame: true,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("DATA from phone is forwarded to bridge and buffered in phone's outbox", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  const bridge = new FakeWS();
  await connectAndAnnounce(channel, "phone", phone);
  await connectAndAnnounce(channel, "bridge", bridge);
  // Drop the RESUME_OK responses from the announce step so the assertions
  // below can focus on the actual DATA roundtrip.
  bridge.sent.length = 0;
  phone.sent.length = 0;

  const mid = generateMid();
  const wire = encodeData({ seq: 1, mid, payload: enc("hello") });

  await channel.webSocketMessage(phone, wire.buffer);

  // Bridge received the frame as-is.
  assert.equal(bridge.sent.length, 1);
  assert.deepEqual(bridge.sent[0], wire);

  // Phone's outbox has it.
  const out = channel.peers.get("phone").outbox;
  assert.equal(out.length, 1);
  assert.equal(out[0].seq, 1);
  assert.deepEqual(out[0].mid, mid);
});

test("DATA does not loop back to sender", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  const bridge = new FakeWS();
  connect(channel, "phone", phone);
  connect(channel, "bridge", bridge);

  const wire = encodeData({ seq: 1, mid: generateMid(), payload: enc("ping") });
  await channel.webSocketMessage(phone, wire.buffer);

  assert.equal(phone.sent.length, 0);
});

test("DATA buffered when peer is offline; nothing forwarded", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  connect(channel, "phone", phone);
  // No bridge connected.

  const wire = encodeData({ seq: 1, mid: generateMid(), payload: enc("hi") });
  await channel.webSocketMessage(phone, wire.buffer);

  assert.equal(channel.peers.get("phone").outbox.length, 1);
  assert.equal(channel.peers.has("bridge"), false);
});

test("DATA buffered while peer is offline replays after the peer's RESUME_REQ", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  connect(channel, "phone", phone);

  const wire = encodeData({ seq: 1, mid: generateMid(), payload: enc("msg1") });
  await channel.webSocketMessage(phone, wire.buffer);

  const bridge = new FakeWS();
  connect(channel, "bridge", bridge);

  // No replay-on-attach any more — the DO waits for the peer's RESUME_REQ.
  assert.equal(bridge.sent.length, 0);

  await channel.webSocketMessage(bridge, encodeResumeReq(0).buffer);

  // RESUME_OK + replayed phone frame.
  assert.equal(bridge.sent.length, 2);
  const ok = decode(bridge.sent[0]);
  assert.equal(ok.type, FRAME_RESUME_OK);
  assert.deepEqual(bridge.sent[1], wire);
});

test("stale DATA from a disconnected peer is not drained into a later peer", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  connect(channel, "phone", phone);

  const wire = encodeData({ seq: 1, mid: generateMid(), payload: enc("stale-msg1") });
  await channel.webSocketMessage(phone, wire.buffer);
  await channel.webSocketClose(phone, 1006, "abnormal", false);

  const bridge = new FakeWS();
  connect(channel, "bridge", bridge);

  assert.equal(bridge.sent.length, 0);
});

test("active same-role duplicate performs a controlled replace", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const firstPhone = new FakeWS();
  connect(channel, "phone", firstPhone);

  const secondPhone = new FakeWS();
  const accepted = connect(channel, "phone", secondPhone);

  assert.equal(accepted, true);
  assert.deepEqual(firstPhone.closed, { code: 4003, reason: "replaced" });
  assert.equal(secondPhone.closed, null);
  assert.equal(channel.peers.get("phone").socket, secondPhone);
});

test("late DATA from a replaced same-role socket is ignored", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const firstPhone = new FakeWS();
  const bridge = new FakeWS();
  connect(channel, "phone", firstPhone);
  await connectAndAnnounce(channel, "bridge", bridge);
  bridge.sent.length = 0;

  const secondPhone = new FakeWS();
  connect(channel, "phone", secondPhone);

  const stale = encodeData({ seq: 9, mid: generateMid(), payload: enc("stale") });
  await channel.webSocketMessage(firstPhone, stale.buffer);

  assert.equal(bridge.sent.length, 0);
  assert.equal(channel.peers.get("phone").socket, secondPhone);
  assert.equal(channel.peers.get("phone").outbox.length, 0);
});

test("fresh DATA on same-role reconnect discards stale handshake outbox", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const firstPhone = new FakeWS();
  connect(channel, "phone", firstPhone);

  // Use a real-shaped Noise IK msg1 — the DO's fresh-handshake gate only
  // fires on payloads that match the Noise IK msg1 size.
  const stale = encodeData({ seq: 1, mid: generateMid(), payload: fakeNoiseIkMsg1() });
  await channel.webSocketMessage(firstPhone, stale.buffer);
  assert.equal(channel.peers.get("phone").outbox.length, 1);
  await channel.webSocketClose(firstPhone, 1006, "abnormal", false);

  const secondPhone = new FakeWS();
  connect(channel, "phone", secondPhone);
  assert.equal(channel.peers.get("phone").socket, secondPhone);

  const fresh = encodeData({ seq: 1, mid: generateMid(), payload: fakeNoiseIkMsg1() });
  await channel.webSocketMessage(secondPhone, fresh.buffer);

  const out = channel.peers.get("phone").outbox;
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].wire, fresh);
});

test("passive same-role reconnect does not drain stale outbox before resume or fresh DATA", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const firstBridge = new FakeWS();
  connect(channel, "bridge", firstBridge);

  const stale = encodeData({ seq: 1, mid: generateMid(), payload: enc("old-msg2") });
  await channel.webSocketMessage(firstBridge, stale.buffer);
  await channel.webSocketClose(firstBridge, 1006, "abnormal", false);

  const secondBridge = new FakeWS();
  connect(channel, "bridge", secondBridge);
  await channel.webSocketMessage(secondBridge, encodePing());

  const phone = new FakeWS();
  connect(channel, "phone", phone);

  assert.equal(phone.sent.length, 0);
});

test("fresh phone handshake does not flow into a connected stale bridge session", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const oldBridge = new FakeWS();
  connect(channel, "bridge", oldBridge);

  // Make the bridge look like it has an existing Noise session/outbox.
  const oldBridgeFrame = encodeData({ seq: 10, mid: generateMid(), payload: enc("old-response") });
  await channel.webSocketMessage(oldBridge, oldBridgeFrame.buffer);
  assert.equal(channel.peers.get("bridge").awaitingFirstFrame, false);

  const phone = new FakeWS();
  connect(channel, "phone", phone);
  // Use a real-shaped Noise IK msg1 — the DO only kicks the counterparty
  // when the phone's first DATA frame looks like a plausible msg1.
  const freshMsg1 = encodeData({ seq: 1, mid: generateMid(), payload: fakeNoiseIkMsg1() });
  await channel.webSocketMessage(phone, freshMsg1.buffer);

  assert.deepEqual(oldBridge.closed, { code: 4004, reason: "fresh-handshake" });
  assert.equal(oldBridge.sent.length, 0, "fresh msg1 must not be forwarded into stale bridge session");
  assert.equal(channel.peers.get("bridge").socket, null);
  assert.equal(channel.peers.get("bridge").coldWake, true);
  assert.equal(channel.peers.get("phone").outbox.length, 1);
  assert.deepEqual(channel.peers.get("phone").outbox[0].wire, freshMsg1);
});

test("malformed first DATA from phone does not evict the active bridge", async () => {
  // An attacker who has acquired the relay token + pairingId but holds no
  // valid Noise key can still open a phone socket. They MUST NOT be able to
  // close the bridge socket by sending arbitrary garbage — only a payload
  // that's structurally plausible as a Noise IK msg1 may flag the
  // counterparty for fresh handshake.
  const channel = new PairingChannel(new FakeState(), {});
  const oldBridge = new FakeWS();
  connect(channel, "bridge", oldBridge);
  const oldBridgeFrame = encodeData({ seq: 10, mid: generateMid(), payload: enc("old-response") });
  await channel.webSocketMessage(oldBridge, oldBridgeFrame.buffer);

  const phone = new FakeWS();
  connect(channel, "phone", phone);
  // 12 bytes — not a valid Noise IK msg1 size. The DO should forward this
  // as ordinary DATA and leave the bridge socket alone.
  const junk = encodeData({ seq: 1, mid: generateMid(), payload: fakeBytes(12) });
  await channel.webSocketMessage(phone, junk.buffer);

  assert.equal(oldBridge.closed, null, "bridge must not be closed by malformed phone DATA");
  assert.equal(channel.peers.get("bridge").socket, oldBridge);
  // The frame is forwarded to the bridge anyway — the bridge's own Noise
  // transport will detect the AEAD mismatch and tear itself down. The DO
  // doesn't help the attacker accelerate that teardown.
  assert.equal(oldBridge.sent.length, 1);
});

test("first DATA with non-1 seq from phone does not evict the active bridge", async () => {
  // A Noise IK msg1 always rides on envelope seq=1 (first frame of a fresh
  // socket). If the phone's first frame has any other seq, treat it as a
  // misbehaving / malicious peer rather than a fresh handshake.
  const channel = new PairingChannel(new FakeState(), {});
  const oldBridge = new FakeWS();
  connect(channel, "bridge", oldBridge);
  const oldBridgeFrame = encodeData({ seq: 10, mid: generateMid(), payload: enc("old-response") });
  await channel.webSocketMessage(oldBridge, oldBridgeFrame.buffer);

  const phone = new FakeWS();
  connect(channel, "phone", phone);
  const wrongSeq = encodeData({ seq: 2, mid: generateMid(), payload: fakeNoiseIkMsg1() });
  await channel.webSocketMessage(phone, wrongSeq.buffer);

  assert.equal(oldBridge.closed, null);
  assert.equal(channel.peers.get("bridge").socket, oldBridge);
});

test("stale bridge reconnect gets RESUME_FAIL before buffered fresh phone msg1", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const oldBridge = new FakeWS();
  connect(channel, "bridge", oldBridge);

  const oldBridgeFrame = encodeData({ seq: 10, mid: generateMid(), payload: enc("old-response") });
  await channel.webSocketMessage(oldBridge, oldBridgeFrame.buffer);

  const phone = new FakeWS();
  connect(channel, "phone", phone);
  const freshMsg1 = encodeData({ seq: 1, mid: generateMid(), payload: fakeNoiseIkMsg1() });
  await channel.webSocketMessage(phone, freshMsg1.buffer);

  const newBridge = new FakeWS();
  connect(channel, "bridge", newBridge);
  assert.equal(newBridge.sent.length, 0, "fresh msg1 waits until bridge observes RESUME_FAIL");

  await channel.webSocketMessage(newBridge, encodeResumeReq(999).buffer);

  assert.equal(newBridge.sent.length, 2);
  const fail = decode(newBridge.sent[0]);
  assert.equal(fail.type, FRAME_RESUME_FAIL);
  assert.equal(fail.reason, RESUME_FAIL_HIBERNATED);
  const replayedMsg1 = decode(newBridge.sent[1]);
  assert.equal(replayedMsg1.seq, 1);
  assert.deepEqual(newBridge.sent[1], freshMsg1);
});

test("bridge restart while phone has stale session: bridge RESUME_FAIL forces phone reset", async () => {
  // Real-world bridge restart sequence: both peers have been actively
  // exchanging transport frames. The bridge process is restarted, which
  // wipes the in-memory Noise transport session on the bridge side. The
  // phone keeps its existing session (its WS to the relay is preserved by
  // the hibernation API) and continues sending transport DATA encrypted
  // with the old keys. If the DO replays those buffered frames into the
  // freshly-connected bridge — which is sitting in handshake mode — they
  // AEAD-fail in a tight loop until the phone's WS happens to time out.
  //
  // The fix: when the new bridge announces itself with RESUME_REQ(0), the
  // DO sees the asymmetry (lastSeenSeq=0 despite previously-active
  // bridge.lastSent>0) and treats it as state loss. RESUME_FAIL goes to
  // the bridge, the phone's WS is booted so its transport drops the stale
  // session and reconnects with a real msg1, and both sides end up doing
  // a clean fresh handshake.
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  const bridge = new FakeWS();
  await connectAndAnnounce(channel, "phone", phone);
  await connectAndAnnounce(channel, "bridge", bridge);

  // Both peers exchange a few transport frames so the DO records non-zero
  // lastSent on each slot — this is what the state-loss heuristic keys on.
  for (let seq = 1; seq <= 3; seq++) {
    await channel.webSocketMessage(phone, encodeData({
      seq,
      mid: generateMid(),
      payload: enc(`phone-data-${seq}`),
    }).buffer);
  }
  for (let seq = 1; seq <= 2; seq++) {
    await channel.webSocketMessage(bridge, encodeData({
      seq,
      mid: generateMid(),
      payload: enc(`bridge-data-${seq}`),
    }).buffer);
  }
  assert.equal(channel.peers.get("phone").outbox.length, 3);
  assert.equal(channel.peers.get("bridge").lastSent, 2);

  // Simulate bridge process restart: old bridge socket dies, then a fresh
  // socket attaches with no session and sends RESUME_REQ(0).
  await channel.webSocketClose(bridge, 1006, "abnormal", false);
  const newBridge = new FakeWS();
  connect(channel, "bridge", newBridge);
  // Before the new bridge announces itself, nothing has been replayed.
  assert.equal(newBridge.sent.length, 0);

  await channel.webSocketMessage(newBridge, encodeResumeReq(0).buffer);

  // Bridge gets RESUME_FAIL — the DO refuses to silently RESUME_OK + replay
  // ciphertext into a session-less responder.
  assert.equal(newBridge.sent.length, 1);
  assert.equal(decode(newBridge.sent[0]).type, FRAME_RESUME_FAIL);

  // Phone WS gets booted so its transport will reconnect with a fresh
  // handshake instead of continuing to ship stale-keys DATA into the
  // responder's handshake state.
  assert.deepEqual(phone.closed, { code: 4004, reason: "counterparty-reset" });
  assert.equal(channel.peers.get("phone").socket, null);
  assert.equal(channel.peers.get("phone").coldWake, true);
  assert.equal(channel.peers.get("phone").awaitingFirstFrame, true);
  // Stale outbox is wiped — no risk of replaying old ciphertext into the
  // next handshake.
  assert.equal(channel.peers.get("phone").outbox.length, 0);
  assert.equal(channel.peers.get("phone").lastSent, 0);
});

test("bridge responder may send msg2 after RESUME_FAIL without being treated as missing msg1", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const oldPhone = new FakeWS();
  const oldBridge = new FakeWS();
  await connectAndAnnounce(channel, "phone", oldPhone);
  await connectAndAnnounce(channel, "bridge", oldBridge);

  // Make the bridge slot look previously active, then restart the bridge so
  // RESUME_REQ(0) takes the state-loss path.
  await channel.webSocketMessage(oldBridge, encodeData({
    seq: 1,
    mid: generateMid(),
    payload: enc("old-bridge-data"),
  }).buffer);
  await channel.webSocketClose(oldBridge, 1006, "abnormal", false);

  const newBridge = new FakeWS();
  connect(channel, "bridge", newBridge);
  await channel.webSocketMessage(newBridge, encodeResumeReq(0).buffer);

  assert.equal(decode(newBridge.sent[0]).type, FRAME_RESUME_FAIL);
  assert.deepEqual(oldPhone.closed, { code: 4004, reason: "counterparty-reset" });
  assert.equal(channel.peers.get("bridge").expectFreshHandshake, false);

  const newPhone = new FakeWS();
  connect(channel, "phone", newPhone);
  await channel.webSocketMessage(newPhone, encodeResumeReq(0).buffer);
  assert.equal(decode(newPhone.sent[0]).type, FRAME_RESUME_FAIL);

  const freshMsg1 = encodeData({ seq: 17, mid: generateMid(), payload: fakeNoiseIkMsg1() });
  await channel.webSocketMessage(newPhone, freshMsg1.buffer);
  assert.deepEqual(newBridge.sent[1], freshMsg1);

  const msg2 = encodeData({ seq: 1, mid: generateMid(), payload: fakeBytes(48) });
  await channel.webSocketMessage(newBridge, msg2.buffer);

  assert.equal(newBridge.closed, null);
  assert.equal(channel.peers.get("bridge").socket, newBridge);
  assert.deepEqual(newPhone.sent[1], msg2);
});

test("bridge's first DATA frame does not evict the active phone", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  const bridge = new FakeWS();
  connect(channel, "phone", phone);

  const msg1 = encodeData({ seq: 1, mid: generateMid(), payload: enc("msg1") });
  await channel.webSocketMessage(phone, msg1.buffer);

  connect(channel, "bridge", bridge);
  const msg2 = encodeData({ seq: 1, mid: generateMid(), payload: enc("msg2") });
  await channel.webSocketMessage(bridge, msg2.buffer);

  assert.equal(phone.closed, null);
  assert.equal(channel.peers.get("phone").socket, phone);
});

test("ACK from bridge GCs phone's outbox up to the acked seq", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  const bridge = new FakeWS();
  connect(channel, "phone", phone);
  connect(channel, "bridge", bridge);

  for (let seq = 1; seq <= 3; seq++) {
    const wire = encodeData({ seq, mid: generateMid(), payload: enc(`m${seq}`) });
    await channel.webSocketMessage(phone, wire.buffer);
  }
  assert.equal(channel.peers.get("phone").outbox.length, 3);

  // Bridge acks seq=2 → phone's outbox should drop entries with seq ≤ 2.
  await channel.webSocketMessage(bridge, encodeAck(2).buffer);
  const out = channel.peers.get("phone").outbox;
  assert.equal(out.length, 1);
  assert.equal(out[0].seq, 3);
});

test("PING is answered with a PONG to the same socket", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  connect(channel, "phone", phone);

  await channel.webSocketMessage(phone, encodePing().buffer);

  assert.equal(phone.sent.length, 1);
  assert.equal(decode(phone.sent[0]).type, FRAME_PONG);
});

test("RESUME_REQ(0) on a fresh channel returns RESUME_OK(0)", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  connect(channel, "phone", phone);

  await channel.webSocketMessage(phone, encodeResumeReq(0).buffer);

  assert.equal(phone.sent.length, 1);
  const got = decode(phone.sent[0]);
  assert.equal(got.type, FRAME_RESUME_OK);
  assert.equal(got.currentSeq, 0);
});

test("RESUME_REQ replays counterparty frames after lastSeenSeq", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  const bridge = new FakeWS();
  await connectAndAnnounce(channel, "phone", phone);
  await connectAndAnnounce(channel, "bridge", bridge);
  phone.sent.length = 0;
  bridge.sent.length = 0;

  // Bridge sends 3 frames; we want to test replay to phone.
  const frames = [];
  for (let seq = 1; seq <= 3; seq++) {
    const wire = encodeData({ seq, mid: generateMid(), payload: enc(`from-bridge-${seq}`) });
    frames.push(wire);
    await channel.webSocketMessage(bridge, wire.buffer);
  }
  // Phone has received 1+2+3 forwarded.
  assert.equal(phone.sent.length, 3);
  // Wipe phone.sent so we can tell what the resume responds.
  phone.sent.length = 0;

  // Phone reconnects with lastSeenSeq=1, asking us to resend 2 and 3.
  await channel.webSocketMessage(phone, encodeResumeReq(1).buffer);

  assert.equal(phone.sent.length, 3, "RESUME_OK + replay of seq=2,3");
  // First frame is RESUME_OK(currentSeq=3)
  const ok = decode(phone.sent[0]);
  assert.equal(ok.type, FRAME_RESUME_OK);
  assert.equal(ok.currentSeq, 3);
  // Then DATA seq=2, then DATA seq=3
  const replay2 = decode(phone.sent[1]);
  assert.equal(replay2.seq, 2);
  const replay3 = decode(phone.sent[2]);
  assert.equal(replay3.seq, 3);
});

test("RESUME_REQ for seq older than buffer returns RESUME_FAIL(BUFFER_EXPIRED)", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  const bridge = new FakeWS();
  connect(channel, "phone", phone);
  connect(channel, "bridge", bridge);

  // Bridge has only sent seqs 5 and 6 — entries 1-4 are not in the buffer.
  for (const seq of [5, 6]) {
    const wire = encodeData({ seq, mid: generateMid(), payload: enc(`m${seq}`) });
    await channel.webSocketMessage(bridge, wire.buffer);
  }
  phone.sent.length = 0;

  // Phone asks for everything after seq=1 — gap from 1 to 5, can't be filled.
  await channel.webSocketMessage(phone, encodeResumeReq(1).buffer);

  assert.equal(phone.sent.length, 1);
  const fail = decode(phone.sent[0]);
  assert.equal(fail.type, FRAME_RESUME_FAIL);
  assert.equal(fail.reason, RESUME_FAIL_BUFFER_EXPIRED);
});

test("RESUME_REQ where lastSeenSeq is already up-to-date returns OK with no replay", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  const bridge = new FakeWS();
  connect(channel, "phone", phone);
  connect(channel, "bridge", bridge);

  // Bridge has sent up to seq=3. Phone says it's seen 3.
  for (let seq = 1; seq <= 3; seq++) {
    const wire = encodeData({ seq, mid: generateMid(), payload: enc(`m${seq}`) });
    await channel.webSocketMessage(bridge, wire.buffer);
  }
  phone.sent.length = 0;

  await channel.webSocketMessage(phone, encodeResumeReq(3).buffer);

  // Just RESUME_OK, no replay frames.
  assert.equal(phone.sent.length, 1);
  const ok = decode(phone.sent[0]);
  assert.equal(ok.type, FRAME_RESUME_OK);
  assert.equal(ok.currentSeq, 3);
});

test("RESUME_REQ after cold wake returns RESUME_FAIL(HIBERNATED)", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  reattachAfterHibernation(channel, "phone", phone);

  await channel.webSocketMessage(phone, encodeResumeReq(7).buffer);

  assert.equal(phone.sent.length, 1);
  const got = decode(phone.sent[0]);
  assert.equal(got.type, FRAME_RESUME_FAIL);
  assert.equal(got.reason, RESUME_FAIL_HIBERNATED);
});

test("fresh phone msg1 after DO hibernation reaches the waiting bridge", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  const bridge = new FakeWS();
  reattachAfterHibernation(channel, "phone", phone);
  reattachAfterHibernation(channel, "bridge", bridge);

  const freshMsg1 = encodeData({ seq: 1, mid: generateMid(), payload: fakeNoiseIkMsg1() });
  await channel.webSocketMessage(phone, freshMsg1.buffer);

  assert.equal(bridge.closed, null);
  assert.equal(bridge.sent.length, 1);
  assert.deepEqual(bridge.sent[0], freshMsg1);
});

test("fresh phone msg1 after RESUME_FAIL may use monotonic seq", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  const bridge = new FakeWS();
  reattachAfterHibernation(channel, "phone", phone);
  reattachAfterHibernation(channel, "bridge", bridge);

  await channel.webSocketMessage(phone, encodeResumeReq(0).buffer);
  assert.equal(decode(phone.sent[0]).type, FRAME_RESUME_FAIL);

  const freshMsg1 = encodeData({ seq: 17, mid: generateMid(), payload: fakeNoiseIkMsg1() });
  await channel.webSocketMessage(phone, freshMsg1.buffer);

  assert.equal(bridge.closed, null);
  assert.equal(bridge.sent.length, 1);
  assert.deepEqual(bridge.sent[0], freshMsg1);
});

test("malformed phone DATA after DO hibernation stays buffered until bridge announces", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  const bridge = new FakeWS();
  reattachAfterHibernation(channel, "phone", phone);
  reattachAfterHibernation(channel, "bridge", bridge);

  const junk = encodeData({ seq: 1, mid: generateMid(), payload: fakeBytes(12) });
  await channel.webSocketMessage(phone, junk.buffer);

  assert.equal(bridge.closed, null);
  assert.equal(bridge.sent.length, 0);
  assert.equal(channel.peers.get("phone").outbox.length, 1);
});

test("Constructor re-attaches sockets from getWebSockets() and marks them coldWake", () => {
  // Pre-populate the state with two sockets that "survived hibernation".
  const state = new FakeState();
  const phone = new FakeWS();
  phone.serializeAttachment({ role: "phone" });
  state.accepted.push({ ws: phone, tags: ["phone"] });
  const bridge = new FakeWS();
  bridge.serializeAttachment({ role: "bridge" });
  state.accepted.push({ ws: bridge, tags: ["bridge"] });

  const channel = new PairingChannel(state, {});

  assert.equal(channel.peers.size, 2);
  assert.equal(channel.peers.get("phone").coldWake, true);
  assert.equal(channel.peers.get("bridge").coldWake, true);
  assert.equal(channel.peers.get("phone").outbox.length, 0);
});

test("Garbage frame closes the socket with a protocol-error code", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  connect(channel, "phone", phone);

  // 0xff is not a valid frame type.
  await channel.webSocketMessage(phone, new Uint8Array([0xff]).buffer);

  assert.ok(phone.closed, "socket should be closed");
  assert.equal(phone.closed.code, 4001);
  assert.match(phone.closed.reason, /envelope/);
});

test("String message is rejected (binary frames only)", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  connect(channel, "phone", phone);

  await channel.webSocketMessage(phone, "hello");

  assert.ok(phone.closed);
  assert.equal(phone.closed.code, 4001);
  assert.match(phone.closed.reason, /binary frames only/);
});

test("RESUME_OK from client is rejected (server-only frame)", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  connect(channel, "phone", phone);

  await channel.webSocketMessage(phone, encodeResumeOk(1).buffer);

  assert.ok(phone.closed);
  assert.equal(phone.closed.code, 4001);
});

test("webSocketClose marks peer's socket null but preserves outbox", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  const bridge = new FakeWS();
  connect(channel, "phone", phone);
  connect(channel, "bridge", bridge);

  // Phone sends one frame so its outbox has content.
  const wire = encodeData({ seq: 1, mid: generateMid(), payload: enc("x") });
  await channel.webSocketMessage(phone, wire.buffer);
  assert.equal(channel.peers.get("phone").outbox.length, 1);

  // Phone disconnects.
  await channel.webSocketClose(phone, 1006, "abnormal", false);

  assert.equal(channel.peers.get("phone").socket, null);
  assert.equal(channel.peers.get("phone").outbox.length, 1, "outbox preserved for resume");
});

test("trimOutbox enforces a cumulative byte cap", async () => {
  // A handful of huge frames must not be able to occupy more than the byte
  // cap. We can't import the constant directly (private to the module), but
  // 8 MB is the spec — push past it with 5 × 2 MB frames and confirm the
  // oldest entries get dropped to bring totalBytes back under the cap.
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  const bridge = new FakeWS();
  connect(channel, "phone", phone);
  connect(channel, "bridge", bridge);

  // First frame must look like a Noise IK msg1 (96 bytes) so the
  // fresh-handshake gate doesn't wipe the outbox after we push later frames.
  const msg1 = encodeData({ seq: 1, mid: generateMid(), payload: fakeNoiseIkMsg1() });
  await channel.webSocketMessage(phone, msg1.buffer);

  // Now push five 2 MB DATA frames. Each one alone is fine; together they
  // exceed the 8 MB outbox cap.
  const huge = fakeBytes(2 * 1024 * 1024, 0x42);
  for (let i = 2; i <= 6; i++) {
    const wire = encodeData({ seq: i, mid: generateMid(), payload: huge });
    await channel.webSocketMessage(phone, wire.buffer);
  }

  const outbox = channel.peers.get("phone").outbox;
  let totalBytes = 0;
  for (const entry of outbox) totalBytes += entry.wire.length;
  assert.ok(totalBytes <= 8 * 1024 * 1024 + 8 * 1024,
    `expected outbox bytes <= 8 MB cap, got ${totalBytes}`);
  // At least one entry got evicted (we pushed 6, cap drops to ~4 of the
  // 2 MB frames + msg1).
  assert.ok(outbox.length < 6, `expected oldest entries to be evicted, length=${outbox.length}`);
});
