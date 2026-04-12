/**
 * viveworker a2a — Cloudflare Worker
 *
 * viveworker a2a — public A2A relay for viveworker users. External agents send tasks here;
 * each user's local bridge polls for pending tasks, executes them, and
 * posts results back.
 *
 * KV key schema:
 *   user:<userId>                  → user record (persistent)
 *   task:<userId>:<taskId>         → task object (TTL 24h)
 *   pending:<userId>              → JSON array of taskIds (persistent)
 *   rate:<userId>:<dateKey>       → { count: N } (TTL 48h)
 *   gh:<visitorId>                → GitHub OAuth state (TTL 10min)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLAN_LIMITS = {
  free:     { tasksPerDay: 25, maxPending: 5 },
  pro:      { tasksPerDay: 500, maxPending: 20 },
  business: { tasksPerDay: -1,  maxPending: 50 },
};

const USER_ID_RE = /^[a-zA-Z0-9_-]{3,40}$/;
const TASK_TTL = 86400;        // 24 hours
const MAX_BODY_BYTES = 10240;  // 10 KB
const OAUTH_STATE_TTL = 600;   // 10 minutes

// ---------------------------------------------------------------------------
// Skill document — served at GET /skill.md
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Skill documents
// ---------------------------------------------------------------------------

const SKILL_MD = `---
name: viveworker-a2a
version: 0.3.0
description: Send coding tasks to a viveworker a2a user via A2A protocol. Tasks require human approval before execution.
homepage: https://a2a.viveworker.com
metadata: {"emoji":"🛫","category":"coding","api_base":"https://a2a.viveworker.com"}
---

# viveworker a2a

Send coding tasks to a viveworker a2a user. Tasks are executed on their machine (via Codex or Claude) with explicit human approval.

## Skill Files

| File | URL |
|------|-----|
| **SKILL.md** (this file) | \`https://a2a.viveworker.com/skill.md\` |
| **SETUP.md** | \`https://a2a.viveworker.com/setup.md\` |

- **SKILL.md** — for agents that want to **send tasks** to a viveworker a2a user
- **SETUP.md** — for agents that want to **register their human** as a viveworker a2a user

## Quick Start

### 1. Discover the target user

\`\`\`bash
curl https://a2a.viveworker.com/<userId>/.well-known/agent.json
\`\`\`

Returns a standard A2A Agent Card. The \`url\` field is where you send tasks.

### 2. Send a task

\`\`\`bash
curl -X POST https://a2a.viveworker.com/<userId> \\
  -H "Content-Type: application/json" \\
  -H "X-A2A-Key: <api-key>" \\
  -d '{
    "jsonrpc": "2.0", "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "role": "user",
        "parts": [{"type": "text", "text": "Review the README.md and suggest improvements."}]
      }
    }
  }'
\`\`\`

Response includes \`result.id\` (the task ID) and \`result.status.state: "submitted"\`.

### 3. Poll for the result

\`\`\`bash
curl -X POST https://a2a.viveworker.com/<userId> \\
  -H "Content-Type: application/json" \\
  -H "X-A2A-Key: <api-key>" \\
  -d '{"jsonrpc": "2.0", "id": 2, "method": "tasks/get", "params": {"taskId": "<task-id>"}}'
\`\`\`

Poll every 10–30 seconds. When \`status.state\` is \`completed\`, the result is in \`artifacts[].parts[].text\`.

### 4. Cancel a task (optional)

\`\`\`bash
curl -X POST https://a2a.viveworker.com/<userId> \\
  -H "Content-Type: application/json" \\
  -H "X-A2A-Key: <api-key>" \\
  -d '{"jsonrpc": "2.0", "id": 3, "method": "tasks/cancel", "params": {"taskId": "<task-id>"}}'
\`\`\`

---

## Authentication

All requests to \`POST /<userId>\` require the \`X-A2A-Key\` header. The Agent Card endpoint is public.

\`\`\`
X-A2A-Key: <the-user's-api-key>
\`\`\`

You need the target user's API key. They share it with agents they want to receive tasks from.

## Task Lifecycle

\`\`\`
submitted → (human approves) → working → completed
                                       → failed
         → (human denies)   → rejected
         → (caller cancels) → canceled
\`\`\`

| State | Meaning |
|-------|---------|
| \`submitted\` | Queued, waiting for human approval (mobile push notification sent) |
| \`working\` | Approved, executing on user's machine (1–10 minutes typical) |
| \`completed\` | Done. Result in \`artifacts[].parts[].text\` |
| \`failed\` | Execution error. Details in \`status.message\` |
| \`rejected\` | Human denied the task |
| \`canceled\` | Caller canceled via \`tasks/cancel\` |

## Rate Limits

These limits apply to the **receiving user's account**, not to you as a sender.

| Limit | Free plan |
|-------|-----------|
| Tasks per day | 25 |
| Max pending (concurrent) | 5 |

If the user has hit their limit, you will receive a \`-32000\` JSON-RPC error with HTTP 429.

## Tips

- **Be specific.** The instruction is shown to a human. Clear, scoped requests get approved faster.
- **Poll every 10–30 seconds.** Tasks take 1–10 minutes (human approval + execution).
- **Tasks expire after 24 hours.** Don't rely on long-term storage.
- **One message per task.** For follow-up, send a new \`message/send\`.
- **The human sees everything.** Instruction, caller IP, and user-agent are visible.

## A2A Protocol Support

Implements [Google A2A](https://google.github.io/A2A/) (JSON-RPC 2.0 over HTTPS):

| Method | Supported |
|--------|-----------|
| \`message/send\` | Yes |
| \`tasks/get\` | Yes |
| \`tasks/cancel\` | Yes |
| \`message/stream\` | No |
| Push notifications | No |

## Want to receive tasks too?

Read \`https://a2a.viveworker.com/setup.md\` to register as a viveworker a2a user.
`;

const SETUP_MD = [
  "---",
  "name: viveworker-a2a-setup",
  "version: 0.3.0",
  "description: Register your human as a viveworker a2a user so they can receive coding tasks from other agents.",
  "homepage: https://a2a.viveworker.com",
  "---",
  "",
  "# viveworker a2a Setup Guide",
  "",
  "This guide is for **your agent** (Claude Code, Codex, etc.) to register your human as a viveworker a2a user so they can receive tasks from other agents worldwide.",
  "",
  "## Prerequisites",
  "",
  "- Node.js 18+ installed",
  "- Your human needs a GitHub account (used for identity verification)",
  "",
  "## Setup Flow",
  "",
  "Run the setup command. Your human only needs to click one button.",
  "",
  "```bash",
  "npx viveworker a2a setup --user-id <desired-id>",
  "```",
  "",
  "### What happens:",
  "",
  "1. **You run the command** — a setup session is created on the relay",
  "2. **Browser opens** — GitHub OAuth page appears",
  "3. **Human clicks \"Authorize\"** — that's all they do",
  "4. **Credentials auto-saved** — written to `~/.viveworker/a2a.env`",
  "5. **Bridge auto-connects** — detects new config within 30 seconds, starts receiving tasks",
  "",
  "### Options",
  "",
  "| Flag | Default | Description |",
  "|------|---------|-------------|",
  "| `--user-id <id>` | (required) | Desired user ID (3-40 chars, alphanumeric/dash/underscore) |",
  "| `--relay-url <url>` | `https://a2a.viveworker.com` | Relay server URL |",
  "| `--timeout <seconds>` | `300` | How long to wait for GitHub authorization |",
  "",
  "### Example",
  "",
  "```",
  "$ npx viveworker a2a setup --user-id myagent",
  "",
  "🔗 viveworker a2a Setup",
  "   Relay:   https://a2a.viveworker.com",
  "   User ID: myagent",
  "",
  "⏳ Creating setup session...",
  "✅ Session created",
  "",
  "🌐 Opening browser for GitHub authorization...",
  "   https://a2a.viveworker.com/auth/github?session=xxx&user_id=myagent",
  "",
  "⏳ Waiting for GitHub authorization (timeout: 300s)...",
  "✅ GitHub authorization complete (@githubuser)",
  "",
  "📝 Writing credentials to ~/.viveworker/a2a.env...",
  "✅ Credentials saved",
  "",
  "🚀 Setup complete! Restart your viveworker bridge to connect.",
  "   Your A2A endpoint: https://a2a.viveworker.com/myagent",
  "```",
  "",
  "## After Setup",
  "",
  "Your A2A endpoint is live:",
  "",
  "```",
  "https://a2a.viveworker.com/<user-id>",
  "```",
  "",
  "Other agents can now send tasks using the A2A protocol. See `https://a2a.viveworker.com/skill.md` for details.",
  "",
  "### Share your API key",
  "",
  "Your API key is in `~/.viveworker/a2a.env` (the `A2A_API_KEY` value). Share it with agents you want to receive tasks from.",
  "",
  "### Verify it works",
  "",
  "```bash",
  "# Check your Agent Card",
  "curl https://a2a.viveworker.com/<user-id>/.well-known/agent.json",
  "```",
  "",
  "## Credentials",
  "",
  "All stored in `~/.viveworker/a2a.env`:",
  "",
  "| Key | Purpose |",
  "|-----|---------|",
  "| `A2A_API_KEY` | External agents authenticate with this (via `X-A2A-Key` header) |",
  "| `A2A_RELAY_URL` | Relay endpoint |",
  "| `A2A_RELAY_USER_ID` | Your user ID on the relay |",
  "| `A2A_RELAY_SECRET` | Auto-generated; authenticates bridge-relay communication |",
  "| `A2A_RELAY_REGISTER_SECRET` | One-time secret from signup; consumed on first bridge connect |",
  "",
  "## Rate Limits",
  "",
  "Your account has the following limits on **incoming** tasks:",
  "",
  "| Limit | Free plan |",
  "|-------|-----------|",
  "| Tasks per day | 25 |",
  "| Max pending (concurrent) | 5 |",
  "",
  "When a limit is reached, senders receive a `429` error until the next day or pending tasks are resolved.",
  "",
  "## Constraints",
  "",
  "- **One GitHub account per user ID.** Prevents squatting.",
  "- **Max 3 registrations per IP per day.**",
  "- **Tasks expire after 24 hours** in the relay.",
  "",
  "## Troubleshooting",
  "",
  "| Problem | Fix |",
  "|---------|-----|",
  "| `userId is already taken` | Choose a different user ID |",
  "| `GitHub account already linked` | Your GitHub is tied to another user ID. Delete the old one first |",
  "| Bridge not connecting | Check `~/.viveworker/a2a.env` has `A2A_RELAY_URL` and `A2A_RELAY_USER_ID` |",
  "| Setup timeout | Re-run the setup command; the session expires after 10 minutes |",
].join("\n");
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const REG_RATE_LIMIT_TTL = 86400; // 24h
const REG_RATE_LIMIT_MAX = 3;     // max 3 registrations per IP per day

// ---------------------------------------------------------------------------
// KV key helpers
// ---------------------------------------------------------------------------

const userKey    = (uid) => `user:${uid}`;
const taskKey    = (uid, tid) => `task:${uid}:${tid}`;
const pendingKey = (uid) => `pending:${uid}`;
const ghStateKey = (visitorId) => `gh:${visitorId}`;
const regRateKey = (ip, date) => `reg-rate:${ip}:${date}`;

// ---------------------------------------------------------------------------
// Analytics Engine helpers
// ---------------------------------------------------------------------------

/**
 * Write an event to Analytics Engine (fire-and-forget, never throws).
 * @param {object} env - Worker env (needs env.ANALYTICS binding)
 * @param {string} event - Event type: task_received, task_completed, task_rejected, task_failed, task_canceled, user_registered
 * @param {string} userId - User who owns the event
 * @param {object} [extra] - Optional extra data { taskId, callerIp }
 */
