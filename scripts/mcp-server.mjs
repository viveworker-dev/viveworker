#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = "2025-11-25";
const SERVER_NAME = "viveworker";
const DEFAULT_CONFIG_FILE = path.join(os.homedir(), ".viveworker", "config.env");
const A2A_ENV_FILE = path.join(os.homedir(), ".viveworker", "a2a.env");
const A2A_TARGETS_FILE = path.join(os.homedir(), ".viveworker", "a2a-targets.json");
const DEFAULT_A2A_RELAY_URL = "https://a2a.viveworker.com";
const BRIDGE_TIMEOUT_MS = 10 * 60 * 1000;
const SHORT_TIMEOUT_MS = 15_000;
const SHARE_FILE_EXTENSIONS = new Set([".html", ".htm", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".csv"]);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const viveworkerCli = process.env.VIVEWORKER_MCP_CLI || path.join(__dirname, "viveworker.mjs");
const packageRoot = path.resolve(__dirname, "..");

export async function runMcpCli(args = []) {
  const cmd = args[0] || "serve";
  if (cmd === "config") {
    printConfigSnippets();
    return;
  }
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  if (cmd !== "serve") {
    throw new Error(`Unknown mcp command: ${cmd}`);
  }
  await runMcpServer();
}

async function runMcpServer() {
  const server = new ViveworkerMcpServer();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      writeRpc({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    try {
      await server.handleMessage(message);
    } catch (error) {
      if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
        writeRpc({
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: {
            code: Number(error?.rpcCode) || -32603,
            message: error?.message || "Internal error",
          },
        });
      } else {
        log(`notification error: ${error?.message || error}`);
      }
    }
  }
}

class ViveworkerMcpServer {
  constructor() {
    this.initialized = false;
  }

  async handleMessage(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
        writeError(message.id, -32600, "Invalid Request");
      }
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(message, "id")) {
      if (message.method === "notifications/initialized") {
        this.initialized = true;
      }
      return;
    }

    const id = message.id;
    switch (message.method) {
      case "initialize":
        return writeResult(id, await this.initialize(message.params || {}));
      case "ping":
        return writeResult(id, {});
      case "tools/list":
        return writeResult(id, { tools: TOOLS });
      case "tools/call":
        return writeResult(id, await callTool(message.params || {}));
      case "prompts/list":
        return writeResult(id, { prompts: PROMPTS.map((prompt) => prompt.definition) });
      case "prompts/get":
        return writeResult(id, getPrompt(message.params || {}));
      default:
        return writeError(id, -32601, `Method not found: ${message.method}`);
    }
  }

  async initialize(params) {
    const requested = String(params?.protocolVersion || "");
    return {
      protocolVersion: requested || PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
      },
      serverInfo: {
        name: SERVER_NAME,
        title: "viveworker MCP",
        version: await readPackageVersion(),
        websiteUrl: "https://viveworker.com",
      },
      instructions:
        "Use viveworker tools when you need to notify, ask, request approval, share a file, hand off context, or delegate an A2A task through the user's paired mobile control plane.",
    };
  }
}

async function callTool(params) {
  const name = String(params?.name || "");
  const args = isPlainObject(params?.arguments) ? params.arguments : {};
  switch (name) {
    case "viveworker_status":
      return toolOk(await bridgeEvent({ eventType: "status" }, SHORT_TIMEOUT_MS));
    case "viveworker_notify":
      return toolOk(await toolNotify(args));
    case "viveworker_ask":
      return toolOk(await toolAsk(args));
    case "viveworker_request_approval":
      return toolOk(await toolRequestApproval(args));
    case "viveworker_share_file":
      return toolOk(await toolShareFile(args));
    case "viveworker_thread_share":
      return toolOk(await toolThreadShare(args));
    case "viveworker_send_a2a_task":
      return toolOk(await toolSendA2ATask(args));
    default:
      throw rpcInvalidParams(`Unknown tool: ${name}`);
  }
}

async function toolNotify(args) {
  const title = requiredString(args.title, "title");
  const message = requiredString(args.message, "message");
  return bridgeEvent({
    eventType: "notify",
    title,
    message,
    threadLabel: optionalString(args.threadLabel) || "MCP",
  }, SHORT_TIMEOUT_MS);
}

async function toolAsk(args) {
  const question = requiredString(args.question, "question");
  const options = normalizeOptionArgs(args.options);
  return bridgeEvent({
    eventType: "choice_request",
    title: optionalString(args.title) || "MCP question",
    question,
    options,
    allowFreeform: args.allowFreeform !== false,
    timeoutMs: clampTimeout(args.timeoutMs),
  }, clampTimeout(args.timeoutMs));
}

