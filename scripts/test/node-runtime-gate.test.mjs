import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

// Runs the CLI as if it were on `nodeVersion`, independent of the Node.js
// running the test suite.
function runCliAs(nodeVersion, args, env = {}) {
  const preload = `Object.defineProperty(process, "versions", { value: Object.freeze({ ...process.versions, node: ${JSON.stringify(nodeVersion)} }), configurable: true, enumerable: true });`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      "scripts/viveworker.mjs",
      ...args,
    ], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function withTmp(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-node-gate-"));
  try {
    return await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("setup stops on an end-of-life Node.js before touching anything", async () => {
  await withTmp(async (tmp) => {
    const configDir = path.join(tmp, "config");
    const result = await runCliAs("20.19.0", [
      "setup", "--locale", "en", "--config-dir", configDir, "--no-launchd",
      "--launch-agent-path", path.join(tmp, "LaunchAgents", "io.viveworker.app.plist"),
    ], { HOME: tmp });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Node\.js v20\.19\.0 is end-of-life/u);
    assert.match(result.stderr, /stopped before changing anything/u);
    assert.match(result.stderr, /--allow-unpatched-node/u);
    assert.deepEqual(await fs.readdir(tmp), []);
  });
});

test("setup stops on an unpatched release of a supported line", async () => {
  await withTmp(async (tmp) => {
    const result = await runCliAs("24.19.0", [
      "setup", "--locale", "ja", "--config-dir", path.join(tmp, "config"), "--no-launchd",
    ], { HOME: tmp });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Node\.js v24\.19\.0 には 2026年10月/u);
    assert.match(result.stderr, /v24\.22\.1 以降/u);
    assert.deepEqual(await fs.readdir(tmp), []);
  });
});

test("enable mcp is gated, but dry-run, patched runtimes and the override pass", async () => {
  await withTmp(async (tmp) => {
    const codexConfig = path.join(tmp, "codex", "config.toml");
    const env = { HOME: tmp, VIVEWORKER_MCP_CODEX_CONFIG_FILE: codexConfig };
    const args = ["enable", "mcp", "--target", "codex", "--locale", "en"];

    const blocked = await runCliAs("22.23.1", [...args, "--yes"], env);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /Node\.js v22\.23\.1 is missing .*v22\.23\.4 or later/u);
    await assert.rejects(fs.access(codexConfig));

    const dryRun = await runCliAs("20.19.0", [...args, "--dry-run"], env);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    await assert.rejects(fs.access(codexConfig));

    const patched = await runCliAs("24.22.1", [...args, "--yes"], env);
    assert.equal(patched.code, 0, patched.stderr);
    assert.match(await fs.readFile(codexConfig, "utf8"), /\[mcp_servers\.viveworker\]/u);

    const overridden = await runCliAs("20.19.0", [...args, "--yes", "--allow-unpatched-node"], env);
    assert.equal(overridden.code, 0, overridden.stderr);
  });
});

test("without launchd, start / pair / restart refuse before rewriting config or stopping the bridge", async () => {
  await withTmp(async (tmp) => {
    const configDir = path.join(tmp, "config");
    const envFile = path.join(configDir, "config.env");
    const pidFile = path.join(configDir, "viveworker.pid");
    await fs.mkdir(configDir, { recursive: true });
    const envText = [
      "DEFAULT_LOCALE=en",
      "SESSION_SECRET=test-secret",
      "NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL=http://127.0.0.1:1",
      "PAIRING_CODE=OLDCODE1",
      "PAIRING_TOKEN=old-token",
      "PAIRING_EXPIRES_AT_MS=1",
      "",
    ].join("\n");
    await fs.writeFile(envFile, envText, "utf8");
    // A pid that cannot be running: restart would "stop" it and remove the file.
    await fs.writeFile(pidFile, "999999\n", "utf8");
    const common = ["--locale", "en", "--config-dir", configDir, "--launch-agent-path", path.join(tmp, "missing.plist")];

    for (const command of ["start", "pair", "restart"]) {
      const result = await runCliAs("20.19.0", [command, ...common], { HOME: tmp });
      assert.equal(result.code, 1, command);
      assert.match(result.stderr, /There is no launchd agent, so the bridge would run on the Node\.js running this command/u, command);
      assert.doesNotMatch(result.stdout, /stopped/u, command);
      assert.equal(await fs.readFile(envFile, "utf8"), envText, command);
      assert.equal(await fs.readFile(pidFile, "utf8"), "999999\n", command);
    }
  });
});