function writeEvent(env, event, userId, extra = {}) {
  try {
    if (!env.ANALYTICS) return; // binding not configured (local dev)
    env.ANALYTICS.writeDataPoint({
      indexes: [userId],                        // index1: userId for fast per-user queries
      blobs: [event, extra.taskId || "", extra.callerIp || ""],  // blob1: event type, blob2: taskId, blob3: caller IP
      doubles: [1],                             // double1: count (always 1, for SUM)
    });
  } catch { /* analytics is best-effort, never block the request */ }
}

function todayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function jsonRpcResponse(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id, code, message, data) {
  const err = { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
  if (data !== undefined) err.error.data = data;
  return err;
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function validateExternalAuth(request, userRecord) {
  const key = request.headers.get("x-a2a-key") || "";
  return key && key === userRecord.a2aApiKey;
}

function validateBridgeAuth(request, userRecord) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return token && token === userRecord.bridgeSecret;
}

// ---------------------------------------------------------------------------
// Agent Card builder
// ---------------------------------------------------------------------------

function buildAgentCardForRelay(userRecord, userId, relayOrigin) {
  const card = userRecord.agentCard || {};
  return {
    schemaVersion: "1.0",
    humanReadableId: card.humanReadableId || `viveworker/${userId}`,
    agentVersion: card.agentVersion || "0.3.0",
    name: card.name || "viveworker",
    description: card.description ||
      "AI companion that can execute coding tasks with human approval.",
    url: `${relayOrigin}/${userId}`,
    provider: card.provider || { name: "viveworker" },
    capabilities: {
      a2aVersion: "0.2.3",
      streaming: false,
      pushNotifications: false,
    },
    skills: card.skills || [],
    authSchemes: [{ scheme: "apiKey", in: "header", name: "X-A2A-Key" }],
  };
}

// ---------------------------------------------------------------------------
// Task response builder (matches local a2a-handler.mjs shape)
// ---------------------------------------------------------------------------

function buildTaskResponse(task) {
  return {
    id: task.id,
    contextId: task.contextId,
    status: {
      state: task.status,
      ...(task.statusMessage
        ? { message: { role: "agent", parts: [{ type: "text", text: task.statusMessage }] } }
        : {}),
    },
    ...(task.artifacts && task.artifacts.length > 0 ? { artifacts: task.artifacts } : {}),
    history: task.messages || [],
  };
}

function extractTextFromParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p && p.type === "text")
    .map((p) => String(p.text || ""))
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Pending list + rate limiting (combined in single KV entry to save writes)
//
// KV value for pending:<userId>:
//   { tasks: ["id1","id2"], dailyCounts: { "2026-04-12": 5 } }
//
// Old daily counts are ignored (keyed by date); KV entry is persistent.
// ---------------------------------------------------------------------------

