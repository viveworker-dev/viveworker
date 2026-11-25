import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startManagedBridge, stopManagedBridge, managedBridgeStatus } from "../lib/managed-bridge.mjs";

async function fixture(t, settings = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-service-"));
  const envFile = path.join(tmp, "config.json");
  const marker = path.join(tmp, "flushed.txt");
  const pidFile = path.join(tmp, "service.pid");
  await fs.writeFile(envFile, JSON.stringify({ marker, ...settings }));
  t.after(async () => {
    await stopManagedBridge(pidFile).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
  });
  return { tmp, marker, envFile, pidFile, logFile: path.join(tmp, "logs", "service.log"),
    bridgeScript: fileURLToPath(new URL("./fixtures/managed-bridge.mjs", import.meta.url)) };
}

test("managed background start is idempotent and stop allows state to flush", async (t) => {
  const options = await fixture(t);
  const first = await startManagedBridge(options);
  assert.equal(first.alreadyRunning, false);
  const second = await startManagedBridge(options);
  assert.equal(second.pid, first.pid);
  assert.equal(second.alreadyRunning, true);
  assert.equal((await managedBridgeStatus(options.pidFile)).running, true);
  assert.equal((await stopManagedBridge(options.pidFile)).stopped, true);
  assert.equal(await fs.readFile(options.marker, "utf8"), "flushed");
  assert.equal((await managedBridgeStatus(options.pidFile)).running, false);
  assert.equal((await stopManagedBridge(options.pidFile)).stopped, false);
});

test("legacy PID records never authorize stopping an unrelated live process", async (t) => {
  const options = await fixture(t);
  await fs.writeFile(options.pidFile, String(process.pid));
  assert.equal((await managedBridgeStatus(options.pidFile)).unverified, true);
  await assert.rejects(stopManagedBridge(options.pidFile), /unverified process/u);
  await assert.rejects(startManagedBridge(options), /unverified process/u);
  assert.equal(process.kill(process.pid, 0), true);
  await fs.rm(options.pidFile);
});

test("a wrong control token cannot stop or take over a live bridge", async (t) => {
  const options = await fixture(t);
  await startManagedBridge(options);
  const original = await fs.readFile(options.pidFile, "utf8");
  try {
    const modified = JSON.parse(original);
    modified.token = "wrong-token";
    await fs.writeFile(options.pidFile, JSON.stringify(modified));
    await assert.rejects(stopManagedBridge(options.pidFile), /unverified process/u);
    assert.equal((await managedBridgeStatus(options.pidFile)).unverified, true);
  } finally {
    await fs.writeFile(options.pidFile, original);
  }
  assert.equal((await managedBridgeStatus(options.pidFile)).running, true);
});

test("simultaneous starts are serialized without orphaning a second bridge", async (t) => {
  const options = await fixture(t);
  const results = await Promise.allSettled([startManagedBridge(options), startManagedBridge(options)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(results.find((r) => r.status === "rejected").reason.message, /lifecycle operation/u);
  assert.equal((await managedBridgeStatus(options.pidFile)).running, true);
});

test("failed startup removes its process record and lifecycle lock", async (t) => {
  const options = await fixture(t, { fail: true });
  await assert.rejects(startManagedBridge(options), /exited during startup/u);
  await assert.rejects(fs.access(options.pidFile), /ENOENT/u);
  await assert.rejects(fs.access(options.pidFile + ".lock"), /ENOENT/u);
});

test("startup readiness timeout terminates only the child it created", async (t) => {
  const options = await fixture(t, { hang: true });
  await assert.rejects(startManagedBridge({ ...options, startupTimeoutMs: 400 }), /did not become ready/u);
  assert.equal((await managedBridgeStatus(options.pidFile)).running, false);
  await assert.rejects(fs.access(options.pidFile + ".lock"), /ENOENT/u);
});

test("a bridge belonging to another config is not reused", async (t) => {
  const options = await fixture(t);
  await startManagedBridge(options);
  await assert.rejects(startManagedBridge({ ...options, envFile: path.join(options.tmp, "another.json") }), /another checkout/u);
  assert.equal((await managedBridgeStatus(options.pidFile)).running, true);
});

test("a crashed bridge can restart from its stale process record", async (t) => {
  const options = await fixture(t);
  const started = await startManagedBridge(options);
  // Only the fixture created by this test is terminated.
  process.kill(started.pid);
  for (let i = 0; i < 100; i++) {
    try { process.kill(started.pid, 0); } catch { break; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await managedBridgeStatus(options.pidFile)).stale, true);
  const restarted = await startManagedBridge(options);
  assert.notEqual(restarted.pid, started.pid);
  assert.equal((await managedBridgeStatus(options.pidFile)).running, true);
});

test("a slow shutdown is reported without force-killing or starting another instance", async (t) => {
  const options = await fixture(t, { ignoreStop: true });
  const started = await startManagedBridge(options);
  try {
    await assert.rejects(stopManagedBridge(options.pidFile, { timeoutMs: 200 }), /still shutting down/u);
    assert.equal(process.kill(started.pid, 0), true);
    await assert.rejects(startManagedBridge(options), /still shutting down/u);
  } finally {
    // Only the intentionally unresponsive fixture created above is terminated.
    process.kill(started.pid);
    for (let i = 0; i < 100; i++) {
      try { process.kill(started.pid, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
});
