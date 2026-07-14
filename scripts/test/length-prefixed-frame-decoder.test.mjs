import assert from "node:assert/strict";
import test from "node:test";

import { LengthPrefixedFrameDecoder } from "../lib/length-prefixed-frame-decoder.mjs";

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

test("decodes a frame whose header and body arrive in small chunks", () => {
  const decoder = new LengthPrefixedFrameDecoder();
  const encoded = encodeFrame({ type: "broadcast", payload: "hello" });
  const decoded = [];

  for (let index = 0; index < encoded.length; index += 1) {
    decoded.push(...decoder.push(encoded.subarray(index, index + 1)));
  }

  assert.equal(decoded.length, 1);
  assert.deepEqual(JSON.parse(decoded[0].toString("utf8")), {
    type: "broadcast",
    payload: "hello",
  });
  assert.equal(decoder.bufferedBytes, 0);
});

test("decodes multiple frames while retaining a partial trailing frame", () => {
  const decoder = new LengthPrefixedFrameDecoder();
  const first = encodeFrame({ id: 1 });
  const second = encodeFrame({ id: 2 });
  const third = encodeFrame({ id: 3 });
  const combined = Buffer.concat([first, second, third]);
  const splitAt = first.length + second.length + 3;

  const initial = decoder.push(combined.subarray(0, splitAt));
  assert.deepEqual(initial.map((frame) => JSON.parse(frame.toString("utf8"))), [{ id: 1 }, { id: 2 }]);
  assert.equal(decoder.bufferedBytes, 3);

  const final = decoder.push(combined.subarray(splitAt));
  assert.deepEqual(final.map((frame) => JSON.parse(frame.toString("utf8"))), [{ id: 3 }]);
  assert.equal(decoder.bufferedBytes, 0);
});

test("large frames are accumulated without rebuilding the prior buffer", () => {
  const decoder = new LengthPrefixedFrameDecoder();
  const payload = { content: "x".repeat(4 * 1024 * 1024) };
  const encoded = encodeFrame(payload);
  let frames = [];

  for (let offset = 0; offset < encoded.length; offset += 4096) {
    frames = decoder.push(encoded.subarray(offset, offset + 4096));
  }

  assert.equal(frames.length, 1);
  assert.equal(JSON.parse(frames[0].toString("utf8")).content.length, payload.content.length);
  assert.equal(decoder.bufferedBytes, 0);
});

test("oversized frames are rejected and clear buffered data", () => {
  const decoder = new LengthPrefixedFrameDecoder({ maxFrameBytes: 8 });
  const header = Buffer.alloc(4);
  header.writeUInt32LE(9, 0);

  assert.throws(() => decoder.push(header), /exceeds 8 bytes/u);
  assert.equal(decoder.bufferedBytes, 0);
});
