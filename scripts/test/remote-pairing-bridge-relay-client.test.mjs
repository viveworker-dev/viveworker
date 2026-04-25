/**
 * remote-pairing-bridge-relay-client.test.mjs — Phase 3d tests for the
 * bridge-relay-client.mjs glue.
 *
 * Two layers of coverage:
 *   - Unit tests with a stub `WebSocketImpl` that never opens. These
 *     exercise BridgeRelayClient's session bookkeeping (start, reload,
 *     close, getSessions) without touching the network or the relay.
 *   - End-to-end tests against a `wrangler dev` instance of the relay,
 *     wiring a real BridgeRelayClient to a real RemotePairingTransport
 *     phone-side. These verify the RPC roundtrip, broadcast, cancel,
 *     and allowlist-reject paths.
 *
 * Run:
 *   node --test scripts/test/remote-pairing-bridge-relay-client.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import WebSocket from "ws";

import {
  BridgeRelayClient,
  MAX_INFLIGHT_PER_SESSION,
} from "../lib/remote-pairing/bridge-relay-client.mjs";
import { RemotePairingTransport, STATE } from "../../web/remote-pairing/transport.js";
import { generateIdentityKeypair, bytesToHex } from "../lib/remote-pairing/keys-core.mjs";
import { buildPairing } from "../lib/remote-pairing/pairings.mjs";
import {
  RPC,
  encodeRequest,
  encodeCancel,
  decode as decodeRpc,
} from "../lib/remote-pairing/rpc.mjs";

// ===========================================================================
// Stub WebSocket — for unit tests. Records events but never fires `open`.
// ===========================================================================

/**
 * Minimal WS-shaped object that satisfies the transport's expectations
 * without ever connecting. Tracks how many were created so reconcile()
 * tests can assert that new sessions actually attempt new sockets.
 */
function makeStubWebSocketImpl() {
  const created = [];
  class StubWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0; // CONNECTING
      /** @type {Record<string, Function[]>} */
      this._listeners = {};
      this.binaryType = "blob";
      created.push(this);
    }
    addEventListener(type, fn) {
      (this._listeners[type] ??= []).push(fn);
    }
    removeEventListener(type, fn) {
      const arr = this._listeners[type] ?? [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }
    send(_bytes) {
      throw new Error("StubWebSocket.send: not open");
    }
    close(code = 1000, reason = "") {
      this.readyState = 3; // CLOSED
      for (const fn of this._listeners.close ?? []) fn({ code, reason });
    }
    terminate() {
      this.close(1006, "terminated");
    }
  }
  StubWebSocket.created = created;
  return StubWebSocket;
}

// ===========================================================================
// Unit tests — BridgeRelayClient bookkeeping
// ===========================================================================

test("constructor rejects missing relayUrl / identityKeypair / dispatch", () => {
  const kp = generateIdentityKeypair();
  assert.throws(
    () => new BridgeRelayClient({ identityKeypair: kp, dispatch: () => {} }),
    /relayUrl required/,
  );
  assert.throws(
    () => new BridgeRelayClient({ relayUrl: "wss://x", dispatch: () => {} }),
    /identityKeypair/,
  );
  assert.throws(
    () => new BridgeRelayClient({ relayUrl: "wss://x", identityKeypair: kp }),
    /dispatch/,
  );
});

test("start() with no pairings produces no sessions", async () => {
  const Stub = makeStubWebSocketImpl();
  const client = new BridgeRelayClient({
    relayUrl: "wss://example",
    identityKeypair: generateIdentityKeypair(),
    pairings: [],
    dispatch: async () => ({ status: 204 }),
    WebSocketImpl: Stub,
  });
  await client.start();
  assert.deepEqual(client.getSessions(), []);
  assert.equal(Stub.created.length, 0);
  client.close();
});