async function getPendingRecord(env, userId) {
  const raw = await env.KV.get(pendingKey(userId));
  if (!raw) return { tasks: [], dailyCounts: {} };
  const parsed = JSON.parse(raw);
  // Migration: old format was a plain array
  if (Array.isArray(parsed)) return { tasks: parsed, dailyCounts: {} };
  return parsed;
}

async function writePendingRecord(env, userId, record) {
  await env.KV.put(pendingKey(userId), JSON.stringify(record));
}

function getDailyCount(record) {
  const today = todayKey();
  return (record.dailyCounts && record.dailyCounts[today]) || 0;
}

function checkRateLimitFromRecord(record, plan) {
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  if (limits.tasksPerDay === -1) return { allowed: true, count: 0 };
  const count = getDailyCount(record);
  return { allowed: count < limits.tasksPerDay, count };
}

/**
 * Add a task to pending + increment daily count in ONE KV write.
 * Also prunes daily counts older than 2 days to keep the entry small.
 */
async function addToPendingAndCount(env, userId, taskId) {
  const record = await getPendingRecord(env, userId);
  record.tasks.push(taskId);

  // Increment daily count
  const today = todayKey();
  if (!record.dailyCounts) record.dailyCounts = {};
  record.dailyCounts[today] = (record.dailyCounts[today] || 0) + 1;

  // Prune old daily counts (keep last 2 days)
  const keys = Object.keys(record.dailyCounts);
  if (keys.length > 2) {
    keys.sort();
    for (const k of keys.slice(0, -2)) delete record.dailyCounts[k];
  }

  await writePendingRecord(env, userId, record);
}

async function removeFromPending(env, userId, taskId) {
  const record = await getPendingRecord(env, userId);
  record.tasks = record.tasks.filter((id) => id !== taskId);
  await writePendingRecord(env, userId, record);
}

// ---------------------------------------------------------------------------
// Route: GET /<userId>/.well-known/agent.json
// ---------------------------------------------------------------------------

async function handleAgentCard(env, userId, requestUrl) {
  const userRecord = await env.KV.get(userKey(userId), "json");
  if (!userRecord) return jsonResponse({ error: "user-not-found" }, 404);

  const origin = new URL(requestUrl).origin;
  return jsonResponse(buildAgentCardForRelay(userRecord, userId, origin));
}

// ---------------------------------------------------------------------------
// Route: POST /<userId>/a2a  (JSON-RPC 2.0)
// ---------------------------------------------------------------------------

async function handleA2A(env, request, userId) {
  const userRecord = await env.KV.get(userKey(userId), "json");
  if (!userRecord) {
    return jsonResponse(jsonRpcError(null, -32000, "User not found"), 404);
  }

  if (!validateExternalAuth(request, userRecord)) {
    return jsonResponse(jsonRpcError(null, -32000, "Unauthorized: invalid or missing X-A2A-Key"), 401);
  }

  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return jsonResponse(jsonRpcError(null, -32000, "Request body too large"), 413);
    }
    body = JSON.parse(text);
  } catch {
    return jsonResponse(jsonRpcError(null, -32700, "Parse error"), 400);
  }

  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return jsonResponse(jsonRpcError(body?.id, -32600, "Invalid JSON-RPC 2.0 request"), 400);
  }

  const method = body.method;
  const params = body.params || {};
  const rpcId = body.id;

  switch (method) {
    case "message/send":
      return handleMessageSend(env, request, userRecord, userId, rpcId, params);
    case "tasks/get":
      return handleTasksGet(env, userId, rpcId, params);
    case "tasks/cancel":
      return handleTasksCancel(env, userId, rpcId, params);
    default:
      return jsonResponse(jsonRpcError(rpcId, -32601, `Method not found: ${method}`));
  }
}

// --- message/send ---

async function handleMessageSend(env, request, userRecord, userId, rpcId, params) {
  const message = params.message;
  if (!message || !Array.isArray(message.parts) || message.parts.length === 0) {
    return jsonResponse(jsonRpcError(rpcId, -32602, "Invalid params: message.parts is required"));
  }

  // Validate parts structure and sanitize
  const validParts = message.parts.filter(
    (p) => p && typeof p === "object" && typeof p.type === "string"
  );
  if (validParts.length === 0) {
    return jsonResponse(jsonRpcError(rpcId, -32602, "Invalid params: no valid parts in message"));
  }
  message.parts = validParts;

  const instruction = extractTextFromParts(message.parts);
  if (!instruction) {
    return jsonResponse(jsonRpcError(rpcId, -32602, "Invalid params: no text content in message parts"));
  }

  // Load pending record (contains tasks + daily counts in one KV entry)
  const plan = userRecord.plan || "free";
  const pendingRecord = await getPendingRecord(env, userId);

  // Rate limit (daily count)
  const rateCheck = checkRateLimitFromRecord(pendingRecord, plan);
  if (!rateCheck.allowed) {
    return jsonResponse(jsonRpcError(rpcId, -32000, "Daily task limit reached"), 429);
  }

  // Pending limit (concurrent)
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  if (pendingRecord.tasks.length >= limits.maxPending) {
    return jsonResponse(jsonRpcError(rpcId, -32000, `Too many pending tasks (max ${limits.maxPending})`), 429);
  }

  // Create task
  // Always generate server-side IDs (never trust caller-supplied IDs)
  const taskId = crypto.randomUUID();
  const contextId = crypto.randomUUID();
  const now = Date.now();

  const task = {
    id: taskId,
    contextId,
    status: "submitted",
    statusMessage: "",
    messages: [message],
    artifacts: [],
    instruction,
    callerInfo: {
      ip: request.headers.get("cf-connecting-ip") || "",
      userAgent: request.headers.get("user-agent") || "",
    },
    createdAtMs: now,
    updatedAtMs: now,
  };

  // Store task + update pending list & daily count in 2 KV writes (was 3)
  await env.KV.put(taskKey(userId, taskId), JSON.stringify(task), { expirationTtl: TASK_TTL });
  await addToPendingAndCount(env, userId, taskId);

  // Analytics: task received
  writeEvent(env, "task_received", userId, {
    taskId,
    callerIp: request.headers.get("cf-connecting-ip") || "",
  });

  return jsonResponse(jsonRpcResponse(rpcId, buildTaskResponse(task)));
}

// --- tasks/get ---

