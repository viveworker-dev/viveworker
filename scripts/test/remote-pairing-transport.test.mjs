/**
 * remote-pairing-transport.test.mjs — Phase 2f tests for transport.js.
 *
 * Runs RemotePairingTransport against a real `wrangler dev` instance of
 * the worker-pairing relay. Spins wrangler up once in `before` and shares
 * it across all tests so the (~5-10s) startup is amortized.
 *
 * Coverage:
 *   - happy-path handshake reaches STATE.CONNECTED on both peers
 *   - channel bindings agree across the two transports
 *   - send/recv round-trip works in both directions
 *   - send() before connect() throws synchronously
 *   - close() during opening tears down cleanly
 *   - force-disconnect (close inner WS) → reconnect via RESUME_OK keeps the
 *     noise session alive; subsequent send() works without re-handshake
 *
 * Run:
 *   node --test scripts/test/remote-pairing-transport.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import WebSocket from "ws";

import { generateIdentityKeypair } from "../lib/remote-pairing/noise.mjs";
import {
  RemotePairingTransport,
  STATE,
} from "../../web/remote-pairing/transport.js";

// ---------------------------------------------------------------------------
// Shared wrangler-dev instance
// ---------------------------------------------------------------------------

const DEV_PORT = 8803;
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
  // Quietly drain wrangler output (don't print to stderr or it muddies the
  // test reporter; uncomment for debugging).
  wranglerProc.stdout.on("data", () => {});
  wranglerProc.stderr.on("data", () => {});

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEV_PORT}/healthz`);
      if (res.ok) return;
    } catch {
      // not ready
    }
    await sleep(500);
  }
  wranglerProc.kill();
  throw new Error("wrangler dev failed to start within 60s");
});

test.after(async () => {
  if (wranglerProc && wranglerProc.exitCode == null) {
    wranglerProc.kill("SIGTERM");
    // wait briefly for the port to free so other test runs don't collide
    await sleep(250);
  }
});

// ---------------------------------------------------------------------------
// Test helper — builds a paired { phone, bridge } with a fresh pairingId
// ---------------------------------------------------------------------------

function uniquePairingId(label) {
  return `txp-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function buildPeer({ pairingId, role, identityKeypair, remoteStatic }) {
  /** @type {Array<Uint8Array>} */
  const inbox = [];
  /** @type {Array<{resolve: (v: Uint8Array) => void}>} */
  const waiters = [];
  /** @type {Array<{state: string, prev: string}>} */
  const stateLog = [];
  /** @type {Uint8Array | null} */
  let handshakeBinding = null;
  let handshakeCount = 0;

  const transport = new RemotePairingTransport({
    relayUrl: RELAY_URL,
    pairingId,
    role,
    identityKeypair,
    remoteStatic,
    onMessage: (pt) => {
      const w = waiters.shift();
      if (w) w.resolve(pt);
      else inbox.push(pt);
    },
    onStateChange: (state, prev) => stateLog.push({ state, prev }),
    onHandshakeComplete: ({ channelBinding }) => {
      handshakeBinding = channelBinding;
      handshakeCount += 1;
    },
    WebSocketImpl: WebSocket,
  });

  function next(timeoutMs = 5_000) {
    return new Promise((resolveOuter, rejectOuter) => {
      if (inbox.length > 0) return resolveOuter(inbox.shift());
      const w = { resolve: resolveOuter };
      waiters.push(w);
      const t = setTimeout(() => {
        const idx = waiters.indexOf(w);
        if (idx >= 0) waiters.splice(idx, 1);
        rejectOuter(new Error(`recv timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      // Once we resolve via inbox, clear the timer.
      w.resolve = (v) => { clearTimeout(t); resolveOuter(v); };
    });
  }

  return {
    transport,
    next,
    get stateLog() { return stateLog.slice(); },
    get handshakeBinding() { return handshakeBinding; },
    get handshakeCount() { return handshakeCount; },
  };
}

async function pair(label) {
  const phoneKeys = generateIdentityKeypair();
  const bridgeKeys = generateIdentityKeypair();
  const pairingId = uniquePairingId(label);
  const phone = buildPeer({
    pairingId, role: "phone",
    identityKeypair: phoneKeys, remoteStatic: bridgeKeys.pub,
  });
  const bridge = buildPeer({
    pairingId, role: "bridge",
    identityKeypair: bridgeKeys,
  });
  await Promise.all([phone.transport.connect(), bridge.transport.connect()]);
  return { phone, bridge, phoneKeys, bridgeKeys, pairingId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("handshake reaches STATE.CONNECTED on both peers", async () => {
  const { phone, bridge } = await pair("happy");
  try {
    assert.equal(phone.transport.state, STATE.CONNECTED);
    assert.equal(bridge.transport.state, STATE.CONNECTED);
    assert.equal(phone.handshakeCount, 1);
    assert.equal(bridge.handshakeCount, 1);
  } finally {
    phone.transport.close();
    bridge.transport.close();
  }
});

test("channel bindings agree across the two peers", async () => {
  const { phone, bridge } = await pair("binding");
  try {
    const pcb = phone.transport.channelBinding;
    const bcb = bridge.transport.channelBinding;
    assert.ok(pcb);
    assert.ok(bcb);
    assert.deepEqual(pcb, bcb);
    assert.deepEqual(pcb, phone.handshakeBinding);
    assert.deepEqual(bcb, bridge.handshakeBinding);
  } finally {
    phone.transport.close();
    bridge.transport.close();
  }
});

test("send/recv round-trips in both directions", async () => {
  const { phone, bridge } = await pair("roundtrip");
  try {
    phone.transport.send(new TextEncoder().encode("hello bridge"));
    const got1 = new TextDecoder().decode(await bridge.next());
    assert.equal(got1, "hello bridge");

    bridge.transport.send(new TextEncoder().encode("hello phone"));
    const got2 = new TextDecoder().decode(await phone.next());
    assert.equal(got2, "hello phone");

    // A handful of additional rounds catches any seq-counter drift.
    for (let i = 0; i < 5; i++) {
      const msg = `round-${i}`;
      phone.transport.send(new TextEncoder().encode(msg));
      assert.equal(new TextDecoder().decode(await bridge.next()), msg);
    }
  } finally {
    phone.transport.close();
    bridge.transport.close();
  }
});

test("send() before connect() throws synchronously", () => {
  const t = new RemotePairingTransport({
    relayUrl: RELAY_URL,
    pairingId: uniquePairingId("nopre"),
    role: "phone",
    identityKeypair: generateIdentityKeypair(),
    remoteStatic: generateIdentityKeypair().pub,
    WebSocketImpl: WebSocket,
  });
  assert.throws(() => t.send(new Uint8Array([1, 2, 3])), /not connected/);
  // No need to close — never connected, no resources to free.
});

test("close() during opening tears down without throwing", async () => {
  // Point at a port nothing's listening on; the WS will fail to open.
  const t = new RemotePairingTransport({
    relayUrl: "ws://127.0.0.1:1",
    pairingId: uniquePairingId("close-during-open"),
    role: "phone",
    identityKeypair: generateIdentityKeypair(),
    remoteStatic: generateIdentityKeypair().pub,
    WebSocketImpl: WebSocket,
    backoffMs: [50, 100], // fail fast — we just want the open attempt to fire
  });
  const connectPromise = t.connect().catch((err) => err);
  // Give it a microtask to enter OPENING.
  await sleep(0);
  t.close();
  const result = await connectPromise;
  assert.ok(result instanceof Error, "connect() should reject after close()");
  assert.equal(t.state, STATE.DISCONNECTED);
});

test("force-disconnect → reconnect resumes the noise session (RESUME_OK)", async () => {
  const { phone, bridge } = await pair("resume");
  try {
    // Sanity round-trip.
    phone.transport.send(new TextEncoder().encode("before"));
    assert.equal(new TextDecoder().decode(await bridge.next()), "before");

    const phoneSessionBefore = phone.transport.channelBinding;
    const handshakesBefore = phone.handshakeCount;

    // Slam the underlying WS so onclose fires and the transport reconnects.
    // Use ws.terminate() (no close frame, simulates a real network blip) —
    // ws.close(1006) is rejected by the `ws` library because 1006 is reserved
    // for the protocol layer and never sent on the wire.
    phone.transport._ws.terminate();

    // Wait for the resume cycle to reach CONNECTED again. Look for the exact
    // transitions: connected → disconnected → opening → resuming → connected.
    await waitForState(phone.transport, STATE.CONNECTED, { skipFirst: true, timeoutMs: 10_000 });

    // Channel binding must NOT change — same noise session.
    assert.deepEqual(phone.transport.channelBinding, phoneSessionBefore);
    // No second handshake should have fired (RESUME_OK keeps the session).
    assert.equal(phone.handshakeCount, handshakesBefore);

    // Verify the resume path was actually exercised (opening → resuming →
    // connected, not opening → handshaking → connected).
    const recentStates = phone.stateLog.map((e) => e.state);
    assert.ok(recentStates.includes(STATE.RESUMING), `expected RESUMING in ${recentStates.join(",")}`);

    // Round-trip after resume should still work.
    phone.transport.send(new TextEncoder().encode("after"));
    assert.equal(new TextDecoder().decode(await bridge.next()), "after");
  } finally {
    phone.transport.close();
    bridge.transport.close();
  }
});

test("close() after CONNECTED leaves both ends in DISCONNECTED", async () => {
  const { phone, bridge } = await pair("close-clean");
  phone.transport.close();
  bridge.transport.close();
  assert.equal(phone.transport.state, STATE.DISCONNECTED);
  assert.equal(bridge.transport.state, STATE.DISCONNECTED);
  assert.throws(() => phone.transport.send(new Uint8Array([0])), /not connected/);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait for a transport to enter `targetState`. If `skipFirst` is true and
 * we're currently in that state, wait for the next entry into it (used for
 * reconnect cycles where we already passed through CONNECTED once).
 */
async function waitForState(transport, targetState, { skipFirst = false, timeoutMs = 5_000 } = {}) {
  if (!skipFirst && transport.state === targetState) return;
  return new Promise((resolveOuter, rejectOuter) => {
    let armed = !skipFirst;
    const t = setTimeout(() => {
      transport._onStateChange = origCb;
      rejectOuter(new Error(`waitForState(${targetState}) timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const origCb = transport._onStateChange;
    transport._onStateChange = (state, prev, info) => {
      try { origCb?.(state, prev, info); } catch {}
      if (!armed && state !== targetState) armed = true;
      if (armed && state === targetState) {
        clearTimeout(t);
        transport._onStateChange = origCb;
        resolveOuter();
      }
    };
  });
}
