import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const appSource = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");

test("approval actions render the result before the full authenticated refresh", () => {
  const start = appSource.indexOf('for (const button of document.querySelectorAll("[data-action-url]"))');
  assert.notEqual(start, -1);
  const end = appSource.indexOf('for (const button of document.querySelectorAll("[data-open-completion-reply-sheet]', start);
  assert.notEqual(end, -1);
  const block = appSource.slice(start, end);

  const approvalFastPath = block.indexOf('if (activeItem?.kind === "approval")');
  const deletePending = block.indexOf("state.pendingActionUrls.delete(actionUrl);", approvalFastPath);
  const pinOutcome = block.indexOf("pinActionOutcomeDetail(", approvalFastPath);
  const render = block.indexOf("await renderShell();", approvalFastPath);
  const backgroundRefresh = block.indexOf("void refreshAuthenticatedState()", approvalFastPath);
  const blockingRefresh = block.indexOf("await refreshAuthenticatedState();", approvalFastPath);

  assert.ok(approvalFastPath > -1, "approval fast path exists");
  assert.ok(deletePending > approvalFastPath, "pending state is cleared before success render");
  assert.ok(pinOutcome > deletePending, "success detail is pinned before render");
  assert.ok(render > pinOutcome, "success detail renders immediately");
  assert.ok(backgroundRefresh > render, "full refresh runs after the immediate render");
  assert.ok(blockingRefresh === -1 || blockingRefresh > backgroundRefresh, "approval fast path does not block on the full refresh");
});
