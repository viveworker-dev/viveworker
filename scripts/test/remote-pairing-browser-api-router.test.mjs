/**
 * remote-pairing-browser-api-router.test.mjs — Unit tests for
 * web/remote-pairing/api-router.js.
 *
 * Validates the LAN-first / probe-on-failure / sticky-relay router that
 * decides between same-origin `fetch()` and `RemotePairingRpcClient.fetch()`
 * for each PWA HTTP call. All external dependencies (RpcClient, fetch,
 * loadPairingState, ensureIdentityKeypair, bindWakeEvents) are injected so
 * the tests run on Node without a browser, IndexedDB, or a real WebSocket.
 *
 * Run:
 *   node --test scripts/test/remote-pairing-browser-api-router.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  routedFetch,
  __getTelemetry,
  __resetForTest,
  __STICKY_RELAY_MS,
} from "../../web/remote-pairing/api-router.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Build a stand-in for `RemotePairingRpcClient`. The test passes a
 * factory function via `opts.RemotePairingRpcClient` and an options bag
 * controls handler behavior.
 *
 *   - `fetchImpl`: function (req) → Promise<RpcResponse> | throws.
 *   - `connectImpl`: function () → Promise<void>; default resolves.
 *
 * Records `connect()` / `close()` / `fetch()` invocations on the
 * returned class for assertion.
 */
function makeFakeRpcClientCtor({
  fetchImpl = async (req) => makeRpcResponse({ status: 200, body: JSON.stringify({ ok: true, echo: req }) }),
  connectImpl = async () => {},
} = {}) {
  const calls = {
    constructed: 0,
    connect: 0,
    close: 0,
    fetch: [],   // array of req objects
    lastInstance: null,
  };

  class FakeRpc {
    constructor(opts) {
      calls.constructed++;
      calls.lastInstance = this;
      this.opts = opts;
      this._closed = false;
    }
    connect() {
      calls.connect++;
      return Promise.resolve(connectImpl());
    }
    close() {
      calls.close++;
      this._closed = true;
    }
    kick() { /* no-op for these tests */ }
    fetch(req) {
      if (this._closed) {
        return Promise.reject(new Error("client closed"));
      }
      calls.fetch.push(req);
      return Promise.resolve(fetchImpl(req));
    }
  }

  return { FakeRpc, calls };
}

/** Build a synthetic RpcResponse with helpers, mirroring rpc-client's output. */
function makeRpcResponse({ status = 200, body = "", headers = {}, bodyEncoding = "utf8" } = {}) {
  return {
    status,
    headers,
    bodyRaw: body,
    bodyEncoding,
    text: () => body,
    json: () => JSON.parse(body),
    bytes: () => new TextEncoder().encode(body),
    arrayBuffer: () => new TextEncoder().encode(body).buffer,
  };
}

/**
 * Build a stub `loadPairingState` that returns a fixed record (or null).
 * Convenience for tests that want a pre-paired phone.
 */
function makeLoadPairingState(record = makePairingRecord()) {
  return () => record;
}

function makePairingRecord(overrides = {}) {
  return {
    version: 2,
    pairingId: "pair-aaaa-bbbb",
    relayToken: "v1.testtesttesttesttesttesttesttest.abc",
    phonePub: "aa".repeat(32),
    phoneFingerprint: "PHONE-FP",
    bridgePubHex: "bb".repeat(32),
    bridgeFingerprint: "BRIDG-FP",
    relayUrl: "wss://relay.test",
    label: "test phone",
    addedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

/** Fake identity keypair — content doesn't matter for these tests. */
async function fakeEnsureIdentityKeypair() {
  return {
    priv: new Uint8Array(32).fill(1),
    pub: new Uint8Array(32).fill(2),
    createdAtMs: 0,
  };
}

/** No-op bindWakeEvents that records calls and returns an unbind. */
function makeFakeBindWakeEvents() {
  const calls = { bound: 0, unbound: 0 };
  function fakeBind(transport, _opts) {
    calls.bound++;
    return () => { calls.unbound++; };
  }
  return { fakeBind, calls };
}

/** Build a fetch stub controlled by a queue of behaviors. */
function makeFakeFetch(behaviors) {
  // behaviors: array of { mode, ... }
  //   { mode: "ok", status, body }       — returns a Response-like
  //   { mode: "throw", err }              — throws err on call
  //   { mode: "abort" }                   — throws AbortError
  //   { mode: "hang" }                    — waits until init.signal aborts
  //   { mode: "hang-ignore-abort" }       — never settles, even after abort
  let i = 0;
  const calls = [];
  async function fakeFetch(url, init) {
    calls.push({ url, init });
    const beh = behaviors[Math.min(i, behaviors.length - 1)];
    i++;
    if (beh.mode === "throw") throw beh.err;
    if (beh.mode === "abort") {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    if (beh.mode === "hang") {
      return await new Promise((resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        }, { once: true });
      });
    }
    if (beh.mode === "hang-ignore-abort") {
      return await new Promise(() => {});
    }
    const status = beh.status ?? 200;
    const body = beh.body ?? "{}";
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: beh.statusText ?? "",
      headers: beh.headers ?? {},
      json: async () => JSON.parse(body),
      text: async () => body,
    };
  }
  return { fakeFetch, calls };
}

