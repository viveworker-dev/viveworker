import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultCodexIpcEndpoint, resolveCodexIpcEndpoint, defaultMkcertRootCaFile, findNativeExecutable } from "../lib/platform.mjs";

test("Windows Codex uses the named pipe namespace, including explicit overrides", () => {
  assert.equal(defaultCodexIpcEndpoint({ platform: "win32" }), "\\\\.\\pipe\\codex-ipc");
  assert.equal(resolveCodexIpcEndpoint("\\\\.\\pipe\\custom-ipc"), "\\\\.\\pipe\\custom-ipc");
  assert.equal(resolveCodexIpcEndpoint("\\\\?\\pipe\\custom-ipc"), "\\\\?\\pipe\\custom-ipc");
});

test("Unix socket defaults preserve uid zero and non-root users", () => {
  assert.equal(defaultCodexIpcEndpoint({ platform: "darwin", uid: 0, tempDir: "/tmp" }), path.join("/tmp", "codex-ipc", "ipc-0.sock"));
  assert.equal(defaultCodexIpcEndpoint({ platform: "darwin", uid: 501, tempDir: "/tmp" }), path.join("/tmp", "codex-ipc", "ipc-501.sock"));
});

test("Windows mkcert paths honor CAROOT and LOCALAPPDATA", () => {
  assert.equal(defaultMkcertRootCaFile({ platform: "win32", env: { CAROOT: "D:\\Certificates" } }), "D:\\Certificates\\rootCA.pem");
  assert.equal(defaultMkcertRootCaFile({ platform: "win32", env: { LOCALAPPDATA: "C:\\Local" } }), "C:\\Local\\mkcert\\rootCA.pem");
});

test("native executable discovery handles Windows Path casing and quoted directories", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-exe-"));
  const directory = path.join(tmp, "日本語 tools");
  try {
    await fs.mkdir(directory);
    const executable = path.join(directory, "mkcert.exe");
    await fs.writeFile(executable, "fixture");
    assert.equal(await findNativeExecutable("mkcert", { platform: "win32", env: { Path: '"' + directory + '"' } }), executable);
    assert.equal(await findNativeExecutable("missing", { platform: "win32", env: { Path: directory } }), "");
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
