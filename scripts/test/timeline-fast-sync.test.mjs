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

test("build id marks the current web bundle", () => {
  assert.match(buildIdSource, /20260713-lan-recovery-v2/);
});

test("bridge startup does not block LAN listening on rollout label indexing", () => {
  assert.match(bridgeSource, /const timer = setTimeout\(run, STARTUP_MAINTENANCE_DELAY_MS\)/);
  assert.match(bridgeSource, /void buildRolloutThreadLabelIndex\(runtime\.knownFiles, runtime\.sessionIndex\)/);
  assert.match(bridgeSource, /ROLLOUT_LABEL_METADATA_MAX_BYTES/);
  assert.match(bridgeSource, /await yieldToEventLoop\(\)/);
});

test("bridge starts LAN listening before optional state backfills", () => {
  const listenAt = bridgeSource.indexOf("await startHttpServer(approvalServer");
  const maintenanceAt = bridgeSource.indexOf("scheduleStartupMaintenance({ config, runtime, state })", listenAt);
  assert.ok(listenAt >= 0);
  assert.ok(maintenanceAt > listenAt);
  const stateInitStart = bridgeSource.indexOf("const initialHistoryItems");
  const stateInitEnd = bridgeSource.indexOf("function defaultLocale", stateInitStart);
  assert.doesNotMatch(bridgeSource.slice(stateInitStart, stateInitEnd), /await backfillPersistedTimelineImagePaths|await backfillMoltbookInboxHistory|await recoverMissingProviderStateFromBackup/);
});

test("startup scans yield to HTTPS and defer maintenance until the first scan completes", () => {
  assert.match(bridgeSource, /lineIndex % SCAN_COOPERATIVE_YIELD_EVERY === 0/);
  assert.match(bridgeSource, /if \(!runtime\.initialScanComplete\)[\s\S]*STARTUP_MAINTENANCE_RETRY_MS/);
  assert.match(bridgeSource, /runtime\.initialScanComplete = true/);
});

test("apply_patch recovery uses bounded reverse lookup with negative caching", () => {
  const start = bridgeSource.indexOf("async function findStoredApplyPatchInput");
  const end = bridgeSource.indexOf("function diffPathForSide", start);
  const lookupSource = bridgeSource.slice(start, end);
  assert.match(lookupSource, /APPLY_PATCH_LOOKBACK_BYTES/);
  assert.match(lookupSource, /applyPatchLookupMisses/);
  assert.match(lookupSource, /lastIndexOf\("\\n"/);
  assert.match(lookupSource, /await yieldToEventLoop\(\)/);
  assert.doesNotMatch(lookupSource, /fs\.readFile\(/);
  assert.doesNotMatch(lookupSource, /content\.split\(/);
});

test("Moltbook history backfill batches additions without renormalizing history per item", () => {
  const start = bridgeSource.indexOf("async function backfillMoltbookInboxHistory");
  const end = bridgeSource.indexOf("async function runDeferredStartupBackfills", start);
  const backfillSource = bridgeSource.slice(start, end);
  assert.match(backfillSource, /const additions = \[\]/);
  assert.match(backfillSource, /mergeNormalizedHistoryItems/);
  assert.doesNotMatch(backfillSource, /recordHistoryItem\(/);
  assert.doesNotMatch(backfillSource, /recentHistoryItems\.some\(/);
});

test("timeline render is reported with sanitized client metadata", () => {
  assert.match(appSource, /function reportTimelineRendered/);
  assert.match(appSource, /"\/api\/client-events"/);
  assert.match(appSource, /latestToken/);
  assert.match(appSource, /latestKind/);
  assert.match(appSource, /renderedTokens/);
  assert.doesNotMatch(appSource, /messageText:\s*latest/);
});

test("timeline hides Codex auto-review decision JSON", () => {
  assert.match(bridgeSource, /function isHiddenCodexApprovalDecisionJsonText/);
  assert.match(bridgeSource, /new Set\(\["risk_level", "user_authorization", "outcome", "rationale"\]\)/);
  assert.match(bridgeSource, /outcome !== "allow" && outcome !== "deny"/);
  assert.match(bridgeSource, /isHiddenCodexApprovalDecisionJsonText\(item\.messageText\)/);
  assert.match(bridgeSource, /isHiddenCodexApprovalDecisionJsonText\(item\.summary\)/);
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
