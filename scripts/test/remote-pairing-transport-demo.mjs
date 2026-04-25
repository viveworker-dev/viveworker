#!/usr/bin/env node
/**
 * remote-pairing-transport-demo.mjs — Phase 2c end-to-end smoke test.
 *
 * Spins up wrangler dev for the worker-pairing relay, then drives two
 * RemotePairingTransport instances (phone=initiator, bridge=responder)
 * against it. Verifies that the high-level transport API correctly handles
 * the full lifecycle: WS open → Noise IK handshake → encrypted DATA round
 * trips → graceful close.
 *
 * Companion to scripts/test/remote-pairing-relay-demo.mjs (which exercises
 * the same relay using hand-rolled protocol calls). The transport-demo
 * pins the additional behaviour the transport class is responsible for:
 *   - Both peers reach STATE.CONNECTED after construction + connect().
 *   - send()/onMessage round-trips work in both directions.
 *   - onHandshakeComplete fires with a consistent channel binding.
 *   - close() leaves both transports in STATE.DISCONNECTED.
 *
 * Run:
 *   node scripts/test/remote-pairing-transport-demo.mjs
 *
 * Exits 0 on success, non-zero on any mismatch or runtime error.
 *
 * NOTE: This is a manual smoke test (not part of `node --test`) because it
 * spawns wrangler dev. Phase 2f wraps the same lifecycle in a node:test
 * harness; this file stays as a quick stand-alone checker.
 */

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
// Config
// ---------------------------------------------------------------------------

const DEV_PORT = 8802; // distinct from relay-demo (8801) so they can co-exist
const PAIRING_ID = `transport-demo-${Date.now()}`;
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = resolve(HERE, "../../worker-pairing");
const RELAY_URL = `ws://127.0.0.1:${DEV_PORT}`;

const log = (tag, msg) => process.stderr.write(`[${tag}] ${msg}\n`);

// ---------------------------------------------------------------------------
// wrangler dev lifecycle (mirrors relay-demo.mjs)
// ---------------------------------------------------------------------------

