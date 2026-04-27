/**
 * remote-pairing-http-dispatch.test.mjs — Phase 4a tests for the
 * HTTP dispatch adapter (http-dispatch.mjs).
 *
 * Pure unit tests — no relay, no transport. Builds a synthetic RPC request,
 * runs it through `createHttpDispatch` against a tiny stub Node-style
 * listener, and asserts the captured response.
 *
 * Run:
 *   node --test scripts/test/remote-pairing-http-dispatch.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createHttpDispatch, classifyRelayPath } from "../lib/remote-pairing/http-dispatch.mjs";
import { buildPairing } from "../lib/remote-pairing/pairings.mjs";
import { generateIdentityKeypair } from "../lib/remote-pairing/keys-core.mjs";

// ---------------------------------------------------------------------------
// Helpers — fake pairing + RPC request
// ---------------------------------------------------------------------------

function fakePairing(label = "test-phone") {
  const kp = generateIdentityKeypair();
  return buildPairing({ pairingId: "p-1", phonePub: kp.pub, label });
}

function fakeRpc({ method = "GET", path = "/api/x", headers = {}, body, bodyEncoding } = {}) {
  return {
    method,
    path,
    headers,
    body,
    bodyEncoding,
    signal: new AbortController().signal,
    pairing: fakePairing(),
    channelBinding: new Uint8Array(32),
  };
}

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

test("createHttpDispatch rejects missing requestListener", () => {
  assert.throws(() => createHttpDispatch({}), /requestListener/);
  assert.throws(() => createHttpDispatch({ requestListener: "nope" }), /requestListener/);
});

// ---------------------------------------------------------------------------
// GET — basic dispatch
// ---------------------------------------------------------------------------

test("GET request: listener sees method/url/headers; response round-trips", async () => {
  let seenReq = null;
  const dispatch = createHttpDispatch({
    requestListener: (req, res) => {
      seenReq = {
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        remoteAddress: req.socket?.remoteAddress,
      };
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ hello: "world" }));
    },
  });

  const result = await dispatch(fakeRpc({
    method: "GET",
    path: "/api/state",
    headers: { "x-test": "yo", "Cookie": "viveworker_session=abc" },
  }));

  assert.equal(seenReq.method, "GET");
  assert.equal(seenReq.url, "/api/state");
  // Headers always lowercased (matches Node IncomingMessage convention).
  assert.deepEqual(seenReq.headers, { "x-test": "yo", "cookie": "viveworker_session=abc" });
  assert.match(seenReq.remoteAddress, /^remote-pair:[A-Z0-9-]+$/);

  assert.equal(result.status, 200);
  assert.equal(result.headers["content-type"], "application/json");
  assert.equal(result.body, JSON.stringify({ hello: "world" }));
  assert.equal(result.bodyEncoding, "utf8");
});

// ---------------------------------------------------------------------------
// req.viveworker — relay context injection (Phase 8b)
// ---------------------------------------------------------------------------
//
// The bridge's auth gates (readSession, requireTrustedMutationOrigin) read
// `req.viveworker.fromRelay` to bypass the cookie / Origin checks that
// LAN-HTTPS traffic uses. The auth substitute is the Noise channel binding
// + the pairing record, both of which are surfaced here. If this object
// stops being attached, every relay request will 401 (cookie missing).

test("httpDispatch attaches req.viveworker with fromRelay/pairing/channelBinding", async () => {
  let seenViveworker = null;
  const dispatch = createHttpDispatch({
    requestListener: (req, res) => {
      seenViveworker = req.viveworker;
      res.statusCode = 204;
      res.end();
    },
  });

  // Build the rpc directly so we control the channelBinding bytes — the
  // shared fakeRpc() always returns a fresh zero-filled Uint8Array(32),
  // which is fine for "is it the same reference?" but not for "are the
  // bytes preserved?".
  const cb = new Uint8Array(32);
  for (let i = 0; i < cb.length; i++) cb[i] = i;
  const rpc = { ...fakeRpc(), channelBinding: cb };

  await dispatch(rpc);

  assert.ok(seenViveworker, "expected req.viveworker to be attached");
  assert.equal(seenViveworker.fromRelay, true);
  assert.equal(seenViveworker.pairing?.pairingId, "p-1");
  assert.ok(seenViveworker.channelBinding instanceof Uint8Array, "channelBinding must be Uint8Array");
  assert.equal(seenViveworker.channelBinding.length, 32);
  // Same reference — we don't copy here, the bridge code reads it directly.
  assert.equal(seenViveworker.channelBinding, cb);
  // Spot-check a couple of bytes survived intact.
  assert.equal(seenViveworker.channelBinding[0], 0);
  assert.equal(seenViveworker.channelBinding[31], 31);
});

// ---------------------------------------------------------------------------
// POST — body streaming
// ---------------------------------------------------------------------------

test("POST request: listener reads body via req.on('data'/'end')", async () => {
  const dispatch = createHttpDispatch({
    requestListener: (req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString("utf8"); });
      req.on("end", () => {
        res.setHeader("content-type", "text/plain");
        res.end(`echo:${body}`);
      });
    },
  });

  const result = await dispatch(fakeRpc({
    method: "POST", path: "/api/echo",
    headers: { "content-type": "text/plain" },
    body: "hello world",
  }));

  assert.equal(result.status, 200);
  assert.equal(result.body, "echo:hello world");
});

test("POST with base64 body decodes back to original bytes", async () => {
  const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff, 0x42]);
  const b64 = Buffer.from(original).toString("base64");

  let seenBytes = null;
  const dispatch = createHttpDispatch({
    requestListener: (req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seenBytes = new Uint8Array(Buffer.concat(chunks));
        res.statusCode = 204;
        res.end();
      });
    },
  });

  await dispatch(fakeRpc({
    method: "POST", path: "/api/upload",
    body: b64, bodyEncoding: "base64",
  }));

  assert.deepEqual(seenBytes, original);
});

// ---------------------------------------------------------------------------
// Status / headers
// ---------------------------------------------------------------------------

test("res.writeHead(status, headers) sets both", async () => {
  const dispatch = createHttpDispatch({
    requestListener: (req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain", "X-Foo": "1" });
      res.end("not found");
    },
  });
  const result = await dispatch(fakeRpc());
  assert.equal(result.status, 404);
  assert.equal(result.headers["content-type"], "text/plain");
  assert.equal(result.headers["x-foo"], "1");
  assert.equal(result.body, "not found");
});

test("res header methods (get/has/remove/getHeaders) work as expected", async () => {
  let captured = null;
  const dispatch = createHttpDispatch({
    requestListener: (req, res) => {
      res.setHeader("a", "1");
      res.setHeader("B", "2"); // mixed case
      captured = {
        getA: res.getHeader("a"),
        getBLower: res.getHeader("b"),
        getBUpper: res.getHeader("B"),
        hasA: res.hasHeader("a"),
        hasC: res.hasHeader("c"),
      };
      res.removeHeader("a");
      captured.afterRemove = res.hasHeader("a");
      captured.headers = res.getHeaders();
      res.end();
    },
  });
  await dispatch(fakeRpc());
  assert.equal(captured.getA, "1");
  assert.equal(captured.getBLower, "2");
  assert.equal(captured.getBUpper, "2");
  assert.equal(captured.hasA, true);
  assert.equal(captured.hasC, false);
  assert.equal(captured.afterRemove, false);
  assert.deepEqual(captured.headers, { b: "2" });
});

// ---------------------------------------------------------------------------
// Binary vs text body encoding heuristic
// ---------------------------------------------------------------------------

test("binary content-type → response body is base64", async () => {
  const bin = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
  const dispatch = createHttpDispatch({
    requestListener: (req, res) => {
      res.setHeader("content-type", "image/png");
      res.end(Buffer.from(bin));
    },
  });
  const result = await dispatch(fakeRpc());
  assert.equal(result.bodyEncoding, "base64");
  assert.deepEqual(new Uint8Array(Buffer.from(result.body, "base64")), bin);
});

test("application/json → utf8 (not base64)", async () => {
  const dispatch = createHttpDispatch({
    requestListener: (req, res) => {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end('{"a":1}');
    },
  });
  const result = await dispatch(fakeRpc());
  assert.equal(result.bodyEncoding, "utf8");
  assert.equal(result.body, '{"a":1}');
});

test("invalid UTF-8 with no content-type → falls back to base64", async () => {
  const dispatch = createHttpDispatch({
    requestListener: (req, res) => {
      // No content-type set; bytes are not valid UTF-8.
      res.end(Buffer.from([0xff, 0xfe, 0xfd]));
    },
  });
  const result = await dispatch(fakeRpc());
  assert.equal(result.bodyEncoding, "base64");
});

test("empty response body returns no body field", async () => {
  const dispatch = createHttpDispatch({
    requestListener: (req, res) => {
      res.statusCode = 204;
      res.end();
    },
  });
  const result = await dispatch(fakeRpc());
  assert.equal(result.status, 204);
  assert.equal(result.body, undefined);
  assert.equal(result.bodyEncoding, undefined);
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test("AbortSignal triggers req.destroy() in the listener", async () => {
  let capturedReq = null;
  const ctrl = new AbortController();
  const rpc = { ...fakeRpc(), signal: ctrl.signal };

  const dispatch = createHttpDispatch({
    requestListener: (req, _res) => {
      capturedReq = req;
      // A long-running handler we'll cancel mid-flight.
      return new Promise((_resolve) => {
        // Never call res.end() — we'll cancel and short-circuit the wrapper.
      });
    },
  });

  // Start dispatch, then abort.
  const dispatchPromise = dispatch(rpc);
  // Give the listener a tick to attach itself.
  await Promise.resolve();
  ctrl.abort();
  // The dispatch resolves once _abort() flips _ended on the response.
  const result = await dispatchPromise;

  // After abort the wrapper just unwinds; status defaults to 200 with no
  // body. The BridgeRelayClient won't send this response anyway because
  // signal.aborted=true.
  assert.equal(result.status, 200);
  // `destroyed` is set synchronously by Readable#destroy; the 'close' event
  // fires later but we don't need to await it for this assertion.
  assert.equal(capturedReq.destroyed, true);
});

test("AbortSignal already aborted triggers req.destroy() before listener returns", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const rpc = { ...fakeRpc(), signal: ctrl.signal };

  let sawDestroy = false;
  const dispatch = createHttpDispatch({
    requestListener: (req, res) => {
      // The req should already be destroyed by the time the listener runs.
      sawDestroy = req.destroyed === true;
      res.statusCode = 204;
      res.end();
    },
  });

  await dispatch(rpc);
  assert.equal(sawDestroy, true);
});

// ---------------------------------------------------------------------------
// Listener errors / no-response
// ---------------------------------------------------------------------------

test("listener throws synchronously → dispatch rejects", async () => {
  const dispatch = createHttpDispatch({
    requestListener: () => { throw new Error("boom"); },
  });
  await assert.rejects(() => dispatch(fakeRpc()), /boom/);
});

test("listener returns a rejected promise → dispatch rejects", async () => {
  const dispatch = createHttpDispatch({
    requestListener: async () => { throw new Error("async boom"); },
  });
  await assert.rejects(() => dispatch(fakeRpc()), /async boom/);
});

test("responseTimeoutMs surfaces a 504 when the listener never calls end", async () => {
  const warnings = [];
  const dispatch = createHttpDispatch({
    requestListener: () => {
      // Forgot to call res.end. Without responseTimeoutMs we'd hang forever;
      // with it, we surface a 504.
      return new Promise(() => {});
    },
    responseTimeoutMs: 50,
    logger: { warn: (m) => warnings.push(m) },
  });
  const result = await dispatch(fakeRpc({ path: "/api/buggy" }));
  assert.equal(result.status, 504);
  assert.match(result.body, /bridge-listener-timeout/);
  assert.ok(warnings.some((w) => /buggy/.test(w)), "expected a warn line referencing the path");
});

test("no responseTimeoutMs → request hangs until res.end (we drive it manually)", async () => {
  let resolveEnd;
  const dispatch = createHttpDispatch({
    requestListener: (_req, res) => {
      // Stash res.end so the test can fire it after the listener returns.
      resolveEnd = () => { res.statusCode = 201; res.end("ok"); };
    },
  });
  const promise = dispatch(fakeRpc({ path: "/api/late" }));
  // Listener has returned; donePromise still pending.
  await Promise.resolve();
  resolveEnd();
  const result = await promise;
  assert.equal(result.status, 201);
  assert.equal(result.body, "ok");
});

// ---------------------------------------------------------------------------
// Body fan-out / multiple writes
// ---------------------------------------------------------------------------

test("res.write(...) + res.end() concatenate into one body", async () => {
  const dispatch = createHttpDispatch({
    requestListener: (req, res) => {
      res.setHeader("content-type", "text/plain");
      res.write("hello ");
      res.write("world");
      res.end("!");
    },
  });
  const result = await dispatch(fakeRpc());
  assert.equal(result.body, "hello world!");
});

test("res.end with a Buffer works as well as with a string", async () => {
  const dispatch = createHttpDispatch({
    requestListener: (req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end(Buffer.from("buf-end"));
    },
  });
  const result = await dispatch(fakeRpc());
  assert.equal(result.body, "buf-end");
});

// ---------------------------------------------------------------------------
// classifyRelayPath — defense-in-depth path gate
// ---------------------------------------------------------------------------

test("classifyRelayPath allows ordinary /api/* paths", () => {
  assert.deepEqual(classifyRelayPath("/api/threads/list"), { allowed: true });
  assert.deepEqual(classifyRelayPath("/api/timeline?since=123"), { allowed: true });
  assert.deepEqual(classifyRelayPath("/api/session"), { allowed: true });
});

test("classifyRelayPath rejects non-/api paths", () => {
  for (const path of ["/", "/app", "/sw.js", "/static/foo.js", "/manifest.webmanifest"]) {
    const result = classifyRelayPath(path);
    assert.equal(result.allowed, false, `expected ${path} to be blocked`);
    assert.equal(result.reason, "non-api-path");
  }
});

test("classifyRelayPath rejects sensitive /api endpoints", () => {
  for (const path of [
    "/api/remote-pairing/lan-enroll",
    "/api/remote-pairing/revoke",
    "/api/session/pair",
  ]) {
    const result = classifyRelayPath(path);
    assert.equal(result.allowed, false, `expected ${path} to be blocked`);
    assert.equal(result.reason, "denied-path");
  }
});

test("classifyRelayPath rejects forbidden prefixes inside /api/", () => {
  // Top-level /admin/ etc. are caught earlier by the non-/api guard; what
  // we want this test to lock down is that we don't accidentally let
  // /api/admin/* or /api/internal/* through.
  for (const path of ["/api/admin/x", "/api/internal/y"]) {
    const result = classifyRelayPath(path);
    assert.equal(result.allowed, false, `expected ${path} to be blocked`);
    assert.equal(result.reason, "denied-prefix");
  }
});

test("classifyRelayPath blocks top-level admin/internal/__ paths regardless of reason", () => {
  for (const path of ["/admin/whatever", "/internal/foo", "/__viveworker/x"]) {
    const result = classifyRelayPath(path);
    assert.equal(result.allowed, false, `expected ${path} to be blocked`);
  }
});

test("classifyRelayPath strips query strings before matching", () => {
  // The deny entries are exact pathname matches, so query strings shouldn't
  // matter — and shouldn't accidentally allow a denied path through.
  assert.equal(
    classifyRelayPath("/api/remote-pairing/lan-enroll?bypass=1").allowed,
    false,
  );
});

test("dispatch returns 403 for denied paths without invoking the listener", async () => {
  let listenerCalled = false;
  const dispatch = createHttpDispatch({
    requestListener: () => { listenerCalled = true; },
  });
  const result = await dispatch(fakeRpc({
    method: "POST",
    path: "/api/remote-pairing/lan-enroll",
    headers: { "content-type": "application/json" },
    body: "{}",
  }));
  assert.equal(listenerCalled, false);
  assert.equal(result.status, 403);
  const json = JSON.parse(result.body);
  assert.equal(json.error, "path-not-allowed-via-relay");
});

test("dispatch returns 403 for non-/api paths", async () => {
  const dispatch = createHttpDispatch({
    requestListener: () => {
      throw new Error("listener should not run");
    },
  });
  const result = await dispatch(fakeRpc({ method: "GET", path: "/sw.js" }));
  assert.equal(result.status, 403);
});