test("start() with N pairings opens N sessions", async () => {
  const Stub = makeStubWebSocketImpl();
  const pairings = [
    buildPairing({ pairingId: "p-1", phonePub: generateIdentityKeypair().pub, label: "A" }),
    buildPairing({ pairingId: "p-2", phonePub: generateIdentityKeypair().pub, label: "B" }),
    buildPairing({ pairingId: "p-3", phonePub: generateIdentityKeypair().pub, label: "C" }),
  ];
  const client = new BridgeRelayClient({
    relayUrl: "wss://example",
    identityKeypair: generateIdentityKeypair(),
    pairings,
    dispatch: async () => ({ status: 204 }),
    WebSocketImpl: Stub,
  });
  await client.start();

  const sessions = client.getSessions();
  assert.equal(sessions.length, 3);
  assert.deepEqual(sessions.map((s) => s.pairingId).sort(), ["p-1", "p-2", "p-3"]);
  // Each session opens exactly one WS (still in OPENING — never fired `open`).
  assert.equal(Stub.created.length, 3);
  for (const s of sessions) {
    assert.equal(s.state, STATE.OPENING);
    assert.equal(s.lastSeenAtMs, null);
    assert.equal(s.channelBindingHex, null);
  }
  client.close();
});

test("start() is idempotent", async () => {
  const Stub = makeStubWebSocketImpl();
  const client = new BridgeRelayClient({
    relayUrl: "wss://example",
    identityKeypair: generateIdentityKeypair(),
    pairings: [
      buildPairing({ pairingId: "p-only", phonePub: generateIdentityKeypair().pub }),
    ],
    dispatch: async () => ({ status: 204 }),
    WebSocketImpl: Stub,
  });
  await client.start();
  await client.start(); // no-op
  assert.equal(Stub.created.length, 1, "second start() should not re-open WS");
  client.close();
});

test("close() tears down all sessions and is idempotent", async () => {
  const Stub = makeStubWebSocketImpl();
  const client = new BridgeRelayClient({
    relayUrl: "wss://example",
    identityKeypair: generateIdentityKeypair(),
    pairings: [
      buildPairing({ pairingId: "p-1", phonePub: generateIdentityKeypair().pub }),
      buildPairing({ pairingId: "p-2", phonePub: generateIdentityKeypair().pub }),
    ],
    dispatch: async () => ({ status: 204 }),
    WebSocketImpl: Stub,
  });
  await client.start();

  client.close();
  // Each underlying WS got close(1000, ...).
  for (const ws of Stub.created) {
    assert.equal(ws.readyState, 3, "WS should be CLOSED");
  }
  assert.deepEqual(client.getSessions(), []);
  client.close(); // idempotent
});

test("reload() adds new pairings and tears down removed ones", async () => {
  const Stub = makeStubWebSocketImpl();
  const phoneAKp = generateIdentityKeypair();
  const phoneBKp = generateIdentityKeypair();
  const phoneCKp = generateIdentityKeypair();

  const initial = [
    buildPairing({ pairingId: "p-A", phonePub: phoneAKp.pub, label: "A" }),
    buildPairing({ pairingId: "p-B", phonePub: phoneBKp.pub, label: "B" }),
  ];

  const client = new BridgeRelayClient({
    relayUrl: "wss://example",
    identityKeypair: generateIdentityKeypair(),
    pairings: initial,
    dispatch: async () => ({ status: 204 }),
    WebSocketImpl: Stub,
  });
  await client.start();
  assert.equal(Stub.created.length, 2);

  // Reload to a list with B removed and C added — but we have to swap the
  // file path for `reload` to read; the unit harness uses `pairings:` only on
  // construction. Instead, exercise reconciliation directly via the
  // private _reconcile to keep the test hermetic.
  client._reconcile([
    initial[0], // keep A
    buildPairing({ pairingId: "p-C", phonePub: phoneCKp.pub, label: "C" }), // add C
  ]);

  const ids = client.getSessions().map((s) => s.pairingId).sort();
  assert.deepEqual(ids, ["p-A", "p-C"]);
  // One additional WS created (for C). B's WS is closed.
  assert.equal(Stub.created.length, 3);
  client.close();
});