async function startWranglerDev() {
  log("relay", `spawning wrangler dev --local --port=${DEV_PORT}`);
  const proc = spawn(
    "npx",
    ["--no-install", "wrangler", "dev", "--local", "--port", String(DEV_PORT)],
    {
      cwd: WORKER_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_LOG: "warn" },
    },
  );

  proc.stdout.on("data", (chunk) => {
    process.stderr.write(`[wrangler] ${chunk.toString().trimEnd()}\n`);
  });
  proc.stderr.on("data", (chunk) => {
    process.stderr.write(`[wrangler] ${chunk.toString().trimEnd()}\n`);
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEV_PORT}/healthz`);
      if (res.ok) {
        log("relay", "wrangler dev is up");
        return proc;
      }
    } catch {
      // not ready yet
    }
    await sleep(500);
  }
  proc.kill();
  throw new Error("wrangler dev failed to start within 60s");
}

function stopWranglerDev(proc) {
  if (!proc || proc.exitCode != null) return;
  proc.kill("SIGTERM");
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function makeTransport({ role, identityKeypair, remoteStatic, label }) {
  /** @type {Array<Uint8Array>} */
  const inbox = [];
  /** @type {Array<{resolve: (v: Uint8Array) => void}>} */
  const waiters = [];
  /** @type {Uint8Array | null} */
  let handshakeBinding = null;

  const transport = new RemotePairingTransport({
    relayUrl: RELAY_URL,
    pairingId: PAIRING_ID,
    role,
    identityKeypair,
    remoteStatic,
    onMessage: (pt) => {
      log(label, `recv ${pt.length}B`);
      const w = waiters.shift();
      if (w) w.resolve(pt);
      else inbox.push(pt);
    },
    onStateChange: (next, prev) => {
      log(label, `state ${prev} → ${next}`);
    },
    onError: (err) => {
      log(label, `ERROR ${err?.message ?? err}`);
    },
    onHandshakeComplete: ({ channelBinding }) => {
      handshakeBinding = channelBinding;
      log(label, `handshake complete; binding=${Buffer.from(channelBinding).toString("hex").slice(0, 32)}…`);
    },
    WebSocketImpl: WebSocket,
    logger: { debug: (msg) => log(label, `dbg: ${msg}`), warn: (msg) => log(label, `warn: ${msg}`) },
  });

  function next() {
    return new Promise((resolve) => {
      if (inbox.length > 0) return resolve(inbox.shift());
      waiters.push({ resolve });
    });
  }

  return { transport, next, getBinding: () => handshakeBinding };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let wrangler;
  let phone;
  let bridge;
  try {
    wrangler = await startWranglerDev();

    // Fresh long-term keys for both sides. (In production the phone has
    // already learned the bridge's static pub during LAN bootstrap.)
    const phoneKeys = generateIdentityKeypair();
    const bridgeKeys = generateIdentityKeypair();

    phone = makeTransport({
      role: "phone",
      identityKeypair: phoneKeys,
      remoteStatic: bridgeKeys.pub,
      label: "phone",
    });
    bridge = makeTransport({
      role: "bridge",
      identityKeypair: bridgeKeys,
      // responder learns the initiator's pub from msg1
      label: "bridge",
    });

    // Connect both — order doesn't matter, the relay buffers either side.
    log("test", "connecting both transports");
    await Promise.all([phone.transport.connect(), bridge.transport.connect()]);

    if (phone.transport.state !== STATE.CONNECTED) {
      throw new Error(`phone state=${phone.transport.state}, expected connected`);
    }
    if (bridge.transport.state !== STATE.CONNECTED) {
      throw new Error(`bridge state=${bridge.transport.state}, expected connected`);
    }
    log("test", "both connected");

    // Channel bindings must agree — same noise transcript hash on both sides.
    // Read both via the public API and via the onHandshakeComplete callback;
    // they should all match.
    const pcb = phone.transport.channelBinding;
    const bcb = bridge.transport.channelBinding;
    if (!pcb || !bcb) throw new Error("channel binding null after CONNECTED");
    if (Buffer.compare(Buffer.from(pcb), Buffer.from(bcb)) !== 0) {
      throw new Error("channel bindings diverged across peers");
    }
    const pcbCb = phone.getBinding();
    const bcbCb = bridge.getBinding();
    if (!pcbCb || !bcbCb || Buffer.compare(Buffer.from(pcbCb), Buffer.from(pcb)) !== 0) {
      throw new Error("onHandshakeComplete binding diverged from transport.channelBinding");
    }
    log("test", `channel binding matches: ${Buffer.from(pcb).toString("hex").slice(0, 32)}…`);

    // Phone → bridge round-trip x3, then bridge → phone x2.
    const phoneSays = ["approve task #42", "decline task #43", "deliver paid share to buyer"];
    for (const msg of phoneSays) {
      phone.transport.send(new TextEncoder().encode(msg));
      const got = await bridge.next();
      const gotStr = new TextDecoder().decode(got);
      if (gotStr !== msg) throw new Error(`p→b mismatch: ${gotStr} != ${msg}`);
      log("test", `p→b ok: "${gotStr}"`);
    }

    const bridgeSays = ["approval queued", "executing now"];
    for (const msg of bridgeSays) {
      bridge.transport.send(new TextEncoder().encode(msg));
      const got = await phone.next();
      const gotStr = new TextDecoder().decode(got);
      if (gotStr !== msg) throw new Error(`b→p mismatch: ${gotStr} != ${msg}`);
      log("test", `b→p ok: "${gotStr}"`);
    }

    // Clean shutdown — both peers should land in DISCONNECTED.
    log("test", "closing transports");
    phone.transport.close();
    bridge.transport.close();
    if (phone.transport.state !== STATE.DISCONNECTED) {
      throw new Error(`phone post-close state=${phone.transport.state}`);
    }
    if (bridge.transport.state !== STATE.DISCONNECTED) {
      throw new Error(`bridge post-close state=${bridge.transport.state}`);
    }

    log("test", "OK: phase 2c transport end-to-end verified");
    process.exitCode = 0;
  } catch (err) {
    log("test", `FAIL: ${err.message}`);
    if (err.stack) log("test", err.stack);
    process.exitCode = 1;
  } finally {
    try { phone?.transport.close(); } catch {}
    try { bridge?.transport.close(); } catch {}
    stopWranglerDev(wrangler);
    await sleep(250);
  }
}

main();
