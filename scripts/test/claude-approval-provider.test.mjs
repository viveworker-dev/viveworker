import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const bridgeSource = readFileSync(new URL("../viveworker-bridge.mjs", import.meta.url), "utf8");
const claudeHookSource = readFileSync(new URL("../viveworker-claude-hook.mjs", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");

test("Claude approvals carry raw params for Web Push body generation", () => {
  assert.match(bridgeSource, /function claudeApprovalRawParams\(body, kind\)/);
  assert.match(bridgeSource, /const rawParams = claudeApprovalRawParams\(body, approvalKind\);/);
  assert.match(bridgeSource, /rawParams,/);
  assert.match(bridgeSource, /formatNativeApprovalMessage\(approval\.kind, approval\.rawParams, locale\)/);
  assert.match(bridgeSource, /const safeParams = isPlainObject\(params\) \? params : \{\};/);
});

test("Claude approval Web Push delivery is awaited and logged", () => {
  assert.match(bridgeSource, /const pushChanged = await deliverWebPushItem\(\{/);
  assert.match(bridgeSource, /await saveState\(config\.stateFile, state\);/);
  assert.match(bridgeSource, /\[claude-approval-push\]/);
});

test("bridge saves state through a private temp file before replacing state.json", () => {
  assert.match(bridgeSource, /const tmpFile = path\.join\(stateDir,/);
  assert.match(bridgeSource, /await fs\.writeFile\(tmpFile,/);
  assert.match(bridgeSource, /await fs\.rename\(tmpFile, stateFile\);/);
  assert.match(bridgeSource, /await fs\.unlink\(tmpFile\)\.catch\(\(\) => \{\}\);/);
});

test("approval action outcome uses the loaded detail provider before falling back", () => {
  assert.match(
    appSource,
    /approvalOutcomeMessage\(actionUrl, state\.currentDetail\?\.provider \|\| activeItem\?\.provider\)/
  );
});

test("command approval markdown fences are escaped before display", () => {
  assert.match(bridgeSource, /function escapeMarkdownCodeFenceBody/);
  assert.match(bridgeSource, /escapeMarkdownCodeFenceBody\(command\)/);
  assert.match(bridgeSource, /escapeMarkdownCodeFenceBody\(commandText\)/);
  assert.match(claudeHookSource, /function escapeMarkdownCodeFenceBody/);
  assert.match(claudeHookSource, /escapeMarkdownCodeFenceBody\(cmd\.slice\(0, 500\)\)/);
});