/** Mock clock — tests advance `t` between calls. */
function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (next) => { t = next; },
  };
}

/** Build a typical `opts` bag for the router under test. */
function makeOpts(overrides = {}) {
  const clock = overrides.clock ?? makeClock();
  const { fakeFetch, calls: fetchCalls } = overrides.fetchPair ?? makeFakeFetch([{ mode: "ok" }]);
  const { FakeRpc, calls: rpcCalls } = overrides.rpcPair ?? makeFakeRpcClientCtor();
  const { fakeBind, calls: wakeCalls } = overrides.wakePair ?? makeFakeBindWakeEvents();
  const loadPairingState = overrides.loadPairingState ?? makeLoadPairingState();
  const inspectPairingState = overrides.inspectPairingState ?? (() => {
    const record = loadPairingState();
    return record
      ? { status: "ready", needsEnrollment: false, record }
      : { status: "missing", needsEnrollment: true, record: null };
  });
  return {
    opts: {
      fetch: fakeFetch,
      now: clock.now,
      RemotePairingRpcClient: FakeRpc,
      ensureIdentityKeypair: fakeEnsureIdentityKeypair,
      bindWakeEvents: fakeBind,
      loadPairingState,
      inspectPairingState,
      logger: { warn() {}, debug() {}, error() {} },
    },
    clock,
    fetchCalls,
    rpcCalls,
    wakeCalls,
  };
}

// Reset module state before every test — the router is intentionally a
// singleton, and the test file shares one module instance.
test.beforeEach(() => {
  __resetForTest();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("LAN happy path: returns response, no relay involvement", async () => {
  const { opts, fetchCalls, rpcCalls } = makeOpts({
    fetchPair: makeFakeFetch([{ mode: "ok", status: 200, body: '{"hello":"world"}' }]),
  });
  const res = await routedFetch("/api/foo", { method: "GET" }, opts);
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { hello: "world" });
  assert.equal(fetchCalls.length, 1);
  assert.equal(rpcCalls.constructed, 0);
});

test("LAN HTTP 4xx is NOT treated as a transport failure", async () => {
  // 404 is a successful round-trip from the router's perspective. The
  // caller checks response.ok like with native fetch.
  const { opts, fetchCalls, rpcCalls } = makeOpts({
    fetchPair: makeFakeFetch([{ mode: "ok", status: 404, body: '{"error":"not-found"}' }]),
  });
  const res = await routedFetch("/api/missing", {}, opts);
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
  assert.equal(fetchCalls.length, 1);
  assert.equal(rpcCalls.constructed, 0);
  // Sticky-relay was NOT triggered.
  const tel = __getTelemetry();
  assert.equal(tel.lanFail, 0);
  assert.equal(tel.stickyRelayUntilMs, 0);
});

// ---------------------------------------------------------------------------
// Probe-on-failure
// ---------------------------------------------------------------------------

test("LAN TypeError → falls back to relay successfully", async () => {
  const tErr = new TypeError("Failed to fetch");
  const { opts, fetchCalls, rpcCalls } = makeOpts({
    fetchPair: makeFakeFetch([{ mode: "throw", err: tErr }]),
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async () => makeRpcResponse({ status: 200, body: '{"via":"relay"}' }),
    }),
  });
  const res = await routedFetch("/api/foo", {}, opts);
  assert.equal(res.ok, true);
  assert.deepEqual(await res.json(), { via: "relay" });
  assert.equal(fetchCalls.length, 1);
  assert.equal(rpcCalls.constructed, 1);
  assert.equal(rpcCalls.connect, 1);
  assert.equal(rpcCalls.fetch.length, 1);
  // The relay fetch carried the path correctly.
  assert.equal(rpcCalls.fetch[0].path, "/api/foo");
});

