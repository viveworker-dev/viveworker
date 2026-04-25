/**
 * remote-pairing-e2e.test.mjs — Phase 4e: full-pipeline E2E against wrangler dev.
 *
 * Earlier phase tests cover individual pieces:
 *   - 4a: http-dispatch adapter alone (synthetic req/res, no relay)
 *   - 4b: orchestrator wiring with stubbed WebSocket (no real I/O)
 *   - 4c: RpcClient with a fake transport (no relay)
 *
 * This test stitches them together against a real `wrangler dev` instance
 * of `worker-pairing/`, so the bytes actually traverse the relay's Durable
 * Object once. Coverage:
 *
 *   - phone `RpcClient.fetch()` → relay → bridge orchestrator → fake
 *     `requestListener` → response → relay → phone, including JSON body
 *     round-trip and header passthrough.
 *   - `handle.broadcast(topic, data)` → phone `onEvent(topic, data)`.
 *   - `handle.reloadNow()` after `savePairings()` picks up a new pairing
 *     and the new phone can immediately RPC.
 *   - `handle.getStatus()` reflects the connected session post-handshake
 *     and matches the persisted identity keypair.
 *   - Clean shutdown — both sides close without hangs.
 *
 * Run:
 *   node --test scripts/test/remote-pairing-e2e.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import WebSocket from "ws";

import {
  startRemotePairingRelay,
} from "../lib/remote-pairing/orchestrator.mjs";
import {
  buildPairing,
  savePairings,
} from "../lib/remote-pairing/pairings.mjs";
import {
  generateIdentityKeypair,
  saveIdentityKeypair,
} from "../lib/remote-pairing/keys.mjs";
import { bytesToHex } from "../lib/remote-pairing/keys-core.mjs";

import {
  RemotePairingRpcClient,
} from "../../web/remote-pairing/rpc-client.js";

// ===========================================================================
// wrangler dev — shared across all tests in this file
// ===========================================================================

const DEV_PORT = 8806; // distinct from the 8804 used by bridge-relay-client tests
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

// ===========================================================================
// Helpers
// ===========================================================================

async function makeTmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vw-e2e-pairing-"));
  return {
    dir,
    keysFile: path.join(dir, "remote-pairing.env"),
    pairingsFile: path.join(dir, "remote-pairings.json"),
    cleanup: async () => {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

function uniquePairingId(label) {
  return `e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Build a minimal Node-style HTTP request listener. The orchestrator's
 * http-dispatch adapter calls this with synthetic IncomingMessage / ServerResponse
 * objects, so as long as we honor `req.method`, `req.url`, and `res.writeHead`
 * + `res.end`, we get the same code path real LAN HTTP would.
 */
function makeFakeRequestListener({ onRequest } = {}) {
  return (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length === 0
        ? ""
        : Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString("utf8");
      onRequest?.({ method: req.method, url: req.url, headers: req.headers, body });

      // Echo path: respond with whatever the request looked like.
      if (req.url === "/api/echo" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json", "x-test": "echo" });
        res.end(JSON.stringify({ method: req.method, url: req.url, body }));
        return;
      }
      // GET /api/hello → JSON greeting.
      if (req.url === "/api/hello" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ greeting: "hi", url: req.url }));
        return;
      }
      // GET /api/text → text body.
      if (req.url === "/api/text" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("hello world");
        return;
      }
      // Default: 404.
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  };
}

/**
 * Bring up an end-to-end pipeline: orchestrator (bridge side) + RpcClient
 * (phone side) talking through wrangler dev.
 *
 * Returns the live handle, the rpc client, and a teardown function that
 * cleans up both sides plus the tmp dir.
 *
 * @param {{
 *   label: string,
 *   onRequest?: (info: object) => void,
 * }} cfg
 */