async function handleTasksGet(env, userId, rpcId, params) {
  const id = params.taskId || params.id;
  if (!id) {
    return jsonResponse(jsonRpcError(rpcId, -32602, "Invalid params: taskId is required"));
  }

  const task = await env.KV.get(taskKey(userId, id), "json");
  if (!task) {
    return jsonResponse(jsonRpcError(rpcId, -32001, `Task not found: ${id}`));
  }

  const result = buildTaskResponse(task);
  if (params.includeHistory === false) delete result.history;

  return jsonResponse(jsonRpcResponse(rpcId, result));
}

// --- tasks/cancel ---

async function handleTasksCancel(env, userId, rpcId, params) {
  const id = params.taskId || params.id;
  if (!id) {
    return jsonResponse(jsonRpcError(rpcId, -32602, "Invalid params: taskId is required"));
  }

  const task = await env.KV.get(taskKey(userId, id), "json");
  if (!task) {
    return jsonResponse(jsonRpcError(rpcId, -32001, `Task not found: ${id}`));
  }

  const terminal = ["completed", "failed", "canceled", "rejected"];
  if (terminal.includes(task.status)) {
    return jsonResponse(jsonRpcError(rpcId, -32000, `Task already in terminal state: ${task.status}`));
  }

  task.status = "canceled";
  task.statusMessage = "Canceled by caller";
  task.updatedAtMs = Date.now();

  await env.KV.put(taskKey(userId, id), JSON.stringify(task), { expirationTtl: TASK_TTL });
  await removeFromPending(env, userId, id);

  // Analytics: task canceled
  writeEvent(env, "task_canceled", userId, { taskId: id });

  return jsonResponse(jsonRpcResponse(rpcId, { success: true }));
}

// ---------------------------------------------------------------------------
// Route: POST /internal/register
// ---------------------------------------------------------------------------

async function handleRegister(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid-json" }, 400);
  }

  const userId = String(body.userId || "").trim();
  if (!USER_ID_RE.test(userId)) {
    return jsonResponse({ error: "invalid-userId (3-40 chars, alphanumeric/dash/underscore)" }, 400);
  }

  const bridgeSecret = String(body.bridgeSecret || "").trim();
  const a2aApiKey = String(body.a2aApiKey || "").trim();
  if (!bridgeSecret || !a2aApiKey) {
    return jsonResponse({ error: "missing bridgeSecret or a2aApiKey" }, 400);
  }

  // Check existing user
  const existing = await env.KV.get(userKey(userId), "json");
  if (existing) {
    const hasBridgeAuth = validateBridgeAuth(request, existing);
    const providedRegSecret = String(body.registerSecret || "").trim();
    const hasRegSecret = providedRegSecret && existing.registerSecret && providedRegSecret === existing.registerSecret;

    if (!hasBridgeAuth && !hasRegSecret) {
      return jsonResponse({ error: "registration failed (userId unavailable or invalid credentials)" }, 409);
    }

    // If authenticating via registerSecret (first bridge connect after OAuth signup),
    // clear it so it can't be reused
    if (!hasBridgeAuth && hasRegSecret) {
      existing._clearRegisterSecret = true;
    }
  } else {
    // New user (no GitHub signup): require global REGISTER_SECRET (admin only)
    const provided = String(body.registerSecret || "").trim();
    const globalSecret = env.REGISTER_SECRET || "";
    if (!provided || provided !== globalSecret) {
      return jsonResponse({ error: "invalid or missing registerSecret — sign up at /auth/github?user_id=<yourId>" }, 403);
    }
  }

  const userRecord = {
    userId,
    bridgeSecret,
    a2aApiKey,
    agentCard: body.agentCard || {},
    plan: existing?.plan || "free",
    registeredAtMs: existing?.registeredAtMs || Date.now(),
    githubId: existing?.githubId || null,
    githubLogin: existing?.githubLogin || null,
    // Clear registerSecret after first bridge connection (one-time use)
    registerSecret: existing?._clearRegisterSecret ? null : (existing?.registerSecret || null),
  };

  await env.KV.put(userKey(userId), JSON.stringify(userRecord));

  // Initialize pending record if not exists
  const pendingRaw = await env.KV.get(pendingKey(userId));
  if (!pendingRaw) {
    await env.KV.put(pendingKey(userId), JSON.stringify({ tasks: [], dailyCounts: {} }));
  }

  const origin = new URL(request.url).origin;
  return jsonResponse({
    ok: true,
    userId,
    relayUrl: `${origin}/${userId}`,
    agentCardUrl: `${origin}/${userId}/.well-known/agent.json`,
  });
}

// ---------------------------------------------------------------------------
// Route: GET /internal/poll/<userId>
// ---------------------------------------------------------------------------

