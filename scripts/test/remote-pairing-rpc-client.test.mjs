/**
 * remote-pairing-rpc-client.test.mjs — Phase 4c tests for the phone-side
 * fetch-shaped RPC client (web/remote-pairing/rpc-client.js).
 *
 * Pure unit tests: a `FakeTransport` injected via the client's test-only
 * `transportFactory` option captures outgoing frames and lets the test
 * synthesize inbound frames (responses, events, cancels). No relay, no
 * Noise crypto, no WebSocket.
 *
 * Coverage:
 *   - fetch() id-correlation + body roundtrip (utf8 + base64)
 *   - response helpers: text(), json(), bytes(), arrayBuffer()
 *   - timeout fires + cancel-frame is emitted
 *   - AbortSignal aborts the pending fetch + emits cancel-frame
 *   - close() rejects every pending fetch
 *   - transport FAILED state rejects every pending fetch
 *   - bridge-initiated cancel surfaces as RpcCancelledByPeerError
 *   - on(topic, handler) subscriber + global onEvent both fire
 *   - off() unsubscribes
 *   - request id is unique per call
 *   - dropped response (id mismatch) is silently ignored
 *
 * Run:
 *   node --test scripts/test/remote-pairing-rpc-client.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  RemotePairingRpcClient,
  RpcTimeoutError,
  RpcClientClosedError,
  RpcTransportFailedError,
  RpcTransportError,
  RpcCancelledByPeerError,
  STATE,
} from "../../web/remote-pairing/rpc-client.js";
import {
  RPC,
  encodeResponse,
  encodeEvent,
  encodeCancel,
  decodeRpc,
} from "../../web/remote-pairing.bundle.js";

// ===========================================================================
// FakeTransport — minimum surface the client needs.
// ===========================================================================

function makeFakeTransport() {
  /** @type {Uint8Array[]} */
  const sent = [];
  let onMessage = () => {};
  let onStateChange = () => {};
  let state = STATE.DISCONNECTED;
  let isConnected = false;
  let closed = false;
  let connectResolve = null;

  const transport = {
    get state() { return state; },
    get isConnected() { return isConnected; },
    get channelBinding() { return new Uint8Array(32); },
    connect() {
      // Auto-connect synchronously by default; tests that want to control
      // ordering can call `transport._setConnected()` manually.
      return new Promise((resolve) => {
        connectResolve = resolve;
        // Fire the connected transition immediately on the next tick.
        queueMicrotask(() => {
          if (closed) return;
          transport._setState(STATE.OPENING);
          transport._setState(STATE.HANDSHAKING);
          transport._setState(STATE.CONNECTED);
          isConnected = true;
          resolve();
        });
      });
    },
    send(plaintext) {
      if (!isConnected) throw new Error(`transport not connected (state=${state})`);
      sent.push(plaintext);
    },
    close() {
      closed = true;
      isConnected = false;
      transport._setState(STATE.DISCONNECTED, { reason: "closed" });
    },
    kick() {},

    // ---- Test helpers (prefixed with _) ----
    _sent: sent,
    _setState(next, info) {
      const prev = state;
      state = next;
      try { onStateChange(next, prev, info); } catch (e) { /* ignore */ }
    },
    _setConnected() {
      isConnected = true;
      transport._setState(STATE.CONNECTED);
    },
    _setFailed(info = { reason: "fatal" }) {
      isConnected = false;
      transport._setState(STATE.FAILED, info);
    },
    _injectMessage(plaintext) {
      onMessage(plaintext);
    },
    _bind({ onMessage: m, onStateChange: s }) {
      onMessage = m;
      onStateChange = s;
    },
  };

  function factory(opts) {
    transport._bind({
      onMessage: opts.onMessage,
      onStateChange: opts.onStateChange,
    });
    return transport;
  }

  return { transport, factory };
}

function fakeIdentityKeypair() {
  // The fake transport doesn't actually use these, but the client validates
  // they're 32-byte Uint8Arrays before passing through.
  return {
    priv: new Uint8Array(32),
    pub: new Uint8Array(32),
  };
}

