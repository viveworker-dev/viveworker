#!/usr/bin/env node
/**
 * remote-pairing-relay-demo.mjs — Phase 1 end-to-end smoke test.
 *
 * Drives a real Noise IK handshake + 3 transport rounds between an
 * "initiator" (phone) and "responder" (PC bridge) — but instead of stdio
 * pipes, it routes every byte through a live `wrangler dev` instance of
 * the worker-pairing relay. This proves the same Phase 0 crypto module
 * survives the CF Worker hop with the Phase 1 envelope on top.
 *
 * Run:
 *   node scripts/test/remote-pairing-relay-demo.mjs
 *
 * What it does:
 *   1. Spawns `wrangler dev --local` on a fixed dev port (8801).
 *   2. Polls /healthz until the Worker is up.
 *   3. Opens two WebSocket clients to the same pairingId, one as
 *      role=phone, one as role=bridge.
 *   4. Runs Noise IK msg1/msg2 wrapped in FRAME_DATA envelopes.
 *   5. Sends 3 transport requests phone→bridge with bridge echoing
 *      uppercased; verifies each round-trip matches.
 *   6. Tears down wrangler dev cleanly.
 *
 * Exits 0 on success, non-zero on any mismatch or runtime error.
 *
 * NOTE: This is a manual smoke test (not part of `node --test`) because
 * it spawns wrangler dev. It's fine to run before deploys; CI integration
 * is a future improvement.
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import WebSocket from "ws";

import { generateRelayToken } from "../lib/remote-pairing/pairings.mjs";
import {
  createInitiator,
  createResponder,
  generateIdentityKeypair,
} from "../lib/remote-pairing/noise.mjs";
import {
  decode,
  encodeData,
  generateMid,
  FRAME_DATA,
} from "../lib/remote-pairing/envelope.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEV_PORT = 8801;
const PAIRING_ID = `demo-${Date.now()}`;
const RELAY_TOKEN = generateRelayToken(PAIRING_ID);
const PROLOGUE = new TextEncoder().encode("viveworker/remote-pairing/v1");
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = resolve(HERE, "../../worker-pairing");

const log = (tag, msg) => process.stderr.write(`[${tag}] ${msg}\n`);

// ---------------------------------------------------------------------------
// wrangler dev lifecycle
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

  // Pipe a trimmed view of wrangler's chatter to stderr so failures aren't silent.
  proc.stdout.on("data", (chunk) => {
    process.stderr.write(`[wrangler] ${chunk.toString().trimEnd()}\n`);
  });
  proc.stderr.on("data", (chunk) => {
    process.stderr.write(`[wrangler] ${chunk.toString().trimEnd()}\n`);
  });

  // Wait for /healthz to come up. wrangler dev typically takes ~3-8s.
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
  if (!proc) return;
  if (proc.exitCode != null) return;
  proc.kill("SIGTERM");
  // Don't await — best-effort.
}

// ---------------------------------------------------------------------------
// WS helpers
// ---------------------------------------------------------------------------

function openWS(role) {
  const url =
    `ws://127.0.0.1:${DEV_PORT}/v1/pairing/${PAIRING_ID}/ws` +
    `?role=${role}&token=${encodeURIComponent(RELAY_TOKEN)}`;
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/**
 * Returns a function: () => Promise<Uint8Array> that resolves to the next
 * inbound DATA frame's decrypted Noise payload (or throws).
 */
function makeInboundQueue(ws) {
  /** @type {Array<Uint8Array>} */
  const queue = [];
  /** @type {Array<{resolve:(v:Uint8Array)=>void, reject:(e:Error)=>void}>} */
  const waiters = [];
  let closed = null;

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      log("ws", "WARNING: received non-binary frame, ignoring");
      return;
    }
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    let frame;
    try {
      frame = decode(u8);
    } catch (e) {
      log("ws", `decode error: ${e.message}`);
      return;
    }
    if (frame.type !== FRAME_DATA) {
      log("ws", `non-DATA frame: type=0x${frame.type.toString(16)} (skipping)`);
      return;
    }
    const w = waiters.shift();
    if (w) w.resolve(frame.payload);
    else queue.push(frame.payload);
  });

  ws.on("close", (code, reason) => {
    closed = new Error(`ws closed: ${code} ${reason}`);
    while (waiters.length > 0) waiters.shift().reject(closed);
  });
  ws.on("error", (err) => {
    closed = err;
    while (waiters.length > 0) waiters.shift().reject(err);
  });

  return () =>
    new Promise((resolve, reject) => {
      if (queue.length > 0) return resolve(queue.shift());
      if (closed) return reject(closed);
      waiters.push({ resolve, reject });
    });
}