async function spawnPipeline(cfg) {
  const tmp = await makeTmp();

  // 1) Persist a known bridge keypair into the env file. The orchestrator
  //    picks it up via ensureIdentityKeypair — saves us from having to read
  //    it back out post-startup just to wire the phone client.
  const bridgeKeypair = generateIdentityKeypair();
  await saveIdentityKeypair(bridgeKeypair, tmp.keysFile);

  // 2) Pre-write a single pairing for one phone.
  const phoneKeypair = generateIdentityKeypair();
  const pairingId = uniquePairingId(cfg.label);
  await savePairings(
    [buildPairing({ pairingId, phonePub: phoneKeypair.pub, label: cfg.label })],
    tmp.pairingsFile,
  );

  // 3) Start the orchestrator with our isolated tmp paths and the relay URL.
  const requestListener = makeFakeRequestListener({ onRequest: cfg.onRequest });
  const handle = await startRemotePairingRelay({
    enabled: true,
    relayUrl: RELAY_URL,
    requestListener,
    identityKeypairFile: tmp.keysFile,
    pairingsFile: tmp.pairingsFile,
    watchPairingsFile: false, // we'll call reloadNow() explicitly when needed
    WebSocketImpl: WebSocket,
    logger: { /* silent */ },
  });

  // 4) Open the phone-side RpcClient. It composes a transport internally.
  const events = []; // { topic, data }
  let stateLog = []; // { state, prev }
  const rpc = new RemotePairingRpcClient({
    relayUrl: RELAY_URL,
    pairingId,
    identityKeypair: phoneKeypair,
    remoteStatic: bridgeKeypair.pub,
    role: "phone",
    initiator: true,
    onEvent: (topic, data) => events.push({ topic, data }),
    onStateChange: (state, prev) => stateLog.push({ state, prev }),
    WebSocketImpl: WebSocket,
    logger: { /* silent */ },
  });
  await rpc.connect();

  return {
    tmp,
    handle,
    rpc,
    pairingId,
    bridgeKeypair,
    phoneKeypair,
    events,
    stateLog,
    async teardown() {
      try { rpc.close(); } catch {}
      try { handle.close(); } catch {}
      await tmp.cleanup();
    },
  };
}

async function waitFor(predicate, msg, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`waitFor: ${msg}`);
}

// ===========================================================================
// Tests
// ===========================================================================

test("phone RpcClient.fetch GET → bridge requestListener → JSON response", async () => {
  let dispatched = null;
  const env = await spawnPipeline({
    label: "get-roundtrip",
    onRequest: (info) => { dispatched = info; },
  });
  try {
    // Wait for handshake to settle on both ends.
    await waitFor(() => env.rpc.isConnected, "phone never reached CONNECTED");
    await waitFor(() => env.handle.getStatus().sessions[0]?.channelBindingHex != null,
      "bridge session never recorded a channel binding");

    const res = await env.rpc.fetch({ method: "GET", path: "/api/hello" });
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "application/json");
    const body = await res.json();
    assert.deepEqual(body, { greeting: "hi", url: "/api/hello" });

    assert.ok(dispatched, "requestListener should have been invoked");
    assert.equal(dispatched.method, "GET");
    assert.equal(dispatched.url, "/api/hello");
  } finally {
    await env.teardown();
  }
});

test("POST with JSON body — request body and response body both round-trip", async () => {
  const seen = [];
  const env = await spawnPipeline({
    label: "post-echo",
    onRequest: (info) => seen.push(info),
  });
  try {
    await waitFor(() => env.rpc.isConnected, "phone never connected");

    const reqBody = JSON.stringify({ hi: 1, list: [1, 2, 3] });
    const res = await env.rpc.fetch({
      method: "POST",
      path: "/api/echo",
      headers: { "content-type": "application/json" },
      body: reqBody,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers["x-test"], "echo");
    const echoed = await res.json();
    assert.equal(echoed.method, "POST");
    assert.equal(echoed.url, "/api/echo");
    assert.equal(echoed.body, reqBody);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].body, reqBody);
    // content-type header should propagate to the listener
    assert.match(String(seen[0].headers["content-type"] ?? ""), /application\/json/);
  } finally {
    await env.teardown();
  }
});

test("text response → res.text() returns the original string", async () => {
  const env = await spawnPipeline({ label: "get-text" });
  try {
    await waitFor(() => env.rpc.isConnected, "phone never connected");

    const res = await env.rpc.fetch({ method: "GET", path: "/api/text" });
    assert.equal(res.status, 200);
    const t = await res.text();
    assert.equal(t, "hello world");
  } finally {
    await env.teardown();
  }
});