test("commands that do not pin or spawn a Node.js binary are not gated", async () => {
  const help = await runCliAs("20.19.0", ["help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /--allow-unpatched-node/u);
});

test("the MCP server warns on stderr only and keeps stdout for JSON-RPC", async () => {
  await withTmp(async (tmp) => {
    const result = await runCliAs("20.19.0", ["mcp"], { HOME: tmp });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^\[viveworker mcp\] Node\.js v20\.19\.0 is end-of-life/mu);

    const patched = await runCliAs("24.22.1", ["mcp"], { HOME: tmp });
    assert.doesNotMatch(patched.stderr, /October 2026/u);
  });
});

test("doctor reports every component pinned to an unpatched Node.js", {
  skip: process.platform === "win32" && "launchd diagnostic fixture requires a POSIX shell",
}, async () => {
  await withTmp(async (tmp) => {
    const fakeNode = path.join(tmp, "bin", "node");
    await fs.mkdir(path.dirname(fakeNode), { recursive: true });
    await fs.writeFile(fakeNode, "#!/bin/sh\necho 20.19.0\n", { mode: 0o755 });
    const launchAgentsDir = path.join(tmp, "Library", "LaunchAgents");
    await fs.mkdir(launchAgentsDir, { recursive: true });
    const bridgePlist = path.join(launchAgentsDir, "io.viveworker.app.plist");
    await fs.writeFile(bridgePlist, [
      "<plist version=\"1.0\"><dict>",
      "<key>ProgramArguments</key>",
      "<array>",
      `  <string>${fakeNode}</string>`,
      "  <string>/path/to/viveworker-bridge.mjs</string>",
      "</array>",
      "</dict></plist>",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(launchAgentsDir, "com.viveworker.moltbook-watcher.plist"),
      `<string>export PATH="${path.dirname(fakeNode)}:$PATH"; exec "${fakeNode}" "/path/to/moltbook-watcher.mjs"</string>`, "utf8");
    await fs.writeFile(path.join(launchAgentsDir, "com.viveworker.moltbook-scout.plist"),
      `<string>export PATH=&quot;${path.dirname(fakeNode)}:$PATH&quot;; &quot;/path/to/moltbook-scout-auto.sh&quot;</string>`, "utf8");
    await fs.mkdir(path.join(tmp, ".claude"), { recursive: true });
    await fs.writeFile(path.join(tmp, ".claude", "settings.json"), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: `'${fakeNode}' '/path/to/viveworker-claude-hook.mjs' --env-file '/path/config.env'` }] }] },
    }), "utf8");
    const args = ["doctor", "--locale", "en", "--config-dir", path.join(tmp, "config"), "--launch-agent-path", bridgePlist];

    const unpatched = await runCliAs("24.22.1", args, { HOME: tmp });
    assert.equal(unpatched.code, 0, unpatched.stderr);
    for (const component of ["the bridge", "the Moltbook watcher", "the Moltbook scout", "the Claude Code hooks"]) {
      assert.match(unpatched.stdout, new RegExp(`${component} runs on ${escapeRegExp(fakeNode)}\\. Node\\.js v20\\.19\\.0 is end-of-life`, "u"), component);
    }
    assert.match(unpatched.stdout, /`doctor --fix` cannot change the Node\.js version/u);

    await fs.writeFile(fakeNode, "#!/bin/sh\necho 24.22.1\n", { mode: 0o755 });
    const patched = await runCliAs("24.22.1", args, { HOME: tmp });
    assert.equal(patched.code, 0, patched.stderr);
    assert.doesNotMatch(patched.stdout, / runs on /u);
  });
});
