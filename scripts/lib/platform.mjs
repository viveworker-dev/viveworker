import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultCodexIpcEndpoint({
  platform = process.platform, uid = process.getuid?.(), tempDir = os.tmpdir(),
} = {}) {
  if (platform === "win32") return "\\\\.\\pipe\\codex-ipc";
  return path.join(tempDir, "codex-ipc", uid === undefined ? "ipc.sock" : "ipc-" + uid + ".sock");
}

export function resolveCodexIpcEndpoint(value, options = {}) {
  const endpoint = value || defaultCodexIpcEndpoint(options);
  // Preserve Windows pipe namespace syntax; it is not a filesystem location.
  if (/^\\\\[.?]\\pipe\\/iu.test(endpoint)) return endpoint;
  return path.resolve(endpoint.startsWith("~/") ? path.join(os.homedir(), endpoint.slice(2)) : endpoint);
}

export function defaultMkcertRootCaFile({
  platform = process.platform, homeDir = os.homedir(), env = process.env,
} = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const root = env.CAROOT || (platform === "win32"
    ? paths.join(env.LOCALAPPDATA || paths.join(homeDir, "AppData", "Local"), "mkcert")
    : paths.join(homeDir, "Library", "Application Support", "mkcert"));
  return paths.join(root, "rootCA.pem");
}

export async function findNativeExecutable(name, { env = process.env, platform = process.platform } = {}) {
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
  const extensions = platform === "win32" && !path.extname(name) ? [".exe", ".com"] : [""];
  for (const directory of pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/gu, ""), name + extension);
      try {
        if (!(await fs.stat(candidate)).isFile()) continue;
        await fs.access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return "";
}