test("404 from listener surfaces as fetch().status === 404", async () => {
  const env = await spawnPipeline({ label: "get-404" });
  try {
    await waitFor(() => env.rpc.isConnected, "phone never connected");

    const res = await env.rpc.fetch({ method: "GET", path: "/no/such/path" });
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "not found");
  } finally {
    await env.teardown();
  }
});

test("handle.broadcast(topic, data) → phone onEvent", async () => {
  const env = await spawnPipeline({ label: "broadcast" });
  try {
    await waitFor(() => env.rpc.isConnected, "phone never connected");
    await waitFor(() => env.handle.getStatus().sessions[0]?.channelBindingHex != null,
      "bridge session never connected");

    env.handle.broadcast("inbox-changed", { count: 5 });
    await waitFor(() => env.events.length === 1, "event never delivered");
    assert.equal(env.events[0].topic, "inbox-changed");
    assert.deepEqual(env.events[0].data, { count: 5 });
  } finally {
    await env.teardown();
  }
});

test("getStatus() reflects identity + connected session", async () => {
  const env = await spawnPipeline({ label: "status" });
  try {
    await waitFor(() => env.handle.getStatus().sessions[0]?.channelBindingHex != null,
      "bridge session never connected");

    const status = env.handle.getStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.relayUrl, RELAY_URL);
    assert.ok(status.identityFingerprint, "identityFingerprint should be set");
    assert.equal(status.identityPubHex, bytesToHex(env.bridgeKeypair.pub));
    assert.equal(status.sessions.length, 1);
    assert.equal(status.sessions[0].pairingId, env.pairingId);
    assert.ok(status.sessions[0].channelBindingHex);
  } finally {
    await env.teardown();
  }
});

test("reloadNow() picks up a newly-added pairing — second phone can RPC", async () => {
  let listenerCount = 0;
  const env = await spawnPipeline({
    label: "reload",
    onRequest: () => { listenerCount += 1; },
  });
  try {
    await waitFor(() => env.handle.getStatus().sessions[0]?.channelBindingHex != null,
      "first session never connected");

    // Create a second phone keypair, append it to the pairings file, then
    // tell the orchestrator to reload.
    const phone2Kp = generateIdentityKeypair();
    const id2 = uniquePairingId("reload-second");
    await savePairings(
      [
        // keep the first
        buildPairing({
          pairingId: env.pairingId,
          phonePub: env.phoneKeypair.pub,
          label: "reload",
        }),
        buildPairing({ pairingId: id2, phonePub: phone2Kp.pub, label: "second" }),
      ],
      env.tmp.pairingsFile,
    );
    await env.handle.reloadNow();

    await waitFor(
      () => env.handle.getStatus().sessions.length === 2,
      "orchestrator never spawned the second session",
    );

    // Bring up a phone for the second pairing and round-trip a request.
    const rpc2 = new RemotePairingRpcClient({
      relayUrl: RELAY_URL,
      pairingId: id2,
      identityKeypair: phone2Kp,
      remoteStatic: env.bridgeKeypair.pub,
      role: "phone",
      initiator: true,
      WebSocketImpl: WebSocket,
      logger: {},
    });
    try {
      await rpc2.connect();
      const res = await rpc2.fetch({ method: "GET", path: "/api/hello" });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.greeting, "hi");
      // First-phone listener should also see traffic if we send to it.
      const res1 = await env.rpc.fetch({ method: "GET", path: "/api/hello" });
      assert.equal(res1.status, 200);
      assert.ok(listenerCount >= 2, "listener should have served both phones");
    } finally {
      try { rpc2.close(); } catch {}
    }
  } finally {
    await env.teardown();
  }
});

test("close() is clean — orchestrator handle and rpc client both shut down without throwing", async () => {
  const env = await spawnPipeline({ label: "shutdown" });
  await waitFor(() => env.rpc.isConnected, "phone never connected");
  // Closing twice must be safe.
  env.rpc.close();
  env.rpc.close();
  env.handle.close();
  env.handle.close();
  await env.tmp.cleanup();
  // After close, getStatus still returns a valid shape.
  const status = env.handle.getStatus();
  assert.equal(typeof status, "object");
});