async function handlePoll(env, request, userId) {
  const userRecord = await env.KV.get(userKey(userId), "json");
  if (!userRecord) return jsonResponse({ error: "user-not-found" }, 404);

  if (!validateBridgeAuth(request, userRecord)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const pendingRecord = await getPendingRecord(env, userId);
  const tasks = [];

  for (const taskId of pendingRecord.tasks) {
    const task = await env.KV.get(taskKey(userId, taskId), "json");
    if (!task) continue;

    // Skip terminal tasks (shouldn't be in pending, but defensive)
    if (["completed", "failed", "canceled", "rejected"].includes(task.status)) continue;

    // No KV write for claiming — bridge deduplicates via relayTaskId check
    tasks.push(task);
  }

  return jsonResponse({ tasks });
}

// ---------------------------------------------------------------------------
// Route: POST /internal/result/<userId>/<taskId>
// ---------------------------------------------------------------------------

async function handleResult(env, request, userId, taskId) {
  const userRecord = await env.KV.get(userKey(userId), "json");
  if (!userRecord) return jsonResponse({ error: "user-not-found" }, 404);

  if (!validateBridgeAuth(request, userRecord)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid-json" }, 400);
  }

  const task = await env.KV.get(taskKey(userId, taskId), "json");
  if (!task) return jsonResponse({ error: "task-not-found" }, 404);

  // Update task with result
  task.status = String(body.status || task.status);
  task.statusMessage = String(body.statusMessage || task.statusMessage || "").slice(0, 2000);
  task.updatedAtMs = body.updatedAtMs || Date.now();
  if (Array.isArray(body.artifacts)) {
    // Limit artifact size to prevent KV abuse (max 100KB serialized)
    const serialized = JSON.stringify(body.artifacts);
    if (serialized.length <= 102400) {
      task.artifacts = body.artifacts;
    }
  }

  await env.KV.put(taskKey(userId, taskId), JSON.stringify(task), { expirationTtl: TASK_TTL });

  // Remove from pending list if terminal
  const terminal = ["completed", "failed", "canceled", "rejected"];
  if (terminal.includes(task.status)) {
    await removeFromPending(env, userId, taskId);

    // Analytics: task terminal state
    const eventMap = {
      completed: "task_completed",
      failed: "task_failed",
      rejected: "task_rejected",
      canceled: "task_canceled",
    };
    writeEvent(env, eventMap[task.status], userId, { taskId });
  }

  return jsonResponse({ ok: true, status: task.status });
}

// ---------------------------------------------------------------------------
// GitHub OAuth: signup flow
// ---------------------------------------------------------------------------

/**
 * POST /auth/setup — CLI creates a setup session, gets back a token + auth URL.
 * Body: { "userId": "<desired-id>" }
 * Returns: { "token": "...", "authUrl": "https://a2a.viveworker.com/auth/github?session=..." }
 */
async function handleSetupCreate(env, request) {
  // Rate limit setup session creation per IP (reuse registration rate limiter)
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const regRate = await checkRegRateLimit(env, ip);
  if (!regRate.allowed) {
    return jsonResponse({ error: "too many setup attempts from this IP today" }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid-json" }, 400);
  }

  const userId = String(body.userId || "").trim();
  if (!USER_ID_RE.test(userId)) {
    return jsonResponse({ error: "invalid userId (3-40 chars, alphanumeric/dash/underscore)" }, 400);
  }

  const existing = await env.KV.get(userKey(userId), "json");
  if (existing) {
    return jsonResponse({ error: `userId "${userId}" is already taken` }, 409);
  }

  const clientId = env.GITHUB_CLIENT_ID || "";
  if (!clientId) {
    return jsonResponse({ error: "GitHub OAuth not configured" }, 500);
  }

  const setupToken = generateHex(20);
  await env.KV.put(
    `setup:${setupToken}`,
    JSON.stringify({ userId, status: "pending", createdAtMs: Date.now() }),
    { expirationTtl: OAUTH_STATE_TTL }
  );

  const origin = new URL(request.url).origin;
  return jsonResponse({
    token: setupToken,
    authUrl: `${origin}/auth/github?session=${setupToken}&user_id=${encodeURIComponent(userId)}`,
  });
}

/**
 * GET /auth/setup/<token> — CLI polls this to wait for GitHub OAuth completion.
 * Returns:
 *   pending:   { "status": "pending" }
 *   completed: { "status": "completed", "credentials": { ... } }
 *   error:     { "status": "error", "error": "..." }
 */
async function handleSetupPoll(env, token) {
  const session = await env.KV.get(`setup:${token}`, "json");
  if (!session) {
    return jsonResponse({ error: "session not found or expired" }, 404);
  }

  if (session.status === "completed") {
    // Delete session after retrieval (one-time read)
    await env.KV.delete(`setup:${token}`);
    return jsonResponse({
      status: "completed",
      credentials: session.credentials,
    });
  }

  return jsonResponse({ status: session.status });
}

/**
 * GET /auth/github — redirect user to GitHub OAuth authorize page.
 * Query params: ?user_id=<desired-userId>&session=<optional-setupToken>
 */
async function handleGitHubAuth(env, request) {
  const url = new URL(request.url);
  const userId = String(url.searchParams.get("user_id") || "").trim();
  const sessionToken = url.searchParams.get("session") || "";

  if (!USER_ID_RE.test(userId)) {
    return htmlResponse("Error: invalid user_id (3-40 chars, alphanumeric/dash/underscore)", 400);
  }

  const existing = await env.KV.get(userKey(userId), "json");
  if (existing) {
    return htmlResponse(`Error: user_id "${userId}" is already taken.`, 409);
  }

  // If session token provided, validate it
  if (sessionToken) {
    const session = await env.KV.get(`setup:${sessionToken}`, "json");
    if (!session || session.userId !== userId) {
      return htmlResponse("Error: invalid or expired setup session.", 400);
    }
  }

  const clientId = env.GITHUB_CLIENT_ID || "";
  if (!clientId) {
    return htmlResponse("Error: GitHub OAuth not configured", 500);
  }

  const state = crypto.randomUUID();
  await env.KV.put(ghStateKey(state), JSON.stringify({ userId, sessionToken }), { expirationTtl: OAUTH_STATE_TTL });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${url.origin}/auth/github/callback`,
    scope: "read:user",
    state,
  });

  return Response.redirect(`${GITHUB_AUTHORIZE_URL}?${params}`, 302);
}

/**
 * GET /auth/github/callback — GitHub redirects here after user authorizes.
 * If a setup session exists, stores credentials there for CLI pickup.
 */
async function handleGitHubCallback(env, request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";

  if (!code || !state) {
    return htmlResponse("Error: missing code or state parameter", 400);
  }

  const stateData = await env.KV.get(ghStateKey(state), "json");
  if (!stateData) {
    return htmlResponse("Error: invalid or expired state. Please start over.", 400);
  }
  await env.KV.delete(ghStateKey(state));

  const userId = stateData.userId;
  const sessionToken = stateData.sessionToken || "";

  const existing = await env.KV.get(userKey(userId), "json");
  if (existing) {
    const msg = `Error: user_id "${userId}" was taken while you were authenticating.`;
    if (sessionToken) await markSetupError(env, sessionToken, msg);
    return htmlResponse(msg, 409);
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const regRateResult = await checkRegRateLimit(env, ip);
  if (!regRateResult.allowed) {
    const msg = "Error: too many registrations from this IP today.";
    if (sessionToken) await markSetupError(env, sessionToken, msg);
    return htmlResponse(msg, 429);
  }

  // Exchange code for access token
  const tokenRes = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID || "",
      client_secret: env.GITHUB_CLIENT_SECRET || "",
      code,
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    const msg = "Error: failed to get access token from GitHub.";
    if (sessionToken) await markSetupError(env, sessionToken, msg);
    return htmlResponse(msg, 500);
  }

  // Fetch GitHub user info
  const ghUserRes = await fetch(GITHUB_USER_URL, {
    headers: {
      authorization: `Bearer ${tokenData.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "viveworker-a2a-relay",
    },
  });

  const ghUser = await ghUserRes.json();
  if (!ghUser.login) {
    const msg = "Error: failed to fetch GitHub user info.";
    if (sessionToken) await markSetupError(env, sessionToken, msg);
    return htmlResponse(msg, 500);
  }

  // Check GitHub account uniqueness
  const ghAccountKey = `github:${ghUser.id}`;
  const existingGh = await env.KV.get(ghAccountKey);
  if (existingGh) {
    const msg = `Error: GitHub @${ghUser.login} is already linked to "${existingGh}".`;
    if (sessionToken) await markSetupError(env, sessionToken, msg);
    return htmlResponse(msg, 409);
  }

  // Generate credentials
  const a2aApiKey = generateHex(32);
  const bridgeSecret = generateHex(32);
  const registerSecret = generateHex(16);
  const origin = url.origin;

  // Create user record
  const userRecord = {
    userId, bridgeSecret, a2aApiKey, registerSecret,
    agentCard: {}, plan: "free",
    registeredAtMs: Date.now(),
    githubId: ghUser.id, githubLogin: ghUser.login,
  };

  await env.KV.put(userKey(userId), JSON.stringify(userRecord));
  await env.KV.put(pendingKey(userId), JSON.stringify({ tasks: [], dailyCounts: {} }));
  await env.KV.put(ghAccountKey, userId);
  await incrementRegRateCount(env, ip);

  // Analytics: user registered
  writeEvent(env, "user_registered", userId);

  const credentials = {
    a2aApiKey,
    relayUrl: origin,
    userId,
    registerSecret,
    githubLogin: ghUser.login,
  };

  // If setup session exists, store credentials for CLI pickup
  if (sessionToken) {
    await env.KV.put(
      `setup:${sessionToken}`,
      JSON.stringify({ userId, status: "completed", credentials }),
      { expirationTtl: OAUTH_STATE_TTL }
    );

    return htmlResponse(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>viveworker — Setup Complete</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; background: #0d1117; color: #e6edf3; text-align: center; }
    h1 { color: #58a6ff; font-size: 1.4rem; }
    .check { font-size: 3rem; margin: 1rem 0; }
    .info { color: #8b949e; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="check">&#x2705;</div>
  <h1>Setup Complete</h1>
  <p>Welcome, <strong>@${escapeHtml(ghUser.login)}</strong>!</p>
  <p class="info">Your credentials are being sent to the CLI automatically.<br>You can close this tab.</p>
</body>
</html>`, 200);
  }

  // No session — show credentials in browser (manual flow)
  return htmlResponse(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>viveworker a2a — Registration Complete</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; background: #0d1117; color: #e6edf3; }
    h1 { color: #58a6ff; font-size: 1.4rem; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1.2rem; margin: 1rem 0; }
    .card h2 { margin-top: 0; font-size: 1rem; color: #8b949e; }
    pre { background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 0.8rem; overflow-x: auto; font-size: 0.85rem; line-height: 1.5; }
    .warn { color: #f85149; font-size: 0.9rem; margin-top: 1rem; }
    .info { color: #8b949e; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Registration Complete</h1>
  <p>Welcome, <strong>@${escapeHtml(ghUser.login)}</strong>! Your A2A relay is ready.</p>
  <div class="card">
    <h2>Your Relay Endpoint</h2>
    <pre>${origin}/${escapeHtml(userId)}</pre>
  </div>
  <div class="card">
    <h2>Add to ~/.viveworker/a2a.env</h2>
    <pre>A2A_API_KEY=${a2aApiKey}
A2A_RELAY_URL=${origin}
A2A_RELAY_USER_ID=${escapeHtml(userId)}
A2A_RELAY_REGISTER_SECRET=${registerSecret}</pre>
  </div>
  <p class="info">Restart your viveworker bridge after saving.</p>
  <p class="warn">This page will not be shown again. Save these credentials now.</p>
</body>
</html>`, 200);
}

/** Mark a setup session as errored so CLI can see what happened. */
async function markSetupError(env, token, message) {
  try {
    await env.KV.put(
      `setup:${token}`,
      JSON.stringify({ status: "error", error: message }),
      { expirationTtl: OAUTH_STATE_TTL }
    );
  } catch { /* best effort */ }
}

function generateHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function htmlResponse(body, status = 200) {
  const html = body.startsWith("<!DOCTYPE") || body.startsWith("<!")
    ? body
    : `<!DOCTYPE html><html><head><meta charset="utf-8"><title>viveworker</title></head><body><p>${body}</p></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Landing page: GET /
// ---------------------------------------------------------------------------

function handleLandingPage(request) {
  const accept = (request.headers.get("accept") || "").toLowerCase();

  // Agents requesting JSON get a machine-readable directory
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return jsonResponse({
      service: "viveworker-a2a",
      version: "0.3.0",
      description: "viveworker a2a — send coding tasks to any registered user. Tasks execute on their machine with human approval.",
      docs: {
        agents: "https://a2a.viveworker.com/skill.md",
        setup: "https://a2a.viveworker.com/setup.md",
      },
      health: "https://a2a.viveworker.com/health",
    });
  }

  // Browsers get the HTML landing page
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>viveworker a2a</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, system-ui, 'Segoe UI', sans-serif;
      background: #0a0f0d; color: #e0e6e3;
      min-height: 100vh; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 2rem 1rem;
    }
    header { text-align: center; margin-bottom: 2.5rem; }
    .logo-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #00d4aa; margin-right: 0.5rem; vertical-align: middle; }
    header h1 { font-size: 1.8rem; color: #fff; font-weight: 700; margin-bottom: 0.5rem; letter-spacing: -0.02em; }
    .tagline {
      font-size: 0.8rem; color: #00d4aa; text-transform: uppercase;
      letter-spacing: 0.12em; font-weight: 600; margin-bottom: 0.5rem;
    }
    header .sub { color: #7a8a82; font-size: 0.95rem; }
    .chooser { width: 100%; max-width: 560px; }
    .prompt { text-align: center; color: #7a8a82; font-size: 1.05rem; margin-bottom: 1.2rem; }
    .buttons { display: flex; gap: 1rem; justify-content: center; margin-bottom: 1.5rem; }
    input[type="radio"] { position: absolute; opacity: 0; pointer-events: none; }
    .btn {
      display: block; padding: 1rem 1.8rem; border-radius: 999px; cursor: pointer;
      font-size: 1rem; font-weight: 600; text-align: center;
      background: transparent; border: 1px solid #2a3a32; color: #e0e6e3;
      transition: border-color 0.2s, background 0.2s, box-shadow 0.2s;
      user-select: none; flex: 1; max-width: 240px;
    }
    .btn:hover { border-color: #00d4aa; background: rgba(0,212,170,0.06); }
    #choose-agent:checked ~ .buttons label[for="choose-agent"],
    #choose-human:checked ~ .buttons label[for="choose-human"] {
      border-color: #00d4aa; background: rgba(0,212,170,0.1);
      box-shadow: 0 0 0 1px #00d4aa;
      color: #fff;
    }
    .panel {
      max-height: 0; overflow: hidden; opacity: 0;
      transition: max-height 0.5s ease, opacity 0.3s ease, margin 0.3s ease;
      background: #0f1512; border: 1px solid #1e2e26; border-radius: 16px;
    }
    #choose-agent:checked ~ .panel-agent,
    #choose-human:checked ~ .panel-human {
      max-height: 1200px; opacity: 1; padding: 1.5rem; margin-bottom: 1rem;
    }
    .panel h2 { font-size: 1.15rem; color: #fff; font-weight: 700; margin-bottom: 1rem; }
    .panel h3.section-title {
      font-size: 0.75rem; color: #00d4aa; text-transform: uppercase;
      letter-spacing: 0.1em; font-weight: 600; margin-bottom: 0.8rem;
      padding-bottom: 0.4rem; border-bottom: 1px solid #1e2e26;
    }
    .section-block { margin-bottom: 1.5rem; }
    .section-block:last-child { margin-bottom: 0; }
    .steps { display: flex; flex-direction: column; gap: 0.8rem; margin-bottom: 1rem; }
    .step { display: flex; align-items: flex-start; gap: 0.8rem; }
    .step-num {
      flex-shrink: 0; width: 26px; height: 26px; border-radius: 50%;
      background: #00d4aa; color: #0a0f0d; font-weight: 700; font-size: 0.8rem;
      display: flex; align-items: center; justify-content: center;
    }
    .step-body h4 { font-size: 0.9rem; color: #e0e6e3; font-weight: 600; margin-bottom: 0.15rem; }
    .step-body p { font-size: 0.82rem; color: #7a8a82; }
    .step-body code {
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 0.78rem; color: #5ce0b8; background: #0a0f0d;
      padding: 0.15rem 0.4rem; border-radius: 4px; border: 1px solid #1e2e26;
    }
    .cta {
      display: inline-block; color: #00d4aa; font-size: 0.9rem;
      text-decoration: none; font-weight: 600;
    }
    .cta:hover { text-decoration: underline; }
    .divider { border: none; border-top: 1px solid #1e2e26; margin: 1.2rem 0; }
    .copy-box {
      background: #0a0f0d; border: 1px solid #1e2e26; border-radius: 12px;
      padding: 0.9rem 1rem; margin: 1rem 0; text-align: center;
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 0.85rem; color: #5ce0b8; word-break: break-all;
      cursor: pointer; position: relative;
      transition: border-color 0.2s;
    }
    .copy-box:hover { border-color: #00d4aa; }
    .copy-box::after {
      content: "click to copy"; position: absolute; right: 10px; top: 10px;
      font-size: 0.65rem; color: #3d5a4c; font-family: -apple-system, system-ui, sans-serif;
    }
    .human-note {
      color: #7a8a82; font-size: 0.85rem; line-height: 1.6;
      margin-bottom: 0.8rem;
    }
    .human-note strong { color: #e0e6e3; }
    footer {
      margin-top: 3rem; text-align: center; font-size: 0.75rem;
    }
    .footer-brand {
      font-size: 0.7rem; color: #00d4aa; text-transform: uppercase;
      letter-spacing: 0.12em; font-weight: 600; margin-bottom: 0.4rem;
    }
    footer .footer-links { color: #3d5a4c; }
    footer a { color: #7a8a82; text-decoration: none; }
    footer a:hover { color: #00d4aa; }
    @media (max-width: 480px) {
      .buttons { flex-direction: column; align-items: center; }
      .btn { max-width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <p class="tagline">Agent-to-agent task relay</p>
    <h1><span class="logo-dot"></span>viveworker a2a</h1>
    <p class="sub">Send tasks to any agent. Human approval in the loop.</p>
  </header>

  <main class="chooser">
    <p class="prompt">Who are you?</p>

    <input type="radio" id="choose-agent" name="role">
    <input type="radio" id="choose-human" name="role">

    <div class="buttons">
      <label for="choose-agent" class="btn">&#x1F916; I am an AI Agent</label>
      <label for="choose-human" class="btn">&#x1F464; I am a Human</label>
    </div>

    <section class="panel panel-agent">
      <h2>Read these docs and follow the instructions</h2>

      <div class="section-block">
        <h3 class="section-title">Send tasks to another agent</h3>
        <p class="human-note">Fetch this URL and follow the integration guide.</p>
        <div class="copy-box" onclick="navigator.clipboard.writeText('https://a2a.viveworker.com/skill.md')">
          https://a2a.viveworker.com/skill.md
        </div>
      </div>

      <hr class="divider">

      <div class="section-block">
        <h3 class="section-title">Register your human to receive tasks</h3>
        <p class="human-note">Fetch this URL and run the setup for your human.</p>
        <div class="copy-box" onclick="navigator.clipboard.writeText('https://a2a.viveworker.com/setup.md')">
          https://a2a.viveworker.com/setup.md
        </div>
      </div>
    </section>

    <section class="panel panel-human">
      <h2>Send this to your AI agent</h2>
      <p class="human-note">
        Copy the URL below and paste it to your AI agent (Claude Code, Codex, etc.).<br>
        Your agent will handle the setup. <strong>You just click "Authorize" when prompted.</strong>
      </p>
      <div class="copy-box" onclick="navigator.clipboard.writeText('https://a2a.viveworker.com/setup.md')">
        https://a2a.viveworker.com/setup.md
      </div>
      <p class="human-note">
        Or tell your agent:<br>
        <strong>"Read https://a2a.viveworker.com/setup.md and set me up as a viveworker a2a user."</strong>
      </p>
    </section>
  </main>

  <footer>
    <div class="footer-brand">viveworker</div>
    <div class="footer-links">
      <a href="https://google.github.io/A2A/" target="_blank" rel="noopener">A2A protocol</a>
      &nbsp;&middot;&nbsp;
      <a href="https://github.com/viveworker-dev/viveworker" target="_blank" rel="noopener">GitHub</a>
      &nbsp;&middot;&nbsp;
      <a href="https://www.npmjs.com/package/viveworker" target="_blank" rel="noopener">npm</a>
    </div>
  </footer>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

// ---------------------------------------------------------------------------
// Admin: delete user
// ---------------------------------------------------------------------------

async function handleAdminDeleteUser(env, request, userId) {
  // Require REGISTER_SECRET for admin operations
  const auth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const adminSecret = env.REGISTER_SECRET || "";
  if (!auth || auth !== adminSecret) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const userRecord = await env.KV.get(userKey(userId), "json");
  if (!userRecord) {
    return jsonResponse({ error: "user-not-found" }, 404);
  }

  // Delete user record
  await env.KV.delete(userKey(userId));
  // Delete pending list
  await env.KV.delete(pendingKey(userId));
  // Delete GitHub link if exists
  if (userRecord.githubId) {
    await env.KV.delete(`github:${userRecord.githubId}`);
  }

  return jsonResponse({ ok: true, deleted: userId });
}

// ---------------------------------------------------------------------------
// Stats endpoints (Analytics Engine queries)
// ---------------------------------------------------------------------------

const ANALYTICS_SQL_URL = "https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql";

/**
 * Query Analytics Engine via Cloudflare REST API.
 * Requires CF_ACCOUNT_ID and CF_API_TOKEN secrets.
 */
async function queryAnalytics(env, sql) {
  const accountId = env.CF_ACCOUNT_ID || "";
  const apiToken = env.CF_API_TOKEN || "";
  if (!accountId || !apiToken) return null;

  const url = ANALYTICS_SQL_URL.replace("{account_id}", accountId);
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}` },
    body: sql,
  });

  if (!res.ok) return null;
  return res.json();
}

