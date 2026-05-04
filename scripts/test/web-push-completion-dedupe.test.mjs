import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const bridgeSource = readFileSync(new URL("../viveworker-bridge.mjs", import.meta.url), "utf8");

test("completion web push uses content dedupe across native event ids", () => {
  assert.match(bridgeSource, /const COMPLETION_PUSH_CONTENT_DEDUPE_WINDOW_MS = 2 \* 60 \* 1000;/);
  assert.match(bridgeSource, /function completionPushContentDedupeId\(event\)/);
  assert.match(bridgeSource, /task_complete_content:\$\{threadId\}:\$\{historyToken\(messageText\)\}/);
  assert.match(bridgeSource, /dedupeId: completionPushContentDedupeId\(event\),/);
  assert.match(bridgeSource, /dedupeWindowMs: COMPLETION_PUSH_CONTENT_DEDUPE_WINDOW_MS,/);
});

test("web push delivery records both exact stable id and semantic dedupe id", () => {
  assert.match(bridgeSource, /stableDeliveryKey = pushDeliveryKey\(subscription\.deviceId, stableId\)/);
  assert.match(bridgeSource, /dedupeDeliveryKey = pushDeliveryKey\(subscription\.deviceId, dedupeId \|\| stableId\)/);
  assert.match(bridgeSource, /state\.pushDeliveries\[stableDeliveryKey\] = now;/);
  assert.match(bridgeSource, /state\.pushDeliveries\[dedupeDeliveryKey\] = now;/);
});

test("rollout task_complete carries thread metadata for completion push dedupe", () => {
  assert.match(
    bridgeSource,
    /record\.type === "event_msg" && record\.payload\?\.type === "task_complete"[\s\S]*?threadId,[\s\S]*?turnId,/,
  );
});
