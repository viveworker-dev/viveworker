import assert from "node:assert/strict";
import test from "node:test";

import { projectConversationState, projectIpcMessage } from "../lib/ipc-message-projector.mjs";

test("conversation snapshots retain bridge fields and discard transcript-heavy state", () => {
  const projected = projectConversationState({
    id: "thread-1",
    cwd: "/tmp/project",
    title: "Project task",
    requests: [{ id: "r1", method: "request_user_input", params: { questions: ["Continue?"] } }],
    latestCollaborationMode: {
      mode: "plan",
      settings: {
        model: "gpt-5",
        reasoning_effort: "high",
        developer_instructions: "x".repeat(1_000_000),
      },
    },
    turns: [{ items: [{ content: "x".repeat(4 * 1024 * 1024) }] }],
  });

  assert.deepEqual(projected, {
    id: "thread-1",
    cwd: "/tmp/project",
    title: "Project task",
    requests: [{ id: "r1", method: "request_user_input", params: { questions: ["Continue?"] } }],
    latestCollaborationMode: {
      mode: "plan",
      settings: { model: "gpt-5", reasoning_effort: "high" },
    },
  });
  assert.equal("turns" in projected, false);
});

test("thread state broadcasts filter irrelevant patches but keep request updates", () => {
  const projected = projectIpcMessage({
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "owner-1",
    params: {
      conversationId: "thread-1",
      change: {
        type: "patches",
        patches: [
          { op: "add", path: "/turns/0/items/-", value: { content: "large" } },
          {
            op: "add",
            path: "/requests/-",
            value: { id: "r1", method: "item/commandExecution/requestApproval", params: { cmd: "npm test" } },
          },
          { op: "replace", path: "/cwd", value: "/tmp/next" },
        ],
      },
    },
  });

  assert.deepEqual(projected.params.change.patches, [
    {
      op: "add",
      path: "/requests/-",
      value: { id: "r1", method: "item/commandExecution/requestApproval", params: { cmd: "npm test" } },
    },
    { op: "replace", path: "/cwd", value: "/tmp/next" },
  ]);
  assert.equal(projected.sourceClientId, "owner-1");
});

test("non-thread IPC messages pass through unchanged", () => {
  const message = { type: "response", requestId: "1", result: { ok: true } };
  assert.strictEqual(projectIpcMessage(message), message);
});
