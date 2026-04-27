import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LOCK_DIR = path.join(os.tmpdir(), "viveworker-remote-pairing-wrangler.lock");
const LOCK_STALE_MS = 5 * 60_000;

async function acquireWranglerDevLock({ timeoutMs = 180_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.mkdir(LOCK_DIR);
      await fs.writeFile(
        path.join(LOCK_DIR, "owner"),
        `pid=${process.pid}\ncreatedAt=${new Date().toISOString()}\n`,
        "utf8",
      );
      return async () => {
        await fs.rm(LOCK_DIR, { recursive: true, force: true });
      };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }

    try {
      const stat = await fs.stat(LOCK_DIR);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(LOCK_DIR, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue;
    }

    await sleep(250);
  }
  throw new Error("timed out waiting for wrangler dev test lock");
}

function appendTail(current, chunk) {
  const next = current + chunk.toString("utf8");
  return next.length > 16_000 ? next.slice(-16_000) : next;
}

function waitForExit(proc, timeoutMs) {
  if (!proc || proc.exitCode != null || proc.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.off("exit", onExit);
      resolve();
    }, timeoutMs);
    function onExit() {
      clearTimeout(timer);
      resolve();
    }
    proc.once("exit", onExit);
  });
}

export async function startWranglerDev({
  workerDir,
  port,
  startupTimeoutMs = 60_000,
  lockTimeoutMs = 180_000,
} = {}) {
  if (!workerDir) throw new Error("startWranglerDev: workerDir required");
  if (!Number.isInteger(port) || port <= 0) throw new Error("startWranglerDev: port required");

  const release = await acquireWranglerDevLock({ timeoutMs: lockTimeoutMs });
  const handle = { proc: null, release };
  let stdout = "";
  let stderr = "";
  let spawnError = null;

  try {
    const proc = spawn(
      "npx",
      ["--no-install", "wrangler", "dev", "--local", "--port", String(port)],
      {
        cwd: workerDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WRANGLER_LOG: "warn" },
      },
    );
    handle.proc = proc;
    proc.stdout.on("data", (chunk) => { stdout = appendTail(stdout, chunk); });
    proc.stderr.on("data", (chunk) => { stderr = appendTail(stderr, chunk); });
    proc.once("error", (err) => { spawnError = err; });

    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (proc.exitCode != null || proc.signalCode != null) {
        throw new Error(
          `wrangler dev exited before ready (code=${proc.exitCode}, signal=${proc.signalCode})\n${stderr || stdout}`,
        );
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (res.ok) return handle;
      } catch {
        // not ready
      }
      await sleep(500);
    }
    throw new Error(`wrangler dev failed to start within ${startupTimeoutMs}ms\n${stderr || stdout}`);
  } catch (err) {
    await stopWranglerDev(handle);
    throw err;
  }
}

export async function stopWranglerDev(handle) {
  if (!handle) return;
  try {
    const proc = handle.proc;
    if (proc && proc.exitCode == null && proc.signalCode == null) {
      proc.kill("SIGTERM");
      await waitForExit(proc, 2_000);
      if (proc.exitCode == null && proc.signalCode == null) {
        proc.kill("SIGKILL");
        await waitForExit(proc, 1_000);
      }
      await sleep(250);
    }
  } finally {
    await handle.release?.();
  }
}
