import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkItemResponse, WORK_ITEM_SCHEMA_VERSION } from "../lib/work-items.mjs";

function item(overrides = {}) {
  return {
    kind: "approval",
    token: "token-1",
    threadId: "thread-1",
    title: "Review change",
    createdAtMs: 100,
    provider: "codex",
    ...overrides,
  };
}

test("normalizes inbox buckets into a common work item schema", () => {
  const response = buildWorkItemResponse({
    pending: [item({ approvalKind: "hazbase_wallet_payment" })],
    inProgress: [item({ kind: "activity_status", token: "active-1", threadId: "thread-2", createdAtMs: 90 })],
    completed: [item({ kind: "assistant_final", token: "done-1", threadId: "thread-3", createdAtMs: 80 })],
    generatedAtMs: 200,
  });

  assert.equal(response.schemaVersion, WORK_ITEM_SCHEMA_VERSION);
  assert.deepEqual(response.counts, { needsAction: 1, inProgress: 1, completed: 1, failed: 0 });
  assert.equal(response.pending[0].work.state, "needs_action");
  assert.equal(response.pending[0].work.category, "payment");
  assert.equal(response.pending[0].work.priority, "urgent");
  assert.equal(response.pending[0].work.requiresAction, true);
  assert.deepEqual(response.pending[0].work.sourceRef, {
    provider: "codex",
    kind: "approval",
    token: "token-1",
    threadId: "thread-1",
  });
  assert.equal(response.inProgress[0].work.state, "in_progress");
  assert.equal(response.completed[0].work.state, "completed");
});

test("suppresses active status while the same provider thread needs action", () => {
  const response = buildWorkItemResponse({
    pending: [item()],
    inProgress: [item({ kind: "activity_status", token: "active-1", createdAtMs: 110 })],
  });

  assert.equal(response.pending.length, 1);
  assert.equal(response.inProgress.length, 0);
});

test("terminal state wins when a stale pending copy has the same identity", () => {
  const shared = item({ token: "shared" });
  const response = buildWorkItemResponse({
    pending: [shared],
    completed: [{ ...shared, createdAtMs: 120 }],
  });

  assert.equal(response.pending.length, 0);
  assert.equal(response.completed.length, 1);
  assert.equal(response.completed[0].work.state, "completed");
});

test("preserves failed A2A results and read-only requests", () => {
  const response = buildWorkItemResponse({
    pending: [item({ kind: "choice", supported: false })],
    completed: [item({ kind: "a2a_task_result", taskStatus: "failed", provider: "a2a" })],
  });

  assert.equal(response.pending[0].work.requiresAction, false);
  assert.equal(response.completed[0].work.state, "failed");
  assert.equal(response.counts.failed, 1);
});
