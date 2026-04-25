/**
 * remote-pairing-rpc.test.mjs — Phase 3a tests for rpc.mjs (envelope framing).
 *
 * Pure unit tests — no transport, no relay. Verifies encode/decode
 * roundtrips, validation rules, and the defensive limits.
 *
 * Run:
 *   node --test scripts/test/remote-pairing-rpc.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  RPC,
  MAX_RPC_ID_LEN,
  MAX_HEADERS,
  MAX_HEADER_LEN,
  MAX_METHOD_LEN,
  MAX_PATH_LEN,
  MAX_BODY_BYTES,
  MAX_TOPIC_LEN,
  encodeRequest,
  encodeResponse,
  encodeCancel,
  encodeEvent,
  decode,
} from "../lib/remote-pairing/rpc.mjs";

// ---------------------------------------------------------------------------
// Roundtrip tests — encode then decode and assert equality
// ---------------------------------------------------------------------------

test("request roundtrip preserves all fields", () => {
  const wire = encodeRequest({
    id: "r1",
    method: "POST",
    path: "/api/threads/share",
    headers: {
      "Cookie": "viveworker_session=abc",
      "Content-Type": "application/json",
    },
    body: '{"shareType":"message","content":"hi"}',
  });
  const got = decode(wire);
  assert.equal(got.type, RPC.REQUEST);
  assert.equal(got.id, "r1");
  assert.equal(got.method, "POST");
  assert.equal(got.path, "/api/threads/share");
  // Headers should be lowercased.
  assert.deepEqual(got.headers, {
    "cookie": "viveworker_session=abc",
    "content-type": "application/json",
  });
  assert.equal(got.body, '{"shareType":"message","content":"hi"}');
  assert.equal(got.bodyEncoding, "utf8");
});

test("request without headers/body decodes cleanly", () => {
  const got = decode(encodeRequest({ id: "x", method: "GET", path: "/api/state" }));
  assert.equal(got.type, RPC.REQUEST);
  assert.equal(got.id, "x");
  assert.equal(got.method, "GET");
  assert.equal(got.path, "/api/state");
  assert.deepEqual(got.headers, {});
  assert.equal(got.body, undefined);
});

test("response roundtrip preserves status + headers + body", () => {
  const wire = encodeResponse({
    id: "r1",
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: '{"ok":true}',
  });
  const got = decode(wire);
  assert.equal(got.type, RPC.RESPONSE);
  assert.equal(got.id, "r1");
  assert.equal(got.status, 200);
  assert.deepEqual(got.headers, { "content-type": "application/json" });
  assert.equal(got.body, '{"ok":true}');
});

test("response with binary body uses base64 encoding hint", () => {
  const bin = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const b64 = Buffer.from(bin).toString("base64");
  const wire = encodeResponse({
    id: "r1", status: 200,
    headers: { "content-type": "application/octet-stream" },
    body: b64, bodyEncoding: "base64",
  });
  const got = decode(wire);
  assert.equal(got.bodyEncoding, "base64");
  assert.equal(got.body, b64);
  // Verify caller can recover the original bytes.
  const recovered = new Uint8Array(Buffer.from(got.body, "base64"));
  assert.deepEqual(recovered, bin);
});

test("cancel roundtrip", () => {
  const got = decode(encodeCancel("r1"));
  assert.equal(got.type, RPC.CANCEL);
  assert.equal(got.id, "r1");
});

test("event roundtrip with json data", () => {
  const wire = encodeEvent({ topic: "inbox-changed", data: { count: 3, mostRecent: "abc" } });
  const got = decode(wire);
  assert.equal(got.type, RPC.EVENT);
  assert.equal(got.topic, "inbox-changed");
  assert.deepEqual(got.data, { count: 3, mostRecent: "abc" });
});

test("event roundtrip without data", () => {
  const got = decode(encodeEvent({ topic: "tick" }));
  assert.equal(got.topic, "tick");
  assert.equal(got.data, undefined);
});

// ---------------------------------------------------------------------------
// Validation — encode-side
// ---------------------------------------------------------------------------

test("encodeRequest rejects missing fields", () => {
  assert.throws(() => encodeRequest({}), /id required/);
  assert.throws(() => encodeRequest({ id: "x" }), /method required/);
  assert.throws(() => encodeRequest({ id: "x", method: "GET" }), /path required/);
});

test("encodeRequest rejects non-string body", () => {
  assert.throws(
    () => encodeRequest({ id: "x", method: "POST", path: "/", body: { foo: 1 } }),
    /body must be a string/,
  );
});

test("encodeRequest rejects path missing leading slash", () => {
  assert.throws(
    () => encodeRequest({ id: "x", method: "GET", path: "api/state" }),
    /must start with "\/"/,
  );
});

test("encodeRequest rejects oversized id / method / path / headers / body", () => {
  const longId = "a".repeat(MAX_RPC_ID_LEN + 1);
  assert.throws(() => encodeRequest({ id: longId, method: "GET", path: "/" }), /id exceeds/);

  const longMethod = "X".repeat(MAX_METHOD_LEN + 1);
  assert.throws(() => encodeRequest({ id: "x", method: longMethod, path: "/" }), /method exceeds/);

  const longPath = "/" + "p".repeat(MAX_PATH_LEN);
  assert.throws(() => encodeRequest({ id: "x", method: "GET", path: longPath }), /path exceeds/);

  const tooManyHeaders = {};
  for (let i = 0; i < MAX_HEADERS + 1; i++) tooManyHeaders[`h${i}`] = "v";
  assert.throws(
    () => encodeRequest({ id: "x", method: "GET", path: "/", headers: tooManyHeaders }),
    /headers exceeds/,
  );

  const longHeader = "v".repeat(MAX_HEADER_LEN + 1);
  assert.throws(
    () => encodeRequest({ id: "x", method: "GET", path: "/", headers: { x: longHeader } }),
    /exceeds .* chars/,
  );

  // body length cap is forgiving (4 MiB), so we don't allocate a huge string
  // here — just verify the boundary check is wired by passing a string at
  // the cap+1 size in a quick allocation that we discard.
  const longBody = "b".repeat(MAX_BODY_BYTES + 1);
  assert.throws(
    () => encodeRequest({ id: "x", method: "POST", path: "/", body: longBody }),
    /body exceeds/,
  );
});

test("encodeResponse rejects out-of-range status", () => {
  assert.throws(() => encodeResponse({ id: "x", status: 99 }), /\[100, 599\]/);
  assert.throws(() => encodeResponse({ id: "x", status: 600 }), /\[100, 599\]/);
  assert.throws(() => encodeResponse({ id: "x", status: 200.5 }), /\[100, 599\]/);
});

test("encodeEvent rejects oversized topic", () => {
  const longTopic = "t".repeat(MAX_TOPIC_LEN + 1);
  assert.throws(() => encodeEvent({ topic: longTopic }), /topic exceeds/);
});

test("encodeRequest rejects non-utf8/non-base64 bodyEncoding", () => {
  assert.throws(
    () => encodeRequest({ id: "x", method: "POST", path: "/", body: "ZGVm", bodyEncoding: "rot13" }),
    /bodyEncoding/,
  );
});

// ---------------------------------------------------------------------------
// Validation — decode-side (defensive against a peer that ignores encode rules)
// ---------------------------------------------------------------------------

test("decode rejects non-Uint8Array input", () => {
  assert.throws(() => decode("not-bytes"), /Uint8Array/);
  assert.throws(() => decode(null), /Uint8Array/);
});

test("decode rejects malformed JSON", () => {
  const garbage = new TextEncoder().encode("{not-json");
  assert.throws(() => decode(garbage), /invalid JSON/);
});

test("decode rejects invalid UTF-8", () => {
  // 0xFF is never valid in UTF-8 as a leading byte.
  assert.throws(() => decode(new Uint8Array([0xff, 0xff, 0xff])), /invalid UTF-8/);
});

test("decode rejects non-object root", () => {
  const arr = new TextEncoder().encode("[1,2,3]");
  assert.throws(() => decode(arr), /not a JSON object/);
  const num = new TextEncoder().encode("42");
  assert.throws(() => decode(num), /not a JSON object/);
  const nul = new TextEncoder().encode("null");
  assert.throws(() => decode(nul), /not a JSON object/);
});

test("decode rejects unknown type discriminator", () => {
  const wire = new TextEncoder().encode(JSON.stringify({ t: "unknown", id: "x" }));
  assert.throws(() => decode(wire), /unknown type/);
});

test("decode rejects request missing required fields", () => {
  const wire = new TextEncoder().encode(JSON.stringify({ t: "req", id: "x" /* no method, no path */ }));
  assert.throws(() => decode(wire), /method required/);
});

