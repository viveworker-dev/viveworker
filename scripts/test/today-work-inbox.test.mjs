import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("../viveworker-bridge.mjs", import.meta.url), "utf8");
const i18nSource = readFileSync(new URL("../../web/i18n.js", import.meta.url), "utf8");

test("inbox API exposes normalized needs-action, active, and terminal buckets", () => {
  assert.match(bridgeSource, /import \{ buildWorkItemResponse \} from "\.\/lib\/work-items\.mjs";/u);
  assert.match(bridgeSource, /function buildInProgressInboxItems\(runtime, locale\)/u);
  assert.match(bridgeSource, /pending: buildPendingInboxItems\(runtime, state, config, locale\)/u);
  assert.match(bridgeSource, /inProgress: buildInProgressInboxItems\(runtime, locale\)/u);
  assert.match(bridgeSource, /work:\s*\{[\s\S]*?health:[\s\S]*?attention/u);
});

test("today is the default inbox view with grouped work states", () => {
  assert.match(appSource, /inboxSubtab: "today"/u);
  assert.match(appSource, /function renderTodayInboxBody\(\{ desktop \}\)/u);
  assert.match(appSource, /work\.section\.needsAction/u);
  assert.match(appSource, /work\.section\.inProgress/u);
  assert.match(appSource, /work\.section\.completedToday/u);
  assert.match(appSource, /Array\.isArray\(fast\?\.inProgress\)/u);
  assert.match(appSource, /isTodayTimestamp\(item\?\.createdAtMs\)/u);
});

test("today and needs-you labels are localized", () => {
  assert.match(i18nSource, /"tab\.inbox\.title": "Today"/u);
  assert.match(i18nSource, /"inbox\.subtab\.pending": "Needs you"/u);
  assert.match(i18nSource, /"tab\.inbox\.title": "今日"/u);
  assert.match(i18nSource, /"inbox\.subtab\.pending": "要対応"/u);
});

test("notification targets remain compatible with legacy inbox subtabs", () => {
  assert.match(appSource, /new Set\(\["today", "pending", "completed"\]\)/u);
  assert.match(appSource, /function normalizeInboxSubtab\(value, fallback = "today"\)/u);
  assert.match(appSource, /data-source-subtab="\$\{escapeHtml\(sourceTab === "inbox" \? state\.inboxSubtab : "completed"\)\}"/u);
});