function makeClient(extraOpts = {}) {
  const { transport, factory } = makeFakeTransport();
  const client = new RemotePairingRpcClient({
    relayUrl: "wss://example",
    pairingId: "pair-test",
    relayToken: "v1.testtesttesttesttesttesttesttest.abc",
    identityKeypair: fakeIdentityKeypair(),
    remoteStatic: new Uint8Array(32),
    transportFactory: factory,
    defaultTimeoutMs: 1_000,
    ...extraOpts,
  });
  return { client, transport };
}

function lastSentFrame(transport) {
  if (transport._sent.length === 0) throw new Error("nothing sent yet");
  return decodeRpc(transport._sent[transport._sent.length - 1]);
}

// ===========================================================================
// Constructor + getters
// ===========================================================================

test("constructor: missing opts throws", () => {
  assert.throws(() => new RemotePairingRpcClient(), /opts required/);
});

test("getters: state / isConnected / channelBinding / pendingCount", async () => {
  const { client } = makeClient();
  assert.equal(client.state, STATE.DISCONNECTED);
  assert.equal(client.isConnected, false);
  assert.equal(client.pendingCount, 0);
  await client.connect();
  assert.equal(client.state, STATE.CONNECTED);
  assert.equal(client.isConnected, true);
  assert.ok(client.channelBinding instanceof Uint8Array);
  client.close();
});

// ===========================================================================
// fetch() — happy path
// ===========================================================================

test("fetch: GET sends a req frame; matching res resolves with helpers", async () => {
  const { client, transport } = makeClient();
  await client.connect();

  const p = client.fetch({
    method: "GET",
    path: "/api/state",
    headers: { "x-test": "yo" },
  });

  // Inspect outgoing frame
  await waitFor(() => transport._sent.length > 0);
  const sent = lastSentFrame(transport);
  assert.equal(sent.type, RPC.REQUEST);
  assert.equal(sent.method, "GET");
  assert.equal(sent.path, "/api/state");
  assert.deepEqual(sent.headers, { "x-test": "yo" });
  assert.match(sent.id, /^[0-9a-f]+-[0-9a-z]+$/);

  // Synthesize response with matching id
  transport._injectMessage(encodeResponse({
    id: sent.id,
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  }));

  const res = await p;
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "application/json");
  assert.equal(res.text(), '{"hello":"world"}');
  assert.deepEqual(res.json(), { hello: "world" });
  assert.equal(res.bytes() instanceof Uint8Array, true);
  assert.equal(res.bytes().length, 17);
  assert.equal(res.arrayBuffer() instanceof ArrayBuffer, true);

  assert.equal(client.pendingCount, 0);
  client.close();
});

test("fetch: called before connect waits for CONNECTED before sending", async () => {
  const { client, transport } = makeClient();

  const p = client.fetch({
    method: "GET",
    path: "/api/bootstrap",
  });

  assert.equal(transport._sent.length, 0, "request must not send before connect resolves");
  await waitFor(() => transport._sent.length === 1);
  const sent = lastSentFrame(transport);
  assert.equal(sent.type, RPC.REQUEST);
  assert.equal(sent.path, "/api/bootstrap");

  transport._injectMessage(encodeResponse({
    id: sent.id,
    status: 200,
    body: JSON.stringify({ boot: true }),
  }));

  const res = await p;
  assert.deepEqual(res.json(), { boot: true });
  client.close();
});

test("fetch: connect failure rejects with RpcTransportError", async () => {
  const transport = {
    get state() { return STATE.DISCONNECTED; },
    get isConnected() { return false; },
    get channelBinding() { return null; },
    connect() { return Promise.reject(new Error("dial failed")); },
    send() { throw new Error("should not send"); },
    close() {},
    kick() {},
  };
  const client = new RemotePairingRpcClient({
    relayUrl: "wss://example",
    pairingId: "pair-test",
    relayToken: "v1.testtesttesttesttesttesttesttest.abc",
    identityKeypair: fakeIdentityKeypair(),
    remoteStatic: new Uint8Array(32),
    transportFactory: () => transport,
    defaultTimeoutMs: 1_000,
  });

  await assert.rejects(
    client.fetch({ method: "GET", path: "/api/bootstrap" }),
    RpcTransportError,
  );
});