test("LAN hang times out → falls back to relay successfully", async () => {
  const { opts, fetchCalls, rpcCalls } = makeOpts({
    fetchPair: makeFakeFetch([{ mode: "hang" }]),
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async () => makeRpcResponse({ status: 200, body: '{"via":"relay-after-timeout"}' }),
    }),
  });
  const res = await routedFetch("/api/bootstrap", {}, { ...opts, lanTimeoutMs: 10 });
  assert.equal(res.ok, true);
  assert.deepEqual(await res.json(), { via: "relay-after-timeout" });
  assert.equal(fetchCalls.length, 1);
  assert.equal(rpcCalls.constructed, 1);
  assert.equal(rpcCalls.fetch.length, 1);
  assert.equal(rpcCalls.fetch[0].path, "/api/bootstrap");
  assert.equal(__getTelemetry().lanFail, 1);
});

test("LAN fetch that ignores AbortController still hard-times out", async () => {
  const { opts, fetchCalls, rpcCalls } = makeOpts({
    fetchPair: makeFakeFetch([{ mode: "hang-ignore-abort" }]),
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async () => makeRpcResponse({ status: 200, body: '{"via":"hard-timeout-relay"}' }),
    }),
  });
  const res = await routedFetch("/api/bootstrap", {}, { ...opts, lanTimeoutMs: 10 });
  assert.equal(res.ok, true);
  assert.deepEqual(await res.json(), { via: "hard-timeout-relay" });
  assert.equal(fetchCalls.length, 1);
  assert.equal(rpcCalls.constructed, 1);
  assert.equal(rpcCalls.fetch.length, 1);
  assert.equal(rpcCalls.fetch[0].path, "/api/bootstrap");
  assert.equal(__getTelemetry().lanFail, 1);
});

test("relay transport failure resets client and retries once", async () => {
  let relayAttempts = 0;
  const { opts, rpcCalls } = makeOpts({
    fetchPair: makeFakeFetch([{ mode: "throw", err: new TypeError("Failed to fetch") }]),
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async () => {
        relayAttempts++;
        if (relayAttempts === 1) {
          const err = new Error("stale noise session");
          err.name = "RpcTransportFailedError";
          throw err;
        }
        return makeRpcResponse({ status: 200, body: '{"via":"fresh-relay"}' });
      },
    }),
  });

  const res = await routedFetch("/api/bootstrap", {}, opts);
  assert.equal(res.ok, true);
  assert.deepEqual(await res.json(), { via: "fresh-relay" });
  assert.equal(rpcCalls.constructed, 2);
  assert.equal(rpcCalls.close, 1);
  assert.equal(rpcCalls.fetch.length, 2);
  assert.equal(__getTelemetry().clientResets, 1);
  assert.equal(__getTelemetry().relayFail, 0);
});

test("both LAN and relay fail → throws the LAN error", async () => {
  const lanErr = new TypeError("Failed to fetch");
  const { opts } = makeOpts({
    fetchPair: makeFakeFetch([{ mode: "throw", err: lanErr }]),
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async () => { throw new Error("relay 503"); },
    }),
  });
  await assert.rejects(routedFetch("/api/foo", {}, opts), (err) => err === lanErr);
});

test("AbortError on LAN re-throws immediately, no relay attempt", async () => {
  const { opts, rpcCalls } = makeOpts({
    fetchPair: makeFakeFetch([{ mode: "abort" }]),
  });
  await assert.rejects(routedFetch("/api/foo", {}, opts), (err) => err.name === "AbortError");
  assert.equal(rpcCalls.constructed, 0);
});

test("AbortError on relay re-throws (after LAN already failed)", async () => {
  const { opts, rpcCalls } = makeOpts({
    fetchPair: makeFakeFetch([{ mode: "throw", err: new TypeError("Failed to fetch") }]),
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    }),
  });
  await assert.rejects(routedFetch("/api/foo", {}, opts), (err) => err.name === "AbortError");
  assert.equal(rpcCalls.fetch.length, 1);
});

