/**
 * a2a-handler.mjs — Agent2Agent (A2A) Protocol handler for viveworker bridge.
 *
 * Implements a minimal A2A server (JSON-RPC 2.0) that:
 *   - Publishes an Agent Card at /.well-known/agent.json
 *   - Accepts tasks via message/send
 *   - Returns task status via tasks/get
 *   - Cancels tasks via tasks/cancel
 *
 * All tasks require user approval through the PWA before execution.
 */

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Agent Card
// ---------------------------------------------------------------------------

export function buildAgentCard(config) {
  const baseUrl = config.a2aPublicUrl || config.publicBaseUrl || `http://localhost:${config.port || 7860}`;

  // Custom description from A2A_DESCRIPTION env var (set during setup)
  const description = config.a2aDescription ||
    "LAN-connected AI companion that bridges Codex and Claude Desktop. " +
    "Can execute coding tasks, file operations, and code reviews with human approval.";

  // Custom skills from A2A_SKILLS env var (comma-separated tags → skill objects)
  let skills;
  if (config.a2aSkills) {
    const LABEL_MAP = {
      typescript: "TypeScript", javascript: "JavaScript",
      nodejs: "Node.js", pwa: "PWA", api: "API", css: "CSS", html: "HTML",
      sql: "SQL", graphql: "GraphQL", nextjs: "Next.js", vuejs: "Vue.js",
      aws: "AWS", gcp: "GCP", cli: "CLI", cicd: "CI/CD", a2a: "A2A",
      llm: "LLM", ai: "AI", ml: "ML",
    };
    skills = config.a2aSkills.split(",").map((s) => s.trim()).filter(Boolean).map((tag) => {
      const label = LABEL_MAP[tag] || tag.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      return { id: tag, name: label, description: label };
    });
  } else {
    skills = [
      {
        id: "code-task",
        name: "Code Task",
        description: "Execute a coding task via Codex or Claude (with human approval)",
        inputSchema: {
          type: "object",
          properties: { instruction: { type: "string" } },
          required: ["instruction"],
        },
      },
      {
        id: "code-review",
        name: "Code Review",
        description: "Review code or a pull request (with human approval)",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string" },
            context: { type: "string" },
          },
          required: ["target"],
        },
      },
    ];
  }

  const card = {
    schemaVersion: "1.0",
    humanReadableId: `viveworker/${config.a2aRelayUserId || "viveworker"}`,
    agentVersion: config.version || "0.1.0",
    name: "viveworker",
    description,
    url: `${baseUrl.replace(/\/$/u, "")}/a2a`,
    provider: { name: "viveworker" },
    capabilities: {
      a2aVersion: "0.2.3",
      streaming: false,
      pushNotifications: false,
    },
    skills,
    authSchemes: [{ scheme: "apiKey", in: "header", name: "X-A2A-Key" }],
  };
  if (config.a2aAvatar) card.avatar = config.a2aAvatar;
  return card;
}

// ---------------------------------------------------------------------------
// Rate limiter (per-IP, in-memory)
// ---------------------------------------------------------------------------

const rateBuckets = new Map(); // ip → { count, resetAtMs }
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;

function checkRateLimit(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAtMs) {
    bucket = { count: 0, resetAtMs: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  return bucket.count <= RATE_MAX;
}

// Sweep stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now >= bucket.resetAtMs) rateBuckets.delete(ip);
  }
}, 5 * 60_000).unref?.();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PENDING_TASKS = 5;
const MAX_BODY_BYTES = 10_240; // 10 KB

// A2A task statuses
const STATUS = {
  SUBMITTED: "submitted",
  WORKING: "working",
  INPUT_REQUIRED: "input-required",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELED: "canceled",
  REJECTED: "rejected",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function taskId() {
  return crypto.randomUUID();
}

function jsonRpcResponse(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id, code, message, data) {
  const err = { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
  if (data !== undefined) err.error.data = data;
  return err;
}

function extractTextFromParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p && p.type === "text")
    .map((p) => String(p.text || ""))
    .join("\n")
    .trim();
}

function buildTaskResponse(task) {
  return {
    id: task.id,
    contextId: task.contextId,
    status: {
      state: task.status,
      ...(task.statusMessage ? { message: { role: "agent", parts: [{ type: "text", text: task.statusMessage }] } } : {}),
    },
    ...(task.artifacts.length > 0 ? { artifacts: task.artifacts } : {}),
    history: task.messages,
  };
}

// ---------------------------------------------------------------------------
// A2A request handler (called from bridge)
// ---------------------------------------------------------------------------