function sendFrame(ws, seq, payload) {
  const wire = encodeData({ seq, mid: generateMid(), payload });
  ws.send(wire, { binary: true });
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

async function runResponder(ws, staticKeypair) {
  const next = makeInboundQueue(ws);
  let seq = 0;

  const responder = createResponder({
    staticKeypair,
    prologue: PROLOGUE,
  });

  // msg1
  const msg1 = await next();
  log("PC", `recv msg1 ${msg1.length}B`);
  const recv1 = responder.readMessage(msg1);
  log("PC", `decrypted msg1: "${new TextDecoder().decode(recv1)}"`);

  // msg2
  const msg2 = responder.writeMessage(new TextEncoder().encode("hello-from-pc"));
  sendFrame(ws, ++seq, msg2);
  log("PC", `send msg2 ${msg2.length}B`);

  const session = responder.intoSession();
  log("PC", `binding=${Buffer.from(session.getChannelBinding()).toString("hex").slice(0, 32)}…`);

  for (let i = 0; i < 3; i++) {
    const ct = await next();
    const pt = session.recv(ct);
    const ptStr = new TextDecoder().decode(pt);
    log("PC", `recv #${i + 1}: "${ptStr}"`);
    const reply = new TextEncoder().encode(`ECHO: ${ptStr.toUpperCase()}`);
    const replyCt = session.send(reply);
    sendFrame(ws, ++seq, replyCt);
    log("PC", `send #${i + 1}`);
  }

  log("PC", "done");
}

async function runInitiator(ws, staticKeypair, remoteStatic) {
  const next = makeInboundQueue(ws);
  let seq = 0;

  const initiator = createInitiator({
    staticKeypair,
    remoteStatic,
    prologue: PROLOGUE,
  });

  // msg1
  const msg1 = initiator.writeMessage(new TextEncoder().encode("hello-from-phone"));
  sendFrame(ws, ++seq, msg1);
  log("phone", `send msg1 ${msg1.length}B`);

  // msg2
  const msg2 = await next();
  log("phone", `recv msg2 ${msg2.length}B`);
  const recv2 = initiator.readMessage(msg2);
  log("phone", `decrypted msg2: "${new TextDecoder().decode(recv2)}"`);

  const session = initiator.intoSession();
  log("phone", `binding=${Buffer.from(session.getChannelBinding()).toString("hex").slice(0, 32)}…`);

  const requests = ["approve task #42", "decline task #43", "deliver paid share to buyer"];
  let allOk = true;
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    const ct = session.send(new TextEncoder().encode(req));
    sendFrame(ws, ++seq, ct);
    log("phone", `send #${i + 1}: "${req}"`);

    const replyCt = await next();
    const reply = session.recv(replyCt);
    const replyStr = new TextDecoder().decode(reply);
    log("phone", `recv #${i + 1}: "${replyStr}"`);

    const expected = `ECHO: ${req.toUpperCase()}`;
    if (replyStr !== expected) {
      log("phone", `MISMATCH expected "${expected}" got "${replyStr}"`);
      allOk = false;
    }
  }

  if (!allOk) throw new Error("echo mismatch");
  log("phone", "all 3 rounds verified");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let wrangler;
  let phoneWS;
  let bridgeWS;
  try {
    wrangler = await startWranglerDev();

    // Generate fresh keypairs for both sides.
    const initStatic = generateIdentityKeypair();
    const respStatic = generateIdentityKeypair();

    // Open both sockets. Order matters slightly: we open both before
    // running either role so frames don't get dropped because the peer
    // hasn't connected yet (the DO buffers them either way, but it's
    // tidier).
    phoneWS = await openWS("phone");
    bridgeWS = await openWS("bridge");

    log("relay", `pairingId=${PAIRING_ID}; both sockets up`);

    // Run responder + initiator concurrently. The Noise handshake makes
    // the ordering work out — initiator drives msg1 first.
    await Promise.all([
      runResponder(bridgeWS, respStatic),
      runInitiator(phoneWS, initStatic, respStatic.pub),
    ]);

    log("relay", "OK: end-to-end Noise+envelope through wrangler dev verified");
    process.exitCode = 0;
  } catch (err) {
    log("relay", `FAIL: ${err.message}`);
    if (err.stack) log("relay", err.stack);
    process.exitCode = 1;
  } finally {
    try { phoneWS?.close(); } catch {}
    try { bridgeWS?.close(); } catch {}
    stopWranglerDev(wrangler);
    // Give wrangler a beat to release the port before exit.
    await sleep(250);
  }
}

main();
