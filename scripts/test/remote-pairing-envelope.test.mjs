/**
 * remote-pairing-envelope.test.mjs — Unit tests for the wire envelope.
 *
 * Run:
 *   node --test scripts/test/remote-pairing-envelope.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FRAME_DATA,
  FRAME_ACK,
  FRAME_PING,
  FRAME_PONG,
  FRAME_RESUME_REQ,
  FRAME_RESUME_OK,
  FRAME_RESUME_FAIL,
  RESUME_FAIL_BUFFER_EXPIRED,
  MID_BYTES,
  encodeData,
  encodeAck,
  encodePing,
  encodePong,
  encodeResumeReq,
  encodeResumeOk,
  encodeResumeFail,
  decode,
  generateMid,
  midToHex,
  frameTypeName,
} from "../lib/remote-pairing/envelope.mjs";

const enc = (s) => new TextEncoder().encode(s);

// ---------------------------------------------------------------------------
// Round-trips
// ---------------------------------------------------------------------------

test("DATA frame round-trips", () => {
  const mid = generateMid();
  const payload = enc("ciphertext-bytes-here");
  const wire = encodeData({ seq: 42, mid, payload });
  // 1 (type) + 4 (seq) + 16 (mid) + payload
  assert.equal(wire.length, 21 + payload.length);
  const out = decode(wire);
  assert.equal(out.type, FRAME_DATA);
  assert.equal(out.seq, 42);
  assert.deepEqual(out.mid, mid);
  assert.deepEqual(out.payload, payload);
});

test("DATA frame with empty payload", () => {
  const mid = generateMid();
  const wire = encodeData({ seq: 0, mid, payload: new Uint8Array(0) });
  assert.equal(wire.length, 21);
  const out = decode(wire);
  assert.equal(out.type, FRAME_DATA);
  assert.equal(out.seq, 0);
  assert.equal(out.payload.length, 0);
});

test("DATA frame with max u32 seq", () => {
  const mid = generateMid();
  const wire = encodeData({ seq: 0xffff_ffff, mid, payload: new Uint8Array(0) });
  const out = decode(wire);
  assert.equal(out.seq, 0xffff_ffff);
});

test("ACK frame round-trips", () => {
  const wire = encodeAck(123);
  assert.equal(wire.length, 5);
  const out = decode(wire);
  assert.equal(out.type, FRAME_ACK);
  assert.equal(out.seq, 123);
});

test("PING / PONG single byte", () => {
  const ping = encodePing();
  const pong = encodePong();
  assert.equal(ping.length, 1);
  assert.equal(pong.length, 1);
  assert.equal(decode(ping).type, FRAME_PING);
  assert.equal(decode(pong).type, FRAME_PONG);
});

test("RESUME_REQ / RESUME_OK / RESUME_FAIL round-trip", () => {
  const req = encodeResumeReq(7);
  const ok = encodeResumeOk(42);
  const fail = encodeResumeFail(RESUME_FAIL_BUFFER_EXPIRED);

  const oReq = decode(req);
  assert.equal(oReq.type, FRAME_RESUME_REQ);
  assert.equal(oReq.lastSeenSeq, 7);

  const oOk = decode(ok);
  assert.equal(oOk.type, FRAME_RESUME_OK);
  assert.equal(oOk.currentSeq, 42);

  const oFail = decode(fail);
  assert.equal(oFail.type, FRAME_RESUME_FAIL);
  assert.equal(oFail.reason, RESUME_FAIL_BUFFER_EXPIRED);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("decode rejects empty frame", () => {
  assert.throws(() => decode(new Uint8Array(0)), /empty/);
});

test("decode rejects unknown type", () => {
  assert.throws(() => decode(new Uint8Array([0xff])), /unknown frame type/);
});

test("decode rejects truncated DATA", () => {
  assert.throws(() => decode(new Uint8Array([0x01, 0x00, 0x00])), /too short/);
});

test("decode rejects ACK with wrong length", () => {
  assert.throws(() => decode(new Uint8Array([0x02, 0x00, 0x00, 0x00])), /wrong length/);
  assert.throws(() => decode(new Uint8Array([0x02, 0x00, 0x00, 0x00, 0x00, 0x00])), /wrong length/);
});

test("decode rejects PING with extra bytes", () => {
  assert.throws(() => decode(new Uint8Array([0x03, 0x00])), /wrong length/);
});

test("encodeData validates mid length", () => {
  assert.throws(
    () => encodeData({ seq: 0, mid: new Uint8Array(15), payload: new Uint8Array(0) }),
    /mid must be 16 bytes/,
  );
});

test("encodeData validates seq range", () => {
  const mid = generateMid();
  assert.throws(
    () => encodeData({ seq: -1, mid, payload: new Uint8Array(0) }),
    /u32 out of range/,
  );
  assert.throws(
    () => encodeData({ seq: 0x1_0000_0000, mid, payload: new Uint8Array(0) }),
    /u32 out of range/,
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test("generateMid yields 16 distinct bytes", () => {
  const a = generateMid();
  const b = generateMid();
  assert.equal(a.length, MID_BYTES);
  assert.equal(b.length, MID_BYTES);
  // Probability of collision is 2^-128 → astronomically unlikely
  assert.notDeepEqual(a, b);
});

test("midToHex produces 32 lowercase hex chars", () => {
  const mid = new Uint8Array([
    0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11,
    0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99,
  ]);
  assert.equal(midToHex(mid), "aabbccddeeff00112233445566778899");
});

test("frameTypeName covers all defined types + unknown fallback", () => {
  assert.equal(frameTypeName(FRAME_DATA), "DATA");
  assert.equal(frameTypeName(FRAME_ACK), "ACK");
  assert.equal(frameTypeName(FRAME_PING), "PING");
  assert.equal(frameTypeName(FRAME_PONG), "PONG");
  assert.equal(frameTypeName(FRAME_RESUME_REQ), "RESUME_REQ");
  assert.equal(frameTypeName(FRAME_RESUME_OK), "RESUME_OK");
  assert.equal(frameTypeName(FRAME_RESUME_FAIL), "RESUME_FAIL");
  assert.match(frameTypeName(0x99), /UNKNOWN/);
});

// ---------------------------------------------------------------------------
// Cross-platform: decode handles ArrayBuffer / Buffer / Uint8Array
// ---------------------------------------------------------------------------

test("decode accepts ArrayBuffer (browser/Worker shape)", () => {
  const mid = generateMid();
  const u8 = encodeData({ seq: 1, mid, payload: enc("hi") });
  // The .buffer might have offset; copy into a fresh ArrayBuffer to mirror
  // what `event.data` looks like on a CF Worker WS message.
  const ab = new ArrayBuffer(u8.length);
  new Uint8Array(ab).set(u8);
  const out = decode(ab);
  assert.equal(out.type, FRAME_DATA);
  assert.equal(out.seq, 1);
});

test("decode accepts Node Buffer (PC bridge)", () => {
  const mid = generateMid();
  const u8 = encodeData({ seq: 1, mid, payload: enc("hi") });
  const buf = Buffer.from(u8);
  const out = decode(buf);
  assert.equal(out.type, FRAME_DATA);
  assert.equal(out.seq, 1);
});
