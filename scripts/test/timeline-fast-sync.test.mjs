import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
const buildIdSource = readFileSync(new URL("../../web/build-id.js", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("../../scripts/viveworker-bridge.mjs", import.meta.url), "utf8");

test("timeline polling is bounded and independent from secondary probes", () => {
  assert.match(appSource, /let authenticatedPollInFlight = false;/);
  assert.match(appSource, /runFastPollStep\(\s*"timeline",\s*\(\) => refreshTimeline\(\{ timeoutMs: TIMELINE_POLL_TIMEOUT_MS \}\)/);
  assert.match(appSource, /runFastPollStep\(\s*"push",\s*\(\) => refreshPushStatus\(\{ timeoutMs: FAST_POLL_STEP_TIMEOUT_MS \}\)/);
  assert.match(appSource, /runFastPollStep\(\s*"a2a-relay",\s*\(\) => fetchA2aRelayStatus\(\{ timeoutMs: FAST_POLL_STEP_TIMEOUT_MS \}\)/);
  assert.doesNotMatch(appSource, /refreshTimeline\(\),\s*refreshDevices\(\),\s*refreshPushStatus\(\)/);
});

test("boot local refresh also uses bounded timeline requests", () => {
  assert.match(appSource, /refreshInbox\(\{ timeoutMs: FAST_POLL_STEP_TIMEOUT_MS \}\)/);
  assert.match(appSource, /refreshTimeline\(\{ timeoutMs: TIMELINE_POLL_TIMEOUT_MS \}\)/);
  assert.match(appSource, /refreshDevices\(\{ timeoutMs: FAST_POLL_STEP_TIMEOUT_MS \}\)/);
});

test("timeline refresh reprobes LAN while sticky relay is active", () => {
  assert.match(appSource, /timeoutMs: TIMELINE_REFRESH_TIMEOUT_MS,/);
  assert.match(appSource, /probeLanWhileSticky: true,/);
  assert.match(appSource, /stickyLanProbeTimeoutMs: TIMELINE_STICKY_LAN_PROBE_TIMEOUT_MS,/);
});

test("build id marks the fast timeline sync bundle", () => {
  assert.match(buildIdSource, /20260504-command-event-detail-v1/);
});

test("timeline render is reported with sanitized client metadata", () => {
  assert.match(appSource, /function reportTimelineRendered/);
  assert.match(appSource, /"\/api\/client-events"/);
  assert.match(appSource, /latestToken/);
  assert.match(appSource, /latestKind/);
  assert.match(appSource, /renderedTokens/);
  assert.doesNotMatch(appSource, /messageText:\s*latest/);
});

test("LAN timeline live sync uses SSE with polling fallback", () => {
  assert.match(bridgeSource, /class TimelineBus/);
  assert.match(bridgeSource, /\/api\/timeline\/stream/);
  assert.match(bridgeSource, /text\/event-stream/);
  assert.match(bridgeSource, /timeline:update/);
  assert.match(bridgeSource, /TIMELINE_LIVE_SYNC/);
  assert.match(bridgeSource, /\[timeline-ingest\]/);
  assert.match(appSource, /new EventSource\("\/api\/timeline\/stream"\)/);
  assert.match(appSource, /handleTimelineLiveUpdate/);
  assert.match(appSource, /syncTimelineLiveStream/);
  assert.match(appSource, /refreshTimelineDirectLan/);
  assert.match(appSource, /apiGetDirectLan/);
  assert.match(appSource, /if \(timelineLiveStream\) \{\s*return;\s*\}/);
});

test("timeline live ingest watches Codex and Claude sources", () => {
  assert.match(bridgeSource, /watchFs/);
  assert.match(bridgeSource, /label: "codex-home"/);
  assert.match(bridgeSource, /label: "codex-sessions"/);
  assert.match(bridgeSource, /label: "claude-projects"/);
  assert.match(bridgeSource, /if \(runtime\.timelineLiveScanTimer\) \{\s*return;\s*\}/);
  assert.match(bridgeSource, /processHistoryTimelineFile/);
  assert.match(bridgeSource, /processSqliteTimelineLog/);
  assert.match(bridgeSource, /processClaudeTranscriptFile/);
});

test("initial detail load renders even when draft editing is protected from refresh", () => {
  assert.match(appSource, /const hadRenderableDetailAtStart = Boolean\(renderableCurrentDetail\(requestedItem\)\);/);
  assert.match(appSource, /const completedInitialDetailLoad =[\s\S]*?!hadRenderableDetailAtStart[\s\S]*?isSameItemRef\(state\.currentDetail, requestedItem\)[\s\S]*?isSameItemRef\(state\.currentItem, requestedItem\);/);
  assert.match(appSource, /shouldDeferRenderForActiveInteraction\(\) && !completedInitialDetailLoad/);
  assert.match(appSource, /state\.currentDetail\?\.kind === "moltbook_draft"/);
});
