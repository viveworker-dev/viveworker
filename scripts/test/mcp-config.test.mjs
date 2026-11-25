import test from "node:test";
import assert from "node:assert/strict";
import { createMcpServerConfig, defaultMcpConfigPath } from "../lib/mcp-config.mjs";

test("Windows MCP configuration invokes the npx shim through cmd without prompts", () => {
  assert.deepEqual(createMcpServerConfig({ platform: "win32" }), {
    command: "cmd.exe",
    args: ["/d", "/c", "npx", "-y", "viveworker", "mcp"],
  });
  assert.deepEqual(createMcpServerConfig({ platform: "darwin" }), {
    command: "npx", args: ["viveworker", "mcp"],
  });
});

test("local MCP configuration preserves paths with spaces and shell metacharacters", () => {
  const nodePath = "C:/Program Files/nodejs/node.exe";
  const serverPath = "C:/Users/開発者/work/vive & worker #1/scripts/mcp-server.mjs";
  assert.deepEqual(createMcpServerConfig({ platform: "win32", local: true, nodePath, serverPath }), {
    command: nodePath, args: [serverPath],
  });
});

test("Windows Claude config follows APPDATA and falls back to the user profile", () => {
  const options = { platform: "win32", homeDir: "C:/Users/開発者", env: { APPDATA: "D:/Roaming Profile" } };
  assert.equal(defaultMcpConfigPath("claude", options).replaceAll("\\", "/"),
    "D:/Roaming Profile/Claude/claude_desktop_config.json");
  assert.equal(defaultMcpConfigPath("claude", { ...options, env: {} }).replaceAll("\\", "/"),
    "C:/Users/開発者/AppData/Roaming/Claude/claude_desktop_config.json");
  assert.equal(defaultMcpConfigPath("cursor", options).replaceAll("\\", "/"),
    "C:/Users/開発者/.cursor/mcp.json");
});

test("Codex config honors CODEX_HOME on both platforms", () => {
  assert.equal(defaultMcpConfigPath("codex", {
    platform: "win32", homeDir: "C:/Users/test", env: { CODEX_HOME: "D:/Codex Profile" },
  }).replaceAll("\\", "/"), "D:/Codex Profile/config.toml");
  assert.equal(defaultMcpConfigPath("codex", {
    platform: "darwin", homeDir: "/Users/test", env: { CODEX_HOME: "/custom/codex" },
  }), "/custom/codex/config.toml");
  assert.equal(defaultMcpConfigPath("codex", {
    platform: "darwin", homeDir: "/Users/test", env: {},
  }), "/Users/test/.codex/config.toml");
  assert.equal(defaultMcpConfigPath("claude", {
    platform: "darwin", homeDir: "/Users/test", env: {},
  }), "/Users/test/Library/Application Support/Claude/claude_desktop_config.json");
});