async function toolRequestApproval(args) {
  const title = requiredString(args.title, "title");
  const message = requiredString(args.message, "message");
  const approvalKind = optionalString(args.approvalKind) || "mcp";
  return bridgeEvent({
    eventType: "approval_request",
    title,
    message,
    approvalKind,
    fileRefs: normalizeStringArray(args.fileRefs),
    diffText: optionalString(args.diffText),
    timeoutMs: clampTimeout(args.timeoutMs),
  }, clampTimeout(args.timeoutMs));
}

async function toolShareFile(args) {
  const requestedPath = requiredString(args.path, "path");
  const workspaceRoot = optionalString(args.workspaceRoot) || process.env.VIVEWORKER_MCP_WORKSPACE_ROOT || process.cwd();
  const file = await validateSharePath(requestedPath, workspaceRoot);
  const stat = await fs.stat(file.realPath);
  const approval = await bridgeEvent({
    eventType: "approval_request",
    title: "Share file with viveworker File Share",
    message: [
      "An MCP client wants to upload a local file to viveworker File Share.",
      "",
      `File: ${file.displayPath}`,
      `Size: ${stat.size} bytes`,
      "",
      "Approve only if this file is safe to send outside this Mac.",
    ].join("\n"),
    approvalKind: "file_share",
    fileRefs: [file.displayPath],
    timeoutMs: clampTimeout(args.timeoutMs),
  }, clampTimeout(args.timeoutMs));
  if (!approval.approved) {
    return { approved: false, decision: approval.decision || "rejected" };
  }

  const uploadArgs = ["share", "upload", file.realPath, "--json"];
  const password = optionalString(args.password);
  const expiresDays = optionalString(args.expiresDays ?? args["expires-days"]);
  if (password) uploadArgs.push("--password", password);
  if (expiresDays) uploadArgs.push("--expires-days", expiresDays);
  const upload = await runViveworkerCliJson(uploadArgs, 90_000);
  return { approved: true, share: upload };
}

async function toolThreadShare(args) {
  const content = requiredString(args.content, "content");
  const targetConversationId = optionalString(args.targetConversationId);
  const targetTool = optionalString(args.targetTool);
  if (!targetConversationId && !targetTool) {
    throw rpcInvalidParams("targetConversationId or targetTool is required");
  }
  const result = await postBridgeJson("/api/threads/share", {
    shareType: optionalString(args.shareType) || "message",
    content,
    sourceTool: "mcp",
    sourceLabel: optionalString(args.sourceLabel) || "MCP",
    targetConversationId,
    targetTool,
    targetCwd: optionalString(args.targetCwd),
    contextFiles: normalizeStringArray(args.contextFiles),
  }, SHORT_TIMEOUT_MS);
  return result.body;
}

async function toolSendA2ATask(args) {
  const target = requiredString(args.target, "target");
  const instruction = requiredString(args.instruction, "instruction");
  const resolved = await resolveA2ATarget(target);
  const approval = await bridgeEvent({
    eventType: "approval_request",
    title: `Send A2A task to ${target}`,
    message: [
      "An MCP client wants to send this task to a registered A2A target.",
      "",
      `Target: ${target}`,
      "",
      instruction,
    ].join("\n"),
    approvalKind: "a2a_task",
    timeoutMs: clampTimeout(args.timeoutMs),
  }, clampTimeout(args.timeoutMs));
  if (!approval.approved) {
    return { approved: false, decision: approval.decision || "rejected" };
  }
  const result = await sendA2AMessage(resolved, instruction, {
    metadata: isPlainObject(args.metadata) ? args.metadata : {},
  });
  return { approved: true, target, result };
}

async function bridgeEvent(body, timeoutMs) {
  const res = await postBridgeJson("/api/providers/mcp/events", body, timeoutMs);
  return res.body;
}

async function postBridgeJson(pathname, body, timeoutMs) {
  const bridge = await resolveBridgeConfig();
  if (!bridge.baseUrl || !bridge.sessionSecret) {
    throw new Error("viveworker bridge config missing. Run `npx viveworker setup` first.");
  }
  const endpoint = `${bridge.baseUrl}${pathname}`;
  const result = await httpJson(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-viveworker-hook-secret": bridge.sessionSecret,
    },
    body: JSON.stringify(body),
    timeoutMs,
    rejectUnauthorized: shouldVerifyTls(endpoint),
  });
  if (!result.ok) {
    throw new Error(`bridge request failed (${result.status}): ${formatBridgeError(result.body)}`);
  }
  return result;
}