test("fetch: POST with string body; bodyEncoding utf8 (default)", async () => {
  const { client, transport } = makeClient();
  await client.connect();
  const p = client.fetch({
    method: "POST",
    path: "/api/x",
    headers: { "content-type": "application/json" },
    body: '{"k":"v"}',
  });
  await waitFor(() => transport._sent.length > 0);
  const sent = lastSentFrame(transport);
  assert.equal(sent.method, "POST");
  assert.equal(sent.body, '{"k":"v"}');
  assert.equal(sent.bodyEncoding, "utf8");
  transport._injectMessage(encodeResponse({ id: sent.id, status: 204 }));
  const res = await p;
  assert.equal(res.status, 204);
  assert.equal(res.text(), "");
  client.close();
});

test("fetch: Uint8Array body → base64 wire encoding", async () => {
  const { client, transport } = makeClient();
  await client.connect();
  const bin = new Uint8Array([0x00, 0xff, 0x10, 0x20, 0x80]);
  const p = client.fetch({
    method: "POST",
    path: "/uploads",
    body: bin,
  });
  await waitFor(() => transport._sent.length > 0);
  const sent = lastSentFrame(transport);
  assert.equal(sent.bodyEncoding, "base64");
  // Round-trip: decode the base64 and compare bytes.
  const sentBytes = Uint8Array.from(Buffer.from(sent.body, "base64"));
  assert.deepEqual(Array.from(sentBytes), Array.from(bin));
  transport._injectMessage(encodeResponse({ id: sent.id, status: 200 }));
  await p;
  client.close();
});

test("fetch: ArrayBuffer body → base64", async () => {
  const { client, transport } = makeClient();
  await client.connect();
  const bin = new Uint8Array([1, 2, 3, 4]).buffer; // ArrayBuffer
  const p = client.fetch({ method: "POST", path: "/u", body: bin });
  await waitFor(() => transport._sent.length > 0);
  const sent = lastSentFrame(transport);
  assert.equal(sent.bodyEncoding, "base64");
  transport._injectMessage(encodeResponse({ id: sent.id, status: 200 }));
  await p;
  client.close();
});

test("fetch: invalid body type rejects", async () => {
  const { client } = makeClient();
  await client.connect();
  await assert.rejects(
    client.fetch({ method: "POST", path: "/x", body: 12345 }),
    /body must be string/,
  );
  client.close();
});

