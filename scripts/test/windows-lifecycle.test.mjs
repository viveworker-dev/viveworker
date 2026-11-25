import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { LengthPrefixedFrameDecoder } from "../lib/length-prefixed-frame-decoder.mjs";
import { stopManagedBridge } from "../lib/managed-bridge.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/viveworker.mjs", ...args], {
      cwd: repoRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error("CLI timed out: " + args[0])); }, 25000);
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("Windows setup, start, restart, pair, status and stop run the real bridge with mock Codex IPC", {
  skip: process.platform !== "win32" && "Windows lifecycle integration",
  timeout: 90000,
}, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-windows-"));
  const configDir = path.join(tmp, "日本語 config & spaces");
  const pidFile = path.join(configDir, "viveworker.pid");
  const ipcPath = "\\\\.\\pipe\\viveworker-test-codex-" + crypto.randomUUID();
  const sockets = new Set();
  let lingeringConnection;
  let initialized = 0;
  const ipcServer = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const decoder = new LengthPrefixedFrameDecoder();
    socket.on("data", (data) => {
      for (const frame of decoder.push(data)) {
        const message = JSON.parse(frame.toString());
        if (message.method !== "initialize") continue;
        initialized++;
        const body = Buffer.from(JSON.stringify({
          type: "response", method: "initialize", requestId: message.requestId,
          resultType: "success", result: { clientId: "windows-test-client" },
        }));
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32LE(body.length);
        socket.write(Buffer.concat([prefix, body]));
      }
    });
  });
  await new Promise((resolve, reject) => {
    ipcServer.once("error", reject);
    ipcServer.listen(ipcPath, resolve);
  });
  const port = await freePort();
  const env = {
    ...process.env, USERPROFILE: tmp, HOME: tmp,
    APPDATA: path.join(tmp, "Roaming"), LOCALAPPDATA: path.join(tmp, "Local"),
    CODEX_HOME: path.join(tmp, "codex"), CODEX_IPC_SOCKET_PATH: ipcPath,
    POLL_INTERVAL_MS: "100", REMOTE_PAIRING_ENABLED: "0",
    A2A_RELAY_URL: "", A2A_RELAY_USER_ID: "", MOLTBOOK_API_KEY: "",
  };
  await fs.mkdir(path.join(env.CODEX_HOME, "sessions"), { recursive: true });
  await fs.mkdir(path.join(tmp, ".claude", "projects"), { recursive: true });
  const common = ["--config-dir", configDir, "--locale", "en", "--allow-unpatched-node"];
  const setupArgs = ["setup", ...common, "--disable-web-push", "--no-auto-claude", "--port", String(port)];
  const run = async (args) => {
    const result = await runCli(args, env);
    assert.equal(result.code, 0, result.stderr);
    return result;
  };
  try {
    const missingSetup = await runCli(["start", ...common], env);
    assert.equal(missingSetup.code, 1);
    assert.match(missingSetup.stderr, /Run setup before start/u);
    await assert.rejects(fs.access(configDir), /ENOENT/u);
    const setup = await run(setupArgs);
    assert.doesNotMatch(setup.stderr, /launchctl|process.getuid/u);
    const first = JSON.parse(await fs.readFile(pidFile, "utf8"));
    assert.equal(first.version, 1);
    assert.deepEqual(await (await fetch("http://127.0.0.1:" + port + "/health")).json(), { ok: true });
    for (let count = 0; count < 30 && !initialized; count++) await delay(100);
    assert.ok(initialized > 0, "The real bridge must initialize through a Windows named pipe");

    const savedEnv = await fs.readFile(path.join(configDir, "config.env"), "utf8");
    assert.ok(savedEnv.includes("CODEX_IPC_SOCKET_PATH=" + ipcPath));

    // The mock pipe only initializes. Replies must also arrive when SQLite
    // has no Responses logs and no desktop IPC broadcasts are sent.
    const baseUrl = "http://127.0.0.1:" + port;
    const pairResponse = await fetch(baseUrl + "/api/session/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ token: savedEnv.match(/^PAIRING_TOKEN=(.+)$/mu)[1].trim(), temporary: true }),
    });
    assert.equal(pairResponse.status, 200);
    const cookie = pairResponse.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const threadId = crypto.randomUUID();
    const rolloutPath = path.join(env.CODEX_HOME, "sessions", "rollout-" + threadId + ".jsonl");
    const message = (id, phase, text) => JSON.stringify({
      timestamp: new Date().toISOString(), type: "response_item",
      payload: { id, type: "message", role: "assistant", phase, content: [{ type: "output_text", text }] },
    });
    const progress = message("msg-1", "commentary", "Checking the build.");
    const answer = message("msg-2", "final_answer", "The build passed.");
    await fs.writeFile(rolloutPath, [progress, answer, answer, message("msg-3", "analysis", "Ignore this.")].join("\n") + "\n");
    let replies = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await fetch(baseUrl + "/api/timeline", { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      replies = (await response.json()).entries.filter((entry) => entry.threadId === threadId);
      if (replies.some((entry) => entry.kind === "assistant_final")) break;
      await delay(200);
    }
    assert.deepEqual(replies.map((entry) => [entry.kind, entry.summary]).sort(), [
      ["assistant_commentary", "Checking the build."], ["assistant_final", "The build passed."],
    ]);

    await run(["start", ...common]);
    assert.equal(JSON.parse(await fs.readFile(pidFile, "utf8")).pid, first.pid);

    const status = await run(["status", ...common]);
    assert.match(status.stdout, /Health: OK/iu);
    assert.doesNotMatch(status.stdout, /LaunchAgent|launchd/u);

    await run(["restart", ...common]);
    const restarted = JSON.parse(await fs.readFile(pidFile, "utf8"));
    assert.notEqual(restarted.pid, first.pid);
    await run(["pair", ...common]);
    const refreshedEnv = await fs.readFile(path.join(configDir, "config.env"), "utf8");
    assert.notEqual(refreshedEnv.match(/^PAIRING_TOKEN=(.+)$/mu)[1], savedEnv.match(/^PAIRING_TOKEN=(.+)$/mu)[1]);

    // A second setup must stop the old instance before replacing configuration.
    const beforeSetup = JSON.parse(await fs.readFile(pidFile, "utf8")).pid;
    await run(setupArgs);
    assert.notEqual(JSON.parse(await fs.readFile(pidFile, "utf8")).pid, beforeSetup);
    // An incomplete HTTP request must not prevent managed shutdown.
    lingeringConnection = net.createConnection(port, "127.0.0.1");
    lingeringConnection.on("error", () => {});
    const connectionClosed = new Promise((resolve) => lingeringConnection.once("close", resolve));
    await new Promise((resolve) => lingeringConnection.once("connect", resolve));
    lingeringConnection.write("GET /health HTTP/1.1\r\nHost: localhost\r\n");
    await run(["stop", ...common]);
    await connectionClosed;
    await assert.rejects(fs.access(pidFile), /ENOENT/u);
    await run(["stop", ...common]);
    assert.doesNotMatch(await fs.readFile(path.join(configDir, "logs", "viveworker.log"), "utf8"), /ENOENT|uncaught|ERR_|sqlite.*error/iu);
    await assert.rejects(fs.access(path.join(tmp, "Library", "LaunchAgents")), /ENOENT/u);
    await assert.rejects(fs.access(path.join(tmp, ".claude", "settings.json")), /ENOENT/u);
  } finally {
    lingeringConnection?.destroy();
    await stopManagedBridge(pidFile).catch(() => {});
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => ipcServer.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
