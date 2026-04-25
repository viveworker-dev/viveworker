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
 * Hook a fake WS into a freshly-built PairingChannel as `role`. Mirrors what
 * `fetch()` does when a peer connects, minus the WebSocketPair/upgrade dance.
 */
function connect(channel, role, ws) {
  channel.state.acceptWebSocket(ws, [role]);
  ws.serializeAttachment({ role });
  const existing = channel.peers.get(role);
  channel.peers.set(role, {
    socket: ws,
    outbox: existing?.outbox ?? [],
    lastSent: existing?.lastSent ?? 0,
    coldWake: false,
  });
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
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("DATA from phone is forwarded to bridge and buffered in phone's outbox", async () => {
  const channel = new PairingChannel(new FakeState(), {});
  const phone = new FakeWS();
  const bridge = new FakeWS();
  connect(channel, "phone", phone);
  connect(channel, "bridge", bridge);

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
  connect(channel, "phone", phone);
  connect(channel, "bridge", bridge);

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