test("response: base64 body decodes via .bytes() / .text()", async () => {
  const { client, transport } = makeClient();
  await client.connect();
  const p = client.fetch({ method: "GET", path: "/binary" });
  await waitFor(() => transport._sent.length > 0);
  const sent = lastSentFrame(transport);
  // Send base64-encoded "hello"
  transport._injectMessage(encodeResponse({
    id: sent.id,
    status: 200,
    body: Buffer.from("hello").toString("base64"),
    bodyEncoding: "base64",
  }));
  const res = await p;
  assert.equal(res.bodyEncoding, "base64");
  assert.equal(res.text(), "hello");
  assert.deepEqual(Array.from(res.bytes()), [0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  client.close();
});

// ===========================================================================
// id correlation & uniqueness
// ===========================================================================

test("multiple in-flight fetches: each gets the right response", async () => {
  const { client, transport } = makeClient();
  await client.connect();

  const p1 = client.fetch({ method: "GET", path: "/a" });
  const p2 = client.fetch({ method: "GET", path: "/b" });
  const p3 = client.fetch({ method: "GET", path: "/c" });

  await waitFor(() => transport._sent.length === 3);
  const ids = transport._sent.map((f) => decodeRpc(f).id);
  assert.equal(new Set(ids).size, 3, "all ids must be unique");
  assert.equal(client.pendingCount, 3);

  // Respond out of order
  transport._injectMessage(encodeResponse({ id: ids[2], status: 203 }));
  transport._injectMessage(encodeResponse({ id: ids[0], status: 201 }));
  transport._injectMessage(encodeResponse({ id: ids[1], status: 202 }));

  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 202);
  assert.equal(r3.status, 203);
  assert.equal(client.pendingCount, 0);
  client.close();
});

test("response with unknown id is silently dropped (no throw)", async () => {
  const { client, transport } = makeClient();
  await client.connect();
  // Inject a response that doesn't match any pending id — must not throw.
  transport._injectMessage(encodeResponse({ id: "no-such-id", status: 200 }));
  // Sanity: a real fetch still works after.
  const p = client.fetch({ method: "GET", path: "/x" });
  await waitFor(() => transport._sent.length > 0);
  const sent = lastSentFrame(transport);
  transport._injectMessage(encodeResponse({ id: sent.id, status: 204 }));
  const res = await p;
  assert.equal(res.status, 204);
  client.close();
});

// ===========================================================================
// timeouts + abort
// ===========================================================================

test("fetch: timeout fires; cancel-frame is emitted", async () => {
  const { client, transport } = makeClient({ defaultTimeoutMs: 50 });
  await client.connect();
  const p = client.fetch({ method: "GET", path: "/slow" });
  await waitFor(() => transport._sent.length > 0);
  const reqId = lastSentFrame(transport).id;

  await assert.rejects(p, RpcTimeoutError);
  // After timeout, a cancel frame for this id should have been sent.
  await waitFor(() => transport._sent.length >= 2);
  const lastFrame = lastSentFrame(transport);
  assert.equal(lastFrame.type, RPC.CANCEL);
  assert.equal(lastFrame.id, reqId);
  assert.equal(client.pendingCount, 0);
  client.close();
});

test("fetch: timeoutMs override on a single call", async () => {
  const { client, transport } = makeClient({ defaultTimeoutMs: 60_000 });
  await client.connect();
  const p = client.fetch({
    method: "GET", path: "/slow", timeoutMs: 30,
  });
  await assert.rejects(p, RpcTimeoutError);
  client.close();
});

test("fetch: timeoutMs=0 disables the timeout", async () => {
  const { client, transport } = makeClient({ defaultTimeoutMs: 60_000 });
  await client.connect();
  const p = client.fetch({
    method: "GET", path: "/forever", timeoutMs: 0,
  });
  await waitFor(() => transport._sent.length > 0);
  const reqId = lastSentFrame(transport).id;
  // Wait some time; promise must NOT have settled yet.
  await sleep(80);
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await sleep(20);
  assert.equal(settled, false);
  // Now answer for cleanup.
  transport._injectMessage(encodeResponse({ id: reqId, status: 200 }));
  await p;
  client.close();
});

test("fetch: AbortSignal aborts pending fetch + emits cancel-frame", async () => {
  const { client, transport } = makeClient();
  await client.connect();
  const ac = new AbortController();
  const p = client.fetch({ method: "GET", path: "/x", signal: ac.signal });
  await waitFor(() => transport._sent.length > 0);
  const reqId = lastSentFrame(transport).id;

  ac.abort();
  await assert.rejects(p, (err) => err.name === "AbortError");
  await waitFor(() => transport._sent.length >= 2);
  const cancel = lastSentFrame(transport);
  assert.equal(cancel.type, RPC.CANCEL);
  assert.equal(cancel.id, reqId);
  client.close();
});

test("fetch: signal already aborted → rejects synchronously", async () => {
  const { client } = makeClient();
  await client.connect();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    client.fetch({ method: "GET", path: "/x", signal: ac.signal }),
    (err) => err.name === "AbortError",
  );
  client.close();
});

// ===========================================================================
// close() / transport-failed termination
// ===========================================================================

test("close(): every pending fetch rejects with RpcClientClosedError", async () => {
  const { client, transport } = makeClient();
  await client.connect();
  const p1 = client.fetch({ method: "GET", path: "/a" });
  const p2 = client.fetch({ method: "GET", path: "/b" });
  await waitFor(() => transport._sent.length === 2);
  client.close();
  await assert.rejects(p1, RpcClientClosedError);
  await assert.rejects(p2, RpcClientClosedError);
});

test("close(): subsequent fetch rejects with RpcClientClosedError", async () => {
  const { client } = makeClient();
  await client.connect();
  client.close();
  await assert.rejects(
    client.fetch({ method: "GET", path: "/x" }),
    RpcClientClosedError,
  );
});

test("close(): connect() rejects with RpcClientClosedError after close", async () => {
  const { client } = makeClient();
  client.close();
  await assert.rejects(client.connect(), RpcClientClosedError);
});

test("transport FAILED: every pending fetch rejects with RpcTransportFailedError", async () => {
  const { client, transport } = makeClient();
  await client.connect();
  const p1 = client.fetch({ method: "GET", path: "/a" });
  const p2 = client.fetch({ method: "GET", path: "/b" });
  await waitFor(() => transport._sent.length === 2);

  transport._setFailed({ reason: "resume-fail" });

  await assert.rejects(p1, RpcTransportFailedError);
  await assert.rejects(p2, RpcTransportFailedError);
  assert.equal(client.pendingCount, 0);
  client.close();
});