test("reload() rotates a pairingId whose pubkey changed", async () => {
  const Stub = makeStubWebSocketImpl();
  const oldPhoneKp = generateIdentityKeypair();
  const newPhoneKp = generateIdentityKeypair();

  const client = new BridgeRelayClient({
    relayUrl: "wss://example",
    identityKeypair: generateIdentityKeypair(),
    pairings: [buildPairing({ pairingId: "p-1", phonePub: oldPhoneKp.pub })],
    dispatch: async () => ({ status: 204 }),
    WebSocketImpl: Stub,
  });
  await client.start();
  const wsBefore = Stub.created[0];

  client._reconcile([
    buildPairing({ pairingId: "p-1", phonePub: newPhoneKp.pub }),
  ]);

  // The session for p-1 must have been torn down + replaced because the pub
  // changed (treat as a different identity even though the slot id matches).
  assert.equal(wsBefore.readyState, 3, "stale WS should be CLOSED");
  assert.equal(Stub.created.length, 2, "new session should open a new WS");
  assert.equal(client.getSessions().length, 1);
  client.close();
});

test("getSessions() snapshot has the documented shape", async () => {
  const Stub = makeStubWebSocketImpl();
  const phoneKp = generateIdentityKeypair();
  const client = new BridgeRelayClient({
    relayUrl: "wss://example",
    identityKeypair: generateIdentityKeypair(),
    pairings: [
      buildPairing({ pairingId: "p-1", phonePub: phoneKp.pub, label: "Some phone" }),
    ],
    dispatch: async () => ({ status: 204 }),
    WebSocketImpl: Stub,
  });
  await client.start();
  const [snap] = client.getSessions();
  assert.equal(snap.pairingId, "p-1");
  assert.equal(snap.label, "Some phone");
  assert.equal(typeof snap.state, "string");
  assert.equal(snap.lastSeenAtMs, null);
  assert.equal(snap.channelBindingHex, null);
  assert.match(snap.phoneFingerprint, /^[A-Z0-9-]+$/);
  client.close();
});

// ===========================================================================
// E2E tests — real wrangler dev relay
// ===========================================================================

const DEV_PORT = 8804;
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = resolve(HERE, "../../worker-pairing");
const RELAY_URL = `ws://127.0.0.1:${DEV_PORT}`;

/** @type {ReturnType<typeof spawn> | null} */
let wranglerProc = null;

test.before(async () => {
  wranglerProc = spawn(
    "npx",
    ["--no-install", "wrangler", "dev", "--local", "--port", String(DEV_PORT)],
    {
      cwd: WORKER_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_LOG: "warn" },
    },
  );
  wranglerProc.stdout.on("data", () => {});
  wranglerProc.stderr.on("data", () => {});

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEV_PORT}/healthz`);
      if (res.ok) return;
    } catch { /* not ready */ }
    await sleep(500);
  }
  wranglerProc.kill();
  throw new Error("wrangler dev failed to start within 60s");
});

test.after(async () => {
  if (wranglerProc && wranglerProc.exitCode == null) {
    wranglerProc.kill("SIGTERM");
    await sleep(250);
  }
});

// ---------------------------------------------------------------------------
// Helpers — set up a paired bridge + phone end to end
// ---------------------------------------------------------------------------

function uniquePairingId(label) {
  return `brc-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * @param {{
 *   label: string,
 *   dispatch?: import("../lib/remote-pairing/bridge-relay-client.mjs").DispatchFn,
 *   onSessionState?: Function,
 *   pairings?: Array<{ pairingId: string, phonePub: Uint8Array, label?: string }>,
 *   bridgeKeypair?: { priv: Uint8Array, pub: Uint8Array },
 * }} cfg
 */