async function resolveBridgeConfig() {
  const envText = await readOptionalFile(process.env.VIVEWORKER_CONFIG_ENV || DEFAULT_CONFIG_FILE);
  const publicBaseUrl = (
    process.env.VIVEWORKER_MCP_BRIDGE_URL ||
    process.env.VIVEWORKER_APPROVAL_BRIDGE_URL ||
    envValue(envText, "VIVEWORKER_MCP_BRIDGE_URL") ||
    envValue(envText, "VIVEWORKER_APPROVAL_BRIDGE_URL") ||
    envValue(envText, "NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL") ||
    ""
  ).replace(/\/$/u, "");
  const port = process.env.NATIVE_APPROVAL_SERVER_PORT || envValue(envText, "NATIVE_APPROVAL_SERVER_PORT") || "";
  const protocol = publicBaseUrl.startsWith("https:") ? "https" : "http";
  const baseUrl = (
    process.env.VIVEWORKER_MCP_BRIDGE_URL ||
    process.env.VIVEWORKER_APPROVAL_BRIDGE_URL ||
    (port ? `${protocol}://127.0.0.1:${port}` : publicBaseUrl)
  ).replace(/\/$/u, "");
  const sessionSecret = (
    process.env.VIVEWORKER_MCP_SESSION_SECRET ||
    process.env.SESSION_SECRET ||
    envValue(envText, "SESSION_SECRET") ||
    ""
  ).trim();
  return { baseUrl, sessionSecret };
}

function httpJson(endpoint, options) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch {
      resolve({ ok: false, status: 0, body: { error: "invalid-url" } });
      return;
    }
    const payload = options.body || "";
    const isHttps = parsed.protocol === "https:";
    const req = (isHttps ? https : http).request({
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : isHttps ? 443 : 80,
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers: {
        ...(options.headers || {}),
        ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
      },
      rejectUnauthorized: options.rejectUnauthorized !== false,
    }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let body = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          body = { error: text.slice(0, 500) };
        }
        resolve({ ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, status: res.statusCode || 0, body });
      });
    });
    const timer = setTimeout(() => {
      req.destroy(new Error("request-timeout"));
    }, Math.max(1000, Number(options.timeoutMs) || SHORT_TIMEOUT_MS));
    req.on("close", () => clearTimeout(timer));
    req.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, status: 0, body: { error: error.message || "request-failed" } });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function validateSharePath(filePath, workspaceRoot) {
  const root = path.resolve(String(workspaceRoot || ""));
  const candidate = path.resolve(String(filePath || ""));
  const [rootReal, fileReal] = await Promise.all([
    fs.realpath(root),
    fs.realpath(candidate),
  ]);
  const rel = path.relative(rootReal, fileReal);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("share_file is limited to the current workspace root");
  }
  const stat = await fs.stat(fileReal);
  if (!stat.isFile()) {
    throw new Error("share_file path must be a regular file");
  }
  assertNotSensitivePath(rel || path.basename(fileReal));
  const ext = path.extname(fileReal).toLowerCase();
  if (!SHARE_FILE_EXTENSIONS.has(ext)) {
    throw new Error(`share_file accepts only ${Array.from(SHARE_FILE_EXTENSIONS).join(" / ")} files. Got: ${ext || "(no extension)"}`);
  }
  return {
    realPath: fileReal,
    displayPath: path.join(rootReal, rel),
  };
}

function assertNotSensitivePath(relPath) {
  const parts = String(relPath || "").split(/[\\/]+/u).map((part) => part.toLowerCase());
  const deniedExact = new Set([
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
  ]);
  for (const part of parts) {
    if (!part) continue;
    if (part === ".ssh" || part === ".aws" || part === ".gnupg") {
      throw new Error("share_file refuses credential directories");
    }
    if (deniedExact.has(part) || part.endsWith(".pem") || part.endsWith(".key") || part.includes("secret") || part.includes("credential") || part.includes("private-key")) {
      throw new Error("share_file refuses paths that look like secrets or credentials");
    }
  }
}