/**
 * @param {object}   params
 * @param {object}   params.req          - Node HTTP IncomingMessage
 * @param {object}   params.res          - Node HTTP ServerResponse
 * @param {object}   params.body         - Parsed JSON-RPC request body
 * @param {object}   params.config       - Bridge config
 * @param {object}   params.runtime      - Bridge runtime state (Maps)
 * @param {object}   params.state        - Persistent state
 * @param {Function} params.writeJson    - writeJson(res, status, body)
 * @param {Function} params.recordTimelineEntry  - recordTimelineEntry({config,runtime,state,entry})
 * @param {Function} params.deliverWebPushItem   - deliverWebPushItem({config,state,...})
 * @param {Function} params.saveState    - saveState(stateFile, state)
 * @param {Function} params.historyToken - historyToken(stableId) → token string
 * @param {Function} params.cleanText    - cleanText(value) → sanitised string
 */
export async function handleA2ARequest({
  req,
  res,
  body,
  config,
  runtime,
  state,
  writeJson,
  recordTimelineEntry,
  deliverWebPushItem,
  saveState,
  historyToken,
  cleanText,
}) {
  // --- Auth ---
  const apiKey = req.headers["x-a2a-key"] || "";
  if (!config.a2aApiKey || apiKey !== config.a2aApiKey) {
    return writeJson(res, 401, jsonRpcError(body?.id, -32000, "Unauthorized: invalid or missing X-A2A-Key"));
  }

  // --- Rate limit ---
  const clientIp = req.socket?.remoteAddress || "unknown";
  if (!checkRateLimit(clientIp)) {
    return writeJson(res, 429, jsonRpcError(body?.id, -32000, "Rate limit exceeded (max 10 req/min)"));
  }

  // --- JSON-RPC envelope validation ---
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return writeJson(res, 400, jsonRpcError(body?.id, -32600, "Invalid JSON-RPC 2.0 request"));
  }

  const method = body.method;
  const params = body.params || {};
  const rpcId = body.id;

  switch (method) {
    case "message/send":
      return handleMessageSend({ rpcId, params, req, config, runtime, state, res, writeJson, recordTimelineEntry, deliverWebPushItem, saveState, historyToken, cleanText });
    case "tasks/get":
      return handleTasksGet({ rpcId, params, runtime, res, writeJson });
    case "tasks/cancel":
      return handleTasksCancel({ rpcId, params, runtime, res, writeJson });
    default:
      return writeJson(res, 200, jsonRpcError(rpcId, -32601, `Method not found: ${method}`));
  }
}

// ---------------------------------------------------------------------------
// message/send
// ---------------------------------------------------------------------------

async function handleMessageSend({
  rpcId, params, req, config, runtime, state, res, writeJson,
  recordTimelineEntry, deliverWebPushItem, saveState, historyToken, cleanText,
}) {
  // Validate message
  const message = params.message;
  if (!message || !Array.isArray(message.parts) || message.parts.length === 0) {
    return writeJson(res, 200, jsonRpcError(rpcId, -32602, "Invalid params: message.parts is required"));
  }

  const instruction = extractTextFromParts(message.parts);
  if (!instruction) {
    return writeJson(res, 200, jsonRpcError(rpcId, -32602, "Invalid params: no text content in message parts"));
  }

  // Check pending task limit
  const pendingCount = [...runtime.a2aTasksByToken.values()].filter(
    (t) => t.status === STATUS.SUBMITTED || t.status === STATUS.WORKING || t.status === STATUS.INPUT_REQUIRED
  ).length;
  if (pendingCount >= MAX_PENDING_TASKS) {
    return writeJson(res, 429, jsonRpcError(rpcId, -32000, `Too many pending tasks (max ${MAX_PENDING_TASKS})`));
  }

  // Create task
  const id = params.taskId || taskId();
  const contextId = params.contextId || taskId();
  const token = historyToken(`a2a_task:${id}`);
  const now = Date.now();

  const task = {
    id,
    token,
    contextId,
    status: STATUS.SUBMITTED,
    statusMessage: "",
    messages: [message],
    artifacts: [],
    instruction,
    callerInfo: {
      ip: req.socket?.remoteAddress || "",
      userAgent: req.headers["user-agent"] || "",
    },
    createdAtMs: now,
    updatedAtMs: now,
    decisionWaiters: [],
    decision: null,
  };

  runtime.a2aTasksByToken.set(token, task);

  // Record timeline entry
  try {
    recordTimelineEntry({
      config,
      runtime,
      state,
      entry: {
        stableId: `a2a_task:${id}`,
        token,
        kind: "a2a_task",
        threadId: "a2a",
        threadLabel: cleanText(instruction).slice(0, 80),
        title: `A2A: ${cleanText(instruction).slice(0, 80)}`,
        summary: cleanText(instruction).slice(0, 160),
        instruction,
        messageText: instruction,
        createdAtMs: now,
        readOnly: false,
        provider: "a2a",
      },
    });
    await saveState(config.stateFile, state);
  } catch (error) {
    console.error(`[a2a-timeline-save] ${error.message}`);
  }

  // Send web push notification
  try {
    await deliverWebPushItem({
      config,
      state,
      kind: "a2a_task",
      token,
      stableId: `a2a_task:${id}`,
      title: "A2A Task Request",
      body: cleanText(instruction).slice(0, 160),
      buildLocalizedContent: ({ locale }) => {
        const lang = locale?.startsWith("ja") ? "ja" : "en";
        return {
          title: lang === "ja" ? "🤝 外部エージェントからタスク依頼" : "🤝 Incoming A2A task request",
          body: cleanText(instruction).slice(0, 160),
        };
      },
    });
  } catch (error) {
    console.error(`[a2a-push-error] ${error.message}`);
  }

  // Return task in submitted state (caller will poll tasks/get)
  return writeJson(res, 200, jsonRpcResponse(rpcId, buildTaskResponse(task)));
}

