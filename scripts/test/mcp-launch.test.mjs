import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpServerConfig } from "../lib/mcp-config.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8", timeout: 10_000, windowsHide: true,
    ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function assertHandshake(output) {
  const messages = output.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(messages.length, 1, output);
  assert.equal(messages[0].id, 1);
  assert.equal(messages[0].result.serverInfo.name, "viveworker");
}

test("local MCP config starts without npx or PATH from another working directory", () => {
  const config = createMcpServerConfig({ local: true });
  assertHandshake(run(config.command, config.args, {
    cwd: os.tmpdir(), env: { ...process.env, PATH: "" }, input: initialize,
  }));
  assertHandshake(run(process.execPath, [path.join(repoRoot, "scripts", "viveworker.mjs"), "mcp"], {
    cwd: os.tmpdir(), input: initialize,
  }));
});

test("local config registration preserves other settings and produces runnable JSON and TOML", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-local-mcp-"));
  const cursorConfig = path.join(tmp, "cursor.json");
  const codexHome = path.join(tmp, "Codex Profile");
  const cli = path.join(repoRoot, "scripts", "viveworker.mjs");
  const env = {
    ...process.env,
    VIVEWORKER_MCP_CURSOR_CONFIG_FILE: cursorConfig,
    VIVEWORKER_MCP_CODEX_CONFIG_FILE: "",
    CODEX_HOME: codexHome,
  };
  const original = { theme: "dark", mcpServers: { docs: { url: "https://example.test/mcp" } } };
  try {
    await fs.writeFile(cursorConfig, JSON.stringify(original));
    const args = ["enable", "mcp", "--local", "--yes", "--allow-unpatched-node", "--target"];
    run(process.execPath, [cli, ...args, "cursor"], { env });
    const data = JSON.parse(await fs.readFile(cursorConfig, "utf8"));
    assert.equal(data.theme, original.theme);
    assert.deepEqual(data.mcpServers.docs, original.mcpServers.docs);
    const saved = data.mcpServers.viveworker;
    assert.equal(saved.command, process.execPath);
    assert.deepEqual(saved.args, [path.join(repoRoot, "scripts", "mcp-server.mjs")]);
    assertHandshake(run(saved.command, saved.args, { cwd: tmp, input: initialize }));
    assert.match(run(process.execPath, [cli, ...args, "cursor"], { env }), /already up to date/u);

    run(process.execPath, [cli, ...args, "codex"], { env });
    const toml = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
    assert.equal(JSON.parse(toml.match(/^command = (.+)$/mu)[1]), saved.command);
    assert.deepEqual(JSON.parse(toml.match(/^args = (.+)$/mu)[1]), saved.args);
    const printed = run(process.execPath, [cli, "mcp", "config", "--local"]);
    assert.ok(printed.includes(toml.trim()));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("direct MCP entry point works in paths containing spaces, Unicode and URL characters", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-path-"));
  const checkout = path.join(tmp, "日本語 MCP & test #1");
  try {
    // A minimal checkout is sufficient: the MCP transport needs no npm packages.
    for (const file of ["package.json", "scripts/mcp-server.mjs", "scripts/lib/mcp-config.mjs", "scripts/lib/node-runtime.mjs"]) {
      const target = path.join(checkout, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(repoRoot, file), target);
    }
    assertHandshake(run(process.execPath, [path.join(checkout, "scripts", "mcp-server.mjs")], {
      cwd: tmp, input: initialize,
    }));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Windows package configuration executes npx.cmd with the expected arguments", {
  skip: process.platform !== "win32" && "Windows command shim",
}, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-cmd-"));
  try {
    await fs.writeFile(path.join(tmp, "npx.cmd"), "@echo off\r\necho %*\r\n");
    const config = createMcpServerConfig();
    assert.equal(run(config.command, config.args, { cwd: tmp }).trim(), "-y viveworker mcp");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
