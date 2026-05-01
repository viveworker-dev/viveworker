import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function startFakeBridge(options = {}) {
  const approvalDecision = options.approvalDecision || { ok: true, approved: true, decision: "accept" };
  const events = [];
  const threadShares = [];
  const server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/threads/share") {
      if (req.headers["x-viveworker-hook-secret"] !== "test-secret") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body = await readRequestJson(req);
      threadShares.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, shareId: "thread-share-1" }));
      return;
    }

    if (req.method !== "POST" || req.url !== "/api/providers/mcp/events") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not-found" }));
      return;
    }
    if (req.headers["x-viveworker-hook-secret"] !== "test-secret") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const body = await readRequestJson(req);
    events.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    if (body.eventType === "status") {
      res.end(JSON.stringify({ ok: true, bridge: { running: true } }));
      return;
    }
    if (body.eventType === "notify") {
      res.end(JSON.stringify({ ok: true, token: "notify-token" }));
      return;
    }
    if (body.eventType === "choice_request") {
      res.end(JSON.stringify({ ok: true, decision: "answered", answerText: "Option A", answers: [{ label: "Option A" }] }));
      return;
    }
    if (body.eventType === "approval_request") {
      res.end(JSON.stringify(approvalDecision));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        events,
        threadShares,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function startMcpServer(env = {}) {
  const child = spawn(process.execPath, ["scripts/mcp-server.mjs", "serve"], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const lines = [];
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let idx;
    while ((idx = stdout.indexOf("\n")) !== -1) {
      const line = stdout.slice(0, idx);
      stdout = stdout.slice(idx + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  function nextLine() {
    const line = lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve) => waiters.push(resolve));
  }

  let id = 0;
  async function request(method, params = {}) {
    const requestId = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    const line = await nextLine();
    const response = JSON.parse(line);
    assert.equal(response.id, requestId);
    return response;
  }

  async function close() {
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
  }

  return { request, close, get stderr() { return stderr; } };
}

test("MCP server initialize, list, notify, and status", async () => {
  const bridge = await startFakeBridge();
  const mcp = startMcpServer({
    VIVEWORKER_MCP_BRIDGE_URL: bridge.baseUrl,
    VIVEWORKER_MCP_SESSION_SECRET: "test-secret",
  });
  try {
    const init = await mcp.request("initialize", { protocolVersion: "2025-11-25" });
    assert.equal(init.result.serverInfo.name, "viveworker");

    const tools = await mcp.request("tools/list");
    const names = tools.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("viveworker_status"));
    assert.ok(names.includes("viveworker_notify"));

    const notify = await mcp.request("tools/call", {
      name: "viveworker_notify",
      arguments: { title: "Hello", message: "from MCP test" },
    });
    assert.equal(notify.result.structuredContent.ok, true);
    assert.equal(bridge.events.at(-1).eventType, "notify");

    const status = await mcp.request("tools/call", {
      name: "viveworker_status",
      arguments: {},
    });
    assert.equal(status.result.structuredContent.bridge.running, true);
    assert.equal(bridge.events.at(-1).eventType, "status");
  } finally {
    await mcp.close();
    await bridge.close();
  }
});

test("MCP prompts and unknown tools", async () => {
  const bridge = await startFakeBridge();
  const mcp = startMcpServer({
    VIVEWORKER_MCP_BRIDGE_URL: bridge.baseUrl,
    VIVEWORKER_MCP_SESSION_SECRET: "test-secret",
  });
  try {
    const prompts = await mcp.request("prompts/list");
    const names = prompts.result.prompts.map((prompt) => prompt.name);
    assert.ok(names.includes("use_viveworker_control_plane"));
    assert.ok(names.includes("setup_viveworker"));
    assert.ok(names.includes("delegate_with_a2a"));

    const prompt = await mcp.request("prompts/get", { name: "share_deliverable" });
    assert.match(prompt.result.messages[0].content.text, /viveworker_share_file/);

    const unknown = await mcp.request("tools/call", {
      name: "missing_tool",
      arguments: {},
    });
    assert.equal(unknown.error.code, -32602);
  } finally {
    await mcp.close();
    await bridge.close();
  }
});

test("ask and approval tools route through the MCP provider endpoint", async () => {
  const bridge = await startFakeBridge();
  const mcp = startMcpServer({
    VIVEWORKER_MCP_BRIDGE_URL: bridge.baseUrl,
    VIVEWORKER_MCP_SESSION_SECRET: "test-secret",
  });
  try {
    const ask = await mcp.request("tools/call", {
      name: "viveworker_ask",
      arguments: {
        title: "Pick one",
        question: "Which path?",
        options: ["Option A", "Option B"],
      },
    });
    assert.equal(ask.result.structuredContent.decision, "answered");
    assert.equal(ask.result.structuredContent.answerText, "Option A");
    assert.equal(bridge.events.at(-1).eventType, "choice_request");
    assert.equal(bridge.events.at(-1).question, "Which path?");

    const approval = await mcp.request("tools/call", {
      name: "viveworker_request_approval",
      arguments: {
        title: "Ship change",
        message: "Approve this MCP smoke-test action?",
        approvalKind: "deployment",
        fileRefs: ["README.md"],
      },
    });
    assert.equal(approval.result.structuredContent.approved, true);
    assert.equal(bridge.events.at(-1).eventType, "approval_request");
    assert.equal(bridge.events.at(-1).approvalKind, "deployment");
    assert.deepEqual(bridge.events.at(-1).fileRefs, ["README.md"]);
  } finally {
    await mcp.close();
    await bridge.close();
  }
});

test("thread_share posts MCP context to the bridge thread-share endpoint", async () => {
  const bridge = await startFakeBridge();
  const mcp = startMcpServer({
    VIVEWORKER_MCP_BRIDGE_URL: bridge.baseUrl,
    VIVEWORKER_MCP_SESSION_SECRET: "test-secret",
  });
  try {
    const response = await mcp.request("tools/call", {
      name: "viveworker_thread_share",
      arguments: {
        content: "Please review this handoff.",
        targetTool: "codex",
        contextFiles: ["README.md"],
      },
    });
    assert.equal(response.result.structuredContent.ok, true);
    assert.equal(bridge.threadShares.length, 1);
    assert.equal(bridge.threadShares[0].sourceTool, "mcp");
    assert.equal(bridge.threadShares[0].targetTool, "codex");
    assert.deepEqual(bridge.threadShares[0].contextFiles, ["README.md"]);
  } finally {
    await mcp.close();
    await bridge.close();
  }
});

test("send_a2a_task reads apiKeyEnv from a2a env after phone approval", async () => {
  let seenA2A = null;
  const a2aServer = createServer(async (req, res) => {
    seenA2A = {
      method: req.method,
      url: req.url,
      apiKey: req.headers["x-a2a-key"] || "",
      body: await readRequestJson(req),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: seenA2A.body.id, result: { taskId: "task-1" } }));
  });
  await new Promise((resolve, reject) => {
    a2aServer.once("error", reject);
    a2aServer.listen(0, "127.0.0.1", resolve);
  });

  const bridge = await startFakeBridge();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-mcp-"));
  const targetsFile = path.join(tmp, "a2a-targets.json");
  const a2aEnvFile = path.join(tmp, "a2a.env");
  const a2aUrl = `http://127.0.0.1:${a2aServer.address().port}/a2a`;
  await fs.writeFile(targetsFile, JSON.stringify({ local: { url: a2aUrl, apiKeyEnv: "LOCAL_A2A_KEY" } }), "utf8");
  await fs.writeFile(a2aEnvFile, "LOCAL_A2A_KEY=test-a2a-key\n", "utf8");
  const mcp = startMcpServer({
    VIVEWORKER_MCP_BRIDGE_URL: bridge.baseUrl,
    VIVEWORKER_MCP_SESSION_SECRET: "test-secret",
    VIVEWORKER_MCP_A2A_TARGETS_FILE: targetsFile,
    VIVEWORKER_MCP_A2A_ENV_FILE: a2aEnvFile,
  });
  try {
    const response = await mcp.request("tools/call", {
      name: "viveworker_send_a2a_task",
      arguments: {
        target: "local",
        instruction: "Run an A2A MCP smoke test.",
        metadata: { smoke: true },
      },
    });
    assert.equal(response.result.structuredContent.approved, true);
    assert.deepEqual(response.result.structuredContent.result, { taskId: "task-1" });
    assert.equal(bridge.events.at(-1).approvalKind, "a2a_task");
    assert.equal(seenA2A.method, "POST");
    assert.equal(seenA2A.url, "/a2a");
    assert.equal(seenA2A.apiKey, "test-a2a-key");
    assert.equal(seenA2A.body.method, "message/send");
    assert.equal(seenA2A.body.params.message.parts[0].text, "Run an A2A MCP smoke test.");
  } finally {
    await mcp.close();
    await bridge.close();
    await new Promise((resolve) => a2aServer.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("send_a2a_task rejects non-local http targets before phone approval", async () => {
  const bridge = await startFakeBridge();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-mcp-"));
  const targetsFile = path.join(tmp, "a2a-targets.json");
  await fs.writeFile(targetsFile, JSON.stringify({ remote: { url: "http://example.test/a2a" } }), "utf8");
  const mcp = startMcpServer({
    VIVEWORKER_MCP_BRIDGE_URL: bridge.baseUrl,
    VIVEWORKER_MCP_SESSION_SECRET: "test-secret",
    VIVEWORKER_MCP_A2A_TARGETS_FILE: targetsFile,
  });
  try {
    const response = await mcp.request("tools/call", {
      name: "viveworker_send_a2a_task",
      arguments: {
        target: "remote",
        instruction: "This should not be sent.",
      },
    });
    assert.equal(response.error.code, -32603);
    assert.match(response.error.message, /must use https/i);
    assert.equal(bridge.events.length, 0);
  } finally {
    await mcp.close();
    await bridge.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("share_file rejects secret-looking workspace paths before bridge approval", async () => {
  const bridge = await startFakeBridge();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-mcp-"));
  await fs.writeFile(path.join(tmp, ".env"), "SECRET=1\n", "utf8");
  const mcp = startMcpServer({
    VIVEWORKER_MCP_BRIDGE_URL: bridge.baseUrl,
    VIVEWORKER_MCP_SESSION_SECRET: "test-secret",
  });
  try {
    const response = await mcp.request("tools/call", {
      name: "viveworker_share_file",
      arguments: { path: path.join(tmp, ".env"), workspaceRoot: tmp },
    });
    assert.equal(response.error.code, -32603);
    assert.match(response.error.message, /secret|credential/i);
    assert.equal(bridge.events.length, 0);
  } finally {
    await mcp.close();
    await bridge.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("share_file rejects unsupported file types before bridge approval", async () => {
  const bridge = await startFakeBridge();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-mcp-"));
  const markdown = path.join(tmp, "README.md");
  await fs.writeFile(markdown, "# no upload\n", "utf8");
  const mcp = startMcpServer({
    VIVEWORKER_MCP_BRIDGE_URL: bridge.baseUrl,
    VIVEWORKER_MCP_SESSION_SECRET: "test-secret",
  });
  try {
    const response = await mcp.request("tools/call", {
      name: "viveworker_share_file",
      arguments: { path: markdown, workspaceRoot: tmp },
    });
    assert.equal(response.error.code, -32603);
    assert.match(response.error.message, /accepts only/i);
    assert.equal(bridge.events.length, 0);
  } finally {
    await mcp.close();
    await bridge.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("share_file rejects symlink escape before bridge approval", async () => {
  const bridge = await startFakeBridge();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-mcp-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-mcp-outside-"));
  const outsideFile = path.join(outside, "report.txt");
  const symlinkPath = path.join(tmp, "report-link.txt");
  await fs.writeFile(outsideFile, "outside\n", "utf8");
  await fs.symlink(outsideFile, symlinkPath);
  const mcp = startMcpServer({
    VIVEWORKER_MCP_BRIDGE_URL: bridge.baseUrl,
    VIVEWORKER_MCP_SESSION_SECRET: "test-secret",
  });
  try {
    const response = await mcp.request("tools/call", {
      name: "viveworker_share_file",
      arguments: { path: symlinkPath, workspaceRoot: tmp },
    });
    assert.equal(response.error.code, -32603);
    assert.match(response.error.message, /workspace root/i);
    assert.equal(bridge.events.length, 0);
  } finally {
    await mcp.close();
    await bridge.close();
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("share_file uploads only after phone approval", async () => {
  const bridge = await startFakeBridge();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-mcp-"));
  const cliArgsFile = path.join(tmp, "fake-cli-args.json");
  const fakeCli = path.join(tmp, "fake-viveworker-cli.mjs");
  const report = path.join(tmp, "report.html");
  await fs.writeFile(report, "<!doctype html><title>report</title>\n", "utf8");
  await fs.writeFile(fakeCli, [
    "import { promises as fs } from 'node:fs';",
    "await fs.writeFile(process.env.VIVEWORKER_MCP_FAKE_CLI_ARGS, JSON.stringify(process.argv.slice(2)));",
    "console.log(JSON.stringify({ url: 'https://share.example/report', password: 'pw' }));",
  ].join("\n"), "utf8");

  const mcp = startMcpServer({
    VIVEWORKER_MCP_BRIDGE_URL: bridge.baseUrl,
    VIVEWORKER_MCP_SESSION_SECRET: "test-secret",
    VIVEWORKER_MCP_CLI: fakeCli,
    VIVEWORKER_MCP_FAKE_CLI_ARGS: cliArgsFile,
  });
  try {
    const response = await mcp.request("tools/call", {
      name: "viveworker_share_file",
      arguments: {
        path: report,
        workspaceRoot: tmp,
        password: "pw",
        expiresDays: "3",
      },
    });
    assert.equal(response.result.structuredContent.approved, true);
    assert.equal(response.result.structuredContent.share.url, "https://share.example/report");
    assert.equal(bridge.events.at(-1).approvalKind, "file_share");

    const cliArgs = JSON.parse(await fs.readFile(cliArgsFile, "utf8"));
    assert.deepEqual(cliArgs, ["share", "upload", await fs.realpath(report), "--json", "--password", "pw", "--expires-days", "3"]);
  } finally {
    await mcp.close();
    await bridge.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("share_file does not upload when phone approval is rejected", async () => {
  const bridge = await startFakeBridge({ approvalDecision: { ok: true, approved: false, decision: "reject" } });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-mcp-"));
  const cliArgsFile = path.join(tmp, "fake-cli-args.json");
  const fakeCli = path.join(tmp, "fake-viveworker-cli.mjs");
  const report = path.join(tmp, "report.html");
  await fs.writeFile(report, "<!doctype html><title>report</title>\n", "utf8");
  await fs.writeFile(fakeCli, [
    "import { promises as fs } from 'node:fs';",
    "await fs.writeFile(process.env.VIVEWORKER_MCP_FAKE_CLI_ARGS, JSON.stringify(process.argv.slice(2)));",
    "console.log(JSON.stringify({ url: 'https://share.example/report' }));",
  ].join("\n"), "utf8");

  const mcp = startMcpServer({
    VIVEWORKER_MCP_BRIDGE_URL: bridge.baseUrl,
    VIVEWORKER_MCP_SESSION_SECRET: "test-secret",
    VIVEWORKER_MCP_CLI: fakeCli,
    VIVEWORKER_MCP_FAKE_CLI_ARGS: cliArgsFile,
  });
  try {
    const response = await mcp.request("tools/call", {
      name: "viveworker_share_file",
      arguments: { path: report, workspaceRoot: tmp },
    });
    assert.equal(response.result.structuredContent.approved, false);
    assert.equal(response.result.structuredContent.decision, "reject");
    await assert.rejects(() => fs.readFile(cliArgsFile, "utf8"), /ENOENT/);
  } finally {
    await mcp.close();
    await bridge.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