function runViveworkerCliJson(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [viveworkerCli, ...args], {
      cwd: packageRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("viveworker CLI timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout || `viveworker CLI failed with code ${code}`).trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`viveworker CLI returned non-JSON: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

async function resolveA2ATarget(alias) {
  const targets = await readA2ATargets();
  const entry = targets[alias];
  if (!entry || typeof entry !== "object") {
    throw new Error(`A2A target not found: ${alias}. Add it to ${A2A_TARGETS_FILE}.`);
  }
  const url = String(entry.url || entry.endpoint || "").trim().replace(/\/$/u, "");
  if (!url || !/^https?:\/\//u.test(url)) {
    throw new Error(`A2A target ${alias} is missing a valid url`);
  }
  assertSafeA2ATargetUrl(url, alias);
  if (entry.apiKey) {
    throw new Error(`A2A target ${alias} uses inline apiKey; use apiKeyEnv instead`);
  }
  const apiKeyEnv = String(entry.apiKeyEnv || defaultA2AApiKeyEnv(alias)).trim();
  const a2aEnvText = await readOptionalFile(process.env.VIVEWORKER_MCP_A2A_ENV_FILE || A2A_ENV_FILE);
  const apiKey = apiKeyEnv ? String(process.env[apiKeyEnv] || envValue(a2aEnvText, apiKeyEnv) || "").trim() : "";
  return { url, apiKey, apiKeyEnv };
}

async function readA2ATargets() {
  const targetsFile = process.env.VIVEWORKER_MCP_A2A_TARGETS_FILE || A2A_TARGETS_FILE;
  try {
    return JSON.parse(await fs.readFile(targetsFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function defaultA2AApiKeyEnv(alias) {
  return `VIVEWORKER_A2A_TARGET_${String(alias || "").toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_KEY`;
}

function assertSafeA2ATargetUrl(url, alias) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`A2A target ${alias} is missing a valid url`);
  }
  if (parsed.protocol === "https:") {
    return;
  }
  if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
    return;
  }
  throw new Error(`A2A target ${alias} must use https, except localhost/127.0.0.1 development targets`);
}

function shouldVerifyTls(endpoint) {
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:") return true;
    return !isLocalBridgeHostname(parsed.hostname);
  } catch {
    return true;
  }
}

function isLocalBridgeHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return isLoopbackHostname(normalized) || normalized.endsWith(".local");
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

async function sendA2AMessage(target, instruction, options = {}) {
  const id = crypto.randomUUID();
  const headers = { "content-type": "application/json" };
  if (target.apiKey) headers["x-a2a-key"] = target.apiKey;
  const result = await httpJson(target.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ type: "text", text: instruction }],
          metadata: options.metadata || {},
        },
      },
    }),
    timeoutMs: 30_000,
  });
  if (!result.ok || result.body?.error) {
    throw new Error(`A2A task failed (${result.status}): ${formatBridgeError(result.body)}`);
  }
  return result.body.result ?? result.body;
}

function normalizeOptionArgs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => {
      if (typeof entry === "string") return { label: entry };
      if (!isPlainObject(entry)) return null;
      const label = optionalString(entry.label) || optionalString(entry.title) || `Option ${index + 1}`;
      return {
        label,
        description: optionalString(entry.description) || optionalString(entry.detail),
      };
    })
    .filter(Boolean);
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function requiredString(value, name) {
  const text = optionalString(value);
  if (!text) throw rpcInvalidParams(`${name} is required`);
  return text;
}

function optionalString(value) {
  if (value == null) return "";
  return String(value).trim();
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return BRIDGE_TIMEOUT_MS;
  return Math.max(10_000, Math.min(900_000, Math.floor(n)));
}

function toolOk(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError: false,
  };
}

function getPrompt(params) {
  const name = String(params?.name || "");
  const prompt = PROMPTS.find((entry) => entry.definition.name === name);
  if (!prompt) throw rpcInvalidParams(`Unknown prompt: ${name}`);
  return {
    description: prompt.definition.description,
    messages: [
      {
        role: "user",
        content: { type: "text", text: prompt.text },
      },
    ],
  };
}

function writeResult(id, result) {
  writeRpc({ jsonrpc: "2.0", id, result });
}