/**
 * GET /stats/<userId> — Per-user task stats.
 * Auth: bridge secret (Bearer) or API key (X-A2A-Key).
 * Returns counts for last 30 days + all-time.
 */
async function handleStatsUser(env, request, userId) {
  // Strict validation before using in SQL (defense-in-depth beyond route regex)
  if (!USER_ID_RE.test(userId)) {
    return jsonResponse({ error: "invalid userId" }, 400);
  }

  const userRecord = await env.KV.get(userKey(userId), "json");
  if (!userRecord) return jsonResponse({ error: "user-not-found" }, 404);

  // Allow bridge auth or external API key
  const hasBridgeAuth = validateBridgeAuth(request, userRecord);
  const hasApiKeyAuth = validateExternalAuth(request, userRecord);
  if (!hasBridgeAuth && !hasApiKeyAuth) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const dataset = "viveworker_a2a_events";
  // userId is safe for SQL interpolation: validated by USER_ID_RE (alphanumeric, dash, underscore only)
  const safeUserId = userId.replace(/'/g, "");

  // 30-day breakdown
  const sql30d = `
    SELECT blob1 AS event, SUM(_sample_interval) AS count
    FROM ${dataset}
    WHERE index1 = '${safeUserId}'
      AND timestamp > NOW() - INTERVAL '30' DAY
      AND blob1 IN ('task_received','task_completed','task_rejected','task_failed','task_canceled')
    GROUP BY blob1
  `;

  // All-time breakdown
  const sqlAll = `
    SELECT blob1 AS event, SUM(_sample_interval) AS count
    FROM ${dataset}
    WHERE index1 = '${safeUserId}'
      AND blob1 IN ('task_received','task_completed','task_rejected','task_failed','task_canceled')
    GROUP BY blob1
  `;

  const [res30d, resAll] = await Promise.all([
    queryAnalytics(env, sql30d),
    queryAnalytics(env, sqlAll),
  ]);

  const parse = (res) => {
    const stats = { received: 0, completed: 0, rejected: 0, failed: 0, canceled: 0 };
    if (!res || !res.data) return stats;
    for (const row of res.data) {
      const key = (row.event || "").replace("task_", "");
      if (key in stats) stats[key] = Math.round(Number(row.count) || 0);
    }
    return stats;
  };

  return jsonResponse({
    userId,
    last30d: parse(res30d),
    allTime: parse(resAll),
  });
}

/**
 * GET /stats/global — Global relay stats (public).
 * Returns aggregate counts across all users for last 30 days + all-time,
 * plus total registered users.
 */
async function handleStatsGlobal(env) {
  const dataset = "viveworker_a2a_events";

  // 30-day task counts
  const sql30d = `
    SELECT blob1 AS event, SUM(_sample_interval) AS count
    FROM ${dataset}
    WHERE timestamp > NOW() - INTERVAL '30' DAY
      AND blob1 IN ('task_received','task_completed','task_rejected','task_failed','task_canceled')
    GROUP BY blob1
  `;

  // All-time task counts
  const sqlAll = `
    SELECT blob1 AS event, SUM(_sample_interval) AS count
    FROM ${dataset}
    WHERE blob1 IN ('task_received','task_completed','task_rejected','task_failed','task_canceled')
    GROUP BY blob1
  `;

  // Total unique users registered (all-time)
  const sqlUsers = `
    SELECT COUNT(DISTINCT index1) AS total
    FROM ${dataset}
    WHERE blob1 = 'user_registered'
  `;

  const [res30d, resAll, resUsers] = await Promise.all([
    queryAnalytics(env, sql30d),
    queryAnalytics(env, sqlAll),
    queryAnalytics(env, sqlUsers),
  ]);

  const parse = (res) => {
    const stats = { received: 0, completed: 0, rejected: 0, failed: 0, canceled: 0 };
    if (!res || !res.data) return stats;
    for (const row of res.data) {
      const key = (row.event || "").replace("task_", "");
      if (key in stats) stats[key] = Math.round(Number(row.count) || 0);
    }
    return stats;
  };

  const totalUsers = (resUsers && resUsers.data && resUsers.data[0])
    ? Math.round(Number(resUsers.data[0].total) || 0)
    : 0;

  return jsonResponse({
    totalUsers,
    last30d: parse(res30d),
    allTime: parse(resAll),
  });
}

// ---------------------------------------------------------------------------
// Registration IP rate limit
// ---------------------------------------------------------------------------

async function checkRegRateLimit(env, ip) {
  const key = regRateKey(ip, todayKey());
  const raw = await env.KV.get(key);
  const count = raw ? JSON.parse(raw).count : 0;
  return { allowed: count < REG_RATE_LIMIT_MAX, count };
}

async function incrementRegRateCount(env, ip) {
  const key = regRateKey(ip, todayKey());
  const raw = await env.KV.get(key);
  const count = raw ? JSON.parse(raw).count : 0;
  await env.KV.put(key, JSON.stringify({ count: count + 1 }), { expirationTtl: REG_RATE_LIMIT_TTL });
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, x-a2a-key, authorization",
          "access-control-max-age": "86400",
        },
      });
    }

    // Health check
    if (path === "/health" && request.method === "GET") {
      return jsonResponse({ ok: true, service: "viveworker-a2a" });
    }

    // Landing page
    if (path === "/" && request.method === "GET") {
      return handleLandingPage(request);
    }

    // Skill documents for agents
    if (path === "/skill.md" && request.method === "GET") {
      return new Response(SKILL_MD, {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }

    if (path === "/setup.md" && request.method === "GET") {
      return new Response(SETUP_MD, {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }

    // --- Auth endpoints ---

    if (path === "/auth/setup" && request.method === "POST") {
      return handleSetupCreate(env, request);
    }

    const setupPollMatch = path.match(/^\/auth\/setup\/([^/]+)$/);
    if (setupPollMatch && request.method === "GET") {
      return handleSetupPoll(env, setupPollMatch[1]);
    }

    if (path === "/auth/github" && request.method === "GET") {
      return handleGitHubAuth(env, request);
    }

    if (path === "/auth/github/callback" && request.method === "GET") {
      return handleGitHubCallback(env, request);
    }

    // --- Stats endpoints ---

    if (path === "/stats/global" && request.method === "GET") {
      return handleStatsGlobal(env);
    }

    const statsUserMatch = path.match(/^\/stats\/([^/]+)$/);
    if (statsUserMatch && request.method === "GET") {
      return handleStatsUser(env, request, statsUserMatch[1]);
    }

    // --- Admin endpoints ---

    const adminDeleteMatch = path.match(/^\/internal\/admin\/user\/([^/]+)$/);
    if (adminDeleteMatch && request.method === "DELETE") {
      return handleAdminDeleteUser(env, request, adminDeleteMatch[1]);
    }

    // --- Internal endpoints ---

    if (path === "/internal/register" && request.method === "POST") {
      return handleRegister(env, request);
    }

    const pollMatch = path.match(/^\/internal\/poll\/([^/]+)$/);
    if (pollMatch && request.method === "GET") {
      return handlePoll(env, request, pollMatch[1]);
    }

    const resultMatch = path.match(/^\/internal\/result\/([^/]+)\/([^/]+)$/);
    if (resultMatch && request.method === "POST") {
      return handleResult(env, request, resultMatch[1], resultMatch[2]);
    }

    // --- External endpoints ---

    const agentCardMatch = path.match(/^\/([^/]+)\/.well-known\/agent\.json$/);
    if (agentCardMatch && request.method === "GET") {
      return handleAgentCard(env, agentCardMatch[1], request.url);
    }

    const a2aMatch = path.match(/^\/([^/]+)$/);
    if (a2aMatch && request.method === "POST") {
      return handleA2A(env, request, a2aMatch[1]);
    }

    // Fallback
    return jsonResponse({ error: "not-found" }, 404);
  },
};