test("decode rejects response with non-numeric status", () => {
  const wire = new TextEncoder().encode(JSON.stringify({ t: "res", id: "x", status: "200" }));
  assert.throws(() => decode(wire), /\[100, 599\]/);
});

test("decode rejects oversized headers count from a misbehaving peer", () => {
  const headers = {};
  for (let i = 0; i < MAX_HEADERS + 5; i++) headers[`h${i}`] = "v";
  const wire = new TextEncoder().encode(
    JSON.stringify({ t: "req", id: "x", method: "GET", path: "/", headers }),
  );
  assert.throws(() => decode(wire), /headers exceeds/);
});

test("decode tolerates extra unknown fields (forward-compat)", () => {
  const wire = new TextEncoder().encode(
    JSON.stringify({ t: "req", id: "x", method: "GET", path: "/", futureFlag: 7, extraStuff: { a: 1 } }),
  );
  // Should decode cleanly and just ignore the extras.
  const got = decode(wire);
  assert.equal(got.type, RPC.REQUEST);
  assert.equal(got.id, "x");
});

// ---------------------------------------------------------------------------
// Header lowercase invariant (matters for the bridge handler — Node's
// IncomingMessage.headers is lowercased; tunneled requests must match).
// ---------------------------------------------------------------------------

test("encode lowercases header keys regardless of input casing", () => {
  const wire = encodeRequest({
    id: "x", method: "GET", path: "/",
    headers: {
      "X-Custom-Header": "1",
      "ACCEPT": "application/json",
      "lower-case": "ok",
    },
  });
  const got = decode(wire);
  assert.deepEqual(got.headers, {
    "x-custom-header": "1",
    "accept": "application/json",
    "lower-case": "ok",
  });
});
