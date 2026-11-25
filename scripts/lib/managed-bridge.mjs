import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

async function readRecord(pidFile) {
  let value;
  try { value = JSON.parse(await fs.readFile(pidFile, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Cannot read bridge process record: " + pidFile, { cause: error });
  }
  if (typeof value === "number") return { pid: value };
  if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error("Invalid bridge process record: " + pidFile);
  }
  return value;
}

async function withLifecycleLock(pidFile, action) {
  await fs.mkdir(path.dirname(pidFile), { recursive: true });
  const lockPath = pidFile + ".lock";
  let lock;
  try { lock = await fs.open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error("Another bridge lifecycle operation is in progress. If none is running, remove " + lockPath);
  }
  try {
    await lock.writeFile(String(process.pid));
    return await action();
  } finally {
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
}

function controlRequest(record, command, timeoutMs = 1500) {
  if (record.version !== 1 || typeof record.endpoint !== "string" || typeof record.token !== "string") {
    return Promise.reject(new Error("Bridge process has no verified control endpoint"));
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(record.endpoint);
    let text = "";
    let finished = false;
    const timer = setTimeout(() => finish(new Error("Bridge control request timed out")), timeoutMs);
    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(result);
    }
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(new Error("Bridge closed the control connection")));
    socket.once("connect", () => socket.write(JSON.stringify({ command, token: record.token }) + "\n"));
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8");
      if (text.length > 4096) return finish(new Error("Invalid bridge control response"));
      if (!text.includes("\n")) return;
      try {
        const result = JSON.parse(text.slice(0, text.indexOf("\n")));
        if (!result.ok || result.pid !== record.pid) throw new Error("Bridge process identity did not match");
        finish(null, result);
      } catch (error) { finish(error); }
    });
  });
}

// Used by the bridge only when launched by startManagedBridge. No TCP port is
// exposed. Each launch has its own endpoint and random token.
export async function openBridgeControlServer({ onStop, env = process.env } = {}) {
  const endpoint = env.VIVEWORKER_CONTROL_ENDPOINT;
  const token = env.VIVEWORKER_CONTROL_TOKEN;
  if (!endpoint && !token) return null;
  if (!endpoint || !token) throw new Error("Incomplete bridge control configuration");
  const expected = Buffer.from(token);
  const sockets = new Set();
  let stopping = false;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(1500, () => socket.destroy());
    let text = "";
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      text += chunk.toString("utf8");
      if (text.length > 4096) return socket.destroy();
      if (!text.includes("\n")) return;
      handled = true;
      try {
        const message = JSON.parse(text.slice(0, text.indexOf("\n")));
        const supplied = Buffer.from(String(message.token || ""));
        if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
          return socket.end(JSON.stringify({ ok: false }) + "\n");
        }
        if (!["ping", "stop"].includes(message.command)) {
          return socket.end(JSON.stringify({ ok: false }) + "\n");
        }
        if (message.command === "stop" && !stopping) {
          stopping = true;
          onStop();
        }
        socket.end(JSON.stringify({ ok: true, pid: process.pid, stopping }) + "\n");
      } catch { socket.destroy(); }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  return {
    close: () => new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

export async function managedBridgeStatus(pidFile) {
  const record = await readRecord(pidFile);
  if (!record || !processExists(record.pid)) return { running: false, stale: Boolean(record) };
  try {
    const response = await controlRequest(record, "ping");
    return { running: true, pid: record.pid, stopping: response.stopping, nodePath: record.nodePath };
  } catch {
    return { running: false, unverified: true, pid: record.pid };
  }
}

export async function startManagedBridge({
  nodePath = process.execPath, bridgeScript, envFile, logFile, pidFile,
  env = process.env, startupTimeoutMs = 15000,
}) {
  return withLifecycleLock(pidFile, async () => {
    const previous = await readRecord(pidFile);
    if (previous && processExists(previous.pid)) {
      const status = await controlRequest(previous, "ping").catch(() => {
        throw new Error("Refusing to reuse an unverified process from " + pidFile);
      });
      if (status.stopping) throw new Error("Bridge is still shutting down; retry start after it stops.");
      if (previous.bridgeScript !== path.resolve(bridgeScript) || previous.envFile !== path.resolve(envFile)) {
        throw new Error("A bridge from another checkout/configuration is running. Stop it before starting this one.");
      }
      return { pid: previous.pid, alreadyRunning: true };
    }
    const name = "viveworker-" + crypto.randomUUID();
    const endpoint = process.platform === "win32"
      ? "\\\\.\\pipe\\" + name : path.join(os.tmpdir(), name + ".sock");
    const token = crypto.randomBytes(32).toString("hex");
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    const log = await fs.open(logFile, "a");
    let child;
    let closed;
    let failure;
    try {
      child = spawn(nodePath, [path.resolve(bridgeScript), "--env-file", path.resolve(envFile)], {
        detached: true, windowsHide: true,
        stdio: ["ignore", log.fd, log.fd],
        env: { ...env, VIVEWORKER_CONTROL_ENDPOINT: endpoint, VIVEWORKER_CONTROL_TOKEN: token },
      });
      closed = new Promise((resolve) => child.once("close", resolve));
      child.once("error", (error) => { failure = error; });
      await once(child, "spawn");
      const record = { version: 1, pid: child.pid, endpoint, token, nodePath,
        bridgeScript: path.resolve(bridgeScript), envFile: path.resolve(envFile) };
      await fs.writeFile(pidFile, JSON.stringify(record) + "\n", { mode: 0o600 });
      const deadline = Date.now() + startupTimeoutMs;
      while (Date.now() < deadline) {
        if (failure || child.exitCode !== null || child.signalCode !== null) {
          throw failure || new Error("Bridge exited during startup. See " + logFile);
        }
        try {
          await controlRequest(record, "ping", 300);
          child.unref();
          return { pid: child.pid, alreadyRunning: false };
        } catch { await delay(100); }
      }
      throw new Error("Bridge did not become ready. See " + logFile);
    } catch (error) {
      // This handle refers to the child we just spawned, never a pid-file target.
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      if (closed) await closed;
      await fs.rm(pidFile, { force: true });
      throw error;
    } finally {
      await log.close();
    }
  });
}

export async function stopManagedBridge(pidFile, { timeoutMs = 15000 } = {}) {
  return withLifecycleLock(pidFile, async () => {
    const record = await readRecord(pidFile);
    if (!record) return { stopped: false };
    if (!processExists(record.pid)) {
      await fs.rm(pidFile, { force: true });
      return { stopped: false, stale: true };
    }
    // Never signal an arbitrary PID: Windows can reuse it after a crash.
    await controlRequest(record, "stop").catch((error) => {
      throw new Error("Refusing to stop an unverified process from " + pidFile, { cause: error });
    });
    const deadline = Date.now() + timeoutMs;
    while (processExists(record.pid) && Date.now() < deadline) await delay(100);
    if (processExists(record.pid)) throw new Error("Bridge is still shutting down; retry stop after checking its log.");
    await fs.rm(pidFile, { force: true });
    return { stopped: true, pid: record.pid };
  });
}
