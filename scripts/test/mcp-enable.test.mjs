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

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/viveworker.mjs", ...args], {
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

test("enable mcp dry-run prints changes without writing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-mcp-enable-"));
  const claudeConfig = path.join(tmp, "Claude", "claude_desktop_config.json");
  await fs.mkdir(path.dirname(claudeConfig), { recursive: true });
  const env = { VIVEWORKER_MCP_CLAUDE_CONFIG_FILE: claudeConfig };
  try {
    const result = await runCli(["enable", "mcp", "--target", "claude", "--dry-run"], env);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Claude Desktop/);
    assert.match(result.stdout, /Dry run only/);
    await assert.rejects(() => fs.readFile(claudeConfig, "utf8"), /ENOENT/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("enable mcp writes JSON and Codex TOML configs idempotently", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-mcp-enable-"));
  const cursorConfig = path.join(tmp, "Cursor", "mcp.json");
  const codexConfig = path.join(tmp, "Codex", "config.toml");
  await fs.mkdir(path.dirname(cursorConfig), { recursive: true });
  await fs.mkdir(path.dirname(codexConfig), { recursive: true });
  await fs.writeFile(codexConfig, "model = \"gpt-5.5\"\n\n[mcp_servers.docs]\nurl = \"https://example.test/mcp\"\n", "utf8");
  const env = {
    VIVEWORKER_MCP_CURSOR_CONFIG_FILE: cursorConfig,
    VIVEWORKER_MCP_CODEX_CONFIG_FILE: codexConfig,
  };
  try {
    const cursor = await runCli(["enable", "mcp", "--target", "cursor", "--yes"], env);
    assert.equal(cursor.code, 0, cursor.stderr);
    const cursorJson = JSON.parse(await fs.readFile(cursorConfig, "utf8"));
    assert.deepEqual(cursorJson.mcpServers.viveworker, {
      command: "npx",
      args: ["viveworker", "mcp"],
    });

    const codex = await runCli(["enable", "mcp", "--target", "codex", "--yes"], env);
    assert.equal(codex.code, 0, codex.stderr);
    const codexText = await fs.readFile(codexConfig, "utf8");
    assert.match(codexText, /model = "gpt-5\.5"/);
    assert.match(codexText, /\[mcp_servers\.docs\]/);
    assert.match(codexText, /\[mcp_servers\.viveworker\]/);
    assert.match(codexText, /command = "npx"/);
    assert.match(codexText, /args = \["viveworker", "mcp"\]/);

    const second = await runCli(["enable", "mcp", "--target", "codex", "--yes"], env);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /already up to date/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
