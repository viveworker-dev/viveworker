/**
 * a2a-relay-client.mjs — Bridge-side polling client for the viveworker A2A relay.
 *
 * Connects the local viveworker bridge to the Cloudflare Worker relay:
 *   - Registers the bridge with the relay on first startup
 *   - Polls the relay every 20 seconds for pending A2A tasks
 *   - Posts task results (completion/failure/rejection) back to the relay
 *
 * Designed to be imported and used from viveworker-bridge.mjs.
 */

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs, readFileSync } from "node:fs";
import { upsertEnvText } from "./lib/pairing.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 20_000;     // 20 seconds
const REQUEST_TIMEOUT_MS = 15_000;   // 15 seconds per HTTP request
const A2A_ENV_FILE = path.join(os.homedir(), ".viveworker", "a2a.env");

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let pollTimer = null;
let isPolling = false;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register this bridge with the A2A relay. On first registration, generates
 * a bridgeSecret and writes it back to ~/.viveworker/a2a.env.
 *
 * @param {object} params
 * @param {object} params.config - Bridge config (must have a2aRelayUrl, a2aRelayUserId, a2aApiKey)
 * @param {Function} params.buildAgentCard - Function to build the local agent card
 * @returns {Promise<{ ok: boolean, relayUrl?: string, error?: string }>}
 */
