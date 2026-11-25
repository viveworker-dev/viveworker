import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Local mode pins this checkout and runtime; it must not depend on npx or PATH.
export function createMcpServerConfig({
  platform = process.platform,
  local = false,
  nodePath = process.execPath,
  serverPath = fileURLToPath(new URL("../mcp-server.mjs", import.meta.url)),
} = {}) {
  if (local) {
    return { command: nodePath, args: [serverPath] };
  }
  // npx is a .cmd shim on Windows and cannot be spawned as an executable.
  if (platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/c", "npx", "-y", "viveworker", "mcp"] };
  }
  return { command: "npx", args: ["viveworker", "mcp"] };
}

export function defaultMcpConfigPath(target, {
  platform = process.platform,
  homeDir = os.homedir(),
  env = process.env,
} = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  switch (target) {
    case "claude":
      return platform === "win32"
        ? paths.join(env.APPDATA || paths.join(homeDir, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
        : paths.join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "cursor":
      return paths.join(homeDir, ".cursor", "mcp.json");
    case "codex":
      return paths.join(env.CODEX_HOME || paths.join(homeDir, ".codex"), "config.toml");
    default:
      throw new Error(`Unknown MCP client: ${target}`);
  }
}