async function spawnBridgeAndPhone(cfg) {
  const bridgeKeypair = cfg.bridgeKeypair ?? generateIdentityKeypair();
  const phoneKeypair = generateIdentityKeypair();
  const pairingId = uniquePairingId(cfg.label);

  const pairings = cfg.pairings ?? [
    buildPairing({ pairingId, phonePub: phoneKeypair.pub, label: cfg.label }),
  ];

  const dispatch = cfg.dispatch ?? (async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true }),
  }));

  const client = new BridgeRelayClient({
    relayUrl: RELAY_URL,
    identityKeypair: bridgeKeypair,
    pairings,
    dispatch,
    onSessionState: cfg.onSessionState,
    WebSocketImpl: WebSocket,
  });
  await client.start();

  // Open a phone-side transport. The phone is the initiator (knows the
  // bridge's static pub from the LAN-pairing flow).
  const phoneInbox = [];
  const phoneWaiters = [];
  const phoneTransport = new RemotePairingTransport({
    relayUrl: RELAY_URL,
    pairingId,
    role: "phone",
    initiator: true,
    identityKeypair: phoneKeypair,
    remoteStatic: bridgeKeypair.pub,
    onMessage: (pt) => {
      const w = phoneWaiters.shift();
      if (w) w.resolve(pt);
      else phoneInbox.push(pt);
    },
    WebSocketImpl: WebSocket,
  });
  await phoneTransport.connect();

  function nextPhone(timeoutMs = 5_000) {
    return new Promise((resolveOuter, rejectOuter) => {
      if (phoneInbox.length > 0) return resolveOuter(phoneInbox.shift());
      const w = { resolve: resolveOuter };
      phoneWaiters.push(w);
      const t = setTimeout(() => {
        const idx = phoneWaiters.indexOf(w);
        if (idx >= 0) phoneWaiters.splice(idx, 1);
        rejectOuter(new Error(`phone recv timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      w.resolve = (v) => { clearTimeout(t); resolveOuter(v); };
    });
  }

  return {
    client,
    phoneTransport,
    nextPhone,
    pairingId,
    phoneKeypair,
    bridgeKeypair,
    teardown() {
      phoneTransport.close();
      client.close();
    },
  };
}

// ---------------------------------------------------------------------------
// E2E tests
// ---------------------------------------------------------------------------

test("phone → bridge RPC roundtrip", async () => {
  let dispatchedReq = null;
  const env = await spawnBridgeAndPhone({
    label: "rpc-roundtrip",
    dispatch: async (req) => {
      dispatchedReq = {
        method: req.method, path: req.path, headers: req.headers, body: req.body,
        pairingId: req.pairing.pairingId,
      };
      return {
        status: 200,
        headers: { "content-type": "application/json", "x-test": "from-bridge" },
        body: JSON.stringify({ echoed: req.body }),
      };
    },
  });
  try {
    // Wait for the bridge-side handshake to complete (channelBinding stamped
    // means _handleHandshakeComplete has run + allowlist passed).
    await waitFor(() => env.client.getSessions()[0]?.channelBindingHex != null,
      "bridge session never recorded a channel binding");

    env.phoneTransport.send(encodeRequest({
      id: "r-1",
      method: "POST",
      path: "/api/echo",
      headers: { "content-type": "text/plain" },
      body: "hello",
    }));

    const reply = decodeRpc(await env.nextPhone());
    assert.equal(reply.type, RPC.RESPONSE);
    assert.equal(reply.id, "r-1");
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.headers, {
      "content-type": "application/json",
      "x-test": "from-bridge",
    });
    assert.equal(reply.body, JSON.stringify({ echoed: "hello" }));

    assert.deepEqual(dispatchedReq, {
      method: "POST",
      path: "/api/echo",
      headers: { "content-type": "text/plain" },
      body: "hello",
      pairingId: env.pairingId,
    });
  } finally {
    env.teardown();
  }
});

test("dispatch sees pairing + channelBinding on each request", async () => {
  let captured = null;
  const env = await spawnBridgeAndPhone({
    label: "rpc-pairing-info",
    dispatch: async (req) => {
      captured = {
        pairingId: req.pairing.pairingId,
        phonePub: req.pairing.phonePub,
        bindingLen: req.channelBinding?.length ?? null,
      };
      return { status: 200 };
    },
  });
  try {
    env.phoneTransport.send(encodeRequest({ id: "r-2", method: "GET", path: "/api/x" }));
    await env.nextPhone();
    assert.equal(captured.pairingId, env.pairingId);
    assert.equal(captured.phonePub, bytesToHex(env.phoneKeypair.pub));
    assert.equal(captured.bindingLen, 32, "channel binding should be 32 bytes (SHA-256)");
  } finally {
    env.teardown();
  }
});

test("dispatch error → 500 response", async () => {
  const env = await spawnBridgeAndPhone({
    label: "rpc-error",
    dispatch: async () => { throw new Error("boom"); },
  });
  try {
    env.phoneTransport.send(encodeRequest({ id: "r-3", method: "GET", path: "/api/x" }));
    const reply = decodeRpc(await env.nextPhone());
    assert.equal(reply.status, 500);
    assert.match(reply.body, /internal error/);
  } finally {
    env.teardown();
  }
});

test("invalid dispatch shape → 500 response", async () => {
  const env = await spawnBridgeAndPhone({
    label: "rpc-bad-shape",
    // Returns a number instead of an object — should be caught by validation.
    dispatch: async () => 42,
  });
  try {
    env.phoneTransport.send(encodeRequest({ id: "r-4", method: "GET", path: "/api/x" }));
    const reply = decodeRpc(await env.nextPhone());
    assert.equal(reply.status, 500);
  } finally {
    env.teardown();
  }
});

test("cancel frame aborts in-flight dispatch (no response sent)", async () => {
  let dispatchedSignal = null;
  let dispatchResolved = false;
  const env = await spawnBridgeAndPhone({
    label: "rpc-cancel",
    dispatch: async (req) => {
      dispatchedSignal = req.signal;
      // Slow handler — wait long enough for the cancel to arrive, then check
      // the abort flag and throw.
      await new Promise((res, rej) => {
        const t = setTimeout(res, 2000);
        req.signal.addEventListener("abort", () => {
          clearTimeout(t);
          rej(new Error("aborted"));
        });
      });
      dispatchResolved = true;
      return { status: 200 };
    },
  });
  try {
    env.phoneTransport.send(encodeRequest({ id: "r-cancel", method: "GET", path: "/api/slow" }));
    // Tiny pause to let the bridge enter dispatch.
    await sleep(50);
    env.phoneTransport.send(encodeCancel("r-cancel"));

    // A response should NOT arrive. Wait briefly then assert nothing came.
    let gotResponse = false;
    const probe = env.nextPhone(800).then(() => { gotResponse = true; }).catch(() => {});
    await probe;
    assert.equal(gotResponse, false, "cancelled request must not send a response");
    assert.ok(dispatchedSignal, "dispatch should have been called");
    assert.equal(dispatchedSignal.aborted, true, "signal should be aborted");
    assert.equal(dispatchResolved, false, "dispatch should not have resolved normally");
  } finally {
    env.teardown();
  }
});

test("broadcast() sends event to phone", async () => {
  const env = await spawnBridgeAndPhone({ label: "evt-broadcast" });
  try {
    await waitFor(() => env.client.getSessions()[0]?.channelBindingHex != null,
      "bridge session never connected");
    env.client.broadcast("inbox-changed", { count: 3 });
    const ev = decodeRpc(await env.nextPhone());
    assert.equal(ev.type, RPC.EVENT);
    assert.equal(ev.topic, "inbox-changed");
    assert.deepEqual(ev.data, { count: 3 });
  } finally {
    env.teardown();
  }
});

test("sendEvent(pairingId, ...) targets exactly one session", async () => {
  // Two phones in the same client.
  const phoneAKp = generateIdentityKeypair();
  const phoneBKp = generateIdentityKeypair();
  const bridgeKp = generateIdentityKeypair();
  const idA = uniquePairingId("evt-A");
  const idB = uniquePairingId("evt-B");

  const client = new BridgeRelayClient({
    relayUrl: RELAY_URL,
    identityKeypair: bridgeKp,
    pairings: [
      buildPairing({ pairingId: idA, phonePub: phoneAKp.pub, label: "A" }),
      buildPairing({ pairingId: idB, phonePub: phoneBKp.pub, label: "B" }),
    ],
    dispatch: async () => ({ status: 200 }),
    WebSocketImpl: WebSocket,
  });
  await client.start();

  const recv = (phoneKp, pairingId) => {
    const got = [];
    const t = new RemotePairingTransport({
      relayUrl: RELAY_URL,
      pairingId,
      role: "phone",
      initiator: true,
      identityKeypair: phoneKp,
      remoteStatic: bridgeKp.pub,
      onMessage: (pt) => got.push(pt),
      WebSocketImpl: WebSocket,
    });
    return { transport: t, got };
  };
  const phoneA = recv(phoneAKp, idA);
  const phoneB = recv(phoneBKp, idB);
  await Promise.all([phoneA.transport.connect(), phoneB.transport.connect()]);

  try {
    await waitFor(() => client.getSessions().every((s) => s.channelBindingHex), "both sessions up");

    const ok = client.sendEvent(idA, "for-A", { hi: 1 });
    assert.equal(ok, true);

    // Wait briefly for delivery, then assert phoneA got it and phoneB did not.
    await sleep(200);
    assert.equal(phoneA.got.length, 1);
    assert.equal(phoneB.got.length, 0);
    const ev = decodeRpc(phoneA.got[0]);
    assert.equal(ev.topic, "for-A");

    // sendEvent for unknown pairingId returns false.
    assert.equal(client.sendEvent("does-not-exist", "x"), false);
  } finally {
    phoneA.transport.close();
    phoneB.transport.close();
    client.close();
  }
});

test("phone with non-paired keypair fails the allowlist check", async () => {
  const bridgeKp = generateIdentityKeypair();
  const expectedPhoneKp = generateIdentityKeypair();
  const wrongPhoneKp = generateIdentityKeypair();
  const pairingId = uniquePairingId("allowlist-reject");

  const stateLog = [];
  const errors = [];
  const client = new BridgeRelayClient({
    relayUrl: RELAY_URL,
    identityKeypair: bridgeKp,
    // Pair the EXPECTED phone — the wrong one will fail allowlist.
    pairings: [buildPairing({ pairingId, phonePub: expectedPhoneKp.pub, label: "expected" })],
    dispatch: async () => ({ status: 200 }),
    onSessionState: (ev) => stateLog.push(ev),
    onError: (err) => errors.push(err),
    WebSocketImpl: WebSocket,
  });
  await client.start();

  // Connect with the WRONG phone key against the same pairingId.
  const wrongPhone = new RemotePairingTransport({
    relayUrl: RELAY_URL,
    pairingId,
    role: "phone",
    initiator: true,
    identityKeypair: wrongPhoneKp,
    remoteStatic: bridgeKp.pub,
    WebSocketImpl: WebSocket,
  });
  // The phone-side connect succeeds (Noise IK doesn't care about the
  // initiator's identity until the responder validates allowlist).
  await wrongPhone.connect();

  try {
    // Wait for the bridge to detect the mismatch and tear its session down.
    await waitFor(
      () => errors.some((e) => /doesn't match pairing/.test(e?.message ?? "")),
      "bridge never reported allowlist mismatch",
      5_000,
    );
    // Once the bridge closes its responder side, the relay drops the routing
    // and the phone-side WS closes too (eventually). We don't strictly need
    // to assert that here — the allowlist error is the contract.
    const mismatch = errors.find((e) => /doesn't match pairing/.test(e?.message ?? ""));
    assert.ok(mismatch, "expected an allowlist-mismatch error");
    assert.match(mismatch.message, new RegExp(bytesToHex(wrongPhoneKp.pub)));
  } finally {
    wrongPhone.close();
    client.close();
  }
});

test("MAX_INFLIGHT_PER_SESSION cap returns 503", async () => {
  // Slow dispatcher so we can pile up requests past the cap before any reply.
  let release;
  const gate = new Promise((res) => { release = res; });

  const env = await spawnBridgeAndPhone({
    label: "rpc-cap",
    dispatch: async () => {
      await gate;
      return { status: 200 };
    },
  });
  try {
    await waitFor(() => env.client.getSessions()[0]?.channelBindingHex != null, "session up");

    // Fire (cap + 5) requests in tight succession.
    const sent = MAX_INFLIGHT_PER_SESSION + 5;
    for (let i = 0; i < sent; i++) {
      env.phoneTransport.send(encodeRequest({
        id: `r-${i}`,
        method: "GET",
        path: "/api/slow",
      }));
    }

    // Collect immediate (over-cap) 503s.
    const replies503 = [];
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      try {
        const reply = decodeRpc(await env.nextPhone(300));
        if (reply.status === 503) replies503.push(reply);
        // Once we've seen all the expected 503s, we can stop early.
        if (replies503.length >= 5) break;
      } catch {
        break;
      }
    }
    // We expect 5 immediate 503s (the cap + 5 - cap = 5 over).
    assert.equal(replies503.length, 5, `got ${replies503.length} 503s`);
    for (const r of replies503) assert.match(r.body, /too many in-flight/);

    // Release the gate so the in-flight ones can complete; otherwise close()
    // would leak unresolved dispatch promises.
    release();
  } finally {
    env.teardown();
  }
});

test("onSeen is invoked with pairing + channel binding on handshake", async () => {
  const seenCalls = [];
  const env = await spawnBridgeAndPhone({
    label: "onseen-stamp",
  });
  // We can't pass onSeen via spawnBridgeAndPhone, so build manually.
  env.teardown();

  const bridgeKp = generateIdentityKeypair();
  const phoneKp = generateIdentityKeypair();
  const pairingId = uniquePairingId("onseen");
  const client = new BridgeRelayClient({
    relayUrl: RELAY_URL,
    identityKeypair: bridgeKp,
    pairings: [buildPairing({ pairingId, phonePub: phoneKp.pub })],
    dispatch: async () => ({ status: 200 }),
    onSeen: (info) => { seenCalls.push(info); },
    WebSocketImpl: WebSocket,
  });
  await client.start();

  const phone = new RemotePairingTransport({
    relayUrl: RELAY_URL,
    pairingId,
    role: "phone",
    initiator: true,
    identityKeypair: phoneKp,
    remoteStatic: bridgeKp.pub,
    WebSocketImpl: WebSocket,
  });
  await phone.connect();

  try {
    await waitFor(() => seenCalls.length === 1, "onSeen never fired");
    const [seen] = seenCalls;
    assert.equal(seen.pairing.pairingId, pairingId);
    assert.equal(seen.pairing.phonePub, bytesToHex(phoneKp.pub));
    assert.ok(typeof seen.atMs === "number" && seen.atMs > 0);
    assert.ok(seen.channelBinding instanceof Uint8Array);
    assert.equal(seen.channelBinding.length, 32);
  } finally {
    phone.close();
    client.close();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitFor(predicate, msg, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`waitFor: ${msg}`);
}