export async function registerWithRelay({ config, buildAgentCard }) {
  const relayUrl = config.a2aRelayUrl;
  const userId = config.a2aRelayUserId;

  if (!relayUrl || !userId) {
    return { ok: false, error: "A2A_RELAY_URL or A2A_RELAY_USER_ID not configured" };
  }

  // Generate or reuse bridgeSecret
  let bridgeSecret = config.a2aRelaySecret || "";
  const isNewSecret = !bridgeSecret;
  if (isNewSecret) {
    bridgeSecret = crypto.randomBytes(32).toString("hex");
  }

  const agentCard = typeof buildAgentCard === "function"
    ? buildAgentCard(config)
    : {};

  const body = {
    userId,
    bridgeSecret,
    a2aApiKey: config.a2aApiKey || "",
    agentCard,
    ...(config.a2aRelayRegisterSecret ? { registerSecret: config.a2aRelayRegisterSecret } : {}),
  };

  const headers = {
    "content-type": "application/json",
  };
  // Re-registration requires the current bridgeSecret
  if (!isNewSecret) {
    headers["authorization"] = `Bearer ${bridgeSecret}`;
  }

  try {
    const res = await fetchWithTimeout(`${relayUrl}/internal/register`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!res.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }

    // On success, write bridgeSecret back to a2a.env if new
    if (isNewSecret) {
      await persistRelaySecret(bridgeSecret);
      // Update config in-place so subsequent calls use the secret
      config.a2aRelaySecret = bridgeSecret;
    }

    console.log(`[a2a-relay] Registered as ${userId} → ${data.relayUrl || relayUrl}`);
    return { ok: true, relayUrl: data.relayUrl };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/**
 * Start polling the relay for pending A2A tasks. Tasks are ingested into
 * the local runtime just like locally-received A2A tasks.
 *
 * @param {object} params
 * @param {object} params.config       - Bridge config
 * @param {object} params.runtime      - Bridge runtime state
 * @param {object} params.state        - Persistent state
 * @param {object} params.helpers      - { recordTimelineEntry, deliverWebPushItem, saveState, historyToken, cleanText }
 */
export function startRelayPolling({ config, runtime, state, helpers }) {
  if (pollTimer) {
    console.warn("[a2a-relay] Polling already started, skipping duplicate start");
    return;
  }

  const relayUrl = config.a2aRelayUrl;
  const userId = config.a2aRelayUserId;
  const secret = config.a2aRelaySecret;

  if (!relayUrl || !userId || !secret) {
    console.warn("[a2a-relay] Cannot start polling — missing relay config");
    return;
  }

  console.log(`[a2a-relay] Starting poll loop (every ${POLL_INTERVAL_MS / 1000}s) for user ${userId}`);

  // Do an initial poll immediately, then schedule interval
  pollOnce({ config, runtime, state, helpers }).catch((err) => {
    console.error(`[a2a-relay] Initial poll error: ${err.message}`);
  });

  pollTimer = setInterval(() => {
    if (isPolling || runtime.stopping) return;
    pollOnce({ config, runtime, state, helpers }).catch((err) => {
      console.error(`[a2a-relay] Poll error: ${err.message}`);
    });
  }, POLL_INTERVAL_MS);

  // Allow Node to exit even if timer is running
  if (pollTimer.unref) pollTimer.unref();
}

/**
 * Stop relay polling. Call on bridge shutdown.
 */
export function stopRelayPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  isPolling = false;
  console.log("[a2a-relay] Polling stopped");
}

/**
 * Single poll cycle: fetch pending tasks from the relay and ingest them.
 */
async function pollOnce({ config, runtime, state, helpers }) {
  if (runtime.stopping) return;
  isPolling = true;

  try {
    const relayUrl = config.a2aRelayUrl;
    const userId = config.a2aRelayUserId;
    const secret = config.a2aRelaySecret;

    const res = await fetchWithTimeout(`${relayUrl}/internal/poll/${userId}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${secret}`,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[a2a-relay] Poll failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      return;
    }

    const data = await res.json();
    const tasks = data.tasks || [];

    if (tasks.length === 0) return;

    console.log(`[a2a-relay] Received ${tasks.length} task(s) from relay`);

    for (const relayTask of tasks) {
      await ingestRelayTask({ relayTask, config, runtime, state, helpers });
    }
  } finally {
    isPolling = false;
  }
}

/**
 * Ingest a single relay task into local runtime. Creates the same structure
 * as a locally-received A2A task, tagged with relayTaskId for result posting.
 */
async function ingestRelayTask({ relayTask, config, runtime, state, helpers }) {
  const { recordTimelineEntry, deliverWebPushItem, saveState, historyToken, cleanText } = helpers;

  // Skip if we already have this task (deduplicate)
  for (const existing of runtime.a2aTasksByToken.values()) {
    if (existing.relayTaskId === relayTask.id) {
      return; // already ingested
    }
  }

  const token = historyToken(`a2a_task:${relayTask.id}`);
  const instruction = cleanText(relayTask.instruction || "");
  const now = Date.now();

  const task = {
    id: relayTask.id,
    token,
    contextId: relayTask.contextId || crypto.randomUUID(),
    status: "submitted",
    statusMessage: "",
    messages: relayTask.messages || [],
    artifacts: [],
    instruction,
    callerInfo: relayTask.callerInfo || {},
    createdAtMs: relayTask.createdAtMs || now,
    updatedAtMs: now,
    decisionWaiters: [],
    decision: null,
    // Mark as relay-originated so we know to post results back
    relayTaskId: relayTask.id,
    relayUserId: config.a2aRelayUserId,
  };

  runtime.a2aTasksByToken.set(token, task);

  // Record timeline entry (same as local A2A handler)
  try {
    recordTimelineEntry({
      config,
      runtime,
      state,
      entry: {
        stableId: `a2a_task:${relayTask.id}`,
        token,
        kind: "a2a_task",
        threadId: "a2a",
        threadLabel: "A2A",
        title: `A2A: ${instruction.slice(0, 80)}`,
        summary: instruction.slice(0, 160),
        messageText: instruction,
        createdAtMs: relayTask.createdAtMs || now,
        readOnly: false,
        provider: "a2a",
      },
    });
    await saveState(config.stateFile, state);
  } catch (err) {
    console.error(`[a2a-relay] Timeline save error: ${err.message}`);
  }

  // Send Web Push notification
  try {
    await deliverWebPushItem({
      config,
      state,
      kind: "a2a_task",
      token,
      stableId: `a2a_task:${relayTask.id}`,
      title: "A2A Task Request",
      body: instruction.slice(0, 160),
      buildLocalizedContent: ({ locale }) => {
        const lang = locale?.startsWith("ja") ? "ja" : "en";
        return {
          title: lang === "ja" ? "\u{1F91D} A2Aリレー経由のタスク依頼" : "\u{1F91D} A2A task via relay",
          body: instruction.slice(0, 160),
        };
      },
    });
  } catch (err) {
    console.error(`[a2a-relay] Push notification error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Result posting
// ---------------------------------------------------------------------------

/**
 * Post a task result back to the relay. Called after task completion,
 * failure, or rejection.
 *
 * @param {object} params
 * @param {object} params.config - Bridge config (a2aRelayUrl, a2aRelayUserId, a2aRelaySecret)
 * @param {object} params.task   - A2A task object with relayTaskId
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function postRelayResult({ config, task }) {
  if (!task.relayTaskId) {
    return { ok: false, error: "Not a relay task" };
  }

  const relayUrl = config.a2aRelayUrl;
  const userId = task.relayUserId || config.a2aRelayUserId;
  const secret = config.a2aRelaySecret;

  if (!relayUrl || !userId || !secret) {
    return { ok: false, error: "Relay not configured" };
  }

  const body = {
    status: task.status,
    statusMessage: task.statusMessage || "",
    updatedAtMs: task.updatedAtMs || Date.now(),
    artifacts: task.artifacts || [],
  };

  try {
    const res = await fetchWithTimeout(
      `${relayUrl}/internal/result/${userId}/${task.relayTaskId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(body),
      }
    );

    const data = await res.json();

    if (!res.ok) {
      console.error(`[a2a-relay] Result post failed: HTTP ${res.status} ${data.error || ""}`);
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }

    console.log(`[a2a-relay] Result posted for task ${task.relayTaskId} → ${data.status}`);
    return { ok: true };
  } catch (err) {
    console.error(`[a2a-relay] Result post error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write A2A_RELAY_SECRET back to ~/.viveworker/a2a.env.
 */
async function persistRelaySecret(secret) {
  try {
    let current = "";
    try {
      current = await fs.readFile(A2A_ENV_FILE, "utf8");
    } catch {
      // File may not exist yet
    }

    const updated = upsertEnvText(current, {
      A2A_RELAY_SECRET: secret,
    });

    await fs.mkdir(path.dirname(A2A_ENV_FILE), { recursive: true, mode: 0o700 });
    await fs.writeFile(A2A_ENV_FILE, updated, { mode: 0o600 });
    console.log(`[a2a-relay] Wrote A2A_RELAY_SECRET to ${A2A_ENV_FILE}`);
  } catch (err) {
    console.error(`[a2a-relay] Failed to write relay secret: ${err.message}`);
  }
}

/**
 * fetch() with a timeout via AbortSignal.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
