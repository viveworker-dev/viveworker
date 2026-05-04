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

test("completion reply UI does not stay stuck on sending when the response is slow", async () => {
  const app = await readApp();

  assert.match(app, /const COMPLETION_REPLY_OPTIMISTIC_SENT_MS = 1_600;/u);
  assert.match(app, /const optimisticSentTimer = setTimeout\(renderOptimisticSent, COMPLETION_REPLY_OPTIMISTIC_SENT_MS\);/u);
  assert.match(app, /clearTimeout\(optimisticSentTimer\);/u);
  assert.match(app, /error\.errorKey === "request-timeout"[\s\S]*optimisticDraft\.collapsedAfterSend/u);
});