// ---------------------------------------------------------------------------
// Sticky-relay window
// ---------------------------------------------------------------------------

test("after LAN fails, next call skips LAN entirely (sticky relay)", async () => {
  const fetchPair = makeFakeFetch([
    { mode: "throw", err: new TypeError("Failed to fetch") },
    // Second call SHOULD NOT happen — assert by counting.
    { mode: "ok", body: '{"shouldnt":"be-hit"}' },
  ]);
  const { opts, fetchCalls, rpcCalls, clock } = makeOpts({
    fetchPair,
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async (req) => makeRpcResponse({
        status: 200,
        body: JSON.stringify({ via: "relay", path: req.path }),
      }),
    }),
  });

  // First call: LAN fails, relay succeeds.
  await routedFetch("/api/first", {}, opts);
  assert.equal(fetchCalls.length, 1);
  assert.equal(rpcCalls.fetch.length, 1);

  // Within the sticky window, we should NOT touch LAN again.
  clock.advance(STICKY_HALF_MS);
  await routedFetch("/api/second", {}, opts);
  assert.equal(fetchCalls.length, 1, "LAN should not be retried inside sticky window");
  assert.equal(rpcCalls.fetch.length, 2);
  assert.equal(rpcCalls.fetch[1].path, "/api/second");
});

const STICKY_HALF_MS = Math.floor(__STICKY_RELAY_MS / 2);

test("after sticky window expires, LAN is re-probed", async () => {
  const fetchPair = makeFakeFetch([
    { mode: "throw", err: new TypeError("Failed to fetch") },
    // Second LAN call (after window expiry) succeeds.
    { mode: "ok", status: 200, body: '{"recovered":"lan"}' },
  ]);
  const { opts, fetchCalls, rpcCalls, clock } = makeOpts({
    fetchPair,
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async () => makeRpcResponse({ status: 200, body: '{"via":"relay"}' }),
    }),
  });

  await routedFetch("/api/first", {}, opts);
  assert.equal(fetchCalls.length, 1);
  assert.equal(rpcCalls.fetch.length, 1);

  // Past the window — LAN should be probed again.
  clock.advance(__STICKY_RELAY_MS + 1);
  const res = await routedFetch("/api/second", {}, opts);
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(await res.json(), { recovered: "lan" });
});

test("inside sticky window, if relay also fails, LAN is tried as a tiebreaker", async () => {
  // After LAN failed once, sticky window is set. On the next call we hit
  // relay first; if relay errors, the router should clear sticky and try
  // LAN as a last attempt.
  const fetchPair = makeFakeFetch([
    { mode: "throw", err: new TypeError("Failed to fetch") },  // first call: LAN dies
    { mode: "ok", body: '{"tiebreaker":"lan"}' },              // second call: LAN comes back
  ]);
  let relayCallCount = 0;
  const { opts, fetchCalls, rpcCalls, clock } = makeOpts({
    fetchPair,
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async () => {
        relayCallCount++;
        if (relayCallCount === 1) {
          // First relay call (during 1st routedFetch) succeeds so we exit the
          // 1st call cleanly with sticky-relay set.
          return makeRpcResponse({ status: 200, body: '{"first":"relay"}' });
        }
        throw new Error("relay flaky");
      },
    }),
  });

  await routedFetch("/api/first", {}, opts);
  assert.equal(fetchCalls.length, 1);

  clock.advance(STICKY_HALF_MS);
  const res = await routedFetch("/api/second", {}, opts);
  // Order: relay (fail) → LAN (succeed)
  assert.equal(rpcCalls.fetch.length, 2);
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(await res.json(), { tiebreaker: "lan" });
});

// ---------------------------------------------------------------------------
// Singleton lifecycle
// ---------------------------------------------------------------------------

test("RpcClient is constructed once across multiple relay fetches", async () => {
  const fetchPair = makeFakeFetch([
    { mode: "throw", err: new TypeError("nope") },
    { mode: "throw", err: new TypeError("nope") },
    { mode: "throw", err: new TypeError("nope") },
  ]);
  const { opts, rpcCalls } = makeOpts({
    fetchPair,
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async () => makeRpcResponse({ status: 200, body: "{}" }),
    }),
  });

  await routedFetch("/api/a", {}, opts);
  await routedFetch("/api/b", {}, opts);
  await routedFetch("/api/c", {}, opts);

  assert.equal(rpcCalls.constructed, 1);
  assert.equal(rpcCalls.connect, 1);
  assert.equal(rpcCalls.fetch.length, 3);
});

