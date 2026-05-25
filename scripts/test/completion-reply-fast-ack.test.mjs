import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

async function readBridge() {
  return fs.readFile(path.join(repoRoot, "scripts/viveworker-bridge.mjs"), "utf8");
}

async function readApp() {
  return fs.readFile(path.join(repoRoot, "web/app.js"), "utf8");
}

test("completion reply treats slow Codex ACK as fast accepted delivery", async () => {
  const bridge = await readBridge();

  assert.match(
    bridge,
    /const DEFAULT_COMPLETION_REPLY_ACK_TIMEOUT_MS = 1200;/u,
    "Codex reply should not keep the phone in sending state for the legacy 4.5s ACK window"
  );
  assert.match(
    bridge,
    /completionReplyAckTimeoutMs:\s*numberEnv\(\s*"COMPLETION_REPLY_ACK_TIMEOUT_MS",\s*DEFAULT_COMPLETION_REPLY_ACK_TIMEOUT_MS\s*\)/u
  );
  assert.match(
    bridge,
    /ackTimeout:\s*replyResult\?\.ackTimeout === true/u,
    "The API response should expose accepted-after-ACK-timeout for diagnostics"
  );
});

test("completion reply retries without stale Codex owner client", async () => {
  const bridge = await readBridge();

  assert.match(
    bridge,
    /function isIpcNoClientFoundError\(errorValue\)/u,
    "Bridge should classify Codex no-client-found as a recoverable stale owner error"
  );
  assert.match(
    bridge,
    /async sendThreadFollowerRequest\([\s\S]*?targetClientId[\s\S]*?catch \(error\)[\s\S]*?isIpcNoClientFoundError\(error\)[\s\S]*?threadOwnerClientIds\.delete\(conversationId\)[\s\S]*?retrying without target[\s\S]*?targetClientId: null/u,
    "Thread-follower requests should clear stale ownerClientId and retry without a target"
  );
  assert.match(
    bridge,
    /isIpcNoClientFoundError\(error\)[\s\S]*?writeJson\(res,\s*503,\s*\{\s*error:\s*"codex-client-not-found"\s*\}\)/u,
    "If the retry still fails, the API should return a stable localized error key"
  );
});

test("completion reply reopens the Codex thread before surfacing no-client-found", async () => {
  const bridge = await readBridge();

  assert.match(
    bridge,
    /const DEFAULT_COMPLETION_REPLY_THREAD_REOPEN_WAIT_MS = 1800;/u,
    "The thread reopen fallback should wait briefly for Codex Desktop to attach the target thread"
  );
  assert.match(
    bridge,
    /function codexThreadDeepLink\(conversationId\)[\s\S]*?codex:\/\/local\/[\s\S]*?function openCodexThreadBestEffort\(conversationId\)/u,
    "Bridge should be able to reopen the target Codex thread via the desktop deep link"
  );
  assert.match(
    bridge,
    /isIpcNoClientFoundError\(candidateError\)[\s\S]*?openCodexThreadBestEffort\(conversationId\)[\s\S]*?waitForCodexThreadOwner\([\s\S]*?sendReplyCandidate\(candidate,\s*"after-reopen"\)/u,
    "A no-client-found reply should auto-reopen the target thread and retry once before returning an error"
  );
});

test("completion reply UI does not stay stuck on sending when the response is slow", async () => {
  const app = await readApp();

  assert.match(app, /const COMPLETION_REPLY_OPTIMISTIC_SENT_MS = 1_600;/u);
  assert.match(app, /const optimisticSentTimer = setTimeout\(renderOptimisticSent, COMPLETION_REPLY_OPTIMISTIC_SENT_MS\);/u);
  assert.match(app, /clearTimeout\(optimisticSentTimer\);/u);
  assert.match(app, /function isCompletionReplyLateNetworkResult\(error\)[\s\S]*error\?\.errorKey === "request-timeout"[\s\S]*LAN_FETCH_TIMEOUT_MESSAGE/u);
  assert.match(app, /isCompletionReplyLateNetworkResult\(error\)[\s\S]*optimisticDraft\.collapsedAfterSend/u);
});