test("close() is idempotent", async () => {
  const { client } = makeClient();
  await client.connect();
  client.close();
  client.close();
  client.close();
});

// ===========================================================================
// peer-initiated cancel
// ===========================================================================

test("bridge cancel frame: matching pending fetch rejects with RpcCancelledByPeerError", async () => {
  const { client, transport } = makeClient();
  await client.connect();
  const p = client.fetch({ method: "GET", path: "/x" });
  await waitFor(() => transport._sent.length > 0);
  const reqId = lastSentFrame(transport).id;

  transport._injectMessage(encodeCancel(reqId));
  await assert.rejects(p, RpcCancelledByPeerError);
  client.close();
});

test("bridge cancel for unknown id: dropped silently", async () => {
  const { client, transport } = makeClient();
  await client.connect();
  // Inject a cancel for a non-existent id; must not throw.
  transport._injectMessage(encodeCancel("unknown"));
  // The client should still be able to send + receive.
  const p = client.fetch({ method: "GET", path: "/x" });
  await waitFor(() => transport._sent.length > 0);
  const sent = lastSentFrame(transport);
  transport._injectMessage(encodeResponse({ id: sent.id, status: 200 }));
  await p;
  client.close();
});

// ===========================================================================
// events
// ===========================================================================

test("on(topic, handler) receives matching events; off() unsubscribes", async () => {
  const { client, transport } = makeClient();
  await client.connect();
  const got = [];
  const unsub = client.on("inbox", (data) => got.push(data));
  transport._injectMessage(encodeEvent({ topic: "inbox", data: { id: 1 } }));
  transport._injectMessage(encodeEvent({ topic: "inbox", data: { id: 2 } }));
  // A different topic should NOT trigger this handler.
  transport._injectMessage(encodeEvent({ topic: "other", data: {} }));
  assert.deepEqual(got, [{ id: 1 }, { id: 2 }]);
  unsub();
  transport._injectMessage(encodeEvent({ topic: "inbox", data: { id: 3 } }));
  assert.deepEqual(got, [{ id: 1 }, { id: 2 }]);
  client.close();
});

test("global onEvent receives every event regardless of topic", async () => {
  const events = [];
  const { client, transport } = makeClient({
    onEvent: (topic, data) => events.push({ topic, data }),
  });
  await client.connect();
  transport._injectMessage(encodeEvent({ topic: "a", data: 1 }));
  transport._injectMessage(encodeEvent({ topic: "b", data: 2 }));
  transport._injectMessage(encodeEvent({ topic: "a", data: 3 }));
  assert.deepEqual(events, [
    { topic: "a", data: 1 },
    { topic: "b", data: 2 },
    { topic: "a", data: 3 },
  ]);
  client.close();
});

test("on() throws on bad inputs", () => {
  const { client } = makeClient();
  assert.throws(() => client.on("", () => {}), /topic required/);
  assert.throws(() => client.on("topic", "not a function"), /handler required/);
  client.close();
});

test("a throwing per-topic handler doesn't break dispatch to other handlers", async () => {
  const { client, transport } = makeClient();
  await client.connect();
  const got = [];
  client.on("t", () => { throw new Error("boom"); });
  client.on("t", (d) => got.push(d));
  transport._injectMessage(encodeEvent({ topic: "t", data: 42 }));
  assert.deepEqual(got, [42]);
  client.close();
});

// ===========================================================================
// state-change hooks
// ===========================================================================

test("onConnected + onDisconnected hooks fire on state transitions", async () => {
  const log = [];
  const { client, transport } = makeClient({
    onConnected: () => log.push("connected"),
    onDisconnected: (info) => log.push(`disconnected:${info?.reason ?? ""}`),
  });
  await client.connect();
  assert.deepEqual(log, ["connected"]);
  transport._setState(STATE.DISCONNECTED, { reason: "wakelost" });
  assert.deepEqual(log, ["connected", "disconnected:wakelost"]);
  client.close();
});

// ===========================================================================
// Misc: helpers
// ===========================================================================

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error("waitFor: predicate never became true");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