test("re-pair (new pairingId) tears down the old client and builds a new one", async () => {
  // Same identity keypair, different bridge → fresh handshake required.
  let activeRecord = makePairingRecord({ pairingId: "pair-original" });
  const fetchPair = makeFakeFetch([
    { mode: "throw", err: new TypeError("nope") },
    { mode: "throw", err: new TypeError("nope") },
  ]);
  const { opts, rpcCalls } = makeOpts({
    fetchPair,
    loadPairingState: () => activeRecord,
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async () => makeRpcResponse({ status: 200, body: "{}" }),
    }),
  });

  await routedFetch("/api/a", {}, opts);
  assert.equal(rpcCalls.constructed, 1);

  // Re-pair under a different bridge.
  activeRecord = makePairingRecord({ pairingId: "pair-new" });

  // Sticky relay window already set — the next call goes straight to relay.
  await routedFetch("/api/b", {}, opts);
  assert.equal(rpcCalls.constructed, 2, "expected RpcClient rebuild on pairingId change");
  assert.equal(rpcCalls.close, 1, "old client should have been closed exactly once");
});

test("unpair (record removed) closes the live client and refuses to relay", async () => {
  let activeRecord = makePairingRecord();
  const fetchPair = makeFakeFetch([
    { mode: "throw", err: new TypeError("nope") },
    { mode: "throw", err: new TypeError("nope") },
  ]);
  const { opts, rpcCalls } = makeOpts({
    fetchPair,
    loadPairingState: () => activeRecord,
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async () => makeRpcResponse({ status: 200, body: "{}" }),
    }),
  });

  await routedFetch("/api/a", {}, opts);
  assert.equal(rpcCalls.constructed, 1);

  activeRecord = null;  // user unpaired
  // Both LAN and relay fail, but the relay failure is actionable: refresh
  // remote pairing on LAN so a v2 relay token can be stored.
  await assert.rejects(
    routedFetch("/api/b", {}, opts),
    (err) => err?.code === "remote-pairing-enrollment-required" && err?.reason === "missing",
  );
  assert.equal(rpcCalls.close, 1, "client should be closed once on unpair");
});

test("missing relay state throws an enrollment refresh error when off-LAN", async () => {
  const { opts, rpcCalls } = makeOpts({
    fetchPair: makeFakeFetch([{ mode: "throw", err: new TypeError("Failed to fetch") }]),
    loadPairingState: () => null,
    inspectPairingState: () => ({ status: "legacy-v1", needsEnrollment: true, record: null }),
  });

  await assert.rejects(
    routedFetch("/api/bootstrap", {}, opts),
    (err) =>
      err?.name === "RemotePairingEnrollmentRequiredError" &&
      err?.code === "remote-pairing-enrollment-required" &&
      err?.reason === "legacy-v1",
  );
  assert.equal(rpcCalls.constructed, 0);
});

test("bindWakeEvents is called once at client construction time", async () => {
  const { opts, wakeCalls, rpcCalls } = makeOpts({
    fetchPair: makeFakeFetch([
      { mode: "throw", err: new TypeError("nope") },
      { mode: "throw", err: new TypeError("nope") },
    ]),
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async () => makeRpcResponse({ status: 200, body: "{}" }),
    }),
  });
  await routedFetch("/api/a", {}, opts);
  await routedFetch("/api/b", {}, opts);
  assert.equal(wakeCalls.bound, 1);
  assert.equal(rpcCalls.constructed, 1);
});

// ---------------------------------------------------------------------------
// Body shape gate
// ---------------------------------------------------------------------------

