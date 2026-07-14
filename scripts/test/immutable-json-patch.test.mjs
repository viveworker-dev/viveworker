import assert from "node:assert/strict";
import test from "node:test";

import { applyJsonPatch, applyJsonPatches } from "../lib/immutable-json-patch.mjs";

test("nested patches clone only containers along the changed path", () => {
  const largeUnchangedValue = { payload: "x".repeat(2 * 1024 * 1024) };
  const originalRequest = {
    id: "request-1",
    method: "item/commandExecution/requestApproval",
    params: { status: "pending", command: "npm test" },
  };
  const state = {
    cwd: "/tmp/project",
    requests: [originalRequest],
    conversation: largeUnchangedValue,
  };

  const next = applyJsonPatch(state, {
    op: "replace",
    path: "/requests/0/params/status",
    value: "approved",
  });

  assert.notStrictEqual(next, state);
  assert.notStrictEqual(next.requests, state.requests);
  assert.notStrictEqual(next.requests[0], originalRequest);
  assert.notStrictEqual(next.requests[0].params, originalRequest.params);
  assert.strictEqual(next.conversation, largeUnchangedValue);
  assert.equal(next.requests[0].params.status, "approved");
  assert.equal(state.requests[0].params.status, "pending");
});

test("multiple add, replace, and remove patches preserve array behavior", () => {
  const state = {
    requests: [
      { id: "a", params: { active: true } },
      { id: "b", params: { active: true } },
    ],
  };

  const next = applyJsonPatches(state, [
    { op: "replace", path: "/requests/0/params/active", value: false },
    { op: "add", path: "/requests/-", value: { id: "c", params: {} } },
    { op: "remove", path: "/requests/1" },
  ]);

  assert.deepEqual(next.requests, [
    { id: "a", params: { active: false } },
    { id: "c", params: {} },
  ]);
  assert.deepEqual(state.requests, [
    { id: "a", params: { active: true } },
    { id: "b", params: { active: true } },
  ]);
});

test("root replacement and escaped pointer segments are supported", () => {
  const replacement = { "a/b": { "~value": 1 } };
  const rooted = applyJsonPatch({ stale: true }, { op: "replace", path: "", value: replacement });
  const next = applyJsonPatch(rooted, { op: "replace", path: "/a~1b/~0value", value: 2 });

  assert.strictEqual(rooted, replacement);
  assert.deepEqual(next, { "a/b": { "~value": 2 } });
  assert.equal(replacement["a/b"]["~value"], 1);
});

test("object pointer writes cannot mutate Object.prototype", () => {
  const next = applyJsonPatch({}, {
    op: "add",
    path: "/__proto__/polluted",
    value: true,
  });

  assert.equal({}.polluted, undefined);
  assert.equal(next.__proto__.polluted, true);
  assert.equal(Object.getPrototypeOf(next), Object.prototype);
});