function writeError(id, code, message, data = undefined) {
  writeRpc({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

function writeRpc(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(message) {
  process.stderr.write(`[viveworker-mcp] ${message}\n`);
}

function rpcInvalidParams(message) {
  const error = new Error(message);
  error.rpcCode = -32602;
  return error;
}

function formatBridgeError(body) {
  if (!body || typeof body !== "object") return "unknown error";
  if (body.error?.message) return body.error.message;
  if (body.error) return String(body.error);
  return JSON.stringify(body).slice(0, 500);
}

async function readOptionalFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readPackageVersion() {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function envValue(text, key) {
  for (const line of String(text || "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) !== key) continue;
    return unquoteEnvValue(trimmed.slice(eq + 1).trim());
  }
  return "";
}

function unquoteEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function printConfigSnippets() {
  const snippet = {
    mcpServers: {
      viveworker: {
        command: "npx",
        args: ["viveworker", "mcp"],
      },
    },
  };
  console.log("Automatic install:");
  console.log("  npx viveworker enable mcp --target claude");
  console.log("  npx viveworker enable mcp --target cursor");
  console.log("  npx viveworker enable mcp --target codex");
  console.log("");
  console.log("Claude Desktop / Cursor / Codex MCP config:");
  console.log(JSON.stringify(snippet, null, 2));
}

function printHelp() {
  console.log("Usage:");
  console.log("  viveworker mcp          Start the stdio MCP server");
  console.log("  viveworker mcp config   Print MCP client config snippets");
}

const TOOLS = [
  {
    name: "viveworker_status",
    title: "viveworker status",
    description: "Return bridge, pairing, remote connection, A2A, and File Share status.",
    inputSchema: { type: "object", additionalProperties: false },
  },
  {
    name: "viveworker_notify",
    title: "Notify phone",
    description: "Send an informational notification to the paired phone and leave it in the timeline.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        message: { type: "string" },
        threadLabel: { type: "string" },
      },
      required: ["title", "message"],
    },
  },
  {
    name: "viveworker_ask",
    title: "Ask on phone",
    description: "Ask the paired phone a question and wait for the user's answer.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        question: { type: "string" },
        options: {
          type: "array",
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label"],
              },
            ],
          },
        },
        allowFreeform: { type: "boolean" },
        timeoutMs: { type: "number" },
      },
      required: ["question"],
    },
  },
  {
    name: "viveworker_request_approval",
    title: "Request approval",
    description: "Ask the paired phone to approve or reject a proposed action. This tool does not execute the action.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        message: { type: "string" },
        approvalKind: { type: "string" },
        fileRefs: { type: "array", items: { type: "string" } },
        diffText: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["title", "message"],
    },
  },
  {
    name: "viveworker_share_file",
    title: "Share file",
    description: "After phone approval, upload a workspace file to viveworker File Share and return the limited URL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        workspaceRoot: { type: "string" },
        password: { type: "string" },
        expiresDays: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["path"],
    },
  },
  {
    name: "viveworker_thread_share",
    title: "Thread share",
    description: "Create a phone-approved Thread Share request to Codex, Claude, or the viveworker inbox.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        content: { type: "string" },
        targetConversationId: { type: "string" },
        targetTool: { type: "string" },
        targetCwd: { type: "string" },
        sourceLabel: { type: "string" },
        shareType: { type: "string" },
        contextFiles: { type: "array", items: { type: "string" } },
      },
      required: ["content"],
    },
  },
  {
    name: "viveworker_send_a2a_task",
    title: "Send A2A task",
    description: "After phone approval, send a task to a registered A2A target alias from ~/.viveworker/a2a-targets.json.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: { type: "string" },
        instruction: { type: "string" },
        metadata: { type: "object" },
        timeoutMs: { type: "number" },
      },
      required: ["target", "instruction"],
    },
  },
];

const PROMPTS = [
  {
    definition: {
      name: "use_viveworker_control_plane",
      title: "Use viveworker control plane",
      description: "Instruct the model to route human approvals, questions, sharing, and delegation through viveworker when useful.",
    },
    text: "Use viveworker as the mobile control plane when work needs human confirmation, a quick question, a file-share handoff, thread sharing, or A2A delegation. Prefer asking or requesting approval over guessing for irreversible, external, or sensitive actions.",
  },
  {
    definition: {
      name: "ask_before_risky_action",
      title: "Ask before risky action",
      description: "Ask the phone before proceeding with a risky or externally visible action.",
    },
    text: "Before you perform an action that is externally visible, hard to undo, or could expose local content, call viveworker_request_approval with a concise summary of the action and the concrete risk.",
  },
  {
    definition: {
      name: "share_deliverable",
      title: "Share deliverable",
      description: "Package a local deliverable through viveworker File Share with phone approval.",
    },
    text: "When the user asks to share a report, prototype, screenshot, CSV, or standalone HTML deliverable, use viveworker_share_file. Only share files inside the workspace and never share secrets or credentials.",
  },
  {
    definition: {
      name: "delegate_with_a2a",
      title: "Delegate with A2A",
      description: "Delegate suitable work to a registered A2A target through viveworker.",
    },
    text: "When another registered agent is a better fit for a bounded task, call viveworker_send_a2a_task with the target alias and a self-contained instruction. Keep the task scoped and include acceptance criteria.",
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  runMcpCli(process.argv.slice(2)).catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}