test("FormData body is serialized as multipart on the relay path", async () => {
  // Force the relay path by failing LAN.
  const fetchPair = makeFakeFetch([{ mode: "throw", err: new TypeError("nope") }]);
  let capturedReq = null;
  const { opts } = makeOpts({
    fetchPair,
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async (req) => {
        capturedReq = req;
        return makeRpcResponse({ status: 200, body: "{}" });
      },
    }),
  });
  // FormData isn't built into Node before v18+, but globalThis.FormData
  // exists on modern Node. Skip this test if it isn't available.
  if (typeof FormData === "undefined" || typeof Blob === "undefined") return;
  const fd = new FormData();
  fd.append("text", "hello");
  fd.append("file", new Blob(["file-data"], { type: "text/plain" }), "note.txt");
  const res = await routedFetch("/api/upload", { method: "POST", body: fd }, opts);
  assert.equal(res.status, 200);
  assert.ok(capturedReq, "relay request should be sent");
  assert.equal(capturedReq.method, "POST");
  assert.match(capturedReq.headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.ok(capturedReq.body instanceof Uint8Array);
  assert.equal(capturedReq.headers["content-length"], String(capturedReq.body.byteLength));

  const multipart = new TextDecoder().decode(capturedReq.body);
  const boundary = capturedReq.headers["content-type"].match(/boundary=(.+)$/)?.[1];
  assert.ok(boundary);
  assert.match(multipart, new RegExp(`--${boundary}`));
  assert.match(multipart, /Content-Disposition: form-data; name="text"/);
  assert.match(multipart, /hello/);
  assert.match(multipart, /Content-Disposition: form-data; name="file"; filename="note\.txt"/);
  assert.match(multipart, /Content-Type: text\/plain/);
  assert.match(multipart, /file-data/);
  assert.ok(multipart.endsWith(`--${boundary}--\r\n`));
});

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

test("telemetry counts LAN successes and relay successes", async () => {
  const fetchPair = makeFakeFetch([
    { mode: "ok", body: "{}" },
    { mode: "throw", err: new TypeError("nope") },
  ]);
  const { opts } = makeOpts({
    fetchPair,
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async () => makeRpcResponse({ status: 200, body: "{}" }),
    }),
  });
  await routedFetch("/api/a", {}, opts);
  await routedFetch("/api/b", {}, opts);

  const tel = __getTelemetry();
  assert.equal(tel.lanOk, 1);
  assert.equal(tel.lanFail, 1);
  assert.equal(tel.relayOk, 1);
  assert.equal(tel.relayFail, 0);
  assert.ok(tel.stickyRelayUntilMs > 0);
  assert.equal(tel.hasClient, true);
});

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

test("relay path strips origin from absolute URLs", async () => {
  const fetchPair = makeFakeFetch([
    { mode: "throw", err: new TypeError("nope") },
  ]);
  const { opts, rpcCalls } = makeOpts({
    fetchPair,
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async () => makeRpcResponse({ status: 200, body: "{}" }),
    }),
  });
  await routedFetch("https://localhost:8810/api/items?id=42", {}, opts);
  assert.equal(rpcCalls.fetch[0].path, "/api/items?id=42");
});

test("relay path preserves query string", async () => {
  const fetchPair = makeFakeFetch([{ mode: "throw", err: new TypeError("nope") }]);
  const { opts, rpcCalls } = makeOpts({
    fetchPair,
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async () => makeRpcResponse({ status: 200, body: "{}" }),
    }),
  });
  await routedFetch("/api/inbox?since=12345&limit=10", {}, opts);
  assert.equal(rpcCalls.fetch[0].path, "/api/inbox?since=12345&limit=10");
});

// ---------------------------------------------------------------------------
// Method default
// ---------------------------------------------------------------------------

test("defaults method to GET when init.method is omitted (relay path)", async () => {
  const fetchPair = makeFakeFetch([{ mode: "throw", err: new TypeError("nope") }]);
  const { opts, rpcCalls } = makeOpts({
    fetchPair,
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async () => makeRpcResponse({ status: 200, body: "{}" }),
    }),
  });
  await routedFetch("/api/foo", {}, opts);
  assert.equal(rpcCalls.fetch[0].method, "GET");
});

test("uppercases method on relay path", async () => {
  const fetchPair = makeFakeFetch([{ mode: "throw", err: new TypeError("nope") }]);
  const { opts, rpcCalls } = makeOpts({
    fetchPair,
    rpcPair: makeFakeRpcClientCtor({
      fetchImpl: async () => makeRpcResponse({ status: 200, body: "{}" }),
    }),
  });
  await routedFetch("/api/foo", { method: "post" }, opts);
  assert.equal(rpcCalls.fetch[0].method, "POST");
});