// ---------------------------------------------------------------------------
// tasks/get
// ---------------------------------------------------------------------------

function handleTasksGet({ rpcId, params, runtime, res, writeJson }) {
  const id = params.taskId || params.id;
  if (!id) {
    return writeJson(res, 200, jsonRpcError(rpcId, -32602, "Invalid params: taskId is required"));
  }

  // Find task by id
  let task = null;
  for (const t of runtime.a2aTasksByToken.values()) {
    if (t.id === id) { task = t; break; }
  }

  if (!task) {
    return writeJson(res, 200, jsonRpcError(rpcId, -32001, `Task not found: ${id}`));
  }

  const result = buildTaskResponse(task);
  if (params.includeHistory === false) {
    delete result.history;
  }

  return writeJson(res, 200, jsonRpcResponse(rpcId, result));
}

// ---------------------------------------------------------------------------
// tasks/cancel
// ---------------------------------------------------------------------------

function handleTasksCancel({ rpcId, params, runtime, res, writeJson }) {
  const id = params.taskId || params.id;
  if (!id) {
    return writeJson(res, 200, jsonRpcError(rpcId, -32602, "Invalid params: taskId is required"));
  }

  let task = null;
  for (const t of runtime.a2aTasksByToken.values()) {
    if (t.id === id) { task = t; break; }
  }

  if (!task) {
    return writeJson(res, 200, jsonRpcError(rpcId, -32001, `Task not found: ${id}`));
  }

  // Only active tasks can be canceled
  if ([STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELED, STATUS.REJECTED].includes(task.status)) {
    return writeJson(res, 200, jsonRpcError(rpcId, -32000, `Task already in terminal state: ${task.status}`));
  }

  task.status = STATUS.CANCELED;
  task.statusMessage = "Canceled by caller";
  task.updatedAtMs = Date.now();

  // Notify any decision waiters
  for (const waiter of task.decisionWaiters.splice(0)) {
    try { waiter({ action: "cancel" }); } catch { /* ignore */ }
  }

  return writeJson(res, 200, jsonRpcResponse(rpcId, { success: true }));
}

// ---------------------------------------------------------------------------
// Decision handler (called from bridge when user approves/denies via PWA)
// ---------------------------------------------------------------------------

/**
 * Process user decision on an A2A task.
 * @param {object} task     - A2A task object from runtime.a2aTasksByToken
 * @param {object} decision - { action: "approve"|"deny", instruction?: string }
 */
export function resolveA2ATaskDecision(task, decision) {
  if (!task) return;
  task.decision = decision;
  task.updatedAtMs = Date.now();

  if (decision.action === "deny") {
    task.status = STATUS.REJECTED;
    task.statusMessage = "Task rejected by user";
  } else if (decision.action === "approve") {
    task.status = STATUS.WORKING;
    task.statusMessage = "Task approved, executing...";
    if (decision.instruction) {
      task.instruction = decision.instruction;
    }
  }

  // Notify waiters
  for (const waiter of task.decisionWaiters.splice(0)) {
    try { waiter(decision); } catch { /* ignore */ }
  }
}

/**
 * Mark task as completed with result artifacts.
 */
export function completeA2ATask(task, resultText) {
  if (!task) return;
  task.status = STATUS.COMPLETED;
  task.statusMessage = "Task completed";
  task.updatedAtMs = Date.now();
  task.artifacts = [
    {
      parts: [{ type: "text", text: resultText }],
    },
  ];
}

/**
 * Mark task as failed.
 */
export function failA2ATask(task, errorMessage) {
  if (!task) return;
  task.status = STATUS.FAILED;
  task.statusMessage = errorMessage || "Task failed";
  task.updatedAtMs = Date.now();
}
