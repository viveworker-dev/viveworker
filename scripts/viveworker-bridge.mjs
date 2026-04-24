#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { promises as fs, readFileSync, createReadStream } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import webPush from "web-push";
import * as hazbaseAuth from "@hazbase/auth";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, localeDisplayName, normalizeLocale, resolveLocalePreference, t } from "../web/i18n.js";
import { generatePairingCredentials, shouldRotatePairing, upsertEnvText } from "./lib/pairing.mjs";
import { renderMarkdownHtml } from "./lib/markdown-render.mjs";
import { buildAgentCard, handleA2ARequest, resolveA2ATaskDecision, completeA2ATask, failA2ATask } from "./a2a-handler.mjs";
import { registerWithRelay, startRelayPolling, stopRelayPolling, postRelayResult, getRelayStatus, updatePublicTasksFlag } from "./a2a-relay-client.mjs";
import { createMoltbookClient, readScoutState, writeScoutState, rollScoutDayIfNeeded, markPostSeen, recordComposeAttempt, writeDraft, readDraft, deleteDraft, listPendingDrafts, solveVerificationPuzzle, solvePuzzleWithLLM, recordPuzzleAttempt, listInboxItems } from "./moltbook-api.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "..");
const webRoot = path.join(workspaceRoot, "web");
const {
  bootstrapPasskeyAccount,
  completePasskeyAssertion,
  completePasskeyRegistration,
  listSupportedChains,
  requestEmailOtp: requestHazbaseEmailOtp,
  requestPasskeyAssertionChallenge,
  requestPasskeyRegistrationChallenge,
  setApiEndpoint: setHazbaseApiEndpoint,
  setClientKey: setHazbaseClientKey,
  verifyEmailOtp: verifyHazbaseEmailOtp,
} = hazbaseAuth;
const listSupportedPayments = typeof hazbaseAuth.listSupportedPayments === "function"
  ? hazbaseAuth.listSupportedPayments.bind(hazbaseAuth)
  : async () => ({ networks: [], defaultNetwork: "base-sepolia" });
const appPackageVersion = readPackageVersion();
const sessionCookieName = "viveworker_session";
const deviceCookieName = "viveworker_device";
const historyKinds = new Set(["completion", "assistant_final", "plan_ready", "approval", "plan", "choice", "info", "moltbook_reply", "moltbook_draft", "thread_share", "a2a_task", "a2a_task_result"]);
const timelineMessageKinds = new Set(["user_message", "assistant_commentary", "assistant_final"]);
const timelineKinds = new Set([...timelineMessageKinds, "ambient_suggestions", "approval", "plan", "choice", "plan_ready", "file_event", "moltbook_reply", "moltbook_draft", "thread_share", "a2a_task", "a2a_task_result"]);
const SQLITE_COMPLETION_BATCH_SIZE = 200;
const DEFAULT_DEVICE_TRUST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PAIRED_DEVICES = 200;
const PAIRING_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const PAIRING_RATE_LIMIT_MAX_ATTEMPTS = 8;
const DEFAULT_COMPLETION_REPLY_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const DEFAULT_COMPLETION_REPLY_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_COMPLETION_REPLY_IMAGE_COUNT = 4;

// Shared memo for buildDiffThreadGroups. Each call spawns 3 git subprocesses
// per tracked repo (`git diff --name-status`, `git status --porcelain`,
// `git diff`) plus a `git rev-parse` per unique dir — roughly 10+ subprocess
// spawns for a typical multi-repo state. Both /api/inbox/diff and
// /api/items/diff_thread/:token call this function; when the user taps a
// detail right after the inbox finished loading, the computation is
// duplicated unnecessarily. Short TTL + explicit invalidation when
// recentCodeEvents mutates keeps the result fresh without the recompute cost.
// Hoisted here so code-event migration at startup can call
// invalidateDiffThreadGroupsCache() before any of the use sites below
// execute, avoiding a temporal-dead-zone ReferenceError on `let`.
const DIFF_THREAD_GROUPS_CACHE_TTL_MS = 3000;
let diffThreadGroupsCache = null;
let diffThreadGroupsPending = null;

function invalidateDiffThreadGroupsCache() {
  diffThreadGroupsCache = null;
  // Don't touch diffThreadGroupsPending — an in-flight build reflects the
  // state at the time it started, and callers racing the rebuild would
  // otherwise pile up their own subprocess spawns.
}

async function getDiffThreadGroupsCached(runtime, state, config) {
  const now = Date.now();
  if (
    diffThreadGroupsCache &&
    now - diffThreadGroupsCache.computedAtMs < DIFF_THREAD_GROUPS_CACHE_TTL_MS
  ) {
    return diffThreadGroupsCache.groups;
  }
  if (diffThreadGroupsPending) {
    return diffThreadGroupsPending;
  }
  diffThreadGroupsPending = (async () => {
    try {
      const groups = await buildDiffThreadGroups(runtime, state, config);
      diffThreadGroupsCache = { groups, computedAtMs: Date.now() };
      return groups;
    } finally {
      diffThreadGroupsPending = null;
    }
  })();
  return diffThreadGroupsPending;
}

// Coalesced state persistence. The full state JSON is ~8 MB on disk (dominated
// by `recentCodeEvents` and `recentTimelineEntries` caches); JSON.stringify
// blocks the event loop ~70 ms and fs.writeFile takes another ~80 ms. Before
// this helper, every tiny mutation (push subscribe/unsubscribe/test, locale
// change, claude-away toggle, A2A toggles, …) awaited a ~150 ms
// serialize+write before the HTTP response fired — and the event-loop block
// delayed every concurrent request on the same server too. That's what made
// the settings/notification buttons feel sluggish: the click → visible
// response round-trip paid the cost of re-serializing 5 MB of code-event
// history every time.
//
// `scheduleSaveState` queues a write within SAVE_STATE_DEBOUNCE_MS and returns
// synchronously, so HTTP handlers can respond immediately after mutating
// in-memory state. Multiple mutations within the window coalesce into one
// write. `flushPendingStateWrite` drains on graceful shutdown.
//
// Durability trade-off: at most ~SAVE_STATE_MAX_DELAY_MS of in-memory
// mutations can be lost on a hard crash. Callers that require stronger
// guarantees (pairing, revocation, the periodic scan loop) still `await
// saveState(...)` directly — only the hot settings/notification paths opt in
// to the coalescer.
const SAVE_STATE_DEBOUNCE_MS = 500;
const SAVE_STATE_MAX_DELAY_MS = 1500;
let saveStateTimer = null;
let saveStateFirstScheduleAtMs = 0;
let saveStateInFlight = null;
let saveStateDirty = false;

function scheduleSaveState(config, state) {
  if (!config?.stateFile) return;
  if (saveStateInFlight) {
    // An in-flight write already reflects the current (or earlier) state.
    // Mark dirty so the .finally handler starts another write when it
    // finishes — overlapping writes would just stomp on each other.
    saveStateDirty = true;
    return;
  }
  const now = Date.now();
  if (!saveStateFirstScheduleAtMs) {
    saveStateFirstScheduleAtMs = now;
  }
  if (saveStateTimer) {
    clearTimeout(saveStateTimer);
  }
  const elapsed = now - saveStateFirstScheduleAtMs;
  const remaining = SAVE_STATE_MAX_DELAY_MS - elapsed;
  const delay = Math.max(0, Math.min(SAVE_STATE_DEBOUNCE_MS, remaining));
  saveStateTimer = setTimeout(() => {
    saveStateTimer = null;
    saveStateFirstScheduleAtMs = 0;
    startSaveStateFlush(config, state);
  }, delay);
}

function startSaveStateFlush(config, state) {
  saveStateDirty = false;
  const promise = (async () => {
    try {
      await saveState(config.stateFile, state);
    } catch (error) {
      console.error(`[save-state-error] ${error.message}`);
    }
  })();
  saveStateInFlight = promise;
  promise.finally(() => {
    if (saveStateInFlight === promise) {
      saveStateInFlight = null;
    }
    if (saveStateDirty) {
      // A mutation arrived mid-flight. Start the follow-up write
      // synchronously — we've already held the original debounce window,
      // so tacking on another 500 ms would defeat coalescing. Going
      // through scheduleSaveState() instead would also introduce a timer
      // that flushPendingStateWrite() would have to know about.
      saveStateDirty = false;
      startSaveStateFlush(config, state);
    }
  });
}

async function flushPendingStateWrite(config, state) {
  // Promote any pending debounce timer to an immediate flush.
  if (saveStateTimer) {
    clearTimeout(saveStateTimer);
    saveStateTimer = null;
    saveStateFirstScheduleAtMs = 0;
    startSaveStateFlush(config, state);
  }
  // Drain the in-flight write plus any cascades triggered by saveStateDirty.
  // Bounded so a pathological re-entrancy bug can't hang shutdown.
  for (let iter = 0; iter < 4 && (saveStateInFlight || saveStateDirty); iter += 1) {
    if (saveStateInFlight) {
      await saveStateInFlight.catch(() => {});
    }
    if (saveStateDirty && !saveStateInFlight) {
      saveStateDirty = false;
      startSaveStateFlush(config, state);
    }
  }
}

const cli = parseCliArgs(process.argv.slice(2));
const envFile = resolveEnvFile(cli.envFile);
loadEnvFile(envFile);
loadEnvFile(path.join(os.homedir(), ".viveworker", "a2a.env"));
await maybeRotateStartupPairingEnv(envFile);

const config = buildConfig(cli);
validateConfig(config);
configureHazbaseClient(config);

const runtime = {
  fileStates: new Map(),
  sessionIndex: new Map(),
  knownFiles: [],
  lastSessionIndexLoadAt: 0,
  lastDirectoryScanAt: 0,
  logsDbFile: "",
  historyFileState: {
    offset: 0,
    remainder: "",
    skipPartialLine: false,
    startupCutoffTs: 0,
    sourceFile: "",
  },
  rolloutThreadLabels: new Map(),
  rolloutThreadCwds: new Map(),
  threadStates: new Map(),
  threadOwnerClientIds: new Map(),
  nativeApprovalsByToken: new Map(),
  nativeApprovalsByRequestKey: new Map(),
  claudeApprovalWaiters: new Map(),
  claudeKnownFiles: [],
  lastClaudeScanAt: 0,
  claudeFileStates: new Map(),
  claudeSessionTitles: new Map(),
  lastClaudeSessionTitleScanAt: 0,
  fileApprovalDeltasById: new Map(),
  planRequestsByToken: new Map(),
  planRequestsByRequestKey: new Map(),
  planRequestsByTurnKey: new Map(),
  planQuestionRequestsByRequestKey: new Map(),
  planQuestionRequestsByTurnKey: new Map(),
  userInputRequestsByToken: new Map(),
  userInputRequestsByRequestKey: new Map(),
  completionDetailsByToken: new Map(),
  moltbookItemsByToken: new Map(),
  moltbookDraftsByToken: new Map(),
  a2aTasksByToken: new Map(),
  threadSharesByToken: new Map(),
  threadRegistry: new Map(),
  planDetailsByToken: new Map(),
  recentHistoryItems: [],
  recentTimelineEntries: [],
  recentCodeEvents: [],
  pairingAttemptsByRemoteAddress: new Map(),
  ipcClient: null,
  stopping: false,
  // In-memory cache for the `/api/share/status` endpoint. A 30s TTL avoids
  // hammering the share worker on every settings-page render. Purely runtime —
  // deliberately NOT persisted via `state` since the cache is worthless after
  // a restart and would just bloat the state file.
  a2aShareStatusCache: null,
};
const state = await loadState(config.stateFile);
runtime.threadRegistry = await loadThreadRegistry(config.threadRegistryFile);
await syncClaudeAwayModeSentinel(config, state.claudeAwayMode === true);
const migratedPairedDevicesStateChanged = migratePairedDevicesState({ config, state });
const restoredPendingPlanStateChanged = restorePendingPlanRequests({ config, runtime, state });
const restoredPendingUserInputStateChanged = restorePendingUserInputRequests({ config, runtime, state });

// Detect available A2A executors (codex / claude CLIs).
try {
  const { detectAvailableExecutors } = await import("./a2a-executor.mjs");
  runtime.a2aAvailableExecutors = detectAvailableExecutors();
  console.log(`[a2a-executors] codex=${runtime.a2aAvailableExecutors.codex}, claude=${runtime.a2aAvailableExecutors.claude}`);
} catch (error) {
  runtime.a2aAvailableExecutors = { codex: false, claude: false };
  console.error(`[a2a-executors] Detection failed: ${error.message}`);
}

// Restore persisted moltbook drafts that haven't expired.
try {
  const pendingDrafts = await listPendingDrafts();
  const now = Date.now();
  for (const draft of pendingDrafts) {
    const age = now - (draft.createdAtMs || 0);
    const ttl = draft.ttlMs || 86400000;
    if (age > ttl) {
      await deleteDraft(draft.token).catch(() => {});
      continue;
    }
    runtime.moltbookDraftsByToken.set(draft.token, { ...draft, decisionWaiters: [] });
  }
  if (runtime.moltbookDraftsByToken.size) {
    console.log(`[moltbook-drafts] Restored ${runtime.moltbookDraftsByToken.size} pending draft(s) from disk`);
  }
} catch (error) {
  console.error(`[moltbook-drafts-restore] ${error.message}`);
}

// Periodic TTL sweeper for expired drafts (every 60s).
setInterval(async () => {
  const now = Date.now();
  for (const [token, draft] of runtime.moltbookDraftsByToken) {
    if (draft.decision) continue;
    const age = now - (draft.createdAtMs || 0);
    if (age > (draft.ttlMs || 86400000)) {
      runtime.moltbookDraftsByToken.delete(token);
      await deleteDraft(token).catch(() => {});
      console.log(`[moltbook-draft-expired] ${token} (age=${Math.round(age / 1000)}s)`);
    }
  }
}, 60_000).unref?.();
const initialHistoryItems = normalizeHistoryItems(state.recentHistoryItems ?? [], config.maxHistoryItems);
const initialTimelineEntries = normalizeTimelineEntries(state.recentTimelineEntries ?? [], config.maxTimelineEntries);
const normalizedHistoryStateChanged =
  JSON.stringify(initialHistoryItems) !== JSON.stringify(Array.isArray(state.recentHistoryItems) ? state.recentHistoryItems : []);
const normalizedTimelineStateChanged =
  JSON.stringify(initialTimelineEntries) !== JSON.stringify(Array.isArray(state.recentTimelineEntries) ? state.recentTimelineEntries : []);
runtime.recentHistoryItems = initialHistoryItems;
runtime.recentTimelineEntries = initialTimelineEntries;
state.recentHistoryItems = initialHistoryItems;
state.recentTimelineEntries = initialTimelineEntries;
const backfilledAmbientSuggestionsStateChanged = backfillAmbientSuggestionsState({ config, runtime, state });
const migratedRecentCodeEventsStateChanged = migrateRecentCodeEventsState({ config, runtime, state });
const restoredTimelineImagePathsStateChanged = await backfillPersistedTimelineImagePaths({ config, runtime, state });
const backfilledMoltbookInboxChanged = await backfillMoltbookInboxHistory({ config, runtime, state });
const recoveredMissingProviderStateChanged = await recoverMissingProviderStateFromBackup({ config, runtime, state });
runtime.historyFileState.offset = Number(state.historyFileOffset) || 0;
runtime.historyFileState.sourceFile = cleanText(state.historyFileSourceFile ?? "");

function defaultLocale(config) {
  return normalizeLocale(config?.defaultLocale || "") || DEFAULT_LOCALE;
}

function readPackageVersion() {
  try {
    const packageJsonPath = path.join(workspaceRoot, "package.json");
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return cleanText(parsed?.version ?? "") || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function normalizeSupportedLocale(value, fallback = "") {
  return normalizeLocale(value) || normalizeLocale(fallback) || "";
}

function getDeviceLocaleState(state, deviceId) {
  const normalizedDeviceId = cleanText(deviceId || "");
  if (!normalizedDeviceId || !isPlainObject(state?.deviceLocales)) {
    return null;
  }
  const record = state.deviceLocales[normalizedDeviceId];
  return isPlainObject(record) ? record : null;
}

function resolveDeviceLocaleInfo(config, state, deviceId) {
  const record = getDeviceLocaleState(state, deviceId);
  const resolved = resolveLocalePreference({
    overrideLocale: record?.overrideLocale,
    detectedLocale: record?.detectedLocale,
    defaultLocale: config.defaultLocale,
    fallbackLocale: DEFAULT_LOCALE,
  });
  return {
    locale: resolved.locale,
    source: resolved.source,
    overrideLocale: normalizeSupportedLocale(record?.overrideLocale),
    detectedLocale: normalizeSupportedLocale(record?.detectedLocale),
  };
}

function upsertDetectedDeviceLocale(state, deviceId, detectedLocale) {
  const normalizedDeviceId = cleanText(deviceId || "");
  const normalizedLocale = normalizeSupportedLocale(detectedLocale);
  if (!normalizedDeviceId || !normalizedLocale) {
    return false;
  }
  if (!isPlainObject(state.deviceLocales)) {
    state.deviceLocales = {};
  }
  const previous = isPlainObject(state.deviceLocales[normalizedDeviceId]) ? state.deviceLocales[normalizedDeviceId] : {};
  const next = {
    ...previous,
    detectedLocale: normalizedLocale,
    updatedAtMs: Date.now(),
  };
  state.deviceLocales[normalizedDeviceId] = next;
  return JSON.stringify(previous) !== JSON.stringify(next);
}

function setDeviceLocaleOverride(state, deviceId, overrideLocale) {
  const normalizedDeviceId = cleanText(deviceId || "");
  if (!normalizedDeviceId) {
    return false;
  }
  if (!isPlainObject(state.deviceLocales)) {
    state.deviceLocales = {};
  }
  const previous = isPlainObject(state.deviceLocales[normalizedDeviceId]) ? state.deviceLocales[normalizedDeviceId] : {};
  const next = {
    ...previous,
    overrideLocale: normalizeSupportedLocale(overrideLocale) || "",
    updatedAtMs: Date.now(),
  };
  state.deviceLocales[normalizedDeviceId] = next;
  return JSON.stringify(previous) !== JSON.stringify(next);
}

function clearDeviceLocaleOverride(state, deviceId) {
  const normalizedDeviceId = cleanText(deviceId || "");
  const record = getDeviceLocaleState(state, normalizedDeviceId);
  if (!normalizedDeviceId || !record || !record.overrideLocale) {
    return false;
  }
  const next = {
    ...record,
    overrideLocale: "",
    updatedAtMs: Date.now(),
  };
  state.deviceLocales[normalizedDeviceId] = next;
  return true;
}

function autoPilotWriteLaneState(state) {
  return {
    content: state?.autoPilotWriteLaneContent === true,
    uiTests: state?.autoPilotWriteLaneUiTests === true,
    source: state?.autoPilotWriteLaneSource === true,
  };
}

function hasAnyAutoPilotWriteLaneEnabled(state) {
  const lanes = autoPilotWriteLaneState(state);
  return lanes.content || lanes.uiTests || lanes.source;
}

function buildSessionLocalePayload(config, state, deviceId) {
  const resolved = resolveDeviceLocaleInfo(config, state, deviceId);
  const writeLanes = autoPilotWriteLaneState(state);
  const trustedWritesEnabled = hasAnyAutoPilotWriteLaneEnabled(state);
  return {
    locale: resolved.locale,
    localeSource: resolved.source,
    supportedLocales: [...SUPPORTED_LOCALES],
    defaultLocale: defaultLocale(config),
    deviceDetectedLocale: resolved.detectedLocale || null,
    deviceOverrideLocale: resolved.overrideLocale || null,
    claudeAwayMode: state?.claudeAwayMode === true,
    autoPilotTrustedReads: state?.autoPilotTrustedReads === true,
    autoPilotTrustedWrites: trustedWritesEnabled,
    autoPilotTrustedWritesShadow: false,
    autoPilotWriteLaneContent: writeLanes.content,
    autoPilotWriteLaneUiTests: writeLanes.uiTests,
    autoPilotWriteLaneSource: writeLanes.source,
    moltbookEnabled: Boolean(config.moltbookApiKey),
    a2aEnabled: Boolean(config.a2aApiKey),
    a2aRelayEnabled: Boolean(config.a2aRelayUrl && config.a2aRelayUserId),
    // Share piggy-backs on A2A credentials — it's "enabled" as soon as both
    // halves (user id + API key) are provisioned.
    a2aShareEnabled: Boolean(config.a2aRelayUserId && config.a2aApiKey),
    a2aExecutors: runtime.a2aAvailableExecutors || { codex: false, claude: false },
    a2aExecutorPreference: state.a2aExecutorPreference || "ask",
  };
}

function kindTitle(locale, kind) {
  switch (kind) {
    case "user_message":
      return t(locale, "server.title.userMessage");
    case "assistant_commentary":
      return t(locale, "server.title.assistantCommentary");
    case "assistant_final":
      return t(locale, "server.title.assistantFinal");
    case "ambient_suggestions":
      return t(locale, "server.title.ambientSuggestions");
    case "approval":
      return t(locale, "server.title.approval");
    case "plan":
      return t(locale, "server.title.plan");
    case "plan_ready":
      return t(locale, "server.title.planReady");
    case "choice":
      return t(locale, "server.title.choice");
    case "completion":
      return t(locale, "server.title.complete");
    case "file_event":
      return t(locale, "common.fileEvent");
    case "diff_thread":
      return t(locale, "common.diff");
    case "a2a_task":
      return "A2A";
    case "a2a_task_result":
      return "A2A";
    case "moltbook_reply":
    case "moltbook_draft":
      return "Moltbook";
    case "thread_share":
      return t(locale, "server.title.threadShare") || "Thread Share";
    default:
      return t(locale, "common.item");
  }
}

function normalizeAmbientSuggestion(raw) {
  if (!isPlainObject(raw)) {
    return null;
  }

  const title = cleanText(raw.title ?? "");
  const prompt = normalizeLongText(raw.prompt ?? "");
  if (!title || !prompt) {
    return null;
  }

  const threadAction = isPlainObject(raw.threadAction)
    ? {
        ...(cleanText(raw.threadAction.type ?? "") ? { type: cleanText(raw.threadAction.type) } : {}),
      }
    : null;
  const appIds = Array.isArray(raw.appIds)
    ? raw.appIds.map((value) => cleanText(value ?? "")).filter(Boolean)
    : [];

  return {
    ...(cleanText(raw.id ?? "") ? { id: cleanText(raw.id) } : {}),
    title,
    prompt,
    ...(cleanText(raw.description ?? "") ? { description: cleanText(raw.description) } : {}),
    ...(threadAction && threadAction.type ? { threadAction } : {}),
    ...(appIds.length > 0 ? { appIds } : {}),
  };
}

function normalizeAmbientSuggestions(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((entry) => normalizeAmbientSuggestion(entry)).filter(Boolean);
}

function parseAmbientSuggestionsEnvelope(value) {
  const normalized = cleanText(value ?? "");
  if (!normalized) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(normalized);
  } catch {
    return null;
  }

  if (!isPlainObject(payload)) {
    return null;
  }

  const hasSuggestionsField = Array.isArray(payload.suggestions);
  const hasExcludeField = Array.isArray(payload.exclude);
  if (!hasSuggestionsField && !hasExcludeField) {
    return null;
  }

  const suggestions = hasSuggestionsField ? normalizeAmbientSuggestions(payload.suggestions) : [];
  if (suggestions.length > 0) {
    return { type: "suggestions", suggestions };
  }

  return {
    type: "metadata",
    hasSuggestionsField,
    hasExcludeField,
  };
}

function parseAmbientSuggestionsPayload(value) {
  const envelope = parseAmbientSuggestionsEnvelope(value);
  return envelope?.type === "suggestions" ? envelope.suggestions : null;
}

function isAmbientSuggestionsMetadataPayload(value) {
  return parseAmbientSuggestionsEnvelope(value) !== null;
}

function ambientSuggestionsSummary(locale, suggestions) {
  const count = Math.max(0, Array.isArray(suggestions) ? suggestions.length : 0);
  if (count <= 0) {
    return "";
  }
  const firstTitle = cleanText(suggestions[0]?.title || "");
  return t(locale, "summary.ambientSuggestions", {
    count,
    firstTitle,
    more: Math.max(0, count - 1),
  });
}

function ambientSuggestionsMessageText(locale, suggestions) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return "";
  }
  return [
    kindTitle(locale, "ambient_suggestions"),
    "",
    ...suggestions.flatMap((suggestion, index) => {
      const description = cleanText(suggestion.description || "");
      return [
        `${index + 1}. ${cleanText(suggestion.title || "")}`,
        ...(description ? [description] : []),
      ];
    }),
  ].join("\n");
}

function looksLikeGeneratedThreadTitle(value) {
  const normalized = cleanText(value || "");
  if (!normalized.includes("|")) {
    return false;
  }
  const prefix = cleanText(normalized.split("|", 1)[0] || "");
  if (!prefix) {
    return false;
  }
  const titleKeys = [
    "server.title.userMessage",
    "server.title.assistantCommentary",
    "server.title.assistantFinal",
    "server.title.approval",
    "server.title.plan",
    "server.title.planReady",
    "server.title.choice",
    "server.title.choiceReadOnly",
    "server.title.complete",
  ];
  return SUPPORTED_LOCALES.some((locale) => titleKeys.some((key) => t(locale, key) === prefix));
}

function formatLocalizedTitle(locale, baseKeyOrTitle, threadLabel) {
  const baseTitle = baseKeyOrTitle.includes(".") ? t(locale, baseKeyOrTitle) : baseKeyOrTitle;
  return formatTitle(baseTitle, threadLabel);
}

function notificationIconPrefix(kind) {
  switch (kind) {
    case "approval":
      return "✋";
    case "plan":
      return "🧭";
    case "choice":
      return "☑️";
    case "completion":
      return "✅";
    case "a2a_task":
    case "a2a_task_result":
      return "🤝";
    default:
      return "";
  }
}

function withNotificationIcon(kind, title) {
  const prefix = notificationIconPrefix(kind);
  return prefix ? `${prefix} ${title}` : title;
}

function normalizeTimelineOutcome(value) {
  const normalized = cleanText(value || "").toLowerCase();
  return ["pending", "approved", "rejected", "implemented", "dismissed", "submitted"].includes(normalized)
    ? normalized
    : "";
}

function normalizeTimelineFileEventType(value) {
  const normalized = cleanText(value || "").toLowerCase();
  return ["read", "write", "create", "delete", "rename"].includes(normalized) ? normalized : "";
}

function fileEventTitle(locale, fileEventType) {
  switch (normalizeTimelineFileEventType(fileEventType)) {
    case "read":
      return t(locale, "fileEvent.read");
    case "write":
      return t(locale, "fileEvent.write");
    case "create":
      return t(locale, "fileEvent.create");
    case "delete":
      return t(locale, "fileEvent.delete");
    case "rename":
      return t(locale, "fileEvent.rename");
    default:
      return t(locale, "common.fileEvent");
  }
}

function fileEventDetailCopy(locale, fileEventType, provider) {
  const vars = { provider: providerDisplayName(locale, provider) };
  switch (normalizeTimelineFileEventType(fileEventType)) {
    case "read":
      return t(locale, "detail.fileEvent.read", vars);
    case "write":
      return t(locale, "detail.fileEvent.write", vars);
    case "create":
      return t(locale, "detail.fileEvent.create", vars);
    case "delete":
      return t(locale, "detail.fileEvent.delete", vars);
    case "rename":
      return t(locale, "detail.fileEvent.rename", vars);
    default:
      return t(locale, "detail.detailUnavailable");
  }
}

function diffThreadDetailCopy(locale, sourceMode, count) {
  switch (cleanText(sourceMode || "")) {
    case "git_current":
      return t(locale, "detail.diffThread.copy.current", { count });
    case "non_git_latest":
      return t(locale, "detail.diffThread.copy.latest", { count });
    default:
      return t(locale, "detail.diffThread.copy", { count });
  }
}

function inferTimelineOutcome(kind, summary = "", messageText = "") {
  const normalizedKind = cleanText(kind || "");
  if (!normalizedKind) {
    return "";
  }

  const candidates = [cleanText(summary || ""), cleanText(messageText || "")].filter(Boolean);
  if (candidates.length === 0) {
    return "";
  }

  const startsWithAny = (keys) =>
    candidates.some((text) => SUPPORTED_LOCALES.some((locale) => keys.some((key) => text.startsWith(t(locale, key)))));

  if (normalizedKind === "approval") {
    if (startsWithAny(["server.message.approvalAccepted"])) {
      return "approved";
    }
    if (startsWithAny(["server.message.approvalRejected"])) {
      return "rejected";
    }
    return "";
  }

  if (normalizedKind === "plan") {
    if (startsWithAny(["server.message.planImplemented"])) {
      return "implemented";
    }
    if (startsWithAny(["server.message.planDismissed"])) {
      return "dismissed";
    }
    return "";
  }

  if (normalizedKind === "choice") {
    if (
      startsWithAny([
        "server.message.choiceSubmitted",
        "server.message.choiceSubmittedTest",
        "server.message.choiceSummarySubmitted",
        "server.message.choiceSummaryReceivedTest",
      ])
    ) {
      return "submitted";
    }
    return "";
  }

  return "";
}

function normalizeTimelineFileRefs(rawFileRefs) {
  if (!Array.isArray(rawFileRefs)) {
    return [];
  }

  const deduped = [];
  const seen = new Set();
  for (const rawRef of rawFileRefs) {
    const normalized = cleanTimelineFileRef(rawRef);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= 8) {
      break;
    }
  }
  return deduped;
}

function cleanTimelineFileRef(value) {
  let normalized = cleanText(value || "");
  if (!normalized) {
    return "";
  }

  normalized = normalized
    .replace(/^[`"'([{<]+/u, "")
    .replace(/[)`"'\]}>.,:;!?]+$/u, "")
    .replace(/[#:]L?\d+(?::\d+)?$/u, "");

  if (!normalized || /^https?:\/\//iu.test(normalized)) {
    return "";
  }

  if (normalized.startsWith("/")) {
    const segments = normalized.split("/").filter(Boolean);
    if (segments.length >= 2 && looksLikeFileRefBasename(segments[segments.length - 1])) {
      return normalized;
    }
    return "";
  }

  if (normalized.includes("/")) {
    const segments = normalized.split("/").filter(Boolean);
    if (
      segments.length >= 2 &&
      segments.every((segment) => /^[A-Za-z0-9._-]+$/u.test(segment)) &&
      looksLikeFileRefBasename(segments[segments.length - 1])
    ) {
      return normalized;
    }
    return "";
  }

  return looksLikeFileRefBasename(normalized) ? normalized : "";
}

function looksLikeFileRefBasename(value) {
  const normalized = cleanText(value || "");
  if (!normalized || /[\s\\]/u.test(normalized)) {
    return false;
  }
  if (
    [
      ".env",
      ".env.example",
      ".gitignore",
      "Dockerfile",
      "LICENSE",
      "Makefile",
      "README.md",
      "package-lock.json",
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.json",
      "vite.config.ts",
    ].includes(normalized)
  ) {
    return true;
  }
  return /^(?:\.[A-Za-z0-9_-]+(?:\.[A-Za-z][A-Za-z0-9_-]{0,9})?|[A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9_-]{0,9})$/u.test(
    normalized
  );
}

function extractTimelineFileRefs(messageText = "") {
  const sourceText = String(messageText || "");
  if (!sourceText) {
    return [];
  }

  const refs = [];
  const pushCandidate = (candidate) => {
    const normalized = cleanTimelineFileRef(candidate);
    if (normalized) {
      refs.push(normalized);
    }
  };
  const collectCandidates = (text) => {
    for (const candidate of String(text || "").split(/\s+/u)) {
      pushCandidate(candidate);
    }
  };

  for (const match of sourceText.matchAll(/\[[^\]]+\]\((\/[^)\s]+)\)/gu)) {
    pushCandidate(match[1]);
  }

  for (const match of sourceText.matchAll(/`([^`\n]+)`/gu)) {
    collectCandidates(match[1]);
  }

  collectCandidates(
    sourceText
      .replace(/`[^`\n]+`/gu, " ")
      .replace(/\[[^\]]+\]\(([^)]+)\)/gu, " ")
  );

  return normalizeTimelineFileRefs(refs);
}

function tokenizeShellWords(commandText) {
  const source = String(commandText || "");
  if (!source) {
    return [];
  }

  const tokens = [];
  let current = "";
  let quote = "";
  let escaping = false;

  for (const character of source) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = "";
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/u.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function isPathWithinRoot(rootPath, candidatePath) {
  const normalizedRoot = cleanText(rootPath || "");
  const normalizedCandidate = cleanText(candidatePath || "");
  if (!normalizedRoot || !normalizedCandidate) {
    return false;
  }
  const relativePath = path.relative(normalizedRoot, normalizedCandidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isSensitiveCommandPath(candidatePath) {
  const normalized = cleanText(candidatePath || "");
  if (!normalized) {
    return true;
  }
  const lower = normalized.toLowerCase();
  const segments = lower.split(/[\\/]+/u).filter(Boolean);
  const basename = segments[segments.length - 1] || "";
  if (segments.some((segment) => [".ssh", ".aws", ".gnupg", ".azure", ".kube"].includes(segment))) {
    return true;
  }
  if (basename === ".npmrc" || basename === ".netrc" || basename === ".env" || basename.startsWith(".env.")) {
    return true;
  }
  if (basename.endsWith(".pem") || basename.endsWith(".key") || basename.endsWith(".p12") || basename.endsWith(".pfx")) {
    return true;
  }
  if (/^id_[a-z0-9._-]+$/iu.test(basename) || basename.includes("secret") || basename.includes("credential")) {
    return true;
  }
  return false;
}

function resolveTrustedReadTargetPath({ token, cwd, workspaceRoot }) {
  const rawToken = cleanText(token || "");
  const normalizedCwd = cleanText(cwd || "");
  const normalizedWorkspaceRoot = cleanText(workspaceRoot || normalizedCwd);
  if (!rawToken || !normalizedCwd || !normalizedWorkspaceRoot) {
    return null;
  }
  if (rawToken === "-" || rawToken.startsWith("~") || rawToken.startsWith("http://") || rawToken.startsWith("https://")) {
    return null;
  }
  const resolved = path.resolve(normalizedCwd, rawToken);
  if (!isPathWithinRoot(normalizedWorkspaceRoot, resolved)) {
    return null;
  }
  if (isSensitiveCommandPath(resolved)) {
    return null;
  }
  return resolved;
}

function isGitObjectPathToken(token) {
  const normalized = cleanText(token || "");
  if (!normalized || normalized.startsWith("-")) {
    return false;
  }
  return /^[^:\s][^:\s]*:.+/u.test(normalized);
}

function isLiteralGitPathspecToken(token) {
  const normalized = cleanText(token || "");
  if (!normalized || normalized === "--" || normalized.startsWith(":(") || normalized.startsWith(":/")) {
    return false;
  }
  if (/[*?[\]{}]/u.test(normalized)) {
    return false;
  }
  return !isGitObjectPathToken(normalized);
}

function isAllowedGitMetadataOnlyFlag(token) {
  const normalized = cleanText(token || "");
  if (!normalized) {
    return false;
  }
  return [
    "--stat",
    "--shortstat",
    "--numstat",
    "--name-only",
    "--name-status",
    "--summary",
    "--compact-summary",
    "--oneline",
    "--no-patch",
    "-s",
  ].includes(normalized);
}

function hasDisallowedGitPatchOutput(tokens) {
  return tokens.some((token) => {
    const normalized = cleanText(token || "");
    if (!normalized) {
      return false;
    }
    return (
      normalized === "-p" ||
      normalized === "--patch" ||
      normalized === "--patch-with-stat" ||
      normalized === "--raw" ||
      normalized === "--cc" ||
      normalized === "--combined-all-paths" ||
      normalized === "--binary" ||
      normalized === "--word-diff" ||
      normalized.startsWith("--word-diff=") ||
      normalized === "-U" ||
      normalized.startsWith("-U") ||
      normalized === "--unified" ||
      normalized.startsWith("--unified=")
    );
  });
}

function extractGitPathspecTokens(tokens) {
  const separatorIndex = tokens.indexOf("--");
  if (separatorIndex < 0) {
    return [];
  }
  return tokens.slice(separatorIndex + 1).filter(Boolean);
}

function resolveTrustedDiffSectionPath({ token, cwd, workspaceRoot }) {
  const normalizedToken = cleanText(token || "");
  if (!normalizedToken) {
    return null;
  }
  const preferredWorkspace = resolveTrustedReadTargetPath({
    token: normalizedToken,
    cwd: workspaceRoot,
    workspaceRoot,
  });
  if (preferredWorkspace) {
    return preferredWorkspace;
  }
  return resolveTrustedReadTargetPath({
    token: normalizedToken,
    cwd,
    workspaceRoot,
  });
}

function extractTrustedReadFileRefs(command, tokens, cwd, workspaceRoot) {
  const normalizedCommand = cleanText(command || "");
  if (!normalizedCommand) {
    return null;
  }

  if (normalizedCommand === "pwd" || (normalizedCommand === "git" && cleanText(tokens[1] || "") === "status")) {
    const resolved = resolveTrustedReadTargetPath({ token: ".", cwd, workspaceRoot });
    return resolved ? normalizeTimelineFileRefs([resolved]) : null;
  }

  if (normalizedCommand === "git") {
    const gitSubcommand = cleanText(tokens[1] || "");
    if (!["diff", "show"].includes(gitSubcommand)) {
      return null;
    }
    if (tokens.some((token) => token === "-C" || token.startsWith("-C") || token === "--output" || token.startsWith("--output="))) {
      return null;
    }
    const commandArgs = tokens.slice(2);
    if (commandArgs.some((token) => isGitObjectPathToken(token))) {
      return null;
    }
    const explicitPathspecs = extractGitPathspecTokens(tokens);
    if (explicitPathspecs.length > 0) {
      if (explicitPathspecs.some((token) => !isLiteralGitPathspecToken(token))) {
        return null;
      }
      const resolvedPaths = explicitPathspecs
        .map((token) => resolveTrustedReadTargetPath({ token, cwd, workspaceRoot }))
        .filter(Boolean);
      return resolvedPaths.length === explicitPathspecs.length ? normalizeTimelineFileRefs(resolvedPaths) : null;
    }
    if (hasDisallowedGitPatchOutput(commandArgs)) {
      return null;
    }
    const metadataOnly = commandArgs.some((token) => isAllowedGitMetadataOnlyFlag(token));
    if (!metadataOnly) {
      return null;
    }
    const resolved = resolveTrustedReadTargetPath({ token: ".", cwd, workspaceRoot });
    return resolved ? normalizeTimelineFileRefs([resolved]) : null;
  }

  if (normalizedCommand === "ls") {
    const pathArgs = tokens.slice(1).filter((token) => !String(token || "").startsWith("-"));
    if (pathArgs.length === 0) {
      const resolved = resolveTrustedReadTargetPath({ token: ".", cwd, workspaceRoot });
      return resolved ? normalizeTimelineFileRefs([resolved]) : null;
    }
    const resolvedPaths = pathArgs
      .map((token) => resolveTrustedReadTargetPath({ token, cwd, workspaceRoot }))
      .filter(Boolean);
    return resolvedPaths.length === pathArgs.length ? normalizeTimelineFileRefs(resolvedPaths) : null;
  }

  if (normalizedCommand === "find") {
    if (tokens.some((token) => ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf", "-fls"].includes(token))) {
      return null;
    }
    const pathArgs = [];
    for (const token of tokens.slice(1)) {
      if (!token || token === "--") continue;
      if (token === "!" || token === "(" || token === ")") break;
      if (token.startsWith("-")) break;
      pathArgs.push(token);
    }
    const effectivePaths = pathArgs.length ? pathArgs : ["."];
    const resolvedPaths = effectivePaths
      .map((token) => resolveTrustedReadTargetPath({ token, cwd, workspaceRoot }))
      .filter(Boolean);
    return resolvedPaths.length === effectivePaths.length ? normalizeTimelineFileRefs(resolvedPaths) : null;
  }

  if (normalizedCommand === "sed") {
    if (!tokens.includes("-n") || tokens.includes("-i") || tokens.includes("--in-place")) {
      return null;
    }
    let script = "";
    const fileArgs = [];
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token) continue;
      if (!script) {
        if (token === "-e") {
          script = tokens[index + 1] || "";
          index += 1;
          continue;
        }
        if (token.startsWith("-")) {
          continue;
        }
        script = token;
        continue;
      }
      if (!token.startsWith("-")) {
        fileArgs.push(token);
      }
    }
    if (!script || !/^[0-9,$; p-]+$/u.test(script) || fileArgs.length === 0) {
      return null;
    }
    const resolvedPaths = fileArgs
      .map((token) => resolveTrustedReadTargetPath({ token, cwd, workspaceRoot }))
      .filter(Boolean);
    return resolvedPaths.length === fileArgs.length ? normalizeTimelineFileRefs(resolvedPaths) : null;
  }

  if (normalizedCommand === "rg") {
    let seenPattern = false;
    const fileArgs = [];
    for (const token of tokens.slice(1)) {
      if (!seenPattern) {
        if (token === "--") {
          seenPattern = true;
          continue;
        }
        if (String(token || "").startsWith("-")) {
          continue;
        }
        seenPattern = true;
        continue;
      }
      if (!String(token || "").startsWith("-")) {
        fileArgs.push(token);
      }
    }
    const effectivePaths = fileArgs.length ? fileArgs : ["."];
    const resolvedPaths = effectivePaths
      .map((token) => resolveTrustedReadTargetPath({ token, cwd, workspaceRoot }))
      .filter(Boolean);
    return resolvedPaths.length === effectivePaths.length ? normalizeTimelineFileRefs(resolvedPaths) : null;
  }

  if (["cat", "nl", "head", "tail", "wc"].includes(normalizedCommand)) {
    const fileArgs = tokens.slice(1).filter((token) => !String(token || "").startsWith("-"));
    if (fileArgs.length === 0) {
      return null;
    }
    const resolvedPaths = fileArgs
      .map((token) => resolveTrustedReadTargetPath({ token, cwd, workspaceRoot }))
      .filter(Boolean);
    return resolvedPaths.length === fileArgs.length ? normalizeTimelineFileRefs(resolvedPaths) : null;
  }

  return null;
}

function stripAllowedTrustedReadRedirections(tokens) {
  const filtered = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index] || "");
    if (!token) {
      continue;
    }
    if (token === "2>" || token === "2>>") {
      const target = String(tokens[index + 1] || "");
      if (target !== "/dev/null") {
        return null;
      }
      index += 1;
      continue;
    }
    if (/^2>>?\/dev\/null$/u.test(token)) {
      continue;
    }
    if (token.includes(">") || token.includes("<")) {
      return null;
    }
    filtered.push(token);
  }
  return filtered;
}

function isAllowedTrustedReadPostProcessStage(stageTokens) {
  if (!Array.isArray(stageTokens) || stageTokens.length === 0) {
    return false;
  }
  const [command, ...args] = stageTokens.map((token) => cleanText(token || ""));
  if (!command) {
    return false;
  }
  if (command === "head" || command === "tail") {
    if (args.length === 0) {
      return true;
    }
    if (args.length === 1 && /^-\d+$/u.test(args[0])) {
      return true;
    }
    if (args.length === 2 && args[0] === "-n" && /^\d+$/u.test(args[1])) {
      return true;
    }
    return false;
  }
  if (command === "wc") {
    return args.length === 0 || (args.length === 1 && args[0] === "-l");
  }
  return false;
}

function normalizeTrustedReadTokens(tokens) {
  const strippedTokens = stripAllowedTrustedReadRedirections(tokens);
  if (!strippedTokens || strippedTokens.length === 0) {
    return null;
  }
  if (strippedTokens.some((token) => {
    const value = String(token || "");
    return (
      ["||", "&&", ";", "&"].includes(value) ||
      value.includes("`") ||
      value.includes("$(")
    );
  })) {
    return null;
  }
  const stages = [];
  let currentStage = [];
  for (const token of strippedTokens) {
    if (token === "|") {
      if (currentStage.length === 0) {
        return null;
      }
      stages.push(currentStage);
      currentStage = [];
      continue;
    }
    currentStage.push(token);
  }
  if (currentStage.length === 0) {
    return null;
  }
  stages.push(currentStage);
  if (stages.length === 0) {
    return null;
  }
  if (stages.slice(1).some((stageTokens) => !isAllowedTrustedReadPostProcessStage(stageTokens))) {
    return null;
  }
  return stages[0];
}

function evaluateTrustedReadCommandPolicy({ commandText, cwd, workspaceRoot }) {
  const normalizedCwd = cleanText(cwd || "");
  const normalizedWorkspaceRoot = cleanText(workspaceRoot || normalizedCwd);
  const normalizedCommandText = unwrapShellCommand(commandText);
  const rawTokens = tokenizeShellWords(normalizedCommandText);
  if (!normalizedCommandText || !normalizedCwd || !normalizedWorkspaceRoot || rawTokens.length === 0) {
    return null;
  }

  if (!isPathWithinRoot(normalizedWorkspaceRoot, path.resolve(normalizedCwd))) {
    return null;
  }

  const tokens = normalizeTrustedReadTokens(rawTokens);
  if (!tokens || tokens.length === 0) {
    return null;
  }

  const command = cleanText(tokens[0]);
  if (!command || /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(command)) {
    return null;
  }

  const fileRefs = extractTrustedReadFileRefs(command, tokens, normalizedCwd, normalizedWorkspaceRoot);
  if (!fileRefs) {
    return null;
  }

  return {
    command,
    commandText: normalizedCommandText,
    fileRefs,
  };
}

function unwrapShellCommand(commandText) {
  const normalized = String(commandText || "").trim();
  if (!normalized) {
    return "";
  }

  const shellMatch = normalized.match(/^\/bin\/(?:zsh|bash|sh)\s+-lc\s+(['"])([\s\S]*)\1$/u);
  if (!shellMatch) {
    return normalized;
  }

  return shellMatch[2]
    .replace(/\\(["'\\])/gu, "$1")
    .trim();
}

function extractCommandLineFromFunctionOutput(outputText) {
  const match = String(outputText || "").match(/^Command:\s+(.+)$/mu);
  return unwrapShellCommand(match?.[1] || "");
}

function extractReadFileRefsFromCommand(commandText) {
  const normalizedCommand = unwrapShellCommand(commandText);
  const tokens = tokenizeShellWords(normalizedCommand);
  if (tokens.length === 0) {
    return [];
  }

  const command = cleanText(tokens[0]);
  if (!command || ["ls", "find"].includes(command)) {
    return [];
  }
  if (command === "git" && cleanText(tokens[1] || "") === "status") {
    return [];
  }
  if (command === "rg" && tokens.includes("--files")) {
    return [];
  }

  if (command === "cat" || command === "nl") {
    return normalizeTimelineFileRefs(tokens.slice(1).filter((token) => !String(token || "").startsWith("-")));
  }

  if (command === "sed") {
    if (!tokens.includes("-n")) {
      return [];
    }
    return normalizeTimelineFileRefs(tokens.slice(1).filter((token) => !String(token || "").startsWith("-")));
  }

  if (command === "rg") {
    if (!tokens.includes("-n")) {
      return [];
    }

    let seenPattern = false;
    const fileArgs = [];
    for (const token of tokens.slice(1)) {
      if (!seenPattern) {
        if (token === "--") {
          seenPattern = true;
          continue;
        }
        if (String(token || "").startsWith("-")) {
          continue;
        }
        seenPattern = true;
        continue;
      }
      fileArgs.push(token);
    }

    return normalizeTimelineFileRefs(fileArgs);
  }

  return [];
}

function autoPilotApprovalMessage(locale, commandText) {
  const prefix = t(locale, "server.message.autoPilotTrustedReadApproved");
  const commandBlock = cleanText(commandText || "")
    ? `${t(locale, "server.message.commandLabel")}\n\`\`\`sh\n${cleanText(commandText || "")}\n\`\`\``
    : "";
  return [prefix, commandBlock].filter(Boolean).join("\n\n");
}

function extractUpdatedFileRefsByType(outputText, patchText = "") {
  const parsedSections = parseApplyPatchSections(patchText);
  if (parsedSections.length > 0) {
    const createRefs = [];
    const writeRefs = [];
    const deleteRefs = [];
    const renameRefs = [];
    for (const section of parsedSections) {
      const newFileRef = cleanTimelineFileRef(section?.newFileRef || section?.fileRef || "");
      const oldFileRef = cleanTimelineFileRef(section?.oldFileRef || "");
      switch (section?.kind) {
        case "create":
          if (newFileRef) {
            createRefs.push(newFileRef);
          }
          break;
        case "write":
          if (newFileRef) {
            writeRefs.push(newFileRef);
          }
          break;
        case "delete":
          if (oldFileRef || newFileRef) {
            deleteRefs.push(oldFileRef || newFileRef);
          }
          break;
        case "rename":
          if (oldFileRef && newFileRef) {
            renameRefs.push({
              oldFileRef,
              newFileRef,
            });
          }
          break;
        default:
          break;
      }
    }
    return {
      create: normalizeTimelineFileRefs(createRefs),
      write: normalizeTimelineFileRefs(writeRefs),
      delete: normalizeTimelineFileRefs(deleteRefs),
      rename: renameRefs.filter(
        (entry, index, array) =>
          array.findIndex(
            (candidate) =>
              timelineFileRefsMatch(candidate.oldFileRef, entry.oldFileRef) &&
              timelineFileRefsMatch(candidate.newFileRef, entry.newFileRef)
          ) === index
      ),
    };
  }

  const parsed = safeJsonParse(outputText);
  const sourceText = typeof parsed?.output === "string" ? parsed.output : String(outputText || "");
  if (!/^Success\. Updated the following files:/mu.test(sourceText)) {
    return { create: [], write: [], delete: [], rename: [] };
  }

  const createRefs = [];
  const writeRefs = [];
  const deleteRefs = [];
  const renameRefs = [];
  for (const line of sourceText.split("\n")) {
    const renameMatch =
      line.match(/^R\d*\s+(.+?)\s+->\s+(.+)$/u) ||
      line.match(/^R\d*\s+(.+?)\t(.+)$/u);
    if (renameMatch) {
      const oldFileRef = cleanTimelineFileRef(renameMatch[1]);
      const newFileRef = cleanTimelineFileRef(renameMatch[2]);
      if (oldFileRef && newFileRef) {
        renameRefs.push({ oldFileRef, newFileRef });
      }
      continue;
    }

    const match = line.match(/^([AMD])\s+(.+)$/u);
    if (!match) {
      continue;
    }
    const fileRef = cleanTimelineFileRef(match[2]);
    if (!fileRef) {
      continue;
    }
    if (match[1] === "A") {
      createRefs.push(fileRef);
    } else if (match[1] === "M") {
      writeRefs.push(fileRef);
    } else if (match[1] === "D") {
      deleteRefs.push(fileRef);
    }
  }

  return {
    create: normalizeTimelineFileRefs(createRefs),
    write: normalizeTimelineFileRefs(writeRefs),
    delete: normalizeTimelineFileRefs(deleteRefs),
    rename: renameRefs.filter(
      (entry, index, array) =>
        array.findIndex(
          (candidate) =>
            timelineFileRefsMatch(candidate.oldFileRef, entry.oldFileRef) &&
            timelineFileRefsMatch(candidate.newFileRef, entry.newFileRef)
        ) === index
    ),
  };
}

function normalizeTimelineDiffSource(value) {
  const normalized = cleanText(value || "");
  return normalized === "apply_patch" || normalized === "git" || normalized === "approval_request" ? normalized : "";
}

function normalizeTimelineDiffText(value) {
  return String(value || "")
    .replace(/\r\n/gu, "\n")
    .trim();
}

function diffLineCounts(diffText) {
  let addedLines = 0;
  let removedLines = 0;
  for (const line of String(diffText || "").split("\n")) {
    if (!line || line.startsWith("+++ ") || line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+")) {
      addedLines += 1;
      continue;
    }
    if (line.startsWith("-")) {
      removedLines += 1;
    }
  }
  return { addedLines, removedLines };
}

function rememberApplyPatchInput(fileState, payload, createdAtMs = Date.now()) {
  const callId = cleanText(payload?.call_id ?? payload?.callId ?? "");
  if (!callId || cleanText(payload?.name ?? "") !== "apply_patch") {
    return;
  }
  const inputText = normalizeTimelineDiffText(payload?.input ?? "");
  if (!inputText) {
    return;
  }
  if (!(fileState.applyPatchInputsByCallId instanceof Map)) {
    fileState.applyPatchInputsByCallId = new Map();
  }
  fileState.applyPatchInputsByCallId.set(callId, {
    inputText,
    cwd: cleanText(fileState.cwd || ""),
    createdAtMs: Number(createdAtMs) || Date.now(),
  });
  while (fileState.applyPatchInputsByCallId.size > 64) {
    const oldestKey = fileState.applyPatchInputsByCallId.keys().next().value;
    if (!oldestKey) {
      break;
    }
    fileState.applyPatchInputsByCallId.delete(oldestKey);
  }
}

async function findStoredApplyPatchInput({ fileState, callId, rolloutFilePath }) {
  const normalizedCallId = cleanText(callId || "");
  if (!normalizedCallId) {
    return null;
  }

  const inMemory =
    fileState?.applyPatchInputsByCallId instanceof Map
      ? fileState.applyPatchInputsByCallId.get(normalizedCallId)
      : null;
  if (inMemory?.inputText) {
    return inMemory;
  }

  const normalizedRolloutFilePath = cleanText(rolloutFilePath || "");
  if (!normalizedRolloutFilePath) {
    return null;
  }

  let content = "";
  try {
    content = await fs.readFile(normalizedRolloutFilePath, "utf8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const rawLine = lines[index];
    if (!rawLine.trim()) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (cleanText(record?.type || "") !== "response_item") {
      continue;
    }
    const payload = isPlainObject(record?.payload) ? record.payload : null;
    if (!payload) {
      continue;
    }
    if (
      cleanText(payload?.type || "") !== "custom_tool_call" ||
      cleanText(payload?.call_id ?? payload?.callId ?? "") !== normalizedCallId ||
      cleanText(payload?.name || "") !== "apply_patch"
    ) {
      continue;
    }

    const inputText = normalizeTimelineDiffText(payload?.input ?? "");
    if (!inputText) {
      return null;
    }

    const restored = {
      inputText,
      cwd: cleanText(fileState?.cwd || ""),
      createdAtMs: Date.parse(record?.timestamp ?? "") || Date.now(),
    };
    if (!(fileState?.applyPatchInputsByCallId instanceof Map)) {
      fileState.applyPatchInputsByCallId = new Map();
    }
    fileState.applyPatchInputsByCallId.set(normalizedCallId, restored);
    return restored;
  }

  return null;
}

function diffPathForSide(fileRef, side) {
  const normalizedFileRef = cleanText(fileRef || "");
  if (!normalizedFileRef) {
    return side === "a" ? "a/unknown" : "b/unknown";
  }
  if (normalizedFileRef === "/dev/null") {
    return normalizedFileRef;
  }
  if (normalizedFileRef.startsWith("/")) {
    return `${side}${normalizedFileRef}`;
  }
  return `${side}/${normalizedFileRef}`;
}

function parseApplyPatchSections(patchText) {
  const sections = [];
  const lines = String(patchText || "").replace(/\r\n/gu, "\n").split("\n");
  let current = null;

  function pushCurrent() {
    if (!current?.fileRef) {
      current = null;
      return;
    }
    sections.push({
      kind: current.kind,
      fileRef: current.fileRef,
      oldFileRef: current.oldFileRef || "",
      newFileRef: current.newFileRef || current.fileRef,
      bodyLines: [...current.bodyLines],
    });
    current = null;
  }

  for (const line of lines) {
    const addMatch = line.match(/^\*\*\* Add File:\s+(.+)$/u);
    if (addMatch) {
      pushCurrent();
      current = {
        kind: "create",
        fileRef: cleanTimelineFileRef(addMatch[1]),
        oldFileRef: "",
        newFileRef: cleanTimelineFileRef(addMatch[1]),
        bodyLines: [],
      };
      continue;
    }

    const updateMatch = line.match(/^\*\*\* Update File:\s+(.+)$/u);
    if (updateMatch) {
      pushCurrent();
      current = {
        kind: "write",
        fileRef: cleanTimelineFileRef(updateMatch[1]),
        oldFileRef: cleanTimelineFileRef(updateMatch[1]),
        newFileRef: cleanTimelineFileRef(updateMatch[1]),
        bodyLines: [],
      };
      continue;
    }

    const deleteMatch = line.match(/^\*\*\* Delete File:\s+(.+)$/u);
    if (deleteMatch) {
      pushCurrent();
      current = {
        kind: "delete",
        fileRef: cleanTimelineFileRef(deleteMatch[1]),
        oldFileRef: cleanTimelineFileRef(deleteMatch[1]),
        newFileRef: "",
        bodyLines: [],
      };
      continue;
    }

    if (!current) {
      continue;
    }

    const moveMatch = line.match(/^\*\*\* Move to:\s+(.+)$/u);
    if (moveMatch) {
      const movedFileRef = cleanTimelineFileRef(moveMatch[1]);
      if (movedFileRef) {
        current.kind = current.kind === "write" ? "rename" : current.kind;
        current.oldFileRef = current.oldFileRef || current.fileRef;
        current.newFileRef = movedFileRef;
        current.fileRef = movedFileRef;
      }
      continue;
    }

    if (line === "*** End Patch") {
      pushCurrent();
      break;
    }

    if (line === "*** End of File") {
      continue;
    }

    current.bodyLines.push(line);
  }

  pushCurrent();
  return sections;
}

function buildUnifiedDiffFromApplyPatchSection(section) {
  if (!section?.fileRef && !section?.oldFileRef) {
    return "";
  }

  const bodyLines = Array.isArray(section.bodyLines) ? section.bodyLines : [];
  const fileRef = cleanTimelineFileRef(section.fileRef || section.newFileRef || "");
  const oldFileRef = cleanTimelineFileRef(section.oldFileRef || fileRef);
  const newFileRef = cleanTimelineFileRef(section.newFileRef || fileRef);
  const diffLines = [`diff --git ${diffPathForSide(oldFileRef || fileRef, "a")} ${diffPathForSide(newFileRef || fileRef, "b")}`];

  if (section.kind === "create") {
    const addedCount = bodyLines.filter((line) => line.startsWith("+")).length;
    diffLines.push("new file mode 100644");
    diffLines.push("--- /dev/null");
    diffLines.push(`+++ ${diffPathForSide(newFileRef || fileRef, "b")}`);
    diffLines.push(`@@ -0,0 +1,${Math.max(addedCount, 1)} @@`);
    diffLines.push(...bodyLines);
    return normalizeTimelineDiffText(diffLines.join("\n"));
  }

  if (section.kind === "write") {
    diffLines.push(`--- ${diffPathForSide(oldFileRef || fileRef, "a")}`);
    diffLines.push(`+++ ${diffPathForSide(newFileRef || fileRef, "b")}`);
    diffLines.push(...bodyLines);
    return normalizeTimelineDiffText(diffLines.join("\n"));
  }

  if (section.kind === "delete") {
    const removedCount = bodyLines.filter((line) => line.startsWith("-")).length;
    diffLines.push("deleted file mode 100644");
    diffLines.push(`--- ${diffPathForSide(oldFileRef || fileRef, "a")}`);
    diffLines.push("+++ /dev/null");
    diffLines.push(`@@ -1,${Math.max(removedCount, 1)} +0,0 @@`);
    diffLines.push(...bodyLines);
    return normalizeTimelineDiffText(diffLines.join("\n"));
  }

  if (section.kind === "rename") {
    diffLines.push(`rename from ${oldFileRef || fileRef}`);
    diffLines.push(`rename to ${newFileRef || fileRef}`);
    if (bodyLines.length > 0) {
      diffLines.push(`--- ${diffPathForSide(oldFileRef || fileRef, "a")}`);
      diffLines.push(`+++ ${diffPathForSide(newFileRef || fileRef, "b")}`);
      diffLines.push(...bodyLines);
    }
    return normalizeTimelineDiffText(diffLines.join("\n"));
  }

  return "";
}

function buildApplyPatchDiffForFileRefs(patchText, fileRefs, fileEventType, previousFileRefs = []) {
  const normalizedRefs = normalizeTimelineFileRefs(fileRefs);
  const normalizedPreviousRefs = normalizeTimelineFileRefs(previousFileRefs);
  if (!normalizedRefs.length) {
    if (normalizeTimelineFileEventType(fileEventType) !== "rename" || !normalizedPreviousRefs.length) {
      return "";
    }
  }

  const sections = parseApplyPatchSections(patchText).filter((section) => {
    if (!section?.fileRef || section.kind !== fileEventType) {
      return false;
    }
    if (fileEventType === "rename") {
      return (
        normalizedRefs.some((fileRef) => timelineFileRefsMatch(fileRef, section.newFileRef || section.fileRef)) ||
        normalizedPreviousRefs.some((fileRef) => timelineFileRefsMatch(fileRef, section.oldFileRef || ""))
      );
    }
    if (fileEventType === "delete") {
      return normalizedRefs.some((fileRef) => timelineFileRefsMatch(fileRef, section.oldFileRef || section.fileRef));
    }
    return normalizedRefs.some((fileRef) => timelineFileRefsMatch(fileRef, section.fileRef));
  });

  if (sections.length === 0) {
    return "";
  }

  return normalizeTimelineDiffText(
    sections
      .map((section) => buildUnifiedDiffFromApplyPatchSection(section))
      .filter(Boolean)
      .join("\n\n")
  );
}

function timelineFileRefsMatch(left, right) {
  const normalizedLeft = cleanTimelineFileRef(left);
  const normalizedRight = cleanTimelineFileRef(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  return normalizedLeft.endsWith(`/${normalizedRight}`) || normalizedRight.endsWith(`/${normalizedLeft}`);
}

async function captureGitDiffText({ cwd, fileRefs }) {
  const normalizedCwd = cleanText(cwd || "");
  const normalizedFileRefs = normalizeTimelineFileRefs(fileRefs)
    .map((fileRef) => gitPathspecForFileRef(normalizedCwd, fileRef))
    .filter(Boolean);
  if (!normalizedCwd || normalizedFileRefs.length === 0) {
    return "";
  }

  return new Promise((resolve) => {
    const child = spawn("git", ["diff", "--no-ext-diff", "--no-color", "-M", "--find-renames", "--", ...normalizedFileRefs], {
      cwd: normalizedCwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      resolve("");
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve("");
        return;
      }
      resolve(normalizeTimelineDiffText(stdout));
    });
  });
}

function gitPathspecForFileRef(cwd, fileRef) {
  const normalizedCwd = resolvePath(cleanText(cwd || ""));
  const normalizedFileRef = cleanText(fileRef || "");
  if (!normalizedCwd || !normalizedFileRef) {
    return "";
  }
  if (!path.isAbsolute(normalizedFileRef)) {
    return normalizedFileRef;
  }

  const resolvedFileRef = resolvePath(normalizedFileRef);
  const relativePath = path.relative(normalizedCwd, resolvedFileRef);
  if (!relativePath || relativePath.startsWith("..")) {
    return "";
  }
  return relativePath;
}

async function buildFileEventDiff({
  fileState,
  callId,
  fileRefs,
  fileEventType,
  previousFileRefs = [],
  rolloutFilePath = "",
}) {
  const normalizedFileEventType = normalizeTimelineFileEventType(fileEventType);
  if (!["write", "create", "delete", "rename"].includes(normalizedFileEventType)) {
    return {
      diffText: "",
      diffSource: "",
      diffAvailable: false,
      diffAddedLines: 0,
      diffRemovedLines: 0,
    };
  }

  const storedPatch = await findStoredApplyPatchInput({
    fileState,
    callId,
    rolloutFilePath,
  });
  let diffText = buildApplyPatchDiffForFileRefs(
    storedPatch?.inputText || "",
    fileRefs,
    normalizedFileEventType,
    previousFileRefs
  );
  let diffSource = diffText ? "apply_patch" : "";

  if (!diffText) {
    diffText = await captureGitDiffText({
      cwd: cleanText(storedPatch?.cwd || fileState?.cwd || ""),
      fileRefs: [...normalizeTimelineFileRefs(previousFileRefs), ...normalizeTimelineFileRefs(fileRefs)],
    });
    diffSource = diffText ? "git" : "";
  }

  const counts = diffLineCounts(diffText);
  return {
    diffText,
    diffSource,
    diffAvailable: Boolean(diffText),
    diffAddedLines: counts.addedLines,
    diffRemovedLines: counts.removedLines,
  };
}

function approvalRequestCallId(params) {
  if (!isPlainObject(params)) {
    return "";
  }
  return cleanText(params.itemId ?? params.item_id ?? params.callId ?? params.call_id ?? "");
}

async function ensureRolloutFileState(runtime, threadId, rolloutFilePath) {
  const normalizedRolloutFilePath = cleanText(rolloutFilePath || "");
  if (!normalizedRolloutFilePath) {
    return null;
  }

  let fileState = runtime.fileStates.get(normalizedRolloutFilePath);
  if (fileState) {
    return fileState;
  }

  fileState = {
    offset: 0,
    remainder: "",
    threadId: cleanText(threadId || ""),
    cwd: await findRolloutThreadCwd(runtime, threadId || ""),
    applyPatchInputsByCallId: new Map(),
    startupCutoffMs: 0,
    skipPartialLine: false,
  };
  runtime.fileStates.set(normalizedRolloutFilePath, fileState);
  return fileState;
}

async function buildApprovalPayloadDeltaFromRollout({ runtime, conversationId, params }) {
  const callId = approvalRequestCallId(params);
  const threadId = cleanText(conversationId || params?.threadId || params?.thread_id || "");
  if (!callId || !threadId) {
    return null;
  }

  const rolloutFilePath = findRolloutFileForThread(runtime, threadId);
  if (!rolloutFilePath) {
    return null;
  }

  const fileState = await ensureRolloutFileState(runtime, threadId, rolloutFilePath);
  if (!fileState) {
    return null;
  }

  const storedPatch = await findStoredApplyPatchInput({
    fileState,
    callId,
    rolloutFilePath,
  });
  if (!storedPatch?.inputText) {
    return null;
  }

  const sections = parseApplyPatchSections(storedPatch.inputText);
  const fileRefs = normalizeTimelineFileRefs(sections.map((section) => section?.fileRef).filter(Boolean));
  const diffText = normalizeTimelineDiffText(
    sections
      .map((section) => buildUnifiedDiffFromApplyPatchSection(section))
      .filter(Boolean)
      .join("\n\n")
  );
  const counts = diffLineCounts(diffText);
  return {
    fileRefs,
    diffText,
    diffAvailable: Boolean(diffText),
    diffSource: diffText ? "apply_patch" : "",
    diffAddedLines: counts.addedLines,
    diffRemovedLines: counts.removedLines,
  };
}

function normalizeUnifiedDiffSectionFileRef(value) {
  const normalized = cleanText(value || "");
  if (!normalized || normalized === "/dev/null") {
    return "";
  }
  if (normalized.startsWith("a/") || normalized.startsWith("b/")) {
    return cleanTimelineFileRef(normalized.slice(2));
  }
  return cleanTimelineFileRef(normalized);
}

function extractUnifiedDiffSectionFileRef(sectionText) {
  const paths = extractUnifiedDiffSectionPaths(sectionText);
  if (paths.newFileRef) {
    return paths.newFileRef;
  }
  if (paths.oldFileRef) {
    return paths.oldFileRef;
  }
  return "";
}

function extractUnifiedDiffSectionPaths(sectionText) {
  const lines = String(sectionText || "").replace(/\r\n/gu, "\n").split("\n");
  let oldFileRef = "";
  let newFileRef = "";

  for (const line of lines) {
    const diffMatch = line.match(/^diff --git\s+(\S+)\s+(\S+)$/u);
    if (!diffMatch) {
      continue;
    }
    oldFileRef = normalizeUnifiedDiffSectionFileRef(diffMatch[1]);
    newFileRef = normalizeUnifiedDiffSectionFileRef(diffMatch[2]);
    if (oldFileRef || newFileRef) {
      return { oldFileRef, newFileRef };
    }
  }

  const preferredPrefixes = ["+++ ", "--- "];
  for (const prefix of preferredPrefixes) {
    for (const line of lines) {
      if (!line.startsWith(prefix)) {
        continue;
      }
      const fileRef = normalizeUnifiedDiffSectionFileRef(line.slice(prefix.length));
      if (fileRef) {
        if (prefix === "+++ ") {
          newFileRef = fileRef;
        } else {
          oldFileRef = fileRef;
        }
      }
    }
  }

  return { oldFileRef, newFileRef };
}

function splitUnifiedDiffTextByFile(diffText) {
  const normalizedDiffText = normalizeTimelineDiffText(diffText);
  if (!normalizedDiffText) {
    return [];
  }

  const lines = normalizedDiffText.split("\n");
  const sections = [];
  let currentLines = [];

  function pushCurrent() {
    if (currentLines.length === 0) {
      return;
    }
    const sectionText = normalizeTimelineDiffText(currentLines.join("\n"));
    if (!sectionText) {
      currentLines = [];
      return;
    }
    sections.push({
      ...extractUnifiedDiffSectionPaths(sectionText),
      fileRef: extractUnifiedDiffSectionFileRef(sectionText),
      diffText: sectionText,
    });
    currentLines = [];
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      pushCurrent();
      currentLines = [line];
      continue;
    }
    if (currentLines.length === 0) {
      currentLines = [line];
      continue;
    }
    currentLines.push(line);
  }

  pushCurrent();
  return sections.filter((section) => section.diffText);
}

function codeOwnershipKeyForFile(fileRef) {
  const normalized = cleanTimelineFileRef(fileRef);
  return normalized ? `file:${normalized}` : "";
}

function codeOwnershipKeyForDelete(fileRef) {
  const normalized = cleanTimelineFileRef(fileRef);
  return normalized ? `delete:${normalized}` : "";
}

function codeOwnershipKeyForRename(oldFileRef, newFileRef) {
  const normalizedOldFileRef = cleanTimelineFileRef(oldFileRef);
  const normalizedNewFileRef = cleanTimelineFileRef(newFileRef);
  return normalizedOldFileRef && normalizedNewFileRef
    ? `rename:${normalizedOldFileRef}=>${normalizedNewFileRef}`
    : "";
}

function normalizeRepoRelativeFileRef({ repoRoot, fileRef, cwd = "" }) {
  const normalizedRepoRoot = resolvePath(cleanText(repoRoot || ""));
  const normalizedFileRef = cleanTimelineFileRef(fileRef);
  const normalizedCwd = resolvePath(cleanText(cwd || ""));
  if (!normalizedRepoRoot || !normalizedFileRef) {
    return "";
  }

  if (path.isAbsolute(normalizedFileRef)) {
    const relativePath = path.relative(normalizedRepoRoot, resolvePath(normalizedFileRef));
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return "";
    }
    return cleanTimelineFileRef(relativePath);
  }

  if (normalizedCwd) {
    const absolutePath = path.resolve(normalizedCwd, normalizedFileRef);
    const relativePath = path.relative(normalizedRepoRoot, absolutePath);
    if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
      return cleanTimelineFileRef(relativePath);
    }
  }

  return normalizedFileRef;
}

async function captureGitOutput({ cwd, args }) {
  const normalizedCwd = resolvePath(cleanText(cwd || ""));
  if (!normalizedCwd || !Array.isArray(args) || args.length === 0) {
    return "";
  }

  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: normalizedCwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      resolve("");
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve("");
        return;
      }
      resolve(String(stdout || "").replace(/\r\n/gu, "\n").trim());
    });
  });
}

async function captureGitRepoRoot(searchDir) {
  return cleanText(
    await captureGitOutput({
      cwd: searchDir,
      args: ["rev-parse", "--show-toplevel"],
    })
  );
}

async function resolveCodeEventRepoRoot(item, repoRootCache) {
  const searchDirs = [];
  const normalizedCwd = resolvePath(cleanText(item?.cwd || ""));
  if (normalizedCwd) {
    searchDirs.push(normalizedCwd);
  }

  for (const fileRef of [
    ...normalizeTimelineFileRefs(item?.fileRefs ?? []),
    ...normalizeTimelineFileRefs(item?.previousFileRefs ?? []),
  ]) {
    if (!path.isAbsolute(fileRef)) {
      continue;
    }
    searchDirs.push(path.dirname(resolvePath(fileRef)));
  }

  for (const searchDir of [...new Set(searchDirs.filter(Boolean))]) {
    if (repoRootCache.has(searchDir)) {
      const cached = cleanText(repoRootCache.get(searchDir) || "");
      if (cached) {
        return cached;
      }
      continue;
    }
    const repoRoot = await captureGitRepoRoot(searchDir);
    repoRootCache.set(searchDir, repoRoot);
    if (repoRoot) {
      return repoRoot;
    }
  }

  return "";
}

function expandCodeEventOwnershipCandidates(item, repoRoot) {
  const fileEventType = normalizeTimelineFileEventType(item?.fileEventType || "");
  const createdAtMs = Number(item?.createdAtMs) || 0;
  const cwd = cleanText(item?.cwd || "");
  const threadId = cleanText(item?.threadId || "");
  const threadLabel = cleanText(item?.threadLabel || "");
  const fileRefs = normalizeTimelineFileRefs(item?.fileRefs ?? []).map((fileRef) =>
    normalizeRepoRelativeFileRef({ repoRoot, fileRef, cwd })
  );
  const previousFileRefs = normalizeTimelineFileRefs(item?.previousFileRefs ?? []).map((fileRef) =>
    normalizeRepoRelativeFileRef({ repoRoot, fileRef, cwd })
  );

  if (fileEventType === "rename") {
    const renameCandidates = [];
    const pairCount = Math.max(fileRefs.length, previousFileRefs.length);
    for (let index = 0; index < pairCount; index += 1) {
      const newFileRef = cleanTimelineFileRef(fileRefs[index] || "");
      const oldFileRef = cleanTimelineFileRef(previousFileRefs[index] || "");
      if (!newFileRef && !oldFileRef) {
        continue;
      }
      const ownershipKeys = [
        codeOwnershipKeyForRename(oldFileRef, newFileRef),
        codeOwnershipKeyForFile(newFileRef),
      ].filter(Boolean);
      renameCandidates.push({
        threadId,
        threadLabel,
        createdAtMs,
        fileEventType,
        ownershipKeys,
        fileRef: newFileRef,
        previousFileRef: oldFileRef,
      });
    }
    return renameCandidates;
  }

  const normalizedRefs = fileRefs.filter(Boolean);
  return normalizedRefs.map((fileRef) => ({
    threadId,
    threadLabel,
    createdAtMs,
    fileEventType,
    ownershipKeys: [
      fileEventType === "delete" ? codeOwnershipKeyForDelete(fileRef) : codeOwnershipKeyForFile(fileRef),
    ].filter(Boolean),
    fileRef,
    previousFileRef: "",
  }));
}

function collectCodeCandidatePathspecs(candidates) {
  const pathspecs = new Set();
  for (const candidate of candidates) {
    const fileRef = cleanTimelineFileRef(candidate?.fileRef || "");
    const previousFileRef = cleanTimelineFileRef(candidate?.previousFileRef || "");
    if (fileRef) {
      pathspecs.add(fileRef);
    }
    if (previousFileRef) {
      pathspecs.add(previousFileRef);
    }
  }
  return [...pathspecs];
}

async function captureGitDiffNameStatus({ repoRoot, pathspecs }) {
  return captureGitOutput({
    cwd: repoRoot,
    args: ["diff", "--name-status", "-M", "--find-renames", "--", ...pathspecs],
  });
}

async function captureGitStatusPorcelain({ repoRoot, pathspecs }) {
  return captureGitOutput({
    cwd: repoRoot,
    args: ["status", "--porcelain=v1", "--untracked-files=all", "--", ...pathspecs],
  });
}

async function captureGitCurrentDiffText({ repoRoot, pathspecs }) {
  return captureGitOutput({
    cwd: repoRoot,
    args: ["diff", "--no-ext-diff", "--no-color", "-M", "--find-renames", "--", ...pathspecs],
  });
}

function parseGitNameStatusEntries(outputText) {
  const entries = [];
  for (const rawLine of String(outputText || "").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split("\t");
    const status = cleanText(parts[0] || "");
    if (!status) {
      continue;
    }
    if (status.startsWith("R")) {
      const oldFileRef = cleanTimelineFileRef(parts[1] || "");
      const newFileRef = cleanTimelineFileRef(parts[2] || "");
      if (oldFileRef && newFileRef) {
        entries.push({
          changeType: "rename",
          fileRef: newFileRef,
          oldFileRef,
          newFileRef,
        });
      }
      continue;
    }
    const fileRef = cleanTimelineFileRef(parts[1] || "");
    if (!fileRef) {
      continue;
    }
    if (status === "M") {
      entries.push({
        changeType: "write",
        fileRef,
        oldFileRef: "",
        newFileRef: fileRef,
      });
    } else if (status === "D") {
      entries.push({
        changeType: "delete",
        fileRef,
        oldFileRef: fileRef,
        newFileRef: "",
      });
    }
  }
  return entries;
}

function parseGitUntrackedEntries(outputText) {
  const fileRefs = [];
  for (const rawLine of String(outputText || "").split("\n")) {
    const line = String(rawLine || "");
    if (!line.startsWith("?? ")) {
      continue;
    }
    const fileRef = cleanTimelineFileRef(line.slice(3));
    if (fileRef) {
      fileRefs.push(fileRef);
    }
  }
  return normalizeTimelineFileRefs(fileRefs);
}

async function buildUntrackedUnifiedDiff({ repoRoot, fileRef }) {
  const normalizedRepoRoot = resolvePath(cleanText(repoRoot || ""));
  const normalizedFileRef = cleanTimelineFileRef(fileRef);
  if (!normalizedRepoRoot || !normalizedFileRef) {
    return "";
  }

  const absolutePath = path.join(normalizedRepoRoot, normalizedFileRef);
  let content = "";
  try {
    content = await fs.readFile(absolutePath, "utf8");
  } catch {
    return "";
  }

  const lines = String(content || "").replace(/\r\n/gu, "\n").split("\n");
  const bodyLines = lines.length === 1 && lines[0] === "" ? [] : lines.map((line) => `+${line}`);
  const diffLines = [
    `diff --git ${diffPathForSide(normalizedFileRef, "a")} ${diffPathForSide(normalizedFileRef, "b")}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ ${diffPathForSide(normalizedFileRef, "b")}`,
  ];
  if (bodyLines.length > 0) {
    diffLines.push(`@@ -0,0 +1,${Math.max(bodyLines.length, 1)} @@`);
    diffLines.push(...bodyLines);
  }
  return normalizeTimelineDiffText(diffLines.join("\n"));
}

function findMatchingCurrentDiffSection(sections, change) {
  if (!Array.isArray(sections) || sections.length === 0 || !isPlainObject(change)) {
    return null;
  }
  const changeType = normalizeTimelineFileEventType(change.changeType || "");
  if (changeType === "rename") {
    return (
      sections.find(
        (section) =>
          timelineFileRefsMatch(section.oldFileRef || "", change.oldFileRef || "") &&
          timelineFileRefsMatch(section.newFileRef || section.fileRef || "", change.newFileRef || "")
      ) ?? null
    );
  }
  if (changeType === "delete") {
    return (
      sections.find((section) =>
        timelineFileRefsMatch(section.oldFileRef || section.fileRef || "", change.fileRef || change.oldFileRef || "")
      ) ?? null
    );
  }
  return (
    sections.find((section) =>
      timelineFileRefsMatch(section.newFileRef || section.fileRef || "", change.fileRef || change.newFileRef || "")
    ) ?? null
  );
}

async function buildCurrentUnstagedChangesForRepo({ repoRoot, candidates }) {
  const pathspecs = collectCodeCandidatePathspecs(candidates);
  if (!repoRoot || pathspecs.length === 0) {
    return [];
  }

  const [nameStatusText, statusText, diffText] = await Promise.all([
    captureGitDiffNameStatus({ repoRoot, pathspecs }),
    captureGitStatusPorcelain({ repoRoot, pathspecs }),
    captureGitCurrentDiffText({ repoRoot, pathspecs }),
  ]);

  const diffSections = splitUnifiedDiffTextByFile(diffText);
  const currentChanges = parseGitNameStatusEntries(nameStatusText).map((entry) => {
    const section = findMatchingCurrentDiffSection(diffSections, entry);
    const bestDiffText =
      normalizeTimelineDiffText(section?.diffText || "") ||
      (entry.changeType === "rename"
        ? buildUnifiedDiffFromApplyPatchSection({
            kind: "rename",
            fileRef: entry.newFileRef || entry.fileRef,
            oldFileRef: entry.oldFileRef,
            newFileRef: entry.newFileRef || entry.fileRef,
            bodyLines: [],
          })
        : "");
    const counts = diffLineCounts(bestDiffText);
    return {
      changeType: normalizeTimelineFileEventType(entry.changeType || ""),
      fileRef: cleanTimelineFileRef(entry.fileRef || entry.newFileRef || ""),
      oldFileRef: cleanTimelineFileRef(entry.oldFileRef || ""),
      newFileRef: cleanTimelineFileRef(entry.newFileRef || entry.fileRef || ""),
      diffText: bestDiffText,
      diffAvailable: Boolean(bestDiffText),
      diffSource: bestDiffText ? "git" : "",
      diffAddedLines: counts.addedLines,
      diffRemovedLines: counts.removedLines,
    };
  });

  for (const fileRef of parseGitUntrackedEntries(statusText)) {
    const syntheticDiffText = await buildUntrackedUnifiedDiff({ repoRoot, fileRef });
    const counts = diffLineCounts(syntheticDiffText);
    currentChanges.push({
      changeType: "create",
      fileRef,
      oldFileRef: "",
      newFileRef: fileRef,
      diffText: syntheticDiffText,
      diffAvailable: Boolean(syntheticDiffText),
      diffSource: syntheticDiffText ? "git" : "",
      diffAddedLines: counts.addedLines,
      diffRemovedLines: counts.removedLines,
    });
  }

  return currentChanges;
}

function resolveCurrentChangeOwner(change, candidates) {
  const preferredKeys = [];
  const changeType = normalizeTimelineFileEventType(change?.changeType || "");
  if (changeType === "rename") {
    preferredKeys.push(codeOwnershipKeyForRename(change?.oldFileRef || "", change?.newFileRef || ""));
    preferredKeys.push(codeOwnershipKeyForFile(change?.newFileRef || change?.fileRef || ""));
  } else if (changeType === "delete") {
    preferredKeys.push(codeOwnershipKeyForDelete(change?.fileRef || change?.oldFileRef || ""));
  } else {
    preferredKeys.push(codeOwnershipKeyForFile(change?.fileRef || change?.newFileRef || ""));
  }

  for (const key of preferredKeys.filter(Boolean)) {
    const match = candidates.find((candidate) => Array.isArray(candidate?.ownershipKeys) && candidate.ownershipKeys.includes(key));
    if (match) {
      return match;
    }
  }
  return null;
}

function normalizeCodeFallbackFileRef({ fileRef, cwd = "" }) {
  const normalizedFileRef = cleanTimelineFileRef(fileRef);
  if (!normalizedFileRef) {
    return "";
  }
  if (path.isAbsolute(normalizedFileRef)) {
    return resolvePath(normalizedFileRef);
  }
  const normalizedCwd = resolvePath(cleanText(cwd || ""));
  if (!normalizedCwd) {
    return normalizedFileRef;
  }
  return resolvePath(path.resolve(normalizedCwd, normalizedFileRef));
}

function buildNonGitCodeChangeEntries(item) {
  const changeType = normalizeTimelineFileEventType(item?.fileEventType || "");
  if (!["write", "create", "delete", "rename"].includes(changeType)) {
    return [];
  }

  const normalizedCwd = cleanText(item?.cwd || "");
  const normalizedFileRefs = normalizeTimelineFileRefs(item?.fileRefs ?? []).map((fileRef) =>
    normalizeCodeFallbackFileRef({ fileRef, cwd: normalizedCwd })
  );
  const normalizedPreviousFileRefs = normalizeTimelineFileRefs(item?.previousFileRefs ?? []).map((fileRef) =>
    normalizeCodeFallbackFileRef({ fileRef, cwd: normalizedCwd })
  );
  const sections = splitUnifiedDiffTextByFile(item?.diffText ?? "");
  const rawChanges = [];

  if (changeType === "rename") {
    const pairCount = Math.max(normalizedFileRefs.length, normalizedPreviousFileRefs.length);
    for (let index = 0; index < pairCount; index += 1) {
      const newFileRef = cleanTimelineFileRef(normalizedFileRefs[index] || "");
      const oldFileRef = cleanTimelineFileRef(normalizedPreviousFileRefs[index] || "");
      if (!newFileRef && !oldFileRef) {
        continue;
      }
      rawChanges.push({
        changeType,
        fileRef: newFileRef || oldFileRef,
        oldFileRef,
        newFileRef: newFileRef || oldFileRef,
      });
    }
  } else {
    const targetRefs =
      normalizedFileRefs.length > 0
        ? normalizedFileRefs
        : changeType === "delete"
          ? normalizedPreviousFileRefs
          : [];
    for (const fileRef of targetRefs) {
      const normalizedFileRef = cleanTimelineFileRef(fileRef || "");
      if (!normalizedFileRef) {
        continue;
      }
      rawChanges.push({
        changeType,
        fileRef: normalizedFileRef,
        oldFileRef: changeType === "delete" ? normalizedFileRef : "",
        newFileRef: changeType === "delete" ? "" : normalizedFileRef,
      });
    }
  }

  const allowWholeItemDiff = sections.length === 0 && rawChanges.length <= 1;
  const baseDiffSource = normalizeTimelineDiffSource(item?.diffSource ?? "");
  const baseAddedLines = Math.max(0, Number(item?.diffAddedLines) || 0);
  const baseRemovedLines = Math.max(0, Number(item?.diffRemovedLines) || 0);
  const threadId = cleanText(item?.threadId || "");
  const threadLabel = cleanText(item?.threadLabel || "");
  const createdAtMs = Number(item?.createdAtMs) || 0;

  return rawChanges.map((change) => {
    const section = findMatchingCurrentDiffSection(sections, change);
    const diffText = normalizeTimelineDiffText(section?.diffText || (allowWholeItemDiff ? item?.diffText ?? "" : ""));
    const counts = diffText
      ? diffLineCounts(diffText)
      : {
          addedLines: allowWholeItemDiff ? baseAddedLines : 0,
          removedLines: allowWholeItemDiff ? baseRemovedLines : 0,
        };
    return {
      threadId,
      threadLabel,
      createdAtMs,
      changeType,
      fileRef: cleanTimelineFileRef(change.fileRef || change.newFileRef || change.oldFileRef || ""),
      oldFileRef: cleanTimelineFileRef(change.oldFileRef || ""),
      newFileRef: cleanTimelineFileRef(change.newFileRef || change.fileRef || ""),
      diffText,
      diffAvailable: item?.diffAvailable === true || Boolean(diffText),
      diffSource: baseDiffSource,
      diffAddedLines: counts.addedLines,
      diffRemovedLines: counts.removedLines,
    };
  });
}

function nonGitCodeChangeIdentity(change) {
  const anchorFileRef = cleanTimelineFileRef(change?.newFileRef || change?.fileRef || change?.oldFileRef || "");
  return anchorFileRef ? `file:${anchorFileRef}` : "";
}

function mergeDiffThreadSourceMode(currentMode, nextMode) {
  const normalizedCurrentMode = cleanText(currentMode || "");
  const normalizedNextMode = cleanText(nextMode || "");
  if (!normalizedCurrentMode) {
    return normalizedNextMode;
  }
  if (!normalizedNextMode || normalizedCurrentMode === normalizedNextMode) {
    return normalizedCurrentMode;
  }
  return "mixed";
}

function ensureDiffThreadGroup(groupsByThread, { threadId = "", threadLabel = "", fallbackKey = "", sourceMode = "" }) {
  const normalizedThreadId = cleanText(threadId || "");
  const normalizedThreadLabel = cleanText(threadLabel || "");
  const normalizedFallbackKey = cleanText(fallbackKey || "");
  const threadKey = normalizedThreadId || `unknown:${normalizedThreadLabel || normalizedFallbackKey || "thread"}`;
  let threadGroup = groupsByThread.get(threadKey);
  if (!threadGroup) {
    threadGroup = {
      kind: "diff_thread",
      token: diffThreadToken(normalizedThreadId, normalizedThreadLabel),
      threadId: normalizedThreadId,
      threadLabel: normalizedThreadLabel,
      sourceMode: cleanText(sourceMode || ""),
      filesByRef: new Map(),
    };
    groupsByThread.set(threadKey, threadGroup);
    return threadGroup;
  }

  if (!threadGroup.threadLabel && normalizedThreadLabel) {
    threadGroup.threadLabel = normalizedThreadLabel;
  }
  threadGroup.sourceMode = mergeDiffThreadSourceMode(threadGroup.sourceMode, sourceMode);
  return threadGroup;
}

function addChangeToDiffThreadGroup({ groupsByThread, threadId, threadLabel, fallbackKey = "", sourceMode = "", change, createdAtMs }) {
  const normalizedChangeType = normalizeTimelineFileEventType(change?.changeType || "");
  const normalizedFileRef = cleanTimelineFileRef(change?.fileRef || change?.newFileRef || change?.oldFileRef || "");
  const normalizedOldFileRef = cleanTimelineFileRef(change?.oldFileRef || "");
  const normalizedNewFileRef = cleanTimelineFileRef(change?.newFileRef || normalizedFileRef);
  if (!normalizedChangeType || !(normalizedFileRef || normalizedOldFileRef || normalizedNewFileRef)) {
    return;
  }

  const group = ensureDiffThreadGroup(groupsByThread, {
    threadId,
    threadLabel,
    fallbackKey: normalizedFileRef || normalizedNewFileRef || normalizedOldFileRef || fallbackKey,
    sourceMode,
  });

  const fileGroupKey = `file:${normalizedNewFileRef || normalizedFileRef || normalizedOldFileRef}`;
  if (!fileGroupKey) {
    return;
  }

  const latestChangedAtMs = Number(createdAtMs) || 0;
  const fileGroup = {
    fileRef: normalizedFileRef || normalizedNewFileRef || normalizedOldFileRef,
    oldFileRef: normalizedOldFileRef,
    newFileRef: normalizedNewFileRef || normalizedFileRef,
    fileLabel:
      path.basename(
        normalizedChangeType === "delete"
          ? normalizedOldFileRef || normalizedFileRef
          : normalizedNewFileRef || normalizedFileRef || normalizedOldFileRef
      ) ||
      normalizedNewFileRef ||
      normalizedOldFileRef ||
      normalizedFileRef,
    changeType: normalizedChangeType,
    fileEventTypes: [normalizedChangeType],
    addedLines: Math.max(0, Number(change?.diffAddedLines) || 0),
    removedLines: Math.max(0, Number(change?.diffRemovedLines) || 0),
    latestChangedAtMs,
    sections: [
      {
        createdAtMs: latestChangedAtMs,
        diffText: normalizeTimelineDiffText(change?.diffText ?? ""),
        diffAvailable: change?.diffAvailable === true || Boolean(change?.diffText),
        diffSource: normalizeTimelineDiffSource(change?.diffSource ?? ""),
        addedLines: Math.max(0, Number(change?.diffAddedLines) || 0),
        removedLines: Math.max(0, Number(change?.diffRemovedLines) || 0),
        fileEventType: normalizedChangeType,
      },
    ],
  };
  group.filesByRef.set(fileGroupKey, fileGroup);
}

function handleSignal() {
  runtime.stopping = true;
}

function normalizeProvider(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "claude") return "claude";
  if (normalized === "moltbook") return "moltbook";
  if (normalized === "a2a") return "a2a";
  if (normalized === "viveworker") return "viveworker";
  return "codex";
}

function providerDisplayName(locale, provider) {
  const p = normalizeProvider(provider);
  if (p === "claude") return t(locale, "common.claude");
  if (p === "moltbook") return "Moltbook";
  if (p === "a2a") return "A2A";
  return t(locale, "common.codex");
}

function normalizeHistoryItems(rawItems, maxItems) {
  if (!Array.isArray(rawItems)) {
    return [];
  }

  const normalized = rawItems
    .map(normalizeHistoryItem)
    .filter(Boolean)
    .sort((left, right) => Number(right.createdAtMs ?? 0) - Number(left.createdAtMs ?? 0));
  const deduped = [];
  const seen = new Set();
  const perProviderCount = {};
  const knownProviders = new Set(["codex", "claude", "moltbook", "a2a", "viveworker"]);
  for (const item of normalized) {
    if (seen.has(item.stableId)) {
      continue;
    }
    const provider = normalizeProvider(item.provider);
    if (!knownProviders.has(provider)) {
      knownProviders.add(provider);
    }
    const providerCount = perProviderCount[provider] ?? 0;
    if (providerCount >= maxItems) {
      continue;
    }
    seen.add(item.stableId);
    deduped.push(item);
    perProviderCount[provider] = providerCount + 1;
  }
  return deduped;
}

function normalizeHistoryItem(raw) {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (shouldHideClaudeInternalItem(raw)) {
    return null;
  }

  const stableId = cleanText(raw.stableId ?? raw.id ?? "");
  const kind = cleanText(raw.kind ?? "");
  const threadId = cleanText(raw.threadId ?? extractConversationIdFromStableId(stableId) ?? "");
  const rawThreadLabel = cleanText(raw.threadLabel ?? "");
  const historyProvider = normalizeProvider(raw.provider);
  const skipHistoryThreadLabelRewrite = historyProvider === "moltbook" || historyProvider === "a2a" || historyProvider === "viveworker"
    || kind === "moltbook_reply" || kind === "moltbook_draft" || kind === "a2a_task" || kind === "a2a_task_result" || kind === "thread_share";
  const threadLabel = skipHistoryThreadLabelRewrite
    ? rawThreadLabel
    : preferTitleOnlyJsonThreadLabel(rawThreadLabel, threadId, raw.messageText, raw.summary, raw.detailText, raw.message);
  const rawTitle = cleanText(raw.title ?? "");
  const title =
    (!isFallbackTimelineTitle(rawTitle, kind, threadId) ? rawTitle : "") ||
    (threadLabel ? formatTitle(kindTitle(DEFAULT_LOCALE, kind), threadLabel) : kindTitle(DEFAULT_LOCALE, kind));
  const messageText = normalizeTimelineMessageText(raw.messageText ?? "");
  const summary = normalizeNotificationText(raw.summary ?? "") || formatNotificationBody(messageText, 100) || "";
  const createdAtMs = Number(raw.createdAtMs) || Date.now();
  if (!stableId || !historyKinds.has(kind) || !title) {
    return null;
  }

  const outcome = normalizeTimelineOutcome(raw.outcome ?? "") || inferTimelineOutcome(kind, summary, messageText);

  const normalized = {
    stableId,
    token: cleanText(raw.token ?? "") || historyToken(stableId),
    kind,
    threadId,
    title,
    threadLabel,
    summary,
    messageText,
    imagePaths: normalizeTimelineImagePaths(raw.imagePaths ?? raw.localImagePaths ?? []),
    fileRefs: normalizeTimelineFileRefs(raw.fileRefs ?? extractTimelineFileRefs(messageText)),
    diffText: normalizeTimelineDiffText(raw.diffText ?? ""),
    diffSource: normalizeTimelineDiffSource(raw.diffSource ?? ""),
    diffAvailable: raw.diffAvailable === true || Boolean(raw.diffText),
    diffAddedLines: Math.max(0, Number(raw.diffAddedLines) || 0),
    diffRemovedLines: Math.max(0, Number(raw.diffRemovedLines) || 0),
    outcome,
    createdAtMs,
    readOnly: raw.readOnly !== false,
    primaryLabel: cleanText(raw.primaryLabel ?? "") || "詳細",
    tone: cleanText(raw.tone ?? "") || "secondary",
    provider: normalizeProvider(raw.provider),
    // Moltbook draft-specific
    ...(raw.draftType != null ? { draftType: cleanText(raw.draftType) } : {}),
    // A2A task-specific
    ...(raw.instruction != null ? { instruction: cleanText(raw.instruction) } : {}),
    ...(raw.taskStatus != null ? { taskStatus: cleanText(raw.taskStatus) } : {}),
  };
  return shouldHideClaudeInternalItem(normalized) ? null : normalized;
}

function historyToken(stableId) {
  return crypto.createHash("sha1").update(String(stableId), "utf8").digest("hex").slice(0, 24);
}

function normalizeTimelineEntries(rawItems, maxItems) {
  if (!Array.isArray(rawItems)) {
    return [];
  }

  const normalized = rawItems
    .map(normalizeTimelineEntry)
    .filter(Boolean)
    .sort((left, right) => {
      const createdAtDiff = Number(right.createdAtMs ?? 0) - Number(left.createdAtMs ?? 0);
      if (createdAtDiff !== 0) {
        return createdAtDiff;
      }
      return timelineKindSortPriority(right.kind) - timelineKindSortPriority(left.kind);
    });
  // Per-provider eviction: each provider (codex, claude, moltbook) gets up
  // to `maxItems` entries, so entries from one busy provider don't push out
  // entries from another.  Total capacity is maxItems * providerCount.
  const deduped = [];
  const seen = new Set();
  const perProviderCount = {};
  const knownProviders = new Set(["codex", "claude", "moltbook", "a2a", "viveworker"]);
  const saturatedProviders = new Set();
  // Content-based dedup for user_message entries: the same logical user turn
  // can surface through two independent readers (rollout session files and
  // ~/.codex/history.jsonl) that compute different stableIds
  // (`user_message:<threadId>:<turn_id|ISO-ts>` vs
  // `user_message:<threadId>:<integer-id|unix-seconds>`), so the stableId-only
  // filter above doesn't catch them. Collapse entries with the same
  // (threadId, messageText) pair when their createdAtMs are within 60 s —
  // wide enough to absorb rollout-vs-history-file flush skew (we've seen
  // several seconds in the wild) but narrow enough not to collapse a genuine
  // repeat (e.g. user retries the same "run tests" command minutes apart).
  // Literal here rather than a named const because this function is first
  // called at top-level module init (line ~302) which runs before any const
  // declared below would leave the TDZ.
  const userMessageDedupWindowMs = 60_000;
  const userMessageIndex = new Map();
  for (const item of normalized) {
    if (seen.has(item.stableId)) {
      continue;
    }
    if (item.kind === "user_message") {
      const threadKey = cleanText(item.threadId || "");
      const textKey = cleanText(item.messageText || "");
      if (threadKey && textKey) {
        const key = `${threadKey}\u0001${textKey}`;
        const existingMs = userMessageIndex.get(key);
        const itemMs = Number(item.createdAtMs || 0);
        if (
          existingMs !== undefined &&
          Math.abs(existingMs - itemMs) <= userMessageDedupWindowMs
        ) {
          continue;
        }
        userMessageIndex.set(key, itemMs);
      }
    }
    const prov = item.provider || "codex";
    if (saturatedProviders.has(prov)) {
      continue;
    }
    const count = (perProviderCount[prov] || 0) + 1;
    perProviderCount[prov] = count;
    if (count > maxItems) {
      saturatedProviders.add(prov);
      if (saturatedProviders.size >= knownProviders.size) break;
      continue;
    }
    seen.add(item.stableId);
    deduped.push(item);
  }
  return deduped;
}

function isCodeEventEntry(raw) {
  if (!isPlainObject(raw)) {
    return false;
  }
  if (cleanText(raw.kind || "") !== "file_event") {
    return false;
  }
  const fileEventType = normalizeTimelineFileEventType(raw.fileEventType ?? "");
  return ["write", "create", "delete", "rename"].includes(fileEventType);
}

function normalizeCodeEvents(rawItems, maxItems) {
  const candidates = Array.isArray(rawItems) ? rawItems.filter((item) => isCodeEventEntry(item)) : [];
  return normalizeTimelineEntries(candidates, maxItems);
}

function migrateRecentCodeEventsState({ config, runtime, state }) {
  const nextItems = normalizeCodeEvents(
    Array.isArray(state.recentCodeEvents) && state.recentCodeEvents.length > 0
      ? state.recentCodeEvents
      : state.recentTimelineEntries ?? runtime.recentTimelineEntries,
    config.maxCodeEvents
  );
  const previousItems = Array.isArray(state.recentCodeEvents) ? normalizeCodeEvents(state.recentCodeEvents, config.maxCodeEvents) : [];
  runtime.recentCodeEvents = nextItems;
  state.recentCodeEvents = nextItems;
  invalidateDiffThreadGroupsCache();
  return JSON.stringify(nextItems) !== JSON.stringify(previousItems);
}

function timelineKindSortPriority(kind) {
  switch (cleanText(kind || "")) {
    case "completion":
      return 70;
    case "approval":
    case "plan":
    case "plan_ready":
    case "choice":
      return 60;
    case "ambient_suggestions":
      return 52;
    case "file_event":
      return 45;
    case "assistant_final":
      return 50;
    case "assistant_commentary":
      return 40;
    case "user_message":
      return 30;
    default:
      return 0;
  }
}

function normalizeTimelineEntry(raw) {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (shouldHideClaudeInternalItem(raw)) {
    return null;
  }

  const stableId = cleanText(raw.stableId ?? raw.id ?? "");
  const kind = cleanText(raw.kind ?? "");
  const createdAtMs = Number(raw.createdAtMs) || Date.now();
  if (!stableId || !timelineKinds.has(kind)) {
    return null;
  }

  const threadId = cleanText(raw.threadId ?? extractConversationIdFromStableId(stableId) ?? "");
  const messageText = normalizeTimelineMessageText(raw.messageText ?? "");
  const fileEventType = normalizeTimelineFileEventType(raw.fileEventType ?? "");
  const diffText = normalizeTimelineDiffText(raw.diffText ?? "");
  const diffSource = normalizeTimelineDiffSource(raw.diffSource ?? "");
  const diffCounts = diffLineCounts(diffText);
  const suggestions = normalizeAmbientSuggestions(raw.suggestions ?? []);
  if (kind === "ambient_suggestions" && suggestions.length === 0) {
    return null;
  }
  const summary =
    normalizeNotificationText(raw.summary ?? "") ||
    formatNotificationBody(messageText, 180) ||
    (kind === "file_event" ? "" : cleanText(raw.title ?? "")) ||
    "";
  const rawProvider = normalizeProvider(raw.provider);
  const skipThreadLabelRewrite = rawProvider === "moltbook" || rawProvider === "a2a" || rawProvider === "viveworker"
    || kind === "moltbook_reply" || kind === "moltbook_draft" || kind === "a2a_task" || kind === "a2a_task_result" || kind === "thread_share";
  const threadLabel =
    skipThreadLabelRewrite
      ? cleanText(raw.threadLabel ?? "")
      : preferTitleOnlyJsonThreadLabel(
          cleanText(raw.threadLabel ?? ""),
          threadId,
          raw.messageText,
          raw.summary,
          raw.detailText,
          raw.message
        );
  const rawTitle = cleanText(raw.title ?? "");
  const title =
    (!isFallbackTimelineTitle(rawTitle, kind, threadId) ? rawTitle : "") ||
    (kind === "file_event" ? fileEventTitle(DEFAULT_LOCALE, fileEventType) : "") ||
    threadLabel ||
    kindTitle(DEFAULT_LOCALE, kind);
  const outcome = normalizeTimelineOutcome(raw.outcome ?? "") || inferTimelineOutcome(kind, summary, messageText);

  const normalized = {
    stableId,
    token: cleanText(raw.token ?? "") || historyToken(stableId),
    kind,
    threadId,
    threadLabel,
    title,
    summary,
    messageText,
    fileEventType,
    previousFileRefs: normalizeTimelineFileRefs(raw.previousFileRefs ?? []),
    imagePaths: normalizeTimelineImagePaths(raw.imagePaths ?? raw.localImagePaths ?? []),
    fileRefs: normalizeTimelineFileRefs(raw.fileRefs ?? extractTimelineFileRefs(messageText)),
    diffText,
    diffSource,
    diffAvailable: raw.diffAvailable === true || Boolean(diffText),
    diffAddedLines:
      Math.max(0, Number(raw.diffAddedLines)) || diffCounts.addedLines,
    diffRemovedLines:
      Math.max(0, Number(raw.diffRemovedLines)) || diffCounts.removedLines,
    outcome,
    createdAtMs,
    readOnly: raw.readOnly !== false,
    primaryLabel: cleanText(raw.primaryLabel ?? "") || "詳細",
    tone: cleanText(raw.tone ?? "") || "secondary",
    cwd: resolvePath(cleanText(raw.cwd || "")),
    provider: normalizeProvider(raw.provider),
    // Moltbook-specific fields — preserved for detail view fallback after
    // the in-memory draft/item expires.
    ...(raw.draftText != null ? { draftText: cleanText(raw.draftText) } : {}),
    ...(raw.intent != null ? { intent: cleanText(raw.intent) } : {}),
    ...(raw.postId != null ? { postId: cleanText(raw.postId) } : {}),
    ...(raw.postUrl != null ? { postUrl: cleanText(raw.postUrl) } : {}),
    ...(raw.postTitle != null ? { postTitle: cleanText(raw.postTitle) } : {}),
    ...(raw.postAuthor != null ? { postAuthor: cleanText(raw.postAuthor) } : {}),
    ...(raw.postBody != null ? { postBody: cleanText(raw.postBody) } : {}),
    ...(raw.commentAuthor != null ? { commentAuthor: cleanText(raw.commentAuthor) } : {}),
    ...(raw.contextText != null ? { contextText: cleanText(raw.contextText) } : {}),
    ...(raw.draftType != null ? { draftType: cleanText(raw.draftType) } : {}),
    ...(raw.submoltName != null ? { submoltName: cleanText(raw.submoltName) } : {}),
    ...(raw.slot != null ? { slot: cleanText(raw.slot) } : {}),
    // A2A task-specific fields
    ...(raw.instruction != null ? { instruction: cleanText(raw.instruction) } : {}),
    ...(raw.taskStatus != null ? { taskStatus: cleanText(raw.taskStatus) } : {}),
    ...(suggestions.length > 0 ? { suggestions } : {}),
  };
  return shouldHideClaudeInternalItem(normalized) ? null : normalized;
}

function recordTimelineEntry({ config, runtime, state, entry }) {
  const normalized = normalizeTimelineEntry(entry);
  if (!normalized) {
    return false;
  }

  const nextItems = normalizeTimelineEntries(
    [normalized, ...runtime.recentTimelineEntries.filter((item) => item.stableId !== normalized.stableId)],
    config.maxTimelineEntries
  );
  const changed =
    JSON.stringify(
      nextItems.map((item) => [
        item.stableId,
        item.title,
        item.createdAtMs,
        item.diffAvailable,
        item.diffSource,
        item.diffAddedLines,
        item.diffRemovedLines,
        item.diffText,
        item.previousFileRefs,
        item.cwd,
      ])
    ) !==
    JSON.stringify(
      runtime.recentTimelineEntries.map((item) => [
        item.stableId,
        item.title,
        item.createdAtMs,
        item.diffAvailable,
        item.diffSource,
        item.diffAddedLines,
        item.diffRemovedLines,
        item.diffText,
        item.previousFileRefs,
        item.cwd,
      ])
    );
  runtime.recentTimelineEntries = nextItems;
  state.recentTimelineEntries = nextItems;
  return changed;
}

function recordCodeEvent({ config, runtime, state, entry }) {
  if (!isCodeEventEntry(entry)) {
    return false;
  }
  const normalized = normalizeTimelineEntry(entry);
  if (!normalized) {
    return false;
  }

  const nextItems = normalizeCodeEvents(
    [normalized, ...runtime.recentCodeEvents.filter((item) => item.stableId !== normalized.stableId)],
    config.maxCodeEvents
  );
  const changed =
    JSON.stringify(
      nextItems.map((item) => [
        item.stableId,
        item.title,
        item.createdAtMs,
        item.diffAvailable,
        item.diffSource,
        item.diffAddedLines,
        item.diffRemovedLines,
        item.diffText,
        item.previousFileRefs,
        item.cwd,
      ])
    ) !==
    JSON.stringify(
      runtime.recentCodeEvents.map((item) => [
        item.stableId,
        item.title,
        item.createdAtMs,
        item.diffAvailable,
        item.diffSource,
        item.diffAddedLines,
        item.diffRemovedLines,
        item.diffText,
        item.previousFileRefs,
        item.cwd,
      ])
    );
  runtime.recentCodeEvents = nextItems;
  state.recentCodeEvents = nextItems;
  if (changed) {
    invalidateDiffThreadGroupsCache();
  }
  return changed;
}

function syncRecentCodeEventsFromTimeline({ config, runtime, state }) {
  const timelineCodeEvents = normalizeCodeEvents(runtime.recentTimelineEntries, config.maxCodeEvents);
  if (timelineCodeEvents.length === 0 && runtime.recentCodeEvents.length === 0) {
    return false;
  }

  const nextItems = normalizeCodeEvents(
    [
      ...timelineCodeEvents,
      ...runtime.recentCodeEvents.filter(
        (entry) => !timelineCodeEvents.some((timelineEntry) => timelineEntry.stableId === entry.stableId)
      ),
    ],
    config.maxCodeEvents
  );
  const changed =
    JSON.stringify(
      nextItems.map((item) => [
        item.stableId,
        item.title,
        item.createdAtMs,
        item.threadLabel,
        item.diffAvailable,
        item.diffSource,
        item.diffAddedLines,
        item.diffRemovedLines,
        item.diffText,
        item.previousFileRefs,
        item.cwd,
      ])
    ) !==
    JSON.stringify(
      runtime.recentCodeEvents.map((item) => [
        item.stableId,
        item.title,
        item.createdAtMs,
        item.threadLabel,
        item.diffAvailable,
        item.diffSource,
        item.diffAddedLines,
        item.diffRemovedLines,
        item.diffText,
        item.previousFileRefs,
        item.cwd,
      ])
    );
  runtime.recentCodeEvents = nextItems;
  state.recentCodeEvents = nextItems;
  if (changed) {
    invalidateDiffThreadGroupsCache();
  }
  return changed;
}

function timelineEntryByToken(runtime, token, kind = "") {
  const normalizedToken = cleanText(token ?? "");
  const normalizedKind = cleanText(kind ?? "");
  return runtime.recentTimelineEntries.find(
    (entry) => entry.token === normalizedToken && (!normalizedKind || entry.kind === normalizedKind)
  );
}

function messageTimelineStableId(kind, threadId, itemId, messageText = "", createdAtMs = 0) {
  const normalizedKind = cleanText(kind || "");
  const normalizedThreadId = cleanText(threadId || "unknown");
  const normalizedItemId = cleanText(itemId || "");
  if (normalizedItemId) {
    return `${normalizedKind}:${normalizedThreadId}:${normalizedItemId}`;
  }
  return `${normalizedKind}:${normalizedThreadId}:${Math.max(0, Number(createdAtMs) || 0)}:${historyToken(messageText)}`;
}

function historyItemFromEvent(event) {
  if (!event?.id || !event?.title) {
    return null;
  }

  if (event.kind !== "task_complete" && event.kind !== "plan_ready") {
    return null;
  }

  const kind = event.kind === "task_complete" ? "completion" : "plan_ready";
  const messageText = normalizeLongText(event.detailText || event.message || "");
  if (kind === "completion" && isAmbientSuggestionsMetadataPayload(messageText)) {
    return null;
  }
  return normalizeHistoryItem({
    stableId: event.id,
    kind,
    threadId: cleanText(event.threadId ?? event.conversationId ?? ""),
    title: event.title,
    threadLabel: cleanText(event.threadLabel ?? ""),
    summary: formatNotificationBody(messageText, 100) || event.message || "",
    messageText,
    createdAtMs: event.timestampMs || Date.now(),
    readOnly: true,
    primaryLabel: "詳細",
    tone: "secondary",
  });
}

function recordHistoryItem({ config, runtime, state, item }) {
  const normalized = normalizeHistoryItem(item);
  if (!normalized) {
    return false;
  }

  const nextItems = normalizeHistoryItems(
    [normalized, ...runtime.recentHistoryItems.filter((entry) => entry.stableId !== normalized.stableId)],
    config.maxHistoryItems
  );
  const changed =
    JSON.stringify(nextItems.map((entry) => [entry.stableId, entry.title, entry.createdAtMs])) !==
    JSON.stringify(runtime.recentHistoryItems.map((entry) => [entry.stableId, entry.title, entry.createdAtMs]));
  runtime.recentHistoryItems = nextItems;
  state.recentHistoryItems = nextItems;
  return changed;
}

function backfillAmbientSuggestionsState({ config, runtime, state }) {
  const nextTimelineEntries = normalizeTimelineEntries(
    (runtime.recentTimelineEntries ?? []).map((entry) => {
      const entryKind = cleanText(entry?.kind || "");
      if (entryKind === "ambient_suggestions") {
        const suggestions = normalizeAmbientSuggestions(entry?.suggestions ?? []);
        if (suggestions.length === 0) {
          return null;
        }
        return {
          ...entry,
          title: kindTitle(DEFAULT_LOCALE, "ambient_suggestions"),
          summary: ambientSuggestionsSummary(DEFAULT_LOCALE, suggestions),
          messageText: ambientSuggestionsMessageText(DEFAULT_LOCALE, suggestions),
          suggestions,
        };
      }
      if (entryKind !== "assistant_final") {
        return entry;
      }
      const envelope = parseAmbientSuggestionsEnvelope(entry?.messageText ?? "");
      if (!envelope) {
        return entry;
      }
      if (envelope.type !== "suggestions") {
        return null;
      }
      const suggestions = envelope.suggestions;
      return {
        ...entry,
        kind: "ambient_suggestions",
        title: kindTitle(DEFAULT_LOCALE, "ambient_suggestions"),
        summary: ambientSuggestionsSummary(DEFAULT_LOCALE, suggestions),
        messageText: ambientSuggestionsMessageText(DEFAULT_LOCALE, suggestions),
        suggestions,
      };
    }),
    config.maxTimelineEntries
  );

  const nextHistoryItems = normalizeHistoryItems(
    (runtime.recentHistoryItems ?? []).filter((item) => {
      const kind = cleanText(item?.kind || "");
      if (kind !== "assistant_final" && kind !== "completion") {
        return true;
      }
      return !isAmbientSuggestionsMetadataPayload(item?.messageText ?? "");
    }),
    config.maxHistoryItems
  );

  const timelineChanged =
    JSON.stringify(nextTimelineEntries) !== JSON.stringify(runtime.recentTimelineEntries ?? []);
  const historyChanged =
    JSON.stringify(nextHistoryItems) !== JSON.stringify(runtime.recentHistoryItems ?? []);

  if (timelineChanged) {
    runtime.recentTimelineEntries = nextTimelineEntries;
    state.recentTimelineEntries = nextTimelineEntries;
  }
  if (historyChanged) {
    runtime.recentHistoryItems = nextHistoryItems;
    state.recentHistoryItems = nextHistoryItems;
  }

  return timelineChanged || historyChanged;
}

// Flip a previously-recorded history item's readOnly flag without disturbing
// its ordering or other fields.  Used by moltbook_reply / moltbook_draft flows
// to transition pending → resolved so the entry starts matching the completed
// tab's readOnly filter.  Returns true if a mutation happened (caller should
// saveState in that case).
function flipHistoryItemReadOnly({ runtime, state, stableId, readOnly = true }) {
  const normalizedStableId = cleanText(stableId || "");
  if (!normalizedStableId) return false;
  const idx = runtime.recentHistoryItems.findIndex((entry) => entry.stableId === normalizedStableId);
  if (idx === -1) return false;
  const current = runtime.recentHistoryItems[idx];
  if (current.readOnly === readOnly) return false;
  const next = { ...current, readOnly };
  const nextItems = runtime.recentHistoryItems.slice();
  nextItems[idx] = next;
  runtime.recentHistoryItems = nextItems;
  state.recentHistoryItems = nextItems;
  return true;
}

function recordActionHistoryItem({
  config,
  runtime,
  state,
  kind,
  stableId,
  token,
  title,
  threadLabel = "",
  messageText,
  summary,
  fileRefs = [],
  diffText = "",
  diffSource = "",
  diffAvailable = false,
  diffAddedLines = 0,
  diffRemovedLines = 0,
  outcome = "",
  provider = "codex",
}) {
  const item = {
    stableId,
    token,
    kind,
    title,
    threadId: cleanText(extractConversationIdFromStableId(stableId) ?? ""),
    threadLabel,
    summary,
    messageText,
    fileRefs,
    diffText,
    diffSource,
    diffAvailable,
    diffAddedLines,
    diffRemovedLines,
    outcome,
    provider: normalizeProvider(provider),
    createdAtMs: Date.now(),
    readOnly: true,
    primaryLabel: "詳細",
    tone: "secondary",
  };

  const historyChanged = recordHistoryItem({
    config,
    runtime,
    state,
    item,
  });
  const timelineChanged = recordTimelineEntry({
    config,
    runtime,
    state,
    entry: item,
  });
  return historyChanged || timelineChanged;
}

function pendingApprovalStableId(approval) {
  return `approval:${approval.requestKey}`;
}

function pendingPlanStableId(planRequest) {
  return `plan:${planRequest.turnKey || planRequest.requestKey}`;
}

function pendingChoiceStableId(userInputRequest) {
  return `choice:${userInputRequest.requestKey}`;
}

function buildAppItemUrl(config, kind, token, options = {}) {
  const url = new URL(`${config.nativeApprovalPublicBaseUrl}/app`);
  url.searchParams.set("item", `${kind}:${token}`);
  const tab = cleanText(options.tab || "");
  const subtab = cleanText(options.subtab || "");
  if (tab) {
    url.searchParams.set("tab", tab);
  }
  if (subtab) {
    url.searchParams.set("subtab", subtab);
  }
  return url.toString();
}

function buildPushPayload({ config, kind, token, stableId, title, body, tab = "", subtab = "" }) {
  return {
    title: withNotificationIcon(kind, title),
    body: formatNotificationBody(body, config.completionDetailThresholdChars) || body || title,
    tag: stableId,
    data: {
      kind,
      token,
      stableId,
      url: buildAppItemUrl(config, kind, token, { tab, subtab }),
    },
  };
}

function pushSubscriptionId(endpoint) {
  return crypto.createHash("sha1").update(String(endpoint || ""), "utf8").digest("hex").slice(0, 24);
}

function normalizePushSubscriptionRecord(raw) {
  if (!isPlainObject(raw)) {
    return null;
  }
  const endpoint = cleanText(raw.endpoint ?? "");
  const deviceId = cleanText(raw.deviceId ?? "");
  const p256dh = cleanText(raw.keys?.p256dh ?? raw.p256dh ?? "");
  const auth = cleanText(raw.keys?.auth ?? raw.auth ?? "");
  if (!endpoint || !deviceId || !p256dh || !auth) {
    return null;
  }
  return {
    id: cleanText(raw.id ?? "") || pushSubscriptionId(endpoint),
    endpoint,
    keys: { p256dh, auth },
    deviceId,
    userAgent: cleanText(raw.userAgent ?? ""),
    standalone: raw.standalone === true,
    createdAtMs: Number(raw.createdAtMs) || Date.now(),
    updatedAtMs: Number(raw.updatedAtMs) || Date.now(),
    lastSuccessfulDeliveryAtMs: Number(raw.lastSuccessfulDeliveryAtMs) || 0,
  };
}

function serializePushSubscriptionRecord(record) {
  return {
    id: record.id,
    endpoint: record.endpoint,
    keys: record.keys,
    deviceId: record.deviceId,
    userAgent: record.userAgent ?? "",
    standalone: record.standalone === true,
    createdAtMs: Number(record.createdAtMs) || Date.now(),
    updatedAtMs: Number(record.updatedAtMs) || Date.now(),
    lastSuccessfulDeliveryAtMs: Number(record.lastSuccessfulDeliveryAtMs) || 0,
  };
}

function listPushSubscriptions(state) {
  if (!isPlainObject(state.pushSubscriptions)) {
    return [];
  }
  return Object.values(state.pushSubscriptions)
    .map((entry) => normalizePushSubscriptionRecord(entry))
    .filter(Boolean);
}

function getPushSubscriptionForDevice(state, deviceId) {
  const normalizedDeviceId = cleanText(deviceId || "");
  if (!normalizedDeviceId) {
    return null;
  }
  return listPushSubscriptions(state).find((entry) => entry.deviceId === normalizedDeviceId) ?? null;
}

function upsertPushSubscription(state, record) {
  const normalized = normalizePushSubscriptionRecord(record);
  if (!normalized) {
    return false;
  }
  if (!isPlainObject(state.pushSubscriptions)) {
    state.pushSubscriptions = {};
  }

  let changed = false;
  for (const [id, existing] of Object.entries(state.pushSubscriptions)) {
    const normalizedExisting = normalizePushSubscriptionRecord(existing);
    if (!normalizedExisting) {
      delete state.pushSubscriptions[id];
      changed = true;
      continue;
    }
    if (
      normalizedExisting.id !== normalized.id &&
      normalizedExisting.deviceId === normalized.deviceId
    ) {
      delete state.pushSubscriptions[id];
      changed = true;
    }
  }

  const previous = state.pushSubscriptions[normalized.id];
  const serialized = serializePushSubscriptionRecord(normalized);
  state.pushSubscriptions[normalized.id] = serialized;
  return JSON.stringify(previous) !== JSON.stringify(serialized) || changed;
}

function deletePushSubscriptionById(state, subscriptionId) {
  if (!subscriptionId || !isPlainObject(state.pushSubscriptions) || !state.pushSubscriptions[subscriptionId]) {
    return false;
  }
  delete state.pushSubscriptions[subscriptionId];
  return true;
}

function deletePushSubscriptionsForDevice(state, deviceId) {
  let changed = false;
  for (const subscription of listPushSubscriptions(state)) {
    if (subscription.deviceId !== deviceId) {
      continue;
    }
    delete state.pushSubscriptions[subscription.id];
    changed = true;
  }
  return changed;
}

function pushDeliveryKey(deviceId, stableId) {
  return `${cleanText(deviceId || "")}:${cleanText(stableId || "")}`;
}

async function deliverWebPushItem({ config, state, kind, token, stableId, title, body, tab = "", subtab = "", buildLocalizedContent = null }) {
  if (!config.webPushEnabled || config.dryRun) {
    return false;
  }

  const subscriptions = listPushSubscriptions(state);
  if (subscriptions.length === 0) {
    return false;
  }

  if (!isPlainObject(state.pushDeliveries)) {
    state.pushDeliveries = {};
  }

  let changed = false;

  for (const subscription of subscriptions) {
    const deliveryKey = pushDeliveryKey(subscription.deviceId, stableId);
    if (state.pushDeliveries[deliveryKey]) {
      continue;
    }

    try {
      const locale = resolveDeviceLocaleInfo(config, state, subscription.deviceId).locale;
      const localizedContent = typeof buildLocalizedContent === "function"
        ? buildLocalizedContent({ locale, deviceId: subscription.deviceId })
        : { title, body };
      const payload = JSON.stringify(
        buildPushPayload({
          config,
          kind,
          token,
          stableId,
          title: localizedContent?.title || title,
          body: localizedContent?.body || body,
          tab,
          subtab,
        })
      );
      await webPush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: subscription.keys,
        },
        payload
      );
      const now = Date.now();
      state.pushDeliveries[deliveryKey] = now;
      trimSeenEvents(state.pushDeliveries, config.maxSeenEvents * 4);
      const stored = normalizePushSubscriptionRecord(state.pushSubscriptions?.[subscription.id]);
      if (stored) {
        stored.lastSuccessfulDeliveryAtMs = now;
        stored.updatedAtMs = now;
        state.pushSubscriptions[subscription.id] = serializePushSubscriptionRecord(stored);
      }
      changed = true;
      console.log(`[web-push] ${stableId} | ${subscription.deviceId}`);
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 0;
      if (statusCode === 404 || statusCode === 410) {
        changed = deletePushSubscriptionById(state, subscription.id) || changed;
        console.warn(`[web-push-pruned] ${subscription.id} | ${statusCode}`);
        continue;
      }
      console.error(`[web-push-error] ${stableId} | ${subscription.deviceId} | ${error.message}`);
    }
  }

  return changed;
}

async function scanOnce({ config, runtime, state }) {
  let dirty = false;
  const now = Date.now();
  let sessionIndexChanged = false;
  let knownFilesChanged = false;

  if (now - runtime.lastSessionIndexLoadAt >= config.sessionIndexRefreshMs) {
    runtime.sessionIndex = await loadSessionIndex(config.sessionIndexFile);
    runtime.lastSessionIndexLoadAt = now;
    sessionIndexChanged = true;
  }

  if (now - runtime.lastDirectoryScanAt >= config.directoryScanIntervalMs) {
    runtime.knownFiles = await listRolloutFiles(config.sessionsDir);
    runtime.logsDbFile = config.codexLogsDbFile || (await findLatestCodexLogsDbFile(config.codexHome)) || "";
    runtime.lastDirectoryScanAt = now;
    knownFilesChanged = true;
  }

  if (sessionIndexChanged || knownFilesChanged) {
    if (knownFilesChanged) {
      runtime.rolloutThreadCwds = new Map();
    }
    runtime.rolloutThreadLabels = await buildRolloutThreadLabelIndex(runtime.knownFiles, runtime.sessionIndex);
    dirty = refreshResolvedThreadLabels({ config, runtime, state }) || dirty;
  }

  for (const filePath of runtime.knownFiles) {
    const changed = await processRolloutFile({
      filePath,
      config,
      runtime,
      state,
      now,
    });
    dirty = dirty || changed;
  }

  if (config.notifyCompletions || config.webUiEnabled) {
    const changed = await processSqliteCompletionLog({
      config,
      runtime,
      state,
      now,
    });
    dirty = dirty || changed;
  }

  if (config.webUiEnabled) {
    let claudeTranscriptChanged = false;
    if (now - runtime.lastClaudeScanAt >= config.directoryScanIntervalMs) {
      runtime.claudeKnownFiles = await listClaudeTranscriptFiles(config.claudeProjectsDir);
      runtime.lastClaudeScanAt = now;
    }
    let claudeSessionTitlesChanged = false;
    if (now - runtime.lastClaudeSessionTitleScanAt >= config.directoryScanIntervalMs) {
      claudeSessionTitlesChanged = await refreshClaudeSessionTitles(runtime);
      runtime.lastClaudeSessionTitleScanAt = now;
    }
    for (const filePath of runtime.claudeKnownFiles) {
      const changed = await processClaudeTranscriptFile({ filePath, config, runtime, state, now });
      claudeTranscriptChanged = claudeTranscriptChanged || changed;
      dirty = dirty || changed;
    }
    if (claudeTranscriptChanged || claudeSessionTitlesChanged) {
      dirty = refreshResolvedThreadLabels({ config, runtime, state }) || dirty;
    }
  }

  if (config.webUiEnabled) {
    const sqliteTimelineChanged = await processSqliteTimelineLog({
      config,
      runtime,
      state,
      now,
    });
    dirty = dirty || sqliteTimelineChanged;

    const historyTimelineChanged = await processHistoryTimelineFile({
      config,
      runtime,
      state,
      now,
    });
    dirty = dirty || historyTimelineChanged;

    const timelineImageBackfillChanged = await backfillRecentTimelineEntryImages({
      config,
      runtime,
      state,
    });
    dirty = dirty || timelineImageBackfillChanged;

    const persistedTimelineImageBackfillChanged = await backfillPersistedTimelineImagePaths({
      config,
      runtime,
      state,
    });
    dirty = dirty || persistedTimelineImageBackfillChanged;

    const timelineDiffBackfillChanged = await backfillRecentTimelineEntryDiffs({
      config,
      runtime,
      state,
    });
    dirty = dirty || timelineDiffBackfillChanged;

    const interruptedTimelineBackfillChanged = backfillInterruptedTimelineEntries({
      config,
      runtime,
      state,
    });
    dirty = dirty || interruptedTimelineBackfillChanged;

    const codeEventsSyncChanged = syncRecentCodeEventsFromTimeline({
      config,
      runtime,
      state,
    });
    dirty = dirty || codeEventsSyncChanged;
  }

  dirty = cleanupExpiredPlanRequests({ runtime, state, now }) || dirty;
  dirty = cleanupExpiredUserInputRequests({ runtime, state, now }) || dirty;

  return dirty;
}

async function processRolloutFile({ filePath, config, runtime, state, now }) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return false;
  }

  let fileState = runtime.fileStates.get(filePath);
  if (!fileState) {
    const restoredOffset = state.fileOffsets[filePath];
    const shouldReplayRecent = stat.mtimeMs >= now - config.replaySeconds * 1000;
    fileState = {
      offset:
        typeof restoredOffset === "number"
          ? restoredOffset
          : shouldReplayRecent
            ? Math.max(0, stat.size - config.maxReadBytes)
            : stat.size,
      remainder: "",
      threadId: extractThreadIdFromRolloutPath(filePath),
      cwd: null,
      applyPatchInputsByCallId: new Map(),
      startupCutoffMs:
        typeof restoredOffset === "number" ? 0 : now - config.replaySeconds * 1000,
      skipPartialLine:
        typeof restoredOffset !== "number" && shouldReplayRecent && stat.size > config.maxReadBytes,
    };
    runtime.fileStates.set(filePath, fileState);
  }

  if (stat.size < fileState.offset) {
    fileState.offset = 0;
    fileState.remainder = "";
    fileState.skipPartialLine = false;
  }

  if (stat.size === fileState.offset) {
    return false;
  }

  if (stat.size - fileState.offset > config.maxReadBytes) {
    fileState.offset = Math.max(0, stat.size - config.maxReadBytes);
    state.fileOffsets[filePath] = fileState.offset;
    fileState.remainder = "";
    fileState.skipPartialLine = true;
  }

  const length = stat.size - fileState.offset;
  const handle = await fs.open(filePath, "r");
  const buffer = Buffer.alloc(length);
  try {
    await handle.read(buffer, 0, length, fileState.offset);
  } finally {
    await handle.close();
  }

  const chunk = buffer.toString("utf8");
  const merged = fileState.remainder + chunk;
  const lines = merged.split("\n");
  fileState.remainder = lines.pop() ?? "";
  if (fileState.skipPartialLine && lines.length > 0) {
    lines.shift();
    fileState.skipPartialLine = false;
  }
  fileState.offset = stat.size;
  state.fileOffsets[filePath] = fileState.offset;

  let dirty = true;
  for (const rawLine of lines) {
    if (!rawLine.trim()) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(rawLine);
    } catch {
      continue;
    }

    if (record.type === "session_meta") {
      fileState.threadId = record.payload?.id ?? fileState.threadId;
      fileState.cwd = record.payload?.cwd ?? fileState.cwd;
      continue;
    }

    if (config.webUiEnabled) {
      const timelineEntry = buildRolloutUserTimelineEntry({
        record,
        fileState,
        runtime,
      });
      if (timelineEntry) {
        dirty =
          recordTimelineEntry({
            config,
            runtime,
            state,
            entry: timelineEntry,
          }) || dirty;
      }

      const fileTimelineEntries = await buildRolloutFileTimelineEntries({
        config,
        record,
        fileState,
        runtime,
        rolloutFilePath: filePath,
      });
      for (const fileTimelineEntry of fileTimelineEntries) {
        dirty =
          recordTimelineEntry({
            config,
            runtime,
            state,
            entry: fileTimelineEntry,
          }) || dirty;
        dirty =
          recordCodeEvent({
            config,
            runtime,
            state,
            entry: fileTimelineEntry,
          }) || dirty;
      }
    }

    const event = buildRolloutEvent({
      record,
      filePath,
      fileState,
      sessionIndex: runtime.sessionIndex,
      config,
      runtime,
      state,
    });
    if (!event) {
      continue;
    }

    if (fileState.startupCutoffMs && event.timestampMs < fileState.startupCutoffMs) {
      continue;
    }

    dirty =
      (await processScannedEvent({
        config,
        runtime,
        state,
        event,
      })) || dirty;
  }

  fileState.startupCutoffMs = 0;
  return dirty;
}

function fileEventCallIdFromStableId(stableId) {
  const match = cleanText(stableId || "").match(/^file_event:(?:read|write|create):[^:]+:(call_[^:]+)$/u);
  return match ? cleanText(match[1]) : "";
}

async function refreshClaudeSessionTitles(runtime) {
  let changed = false;
  // Read ~/Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json
  // Each file maps cliSessionId → title (auto-generated by Claude Desktop).
  const baseDir = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Claude",
    "claude-code-sessions"
  );
  try {
    const topEntries = await fs.readdir(baseDir, { withFileTypes: true });
    for (const top of topEntries) {
      if (!top.isDirectory()) continue;
      const topPath = path.join(baseDir, top.name);
      let midEntries;
      try {
        midEntries = await fs.readdir(topPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const mid of midEntries) {
        if (!mid.isDirectory()) continue;
        const midPath = path.join(topPath, mid.name);
        let files;
        try {
          files = await fs.readdir(midPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.isFile() || !file.name.startsWith("local_") || !file.name.endsWith(".json")) continue;
          try {
            const raw = await fs.readFile(path.join(midPath, file.name), "utf8");
            const data = JSON.parse(raw);
            const cliSessionId = cleanText(data?.cliSessionId || "");
            const title = cleanText(data?.title || "");
            if (cliSessionId && title) {
              if (runtime.claudeSessionTitles.get(cliSessionId) !== title) {
                runtime.claudeSessionTitles.set(cliSessionId, title);
                changed = true;
              }
            }
          } catch {
            // skip unreadable/invalid
          }
        }
      }
    }
  } catch {
    // base dir missing — Claude Desktop not installed
  }

  for (const filePath of runtime.claudeKnownFiles ?? []) {
    let lines;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      lines = raw.split("\n");
    } catch {
      continue;
    }
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      let record;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (record?.entrypoint !== "sdk-cli" || record?.type !== "user") {
        continue;
      }
      const threadId = cleanText(record?.sessionId || "");
      const message = record?.message || {};
      let text = "";
      if (typeof message.content === "string") {
        text = message.content;
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === "text" && block.text) {
            text += block.text;
          }
        }
      }
      const derivedTitle = deriveClaudeSdkCliThreadLabel(text, threadId);
      if (threadId && derivedTitle && runtime.claudeSessionTitles.get(threadId) !== derivedTitle) {
        runtime.claudeSessionTitles.set(threadId, derivedTitle);
        changed = true;
      }
      break;
    }
  }

  return changed;
}

async function listClaudeTranscriptFiles(claudeProjectsDir) {
  try {
    const result = [];
    const entries = await fs.readdir(claudeProjectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectPath = path.join(claudeProjectsDir, entry.name);
      try {
        const files = await fs.readdir(projectPath, { withFileTypes: true });
        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
          result.push(path.join(projectPath, file.name));
        }
      } catch {
        // skip unreadable project dirs
      }
    }
    return result;
  } catch {
    return [];
  }
}

async function processClaudeTranscriptFile({ filePath, config, runtime, state, now }) {
  let fileState = runtime.claudeFileStates.get(filePath);
  if (!fileState) {
    // Derive a default threadLabel from the project directory path
    // e.g. ~/.claude/projects/-Users-y-hoshino-Work-kanade/session.jsonl → "kanade"
    const projectDirName = path.basename(path.dirname(filePath));
    const decodedProjectDir = projectDirName.replace(/^-/u, "").replace(/-/gu, "/");
    const defaultThreadLabel = path.basename(decodedProjectDir) || "";

    // On startup, use the same "recent only" strategy as processRolloutFile to avoid
    // re-processing old entries that would be immediately discarded by the per-provider entry limit.
    let initialOffset = 0;
    let startupCutoffMs = 0;
    try {
      const stat = await fs.stat(filePath);
      const shouldReplayRecent = stat.mtimeMs >= now - config.replaySeconds * 1000;
      if (shouldReplayRecent) {
        // Recently active transcript: start from near the end and apply a time cutoff
        initialOffset = Math.max(0, stat.size - config.maxReadBytes);
        startupCutoffMs = now - config.replaySeconds * 1000;
      } else {
        // Inactive transcript: skip to end, only process future appends
        initialOffset = stat.size;
      }
    } catch {
      // stat failed — start from beginning with no cutoff
    }

    fileState = { offset: initialOffset, threadId: "", threadLabel: defaultThreadLabel, cwd: "", startupCutoffMs, remainder: "" };
    runtime.claudeFileStates.set(filePath, fileState);
  }

  let fileContent;
  let newOffset;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size <= fileState.offset) return false;
    if (stat.size - fileState.offset > config.maxReadBytes) {
      fileState.offset = Math.max(0, stat.size - config.maxReadBytes);
      fileState.remainder = "";
    }
    const readLen = stat.size - fileState.offset;
    const buf = Buffer.alloc(readLen);
    const fh = await fs.open(filePath, "r");
    try {
      const { bytesRead } = await fh.read(buf, 0, readLen, fileState.offset);
      fileContent = buf.slice(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
    newOffset = stat.size;
  } catch {
    return false;
  }

  const merged = (fileState.remainder || "") + fileContent;
  const lines = merged.split("\n");
  // Last element is the in-progress partial line (or "" if file ends with \n).
  // Stash it as the next remainder so a future scan can complete it.
  fileState.remainder = lines.pop() ?? "";
  fileState.offset = newOffset;
  let dirty = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Apply startup cutoff: skip entries older than replaySeconds on first scan
    if (fileState.startupCutoffMs && record.timestamp) {
      const recordMs = Date.parse(record.timestamp);
      if (recordMs && recordMs < fileState.startupCutoffMs) {
        // Still update threadId/cwd state so later entries inherit correct context
        if (record.sessionId) fileState.threadId = record.sessionId;
        if (record.cwd) {
          fileState.cwd = record.cwd;
          fileState.threadLabel = path.basename(record.cwd);
        }
        continue;
      }
    }

    if (record.sessionId) fileState.threadId = record.sessionId;
    if (record.cwd) {
      fileState.cwd = record.cwd;
      fileState.threadLabel = path.basename(record.cwd);
    }

    // Accept both Claude Desktop sessions and the current sdk-cli sessions
    // that Claude emits for agent-driven work. The latter regressed the
    // timeline/completed views because they were silently skipped here.
    if (record.entrypoint !== "claude-desktop" && record.entrypoint !== "sdk-cli") continue;

    const type = record.type;
    if (type !== "user" && type !== "assistant") continue;
    // Skip Claude Code's meta records (e.g. Stop hook feedback injected as a
    // synthetic user message). They are not real user input.
    if (record.isMeta === true) continue;

    const msg = record.message || {};
    const content = msg.content;
    const uuid = cleanText(record.uuid || "");
    const createdAtMs = record.timestamp ? Date.parse(record.timestamp) : now;
    const threadId = cleanText(fileState.threadId || record.sessionId || "");
    // Prefer Claude Desktop's auto-generated session title (e.g. "Sync Codex app from Mac to iPhone")
    // when available; fall back to the cwd-derived basename (e.g. "viveworker").
    const claudeTitle = threadId ? runtime.claudeSessionTitles.get(threadId) || "" : "";
    const threadLabel = claudeTitle || fileState.threadLabel || "";

    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && block.text) text += block.text;
      }
    }
    text = cleanText(text);
    if (!text) continue;
    if (type === "user" && record.entrypoint === "sdk-cli") {
      const derivedThreadLabel = deriveClaudeSdkCliThreadLabel(text, threadId);
      if (derivedThreadLabel) {
        fileState.threadLabel = derivedThreadLabel;
        if (threadId) {
          runtime.claudeSessionTitles.set(threadId, derivedThreadLabel);
        }
      }
    }
    // Skip Claude Code internal system messages (task notifications, system
    // reminders, etc.) — these are XML-like tags injected into the
    // conversation that should not appear on the user-facing timeline.
    if (/^<(?:task-notification|system-reminder)\b/i.test(text.trim())) continue;

    // Classify assistant messages using Claude's stop_reason:
    //   "end_turn"  → final answer (like Codex phase "final_answer")
    //   "tool_use"  → intermediate, about to call tools (commentary)
    //   null/other  → intermediate thinking (commentary)
    const stopReason = msg.stop_reason || "";
    const kind = type === "user"
      ? "user_message"
      : stopReason === "end_turn"
        ? "assistant_final"
        : "assistant_commentary";
    // Use kind-independent stableId so re-scans with corrected classification
    // replace old entries rather than creating duplicates.
    const stableId = `claude_msg:${threadId}:${uuid}`;
    const entry = normalizeTimelineEntry({
      stableId,
      token: historyToken(stableId),
      kind,
      threadId,
      threadLabel,
      title: threadLabel || "Claude",
      summary: truncate(singleLine(text), 180),
      messageText: text,
      createdAtMs,
      readOnly: true,
      cwd: fileState.cwd,
      provider: "claude",
    });
    if (entry) {
      dirty = recordTimelineEntry({ config, runtime, state, entry }) || dirty;

      // Also record Claude assistant_final as a history item for the completed list
      if (kind === "assistant_final") {
        dirty = recordHistoryItem({
          config, runtime, state,
          item: {
            stableId: entry.stableId,
            kind: entry.kind,
            threadId: entry.threadId,
            title: entry.title,
            threadLabel: entry.threadLabel,
            summary: entry.summary,
            messageText: entry.messageText,
            createdAtMs: entry.createdAtMs,
            readOnly: true,
            provider: "claude",
          },
        }) || dirty;
      }

      // Push notification for Claude final answers (skip during startup replay)
      if (kind === "assistant_final" && !fileState.startupCutoffMs) {
        try {
          await deliverWebPushItem({
            config,
            state,
            kind: "assistant_final",
            tab: "timeline",
            token: entry.token,
            stableId: entry.stableId,
            title: threadLabel || "Claude",
            body: truncate(singleLine(text), 160),
            buildLocalizedContent: ({ locale }) => ({
              title: formatLocalizedTitle(locale, "server.title.assistantFinal", threadLabel),
              body: truncate(singleLine(text), 160),
            }),
          });
        } catch (pushError) {
          console.error(`[claude-push-error] ${pushError.message}`);
        }
      }
    }
  }

  // Clear startup cutoff after first scan so subsequent incremental reads are unfiltered
  fileState.startupCutoffMs = 0;
  return dirty;
}

async function loadRecoveryBackupState(stateFile) {
  const dir = path.dirname(stateFile);
  const base = path.basename(stateFile);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(`${base}.bak-`)) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const stat = await fs.stat(filePath);
      candidates.push({ filePath, mtimeMs: Number(stat.mtimeMs) || 0 });
    } catch {
      // ignore unreadable backup
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate.filePath, "utf8");
      return JSON.parse(raw);
    } catch {
      // try next backup
    }
  }
  return null;
}

function providerSetForItems(items) {
  return new Set(
    (Array.isArray(items) ? items : [])
      .map((item) => normalizeProvider(item?.provider))
      .filter(Boolean)
  );
}

function missingRecoveryProviders(items) {
  const present = providerSetForItems(items);
  return ["claude", "a2a"].filter((provider) => !present.has(provider));
}

function selectRecoveryItems(items, missingProviders) {
  const wanted = new Set(missingProviders);
  return (Array.isArray(items) ? items : []).filter((item) => wanted.has(normalizeProvider(item?.provider)));
}

async function recoverMissingProviderStateFromBackup({ config, runtime, state }) {
  const missingHistoryProviders = missingRecoveryProviders(state.recentHistoryItems ?? runtime.recentHistoryItems);
  const missingTimelineProviders = missingRecoveryProviders(state.recentTimelineEntries ?? runtime.recentTimelineEntries);
  const shouldRecoverCodeEvents = !Array.isArray(state.recentCodeEvents) || state.recentCodeEvents.length === 0;

  if (missingHistoryProviders.length === 0 && missingTimelineProviders.length === 0 && !shouldRecoverCodeEvents) {
    return false;
  }

  const backup = await loadRecoveryBackupState(config.stateFile);
  if (!backup) {
    return false;
  }

  let changed = false;

  if (missingHistoryProviders.length > 0) {
    const mergedHistory = normalizeHistoryItems(
      [
        ...(state.recentHistoryItems ?? runtime.recentHistoryItems ?? []),
        ...selectRecoveryItems(backup.recentHistoryItems, missingHistoryProviders),
      ],
      config.maxHistoryItems
    );
    if (JSON.stringify(mergedHistory) !== JSON.stringify(state.recentHistoryItems ?? runtime.recentHistoryItems ?? [])) {
      state.recentHistoryItems = mergedHistory;
      runtime.recentHistoryItems = mergedHistory;
      changed = true;
    }
  }

  if (missingTimelineProviders.length > 0) {
    const mergedTimeline = normalizeTimelineEntries(
      [
        ...(state.recentTimelineEntries ?? runtime.recentTimelineEntries ?? []),
        ...selectRecoveryItems(backup.recentTimelineEntries, missingTimelineProviders),
      ],
      config.maxTimelineEntries
    );
    if (JSON.stringify(mergedTimeline) !== JSON.stringify(state.recentTimelineEntries ?? runtime.recentTimelineEntries ?? [])) {
      state.recentTimelineEntries = mergedTimeline;
      runtime.recentTimelineEntries = mergedTimeline;
      changed = true;
    }
  }

  if (shouldRecoverCodeEvents) {
    const mergedCodeEvents = normalizeCodeEvents(
      [
        ...(state.recentCodeEvents ?? runtime.recentCodeEvents ?? []),
        ...(Array.isArray(backup.recentCodeEvents) ? backup.recentCodeEvents : []),
      ],
      config.maxCodeEvents
    );
    if (JSON.stringify(mergedCodeEvents) !== JSON.stringify(state.recentCodeEvents ?? runtime.recentCodeEvents ?? [])) {
      state.recentCodeEvents = mergedCodeEvents;
      runtime.recentCodeEvents = mergedCodeEvents;
      invalidateDiffThreadGroupsCache();
      changed = true;
    }
  }

  if (changed) {
    console.log(
      `[state-recovery] recovered history=${missingHistoryProviders.join(",") || "none"} timeline=${missingTimelineProviders.join(",") || "none"} code=${shouldRecoverCodeEvents ? "yes" : "no"}`
    );
  }
  return changed;
}

async function processSqliteCompletionLog({ config, runtime, state, now }) {
  const logsDbFile = cleanText(runtime.logsDbFile || config.codexLogsDbFile || "");
  if (!logsDbFile) {
    return false;
  }

  try {
    await fs.access(logsDbFile);
  } catch {
    return false;
  }

  let dirty = false;
  const sourceChanged = cleanText(state.sqliteCompletionSourceFile ?? "") !== logsDbFile;
  if (sourceChanged) {
    state.sqliteCompletionSourceFile = logsDbFile;
    state.sqliteCompletionCursorId = 0;
    dirty = true;
  }

  let cursorId = Number(state.sqliteCompletionCursorId) || 0;
  const startupMinTsSec = Math.max(0, Math.floor((now - config.replaySeconds * 1000) / 1000));

  while (true) {
    let rows;
    try {
      rows = await querySqliteCompletionRows({
        logsDbFile,
        cursorId,
        minTsSec: cursorId > 0 ? 0 : startupMinTsSec,
      });
    } catch (error) {
      console.error(`[sqlite-completion-scan-error] ${error.message}`);
      break;
    }

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const rowId = Number(row.id) || 0;
      if (rowId > cursorId) {
        cursorId = rowId;
      }

      const event = buildSqliteCompletionEvent({
        row,
        config,
        runtime,
      });
      if (!event) {
        continue;
      }

      dirty =
        (await processScannedEvent({
          config,
          runtime,
          state,
          event,
        })) || dirty;
    }

    state.sqliteCompletionCursorId = cursorId;
    dirty = true;

    if (rows.length < SQLITE_COMPLETION_BATCH_SIZE) {
      break;
    }
  }

  return dirty;
}

async function processSqliteTimelineLog({ config, runtime, state, now }) {
  const logsDbFile = cleanText(runtime.logsDbFile || config.codexLogsDbFile || "");
  if (!logsDbFile) {
    return false;
  }

  try {
    await fs.access(logsDbFile);
  } catch {
    return false;
  }

  let dirty = false;
  const sourceChanged = cleanText(state.sqliteMessageSourceFile ?? "") !== logsDbFile;
  if (sourceChanged) {
    state.sqliteMessageSourceFile = logsDbFile;
    state.sqliteMessageCursorId = 0;
    dirty = true;
  }

  let cursorId = Number(state.sqliteMessageCursorId) || 0;
  const startupMinTsSec = Math.max(0, Math.floor((now - config.replaySeconds * 1000) / 1000));

  while (true) {
    let rows;
    try {
      rows = await querySqliteTimelineRows({
        logsDbFile,
        cursorId,
        minTsSec: cursorId > 0 ? 0 : startupMinTsSec,
      });
    } catch (error) {
      console.error(`[sqlite-timeline-scan-error] ${error.message}`);
      break;
    }

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const rowId = Number(row.id) || 0;
      if (rowId > cursorId) {
        cursorId = rowId;
      }

      const entry = buildSqliteTimelineEntry({
        row,
        config,
        runtime,
      });
      if (!entry) {
        continue;
      }

      dirty =
        recordTimelineEntry({
          config,
          runtime,
          state,
          entry,
        }) || dirty;

      // Also record Codex assistant_final as a history item so it appears
      // in the completed inbox and supports reply (replaces "completion").
      if (entry.kind === "assistant_final") {
        dirty =
          recordHistoryItem({
            config,
            runtime,
            state,
            item: {
              stableId: entry.stableId,
              kind: entry.kind,
              threadId: entry.threadId,
              title: entry.title,
              threadLabel: entry.threadLabel,
              summary: entry.summary,
              messageText: entry.messageText,
              createdAtMs: entry.createdAtMs,
              readOnly: true,
              provider: "codex",
            },
          }) || dirty;
      }
    }

    state.sqliteMessageCursorId = cursorId;
    dirty = true;

    if (rows.length < SQLITE_COMPLETION_BATCH_SIZE) {
      break;
    }
  }

  return dirty;
}

async function processHistoryTimelineFile({ config, runtime, state, now }) {
  const historyFile = cleanText(config.historyFile || "");
  if (!historyFile) {
    return false;
  }

  try {
    await fs.access(historyFile);
  } catch {
    return false;
  }

  let fileState = runtime.historyFileState;
  let dirty = false;
  if (cleanText(fileState.sourceFile) !== historyFile) {
    fileState = {
      offset: 0,
      remainder: "",
      skipPartialLine: false,
      startupCutoffTs: 0,
      sourceFile: historyFile,
    };
    runtime.historyFileState = fileState;
    state.historyFileSourceFile = historyFile;
    state.historyFileOffset = 0;
    dirty = true;
  }

  let stat;
  try {
    stat = await fs.stat(historyFile);
  } catch {
    return dirty;
  }

  if (fileState.offset <= 0) {
    const shouldReplayRecent = stat.mtimeMs >= now - config.replaySeconds * 1000;
    fileState.offset = shouldReplayRecent ? Math.max(0, stat.size - config.maxReadBytes) : stat.size;
    fileState.startupCutoffTs = shouldReplayRecent ? Math.floor((now - config.replaySeconds * 1000) / 1000) : 0;
    fileState.skipPartialLine = shouldReplayRecent && stat.size > config.maxReadBytes;
    state.historyFileOffset = fileState.offset;
    dirty = true;
  }

  if (stat.size < fileState.offset) {
    fileState.offset = 0;
    fileState.remainder = "";
    fileState.skipPartialLine = false;
  }

  if (stat.size === fileState.offset) {
    return dirty;
  }

  if (stat.size - fileState.offset > config.maxReadBytes) {
    fileState.offset = Math.max(0, stat.size - config.maxReadBytes);
    fileState.remainder = "";
    fileState.skipPartialLine = true;
    state.historyFileOffset = fileState.offset;
    dirty = true;
  }

  const length = stat.size - fileState.offset;
  const handle = await fs.open(historyFile, "r");
  const buffer = Buffer.alloc(length);
  try {
    await handle.read(buffer, 0, length, fileState.offset);
  } finally {
    await handle.close();
  }

  const chunk = buffer.toString("utf8");
  const merged = fileState.remainder + chunk;
  const lines = merged.split("\n");
  fileState.remainder = lines.pop() ?? "";
  if (fileState.skipPartialLine && lines.length > 0) {
    lines.shift();
    fileState.skipPartialLine = false;
  }
  fileState.offset = stat.size;
  state.historyFileOffset = fileState.offset;
  state.historyFileSourceFile = historyFile;
  dirty = true;

  for (const rawLine of lines) {
    if (!rawLine.trim()) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(rawLine);
    } catch {
      continue;
    }

    const entry = buildHistoryUserTimelineEntry({
      record,
      runtime,
      config,
    });
    if (!entry) {
      continue;
    }
    if (fileState.startupCutoffTs && Math.floor(Number(entry.createdAtMs || 0) / 1000) < fileState.startupCutoffTs) {
      continue;
    }

    dirty =
      recordTimelineEntry({
        config,
        runtime,
        state,
        entry,
      }) || dirty;
  }

  fileState.startupCutoffTs = 0;
  return dirty;
}

async function backfillRecentTimelineEntryImages({ config, runtime, state }) {
  const candidates = runtime.recentTimelineEntries.filter(
    (entry) =>
      cleanText(entry?.kind || "") === "user_message" &&
      cleanText(entry?.threadId || "") &&
      normalizeTimelineImagePaths(entry?.imagePaths ?? []).length === 0
  );
  if (candidates.length === 0 || !Array.isArray(runtime.knownFiles) || runtime.knownFiles.length === 0) {
    return false;
  }

  const fileCache = new Map();
  let changed = false;
  const nextEntries = runtime.recentTimelineEntries.map((entry) => ({ ...entry }));

  for (let index = 0; index < nextEntries.length; index += 1) {
    const entry = nextEntries[index];
    if (
      cleanText(entry?.kind || "") !== "user_message" ||
      !cleanText(entry?.threadId || "") ||
      normalizeTimelineImagePaths(entry?.imagePaths ?? []).length > 0
    ) {
      continue;
    }

    const hydrated = await hydrateTimelineEntryImagesFromRollout({
      config,
      runtime,
      entry,
      fileCache,
    });
    if (!hydrated) {
      continue;
    }

    nextEntries[index] = hydrated;
    changed = true;
  }

  if (!changed) {
    return false;
  }

  const normalized = normalizeTimelineEntries(nextEntries, config.maxTimelineEntries);
  runtime.recentTimelineEntries = normalized;
  state.recentTimelineEntries = normalized;
  return true;
}

async function backfillPersistedTimelineImagePaths({ config, runtime, state }) {
  let changed = false;
  const nextEntries = [];
  for (const entry of runtime.recentTimelineEntries) {
    const nextImagePaths = await normalizePersistedTimelineImagePaths({
      config,
      state,
      imagePaths: entry?.imagePaths ?? [],
    });
    if (JSON.stringify(nextImagePaths) !== JSON.stringify(normalizeTimelineImagePaths(entry?.imagePaths ?? []))) {
      changed = true;
      nextEntries.push({
        ...entry,
        imagePaths: nextImagePaths,
      });
      continue;
    }
    nextEntries.push(entry);
  }

  if (!changed) {
    return false;
  }

  const normalized = normalizeTimelineEntries(nextEntries, config.maxTimelineEntries);
  runtime.recentTimelineEntries = normalized;
  state.recentTimelineEntries = normalized;
  return true;
}

// Walk ~/.viveworker/moltbook-inbox/ on startup and synthesize readOnly
// history entries for items the CLI / reconcile marked as replied or skipped.
// Without this, an inbox item that was handled before the history hooks
// existed — or that was resolved purely via the CLI path, which doesn't touch
// the bridge's in-memory maps — never makes it into `recentHistoryItems` and
// so never appears in the completed tab.  We match the same stableId / token
// scheme as the live push (sourceId = `comment:<commentId>`) so a future
// watcher push for the same commentId replaces this entry cleanly rather than
// creating a duplicate.
async function backfillMoltbookInboxHistory({ config, runtime, state }) {
  let changed = false;
  try {
    const inboxItems = await listInboxItems();
    for (const inbox of inboxItems) {
      const status = String(inbox?.status || "").toLowerCase();
      if (status !== "replied" && status !== "skipped") continue;
      const commentId = String(inbox?.commentId || "");
      if (!commentId) continue;
      const sourceId = `comment:${commentId}`;
      const stableId = `moltbook_reply:${sourceId}`;
      if (runtime.recentHistoryItems.some((entry) => entry.stableId === stableId)) continue;
      const token = historyToken(`moltbook:${sourceId}`);
      const createdAtMs = Number(Date.parse(inbox.updatedAt || inbox.createdAt || "")) || Date.now();
      const postTitle = cleanText(inbox.postTitle || "");
      const contextText = cleanText(inbox.contextText || "");
      const replyText = cleanText(inbox.replyText || "");
      const messageText = status === "replied" ? (replyText || contextText) : contextText;
      const summary = (status === "replied" ? (replyText || contextText) : contextText).slice(0, 160);
      const titlePrefix = status === "replied" ? "replied" : "skipped";
      const title = postTitle ? `${titlePrefix} → ${postTitle}` : (status === "replied" ? "Moltbook reply" : "Moltbook skipped");
      const recorded = recordHistoryItem({
        config,
        runtime,
        state,
        item: {
          stableId,
          token,
          kind: "moltbook_reply",
          threadId: "moltbook",
          threadLabel: postTitle || "Moltbook",
          title,
          summary,
          messageText,
          createdAtMs,
          readOnly: true,
          provider: "moltbook",
        },
      });
      if (recorded) changed = true;
    }
  } catch (error) {
    console.error(`[moltbook-inbox-backfill] ${error.message}`);
    return false;
  }
  if (changed) {
    console.log(`[moltbook-inbox-backfill] Synthesized history entries for resolved inbox items`);
  }
  return changed;
}

async function backfillRecentTimelineEntryDiffs({ config, runtime, state }) {
  const nextEntries = runtime.recentTimelineEntries.map((entry) => ({ ...entry }));
  let changed = false;

  for (let index = 0; index < nextEntries.length; index += 1) {
    const entry = nextEntries[index];
    if (
      cleanText(entry?.kind || "") !== "file_event" ||
      !["write", "create"].includes(normalizeTimelineFileEventType(entry?.fileEventType || "")) ||
      entry?.diffAvailable === true
    ) {
      continue;
    }

    const callId = fileEventCallIdFromStableId(entry?.stableId || "");
    const rolloutFilePath = findRolloutFileForThread(runtime, entry?.threadId || "");
    if (!callId || !rolloutFilePath) {
      continue;
    }

    let fileState = runtime.fileStates.get(rolloutFilePath);
    if (!fileState) {
      fileState = {
        offset: 0,
        remainder: "",
        threadId: cleanText(entry?.threadId || ""),
        cwd: await findRolloutThreadCwd(runtime, entry?.threadId || ""),
        applyPatchInputsByCallId: new Map(),
        startupCutoffMs: 0,
        skipPartialLine: false,
      };
      runtime.fileStates.set(rolloutFilePath, fileState);
    }

    const nextDiff = await buildFileEventDiff({
      fileState,
      callId,
      fileRefs: entry?.fileRefs ?? [],
      fileEventType: entry?.fileEventType ?? "",
      rolloutFilePath,
    });
    if (!nextDiff.diffAvailable) {
      continue;
    }

    nextEntries[index] = normalizeTimelineEntry({
      ...entry,
      diffText: nextDiff.diffText,
      diffSource: nextDiff.diffSource,
      diffAvailable: nextDiff.diffAvailable,
      diffAddedLines: nextDiff.diffAddedLines,
      diffRemovedLines: nextDiff.diffRemovedLines,
    });
    changed = true;
  }

  if (!changed) {
    return false;
  }

  const normalized = normalizeTimelineEntries(nextEntries, config.maxTimelineEntries);
  runtime.recentTimelineEntries = normalized;
  state.recentTimelineEntries = normalized;
  return true;
}

function backfillInterruptedTimelineEntries({ config, runtime, state }) {
  const locale = normalizeLocale(config.defaultLocale) || DEFAULT_LOCALE;
  let changed = false;
  const nextEntries = runtime.recentTimelineEntries.map((entry) => {
    const nextMessageText = normalizeTimelineMessageText(entry?.messageText ?? "", locale);
    const nextSummary = normalizeNotificationText(entry?.summary ?? "", locale) || formatNotificationBody(nextMessageText, 180);
    if (nextMessageText === (entry?.messageText ?? "") && nextSummary === (entry?.summary ?? "")) {
      return entry;
    }
    changed = true;
    return {
      ...entry,
      messageText: nextMessageText,
      summary: nextSummary,
    };
  });

  if (!changed) {
    return false;
  }

  runtime.recentTimelineEntries = nextEntries;
  state.recentTimelineEntries = nextEntries;
  return true;
}

async function hydrateTimelineEntryImagesFromRollout({ config, runtime, entry, fileCache }) {
  const threadId = cleanText(entry?.threadId || "");
  if (!threadId) {
    return null;
  }

  const rolloutFile = findRolloutFileForThread(runtime, threadId);
  if (!rolloutFile) {
    return null;
  }

  let recentMessages = fileCache.get(rolloutFile);
  if (!recentMessages) {
    recentMessages = await readRecentRolloutUserMessagesWithImages({
      filePath: rolloutFile,
      maxBytes: Math.max(config.maxReadBytes * 4, 1024 * 1024),
    });
    fileCache.set(rolloutFile, recentMessages);
  }

  if (!recentMessages.length) {
    return null;
  }

  const entryCreatedAtMs = Number(entry?.createdAtMs) || 0;
  const entryMessageText = normalizeTimelineMessageText(entry?.messageText ?? "");
  let bestMatch = null;

  for (const candidate of recentMessages) {
    const candidateCreatedAtMs = Number(candidate?.createdAtMs) || 0;
    if (entryCreatedAtMs && candidateCreatedAtMs && Math.abs(candidateCreatedAtMs - entryCreatedAtMs) > 15_000) {
      continue;
    }
    if (entryMessageText && normalizeTimelineMessageText(candidate?.messageText ?? "") !== entryMessageText) {
      continue;
    }

    if (!bestMatch) {
      bestMatch = candidate;
      continue;
    }

    const previousDiff = Math.abs((Number(bestMatch.createdAtMs) || 0) - entryCreatedAtMs);
    const nextDiff = Math.abs(candidateCreatedAtMs - entryCreatedAtMs);
    if (nextDiff < previousDiff) {
      bestMatch = candidate;
    }
  }

  if (!bestMatch || normalizeTimelineImagePaths(bestMatch.imagePaths).length === 0) {
    return null;
  }

  const nextMessageText = normalizeTimelineMessageText(bestMatch.messageText ?? entryMessageText);
  return normalizeTimelineEntry({
    ...entry,
    messageText: nextMessageText,
    summary: formatNotificationBody(nextMessageText, 180) || cleanText(entry.summary || ""),
    imagePaths: bestMatch.imagePaths,
  });
}

function findRolloutFileForThread(runtime, threadId) {
  const normalizedThreadId = cleanText(threadId || "");
  if (!normalizedThreadId) {
    return "";
  }
  return (
    (Array.isArray(runtime.knownFiles) ? runtime.knownFiles : []).find(
      (filePath) => extractThreadIdFromRolloutPath(filePath) === normalizedThreadId
    ) || ""
  );
}

async function readRecentRolloutUserMessagesWithImages({ filePath, maxBytes }) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return [];
  }

  const readLength = Math.max(0, Math.min(Number(maxBytes) || 0, stat.size));
  const startOffset = Math.max(0, stat.size - readLength);
  let chunk = "";
  try {
    const handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(readLength);
    try {
      await handle.read(buffer, 0, readLength, startOffset);
    } finally {
      await handle.close();
    }
    chunk = buffer.toString("utf8");
  } catch {
    return [];
  }

  const lines = chunk.split("\n");
  if (startOffset > 0 && lines.length > 0) {
    lines.shift();
  }

  const matches = [];
  for (const rawLine of lines) {
    if (!rawLine.trim()) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(rawLine);
    } catch {
      continue;
    }

    const extracted = extractRolloutUserMessage(record);
    if (!extracted || normalizeTimelineImagePaths(extracted.imagePaths).length === 0) {
      continue;
    }

    matches.push({
      createdAtMs: Date.parse(record.timestamp ?? "") || 0,
      messageText: extracted.messageText,
      imagePaths: extracted.imagePaths,
    });
  }

  return matches;
}

async function querySqliteTimelineRows({ logsDbFile, cursorId, minTsSec = 0 }) {
  const conditions = [
    `id > ${Math.max(0, Number(cursorId) || 0)}`,
    `target = 'codex_api::endpoint::responses_websocket'`,
    `feedback_log_body LIKE '%websocket event: {"type":"response.output_item.done"%'`,
    `feedback_log_body LIKE '%"type":"message"%'`,
    `feedback_log_body LIKE '%"role":"assistant"%'`,
  ];

  if (Number(minTsSec) > 0) {
    conditions.push(`ts >= ${Math.max(0, Number(minTsSec) || 0)}`);
  }

  const sql = `
    SELECT id, ts, thread_id, feedback_log_body
    FROM logs
    WHERE ${conditions.join("\n      AND ")}
    ORDER BY id ASC
    LIMIT ${SQLITE_COMPLETION_BATCH_SIZE}
  `;

  return runSqliteJsonQuery(logsDbFile, sql);
}

function buildSqliteTimelineEntry({ row, config, runtime }) {
  const body = String(row?.feedback_log_body ?? "");
  const marker = "websocket event: ";
  const markerIndex = body.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(body.slice(markerIndex + marker.length));
  } catch {
    return null;
  }

  if (payload?.type !== "response.output_item.done") {
    return null;
  }

  const item = isPlainObject(payload.item) ? payload.item : null;
  if (!item || item.type !== "message" || item.role !== "assistant") {
    return null;
  }

  const phase = cleanText(item.phase || "");
  const kind =
    phase === "commentary"
      ? "assistant_commentary"
      : phase === "final_answer"
        ? "assistant_final"
        : "";
  if (!kind) {
    return null;
  }

  const threadId = cleanText(row.thread_id || extractThreadIdFromLogBody(body));
  if (!threadId) {
    return null;
  }

  const messageText = extractRolloutMessageText(item.content);
  if (!messageText) {
    return null;
  }
  const ambientSuggestionsEnvelope = kind === "assistant_final" ? parseAmbientSuggestionsEnvelope(messageText) : null;
  if (ambientSuggestionsEnvelope?.type === "metadata") {
    return null;
  }
  const ambientSuggestions = ambientSuggestionsEnvelope?.type === "suggestions"
    ? ambientSuggestionsEnvelope.suggestions
    : null;
  const entryKind = ambientSuggestions ? "ambient_suggestions" : kind;
  const entryMessageText = ambientSuggestions
    ? ambientSuggestionsMessageText(config.defaultLocale, ambientSuggestions)
    : messageText;
  const entrySummary = ambientSuggestions
    ? ambientSuggestionsSummary(config.defaultLocale, ambientSuggestions)
    : formatNotificationBody(messageText, 180) || messageText;

  const createdAtMs = Math.max(0, Number(row.ts) || 0) * 1000 || Date.now();
  const threadLabel = getNativeThreadLabel({
    runtime,
    conversationId: threadId,
    cwd: "",
  });
  const stableId = messageTimelineStableId(entryKind, threadId, item.id || row.id, entryMessageText, createdAtMs);

  return normalizeTimelineEntry({
    stableId,
    token: historyToken(stableId),
    kind: entryKind,
    threadId,
    threadLabel,
    title: ambientSuggestions ? kindTitle(config.defaultLocale, entryKind) : threadLabel || kindTitle(config.defaultLocale, entryKind),
    summary: entrySummary,
    messageText: entryMessageText,
    ...(ambientSuggestions ? { suggestions: ambientSuggestions } : {}),
    createdAtMs,
    readOnly: true,
  });
}

function extractRolloutUserMessage(record) {
  const payload = isPlainObject(record?.payload) ? record.payload : null;
  if (!payload) {
    return null;
  }

  if (record?.type === "event_msg" && payload.type === "user_message") {
    const messageText = normalizeTimelineMessageText(payload.message ?? "");
    const imagePaths = normalizeTimelineImagePaths(payload.local_images ?? payload.localImagePaths ?? []);
    if (!messageText && imagePaths.length === 0) {
      return null;
    }
    return {
      itemId: cleanText(payload.turn_id || record.timestamp || ""),
      messageText,
      imagePaths,
    };
  }

  if (payload.type !== "message" || payload.role !== "user") {
    return null;
  }

  if (rolloutContentHasImages(payload.content)) {
    // Prefer the richer event_msg.user_message entry when images are attached.
    return null;
  }

  const messageText = extractRolloutMessageText(payload.content);
  if (!messageText) {
    return null;
  }

  return {
    itemId: cleanText(payload.id || record.timestamp || ""),
    messageText,
    imagePaths: [],
  };
}

function extractTimestampPrefixFromImagePath(filePath) {
  const match = path.basename(cleanText(filePath || "")).match(/^(\d{10,})-/u);
  return match ? Number(match[1]) || 0 : 0;
}

async function listReplyUploadFiles(config) {
  try {
    const entries = await fs.readdir(config.replyUploadsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const filePath = path.join(config.replyUploadsDir, entry.name);
        return {
          filePath,
          extension: path.extname(entry.name).toLowerCase(),
          ts: extractTimestampPrefixFromImagePath(entry.name),
        };
      })
      .filter((entry) => entry.ts > 0);
  } catch {
    return [];
  }
}

async function findReplyUploadFallback(config, sourcePath, usedPaths = new Set()) {
  const targetTs = extractTimestampPrefixFromImagePath(sourcePath);
  const targetExtension = path.extname(cleanText(sourcePath || "")).toLowerCase();
  if (!targetTs) {
    return "";
  }

  const uploads = await listReplyUploadFiles(config);
  const candidates = uploads
    .filter((entry) => !usedPaths.has(entry.filePath))
    .filter((entry) => !targetExtension || entry.extension === targetExtension)
    .filter((entry) => Math.abs(entry.ts - targetTs) <= 60_000)
    .sort((left, right) => Math.abs(left.ts - targetTs) - Math.abs(right.ts - targetTs));

  return candidates[0]?.filePath || "";
}

async function copyTimelineAttachmentToPersistentDir(config, sourcePath) {
  const normalizedSourcePath = resolvePath(cleanText(sourcePath || ""));
  if (!normalizedSourcePath) {
    return "";
  }

  await fs.mkdir(config.timelineAttachmentsDir, { recursive: true });
  const extension = path.extname(normalizedSourcePath) || ".img";
  const destinationPath = path.join(
    config.timelineAttachmentsDir,
    `${Date.now()}-${crypto.randomUUID()}${extension}`
  );
  try {
    await fs.copyFile(normalizedSourcePath, destinationPath);
    return destinationPath;
  } catch (error) {
    console.warn(`[timeline-image-copy-skipped] ${error?.message || error}`);
    return "";
  }
}

async function normalizePersistedTimelineImagePaths({ config, state, imagePaths = [] }) {
  const normalizedImagePaths = normalizeTimelineImagePaths(imagePaths);
  if (normalizedImagePaths.length === 0) {
    return [];
  }

  const aliases = isPlainObject(state.timelineImagePathAliases) ? state.timelineImagePathAliases : (state.timelineImagePathAliases = {});
  const usedFallbacks = new Set();
  const nextPaths = [];

  for (const rawPath of normalizedImagePaths) {
    const normalizedPath = cleanText(rawPath || "");
    if (!normalizedPath) {
      continue;
    }

    const aliasedPath = cleanText(aliases[normalizedPath] || "");
    if (aliasedPath) {
      try {
        await fs.access(aliasedPath);
        nextPaths.push(aliasedPath);
        continue;
      } catch {
        // Fall through and repair below.
      }
    }

    let existingSourcePath = normalizedPath;
    try {
      await fs.access(existingSourcePath);
    } catch {
      existingSourcePath = await findReplyUploadFallback(config, normalizedPath, usedFallbacks);
      if (!existingSourcePath) {
        continue;
      }
      usedFallbacks.add(existingSourcePath);
    }

    let persistentPath = existingSourcePath;
    if (!existingSourcePath.startsWith(`${config.timelineAttachmentsDir}${path.sep}`)) {
      persistentPath = await copyTimelineAttachmentToPersistentDir(config, existingSourcePath) || existingSourcePath;
    }

    aliases[normalizedPath] = persistentPath;
    nextPaths.push(persistentPath);
  }

  return normalizeTimelineImagePaths(nextPaths);
}

function buildRolloutUserTimelineEntry({ record, fileState, runtime }) {
  const extracted = extractRolloutUserMessage(record);
  if (!extracted) {
    return null;
  }

  const threadId = cleanText(fileState.threadId || "");
  if (!threadId) {
    return null;
  }

  const createdAtMs = Date.parse(record.timestamp ?? "") || Date.now();
  const stableId = messageTimelineStableId(
    "user_message",
    threadId,
    extracted.itemId,
    extracted.messageText,
    createdAtMs
  );
  const threadLabel = getNativeThreadLabel({
    runtime,
    conversationId: threadId,
    cwd: fileState.cwd || "",
  });

  return normalizeTimelineEntry({
    stableId,
    token: historyToken(stableId),
    kind: "user_message",
    threadId,
    threadLabel,
    title: threadLabel || kindTitle(DEFAULT_LOCALE, "user_message"),
    summary: formatNotificationBody(extracted.messageText, 180) || extracted.messageText,
    messageText: extracted.messageText,
    imagePaths: extracted.imagePaths,
    createdAtMs,
    readOnly: true,
  });
}

async function buildRolloutFileTimelineEntries({ config, record, fileState, runtime, rolloutFilePath = "" }) {
  if (!isPlainObject(record) || cleanText(record.type) !== "response_item") {
    return [];
  }

  const payload = isPlainObject(record.payload) ? record.payload : null;
  const payloadType = cleanText(payload?.type || "");
  const threadId = cleanText(fileState.threadId || "");
  if (!payload || !threadId) {
    return [];
  }

  const createdAtMs = Date.parse(record.timestamp ?? "") || Date.now();
  const callId = cleanText(payload.call_id || record.timestamp || "");
  const threadLabel = getNativeThreadLabel({
    runtime,
    conversationId: threadId,
    cwd: fileState.cwd || "",
  });

  if (payloadType === "custom_tool_call") {
    rememberApplyPatchInput(fileState, payload, createdAtMs);
    return [];
  }

  if (payloadType === "function_call_output") {
    const commandText = extractCommandLineFromFunctionOutput(payload.output ?? "");
    const fileRefs = extractReadFileRefsFromCommand(commandText);
    if (fileRefs.length === 0) {
      return [];
    }
    return [
      normalizeTimelineEntry({
        stableId: `file_event:read:${threadId}:${callId || historyToken(`${threadId}:${createdAtMs}:${fileRefs.join("|")}`)}`,
        token: historyToken(`file_event:read:${threadId}:${callId || createdAtMs}`),
        kind: "file_event",
        fileEventType: "read",
        threadId,
        threadLabel,
        title: fileEventTitle(DEFAULT_LOCALE, "read"),
        summary: "",
        fileRefs,
        createdAtMs,
        readOnly: true,
      }),
    ].filter(Boolean);
  }

  if (payloadType === "custom_tool_call_output") {
    const storedPatch = await findStoredApplyPatchInput({
      fileState,
      callId,
      rolloutFilePath,
    });
    const updates = extractUpdatedFileRefsByType(payload.output ?? "", storedPatch?.inputText || "");
    const entries = [];
    const createDiff = await buildFileEventDiff({
      fileState,
      callId,
      fileRefs: updates.create,
      fileEventType: "create",
      rolloutFilePath,
    });
    const writeDiff = await buildFileEventDiff({
      fileState,
      callId,
      fileRefs: updates.write,
      fileEventType: "write",
      previousFileRefs: [],
      rolloutFilePath,
    });
    const deleteDiff = await buildFileEventDiff({
      fileState,
      callId,
      fileRefs: updates.delete,
      fileEventType: "delete",
      previousFileRefs: [],
      rolloutFilePath,
    });
    const renameNewRefs = updates.rename.map((entry) => entry.newFileRef);
    const renameOldRefs = updates.rename.map((entry) => entry.oldFileRef);
    const renameDiff = await buildFileEventDiff({
      fileState,
      callId,
      fileRefs: renameNewRefs,
      fileEventType: "rename",
      previousFileRefs: renameOldRefs,
      rolloutFilePath,
    });

    if (updates.create.length > 0) {
      entries.push(
        normalizeTimelineEntry({
          stableId: `file_event:create:${threadId}:${callId || historyToken(`${threadId}:${createdAtMs}:${updates.create.join("|")}`)}`,
          token: historyToken(`file_event:create:${threadId}:${callId || createdAtMs}`),
          kind: "file_event",
          fileEventType: "create",
          threadId,
          threadLabel,
          title: fileEventTitle(DEFAULT_LOCALE, "create"),
          summary: "",
          fileRefs: updates.create,
          diffText: createDiff.diffText,
          diffSource: createDiff.diffSource,
          diffAvailable: createDiff.diffAvailable,
          diffAddedLines: createDiff.diffAddedLines,
          diffRemovedLines: createDiff.diffRemovedLines,
          createdAtMs,
          cwd: fileState.cwd || "",
          readOnly: true,
        })
      );
    }

    if (updates.write.length > 0) {
      entries.push(
        normalizeTimelineEntry({
          stableId: `file_event:write:${threadId}:${callId || historyToken(`${threadId}:${createdAtMs}:${updates.write.join("|")}`)}`,
          token: historyToken(`file_event:write:${threadId}:${callId || createdAtMs}`),
          kind: "file_event",
          fileEventType: "write",
          threadId,
          threadLabel,
          title: fileEventTitle(DEFAULT_LOCALE, "write"),
          summary: "",
          fileRefs: updates.write,
          diffText: writeDiff.diffText,
          diffSource: writeDiff.diffSource,
          diffAvailable: writeDiff.diffAvailable,
          diffAddedLines: writeDiff.diffAddedLines,
          diffRemovedLines: writeDiff.diffRemovedLines,
          createdAtMs,
          cwd: fileState.cwd || "",
          readOnly: true,
        })
      );
    }

    if (updates.delete.length > 0) {
      entries.push(
        normalizeTimelineEntry({
          stableId: `file_event:delete:${threadId}:${callId || historyToken(`${threadId}:${createdAtMs}:${updates.delete.join("|")}`)}`,
          token: historyToken(`file_event:delete:${threadId}:${callId || createdAtMs}`),
          kind: "file_event",
          fileEventType: "delete",
          threadId,
          threadLabel,
          title: fileEventTitle(DEFAULT_LOCALE, "delete"),
          summary: "",
          fileRefs: updates.delete,
          diffText: deleteDiff.diffText,
          diffSource: deleteDiff.diffSource,
          diffAvailable: deleteDiff.diffAvailable,
          diffAddedLines: deleteDiff.diffAddedLines,
          diffRemovedLines: deleteDiff.diffRemovedLines,
          createdAtMs,
          cwd: fileState.cwd || "",
          readOnly: true,
        })
      );
    }

    if (updates.rename.length > 0) {
      entries.push(
        normalizeTimelineEntry({
          stableId: `file_event:rename:${threadId}:${callId || historyToken(`${threadId}:${createdAtMs}:${renameOldRefs.join("|")}=>${renameNewRefs.join("|")}`)}`,
          token: historyToken(`file_event:rename:${threadId}:${callId || createdAtMs}`),
          kind: "file_event",
          fileEventType: "rename",
          threadId,
          threadLabel,
          title: fileEventTitle(DEFAULT_LOCALE, "rename"),
          summary: "",
          fileRefs: renameNewRefs,
          previousFileRefs: renameOldRefs,
          diffText: renameDiff.diffText,
          diffSource: renameDiff.diffSource,
          diffAvailable: renameDiff.diffAvailable,
          diffAddedLines: renameDiff.diffAddedLines,
          diffRemovedLines: renameDiff.diffRemovedLines,
          createdAtMs,
          cwd: fileState.cwd || "",
          readOnly: true,
        })
      );
    }

    if (callId && fileState.applyPatchInputsByCallId instanceof Map) {
      fileState.applyPatchInputsByCallId.delete(callId);
    }

    return entries.filter(Boolean);
  }

  return [];
}

function buildHistoryUserTimelineEntry({ record, runtime, config }) {
  if (!isPlainObject(record)) {
    return null;
  }

  const threadId = cleanText(record.session_id || record.sessionId || "");
  const messageText = normalizeTimelineMessageText(record.text ?? "");
  if (!threadId || !messageText) {
    return null;
  }
  if (!runtime.threadStates.has(threadId) && !runtime.sessionIndex.has(threadId) && !runtime.rolloutThreadLabels.has(threadId)) {
    return null;
  }

  const createdAtMs = Math.max(0, Number(record.ts) || 0) * 1000 || Date.now();
  const stableId = messageTimelineStableId("user_message", threadId, record.id || record.ts, messageText, createdAtMs);
  const threadLabel = getNativeThreadLabel({
    runtime,
    conversationId: threadId,
    cwd: "",
  });

  return normalizeTimelineEntry({
    stableId,
    token: historyToken(stableId),
    kind: "user_message",
    threadId,
    threadLabel,
    title: threadLabel || kindTitle(config.defaultLocale, "user_message"),
    summary: formatNotificationBody(messageText, 180) || messageText,
    messageText,
    createdAtMs,
    readOnly: true,
  });
}

async function processScannedEvent({ config, runtime, state, event }) {
  if (!event || state.seenEvents[event.id]) {
    return false;
  }

  let dirty = false;

  if (event.kind === "task_complete") {
    attachCompletionDetails({ config, runtime, event });
  } else if (event.kind === "plan_ready") {
    attachPlanDetails({ config, runtime, event });
  }

  dirty =
    recordHistoryItem({
      config,
      runtime,
      state,
      item: historyItemFromEvent(event),
    }) || dirty;

  const isAmbientSuggestionsCompletion =
    event.kind === "task_complete" &&
    isAmbientSuggestionsMetadataPayload(normalizeLongText(event.detailText || event.message || ""));

  if (event.kind === "task_complete" && !isAmbientSuggestionsCompletion) {
    dirty =
      (await deliverWebPushItem({
        config,
        state,
        kind: "completion",
        tab: "inbox",
        subtab: "completed",
        token: historyToken(event.id),
        stableId: event.id,
        title: event.title,
        body: event.detailText || event.message,
        buildLocalizedContent: ({ locale }) => ({
          title: formatLocalizedTitle(locale, "server.title.complete", event.threadLabel),
          body: event.detailText || event.message,
        }),
      })) || dirty;
  }

  if (config.enableNtfy && !isAmbientSuggestionsCompletion) {
    try {
      await publishNtfy(config, event);
    } catch (error) {
      console.error(`[notify-error] ${event.kind} | ${event.title} | ${error.message}`);
    }
  }

  state.seenEvents[event.id] = event.timestampMs || Date.now();
  trimSeenEvents(state.seenEvents, config.maxSeenEvents);
  return true;
}

async function querySqliteCompletionRows({ logsDbFile, cursorId, minTsSec = 0 }) {
  const conditions = [
    `id > ${Math.max(0, Number(cursorId) || 0)}`,
    `target = 'codex_api::endpoint::responses_websocket'`,
    `feedback_log_body LIKE '%websocket event: {"type":"response.output_item.done"%'`,
    `feedback_log_body LIKE '%"type":"message"%'`,
    `feedback_log_body LIKE '%"role":"assistant"%'`,
    `feedback_log_body LIKE '%"phase":"final_answer"%'`,
  ];

  if (Number(minTsSec) > 0) {
    conditions.push(`ts >= ${Math.max(0, Number(minTsSec) || 0)}`);
  }

  const sql = `
    SELECT id, ts, thread_id, feedback_log_body
    FROM logs
    WHERE ${conditions.join("\n      AND ")}
    ORDER BY id ASC
    LIMIT ${SQLITE_COMPLETION_BATCH_SIZE}
  `;

  return runSqliteJsonQuery(logsDbFile, sql);
}

async function runSqliteJsonQuery(dbFile, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("sqlite3", ["-json", dbFile, sql], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(cleanText(stderr) || `sqlite3-exit-${code}`));
        return;
      }
      if (!cleanText(stdout)) {
        resolve([]);
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch (error) {
        reject(new Error(`sqlite-json-parse-failed: ${error.message}`));
      }
    });
  });
}

function buildSqliteCompletionEvent({ row, config, runtime }) {
  const body = String(row?.feedback_log_body ?? "");
  const marker = "websocket event: ";
  const markerIndex = body.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(body.slice(markerIndex + marker.length));
  } catch {
    return null;
  }

  if (payload?.type !== "response.output_item.done") {
    return null;
  }

  const item = isPlainObject(payload.item) ? payload.item : null;
  if (!item || item.type !== "message" || item.role !== "assistant" || item.phase !== "final_answer") {
    return null;
  }

  const threadId = cleanText(row.thread_id || extractThreadIdFromLogBody(body));
  const turnId = cleanText(extractTurnIdFromLogBody(body) || item.id || row.id);
  if (!threadId || !turnId) {
    return null;
  }

  const outputTexts = Array.isArray(item.content)
    ? item.content
        .map((entry) => (isPlainObject(entry) && entry.type === "output_text" ? normalizeLongText(entry.text ?? "") : ""))
        .filter(Boolean)
    : [];
  const detailText = formatCompletionDetailText(outputTexts.join("\n\n"), config.defaultLocale);
  const message = formatNotificationBody(detailText, config.completionDetailThresholdChars) || t(config.defaultLocale, "server.message.taskFinished");
  const threadLabel = getNativeThreadLabel({
    runtime,
    conversationId: threadId,
    cwd: "",
  });

  return {
    id: `task_complete:${threadId}:${turnId}`,
    kind: "task_complete",
    timestampMs: Math.max(0, Number(row.ts) || 0) * 1000 || Date.now(),
    title: formatTitle(config.completeTitle, threadLabel),
    threadLabel,
    message,
    detailText,
    threadId,
    turnId,
    priority: config.completePriority,
    tags: config.completeTags,
    clickUrl: config.clickUrl,
  };
}

function extractThreadIdFromLogBody(body) {
  return (
    String(body || "").match(/thread(?:\.id|_id)=([0-9a-f-]{36})/iu)?.[1] ??
    String(body || "").match(/conversation\.id=([0-9a-f-]{36})/iu)?.[1] ??
    ""
  );
}

function extractTurnIdFromLogBody(body) {
  return String(body || "").match(/turn(?:\.id|_id)=([0-9a-f-]{36})/iu)?.[1] ?? "";
}

function buildRolloutEvent({ record, filePath, fileState, sessionIndex, config, runtime, state }) {
  const timestampMs = Date.parse(record.timestamp ?? "") || Date.now();
  const threadId =
    record.payload?.thread_id ??
    record.payload?.threadId ??
    fileState.threadId ??
    extractThreadIdFromRolloutPath(filePath);
  const threadName = getThreadName(sessionIndex, runtime.rolloutThreadLabels, threadId, fileState.cwd, filePath);
  const context = describeContext({ threadName, cwd: fileState.cwd, filePath });

  if (record.type === "event_msg" && record.payload?.type === "item_completed" && (config.notifyPlans || config.webUiEnabled)) {
    const item = record.payload.item;
    if (item?.type === "Plan") {
      const turnId = cleanText(record.payload.turn_id ?? record.payload.turnId ?? "");
      if (shouldSuppressPlanReadyEvent({ runtime, state, threadId, turnId })) {
        console.log(`[plan-ready-suppressed] ${planTurnKey(threadId, turnId) || threadId || "unknown"}`);
        return null;
      }

      const planId = turnId || item.id || record.timestamp;
      const detailText = formatPlanDetailText(item.text ?? "", config.defaultLocale);
      const message = formatNotificationBody(detailText, config.completionDetailThresholdChars) || t(config.defaultLocale, "server.message.planReady");

      return {
        id: `plan_ready:${threadId ?? "unknown"}:${planId}`,
        kind: "plan_ready",
        timestampMs,
        title: formatTitle(config.planReadyTitle, context.threadLabel),
        threadLabel: context.threadLabel,
        message,
        detailText,
        threadId,
        turnId,
        priority: config.planPriority,
        tags: config.planTags,
      };
    }
  }

  if (record.type === "event_msg" && record.payload?.type === "task_complete" && (config.notifyCompletions || config.webUiEnabled)) {
    const turnId = record.payload.turn_id ?? record.payload.turnId ?? record.timestamp;
    const detailText = formatCompletionDetailText(record.payload.last_agent_message ?? "", config.defaultLocale);
    const message = formatNotificationBody(detailText, config.completionDetailThresholdChars) || t(config.defaultLocale, "server.message.taskFinished");

    return {
      id: `task_complete:${threadId ?? "unknown"}:${turnId}`,
      kind: "task_complete",
      timestampMs,
      title: formatTitle(config.completeTitle, context.threadLabel),
      threadLabel: context.threadLabel,
      message,
      detailText,
      priority: config.completePriority,
      tags: config.completeTags,
      clickUrl: config.clickUrl,
    };
  }

  if (
    !config.nativeApprovals &&
    record.type === "response_item" &&
    record.payload?.type === "function_call" &&
    config.notifyApprovals
  ) {
    const approval = extractLegacyApprovalRequest(record.payload);
    if (!approval) {
      return null;
    }

    const cmd = truncate(singleLine(approval.cmd ?? ""), config.maxCommandChars);
    const justification = truncate(cleanText(approval.justification ?? ""), config.maxJustificationChars);
    const message = formatMessage(
      [
        t(config.defaultLocale, "server.message.approveOnMac"),
        justification || t(config.defaultLocale, "server.message.approvalNeededInCodex", { provider: providerDisplayName(config.defaultLocale, "codex") }),
        cmd ? t(config.defaultLocale, "server.message.commandPrefix", { command: cmd }) : null,
        approval.extraCount > 0 ? t(config.defaultLocale, "server.message.extraApprovals", { count: approval.extraCount }) : null,
      ],
      1024
    );

    return {
      id: `approval_needed:${threadId ?? "unknown"}:${approval.eventId}`,
      kind: "approval_needed",
      timestampMs,
      title: formatTitle(config.approvalTitle, context.threadLabel),
      threadLabel: context.threadLabel,
      message,
      priority: config.approvalPriority,
      tags: config.approvalTags,
      clickUrl: config.clickUrl,
    };
  }

  return null;
}

function extractLegacyApprovalRequest(payload) {
  const name = payload.name ?? "";
  const args = safeJsonParse(payload.arguments);
  if (!args) {
    return null;
  }

  if (name === "exec_command" && args.sandbox_permissions === "require_escalated") {
    return {
      eventId: payload.call_id ?? payload.callId ?? payload.id ?? Date.now().toString(),
      cmd: args.cmd ?? "",
      justification: args.justification ?? "",
    };
  }

  if (name === "parallel" && Array.isArray(args.tool_uses)) {
    const matching = args.tool_uses.filter(
      (toolUse) => toolUse?.parameters?.sandbox_permissions === "require_escalated"
    );
    if (matching.length === 0) {
      return null;
    }

    const first = matching[0];
    return {
      eventId: payload.call_id ?? payload.callId ?? payload.id ?? Date.now().toString(),
      cmd: first?.parameters?.cmd ?? first?.recipient_name ?? "parallel tool call",
      justification: first?.parameters?.justification ?? "",
      extraCount: Math.max(0, matching.length - 1),
    };
  }

  return null;
}

async function syncNativeApprovals({ config, runtime, state, conversationId, previousRequests, nextRequests, sourceClientId }) {
  let stateChanged = false;
  if (sourceClientId) {
    runtime.threadOwnerClientIds.set(conversationId, sourceClientId);
  }

  const previousKeys = new Map(previousRequests.map((request) => [nativeRequestKey(conversationId, request.id), request]));
  const nextKeys = new Map(nextRequests.map((request) => [nativeRequestKey(conversationId, request.id), request]));

  for (const [requestKey, request] of nextKeys) {
    const existing = runtime.nativeApprovalsByRequestKey.get(requestKey);
    if (existing) {
      const changed = await refreshNativeApprovalFromRequest({
        config,
        runtime,
        conversationId,
        request,
        approval: existing,
      });
      const existingAutoPilotWriteCandidate =
        existing.kind === "file"
          ? maybeAutoApproveTrustedWriteCandidate({ runtime, state, approval: existing })
          : null;
      if (existingAutoPilotWriteCandidate) {
        try {
          await autoApproveTrustedWrite({
            config,
            runtime,
            state,
            approval: existing,
            candidate: existingAutoPilotWriteCandidate,
          });
          continue;
        } catch (error) {
          existing.resolved = false;
          existing.resolving = false;
          runtime.nativeApprovalsByRequestKey.set(requestKey, existing);
          runtime.nativeApprovalsByToken.set(existing.token, existing);
          console.error(`[auto-pilot-write-error] ${requestKey} | ${error.message}`);
        }
      }
      if (changed) {
        const fileKeys = isPlainObject(existing.rawParams) ? Object.keys(existing.rawParams).join(",") : "";
        console.log(
          `[native-approval-refresh] ${requestKey} | files=${normalizeTimelineFileRefs(existing.fileRefs ?? []).length} | diff=${existing.diffAvailable || Boolean(existing.diffText) ? "yes" : "no"} | keys=${fileKeys || "none"}`
        );
      }
      continue;
    }

    const approval = await createNativeApproval({
      config,
      runtime,
      conversationId,
      request,
    });
    if (!approval) {
      continue;
    }

    runtime.nativeApprovalsByRequestKey.set(requestKey, approval);
    runtime.nativeApprovalsByToken.set(approval.token, approval);

    const nativeAutoPilotMatch =
      approval.kind === "command"
        ? maybeAutoApproveTrustedRead({
            state,
            commandText: approval.rawParams?.command ?? approval.rawParams?.cmd ?? "",
            cwd: approval.rawParams?.cwd ?? approval.rawParams?.grantRoot ?? "",
            workspaceRoot: approval.rawParams?.grantRoot ?? approval.rawParams?.cwd ?? "",
          })
        : null;
    if (nativeAutoPilotMatch) {
      try {
        await autoApproveTrustedRead({
          config,
          runtime,
          state,
          approval,
          policyMatch: nativeAutoPilotMatch,
        });
        continue;
      } catch (error) {
        approval.resolved = false;
        approval.resolving = false;
        runtime.nativeApprovalsByRequestKey.set(requestKey, approval);
        runtime.nativeApprovalsByToken.set(approval.token, approval);
        console.error(`[auto-pilot-error] ${requestKey} | ${error.message}`);
      }
    }

    const nativeAutoPilotWriteCandidate =
      approval.kind === "file"
        ? maybeAutoApproveTrustedWriteCandidate({ runtime, state, approval })
        : null;
    if (nativeAutoPilotWriteCandidate) {
      try {
        await autoApproveTrustedWrite({
          config,
          runtime,
          state,
          approval,
          candidate: nativeAutoPilotWriteCandidate,
        });
        continue;
      } catch (error) {
        approval.resolved = false;
        approval.resolving = false;
        runtime.nativeApprovalsByRequestKey.set(requestKey, approval);
        runtime.nativeApprovalsByToken.set(approval.token, approval);
        console.error(`[auto-pilot-write-error] ${requestKey} | ${error.message}`);
      }
    }

    if (previousKeys.has(requestKey)) {
      const fileKeys = isPlainObject(approval.rawParams) ? Object.keys(approval.rawParams).join(",") : "";
      console.log(
        `[native-approval-recovered] ${requestKey} | files=${normalizeTimelineFileRefs(approval.fileRefs ?? []).length} | diff=${approval.diffAvailable || Boolean(approval.diffText) ? "yes" : "no"} | keys=${fileKeys || "none"}`
      );
      continue;
    }

    try {
      await publishNtfy(config, {
        kind: "native_approval",
        title: approval.title,
        message: formatNotificationBody(approval.messageText, config.completionDetailThresholdChars),
        priority: config.approvalPriority,
        tags: config.approvalTags,
        clickUrl: approval.reviewUrl,
        actions: buildNativeApprovalActions(approval.reviewUrl, config.defaultLocale),
      });
      const fileKeys = isPlainObject(approval.rawParams) ? Object.keys(approval.rawParams).join(",") : "";
      console.log(
        `[native-approval] ${requestKey} | ${approval.title} | files=${normalizeTimelineFileRefs(approval.fileRefs ?? []).length} | diff=${approval.diffAvailable || Boolean(approval.diffText) ? "yes" : "no"} | keys=${fileKeys || "none"}`
      );
    } catch (error) {
      console.error(`[native-approval-error] ${requestKey} | ${error.message}`);
    }

    stateChanged =
      await deliverWebPushItem({
        config,
        state,
        kind: "approval",
        tab: "inbox",
        subtab: "pending",
        token: approval.token,
        stableId: pendingApprovalStableId(approval),
        title: approval.title,
        body: approval.messageText,
        buildLocalizedContent: ({ locale }) => ({
          title: formatLocalizedTitle(locale, "server.title.approval", approval.threadLabel),
          body: approval.messageText,
        }),
      }) || stateChanged;
  }

  for (const requestKey of previousKeys.keys()) {
    if (nextKeys.has(requestKey)) {
      continue;
    }
    expireNativeApproval(runtime, requestKey);
  }

  if (stateChanged) {
    await saveState(config.stateFile, state);
  }
}

async function syncPlanImplementationRequests({
  config,
  runtime,
  state,
  conversationId,
  previousRequests,
  nextRequests,
  sourceClientId,
}) {
  let stateChanged = false;
  const now = Date.now();

  if (sourceClientId) {
    runtime.threadOwnerClientIds.set(conversationId, sourceClientId);
  }

  const previousPlans = new Map(
    previousRequests
      .filter((request) => request.method === "item/plan/requestImplementation")
      .map((request) => [nativeRequestKey(conversationId, request.id), request])
  );
  const nextPlans = new Map(
    nextRequests
      .filter((request) => request.method === "item/plan/requestImplementation")
      .map((request) => [nativeRequestKey(conversationId, request.id), request])
  );

  for (const [requestKey, request] of nextPlans) {
    const turnKey = planTurnKeyFromRequest(conversationId, request);
    const existingPlanRequest =
      runtime.planRequestsByRequestKey.get(requestKey) ?? runtime.planRequestsByTurnKey.get(turnKey) ?? null;
    let planRequest = existingPlanRequest;

    if (!planRequest && state.dismissedPlanRequests[requestKey]) {
      stateChanged = markPlanTurnSuppressed(state, turnKey, config.maxSeenEvents) || stateChanged;
      continue;
    }

    const hadExistingSession = Boolean(existingPlanRequest);
    const wasLiveRequestActive = existingPlanRequest?.isLiveRequestActive === true;
    const wasRecovered = !existingPlanRequest && previousPlans.has(requestKey);

    if (!planRequest) {
      planRequest = createPlanImplementationRequest({
        config,
        runtime,
        conversationId,
        request,
        now,
      });
      if (!planRequest) {
        continue;
      }
    } else {
      const previousRequestKey = planRequest.requestKey;
      updatePlanImplementationRequest({
        config,
        runtime,
        conversationId,
        request,
        planRequest,
        now,
      });
      if (previousRequestKey && previousRequestKey !== planRequest.requestKey) {
        runtime.planRequestsByRequestKey.delete(previousRequestKey);
      }
    }

    stateChanged = applyStoredPlanQuestionRequest(runtime, planRequest) || stateChanged;
    registerPlanImplementationRequest(runtime, planRequest);
    stateChanged = storePendingPlanRequest(state, planRequest) || stateChanged;
    stateChanged = markPlanTurnSuppressed(state, planRequest.turnKey, config.maxSeenEvents) || stateChanged;
    if (!planRequest.resolved) {
      stateChanged = markPlanTurnActive(state, planRequest.turnKey, config.maxSeenEvents) || stateChanged;
    }

    const shouldNotify = !planRequest.resolved && !wasRecovered && (!hadExistingSession || !wasLiveRequestActive);
    if (shouldNotify) {
      try {
        await publishNtfy(config, {
          kind: "native_plan_request",
          title: planRequest.title,
          message: formatNotificationBody(planRequest.messageText, config.completionDetailThresholdChars),
          priority: config.planPriority,
          tags: config.planTags,
          clickUrl: planRequest.reviewUrl,
          actions: buildPlanRequestActions(planRequest.reviewUrl, config.defaultLocale),
        });
        console.log(
          `[${hadExistingSession ? "plan-request-reused" : "plan-request"}] ${planRequest.requestKey} | ${planRequest.title}`
        );
      } catch (error) {
        console.error(`[plan-request-error] ${planRequest.requestKey} | ${error.message}`);
      }

      stateChanged =
        await deliverWebPushItem({
          config,
          state,
          kind: "plan",
          tab: "inbox",
          subtab: "pending",
          token: planRequest.token,
          stableId: pendingPlanStableId(planRequest),
          title: planRequest.title,
          body: planRequest.messageText,
          buildLocalizedContent: ({ locale }) => ({
            title: formatLocalizedTitle(locale, "server.title.plan", planRequest.threadLabel),
            body: planRequest.messageText,
          }),
        }) || stateChanged;
    }
  }

  for (const [requestKey] of previousPlans) {
    if (nextPlans.has(requestKey)) {
      continue;
    }
    const planRequest = runtime.planRequestsByRequestKey.get(requestKey);
    if (!planRequest) {
      continue;
    }

    if (planRequest.isLiveRequestActive) {
      planRequest.isLiveRequestActive = false;
      planRequest.lastSeenAtMs = Math.max(planRequest.lastSeenAtMs ?? 0, now);
      planRequest.expiresAtMs = Math.max(planRequest.expiresAtMs ?? 0, now + config.planRequestTtlMs);
      stateChanged = storePendingPlanRequest(state, planRequest) || stateChanged;
      stateChanged = clearPlanTurnActive(state, planRequest.turnKey) || stateChanged;
      stateChanged = markPlanTurnSuppressed(state, planRequest.turnKey, config.maxSeenEvents) || stateChanged;
      console.log(`[plan-request-retained] ${planRequest.turnKey || requestKey}`);
    }
  }

  if (stateChanged) {
    await saveState(config.stateFile, state);
  }
}

async function syncPlanUserInputRequests({
  config,
  runtime,
  state,
  conversationId,
  nextRequests,
  sourceClientId,
}) {
  let stateChanged = false;
  const now = Date.now();

  if (sourceClientId) {
    runtime.threadOwnerClientIds.set(conversationId, sourceClientId);
  }

  for (const request of nextRequests) {
    if (!isPlanQuestionRequest(request)) {
      continue;
    }

    const questionRequestId = cleanText(request.id);
    const requestKey = questionRequestId ? nativeRequestKey(conversationId, questionRequestId) : "";
    const turnId = extractPlanQuestionTurnId(request.params);
    const turnKey = turnId ? planTurnKey(conversationId, turnId) : "";

    const existingQuestionRequest =
      (requestKey ? runtime.planQuestionRequestsByRequestKey.get(requestKey) : null) ??
      (turnKey ? runtime.planQuestionRequestsByTurnKey.get(turnKey) : null) ??
      null;

    let questionRequest = existingQuestionRequest;
    if (!questionRequest) {
      questionRequest = createPlanQuestionRequest({
        runtime,
        conversationId,
        request,
        sourceClientId,
        now,
      });
      if (!questionRequest) {
        continue;
      }
    } else {
      const previousRequestKey = questionRequest.requestKey;
      updatePlanQuestionRequest({
        runtime,
        conversationId,
        request,
        sourceClientId,
        planQuestionRequest: questionRequest,
        now,
      });
      if (previousRequestKey && previousRequestKey !== questionRequest.requestKey) {
        runtime.planQuestionRequestsByRequestKey.delete(previousRequestKey);
      }
    }

    registerPlanQuestionRequest(runtime, questionRequest);

    const planRequest =
      (questionRequest.turnKey ? runtime.planRequestsByTurnKey.get(questionRequest.turnKey) : null) ??
      findLatestPlanRequestForConversation(runtime, conversationId);
    if (!planRequest || planRequest.resolved) {
      continue;
    }

    stateChanged = attachPlanQuestionRequest(planRequest, questionRequest) || stateChanged;
    stateChanged = storePendingPlanRequest(state, planRequest) || stateChanged;
  }

  if (stateChanged) {
    await saveState(config.stateFile, state);
  }
}

async function syncGenericUserInputRequests({
  config,
  runtime,
  state,
  conversationId,
  previousRequests = [],
  nextRequests,
  sourceClientId,
}) {
  let stateChanged = false;
  const now = Date.now();

  if (sourceClientId) {
    runtime.threadOwnerClientIds.set(conversationId, sourceClientId);
  }

  const previousGeneric = new Map(
    previousRequests
      .filter((request) => isGenericUserInputRequest(request))
      .map((request) => [nativeRequestKey(conversationId, request.id), request])
  );
  const nextGeneric = new Map(
    nextRequests
      .filter((request) => isGenericUserInputRequest(request))
      .map((request) => [nativeRequestKey(conversationId, request.id), request])
  );

  for (const [requestKey, request] of nextGeneric) {
    let userInputRequest = runtime.userInputRequestsByRequestKey.get(requestKey) ?? null;
    const hadExistingSession = Boolean(userInputRequest);
    const wasLiveRequestActive = userInputRequest?.isLiveRequestActive === true;
    const wasSupported = userInputRequest?.supported === true;

    if (!userInputRequest) {
      userInputRequest = createGenericUserInputRequest({
        config,
        runtime,
        conversationId,
        request,
        now,
      });
      if (!userInputRequest) {
        continue;
      }
    } else {
      const previousRequestKey = userInputRequest.requestKey;
      updateGenericUserInputRequest({
        config,
        runtime,
        conversationId,
        request,
        userInputRequest,
        now,
      });
      if (previousRequestKey && previousRequestKey !== userInputRequest.requestKey) {
        runtime.userInputRequestsByRequestKey.delete(previousRequestKey);
      }
    }

    registerGenericUserInputRequest(runtime, userInputRequest);
    stateChanged = storePendingUserInputRequest(state, userInputRequest) || stateChanged;

    const shouldNotify =
      !userInputRequest.resolved &&
      (!hadExistingSession || !wasLiveRequestActive || (!wasSupported && userInputRequest.supported));
    if (shouldNotify) {
      try {
        await publishNtfy(config, {
          kind: userInputRequest.supported ? "user_input" : "user_input_read_only",
          title: userInputRequest.title,
          message: formatNotificationBody(
            userInputRequest.notificationText || userInputRequest.messageText,
            config.completionDetailThresholdChars
          ),
          priority: config.planPriority,
          tags: config.planTags,
          clickUrl: userInputRequest.reviewUrl,
          actions: userInputRequest.supported
            ? buildUserInputActions(userInputRequest.reviewUrl, config.defaultLocale)
            : buildUserInputFallbackActions(userInputRequest.reviewUrl, config.defaultLocale),
        });
        console.log(
          `[${userInputRequest.supported ? "user-input" : "user-input-fallback"}] ${requestKey} | ${userInputRequest.title}`
        );
      } catch (error) {
        console.error(`[user-input-error] ${requestKey} | ${error.message}`);
      }

      stateChanged =
        await deliverWebPushItem({
          config,
          state,
          kind: "choice",
          tab: "inbox",
          subtab: "pending",
          token: userInputRequest.token,
          stableId: pendingChoiceStableId(userInputRequest),
          title: userInputRequest.title,
          body: userInputRequest.notificationText || userInputRequest.messageText,
          buildLocalizedContent: ({ locale }) => ({
            title: formatLocalizedTitle(
              locale,
              userInputRequest.supported ? "server.title.choice" : "server.title.choiceReadOnly",
              userInputRequest.threadLabel
            ),
            body: userInputRequest.notificationText || userInputRequest.messageText,
          }),
        }) || stateChanged;
    }
  }

  for (const [requestKey] of previousGeneric) {
    if (nextGeneric.has(requestKey)) {
      continue;
    }

    const userInputRequest = runtime.userInputRequestsByRequestKey.get(requestKey);
    if (!userInputRequest) {
      continue;
    }

    if (userInputRequest.isLiveRequestActive) {
      userInputRequest.isLiveRequestActive = false;
      userInputRequest.lastSeenAtMs = Math.max(userInputRequest.lastSeenAtMs ?? 0, now);
      userInputRequest.expiresAtMs = Math.max(userInputRequest.expiresAtMs ?? 0, now + config.planRequestTtlMs);
      stateChanged = storePendingUserInputRequest(state, userInputRequest) || stateChanged;
      console.log(`[user-input-retained] ${requestKey}`);
    }
  }

  if (stateChanged) {
    await saveState(config.stateFile, state);
  }
}

async function createNativeApproval({ config, runtime, conversationId, request, now = Date.now() }) {
  const token = crypto.randomBytes(18).toString("hex");
  const payload = await buildNativeApprovalPayload({
    config,
    runtime,
    conversationId,
    request,
    token,
  });
  if (!payload) {
    return null;
  }

  return {
    token,
    ...payload,
    createdAtMs: now,
    resolved: false,
    resolving: false,
    provider: "codex",
  };
}

async function buildNativeApprovalPayload({ config, runtime, conversationId, request, token }) {
  const kind = nativeApprovalKind(request.method);
  if (!kind) {
    return null;
  }

  const requestId = request.id;
  if (requestId == null) {
    return null;
  }
  const requestKey = nativeRequestKey(conversationId, requestId);

  const threadLabel = getNativeThreadLabel({
    runtime,
    conversationId,
    cwd: request.params?.cwd ?? request.params?.grantRoot ?? "",
  });
  const reviewUrl = `${config.nativeApprovalPublicBaseUrl}/native-approvals/${token}`;
  const title = formatTitle(config.approvalTitle, threadLabel);
  const rawParams = isPlainObject(request.params) ? cloneJson(request.params) : {};
  const approvalIds = kind === "file" ? collectFileApprovalCorrelationIds(rawParams, requestId) : [];
  const requestDelta = kind === "file" ? extractApprovalPayloadDelta(rawParams, "approval_request") : null;
  const cachedDelta =
    kind === "file"
      ? approvalIds.reduce(
          (merged, approvalId) => mergeApprovalPayloadDelta(merged, runtime.fileApprovalDeltasById.get(approvalId) ?? null),
          null
        )
      : null;
  const rolloutDelta =
    kind === "file"
      ? await buildApprovalPayloadDeltaFromRollout({
          runtime,
          conversationId,
          params: rawParams,
        })
      : null;
  const mergedDelta =
    kind === "file"
      ? mergeApprovalPayloadDelta(mergeApprovalPayloadDelta(requestDelta, cachedDelta), rolloutDelta)
      : null;
  const messageText = formatNativeApprovalMessage(kind, rawParams, config.defaultLocale);

  return {
    kind,
    title,
    threadLabel,
    messageText,
    reviewUrl,
    conversationId,
    requestId,
    requestKey,
    ownerClientId: runtime.threadOwnerClientIds.get(conversationId) ?? null,
    approvalIds,
    rawParams,
    cwd: cleanText(rawParams?.cwd ?? rawParams?.grantRoot ?? ""),
    workspaceRoot: cleanText(rawParams?.grantRoot ?? rawParams?.cwd ?? ""),
    fileRefs: normalizeTimelineFileRefs(mergedDelta?.fileRefs ?? []),
    diffText: normalizeTimelineDiffText(mergedDelta?.diffText ?? ""),
    diffAvailable: Boolean(mergedDelta?.diffAvailable),
    diffSource: normalizeTimelineDiffSource(mergedDelta?.diffSource ?? ""),
    diffAddedLines: Math.max(0, Number(mergedDelta?.diffAddedLines) || 0),
    diffRemovedLines: Math.max(0, Number(mergedDelta?.diffRemovedLines) || 0),
  };
}

async function refreshNativeApprovalFromRequest({ config, runtime, conversationId, request, approval }) {
  if (!approval?.token) {
    return false;
  }
  const payload = await buildNativeApprovalPayload({
    config,
    runtime,
    conversationId,
    request,
    token: approval.token,
  });
  if (!payload) {
    return false;
  }

  const before = JSON.stringify({
    kind: approval.kind,
    title: approval.title,
    threadLabel: approval.threadLabel,
    messageText: approval.messageText,
    reviewUrl: approval.reviewUrl,
    conversationId: approval.conversationId,
    requestId: approval.requestId,
    requestKey: approval.requestKey,
    ownerClientId: approval.ownerClientId,
    approvalIds: approval.approvalIds,
    rawParams: approval.rawParams,
    cwd: approval.cwd,
    workspaceRoot: approval.workspaceRoot,
    fileRefs: normalizeTimelineFileRefs(approval.fileRefs ?? []),
    diffText: normalizeTimelineDiffText(approval.diffText ?? ""),
    diffAvailable: Boolean(approval.diffAvailable),
    diffSource: normalizeTimelineDiffSource(approval.diffSource ?? ""),
    diffAddedLines: Math.max(0, Number(approval.diffAddedLines) || 0),
    diffRemovedLines: Math.max(0, Number(approval.diffRemovedLines) || 0),
  });

  approval.kind = payload.kind;
  approval.title = payload.title;
  approval.threadLabel = payload.threadLabel;
  approval.messageText = payload.messageText;
  approval.reviewUrl = payload.reviewUrl;
  approval.conversationId = payload.conversationId;
  approval.requestId = payload.requestId;
  approval.requestKey = payload.requestKey;
  approval.ownerClientId = payload.ownerClientId;
  approval.approvalIds = payload.approvalIds;
  approval.rawParams = payload.rawParams;
  approval.cwd = payload.cwd;
  approval.workspaceRoot = payload.workspaceRoot;
  approval.fileRefs = payload.fileRefs;
  approval.diffText = payload.diffText;
  approval.diffAvailable = payload.diffAvailable;
  approval.diffSource = payload.diffSource;
  approval.diffAddedLines = payload.diffAddedLines;
  approval.diffRemovedLines = payload.diffRemovedLines;

  const after = JSON.stringify({
    kind: approval.kind,
    title: approval.title,
    threadLabel: approval.threadLabel,
    messageText: approval.messageText,
    reviewUrl: approval.reviewUrl,
    conversationId: approval.conversationId,
    requestId: approval.requestId,
    requestKey: approval.requestKey,
    ownerClientId: approval.ownerClientId,
    approvalIds: approval.approvalIds,
    rawParams: approval.rawParams,
    cwd: approval.cwd,
    workspaceRoot: approval.workspaceRoot,
    fileRefs: normalizeTimelineFileRefs(approval.fileRefs ?? []),
    diffText: normalizeTimelineDiffText(approval.diffText ?? ""),
    diffAvailable: Boolean(approval.diffAvailable),
    diffSource: normalizeTimelineDiffSource(approval.diffSource ?? ""),
    diffAddedLines: Math.max(0, Number(approval.diffAddedLines) || 0),
    diffRemovedLines: Math.max(0, Number(approval.diffRemovedLines) || 0),
  });

  return before !== after;
}

function createPlanQuestionRequest({ runtime, conversationId, request, sourceClientId, now = Date.now() }) {
  if (!isPlanQuestionRequest(request)) {
    return null;
  }

  const questionRequestId = cleanText(request.id);
  const turnId = extractPlanQuestionTurnId(request.params);
  const turnKey = turnId ? planTurnKey(conversationId, turnId) : "";
  const options = extractPlanQuestionOptions(request.params);
  const promptText = extractPlanQuestionPrompt(request.params);
  const requestKey = questionRequestId ? nativeRequestKey(conversationId, questionRequestId) : "";

  return {
    conversationId,
    turnId,
    turnKey,
    requestId: questionRequestId,
    requestKey,
    ownerClientId:
      cleanText(sourceClientId ?? "") ||
      runtime.threadOwnerClientIds.get(conversationId) ||
      null,
    promptText,
    options,
    lastSeenAtMs: now,
  };
}

function updatePlanQuestionRequest({ runtime, conversationId, request, sourceClientId, planQuestionRequest, now = Date.now() }) {
  const turnId = extractPlanQuestionTurnId(request.params) || planQuestionRequest.turnId;
  const turnKey = turnId ? planTurnKey(conversationId, turnId) : planQuestionRequest.turnKey;
  const questionRequestId = cleanText(request.id) || planQuestionRequest.requestId;

  planQuestionRequest.conversationId = conversationId;
  planQuestionRequest.turnId = turnId;
  planQuestionRequest.turnKey = turnKey;
  planQuestionRequest.requestId = questionRequestId;
  planQuestionRequest.requestKey = questionRequestId ? nativeRequestKey(conversationId, questionRequestId) : "";
  planQuestionRequest.ownerClientId =
    cleanText(sourceClientId ?? "") ||
    runtime.threadOwnerClientIds.get(conversationId) ||
    planQuestionRequest.ownerClientId ||
    null;
  planQuestionRequest.promptText = extractPlanQuestionPrompt(request.params) || planQuestionRequest.promptText || "";
  planQuestionRequest.options = extractPlanQuestionOptions(request.params);
  planQuestionRequest.lastSeenAtMs = now;
}

function registerPlanQuestionRequest(runtime, planQuestionRequest) {
  if (!planQuestionRequest) {
    return;
  }

  if (planQuestionRequest.requestKey) {
    runtime.planQuestionRequestsByRequestKey.set(planQuestionRequest.requestKey, planQuestionRequest);
  }
  if (planQuestionRequest.turnKey) {
    runtime.planQuestionRequestsByTurnKey.set(planQuestionRequest.turnKey, planQuestionRequest);
  }
}

function applyStoredPlanQuestionRequest(runtime, planRequest) {
  if (!planRequest?.turnKey) {
    return false;
  }

  const stored = runtime.planQuestionRequestsByTurnKey.get(planRequest.turnKey);
  if (!stored) {
    return false;
  }

  return attachPlanQuestionRequest(planRequest, stored);
}

function attachPlanQuestionRequest(planRequest, planQuestionRequest) {
  if (!planRequest || !planQuestionRequest) {
    return false;
  }

  const nextOptions = Array.isArray(planQuestionRequest.options)
    ? planQuestionRequest.options.map((option) => ({
        id: cleanText(option.id ?? ""),
        label: cleanText(option.label ?? ""),
        isOther: Boolean(option.isOther),
      }))
    : [];

  const previousSnapshot = JSON.stringify({
    questionRequestId: planRequest.questionRequestId ?? "",
    questionRequestKey: planRequest.questionRequestKey ?? "",
    questionPrompt: planRequest.questionPrompt ?? "",
    questionOwnerClientId: planRequest.questionOwnerClientId ?? "",
    questionOptions: planRequest.questionOptions ?? [],
  });

  planRequest.questionRequestId = cleanText(planQuestionRequest.requestId ?? "") || null;
  planRequest.questionRequestKey = cleanText(planQuestionRequest.requestKey ?? "") || null;
  planRequest.questionPrompt = cleanText(planQuestionRequest.promptText ?? "") || null;
  planRequest.questionOwnerClientId = cleanText(planQuestionRequest.ownerClientId ?? "") || null;
  planRequest.questionOptions = nextOptions;

  const nextSnapshot = JSON.stringify({
    questionRequestId: planRequest.questionRequestId ?? "",
    questionRequestKey: planRequest.questionRequestKey ?? "",
    questionPrompt: planRequest.questionPrompt ?? "",
    questionOwnerClientId: planRequest.questionOwnerClientId ?? "",
    questionOptions: planRequest.questionOptions ?? [],
  });

  return previousSnapshot !== nextSnapshot;
}

function isPlanQuestionRequest(request) {
  const method = cleanText(request?.method ?? "").toLowerCase();
  if (!method) {
    return false;
  }

  if (
    !method.includes("requestuserinput") &&
    method !== "request_user_input" &&
    method !== "user-input-requested"
  ) {
    return false;
  }

  const promptText = extractPlanQuestionPrompt(request?.params ?? {}).toLowerCase();
  if (promptText.includes("implement this plan")) {
    return true;
  }

  const options = extractPlanQuestionOptions(request?.params ?? {});
  return options.some((option) => {
    const optionId = cleanText(option.id ?? "").toLowerCase();
    const optionLabel = cleanText(option.label ?? "").toLowerCase();
    return (
      optionId.includes("implement") ||
      optionId.includes("stay") ||
      optionId.includes("plan") ||
      optionLabel.includes("implement this plan") ||
      optionLabel.includes("stay in plan mode") ||
      optionLabel.includes("continue planning")
    );
  });
}

function extractPlanQuestionTurnId(params) {
  return cleanText(
    params?.turnId ??
      params?.turn_id ??
      params?.request?.turnId ??
      params?.request?.turn_id ??
      params?.item?.turnId ??
      params?.item?.turn_id ??
      ""
  );
}

function extractPlanQuestionPrompt(params) {
  const directPrompt = cleanText(params?.prompt ?? params?.question ?? params?.title ?? "");
  if (directPrompt) {
    return directPrompt;
  }

  const questions = extractToolRequestQuestions(params);
  for (const question of questions) {
    const prompt = cleanText(question.question ?? question.prompt ?? question.title ?? question.header ?? "");
    if (prompt) {
      return prompt;
    }
  }

  return "";
}

function extractPlanQuestionOptions(params) {
  const options = [];
  const questions = extractToolRequestQuestions(params);
  for (const question of questions) {
    for (const option of normalizeToolRequestOptions(question.options)) {
      options.push(option);
    }
  }

  if (options.length > 0) {
    return options;
  }

  return normalizeToolRequestOptions(params?.options ?? params?.choices ?? []);
}

function extractToolRequestQuestions(params) {
  if (Array.isArray(params?.questions)) {
    return params.questions.filter((question) => isPlainObject(question));
  }
  if (isPlainObject(params?.question)) {
    return [params.question];
  }
  return [];
}

function normalizeToolRequestOptions(rawOptions) {
  if (!Array.isArray(rawOptions)) {
    return [];
  }

  return rawOptions
    .filter((option) => isPlainObject(option) || typeof option === "string")
    .map((option, index) => {
      if (typeof option === "string") {
        return {
          id: "",
          label: cleanText(option),
          description: "",
          isOther: false,
          index,
        };
      }

      return {
        id: cleanText(option.id ?? option.value ?? option.key ?? ""),
        label: cleanText(option.label ?? option.text ?? option.title ?? option.value ?? ""),
        description: cleanText(option.description ?? option.hint ?? option.hintText ?? option.helpText ?? option.subtitle ?? option.detail ?? ""),
        isOther: Boolean(option.isOther),
        index,
      };
    })
    .filter((option) => option.label);
}

function questionHasFreeformOption(options) {
  if (!Array.isArray(options)) {
    return false;
  }

  return options.some((option) => option?.isOther);
}

function isUserInputRequestedMethod(method) {
  const normalized = cleanText(method).toLowerCase();
  return (
    normalized.includes("requestuserinput") ||
    normalized === "request_user_input" ||
    normalized === "user-input-requested"
  );
}

function isGenericUserInputRequest(request) {
  return isUserInputRequestedMethod(request?.method) && !isPlanQuestionRequest(request);
}

function extractUserInputTurnId(params) {
  return cleanText(
    params?.turnId ??
      params?.turn_id ??
      params?.request?.turnId ??
      params?.request?.turn_id ??
      params?.item?.turnId ??
      params?.item?.turn_id ??
      ""
  );
}

function normalizeToolRequestQuestions(params) {
  const sourceQuestions = extractToolRequestQuestions(params);
  if (sourceQuestions.length === 0) {
    const fallbackOptions = normalizeToolRequestOptions(params?.options ?? params?.choices ?? []);
    const fallbackPrompt = cleanText(params?.prompt ?? params?.question ?? params?.title ?? "");
    const fallbackHeader = cleanText(params?.header ?? params?.label ?? "");
    const fallbackHint = normalizeQuestionHintText(params);
    if (!fallbackPrompt && fallbackOptions.length === 0) {
      return [];
    }
    return [
      {
        id: cleanText(params?.questionId ?? params?.question_id ?? ""),
        header: fallbackHeader,
        prompt: fallbackPrompt || fallbackHeader || t(DEFAULT_LOCALE, "choice.questionFallback"),
        hint: fallbackHint,
        options: fallbackOptions,
        hasOther: questionHasFreeformOption(fallbackOptions),
      },
    ];
  }

  return sourceQuestions.map((question) => {
    const options = normalizeToolRequestOptions(question.options ?? question.choices ?? []);
    const prompt =
      cleanText(question.question ?? question.prompt ?? question.title ?? "") ||
      cleanText(question.header ?? "");
    return {
      id: cleanText(question.id ?? question.questionId ?? question.question_id ?? ""),
      header: cleanText(question.header ?? question.title ?? ""),
      prompt: prompt || t(DEFAULT_LOCALE, "choice.questionFallback"),
      hint: normalizeQuestionHintText(question),
      options,
      // Codex sometimes sets question-level isOther even when the payload only
      // contains fixed choices. For the iPhone selection UI, trust the actual
      // option list so explicit choices stay actionable.
      hasOther: questionHasFreeformOption(options),
    };
  });
}

function isSupportedGenericUserInputQuestion(question) {
  return Boolean(question?.id) && Array.isArray(question?.options) && question.options.length > 0 && !question.hasOther;
}

function areSupportedGenericUserInputQuestions(questions) {
  return Array.isArray(questions) && questions.length > 0 && questions.every(isSupportedGenericUserInputQuestion);
}

function buildUserInputDetailText(questions, locale = config?.defaultLocale || DEFAULT_LOCALE) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return t(locale, "choice.ready");
  }

  return questions
    .map((question, index) => {
      const heading = question.header || t(locale, "choice.questionHeading", { index: index + 1 });
      const prompt = question.prompt || heading;
      const optionLines = Array.isArray(question.options)
        ? question.options.map((option) => `- ${option.label}${option.isOther ? " (Other)" : ""}`)
        : [];
      return [`### ${heading}`, prompt, ...optionLines].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function buildUserInputNotificationText(questions, supported, locale = config?.defaultLocale || DEFAULT_LOCALE) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return supported ? t(locale, "choice.needInput") : t(locale, "choice.macOnly");
  }

  const firstPrompt = cleanText(questions[0]?.prompt ?? questions[0]?.header ?? "") || t(locale, "choice.needInput");
  const countLabel = questions.length > 1
    ? t(locale, "choice.multiQuestion", { count: questions.length })
    : t(locale, "choice.oneQuestion");
  if (!supported) {
    return `${firstPrompt}\n${countLabel}\n${t(locale, "choice.macOnly")}`;
  }
  return `${firstPrompt}\n${countLabel}`;
}

function buildUserInputReviewUrl(config, token) {
  return `${config.nativeApprovalPublicBaseUrl}/user-inputs/${token}`;
}

function restoreUserInputTitle(rawTitle, supported) {
  const normalizedTitle = cleanText(rawTitle ?? "");
  if (!normalizedTitle) {
    return supported ? t(DEFAULT_LOCALE, "server.title.choice") : t(DEFAULT_LOCALE, "server.title.choiceReadOnly");
  }

  for (const prefix of [
    t(DEFAULT_LOCALE, "server.title.choice"),
    t(DEFAULT_LOCALE, "server.title.choiceReadOnly"),
    t("ja", "server.title.choice"),
    t("ja", "server.title.choiceReadOnly"),
  ]) {
    const marker = `${prefix} | `;
    if (normalizedTitle.startsWith(marker)) {
      return formatTitle(
        supported ? t(DEFAULT_LOCALE, "server.title.choice") : t(DEFAULT_LOCALE, "server.title.choiceReadOnly"),
        cleanText(normalizedTitle.slice(marker.length))
      );
    }
  }

  return normalizedTitle;
}

function createGenericUserInputRequest({ config, runtime, conversationId, request, now = Date.now() }) {
  if (!isGenericUserInputRequest(request) || request.id == null) {
    return null;
  }

  const threadState = runtime.threadStates.get(conversationId) ?? null;
  const threadLabel = getNativeThreadLabel({
    runtime,
    conversationId,
    cwd: threadState?.cwd ?? "",
  });
  const token = crypto.randomBytes(18).toString("hex");
  const questions = normalizeToolRequestQuestions(request.params ?? {});
  const supported = areSupportedGenericUserInputQuestions(questions);
  const turnId = extractUserInputTurnId(request.params ?? {});

  return {
    token,
    title: formatTitle(
      supported ? t(config.defaultLocale, "server.title.choice") : t(config.defaultLocale, "server.title.choiceReadOnly"),
      threadLabel
    ),
    threadLabel,
    messageText: buildUserInputDetailText(questions, config.defaultLocale),
    notificationText: buildUserInputNotificationText(questions, supported, config.defaultLocale),
    reviewUrl: buildUserInputReviewUrl(config, token),
    conversationId,
    turnId,
    requestId: request.id,
    requestKey: nativeRequestKey(conversationId, request.id),
    ownerClientId: runtime.threadOwnerClientIds.get(conversationId) ?? null,
    questions,
    supported,
    testRequest: false,
    createdAtMs: now,
    lastSeenAtMs: now,
    expiresAtMs: now + config.planRequestTtlMs,
    isLiveRequestActive: true,
    resolved: false,
    resolving: false,
    draftAnswers: {},
    draftPage: 1,
  };
}

function updateGenericUserInputRequest({ config, runtime, conversationId, request, userInputRequest, now = Date.now() }) {
  const threadState = runtime.threadStates.get(conversationId) ?? null;
  const threadLabel = getNativeThreadLabel({
    runtime,
    conversationId,
    cwd: threadState?.cwd ?? "",
  });
  const nextQuestions = normalizeToolRequestQuestions(request.params ?? {});
  const nextSupported = areSupportedGenericUserInputQuestions(nextQuestions);
  const preserveExistingSupported =
    userInputRequest.supported &&
    !nextSupported &&
    Array.isArray(userInputRequest.questions) &&
    userInputRequest.questions.length > 0;
  const questions = preserveExistingSupported ? userInputRequest.questions : nextQuestions;
  const supported = preserveExistingSupported ? true : nextSupported;

  userInputRequest.title = formatTitle(
    supported ? t(config.defaultLocale, "server.title.choice") : t(config.defaultLocale, "server.title.choiceReadOnly"),
    threadLabel
  );
  userInputRequest.threadLabel = threadLabel;
  userInputRequest.messageText = buildUserInputDetailText(questions, config.defaultLocale);
  userInputRequest.notificationText = buildUserInputNotificationText(questions, supported, config.defaultLocale);
  userInputRequest.reviewUrl = buildUserInputReviewUrl(config, userInputRequest.token);
  userInputRequest.conversationId = conversationId;
  userInputRequest.turnId = extractUserInputTurnId(request.params ?? {}) || userInputRequest.turnId;
  userInputRequest.requestId = request.id;
  userInputRequest.requestKey = nativeRequestKey(conversationId, request.id);
  userInputRequest.ownerClientId =
    runtime.threadOwnerClientIds.get(conversationId) ??
    userInputRequest.ownerClientId ??
    null;
  userInputRequest.questions = questions;
  userInputRequest.supported = supported;
  userInputRequest.testRequest = false;
  userInputRequest.lastSeenAtMs = now;
  userInputRequest.expiresAtMs = now + config.planRequestTtlMs;
  if (!userInputRequest.resolved) {
    userInputRequest.isLiveRequestActive = true;
  }
  if (!isPlainObject(userInputRequest.draftAnswers)) {
    userInputRequest.draftAnswers = {};
  }
  if (!Number.isFinite(userInputRequest.draftPage) || userInputRequest.draftPage < 1) {
    userInputRequest.draftPage = 1;
  }
}

function registerGenericUserInputRequest(runtime, userInputRequest) {
  if (!userInputRequest) {
    return;
  }

  runtime.userInputRequestsByToken.set(userInputRequest.token, userInputRequest);
  runtime.userInputRequestsByRequestKey.set(userInputRequest.requestKey, userInputRequest);
}

function expireGenericUserInputRequest(runtime, requestKey) {
  const request = runtime.userInputRequestsByRequestKey.get(requestKey);
  if (!request) {
    return;
  }

  runtime.userInputRequestsByRequestKey.delete(requestKey);
  runtime.userInputRequestsByToken.delete(request.token);
}

function serializeGenericUserInputRequest(userInputRequest) {
  return {
    token: userInputRequest.token,
    title: userInputRequest.title,
    threadLabel: userInputRequest.threadLabel ?? "",
    messageText: userInputRequest.messageText,
    notificationText: userInputRequest.notificationText,
    conversationId: userInputRequest.conversationId,
    turnId: userInputRequest.turnId,
    requestId: userInputRequest.requestId,
    requestKey: userInputRequest.requestKey,
    ownerClientId: userInputRequest.ownerClientId ?? null,
    questions: Array.isArray(userInputRequest.questions) ? userInputRequest.questions : [],
    supported: Boolean(userInputRequest.supported),
    testRequest: Boolean(userInputRequest.testRequest),
    createdAtMs: userInputRequest.createdAtMs ?? Date.now(),
    lastSeenAtMs: userInputRequest.lastSeenAtMs ?? Date.now(),
    expiresAtMs: userInputRequest.expiresAtMs ?? Date.now(),
    resolved: Boolean(userInputRequest.resolved),
    isLiveRequestActive: Boolean(userInputRequest.isLiveRequestActive),
    draftAnswers: isPlainObject(userInputRequest.draftAnswers) ? userInputRequest.draftAnswers : {},
    draftPage: Number(userInputRequest.draftPage) || 1,
  };
}

function storePendingUserInputRequest(state, userInputRequest) {
  if (!userInputRequest?.requestKey) {
    return false;
  }

  const nextValue = serializeGenericUserInputRequest(userInputRequest);
  const previousValue = state.pendingUserInputRequests?.[userInputRequest.requestKey];
  state.pendingUserInputRequests[userInputRequest.requestKey] = nextValue;
  return JSON.stringify(previousValue) !== JSON.stringify(nextValue);
}

function deletePendingUserInputRequest(state, requestKey) {
  if (!requestKey || !state.pendingUserInputRequests?.[requestKey]) {
    return false;
  }

  delete state.pendingUserInputRequests[requestKey];
  return true;
}

function restorePendingUserInputRequests({ config, runtime, state, now = Date.now() }) {
  let changed = false;
  const pending = isPlainObject(state.pendingUserInputRequests) ? state.pendingUserInputRequests : {};
  state.pendingUserInputRequests = pending;

  for (const [requestKey, raw] of Object.entries(pending)) {
    const userInputRequest = restoreGenericUserInputRequest({ config, raw, now });
    if (!userInputRequest || isGenericUserInputRequestExpired(userInputRequest, now)) {
      delete pending[requestKey];
      changed = true;
      continue;
    }

    registerGenericUserInputRequest(runtime, userInputRequest);
    changed = storePendingUserInputRequest(state, userInputRequest) || changed;
  }

  return changed;
}

function restoreGenericUserInputRequest({ config, raw, now = Date.now() }) {
  if (!isPlainObject(raw)) {
    return null;
  }

  const token = cleanText(raw.token);
  const conversationId = cleanText(raw.conversationId);
  const requestId = raw.requestId;
  const requestKey = cleanText(raw.requestKey);
  if (!token || !conversationId || requestId == null || !requestKey) {
    return null;
  }

  const questions = normalizeRestoredQuestions(raw.questions ?? []);
  const supported = areSupportedGenericUserInputQuestions(questions);
  const detailText = normalizeLongText(raw.messageText ?? "") || buildUserInputDetailText(questions, config.defaultLocale);
  const rawNotificationText = normalizeLongText(raw.notificationText ?? "");
  const notificationText =
    rawNotificationText && Boolean(raw.supported) === supported
      ? rawNotificationText
      : buildUserInputNotificationText(questions, supported, config.defaultLocale);

  return {
    token,
    title: restoreUserInputTitle(raw.title, supported),
    threadLabel: cleanText(raw.threadLabel ?? ""),
    messageText: detailText,
    notificationText,
    reviewUrl: buildUserInputReviewUrl(config, token),
    conversationId,
    turnId: cleanText(raw.turnId ?? ""),
    requestId,
    requestKey,
    ownerClientId: cleanText(raw.ownerClientId ?? "") || null,
    questions,
    supported,
    testRequest: Boolean(raw.testRequest),
    createdAtMs: Number(raw.createdAtMs) || now,
    lastSeenAtMs: Number(raw.lastSeenAtMs) || now,
    expiresAtMs: Number(raw.expiresAtMs) || now + config.planRequestTtlMs,
    isLiveRequestActive: false,
    resolved: Boolean(raw.resolved),
    resolving: false,
    draftAnswers: isPlainObject(raw.draftAnswers) ? raw.draftAnswers : {},
    draftPage: Number(raw.draftPage) || 1,
  };
}

function normalizeRestoredQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) {
    return [];
  }

  return rawQuestions
    .filter((question) => isPlainObject(question))
    .map((question) => {
      const options = normalizeToolRequestOptions(question.options ?? []);
      return {
        id: cleanText(question.id ?? ""),
        header: cleanText(question.header ?? ""),
        prompt: cleanText(question.prompt ?? question.header ?? "") || t(DEFAULT_LOCALE, "choice.questionFallback"),
        hint: normalizeQuestionHintText(question),
        options,
        hasOther: questionHasFreeformOption(options),
      };
    });
}

function normalizeQuestionHintText(question) {
  if (!isPlainObject(question)) {
    return "";
  }

  const header = cleanText(question.header ?? question.title ?? "");
  const prompt =
    cleanText(question.question ?? question.prompt ?? question.title ?? "") ||
    header;
  const hint = cleanText(
    question.tooltip ??
      question.toolTip ??
      question.hint ??
      question.hintText ??
      question.helpText ??
      question.description ??
      question.subtitle ??
      question.detail ??
      ""
  );

  if (!hint || hint === header || hint === prompt) {
    return "";
  }

  return hint;
}

function isGenericUserInputRequestExpired(userInputRequest, now = Date.now()) {
  if (!userInputRequest) {
    return true;
  }

  if (userInputRequest.isLiveRequestActive && !userInputRequest.resolved) {
    return false;
  }

  return Number(userInputRequest.expiresAtMs) > 0 && now >= Number(userInputRequest.expiresAtMs);
}

function createTestGenericUserInputRequest({ config, title, questions, now = Date.now() }) {
  const requestId = `test-${crypto.randomUUID()}`;
  const threadLabel = cleanText(title || "") || "Bridge test";
  const token = crypto.randomBytes(18).toString("hex");
  const normalizedQuestions = normalizeRestoredQuestions(questions);
  const supported = areSupportedGenericUserInputQuestions(normalizedQuestions);

  return {
    token,
    title: formatTitle(
      supported ? t(config.defaultLocale, "server.title.choice") : t(config.defaultLocale, "server.title.choiceReadOnly"),
      threadLabel
    ),
    threadLabel,
    messageText: buildUserInputDetailText(normalizedQuestions, config.defaultLocale),
    notificationText: buildUserInputNotificationText(normalizedQuestions, supported, config.defaultLocale),
    reviewUrl: buildUserInputReviewUrl(config, token),
    conversationId: "__test__",
    turnId: "",
    requestId,
    requestKey: nativeRequestKey("__test__", requestId),
    ownerClientId: null,
    questions: normalizedQuestions,
    supported,
    testRequest: true,
    createdAtMs: now,
    lastSeenAtMs: now,
    expiresAtMs: now + config.planRequestTtlMs,
    isLiveRequestActive: false,
    resolved: false,
    resolving: false,
    draftAnswers: {},
    draftPage: 1,
  };
}

function cleanupExpiredUserInputRequests({ runtime, state, now = Date.now() }) {
  let changed = false;

  for (const userInputRequest of Array.from(runtime.userInputRequestsByRequestKey.values())) {
    if (!isGenericUserInputRequestExpired(userInputRequest, now)) {
      continue;
    }

    expireGenericUserInputRequest(runtime, userInputRequest.requestKey);
    changed = deletePendingUserInputRequest(state, userInputRequest.requestKey) || changed;
    console.log(`[user-input-expired] ${userInputRequest.requestKey}`);
  }

  return changed;
}

function createPlanImplementationRequest({ config, runtime, conversationId, request, now = Date.now() }) {
  if (request.method !== "item/plan/requestImplementation" || request.id == null) {
    return null;
  }

  const threadState = runtime.threadStates.get(conversationId) ?? null;
  const threadLabel = getNativeThreadLabel({
    runtime,
    conversationId,
    cwd: threadState?.cwd ?? "",
  });
  const turnId = cleanText(request.params?.turnId ?? request.params?.turn_id ?? "");
  const turnKey = planTurnKey(conversationId, turnId);
  const token = crypto.randomBytes(18).toString("hex");
  const reviewUrl = buildPlanRequestReviewUrl(config, token);
  const title = formatTitle(config.planTitle, threadLabel);
  const rawPlanContent = String(request.params?.planContent ?? "");
  const planContent = formatPlanDetailText(rawPlanContent, config.defaultLocale);
  const latestCollaborationMode = buildDefaultCollaborationMode(threadState);

  return {
    token,
    title,
    threadLabel,
    messageText: planContent,
    rawPlanContent,
    reviewUrl,
    conversationId,
    turnId,
    turnKey,
    requestId: request.id,
    requestKey: nativeRequestKey(conversationId, request.id),
    ownerClientId: runtime.threadOwnerClientIds.get(conversationId) ?? null,
    latestCollaborationMode,
    threadState,
    questionRequestId: null,
    questionRequestKey: null,
    questionPrompt: null,
    questionOwnerClientId: null,
    questionOptions: [],
    createdAtMs: now,
    lastSeenAtMs: now,
    expiresAtMs: now + config.planRequestTtlMs,
    isLiveRequestActive: true,
    resolved: false,
    resolving: false,
    draftAnswers: {},
  };
}

function updatePlanImplementationRequest({ config, runtime, conversationId, request, planRequest, now = Date.now() }) {
  const threadState = runtime.threadStates.get(conversationId) ?? planRequest.threadState ?? null;
  const threadLabel = getNativeThreadLabel({
    runtime,
    conversationId,
    cwd: threadState?.cwd ?? "",
  });
  const turnId = cleanText(request.params?.turnId ?? request.params?.turn_id ?? planRequest.turnId);
  const turnKey = planTurnKey(conversationId, turnId);
  const rawPlanContent = String(request.params?.planContent ?? planRequest.rawPlanContent ?? "");

  planRequest.title = formatTitle(config.planTitle, threadLabel);
  planRequest.threadLabel = threadLabel;
  planRequest.messageText = formatPlanDetailText(rawPlanContent, config.defaultLocale);
  planRequest.rawPlanContent = rawPlanContent;
  planRequest.reviewUrl = buildPlanRequestReviewUrl(config, planRequest.token);
  planRequest.conversationId = conversationId;
  planRequest.turnId = turnId;
  planRequest.turnKey = turnKey;
  planRequest.requestId = request.id;
  planRequest.requestKey = nativeRequestKey(conversationId, request.id);
  planRequest.ownerClientId =
    runtime.threadOwnerClientIds.get(conversationId) ??
    planRequest.ownerClientId ??
    null;
  planRequest.latestCollaborationMode = buildDefaultCollaborationMode(
    threadState ?? planRequest.latestCollaborationMode
  );
  planRequest.threadState = threadState ?? planRequest.threadState ?? null;
  planRequest.lastSeenAtMs = now;
  planRequest.expiresAtMs = now + config.planRequestTtlMs;
  if (!planRequest.resolved) {
    planRequest.isLiveRequestActive = true;
  }
}

function registerPlanImplementationRequest(runtime, planRequest) {
  if (!planRequest) {
    return;
  }

  runtime.planRequestsByToken.set(planRequest.token, planRequest);
  runtime.planRequestsByRequestKey.set(planRequest.requestKey, planRequest);
  runtime.planRequestsByTurnKey.set(planRequest.turnKey, planRequest);
}

function expireNativeApproval(runtime, requestKey) {
  const approval = runtime.nativeApprovalsByRequestKey.get(requestKey);
  if (!approval) {
    return;
  }

  runtime.nativeApprovalsByRequestKey.delete(requestKey);
  runtime.nativeApprovalsByToken.delete(approval.token);
}

function expirePlanImplementationRequest(runtime, requestKey) {
  const request = runtime.planRequestsByRequestKey.get(requestKey);
  if (!request) {
    return;
  }

  if (request.questionRequestKey) {
    runtime.planQuestionRequestsByRequestKey.delete(request.questionRequestKey);
  }
  if (request.turnKey) {
    runtime.planQuestionRequestsByTurnKey.delete(request.turnKey);
  }
  runtime.planRequestsByRequestKey.delete(requestKey);
  runtime.planRequestsByToken.delete(request.token);
  runtime.planRequestsByTurnKey.delete(request.turnKey);
}

function shouldSuppressPlanReadyEvent({ runtime, state, threadId, turnId }) {
  const turnKey = planTurnKey(threadId, turnId);
  if (!turnKey) {
    return false;
  }

  if (state.activePlanRequestTurns?.[turnKey] || state.suppressedPlanReadyTurns?.[turnKey]) {
    return true;
  }

  for (const request of runtime.planRequestsByTurnKey.values()) {
    if (request.turnKey === turnKey && !isPlanRequestExpired(request)) {
      return true;
    }
  }

  return false;
}

function findLatestPlanRequestForConversation(runtime, conversationId) {
  const candidates = [];
  for (const planRequest of runtime.planRequestsByTurnKey.values()) {
    if (planRequest.conversationId !== conversationId) {
      continue;
    }
    if (planRequest.resolved || isPlanRequestExpired(planRequest)) {
      continue;
    }
    candidates.push(planRequest);
  }

  candidates.sort((left, right) => Number(right.createdAtMs ?? 0) - Number(left.createdAtMs ?? 0));
  return candidates[0] ?? null;
}

function planTurnKey(threadId, turnId) {
  const normalizedThreadId = cleanText(threadId);
  const normalizedTurnId = cleanText(turnId);
  if (!normalizedThreadId || !normalizedTurnId) {
    return "";
  }
  return `${normalizedThreadId}:${normalizedTurnId}`;
}

function planTurnKeyFromRequest(conversationId, request) {
  if (!isPlainObject(request)) {
    return "";
  }

  const threadId = cleanText(request.params?.threadId ?? request.params?.thread_id ?? conversationId);
  const turnId = cleanText(request.params?.turnId ?? request.params?.turn_id ?? "");
  return planTurnKey(threadId, turnId);
}

function markPlanTurnActive(state, turnKey, maxEntries) {
  if (!turnKey || state.activePlanRequestTurns?.[turnKey]) {
    return false;
  }

  state.activePlanRequestTurns[turnKey] = Date.now();
  trimSeenEvents(state.activePlanRequestTurns, maxEntries);
  return true;
}

function clearPlanTurnActive(state, turnKey) {
  if (!turnKey || !state.activePlanRequestTurns?.[turnKey]) {
    return false;
  }

  delete state.activePlanRequestTurns[turnKey];
  return true;
}

function markPlanTurnSuppressed(state, turnKey, maxEntries) {
  if (!turnKey || state.suppressedPlanReadyTurns?.[turnKey]) {
    return false;
  }

  state.suppressedPlanReadyTurns[turnKey] = Date.now();
  trimSeenEvents(state.suppressedPlanReadyTurns, maxEntries);
  return true;
}

function buildPlanRequestReviewUrl(config, token) {
  return `${config.nativeApprovalPublicBaseUrl}/plan-requests/${token}`;
}

function serializePlanImplementationRequest(planRequest) {
  return {
    token: planRequest.token,
    title: planRequest.title,
    threadLabel: planRequest.threadLabel ?? "",
    messageText: planRequest.messageText,
    rawPlanContent: planRequest.rawPlanContent,
    conversationId: planRequest.conversationId,
    turnId: planRequest.turnId,
    turnKey: planRequest.turnKey,
    requestId: planRequest.requestId,
    requestKey: planRequest.requestKey,
    ownerClientId: planRequest.ownerClientId ?? null,
    latestCollaborationMode: planRequest.latestCollaborationMode ?? null,
    questionRequestId: planRequest.questionRequestId ?? null,
    questionRequestKey: planRequest.questionRequestKey ?? null,
    questionPrompt: planRequest.questionPrompt ?? null,
    questionOwnerClientId: planRequest.questionOwnerClientId ?? null,
    questionOptions: Array.isArray(planRequest.questionOptions) ? planRequest.questionOptions : [],
    createdAtMs: planRequest.createdAtMs ?? Date.now(),
    lastSeenAtMs: planRequest.lastSeenAtMs ?? Date.now(),
    expiresAtMs: planRequest.expiresAtMs ?? Date.now(),
    resolved: Boolean(planRequest.resolved),
    isLiveRequestActive: Boolean(planRequest.isLiveRequestActive),
  };
}

function storePendingPlanRequest(state, planRequest) {
  if (!planRequest?.turnKey) {
    return false;
  }

  const nextValue = serializePlanImplementationRequest(planRequest);
  const previousValue = state.pendingPlanRequests?.[planRequest.turnKey];
  state.pendingPlanRequests[planRequest.turnKey] = nextValue;
  return JSON.stringify(previousValue) !== JSON.stringify(nextValue);
}

function deletePendingPlanRequest(state, turnKey) {
  if (!turnKey || !state.pendingPlanRequests?.[turnKey]) {
    return false;
  }

  delete state.pendingPlanRequests[turnKey];
  return true;
}

function restorePendingPlanRequests({ config, runtime, state, now = Date.now() }) {
  let changed = false;
  const pending = isPlainObject(state.pendingPlanRequests) ? state.pendingPlanRequests : {};
  state.pendingPlanRequests = pending;

  for (const [turnKey, raw] of Object.entries(pending)) {
    const planRequest = restorePlanImplementationRequest({ config, turnKey, raw, now });
    if (!planRequest || isPlanRequestExpired(planRequest, now)) {
      delete pending[turnKey];
      changed = true;
      continue;
    }

    registerPlanImplementationRequest(runtime, planRequest);
  }

  return changed;
}

function restorePlanImplementationRequest({ config, turnKey, raw, now = Date.now() }) {
  if (!isPlainObject(raw)) {
    return null;
  }

  const token = cleanText(raw.token);
  const conversationId = cleanText(raw.conversationId);
  const turnId = cleanText(raw.turnId);
  const requestKey = cleanText(raw.requestKey);
  if (!token || !conversationId || !turnId || !turnKey) {
    return null;
  }

  const rawPlanContent = String(raw.rawPlanContent ?? raw.messageText ?? "");
  const latestCollaborationMode = isPlainObject(raw.latestCollaborationMode)
    ? buildDefaultCollaborationMode(raw.latestCollaborationMode)
    : buildDefaultCollaborationMode(null);

  return {
    token,
    title: cleanText(raw.title) || t(DEFAULT_LOCALE, "server.title.plan"),
    threadLabel: cleanText(raw.threadLabel ?? ""),
    messageText: formatPlanDetailText(raw.messageText ?? rawPlanContent, config.defaultLocale),
    rawPlanContent,
    reviewUrl: buildPlanRequestReviewUrl(config, token),
    conversationId,
    turnId,
    turnKey,
    requestId: raw.requestId ?? null,
    requestKey,
    ownerClientId: cleanText(raw.ownerClientId ?? "") || null,
    latestCollaborationMode,
    threadState: null,
    questionRequestId: cleanText(raw.questionRequestId ?? "") || null,
    questionRequestKey: cleanText(raw.questionRequestKey ?? "") || null,
    questionPrompt: cleanText(raw.questionPrompt ?? "") || null,
    questionOwnerClientId: cleanText(raw.questionOwnerClientId ?? "") || null,
    questionOptions: normalizeToolRequestOptions(raw.questionOptions ?? []),
    createdAtMs: Number(raw.createdAtMs) || now,
    lastSeenAtMs: Number(raw.lastSeenAtMs) || now,
    expiresAtMs: Number(raw.expiresAtMs) || now + config.planRequestTtlMs,
    isLiveRequestActive: false,
    resolved: Boolean(raw.resolved),
    resolving: false,
  };
}

function isPlanRequestExpired(planRequest, now = Date.now()) {
  if (!planRequest) {
    return true;
  }

  if (planRequest.isLiveRequestActive && !planRequest.resolved) {
    return false;
  }

  return Number(planRequest.expiresAtMs) > 0 && now >= Number(planRequest.expiresAtMs);
}

function cleanupExpiredPlanRequests({ runtime, state, now = Date.now() }) {
  let changed = false;

  for (const planRequest of Array.from(runtime.planRequestsByTurnKey.values())) {
    if (!isPlanRequestExpired(planRequest, now)) {
      continue;
    }

    expirePlanImplementationRequest(runtime, planRequest.requestKey);
    changed = deletePendingPlanRequest(state, planRequest.turnKey) || changed;
    changed = clearPlanTurnActive(state, planRequest.turnKey) || changed;
    console.log(`[plan-request-expired] ${planRequest.turnKey || planRequest.requestKey}`);
  }

  return changed;
}

function attachCompletionDetails({ config, runtime, event }) {
  const detailText = event.detailText || "";
  if (!detailText) {
    return;
  }

  if (!notificationNeedsDetail(detailText, config.completionDetailThresholdChars)) {
    return;
  }

  const token = crypto.randomBytes(18).toString("hex");
  const detailUrl = `${config.nativeApprovalPublicBaseUrl}/completion-details/${token}`;
  runtime.completionDetailsByToken.set(token, {
    title: event.title,
    messageText: detailText,
  });
  trimMap(runtime.completionDetailsByToken, config.maxCompletionDetails);

  event.clickUrl = detailUrl;
  event.actions = buildCompletionActions(detailUrl);
}

function attachPlanDetails({ config, runtime, event }) {
  const detailText = event.detailText || "";
  if (!detailText) {
    return;
  }

  const token = crypto.randomBytes(18).toString("hex");
  const detailUrl = `${config.nativeApprovalPublicBaseUrl}/plan-details/${token}`;
  runtime.planDetailsByToken.set(token, {
    title: event.title,
    messageText: detailText,
    threadId: event.threadId ?? "",
    resolved: false,
    resolving: false,
  });
  trimMap(runtime.planDetailsByToken, config.maxCompletionDetails);

  event.clickUrl = detailUrl;
  event.actions = buildPlanDetailActions(detailUrl);
}

async function publishNtfy(config, payload) {
  if (!config.enableNtfy) {
    return;
  }
  if (config.dryRun) {
    console.log(`[dry-run] ${payload.kind || "event"} | ${payload.title} | ${singleLine(payload.message)}`);
    return;
  }

  const args = [
    "-sS",
    "--fail-with-body",
    "--connect-timeout",
    String(config.ntfyConnectTimeoutSecs),
    "--max-time",
    String(config.ntfyMaxTimeSecs),
    "-X",
    "POST",
    "-H",
    "Content-Type: text/plain; charset=utf-8",
    "-H",
    `Title: ${payload.title}`,
    "-H",
    `Priority: ${payload.priority}`,
    "-H",
    `Tags: ${payload.tags.join(",")}`,
  ];

  const authHeader = buildAuthHeader();
  if (authHeader) {
    args.push("-H", `Authorization: ${authHeader}`);
  }

  const actionsHeader = serializeActions(payload.actions);
  if (actionsHeader) {
    args.push("-H", `Actions: ${actionsHeader}`);
  }

  if (payload.clickUrl) {
    args.push("-H", `Click: ${payload.clickUrl}`);
  }

  args.push(
    "--data-binary",
    payload.message,
    buildTopicUrl(config.ntfyPublishBaseUrl, config.ntfyTopic)
  );

  await runCurl(args);
}

function runCurl(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `curl exited with code ${code}`));
    });
  });
}

const IMPLEMENT_PLAN_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:";
const COMPLETION_REPLY_WORKSPACE_STAGE_DIR = ".viveworker-attachments";
const COMPLETION_REPLY_WORKSPACE_STAGE_TTL_MS = 60 * 60 * 1000;
const COMPLETION_REPLY_WORKSPACE_STAGE_CLEANUP_DELAY_MS = 10 * 60 * 1000;

function buildImplementPlanPrompt(planContent) {
  return `${IMPLEMENT_PLAN_PROMPT_PREFIX}\n${formatPlanDetailText(planContent)}`;
}

function buildTurnInput(text, options = {}) {
  const items = [];
  const normalizedText = String(text ?? "");
  const localImagePaths = Array.isArray(options?.localImagePaths)
    ? options.localImagePaths
        .map((value) => cleanText(value || ""))
        .filter(Boolean)
    : [];

  if (normalizedText) {
    items.push({
      type: "text",
      text: normalizedText,
      text_elements: [],
    });
  }

  for (const localImagePath of localImagePaths) {
    items.push({
      type: "local_image",
      path: localImagePath,
    });
  }

  return items;
}

function buildComposerStyleLocalImageInput(text, localImagePaths = []) {
  const items = [];
  const normalizedText = String(text ?? "");

  if (normalizedText) {
    items.push({
      type: "text",
      text: normalizedText,
      text_elements: [],
    });
  }

  for (const localImagePath of localImagePaths) {
    const normalizedPath = cleanText(localImagePath || "");
    if (!normalizedPath) {
      continue;
    }
    items.push({
      type: "localImage",
      path: normalizedPath,
    });
  }

  return items;
}

function buildComposerStyleImageInput(text, imageDataUrls = []) {
  const items = [];
  const normalizedText = String(text ?? "");

  if (normalizedText) {
    items.push({
      type: "text",
      text: normalizedText,
      text_elements: [],
    });
  }

  for (const imageUrl of imageDataUrls) {
    const normalizedUrl = cleanText(imageUrl || "");
    if (!normalizedUrl) {
      continue;
    }
    items.push({
      type: "image",
      url: normalizedUrl,
    });
  }

  return items;
}

function buildUserInputPayload(items, finalOutputJsonSchema = null) {
  return {
    items: Array.isArray(items) ? items : [],
    final_output_json_schema: finalOutputJsonSchema ?? null,
  };
}

function buildTurnContentItems(text, imageDataUrls = []) {
  const items = [];
  const normalizedText = String(text ?? "");
  if (normalizedText) {
    items.push({
      type: "input_text",
      text: normalizedText,
    });
  }
  for (const imageUrl of imageDataUrls) {
    if (!imageUrl) {
      continue;
    }
    items.push({
      type: "input_image",
      image_url: imageUrl,
      detail: "original",
    });
  }
  return items;
}

function buildTurnImageItems(text, imageDataUrls = []) {
  const items = [];
  const normalizedText = String(text ?? "");
  if (normalizedText) {
    items.push({
      type: "text",
      text: normalizedText,
      text_elements: [],
    });
  }
  for (const imageUrl of imageDataUrls) {
    if (!imageUrl) {
      continue;
    }
    items.push({
      type: "image",
      image_url: imageUrl,
    });
  }
  return items;
}

function buildRequestedCollaborationMode(threadState, requestedMode = "default") {
  const sourceMode = isPlainObject(threadState?.latestCollaborationMode)
    ? threadState.latestCollaborationMode
    : isPlainObject(threadState)
      ? threadState
      : null;
  const settings = isPlainObject(sourceMode?.settings)
    ? sourceMode.settings
    : {};

  return {
    mode: cleanText(requestedMode || "").toLowerCase() === "plan" ? "plan" : "default",
    settings: {
      model: cleanText(settings.model ?? ""),
      reasoning_effort: settings.reasoning_effort ?? null,
      developer_instructions: null,
    },
  };
}

function normalizeIpcErrorMessage(errorValue) {
  if (typeof errorValue === "string") {
    return cleanText(errorValue || "") || "ipc-request-failed";
  }
  if (errorValue instanceof Error) {
    return cleanText(errorValue.message || "") || errorValue.name || "ipc-request-failed";
  }
  if (Array.isArray(errorValue)) {
    try {
      return JSON.stringify(errorValue);
    } catch {
      return "ipc-request-failed";
    }
  }
  if (isPlainObject(errorValue)) {
    const candidateFields = [
      errorValue.message,
      errorValue.error,
      errorValue.details,
      errorValue.reason,
    ];
    const directMessage = candidateFields
      .map((value) => (typeof value === "string" ? cleanText(value || "") : ""))
      .find(Boolean);
    if (directMessage) {
      return directMessage;
    }
    try {
      return JSON.stringify(errorValue);
    } catch {
      return "ipc-request-failed";
    }
  }
  if (errorValue && typeof errorValue === "object") {
    try {
      return JSON.stringify(errorValue);
    } catch {
      return "ipc-request-failed";
    }
  }
  return cleanText(String(errorValue ?? "")) || "ipc-request-failed";
}

function buildDefaultCollaborationMode(threadState) {
  // Fallback turns must leave Plan mode unless the caller explicitly opts in.
  return buildRequestedCollaborationMode(threadState, "default");
}

class NativeIpcClient {
  constructor({ config, runtime, onThreadStateChanged, onUserInputRequested }) {
    this.config = config;
    this.runtime = runtime;
    this.onThreadStateChanged = onThreadStateChanged;
    this.onUserInputRequested = onUserInputRequested;
    this.buffer = Buffer.alloc(0);
    this.socket = null;
    this.clientId = null;
    this.pendingResponses = new Map();
    this.reconnectTimer = null;
    this.stopped = false;
  }

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const [requestId, pending] of this.pendingResponses) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("ipc-client-stopped"));
      this.pendingResponses.delete(requestId);
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  async sendApprovalDecision(approval, decision) {
    const method =
      approval.kind === "command"
        ? "thread-follower-command-approval-decision"
        : "thread-follower-file-approval-decision";
    return this.sendThreadFollowerRequest(method, {
      conversationId: approval.conversationId,
      requestId: approval.requestId,
      decision,
    }, approval.conversationId, approval.ownerClientId);
  }

  async setCollaborationMode(conversationId, collaborationMode, ownerClientId = null) {
    return this.sendThreadFollowerRequest(
      "thread-follower-set-collaboration-mode",
      {
        conversationId,
        collaborationMode,
      },
      conversationId,
      ownerClientId
    );
  }

  async startTurn(conversationId, turnStartParams, ownerClientId = null) {
    return this.sendThreadFollowerRequest(
      "thread-follower-start-turn",
      {
        conversationId,
        turnStartParams,
      },
      conversationId,
      ownerClientId
    );
  }

  async startTurnDirect(conversationId, turnStartParams, ownerClientId = null) {
    const targetClientId =
      ownerClientId ??
      this.runtime.threadOwnerClientIds.get(conversationId) ??
      null;
    return this.sendRequest(
      "turn/start",
      buildDirectTurnStartPayload(conversationId, turnStartParams),
      { targetClientId }
    );
  }

  async submitUserInputRequest(conversationId, requestId, answers, ownerClientId = null) {
    return this.sendThreadFollowerRequest(
      "thread-follower-submit-user-input-request",
      {
        conversationId,
        requestId,
        answers,
      },
      conversationId,
      ownerClientId
    );
  }

  async submitStructuredUserInput(conversationId, requestId, response, ownerClientId = null) {
    return this.sendThreadFollowerRequest(
      "thread-follower-submit-user-input",
      {
        conversationId,
        requestId,
        response,
      },
      conversationId,
      ownerClientId
    );
  }

  sendThreadFollowerRequest(method, params, conversationId, ownerClientId = null) {
    return this.sendRequest(method, params, {
      targetClientId:
        ownerClientId ??
        this.runtime.threadOwnerClientIds.get(conversationId) ??
        null,
    });
  }

  sendRequest(method, params, options = {}) {
    if (!this.socket || !this.clientId) {
      return Promise.reject(new Error("codex-ipc-not-connected"));
    }

    const requestId = crypto.randomUUID();
    const timeoutMs = options.timeoutMs ?? this.config.ipcRequestTimeoutMs;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        reject(new Error(`${method}-timeout`));
      }, timeoutMs);

      this.pendingResponses.set(requestId, { resolve, reject, timeout });
      this.write({
        type: "request",
        requestId,
        sourceClientId: this.clientId,
        targetClientId: options.targetClientId || undefined,
        method,
        version: options.version ?? 1,
        params,
      });
    });
  }

  connect() {
    if (this.stopped || this.socket) {
      return;
    }

    const socket = net.createConnection(this.config.ipcSocketPath);
    this.socket = socket;

    socket.on("connect", () => {
      this.buffer = Buffer.alloc(0);
      this.write({
        type: "request",
        requestId: crypto.randomUUID(),
        method: "initialize",
        params: { clientType: "viveworker-bridge" },
      });
    });

    socket.on("data", (chunk) => {
      this.handleData(chunk).catch((error) => {
        console.error(`[ipc-error] ${error.message}`);
      });
    });

    socket.on("error", (error) => {
      console.error(`[ipc-error] ${error.message}`);
    });

    socket.on("close", () => {
      this.socket = null;
      this.clientId = null;
      this.rejectPendingResponses("ipc-socket-closed");
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.config.ipcReconnectMs);
  }

  rejectPendingResponses(message) {
    for (const [requestId, pending] of this.pendingResponses) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      this.pendingResponses.delete(requestId);
    }
  }

  async handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      const frameBytes = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + frameBytes) {
        return;
      }

      const frame = this.buffer.subarray(4, 4 + frameBytes).toString("utf8");
      this.buffer = this.buffer.subarray(4 + frameBytes);

      let message;
      try {
        message = JSON.parse(frame);
      } catch {
        continue;
      }

      await this.handleMessage(message);
    }
  }

  async handleMessage(message) {
    if (message.type === "response") {
      if (message.resultType === "success" && message.method === "initialize") {
        this.clientId = message.result?.clientId ?? null;
        console.log(`[ipc] connected | clientId=${this.clientId || "unknown"}`);
      }

      const pending = this.pendingResponses.get(message.requestId);
      if (!pending) {
        return;
      }

      this.pendingResponses.delete(message.requestId);
      clearTimeout(pending.timeout);

      if (message.resultType === "error") {
        console.log(
          `[ipc] error method=${cleanText(message.method || "") || "unknown"} requestId=${cleanText(message.requestId || "") || "unknown"} payload=${inspect(message.error, { depth: 6, breakLength: 160 })}`
        );
        const error = new Error(normalizeIpcErrorMessage(message.error));
        if (message.error && typeof message.error === "object") {
          error.ipcError = message.error;
        }
        pending.reject(error);
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (message.type === "client-discovery-request") {
      this.write({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: false },
      });
      return;
    }

    if (message.type !== "broadcast") {
      return;
    }

    if (message.method === "thread-stream-state-changed") {
      await this.handleThreadStreamStateChanged(message);
      return;
    }

    if (message.method === "item/fileChange/outputDelta") {
      this.handleFileChangeOutputDelta(message);
      return;
    }

    if (isUserInputRequestedBroadcastMethod(message.method)) {
      await this.handleUserInputRequested(message);
    }
  }

  async handleThreadStreamStateChanged(message) {
    const normalized = normalizeThreadStreamStateChanged(message);
    if (!normalized) {
      return;
    }

    const previousState = this.runtime.threadStates.get(normalized.conversationId) ?? { requests: [] };
    let nextState = cloneJson(previousState) ?? { requests: [] };

    if (normalized.state) {
      nextState = mergeConversationState(nextState, normalized.state);
    }

    if (normalized.patches.length > 0) {
      nextState = applyJsonPatches(nextState, normalized.patches);
    }

    if (!Array.isArray(nextState.requests)) {
      nextState.requests = [];
    }

    const previousRequests = normalizeNativeRequests(previousState.requests);
    const nextRequests = normalizeNativeRequests(nextState.requests);

    if (previousRequests.length !== nextRequests.length) {
      console.log(
        `[ipc-requests] ${normalized.conversationId} | ${previousRequests.length} -> ${nextRequests.length}`
      );
    }

    this.runtime.threadStates.set(normalized.conversationId, nextState);

    // Register / update in the persistent thread registry.
    const regLabel = extractThreadLabelFromState(nextState)
      || getThreadName(this.runtime.sessionIndex, this.runtime.rolloutThreadLabels, normalized.conversationId, nextState.cwd || "", "");
    if (registerThread(this.runtime, {
      id: normalized.conversationId,
      label: regLabel,
      tool: "codex",
      cwd: nextState.cwd || "",
      lastSeenAtMs: Date.now(),
      active: true,
    })) {
      saveThreadRegistry(this.config.threadRegistryFile, this.runtime.threadRegistry).catch(() => {});
    }

    await this.onThreadStateChanged({
      conversationId: normalized.conversationId,
      previousRequests,
      nextRequests,
      sourceClientId: normalized.sourceClientId,
    });
  }

  async handleUserInputRequested(message) {
    if (!this.onUserInputRequested) {
      return;
    }

    const normalized = normalizeUserInputRequestedBroadcast(message);
    if (!normalized) {
      return;
    }

    await this.onUserInputRequested(normalized);
  }

  handleFileChangeOutputDelta(message) {
    const params = isPlainObject(message?.params) ? message.params : {};
    if (!rememberFileApprovalDelta(this.runtime, params)) {
      return;
    }
    const approvalIds = collectFileApprovalCorrelationIds(params);
    console.log(`[ipc-file-change-delta] approvalIds=${approvalIds.join(",") || "unknown"}`);
  }

  write(message) {
    if (!this.socket) {
      return;
    }

    const json = JSON.stringify(message);
    const frame = Buffer.alloc(4 + Buffer.byteLength(json));
    frame.writeUInt32LE(Buffer.byteLength(json), 0);
    frame.write(json, 4);
    this.socket.write(frame);
  }
}

function isUserInputRequestedBroadcastMethod(method) {
  return isUserInputRequestedMethod(method);
}

function normalizeUserInputRequestedBroadcast(message) {
  const params = isPlainObject(message.params) ? message.params : {};
  const conversationId = cleanText(
    params.conversationId ??
      params.threadId ??
      params.thread_id ??
      params.conversation?.id ??
      params.thread?.id ??
      params.request?.conversationId ??
      params.request?.threadId ??
      ""
  );
  const requestId = cleanText(
    params.requestId ??
      params.request_id ??
      params.id ??
      params.request?.id ??
      ""
  );

  if (!conversationId || !requestId) {
    return null;
  }

  return {
    conversationId,
    sourceClientId: cleanText(message.sourceClientId ?? ""),
    nextRequests: [
      {
        id: requestId,
        method: cleanText(message.method) || "request_user_input",
        params,
      },
    ],
  };
}

function normalizeThreadStreamStateChanged(message) {
  const params = message.params ?? {};
  const change = isPlainObject(params.change) ? params.change : null;
  const conversationId = cleanText(
    params.conversationId ??
      params.threadId ??
      params.id ??
      params.conversation?.id ??
      params.thread?.id ??
      change?.conversationState?.id ??
      params.state?.id ??
      ""
  );
  if (!conversationId) {
    return null;
  }

  let patches =
    change?.type === "patches"
      ? change.patches ?? []
      : params.patch ?? params.patches ?? params.operations ?? params.ops ?? [];
  if (!Array.isArray(patches)) {
    patches = patches ? [patches] : [];
  }

  let state = null;
  if (change?.type === "snapshot" && isPlainObject(change.conversationState)) {
    state = change.conversationState;
  } else if (isPlainObject(params.state)) {
    state = params.state;
  } else if (isPlainObject(params.conversation)) {
    state = params.conversation;
  } else if (isPlainObject(params.thread)) {
    state = params.thread;
  } else if (Array.isArray(params.requests)) {
    state = { requests: params.requests };
  }

  return {
    conversationId,
    patches: patches.filter((patch) => isPlainObject(patch) && typeof patch.op === "string"),
    state,
    sourceClientId: cleanText(message.sourceClientId ?? ""),
  };
}

function mergeConversationState(previousState, nextState) {
  const merged = {
    ...(isPlainObject(previousState) ? previousState : {}),
    ...(isPlainObject(nextState) ? nextState : {}),
  };

  if (Array.isArray(nextState?.requests)) {
    merged.requests = nextState.requests;
  }

  return merged;
}

function applyJsonPatches(document, patches) {
  let next = cloneJson(document) ?? {};

  for (const patch of patches) {
    next = applyJsonPatch(next, patch);
  }

  return next;
}

function applyJsonPatch(document, patch) {
  const operation = patch.op;
  const pathSegments = decodeJsonPointer(patch.path);

  if (pathSegments.length === 0) {
    if (operation === "remove") {
      return {};
    }
    if (operation === "add" || operation === "replace") {
      return cloneJson(patch.value);
    }
    return document;
  }

  const target = cloneJson(document) ?? {};
  if (operation === "remove") {
    removeAtPointer(target, pathSegments);
    return target;
  }

  if (operation === "add" || operation === "replace") {
    setAtPointer(target, pathSegments, cloneJson(patch.value), operation === "add");
    return target;
  }

  return target;
}

function decodeJsonPointer(pointer) {
  if (Array.isArray(pointer)) {
    return pointer.map((segment) => String(segment));
  }

  if (!pointer || pointer === "/") {
    return [];
  }

  return String(pointer)
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

function setAtPointer(target, segments, value, isAdd) {
  let node = target;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];

    if (Array.isArray(node)) {
      const arrayIndex = toArrayIndex(segment, node.length, true);
      if (node[arrayIndex] == null || typeof node[arrayIndex] !== "object") {
        node[arrayIndex] = isArrayPointerSegment(nextSegment) ? [] : {};
      }
      node = node[arrayIndex];
      continue;
    }

    if (node[segment] == null || typeof node[segment] !== "object") {
      node[segment] = isArrayPointerSegment(nextSegment) ? [] : {};
    }
    node = node[segment];
  }

  const finalSegment = segments.at(-1);
  if (Array.isArray(node)) {
    const index = toArrayIndex(finalSegment, node.length, isAdd);
    if (isAdd && (finalSegment === "-" || index === node.length)) {
      node.push(value);
      return;
    }
    if (isAdd) {
      node.splice(index, 0, value);
      return;
    }
    node[index] = value;
    return;
  }

  node[finalSegment] = value;
}

function removeAtPointer(target, segments) {
  let node = target;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (Array.isArray(node)) {
      const arrayIndex = toArrayIndex(segment, node.length, false);
      node = node[arrayIndex];
    } else {
      node = node?.[segment];
    }

    if (node == null) {
      return;
    }
  }

  const finalSegment = segments.at(-1);
  if (Array.isArray(node)) {
    const arrayIndex = toArrayIndex(finalSegment, node.length, false);
    if (arrayIndex >= 0 && arrayIndex < node.length) {
      node.splice(arrayIndex, 1);
    }
    return;
  }

  delete node?.[finalSegment];
}

function toArrayIndex(segment, length, allowEnd) {
  if (segment === "-" && allowEnd) {
    return length;
  }
  const parsed = Number.parseInt(segment, 10);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return allowEnd ? length : 0;
}

function isArrayPointerSegment(segment) {
  return segment === "-" || /^\d+$/u.test(String(segment || ""));
}

function normalizeNativeRequests(requests) {
  if (!Array.isArray(requests)) {
    return [];
  }

  return requests
    .filter((request) => isPlainObject(request) && request.id != null && request.method)
    .map((request) => ({
      id: request.id,
      method: String(request.method),
      params: isPlainObject(request.params) ? request.params : {},
    }));
}

function nativeApprovalKind(method) {
  if (method === "item/commandExecution/requestApproval") {
    return "command";
  }
  if (method === "item/fileChange/requestApproval") {
    return "file";
  }
  return null;
}

function nativeRequestKey(conversationId, requestId) {
  return `${conversationId}:${String(requestId)}`;
}

function getNativeThreadLabel({ runtime, conversationId, cwd }) {
  const normalizedConversationId = cleanText(conversationId || "");
  const threadState = normalizedConversationId ? runtime.threadStates.get(normalizedConversationId) ?? null : null;
  const stateLabel = sanitizeResolvedThreadLabel(extractThreadLabelFromState(threadState), normalizedConversationId);
  if (stateLabel) {
    return stateLabel;
  }
  if (normalizedConversationId && runtime.sessionIndex.has(normalizedConversationId)) {
    const sessionLabel = sanitizeResolvedThreadLabel(runtime.sessionIndex.get(normalizedConversationId) || "", normalizedConversationId);
    if (sessionLabel) {
      return sessionLabel;
    }
  }
  if (normalizedConversationId && runtime.rolloutThreadLabels.has(normalizedConversationId)) {
    const rolloutLabel = sanitizeResolvedThreadLabel(runtime.rolloutThreadLabels.get(normalizedConversationId) || "", normalizedConversationId);
    if (rolloutLabel) {
      return rolloutLabel;
    }
  }
  if (cwd) {
    return truncate(cleanText(path.basename(cwd)), 90) || shortId(normalizedConversationId);
  }
  return shortId(normalizedConversationId) || t(DEFAULT_LOCALE, "server.fallback.codexTask", { provider: providerDisplayName(DEFAULT_LOCALE, "codex") });
}

function isFallbackConversationLabel(label, conversationId) {
  const normalizedLabel = cleanText(label || "");
  const normalizedConversationId = cleanText(conversationId || "");
  if (!normalizedLabel) {
    return true;
  }
  if (normalizedConversationId && normalizedLabel === shortId(normalizedConversationId)) {
    return true;
  }
  return false;
}

function deriveClaudeSdkCliThreadLabel(messageText, conversationId = "") {
  const cleaned = stripNotificationMarkup(stripEnvironmentContextBlocks(messageText || ""));
  const single = cleanText(cleaned);
  if (!single || /^\d+$/u.test(single)) {
    return "";
  }

  if (/^You are scoring Moltbook posts? for an AI agent\b/iu.test(single)) {
    return "Moltbook scoring";
  }
  if (/^Codex from another agent:/iu.test(single)) {
    return truncate(cleanText(single.replace(/^Codex from another agent:\s*/iu, "")), 90) || "Cross-agent task";
  }

  const firstSentence = cleanText(single.split(/(?<=[.!?。！？])\s+/u)[0] || "");
  const candidate = firstSentence || single;
  if (!candidate || candidate === shortId(conversationId)) {
    return "";
  }
  return truncate(candidate, 90);
}

function isHiddenClaudeInternalScoringText(text) {
  const single = cleanText(stripNotificationMarkup(stripEnvironmentContextBlocks(text || "")));
  if (!single) {
    return false;
  }
  return /^You are scoring Moltbook posts? for an AI agent\b/iu.test(single);
}

function shouldHideClaudeInternalItem(item) {
  if (!isPlainObject(item)) {
    return false;
  }
  if (normalizeProvider(item.provider) !== "claude") {
    return false;
  }
  const threadLabel = cleanText(item.threadLabel ?? "");
  if (threadLabel === "Moltbook scoring") {
    return true;
  }
  return (
    isHiddenClaudeInternalScoringText(item.messageText) ||
    isHiddenClaudeInternalScoringText(item.summary) ||
    isHiddenClaudeInternalScoringText(item.detailText) ||
    isHiddenClaudeInternalScoringText(item.message)
  );
}

function threadStateArchiveStatus(threadState) {
  if (!isPlainObject(threadState)) {
    return "";
  }

  const booleanCandidates = [
    threadState.archived,
    threadState.isArchived,
    threadState.hidden,
    threadState.isHidden,
    threadState.deleted,
    threadState.isDeleted,
    threadState.closed,
    threadState.isClosed,
    threadState.thread?.archived,
    threadState.thread?.isArchived,
    threadState.thread?.hidden,
    threadState.thread?.isHidden,
    threadState.thread?.deleted,
    threadState.thread?.isDeleted,
    threadState.metadata?.archived,
    threadState.metadata?.isArchived,
    threadState.metadata?.hidden,
    threadState.metadata?.isHidden,
    threadState.metadata?.deleted,
    threadState.metadata?.isDeleted,
  ];
  if (booleanCandidates.some((value) => value === true)) {
    return "archived";
  }

  const statusCandidates = [
    threadState.status,
    threadState.state,
    threadState.visibility,
    threadState.lifecycle,
    threadState.thread?.status,
    threadState.thread?.state,
    threadState.thread?.visibility,
    threadState.metadata?.status,
    threadState.metadata?.state,
    threadState.metadata?.visibility,
  ]
    .map((value) => cleanText(value || "").toLowerCase())
    .filter(Boolean);

  for (const status of statusCandidates) {
    if (["archived", "hidden", "deleted", "closed"].includes(status)) {
      return status;
    }
  }

  return "";
}

function shouldExcludeCodeThread(runtime, threadId) {
  const normalizedThreadId = cleanText(threadId || "");
  if (!normalizedThreadId) {
    return false;
  }

  const threadState = runtime.threadStates.get(normalizedThreadId) ?? null;
  if (threadStateArchiveStatus(threadState)) {
    return true;
  }

  const currentSessionHasThread = Array.isArray(runtime.knownFiles)
    ? runtime.knownFiles.some((filePath) => extractThreadIdFromRolloutPath(filePath) === normalizedThreadId)
    : false;
  if (currentSessionHasThread) {
    return false;
  }

  if (threadState) {
    return false;
  }

  if (runtime.sessionIndex instanceof Map && runtime.sessionIndex.size > 0) {
    return runtime.sessionIndex.has(normalizedThreadId);
  }

  return false;
}

async function findRolloutThreadCwd(runtime, conversationId) {
  const normalizedConversationId = cleanText(conversationId || "");
  if (!normalizedConversationId) {
    return "";
  }

  const cachedCwd = resolvePath(cleanText(runtime.rolloutThreadCwds?.get(normalizedConversationId) || ""));
  if (cachedCwd) {
    return cachedCwd;
  }

  const knownFiles = Array.isArray(runtime.knownFiles) ? runtime.knownFiles : [];
  if (!knownFiles.length) {
    return "";
  }

  const prioritizedFiles = [];
  const fallbackFiles = [];
  for (const filePath of knownFiles) {
    if (extractThreadIdFromRolloutPath(filePath) === normalizedConversationId) {
      prioritizedFiles.push(filePath);
    } else {
      fallbackFiles.push(filePath);
    }
  }

  const filesToInspect = prioritizedFiles.length ? [...prioritizedFiles, ...fallbackFiles] : fallbackFiles;
  for (const filePath of filesToInspect) {
    const metadata = await extractRolloutThreadMetadata(filePath);
    if (cleanText(metadata?.threadId || "") !== normalizedConversationId) {
      continue;
    }
    const resolvedCwd = resolvePath(cleanText(metadata?.cwd || ""));
    if (resolvedCwd) {
      runtime.rolloutThreadCwds.set(normalizedConversationId, resolvedCwd);
      return resolvedCwd;
    }
  }

  return "";
}

async function resolveConversationCwd(runtime, conversationId) {
  const normalizedConversationId = cleanText(conversationId || "");
  if (!normalizedConversationId) {
    return "";
  }

  const threadStateCwd = resolvePath(
    cleanText(runtime.threadStates.get(normalizedConversationId)?.cwd || "")
  );
  if (threadStateCwd) {
    return threadStateCwd;
  }

  return await findRolloutThreadCwd(runtime, normalizedConversationId);
}

function formatNativeApprovalMessage(kind, params, locale = config?.defaultLocale || DEFAULT_LOCALE) {
  if (kind === "command") {
    return formatCommandApprovalMessage(params, locale);
  }
  return formatFileApprovalMessage(params, locale);
}

function formatCommandApprovalMessage(params, locale = config?.defaultLocale || DEFAULT_LOCALE) {
  const parts = [];
  const reason = truncate(cleanText(params.reason ?? params.justification ?? ""), 220);
  const command = truncate(cleanText(params.command ?? params.cmd ?? ""), 1200);
  if (reason) {
    parts.push(reason);
  } else {
    parts.push(t(locale, "server.message.commandApprovalNeeded"));
  }
  if (command) {
    parts.push(`${t(locale, "server.message.commandLabel")}\n\`\`\`sh\n${command}\n\`\`\``);
  }
  return parts.join("\n\n") || t(locale, "server.message.commandApprovalNeeded");
}

function formatFileApprovalMessage(params, locale = config?.defaultLocale || DEFAULT_LOCALE) {
  const parts = [];
  const reason = truncate(cleanText(params.reason ?? ""), 220);
  if (reason) {
    parts.push(reason);
  } else {
    parts.push(t(locale, "server.message.fileApprovalNeeded"));
  }
  if (params.grantRoot) {
    parts.push(t(locale, "server.message.pathPrefix", { path: compactPath(params.grantRoot) }));
  } else if (params.cwd) {
    parts.push(t(locale, "server.message.pathPrefix", { path: compactPath(params.cwd) }));
  }
  return truncate(parts.join("\n"), 1024);
}

function extractApprovalFileRefs(params) {
  if (!isPlainObject(params)) {
    return [];
  }

  const refs = [];
  const candidateKeys = new Set([
    "file",
    "files",
    "fileChange",
    "fileChanges",
    "change",
    "changes",
    "path",
    "paths",
    "filePath",
    "filePaths",
    "filename",
    "filenames",
    "fileName",
    "fileNames",
    "file_name",
    "file_names",
    "fileRef",
    "fileRefs",
    "updatedFile",
    "updatedFiles",
    "changedFile",
    "changedFiles",
    "targetFile",
    "targetFiles",
    "touchedFile",
    "touchedFiles",
    "relativePath",
    "relativePaths",
    "oldPath",
    "newPath",
    "old_path",
    "new_path",
    "sourcePath",
    "sourcePaths",
    "destinationPath",
    "destinationPaths",
  ]);

  function visit(value, parentKey = "", depth = 0) {
    if (depth > 5 || value == null) {
      return;
    }
    const normalizedParentKey = cleanText(parentKey);

    if (typeof value === "string") {
      if (candidateKeys.has(normalizedParentKey)) {
        refs.push(value);
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, normalizedParentKey, depth + 1);
      }
      return;
    }

    if (!isPlainObject(value)) {
      return;
    }

    if (candidateKeys.has(normalizedParentKey)) {
      const directRef = cleanText(
        value.fileRef ??
          value.filePath ??
          value.path ??
          value.filename ??
          value.fileName ??
          value.file_name ??
          value.relativePath ??
          value.oldPath ??
          value.newPath ??
          value.old_path ??
          value.new_path ??
          value.sourcePath ??
          value.destinationPath ??
          value.name ??
          ""
      );
      if (directRef) {
        refs.push(directRef);
      }
    }

    for (const [key, child] of Object.entries(value)) {
      visit(child, key, depth + 1);
    }
  }

  for (const [key, value] of Object.entries(params)) {
    visit(value, key, 0);
  }

  return normalizeTimelineFileRefs(refs);
}

function buildUnifiedDiffFromBeforeAfter({ fileRef = "", beforeText = "", afterText = "" }) {
  const normalizedFileRef = cleanTimelineFileRef(fileRef);
  if (!normalizedFileRef) {
    return "";
  }
  const before = String(beforeText ?? "");
  const after = String(afterText ?? "");
  if (!before && !after) {
    return "";
  }
  const beforeLines = before.replace(/\r\n/gu, "\n").split("\n");
  const afterLines = after.replace(/\r\n/gu, "\n").split("\n");
  const diffLines = [`diff --git ${diffPathForSide(normalizedFileRef, "a")} ${diffPathForSide(normalizedFileRef, "b")}`];

  if (!before && after) {
    diffLines.push("new file mode 100644");
    diffLines.push("--- /dev/null");
    diffLines.push(`+++ ${diffPathForSide(normalizedFileRef, "b")}`);
    diffLines.push(`@@ -0,0 +1,${Math.max(afterLines.length, 1)} @@`);
    diffLines.push(...afterLines.map((line) => `+${line}`));
    return normalizeTimelineDiffText(diffLines.join("\n"));
  }

  diffLines.push(`--- ${diffPathForSide(normalizedFileRef, "a")}`);
  diffLines.push(`+++ ${diffPathForSide(normalizedFileRef, "b")}`);
  diffLines.push(`@@ -1,${Math.max(beforeLines.length, 1)} +1,${Math.max(afterLines.length, 1)} @@`);
  diffLines.push(...beforeLines.map((line) => `-${line}`));
  diffLines.push(...afterLines.map((line) => `+${line}`));
  return normalizeTimelineDiffText(diffLines.join("\n"));
}

function extractStructuredApprovalDiffText(value, fallbackFileRefs = []) {
  const normalizedFallbackRefs = normalizeTimelineFileRefs(fallbackFileRefs);
  if (typeof value === "string") {
    return normalizeTimelineDiffText(value);
  }

  if (Array.isArray(value)) {
    const sections = value
      .map((item) => extractStructuredApprovalDiffText(item, normalizedFallbackRefs))
      .filter(Boolean);
    return normalizeTimelineDiffText(sections.join("\n\n"));
  }

  if (!isPlainObject(value)) {
    return "";
  }

  const explicitDiff =
    extractStructuredApprovalDiffText(
      value.diff ??
        value.patch ??
        value.patchText ??
      value.diffText ??
      value.unifiedDiff ??
      value.unified_diff ??
      value.unifiedPatch ??
      value.unified_patch ??
      value.unifiedPatchText ??
      value.unified_patch_text ??
      value.text ??
      value.value ??
      value.content ??
      value.delta ??
      value.output ??
      value.fileChanges ??
      value.fileChange ??
      value.changes ??
      value.change ??
      null,
      normalizedFallbackRefs
    ) || "";
  if (explicitDiff) {
    return explicitDiff;
  }

  const fileRef =
    cleanTimelineFileRef(
      value.fileRef ??
        value.filePath ??
        value.path ??
        value.filename ??
        value.fileName ??
        value.file_name ??
        value.relativePath ??
        value.name ??
        value.targetFile ??
        value.newPath ??
        value.oldPath ??
        value.new_path ??
        value.old_path ??
        value.sourcePath ??
        value.destinationPath ??
        normalizedFallbackRefs[0] ??
        ""
    ) || normalizedFallbackRefs[0] || "";
  const beforeText =
    value.before ??
    value.beforeText ??
    value.oldText ??
    value.old_text ??
    value.originalText ??
    value.original_text ??
    value.previousText ??
    value.previous_text ??
    value.contentBefore ??
    value.beforeContent ??
    value.oldContent ??
    value.old_content ??
    "";
  const afterText =
    value.after ??
    value.afterText ??
    value.newText ??
    value.new_text ??
    value.updatedText ??
    value.updated_text ??
    value.currentText ??
    value.current_text ??
    value.contentAfter ??
    value.afterContent ??
    value.newContent ??
    value.new_content ??
    "";
  const beforeAfterDiff = buildUnifiedDiffFromBeforeAfter({ fileRef, beforeText, afterText });
  if (beforeAfterDiff) {
    return beforeAfterDiff;
  }

  for (const child of Object.values(value)) {
    const nested = extractStructuredApprovalDiffText(child, fileRef ? [fileRef] : normalizedFallbackRefs);
    if (nested) {
      return nested;
    }
  }
  return "";
}

function extractApprovalDiffText(params, fileRefs = []) {
  if (!isPlainObject(params)) {
    return "";
  }

  const candidateKeys = new Set([
    "diff",
    "diffText",
    "patch",
    "patchText",
    "unifiedDiff",
    "unified_diff",
    "diffPreview",
    "diffString",
    "fileChange",
    "fileChanges",
    "change",
    "changes",
  ]);

  let best = "";

  function considerText(value) {
    const normalized = normalizeTimelineDiffText(value);
    if (!normalized) {
      return;
    }
    if (!best || normalized.length > best.length) {
      best = normalized;
    }
  }

  function visit(value, parentKey = "", depth = 0) {
    if (depth > 6 || value == null || best) {
      return;
    }

    if (typeof value === "string") {
      const normalizedParentKey = cleanText(parentKey);
      if (
        candidateKeys.has(normalizedParentKey) ||
        value.includes("*** Begin Patch") ||
        value.includes("\n@@ ") ||
        value.includes("\n--- ") ||
        value.includes("\n+++ ")
      ) {
        considerText(value);
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, parentKey, depth + 1);
        if (best) {
          return;
        }
      }
      return;
    }

    if (!isPlainObject(value)) {
      return;
    }

    const normalizedParentKey = cleanText(parentKey);
    if (candidateKeys.has(normalizedParentKey)) {
      considerText(extractStructuredApprovalDiffText(value, fileRefs));
      if (best) {
        return;
      }
    }

    for (const [key, child] of Object.entries(value)) {
      visit(child, key, depth + 1);
      if (best) {
        return;
      }
    }
  }

  visit(params, "", 0);
  if (!best) {
    return "";
  }

  const normalizedFileRefs = normalizeTimelineFileRefs(fileRefs);
  if (normalizedFileRefs.length === 0) {
    return best;
  }

  const filtered = splitUnifiedDiffTextByFile(best)
    .filter((section) => normalizedFileRefs.some((fileRef) => timelineFileRefsMatch(section.fileRef, fileRef)))
    .map((section) => section.diffText)
    .filter(Boolean)
    .join("\n");

  return filtered ? normalizeTimelineDiffText(filtered) : best;
}

function extractApprovalPayloadDelta(params, diffSource = "approval_request") {
  const fileRefs = extractApprovalFileRefs(params);
  const diffText = extractApprovalDiffText(params, fileRefs);
  const diffCounts = diffLineCounts(diffText);
  return {
    fileRefs,
    diffText,
    diffAvailable: Boolean(diffText),
    diffSource: diffText ? diffSource : "",
    diffAddedLines: diffCounts.addedLines,
    diffRemovedLines: diffCounts.removedLines,
  };
}

function mergeApprovalDiffTexts(existingText = "", nextText = "", fileRefs = []) {
  const existing = normalizeTimelineDiffText(existingText);
  const next = normalizeTimelineDiffText(nextText);
  if (!existing) {
    return next;
  }
  if (!next || next === existing) {
    return existing;
  }
  if (next.includes(existing)) {
    return next;
  }
  if (existing.includes(next)) {
    return existing;
  }

  const relevantRefs = normalizeTimelineFileRefs(fileRefs);
  const existingSections = splitUnifiedDiffTextByFile(existing);
  const nextSections = splitUnifiedDiffTextByFile(next);
  if (existingSections.length === 0 || nextSections.length === 0) {
    return normalizeTimelineDiffText([existing, next].join("\n\n"));
  }

  const mergedSections = [...existingSections];
  for (const section of nextSections) {
    const matchIndex = mergedSections.findIndex((candidate) => timelineFileRefsMatch(candidate.fileRef, section.fileRef));
    if (matchIndex === -1) {
      mergedSections.push(section);
      continue;
    }
    if ((section.diffText || "").length > (mergedSections[matchIndex].diffText || "").length) {
      mergedSections[matchIndex] = section;
    }
  }

  const filteredSections =
    relevantRefs.length > 0
      ? mergedSections.filter((section) => relevantRefs.some((fileRef) => timelineFileRefsMatch(section.fileRef, fileRef)))
      : mergedSections;
  return normalizeTimelineDiffText(filteredSections.map((section) => section.diffText).filter(Boolean).join("\n\n"));
}

function mergeApprovalPayloadDelta(base, next) {
  if (!base && !next) {
    return null;
  }
  if (!base) {
    return next ? { ...next, fileRefs: normalizeTimelineFileRefs(next.fileRefs ?? []) } : null;
  }
  if (!next) {
    return base ? { ...base, fileRefs: normalizeTimelineFileRefs(base.fileRefs ?? []) } : null;
  }

  const fileRefs = normalizeTimelineFileRefs([...(base.fileRefs ?? []), ...(next.fileRefs ?? [])]);
  const diffText = mergeApprovalDiffTexts(base.diffText ?? "", next.diffText ?? "", fileRefs);
  const diffCounts = diffLineCounts(diffText);
  return {
    fileRefs,
    diffText,
    diffAvailable: Boolean(diffText) || base.diffAvailable === true || next.diffAvailable === true,
    diffSource: normalizeTimelineDiffSource(next.diffSource || base.diffSource || ""),
    diffAddedLines: diffCounts.addedLines,
    diffRemovedLines: diffCounts.removedLines,
  };
}

function collectFileApprovalCorrelationIds(params, fallbackRequestId = "") {
  const ids = new Set();
  const pushValue = (value) => {
    const normalized = cleanText(value ?? "");
    if (normalized) {
      ids.add(normalized);
    }
  };

  pushValue(fallbackRequestId);
  if (isPlainObject(params)) {
    pushValue(params.approvalId);
    pushValue(params.requestId);
    pushValue(params.id);
  }
  return [...ids.values()];
}

function approvalCorrelationIds(approval) {
  const ids = new Set();
  if (approval?.requestId != null) {
    ids.add(cleanText(approval.requestId));
  }
  if (Array.isArray(approval?.approvalIds)) {
    for (const approvalId of approval.approvalIds) {
      const normalized = cleanText(approvalId);
      if (normalized) {
        ids.add(normalized);
      }
    }
  }
  const rawParams = isPlainObject(approval?.rawParams) ? approval.rawParams : {};
  for (const candidate of [rawParams.approvalId, rawParams.requestId, rawParams.id]) {
    const normalized = cleanText(candidate ?? "");
    if (normalized) {
      ids.add(normalized);
    }
  }
  return [...ids.values()];
}

function applyApprovalPayloadDeltaToApproval(approval, delta) {
  if (!approval || !delta) {
    return false;
  }
  const merged = mergeApprovalPayloadDelta(
    {
      fileRefs: approval.fileRefs ?? [],
      diffText: approval.diffText ?? "",
      diffAvailable: approval.diffAvailable === true,
      diffSource: approval.diffSource ?? "",
      diffAddedLines: approval.diffAddedLines ?? 0,
      diffRemovedLines: approval.diffRemovedLines ?? 0,
    },
    delta
  );
  if (!merged) {
    return false;
  }
  const changed =
    JSON.stringify([
      normalizeTimelineFileRefs(approval.fileRefs ?? []),
      normalizeTimelineDiffText(approval.diffText ?? ""),
      Boolean(approval.diffAvailable),
      normalizeTimelineDiffSource(approval.diffSource ?? ""),
      Math.max(0, Number(approval.diffAddedLines) || 0),
      Math.max(0, Number(approval.diffRemovedLines) || 0),
    ]) !==
    JSON.stringify([
      normalizeTimelineFileRefs(merged.fileRefs ?? []),
      normalizeTimelineDiffText(merged.diffText ?? ""),
      Boolean(merged.diffAvailable),
      normalizeTimelineDiffSource(merged.diffSource ?? ""),
      Math.max(0, Number(merged.diffAddedLines) || 0),
      Math.max(0, Number(merged.diffRemovedLines) || 0),
    ]);
  approval.fileRefs = normalizeTimelineFileRefs(merged.fileRefs ?? []);
  approval.diffText = normalizeTimelineDiffText(merged.diffText ?? "");
  approval.diffAvailable = Boolean(merged.diffAvailable);
  approval.diffSource = normalizeTimelineDiffSource(merged.diffSource ?? "");
  approval.diffAddedLines = Math.max(0, Number(merged.diffAddedLines) || 0);
  approval.diffRemovedLines = Math.max(0, Number(merged.diffRemovedLines) || 0);
  return changed;
}

function rememberFileApprovalDelta(runtime, params) {
  const approvalIds = collectFileApprovalCorrelationIds(params);
  if (approvalIds.length === 0) {
    return false;
  }

  const delta = extractApprovalPayloadDelta(params, "approval_request");
  if (!delta.diffAvailable && normalizeTimelineFileRefs(delta.fileRefs ?? []).length === 0) {
    return false;
  }

  let changed = false;
  for (const approvalId of approvalIds) {
    const previous = runtime.fileApprovalDeltasById.get(approvalId) ?? null;
    const next = mergeApprovalPayloadDelta(previous, delta);
    if (!next) {
      continue;
    }
    runtime.fileApprovalDeltasById.set(approvalId, next);
    changed = true;
  }

  if (runtime.fileApprovalDeltasById.size > 256) {
    const oldestKey = runtime.fileApprovalDeltasById.keys().next().value;
    if (oldestKey) {
      runtime.fileApprovalDeltasById.delete(oldestKey);
    }
  }

  if (!changed) {
    return false;
  }

  for (const approval of runtime.nativeApprovalsByToken.values()) {
    const matches = approvalCorrelationIds(approval).some((approvalId) => approvalIds.includes(approvalId));
    if (!matches) {
      continue;
    }
    applyApprovalPayloadDeltaToApproval(approval, delta);
  }
  return true;
}

function buildNativeApprovalActions(reviewUrl, locale = config?.defaultLocale || DEFAULT_LOCALE) {
  return [{ action: "view", label: t(locale, "server.action.review"), url: reviewUrl, clear: true }];
}

function buildCompletionActions(detailUrl, locale = config?.defaultLocale || DEFAULT_LOCALE) {
  return [{ action: "view", label: t(locale, "server.action.detail"), url: detailUrl, clear: false }];
}

function buildPlanDetailActions(detailUrl, locale = config?.defaultLocale || DEFAULT_LOCALE) {
  return [{ action: "view", label: t(locale, "server.action.detail"), url: detailUrl, clear: false }];
}

function buildPlanRequestActions(detailUrl, locale = config?.defaultLocale || DEFAULT_LOCALE) {
  return [{ action: "view", label: t(locale, "server.action.review"), url: detailUrl, clear: false }];
}

function buildUserInputActions(detailUrl, locale = config?.defaultLocale || DEFAULT_LOCALE) {
  return [{ action: "view", label: t(locale, "server.action.select"), url: detailUrl, clear: false }];
}

function buildUserInputFallbackActions(detailUrl, locale = config?.defaultLocale || DEFAULT_LOCALE) {
  return [{ action: "view", label: t(locale, "server.action.detail"), url: detailUrl, clear: false }];
}

function parseCookies(req) {
  const header = String(req.headers.cookie || "");
  const cookies = {};
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.split("=");
    const name = cleanText(rawName);
    if (!name) {
      continue;
    }
    cookies[name] = decodeURIComponent(rawValue.join("=") || "");
  }
  return cookies;
}

function base64UrlEncode(value) {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(String(value), "base64url").toString("utf8");
}

function signSessionPayload(payload, secret) {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifySessionToken(token, secret) {
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature) {
    return null;
  }

  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  const left = Buffer.from(signature, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encoded));
    if (!isPlainObject(payload)) {
      return null;
    }
    const expiresAtMs = Number(payload.expiresAtMs) || 0;
    if (expiresAtMs > 0 && Date.now() >= expiresAtMs) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function normalizeDeviceTrustRecord(raw, { trustTtlMs, now = Date.now() }) {
  if (typeof raw === "number" || typeof raw === "string") {
    const legacyPairedAtMs = Number(raw) || 0;
    if (!legacyPairedAtMs) {
      return null;
    }
    return {
      pairedAtMs: legacyPairedAtMs,
      trustedUntilMs: legacyPairedAtMs + trustTtlMs,
      lastAuthenticatedAtMs: legacyPairedAtMs,
      revokedAtMs: 0,
      userAgent: "",
      standalone: false,
      lastLocale: "",
    };
  }

  if (!isPlainObject(raw)) {
    return null;
  }

  const pairedAtMs =
    Number(raw.pairedAtMs) ||
    Number(raw.lastAuthenticatedAtMs) ||
    Number(raw.trustedUntilMs) ||
    now;
  if (!pairedAtMs) {
    return null;
  }

  return {
    pairedAtMs,
    trustedUntilMs: Number(raw.trustedUntilMs) || pairedAtMs + trustTtlMs,
    lastAuthenticatedAtMs: Number(raw.lastAuthenticatedAtMs) || pairedAtMs,
    revokedAtMs: Number(raw.revokedAtMs) || 0,
    userAgent: cleanText(raw.userAgent ?? ""),
    standalone: raw.standalone === true,
    lastLocale: normalizeSupportedLocale(raw.lastLocale),
  };
}

function deviceTrustSortTimestamp(record) {
  if (!isPlainObject(record)) {
    return 0;
  }
  return Math.max(
    Number(record.lastAuthenticatedAtMs) || 0,
    Number(record.pairedAtMs) || 0,
    Number(record.trustedUntilMs) || 0,
    Number(record.revokedAtMs) || 0
  );
}

function trimDeviceTrustRecords(pairedDevices, maxEntries = MAX_PAIRED_DEVICES) {
  const entries = Object.entries(isPlainObject(pairedDevices) ? pairedDevices : {});
  if (entries.length <= maxEntries) {
    return;
  }

  entries.sort((left, right) => deviceTrustSortTimestamp(right[1]) - deviceTrustSortTimestamp(left[1]));
  for (const [deviceId] of entries.slice(maxEntries)) {
    delete pairedDevices[deviceId];
  }
}

function migratePairedDevicesState({ config, state, now = Date.now() }) {
  const current = isPlainObject(state?.pairedDevices) ? state.pairedDevices : {};
  const next = {};
  for (const [rawDeviceId, rawRecord] of Object.entries(current)) {
    const deviceId = cleanText(rawDeviceId || "");
    if (!deviceId) {
      continue;
    }
    const record = normalizeDeviceTrustRecord(rawRecord, {
      trustTtlMs: config.deviceTrustTtlMs,
      now,
    });
    if (!record) {
      continue;
    }
    next[deviceId] = record;
  }

  trimDeviceTrustRecords(next, MAX_PAIRED_DEVICES);
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  state.pairedDevices = next;
  return changed;
}

function isDeviceTrustRecordActive(record, now = Date.now()) {
  if (!isPlainObject(record)) {
    return false;
  }
  if (Number(record.revokedAtMs) > 0 && Number(record.revokedAtMs) <= now) {
    return false;
  }
  const trustedUntilMs = Number(record.trustedUntilMs) || 0;
  if (trustedUntilMs > 0 && now >= trustedUntilMs) {
    return false;
  }
  return true;
}

function getActiveDeviceTrustRecord(state, config, deviceId, now = Date.now()) {
  const normalizedDeviceId = cleanText(deviceId || "");
  if (!normalizedDeviceId || !isPlainObject(state?.pairedDevices)) {
    return null;
  }

  const record = normalizeDeviceTrustRecord(state.pairedDevices[normalizedDeviceId], {
    trustTtlMs: config.deviceTrustTtlMs,
    now,
  });
  if (!record || !isDeviceTrustRecordActive(record, now)) {
    return null;
  }
  return record;
}

function markDevicePaired(state, config, deviceId, metadata = {}, now = Date.now()) {
  const normalizedDeviceId = cleanText(deviceId || "");
  if (!normalizedDeviceId) {
    return false;
  }

  if (!isPlainObject(state.pairedDevices)) {
    state.pairedDevices = {};
  }

  const previous = normalizeDeviceTrustRecord(state.pairedDevices[normalizedDeviceId], {
    trustTtlMs: config.deviceTrustTtlMs,
    now,
  });
  const next = {
    pairedAtMs: Number(previous?.pairedAtMs) || now,
    trustedUntilMs: now + config.deviceTrustTtlMs,
    lastAuthenticatedAtMs: now,
    revokedAtMs: 0,
    userAgent: cleanText(metadata.userAgent ?? previous?.userAgent ?? ""),
    standalone: metadata.standalone === true || previous?.standalone === true,
    lastLocale: normalizeSupportedLocale(metadata.lastLocale, previous?.lastLocale),
  };
  state.pairedDevices[normalizedDeviceId] = next;
  trimDeviceTrustRecords(state.pairedDevices, MAX_PAIRED_DEVICES);
  return JSON.stringify(previous ?? null) !== JSON.stringify(next);
}

const TOUCH_DEVICE_TRUST_DEBOUNCE_MS = 60_000;

function touchDeviceTrust(state, config, deviceId, now = Date.now()) {
  const normalizedDeviceId = cleanText(deviceId || "");
  const current = getActiveDeviceTrustRecord(state, config, normalizedDeviceId, now);
  if (!normalizedDeviceId || !current) {
    return false;
  }

  // Debounce: `lastAuthenticatedAtMs` is bumped to `now` on every
  // authenticated request. Without this guard, every `/api/session`
  // (and `/api/bootstrap`) call flags the record as "changed" and the
  // caller runs a full `saveState`, which synchronously stringifies an
  // 8+ MB state.json on the main thread and starves the event loop —
  // driving TLS handshake latency for any in-flight connection into the
  // seconds range. Skip the write when we've touched it recently; the
  // next real change (pairing, revocation, locale update, etc.) still
  // goes through unchanged.
  const previousTouch = Number(current.lastAuthenticatedAtMs) || 0;
  if (previousTouch > 0 && now - previousTouch < TOUCH_DEVICE_TRUST_DEBOUNCE_MS) {
    return false;
  }

  const next = {
    ...current,
    lastAuthenticatedAtMs: now,
  };
  state.pairedDevices[normalizedDeviceId] = next;
  return JSON.stringify(current) !== JSON.stringify(next);
}

function updateDeviceTrustMetadata(state, config, deviceId, metadata = {}, now = Date.now()) {
  const normalizedDeviceId = cleanText(deviceId || "");
  if (!normalizedDeviceId || !isPlainObject(state?.pairedDevices)) {
    return false;
  }

  const current = normalizeDeviceTrustRecord(state.pairedDevices[normalizedDeviceId], {
    trustTtlMs: config.deviceTrustTtlMs,
    now,
  });
  if (!current) {
    return false;
  }

  const next = {
    ...current,
    userAgent: cleanText(metadata.userAgent ?? current.userAgent ?? ""),
    standalone: metadata.standalone === true || (metadata.standalone == null ? current.standalone === true : false),
    lastLocale: normalizeSupportedLocale(metadata.lastLocale, current.lastLocale),
  };
  state.pairedDevices[normalizedDeviceId] = next;
  return JSON.stringify(current) !== JSON.stringify(next);
}

function revokeDeviceTrust(state, config, deviceId, now = Date.now()) {
  const normalizedDeviceId = cleanText(deviceId || "");
  if (!normalizedDeviceId || !isPlainObject(state?.pairedDevices)) {
    return false;
  }

  const current = normalizeDeviceTrustRecord(state.pairedDevices[normalizedDeviceId], {
    trustTtlMs: config.deviceTrustTtlMs,
    now,
  });
  if (!current) {
    return false;
  }

  const next = {
    ...current,
    trustedUntilMs: Math.min(Number(current.trustedUntilMs) || now, now),
    revokedAtMs: now,
  };
  state.pairedDevices[normalizedDeviceId] = next;
  return JSON.stringify(current) !== JSON.stringify(next);
}

function activeTrustedDevices(state, config, now = Date.now()) {
  if (!isPlainObject(state?.pairedDevices)) {
    return [];
  }
  return Object.entries(state.pairedDevices)
    .map(([deviceId, rawRecord]) => ({
      deviceId: cleanText(deviceId || ""),
      record: normalizeDeviceTrustRecord(rawRecord, {
        trustTtlMs: config.deviceTrustTtlMs,
        now,
      }),
    }))
    .filter(({ deviceId, record }) => deviceId && record && isDeviceTrustRecordActive(record, now))
    .sort((left, right) => Number(right.record.lastAuthenticatedAtMs || 0) - Number(left.record.lastAuthenticatedAtMs || 0));
}

function summarizeUserAgentDevice(userAgent) {
  const text = cleanText(userAgent || "");
  if (!text) {
    return "browser";
  }
  if (/iPhone/u.test(text)) {
    return "iphone";
  }
  if (/iPad/u.test(text)) {
    return "ipad";
  }
  if (/Android/u.test(text)) {
    return "android";
  }
  if (/Macintosh|Mac OS X/u.test(text)) {
    return "mac";
  }
  return "browser";
}

function buildDeviceDisplayName({ record, localeInfo, deviceId, locale }) {
  const platformKey = `settings.device.platform.${summarizeUserAgentDevice(record?.userAgent)}`;
  const platformLabel = t(locale, platformKey);
  const modeLabel = t(locale, record?.standalone ? "settings.device.mode.standalone" : "settings.device.mode.browser");
  const localeLabel = localeDisplayName(localeInfo.locale, locale) || localeInfo.locale || "";
  const parts = [platformLabel, modeLabel].filter(Boolean);
  if (localeLabel) {
    parts.push(localeLabel);
  }
  if (parts.length === 0) {
    return `${t(locale, "settings.device.fallbackName")} ${String(deviceId || "").slice(0, 8)}`;
  }
  return parts.join(" · ");
}

function buildDeviceSummary({ config, state, deviceId, record, currentDeviceId, locale }) {
  const subscription = getPushSubscriptionForDevice(state, deviceId);
  const localeInfo = resolveDeviceLocaleInfo(config, state, deviceId);
  return {
    deviceId,
    currentDevice: deviceId === cleanText(currentDeviceId || ""),
    pairedAtMs: Number(record?.pairedAtMs) || 0,
    lastAuthenticatedAtMs: Number(record?.lastAuthenticatedAtMs) || 0,
    trustedUntilMs: Number(record?.trustedUntilMs) || 0,
    pushSubscribed: Boolean(subscription),
    standalone: subscription?.standalone === true || record?.standalone === true,
    locale: localeInfo.locale || "",
    displayName: buildDeviceDisplayName({ record, localeInfo, deviceId, locale }),
  };
}

// Shared between `/api/session` and `/api/bootstrap` so both return an
// identical session shape.
function buildSessionPayload({ config, state, session }) {
  return {
    authenticated: Boolean(session.authenticated),
    expiresAtMs: Number(session.expiresAtMs) || 0,
    pairingAvailable: isPairingAvailableForState(config, state),
    webPushEnabled: config.webPushEnabled,
    httpsEnabled: config.nativeApprovalPublicBaseUrl.startsWith("https://"),
    appVersion: appPackageVersion,
    deviceId: session.deviceId || null,
    temporaryPairing: session.temporaryPairing === true,
    ...buildSessionLocalePayload(config, state, session.deviceId),
  };
}

function buildDevicesResponse({ config, state, session, locale }) {
  return {
    devices: activeTrustedDevices(state, config).map(({ deviceId, record }) =>
      buildDeviceSummary({
        config,
        state,
        deviceId,
        record,
        currentDeviceId: session.deviceId,
        locale,
      })
    ),
  };
}

function readSession(req, config, state) {
  const deviceId = readDeviceId(req, config);
  if (!config.authRequired) {
    return {
      authenticated: true,
      sessionId: "local-noauth",
      pairedAtMs: Date.now(),
      expiresAtMs: 0,
      deviceId,
    };
  }

  const token = parseCookies(req)[sessionCookieName];
  const payload = token ? verifySessionToken(token, config.sessionSecret) : null;
  if (!payload) {
    const trustedRecord = getActiveDeviceTrustRecord(state, config, deviceId);
    if (trustedRecord) {
      return {
        authenticated: true,
        sessionId: "restored-device",
        pairedAtMs: Number(trustedRecord.pairedAtMs) || Date.now(),
        expiresAtMs: Date.now() + config.sessionTtlMs,
        deviceId,
        restoredFromDevice: true,
      };
    }

    return {
      authenticated: false,
      pairingAvailable: isPairingAvailable(config),
      deviceId,
    };
  }

  return {
    authenticated: true,
    sessionId: cleanText(payload.sessionId ?? "") || null,
    pairedAtMs: Number(payload.pairedAtMs) || 0,
    expiresAtMs: Number(payload.expiresAtMs) || 0,
    deviceId,
    temporaryPairing: payload?.temporaryPairing === true,
  };
}

function buildSessionCookie(config) {
  const now = Date.now();
  const payload = {
    sessionId: crypto.randomUUID(),
    pairedAtMs: now,
    expiresAtMs: now + config.sessionTtlMs,
  };
  return signSessionPayload(payload, config.sessionSecret);
}

function readDeviceId(req, config) {
  const token = parseCookies(req)[deviceCookieName];
  const payload = token ? verifySessionToken(token, config.sessionSecret) : null;
  return cleanText(payload?.deviceId ?? "") || null;
}

function buildDeviceCookie(config, existingDeviceId = "") {
  const now = Date.now();
  const payload = {
    deviceId: cleanText(existingDeviceId || "") || crypto.randomUUID(),
    pairedAtMs: now,
    expiresAtMs: now + 180 * 24 * 60 * 60 * 1000,
  };
  return signSessionPayload(payload, config.sessionSecret);
}

function buildCookieHeader(name, { value, maxAgeSecs, secure }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSecs}`,
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function buildSetCookieHeader({ value, maxAgeSecs, secure = false }) {
  return buildCookieHeader(sessionCookieName, { value, maxAgeSecs, secure });
}

function setSessionCookie(res, config) {
  const secure = config.nativeApprovalPublicBaseUrl.startsWith("https://");
  const token = buildSessionCookie(config);
  res.setHeader("Set-Cookie", buildSetCookieHeader({
    value: token,
    maxAgeSecs: Math.max(1, Math.floor(config.sessionTtlMs / 1000)),
    secure,
  }));
}

function setTemporarySessionCookie(res, config) {
  const secure = config.nativeApprovalPublicBaseUrl.startsWith("https://");
  const now = Date.now();
  const token = signSessionPayload({
    sessionId: crypto.randomUUID(),
    pairedAtMs: now,
    expiresAtMs: now + config.sessionTtlMs,
    temporaryPairing: true,
  }, config.sessionSecret);
  res.setHeader("Set-Cookie", buildSetCookieHeader({
    value: token,
    maxAgeSecs: Math.max(1, Math.floor(config.sessionTtlMs / 1000)),
    secure,
  }));
}

function clearSessionCookie(res, config) {
  const secure = config.nativeApprovalPublicBaseUrl.startsWith("https://");
  res.setHeader("Set-Cookie", buildSetCookieHeader({ value: "", maxAgeSecs: 0, secure }));
}

function setPairingCookies(res, config, existingDeviceId = "") {
  const secure = config.nativeApprovalPublicBaseUrl.startsWith("https://");
  const sessionToken = buildSessionCookie(config);
  const deviceToken = buildDeviceCookie(config, existingDeviceId);
  res.setHeader("Set-Cookie", [
    buildCookieHeader(sessionCookieName, {
      value: sessionToken,
      maxAgeSecs: Math.max(1, Math.floor(config.sessionTtlMs / 1000)),
      secure,
    }),
    buildCookieHeader(deviceCookieName, {
      value: deviceToken,
      maxAgeSecs: 180 * 24 * 60 * 60,
      secure,
    }),
  ]);
}

function clearAuthCookies(res, config) {
  const secure = config.nativeApprovalPublicBaseUrl.startsWith("https://");
  res.setHeader("Set-Cookie", [
    buildCookieHeader(sessionCookieName, { value: "", maxAgeSecs: 0, secure }),
    buildCookieHeader(deviceCookieName, { value: "", maxAgeSecs: 0, secure }),
  ]);
}

function normalizePushSubscriptionBody(payload, deviceId) {
  const endpoint = cleanText(payload?.subscription?.endpoint ?? payload?.endpoint ?? "");
  const p256dh = cleanText(
    payload?.subscription?.keys?.p256dh ??
    payload?.keys?.p256dh ??
    payload?.p256dh ??
    ""
  );
  const auth = cleanText(
    payload?.subscription?.keys?.auth ??
    payload?.keys?.auth ??
    payload?.auth ??
    ""
  );
  if (!endpoint || !p256dh || !auth || !deviceId) {
    return null;
  }
  return normalizePushSubscriptionRecord({
    id: pushSubscriptionId(endpoint),
    endpoint,
    keys: { p256dh, auth },
    deviceId,
    userAgent: cleanText(payload?.userAgent ?? ""),
    standalone: payload?.standalone === true,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  });
}

function buildPushStatusResponse(config, state, session) {
  const current = getPushSubscriptionForDevice(state, session.deviceId);
  return {
    enabled: config.webPushEnabled,
    secureOrigin: config.nativeApprovalPublicBaseUrl.startsWith("https://"),
    vapidPublicKey: config.webPushEnabled ? config.webPushVapidPublicKey : "",
    subject: config.webPushEnabled ? config.webPushSubject : "",
    deviceId: session.deviceId || null,
    subscribed: Boolean(current),
    subscriptionId: current?.id || null,
    lastSuccessfulDeliveryAtMs: Number(current?.lastSuccessfulDeliveryAtMs) || 0,
  };
}

function requestUserAgent(req) {
  return cleanText(req.headers?.["user-agent"] ?? "");
}

function updateCurrentDeviceSnapshot(state, config, deviceId, metadata = {}) {
  if (!deviceId) {
    return false;
  }
  return updateDeviceTrustMetadata(state, config, deviceId, metadata);
}

async function sendPushTestToDevice({ config, state, session }) {
  if (!config.webPushEnabled) {
    throw new Error("web-push-disabled");
  }
  const subscription = getPushSubscriptionForDevice(state, session.deviceId);
  if (!subscription) {
    throw new Error("push-subscription-not-found");
  }

  const locale = resolveDeviceLocaleInfo(config, state, session.deviceId).locale;
  const payload = JSON.stringify({
    title: t(locale, "server.pushTest.title"),
    body: t(locale, "server.pushTest.body"),
    tag: `push-test:${subscription.deviceId}`,
    data: {
      url: `${config.nativeApprovalPublicBaseUrl}/app`,
      kind: "info",
      token: "",
      stableId: `push-test:${subscription.deviceId}`,
    },
  });

  await webPush.sendNotification(
    {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
    },
    payload
  );

  const now = Date.now();
  const stored = normalizePushSubscriptionRecord(state.pushSubscriptions?.[subscription.id]);
  if (stored) {
    stored.lastSuccessfulDeliveryAtMs = now;
    stored.updatedAtMs = now;
    state.pushSubscriptions[subscription.id] = serializePushSubscriptionRecord(stored);
  }
}

function isPairingAvailable(config) {
  if (!config.authRequired) {
    return false;
  }
  if (!config.pairingCode && !config.pairingToken) {
    return false;
  }
  return !(config.pairingExpiresAtMs > 0 && Date.now() >= config.pairingExpiresAtMs);
}

function currentPairingCredential(config) {
  const token = cleanText(config?.pairingToken ?? "");
  if (token) {
    return `token:${token}`;
  }
  const code = cleanText(config?.pairingCode ?? "").toUpperCase();
  if (code) {
    return `code:${code}`;
  }
  return "";
}

function pairingCredentialConsumed(config, state) {
  const current = currentPairingCredential(config);
  if (!current) {
    return false;
  }
  const consumedAtMs = Number(state?.pairingConsumedAt) || 0;
  const consumedCredential = cleanText(state?.pairingConsumedCredential ?? "");
  return consumedAtMs > 0 && consumedCredential === current;
}

function isPairingAvailableForState(config, state) {
  return isPairingAvailable(config) && !pairingCodeConsumed(config, state);
}

function pairingCodeConsumed(config, state) {
  const code = cleanText(config?.pairingCode ?? "").toUpperCase();
  if (!code) {
    return false;
  }
  const consumedAtMs = Number(state?.pairingConsumedAt) || 0;
  const consumedCredential = cleanText(state?.pairingConsumedCredential ?? "");
  return consumedAtMs > 0 && consumedCredential === `code:${code}`;
}

function markPairingConsumed(state, credential, now = Date.now()) {
  const current = cleanText(credential || "");
  if (!current) {
    return false;
  }
  const consumedAtMs = Number(state?.pairingConsumedAt) || 0;
  const consumedCredential = cleanText(state?.pairingConsumedCredential ?? "");
  if (consumedAtMs > 0 && consumedCredential === current) {
    return false;
  }
  state.pairingConsumedAt = now;
  state.pairingConsumedCredential = current;
  return true;
}

function validatePairingPayload(payload, config, state) {
  if (!config.authRequired) {
    return { ok: true };
  }
  if (!isPairingAvailable(config)) {
    return { ok: false, error: "pairing-unavailable" };
  }

  const code = cleanText(payload?.code ?? "").toUpperCase();
  const token = cleanText(payload?.token ?? "");
  const matchesCode = code && cleanText(config.pairingCode).toUpperCase() === code;
  const matchesToken = token && cleanText(config.pairingToken) === token;
  if (matchesToken) {
    return { ok: true, credential: `token:${token}` };
  }
  if (matchesCode) {
    if (pairingCodeConsumed(config, state)) {
      return { ok: false, error: "pairing-unavailable" };
    }
    return { ok: true, credential: `code:${code}` };
  }
  return { ok: false, error: "invalid-pairing-credentials" };
}

function readRemoteAddress(req) {
  return cleanText(req.socket?.remoteAddress ?? "");
}

function getActivePairingFailureTimestamps(runtime, remoteAddress, now = Date.now()) {
  const normalizedRemoteAddress = cleanText(remoteAddress || "");
  if (!normalizedRemoteAddress) {
    return [];
  }

  const cutoff = now - PAIRING_RATE_LIMIT_WINDOW_MS;
  const existing = Array.isArray(runtime.pairingAttemptsByRemoteAddress.get(normalizedRemoteAddress))
    ? runtime.pairingAttemptsByRemoteAddress.get(normalizedRemoteAddress)
    : [];
  const next = existing
    .map((value) => Number(value) || 0)
    .filter((value) => value > cutoff);

  if (next.length > 0) {
    runtime.pairingAttemptsByRemoteAddress.set(normalizedRemoteAddress, next);
  } else {
    runtime.pairingAttemptsByRemoteAddress.delete(normalizedRemoteAddress);
  }

  return next;
}

function getPairingRetryAfterSecs(runtime, remoteAddress, now = Date.now()) {
  const failures = getActivePairingFailureTimestamps(runtime, remoteAddress, now);
  if (failures.length < PAIRING_RATE_LIMIT_MAX_ATTEMPTS) {
    return 0;
  }

  const oldestFailure = failures[0];
  return Math.max(1, Math.ceil((oldestFailure + PAIRING_RATE_LIMIT_WINDOW_MS - now) / 1000));
}

function recordPairingFailure(runtime, remoteAddress, now = Date.now()) {
  const normalizedRemoteAddress = cleanText(remoteAddress || "");
  if (!normalizedRemoteAddress) {
    return 0;
  }

  const failures = getActivePairingFailureTimestamps(runtime, normalizedRemoteAddress, now);
  failures.push(now);
  runtime.pairingAttemptsByRemoteAddress.set(normalizedRemoteAddress, failures);
  return getPairingRetryAfterSecs(runtime, normalizedRemoteAddress, now);
}

function clearPairingFailures(runtime, remoteAddress) {
  const normalizedRemoteAddress = cleanText(remoteAddress || "");
  if (!normalizedRemoteAddress) {
    return;
  }
  runtime.pairingAttemptsByRemoteAddress.delete(normalizedRemoteAddress);
}

function writePairingRateLimited(res, retryAfterSecs) {
  res.setHeader("Retry-After", String(Math.max(1, Number(retryAfterSecs) || 1)));
  return writeJson(res, 429, { error: "pairing-rate-limited" });
}

function nonLoopbackIpv4Origins(config) {
  const origins = new Set();
  let baseUrl;
  try {
    baseUrl = new URL(config.nativeApprovalPublicBaseUrl);
  } catch {
    return origins;
  }

  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) {
        continue;
      }
      const family = typeof entry.family === "string" ? entry.family : String(entry.family || "");
      if (family !== "IPv4") {
        continue;
      }
      const ip = cleanText(entry.address || "");
      if (!ip || ip === "127.0.0.1") {
        continue;
      }
      const next = new URL(baseUrl.toString());
      next.hostname = ip;
      next.pathname = "";
      next.search = "";
      next.hash = "";
      origins.add(next.origin);
    }
  }

  return origins;
}

function trustedMutationOrigins(config) {
  const origins = new Set();
  let baseUrl;
  try {
    baseUrl = new URL(config.nativeApprovalPublicBaseUrl);
  } catch {
    return origins;
  }

  baseUrl.pathname = "";
  baseUrl.search = "";
  baseUrl.hash = "";
  origins.add(baseUrl.origin);

  for (const host of ["localhost", "127.0.0.1"]) {
    const next = new URL(baseUrl.toString());
    next.hostname = host;
    origins.add(next.origin);
  }

  for (const origin of nonLoopbackIpv4Origins(config)) {
    origins.add(origin);
  }

  return origins;
}

function requestOrigin(req) {
  const originHeader = cleanText(req.headers?.origin ?? "");
  if (originHeader && originHeader !== "null") {
    try {
      return new URL(originHeader).origin;
    } catch {
      return "__invalid__";
    }
  }

  const refererHeader = cleanText(req.headers?.referer ?? "");
  if (refererHeader) {
    try {
      return new URL(refererHeader).origin;
    } catch {
      return "__invalid__";
    }
  }

  return "";
}

function requireTrustedMutationOrigin(req, res, config) {
  const origin = requestOrigin(req);
  if (!origin) {
    if (isLoopbackRequest(req)) {
      return true;
    }
    writeJson(res, 403, { error: "origin-not-allowed" });
    return false;
  }
  if (origin === "__invalid__") {
    writeJson(res, 403, { error: "origin-not-allowed" });
    return false;
  }
  if (!trustedMutationOrigins(config).has(origin)) {
    writeJson(res, 403, { error: "origin-not-allowed" });
    return false;
  }
  return true;
}

function requireMutatingApiSession(req, res, config, state) {
  if (!requireTrustedMutationOrigin(req, res, config)) {
    return null;
  }
  return requireApiSession(req, res, config, state);
}

function requireApiSession(req, res, config, state) {
  const session = readSession(req, config, state);
  if (session.authenticated) {
    return session;
  }

  writeJson(res, 401, {
    error: "authentication-required",
    pairingAvailable: isPairingAvailableForState(config, state),
  });
  return null;
}

function renderMessageHtml(messageText, fallbackHtml = "<p></p>") {
  return renderMarkdownHtml(messageText, { fallbackHtml });
}

function historyItemByToken(runtime, kind, token) {
  return runtime.recentHistoryItems.find(
    (item) => item.kind === kind && item.token === token
  ) ?? null;
}

function listLatestPersistedUserInputRequests({ config, runtime, state }) {
  const byToken = new Map();
  for (const userInputRequest of runtime.userInputRequestsByToken.values()) {
    byToken.set(userInputRequest.token, userInputRequest);
  }

  const pending = isPlainObject(state.pendingUserInputRequests) ? state.pendingUserInputRequests : {};
  for (const raw of Object.values(pending)) {
    const restored = restoreGenericUserInputRequest({ config, raw });
    if (!restored) {
      continue;
    }
    const existing = byToken.get(restored.token);
    if (!existing || Number(restored.lastSeenAtMs ?? 0) >= Number(existing.lastSeenAtMs ?? 0)) {
      byToken.set(restored.token, restored);
      registerGenericUserInputRequest(runtime, restored);
    }
  }

  return Array.from(byToken.values());
}

function hasLiveConversationRequest(runtime, conversationId, requestId) {
  const threadState = runtime.threadStates.get(cleanText(conversationId));
  if (!Array.isArray(threadState?.requests) || requestId == null) {
    return false;
  }

  const normalizedRequestId = String(requestId);
  return threadState.requests.some(
    (request) => isPlainObject(request) && request.id != null && String(request.id) === normalizedRequestId
  );
}

function shouldShowPlanRequestInPending(runtime, planRequest) {
  return (
    Boolean(planRequest?.isLiveRequestActive) ||
    hasLiveConversationRequest(runtime, planRequest?.conversationId, planRequest?.requestId)
  );
}

function shouldShowUserInputRequestInPending(runtime, userInputRequest) {
  return (
    Boolean(userInputRequest?.isLiveRequestActive) ||
    hasLiveConversationRequest(runtime, userInputRequest?.conversationId, userInputRequest?.requestId)
  );
}

function buildPendingInboxItems(runtime, state, config, locale) {
  const now = Date.now();
  const items = [];

  for (const approval of runtime.nativeApprovalsByToken.values()) {
    if (approval.resolved || approval.resolving) {
      continue;
    }
    items.push({
      kind: "approval",
      token: approval.token,
      threadId: cleanText(approval.conversationId || ""),
      threadLabel: approval.threadLabel || "",
      title: formatLocalizedTitle(locale, "server.title.approval", approval.threadLabel),
      summary: formatNotificationBody(approval.messageText, 100) || approval.messageText,
      primaryLabel: t(locale, "server.action.review"),
      createdAtMs: Number(approval.createdAtMs) || now,
      provider: normalizeProvider(approval.provider),
    });
  }

  for (const planRequest of runtime.planRequestsByToken.values()) {
    if (planRequest.resolved || planRequest.resolving || isPlanRequestExpired(planRequest, now)) {
      continue;
    }
    if (!shouldShowPlanRequestInPending(runtime, planRequest)) {
      continue;
    }
    items.push({
      kind: "plan",
      token: planRequest.token,
      threadId: cleanText(planRequest.conversationId || ""),
      threadLabel: planRequest.threadLabel || "",
      title: formatLocalizedTitle(locale, "server.title.plan", planRequest.threadLabel),
      summary: formatNotificationBody(planRequest.messageText, 100) || planRequest.messageText,
      primaryLabel: t(locale, "server.action.review"),
      createdAtMs: Number(planRequest.createdAtMs) || now,
      provider: "codex",
    });
  }

  for (const userInputRequest of listLatestPersistedUserInputRequests({ config, runtime, state })) {
    if (userInputRequest.resolved || userInputRequest.resolving || isGenericUserInputRequestExpired(userInputRequest, now)) {
      continue;
    }
    if (!shouldShowUserInputRequestInPending(runtime, userInputRequest)) {
      continue;
    }
    items.push({
      kind: "choice",
      token: userInputRequest.token,
      threadId: cleanText(userInputRequest.conversationId || ""),
      threadLabel: userInputRequest.threadLabel || "",
      title: formatLocalizedTitle(
        locale,
        userInputRequest.supported ? "server.title.choice" : "server.title.choiceReadOnly",
        userInputRequest.threadLabel
      ),
      summary: userInputRequest.notificationText || formatNotificationBody(userInputRequest.messageText, 100),
      primaryLabel: t(locale, userInputRequest.supported ? "server.action.select" : "server.action.detail"),
      createdAtMs: Number(userInputRequest.createdAtMs) || now,
      provider: "codex",
    });
  }

  for (const draft of runtime.moltbookDraftsByToken.values()) {
    if (draft.decision) continue;
    const title = draft.postTitle ? `draft → ${draft.postTitle}` : "Moltbook draft";
    const draftThreadLabel = draft.postTitle || "Moltbook";
    items.push({
      kind: "moltbook_draft",
      token: draft.token,
      threadId: "moltbook",
      threadLabel: draftThreadLabel,
      title,
      summary: draft.contextSummary || String(draft.draftText || "").slice(0, 160),
      primaryLabel: t(locale, "server.action.review"),
      createdAtMs: Number(draft.createdAtMs) || now,
      provider: "moltbook",
      draftType: draft.draftType || "reply",
    });
  }

  for (const task of runtime.a2aTasksByToken.values()) {
    if (task.status !== "submitted") continue;
    items.push({
      kind: "a2a_task",
      token: task.token,
      threadId: "a2a",
      threadLabel: cleanText(task.instruction || "").slice(0, 80),
      title: `A2A: ${cleanText(task.instruction || "").slice(0, 80)}`,
      summary: cleanText(task.instruction || "").slice(0, 160),
      primaryLabel: t(locale, "server.action.review"),
      createdAtMs: Number(task.createdAtMs) || now,
      provider: "a2a",
    });
  }

  for (const share of runtime.threadSharesByToken.values()) {
    if (share.decision) continue;
    const title = share.sourceLabel
      ? `${share.sourceLabel} → ${share.targetLabel || share.targetTool}`
      : `→ ${share.targetLabel || share.targetTool}`;
    items.push({
      kind: "thread_share",
      token: share.token,
      threadId: "thread_share",
      threadLabel: "Thread Share",
      title,
      summary: String(share.content || "").slice(0, 160),
      primaryLabel: t(locale, "server.action.review"),
      createdAtMs: Number(share.createdAtMs) || now,
      provider: "viveworker",
    });
  }

  // Moltbook reply items intentionally do not appear in the unhandled list.
  // Reply drafting is delegated to Codex/Claude Desktop via the
  // `viveworker moltbook` CLI, so they live in the timeline only.

  return items.sort((left, right) => Number(right.createdAtMs ?? 0) - Number(left.createdAtMs ?? 0));
}

function buildCompletedInboxItems(runtime, state, config, locale) {
  const items = normalizeHistoryItems(state.recentHistoryItems ?? runtime.recentHistoryItems, config.maxHistoryItems);
  runtime.recentHistoryItems = items;
  const completedKinds = new Set(["assistant_final", "approval", "moltbook_reply", "moltbook_draft", "thread_share", "a2a_task_result"]);

  // Infrequent kinds (A2A, thread_share) get evicted from the fixed-size
  // history FIFO by the high volume of approval/assistant_final entries.
  // Fall back to recentTimelineEntries so completed A2A tasks are never lost
  // while they're still within the timeline window.
  const infrequentKinds = new Set(["a2a_task_result", "thread_share"]);
  const historyStableIds = new Set(items.map((i) => i.stableId).filter(Boolean));
  const timelineEntries = (runtime.recentTimelineEntries ?? [])
    .filter((e) => infrequentKinds.has(cleanText(e?.kind || "")) && !historyStableIds.has(e.stableId));
  const merged = [...items, ...timelineEntries];

  return merged
    .filter((item) => {
      const k = cleanText(item?.kind || "");
      if (!completedKinds.has(k)) return false;
      // Only resolved approvals (readOnly = true).  Moltbook reply/draft items
      // are gated the same way so pending entries don't double-show as
      // completed while they're also surfaced via moltbookItemsByToken /
      // moltbookDraftsByToken on the pending list.
      if ((k === "approval" || k === "moltbook_reply" || k === "moltbook_draft") && !item.readOnly) return false;
      return true;
    })
    .slice()
    .sort((left, right) => Number(right.createdAtMs ?? 0) - Number(left.createdAtMs ?? 0))
    .map((item) => ({
      kind: item.kind,
      token: item.token,
      threadId: cleanText(item.threadId || extractConversationIdFromStableId(item.stableId) || ""),
      threadLabel: item.threadLabel || "",
      title: item.kind === "assistant_final"
        ? (item.threadLabel ? formatTitle(kindTitle(locale, item.kind), item.threadLabel) : item.title)
        : (item.kind === "a2a_task_result" && item.instruction)
          ? cleanText(item.instruction).slice(0, 80)
          : (item.kind === "moltbook_reply" || item.kind === "moltbook_draft")
            ? cleanText(item.summary || item.messageText || "").slice(0, 80) || item.title
            : item.title || kindTitle(locale, item.kind),
      summary: item.summary,
      fileRefs: normalizeTimelineFileRefs(item.fileRefs ?? []),
      primaryLabel: t(locale, "server.action.detail"),
      createdAtMs: item.createdAtMs,
      provider: normalizeProvider(item.provider),
      ...(item.draftType != null ? { draftType: item.draftType } : {}),
    }));
}

async function buildDiffInboxItems(runtime, state, config, locale) {
  return (await getDiffThreadGroupsCached(runtime, state, config)).map((group) => ({
    kind: "diff_thread",
    token: group.token,
    threadId: group.threadId,
    threadLabel: group.threadLabel || "",
    sourceMode: cleanText(group.sourceMode || ""),
    title: cleanText(group.threadLabel || "") || kindTitle(locale, "diff_thread"),
    summary: t(locale, "diff.threadSummary", { count: group.changedFileCount }),
    changedFileCount: group.changedFileCount,
    fileRefs: normalizeTimelineFileRefs(group.files.map((file) => file.fileRef)),
    latestChangedAtMs: group.latestChangedAtMs,
    latestChangeType: cleanText(group.latestChangeType || ""),
    latestChangeFileRefs: normalizeTimelineFileRefs(group.latestChangeFileRefs ?? []),
    diffAddedLines: group.diffAddedLines,
    diffRemovedLines: group.diffRemovedLines,
    files: Array.isArray(group.files)
      ? group.files.map((fileGroup) => ({
          fileRef: cleanTimelineFileRef(fileGroup.fileRef || ""),
          oldFileRef: cleanTimelineFileRef(fileGroup.oldFileRef || ""),
          newFileRef: cleanTimelineFileRef(fileGroup.newFileRef || ""),
          changeType: normalizeTimelineFileEventType(fileGroup.changeType || ""),
        }))
      : [],
    primaryLabel: t(locale, "server.action.detail"),
    createdAtMs: group.latestChangedAtMs,
  }));
}

function diffThreadToken(threadId, threadLabel = "") {
  const normalizedThreadId = cleanText(threadId || "");
  const normalizedThreadLabel = cleanText(threadLabel || "");
  return historyToken(`diff_thread:${normalizedThreadId || normalizedThreadLabel || "unknown"}`);
}

async function buildDiffThreadGroups(runtime, state, config) {
  const items = normalizeCodeEvents(
    state.recentCodeEvents ?? runtime.recentCodeEvents,
    config.maxCodeEvents
  );
  runtime.recentCodeEvents = items;

  const repoRootCache = new Map();
  const relevantItems = items
    .slice()
    .sort((left, right) => Number(right.createdAtMs ?? 0) - Number(left.createdAtMs ?? 0));
  const candidatesByRepoRoot = new Map();
  const nonGitRelevantItems = [];

  for (const item of relevantItems) {
    const repoRoot = await resolveCodeEventRepoRoot(item, repoRootCache);
    if (!repoRoot) {
      nonGitRelevantItems.push(item);
      continue;
    }
    const candidates = expandCodeEventOwnershipCandidates(item, repoRoot);
    if (candidates.length === 0) {
      continue;
    }
    const existing = candidatesByRepoRoot.get(repoRoot) ?? [];
    existing.push(...candidates);
    candidatesByRepoRoot.set(repoRoot, existing);
  }

  const groupsByThread = new Map();

  for (const [repoRoot, candidates] of candidatesByRepoRoot.entries()) {
    const currentChanges = await buildCurrentUnstagedChangesForRepo({ repoRoot, candidates });
    for (const change of currentChanges) {
      const owner = resolveCurrentChangeOwner(change, candidates);
      if (!owner) {
        continue;
      }

      addChangeToDiffThreadGroup({
        groupsByThread,
        threadId: cleanText(owner.threadId || ""),
        threadLabel: cleanText(owner.threadLabel || ""),
        fallbackKey: cleanText(change.fileRef || change.newFileRef || change.oldFileRef || ""),
        sourceMode: "git_current",
        change,
        createdAtMs: Number(owner.createdAtMs) || 0,
      });
    }
  }

  const latestNonGitChangesByIdentity = new Map();
  for (const item of nonGitRelevantItems) {
    const changes = buildNonGitCodeChangeEntries(item);
    for (const change of changes) {
      const identity = nonGitCodeChangeIdentity(change);
      if (!identity || latestNonGitChangesByIdentity.has(identity)) {
        continue;
      }
      latestNonGitChangesByIdentity.set(identity, change);
    }
  }

  for (const change of latestNonGitChangesByIdentity.values()) {
    addChangeToDiffThreadGroup({
      groupsByThread,
      threadId: cleanText(change.threadId || ""),
      threadLabel: cleanText(change.threadLabel || ""),
      fallbackKey: cleanText(change.fileRef || change.newFileRef || change.oldFileRef || ""),
      sourceMode: "non_git_latest",
      change,
      createdAtMs: Number(change.createdAtMs) || 0,
    });
  }

  return [...groupsByThread.values()]
    .map((group) => {
      const files = [...group.filesByRef.values()]
        .map((fileGroup) => ({
          fileRef: fileGroup.fileRef,
          oldFileRef: fileGroup.oldFileRef,
          newFileRef: fileGroup.newFileRef,
          fileLabel: fileGroup.fileLabel,
          changeType: normalizeTimelineFileEventType(fileGroup.changeType),
          fileEventTypes: Array.isArray(fileGroup.fileEventTypes)
            ? fileGroup.fileEventTypes
            : [...fileGroup.fileEventTypes.values()],
          addedLines: fileGroup.addedLines,
          removedLines: fileGroup.removedLines,
          latestChangedAtMs: fileGroup.latestChangedAtMs,
          sections: fileGroup.sections,
        }))
        .sort((left, right) => Number(right.latestChangedAtMs ?? 0) - Number(left.latestChangedAtMs ?? 0));

      const latestChangedAtMs = Math.max(0, ...files.map((fileGroup) => Number(fileGroup.latestChangedAtMs) || 0));
      const latestFiles = files.filter((fileGroup) => Number(fileGroup.latestChangedAtMs || 0) === latestChangedAtMs);
      const latestChangeTypes = [...new Set(latestFiles.map((fileGroup) => normalizeTimelineFileEventType(fileGroup.changeType)).filter(Boolean))];
      const latestChangeFileRefs = normalizeTimelineFileRefs(
        latestFiles
          .map((fileGroup) => cleanTimelineFileRef(fileGroup.fileRef || fileGroup.newFileRef || fileGroup.oldFileRef || ""))
          .filter(Boolean)
      );
      const diffAddedLines = files.reduce((sum, fileGroup) => sum + Math.max(0, Number(fileGroup.addedLines) || 0), 0);
      const diffRemovedLines = files.reduce((sum, fileGroup) => sum + Math.max(0, Number(fileGroup.removedLines) || 0), 0);

      return {
        kind: "diff_thread",
        token: group.token,
        threadId: group.threadId,
        threadLabel: group.threadLabel,
        sourceMode: cleanText(group.sourceMode || ""),
        changedFileCount: files.length,
        latestChangedAtMs,
        latestChangeType: latestChangeTypes.length === 1 ? latestChangeTypes[0] : "",
        latestChangeFileRefs,
        diffAddedLines,
        diffRemovedLines,
        files,
      };
    })
    .filter((group) => !shouldExcludeCodeThread(runtime, group.threadId))
    .filter((group) => group.changedFileCount > 0)
    .sort((left, right) => Number(right.latestChangedAtMs ?? 0) - Number(left.latestChangedAtMs ?? 0));
}

// Split into two halves so `/api/inbox` (pending + completed) returns
// without waiting on the diff build, which spawns `git` subprocesses per
// tracked repo inside `buildCurrentUnstagedChangesForRepo`. The diff half
// is served from `/api/inbox/diff` and fetched separately by the PWA so
// it doesn't block first paint of the inbox/completed lists.
function buildInboxFastResponse(runtime, state, config, locale) {
  return {
    pending: buildPendingInboxItems(runtime, state, config, locale),
    completed: buildCompletedInboxItems(runtime, state, config, locale),
  };
}

async function buildInboxDiffResponse(runtime, state, config, locale) {
  return {
    diff: await buildDiffInboxItems(runtime, state, config, locale),
  };
}

function buildOperationalTimelineEntries(runtime, state, config, locale) {
  const now = Date.now();
  const items = [];

  for (const approval of runtime.nativeApprovalsByToken.values()) {
    if (approval.resolved || approval.resolving) {
      continue;
    }
    items.push(
      normalizeTimelineEntry({
        stableId: pendingApprovalStableId(approval),
        token: approval.token,
        kind: "approval",
        threadId: cleanText(approval.conversationId || ""),
        threadLabel: approval.threadLabel,
        title: formatLocalizedTitle(locale, "server.title.approval", approval.threadLabel),
        summary: formatNotificationBody(approval.messageText, 180) || approval.messageText,
        messageText: approval.messageText,
        outcome: "pending",
        createdAtMs: Number(approval.createdAtMs) || now,
        provider: normalizeProvider(approval.provider),
      })
    );
  }

  for (const planRequest of runtime.planRequestsByToken.values()) {
    if (planRequest.resolved || planRequest.resolving || isPlanRequestExpired(planRequest, now)) {
      continue;
    }
    if (!shouldShowPlanRequestInPending(runtime, planRequest)) {
      continue;
    }
    items.push(
      normalizeTimelineEntry({
        stableId: pendingPlanStableId(planRequest),
        token: planRequest.token,
        kind: "plan",
        threadId: cleanText(planRequest.conversationId || ""),
        threadLabel: planRequest.threadLabel,
        title: formatLocalizedTitle(locale, "server.title.plan", planRequest.threadLabel),
        summary: formatNotificationBody(planRequest.messageText, 180) || planRequest.messageText,
        messageText: planRequest.messageText,
        outcome: "pending",
        createdAtMs: Number(planRequest.createdAtMs) || now,
        provider: "codex",
      })
    );
  }

  for (const userInputRequest of listLatestPersistedUserInputRequests({ config, runtime, state })) {
    if (userInputRequest.resolved || userInputRequest.resolving || isGenericUserInputRequestExpired(userInputRequest, now)) {
      continue;
    }
    if (!shouldShowUserInputRequestInPending(runtime, userInputRequest)) {
      continue;
    }
    items.push(
      normalizeTimelineEntry({
        stableId: pendingChoiceStableId(userInputRequest),
        token: userInputRequest.token,
        kind: "choice",
        threadId: cleanText(userInputRequest.conversationId || ""),
        threadLabel: userInputRequest.threadLabel,
        title: formatLocalizedTitle(
          locale,
          userInputRequest.supported ? "server.title.choice" : "server.title.choiceReadOnly",
          userInputRequest.threadLabel
        ),
        summary: userInputRequest.notificationText || formatNotificationBody(userInputRequest.messageText, 180),
        messageText: userInputRequest.messageText,
        outcome: "pending",
        createdAtMs: Number(userInputRequest.createdAtMs) || now,
        provider: "codex",
      })
    );
  }

  for (const historyItem of normalizeHistoryItems(state.recentHistoryItems ?? runtime.recentHistoryItems, config.maxHistoryItems)) {
    let historyKind = historyItem.kind;
    let historySummary = historyItem.summary;
    let historyMessageText = historyItem.messageText;
    let historyTitle = historyItem.threadLabel ? formatTitle(kindTitle(locale, historyItem.kind), historyItem.threadLabel) : historyItem.title;
    let historySuggestions = [];

    if (historyItem.kind === "assistant_final" || historyItem.kind === "completion") {
      const ambientSuggestionsEnvelope = parseAmbientSuggestionsEnvelope(historyItem.messageText ?? "");
      if (ambientSuggestionsEnvelope?.type === "metadata") {
        continue;
      }
      if (ambientSuggestionsEnvelope?.type === "suggestions") {
        const ambientSuggestions = ambientSuggestionsEnvelope.suggestions;
        historyKind = "ambient_suggestions";
        historyTitle = kindTitle(locale, historyKind);
        historySummary = ambientSuggestionsSummary(locale, ambientSuggestions);
        historyMessageText = ambientSuggestionsMessageText(locale, ambientSuggestions);
        historySuggestions = ambientSuggestions;
      }
    }

    if (!timelineKinds.has(historyKind)) {
      continue;
    }
    items.push(
      normalizeTimelineEntry({
        stableId: historyItem.stableId,
        token: historyItem.token,
        kind: historyKind,
        threadId: cleanText(extractConversationIdFromStableId(historyItem.stableId) || ""),
        threadLabel: historyItem.threadLabel,
        title: historyTitle,
        summary: historySummary,
        messageText: historyMessageText,
        outcome: historyItem.outcome,
        createdAtMs: historyItem.createdAtMs,
        provider: normalizeProvider(historyItem.provider),
        ...(historySuggestions.length > 0 && historyKind === "ambient_suggestions" ? { suggestions: historySuggestions } : {}),
      })
    );
  }

  return items.filter(Boolean);
}

function sanitizeTimelineThreadFilterLabel(value, threadId = "") {
  const normalized = cleanText(value || "");
  if (!normalized) {
    return "";
  }

  const normalizedThreadId = cleanText(threadId || "");
  if (normalizedThreadId && (normalized === normalizedThreadId || normalized === shortId(normalizedThreadId))) {
    return "";
  }

  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}$/iu.test(normalized)) {
    return "";
  }

  if (looksLikeGeneratedThreadTitle(normalized)) {
    return "";
  }

  return normalized;
}

function buildTimelineThreads(entries, config) {
  const byThread = new Map();
  for (const entry of entries) {
    const threadId = cleanText(entry.threadId || "");
    if (!threadId || threadId === "moltbook" || threadId.startsWith("draft:") || (entry.kind || "").startsWith("moltbook_")) {
      continue;
    }
    const preferredLabel =
      sanitizeTimelineThreadFilterLabel(entry.threadLabel || "", threadId) ||
      t(DEFAULT_LOCALE, "server.fallback.codexTask", { provider: providerDisplayName(DEFAULT_LOCALE, entry?.provider) });
    const existing = byThread.get(threadId);
    if (!existing) {
      byThread.set(threadId, {
        id: threadId,
        label: preferredLabel,
        latestAtMs: Number(entry.createdAtMs) || 0,
        preview: cleanText(entry.summary || entry.title || ""),
        entryCount: 1,
      });
      continue;
    }
    existing.entryCount += 1;
    if (Number(entry.createdAtMs) > Number(existing.latestAtMs)) {
      existing.latestAtMs = Number(entry.createdAtMs) || existing.latestAtMs;
      existing.label = preferredLabel || existing.label;
      existing.preview = cleanText(entry.summary || entry.title || "") || existing.preview;
    }
  }

  return [...byThread.values()]
    .sort((left, right) => Number(right.latestAtMs ?? 0) - Number(left.latestAtMs ?? 0))
    .slice(0, config.maxTimelineThreads);
}

function buildTimelineResponse(runtime, state, config, locale) {
  const messageEntries = normalizeTimelineEntries(
    state.recentTimelineEntries ?? runtime.recentTimelineEntries,
    config.maxTimelineEntries
  );
  runtime.recentTimelineEntries = messageEntries;
  const entries = normalizeTimelineEntries(
    [...messageEntries, ...buildOperationalTimelineEntries(runtime, state, config, locale)],
    config.maxTimelineEntries
  ).map((entry) => ({
    kind: entry.kind,
    token: entry.token,
    title: entry.title,
    threadId: entry.threadId,
    threadLabel: entry.threadLabel,
    summary: entry.summary,
    fileEventType: normalizeTimelineFileEventType(entry.fileEventType ?? ""),
    imageUrls: buildTimelineEntryImageUrls(entry),
    fileRefs: normalizeTimelineFileRefs(entry.fileRefs ?? []),
    diffAvailable: Boolean(entry.diffAvailable),
    diffAddedLines: Math.max(0, Number(entry.diffAddedLines) || 0),
    diffRemovedLines: Math.max(0, Number(entry.diffRemovedLines) || 0),
    outcome: entry.outcome || "",
    createdAtMs: entry.createdAtMs,
    provider: normalizeProvider(entry.provider),
    ...(entry.draftType != null ? { draftType: entry.draftType } : {}),
  }));

  return {
    threads: buildTimelineThreads(entries, config),
    entries,
  };
}

function buildPendingApprovalDetail(runtime, state, approval, locale) {
  const previousContext = buildPreviousApprovalContext(runtime, approval);
  const approvalKind = cleanText(approval.kind || "");
  const autoPilotReview = buildAutoPilotManualReview(runtime, state, approval, locale);
  const detail = {
    kind: "approval",
    approvalKind,
    provider: normalizeProvider(approval.provider),
    token: approval.token,
    title: formatLocalizedTitle(locale, "server.title.approval", approval.threadLabel),
    threadLabel: approval.threadLabel || "",
    createdAtMs: Number(approval.createdAtMs) || 0,
    messageHtml: renderMessageHtml(approval.messageText, `<p>${escapeHtml(t(locale, "detail.approvalRequested"))}</p>`),
    fileRefs: normalizeTimelineFileRefs(approval.fileRefs ?? []),
    diffText: normalizeTimelineDiffText(approval.diffText ?? ""),
    diffAvailable: approval.diffAvailable === true || Boolean(approval.diffText),
    diffSource: normalizeTimelineDiffSource(approval.diffSource ?? ""),
    diffAddedLines: Math.max(0, Number(approval.diffAddedLines) || 0),
    diffRemovedLines: Math.max(0, Number(approval.diffRemovedLines) || 0),
    previousContext,
    autoPilotReview,
    readOnly: approval.readOnly === true,
    actions: approval.readOnly === true
      ? []
      : [
          { label: t(locale, "server.action.approve"), tone: "primary", url: `/api/items/approval/${encodeURIComponent(approval.token)}/accept`, body: {} },
          { label: t(locale, "server.action.reject"), tone: "danger", url: `/api/items/approval/${encodeURIComponent(approval.token)}/decline`, body: {} },
        ],
  };
  if (approvalKind === "plan") {
    const planText = String(approval.planText || "");
    detail.planText = planText;
    detail.planHtml = planText
      ? renderMessageHtml(planText, `<p>${escapeHtml(t(locale, "detail.planReady"))}</p>`)
      : "";
  }
  if (approvalKind === "question") {
    detail.questions = Array.isArray(approval.questions) ? approval.questions : [];
    detail.answerUrl = `/api/items/question/${encodeURIComponent(approval.token)}/answer`;
    // Question answers are submitted via answerUrl; remove approve/reject actions.
    detail.actions = [];
  }
  return detail;
}

function buildAutoPilotManualReview(runtime, state, approval, locale) {
  if (!isPlainObject(approval) || approval.readOnly === true) {
    return null;
  }
  if (cleanText(approval.kind || "") !== "file") {
    return null;
  }
  return buildAutoPilotWriteManualReview(runtime, state, approval, locale);
}

function buildAutoPilotWriteManualReview(runtime, state, approval, locale) {
  const writesEnabled = isAutoPilotTrustedWritesEnabled(state);
  if (!writesEnabled) {
    return {
      title: t(locale, "detail.autoPilot.manualTitle"),
      body: t(locale, "detail.autoPilot.writeDisabled"),
    };
  }

  const cwd = cleanText(approval?.cwd || approval?.rawParams?.cwd || approval?.rawParams?.grantRoot || "");
  const workspaceRoot = cleanText(approval?.workspaceRoot || approval?.rawParams?.grantRoot || cwd);
  if (!cwd || !workspaceRoot) {
    return {
      title: t(locale, "detail.autoPilot.manualTitle"),
      body: t(locale, "detail.autoPilot.writeMissingWorkspace"),
    };
  }

  const diffText = normalizeTimelineDiffText(approval?.diffText ?? "");
  if (!diffText) {
    return {
      title: t(locale, "detail.autoPilot.manualTitle"),
      body: t(locale, "detail.autoPilot.writeMissingDiff"),
    };
  }

  const rawFileRefs = normalizeTimelineFileRefs(approval?.fileRefs ?? []);
  if (rawFileRefs.length === 0) {
    return {
      title: t(locale, "detail.autoPilot.manualTitle"),
      body: t(locale, "detail.autoPilot.writeMissingFiles"),
    };
  }

  const resolvedFileRefs = resolveTrustedWriteFileRefs({
    fileRefs: approval?.fileRefs ?? [],
    cwd,
    workspaceRoot,
  });
  if (!resolvedFileRefs) {
    return {
      title: t(locale, "detail.autoPilot.manualTitle"),
      body: t(locale, "detail.autoPilot.writeInvalidFiles"),
    };
  }

  const counts = diffLineCounts(diffText);
  const totalChangedLines =
    Math.max(0, Number(counts.addedLines) || 0) +
    Math.max(0, Number(counts.removedLines) || 0);
  if (totalChangedLines === 0) {
    return {
      title: t(locale, "detail.autoPilot.manualTitle"),
      body: t(locale, "detail.autoPilot.writeMissingDiff"),
    };
  }
  if (totalChangedLines > 120) {
    return {
      title: t(locale, "detail.autoPilot.manualTitle"),
      body: t(locale, "detail.autoPilot.writeDiffTooLarge"),
    };
  }

  const diffSections = splitUnifiedDiffTextByFile(diffText);
  if (diffSections.length === 0) {
    return {
      title: t(locale, "detail.autoPilot.manualTitle"),
      body: t(locale, "detail.autoPilot.writeDiffUnreadable"),
    };
  }
  if (diffSections.length > 3) {
    return {
      title: t(locale, "detail.autoPilot.manualTitle"),
      body: t(locale, "detail.autoPilot.writeDiffTooLarge"),
    };
  }

  if (
    /^(?:new file mode|deleted file mode|rename from|rename to|old mode|new mode|similarity index|dissimilarity index|GIT binary patch|Binary files )/mu.test(diffText)
  ) {
    return {
      title: t(locale, "detail.autoPilot.manualTitle"),
      body: t(locale, "detail.autoPilot.writeDangerousDiff"),
    };
  }

  const diffSectionRefs = resolveTrustedWriteDiffSectionFileRefs({
    diffSections,
    cwd,
    workspaceRoot,
  });
  if (!diffSectionRefs || !sameNormalizedFileRefSet(diffSectionRefs, resolvedFileRefs)) {
    return {
      title: t(locale, "detail.autoPilot.manualTitle"),
      body: t(locale, "detail.autoPilot.writeDiffMismatch"),
    };
  }

  const lanes = autoPilotWriteLaneState(state);
  const isContentOnly = resolvedFileRefs.every((fileRef) => isAutoPilotContentWritePath(fileRef));
  if (isContentOnly) {
    if (!lanes.content) {
      return {
        title: t(locale, "detail.autoPilot.manualTitle"),
        body: t(locale, "detail.autoPilot.writeContentDisabled"),
      };
    }
    return {
      title: t(locale, "detail.autoPilot.manualTitle"),
      body: t(locale, "detail.autoPilot.writeNoLaneMatch"),
    };
  }

  const isUiTestsOnly = resolvedFileRefs.every((fileRef) => isAutoPilotUiTestWritePath(fileRef));
  if (isUiTestsOnly) {
    if (!lanes.uiTests) {
      return {
        title: t(locale, "detail.autoPilot.manualTitle"),
        body: t(locale, "detail.autoPilot.writeUiDisabled"),
      };
    }
    if (totalChangedLines > 80) {
      return {
        title: t(locale, "detail.autoPilot.manualTitle"),
        body: t(locale, "detail.autoPilot.writeUiTooLarge"),
      };
    }
    if (hasUnsafeUiOrTestWriteDiff(diffText)) {
      return {
        title: t(locale, "detail.autoPilot.manualTitle"),
        body: t(locale, "detail.autoPilot.writeUiUnsafe"),
      };
    }
    return {
      title: t(locale, "detail.autoPilot.manualTitle"),
      body: t(locale, "detail.autoPilot.writeNoLaneMatch"),
    };
  }

  const isSourceOnly = resolvedFileRefs.every((fileRef) => isAutoPilotSourceWritePath(fileRef));
  if (isSourceOnly) {
    if (!lanes.source) {
      return {
        title: t(locale, "detail.autoPilot.manualTitle"),
        body: t(locale, "detail.autoPilot.writeSourceDisabled"),
      };
    }
    if (totalChangedLines > 40) {
      return {
        title: t(locale, "detail.autoPilot.manualTitle"),
        body: t(locale, "detail.autoPilot.writeSourceTooLarge"),
      };
    }
    if (hasUnsafeSourceWriteDiff(diffText)) {
      return {
        title: t(locale, "detail.autoPilot.manualTitle"),
        body: t(locale, "detail.autoPilot.writeSourceUnsafe"),
      };
    }
    if (!hasRecentSourceReadContinuity({ runtime, state, approval, resolvedFileRefs })) {
      return {
        title: t(locale, "detail.autoPilot.manualTitle"),
        body: t(locale, "detail.autoPilot.writeSourceContinuity"),
      };
    }
    return {
      title: t(locale, "detail.autoPilot.manualTitle"),
      body: t(locale, "detail.autoPilot.writeNoLaneMatch"),
    };
  }

  return {
    title: t(locale, "detail.autoPilot.manualTitle"),
    body: t(locale, "detail.autoPilot.writeNoLaneMatch"),
  };
}

function buildPreviousApprovalContext(runtime, approval) {
  const threadId = cleanText(approval?.conversationId || "");
  const approvalCreatedAtMs = Number(approval?.createdAtMs) || 0;
  if (!threadId || !approvalCreatedAtMs) {
    return null;
  }

  const previousEntry = runtime.recentTimelineEntries
    .filter((entry) => {
      if (!timelineMessageKinds.has(entry.kind)) {
        return false;
      }
      if (cleanText(entry.threadId || "") !== threadId) {
        return false;
      }
      return Number(entry.createdAtMs) > 0 && Number(entry.createdAtMs) < approvalCreatedAtMs;
    })
    .sort((left, right) => Number(right.createdAtMs ?? 0) - Number(left.createdAtMs ?? 0))[0];

  if (!previousEntry) {
    return null;
  }

  const sourceText = normalizeLongText(previousEntry.messageText || previousEntry.summary || "");
  if (!sourceText) {
    return null;
  }

  return {
    kind: previousEntry.kind,
    createdAtMs: Number(previousEntry.createdAtMs) || 0,
    messageHtml: renderMessageHtml(sourceText, "<p></p>"),
  };
}

function buildInterruptedTimelineContext(runtime, entry, locale) {
  if (!runtime || !isTurnAbortedDisplayMessage(entry?.messageText)) {
    return null;
  }

  const threadId = cleanText(entry?.threadId || "");
  const interruptedCreatedAtMs = Number(entry?.createdAtMs) || 0;
  if (!threadId || !interruptedCreatedAtMs) {
    return null;
  }

  const previousEntry = runtime.recentTimelineEntries
    .filter((candidate) => {
      if (!timelineMessageKinds.has(cleanText(candidate?.kind || ""))) {
        return false;
      }
      if (cleanText(candidate?.threadId || "") !== threadId) {
        return false;
      }
      if (Number(candidate?.createdAtMs) <= 0 || Number(candidate?.createdAtMs) >= interruptedCreatedAtMs) {
        return false;
      }
      return !isTurnAbortedDisplayMessage(candidate?.messageText);
    })
    .sort((left, right) => Number(right?.createdAtMs ?? 0) - Number(left?.createdAtMs ?? 0))[0];

  if (!previousEntry) {
    return null;
  }

  const sourceText = normalizeLongText(previousEntry.messageText || previousEntry.summary || "");
  if (!sourceText) {
    return null;
  }

  return {
    kind: previousEntry.kind,
    label: t(locale, "detail.interruptedTask"),
    createdAtMs: Number(previousEntry.createdAtMs) || 0,
    messageHtml: renderMessageHtml(sourceText, "<p></p>"),
  };
}

function buildPendingPlanDetail(planRequest, locale) {
  return {
    kind: "plan",
    token: planRequest.token,
    title: formatLocalizedTitle(locale, "server.title.plan", planRequest.threadLabel),
    threadLabel: planRequest.threadLabel || "",
    createdAtMs: Number(planRequest.createdAtMs) || 0,
    messageHtml: renderMessageHtml(planRequest.messageText, `<p>${escapeHtml(t(locale, "detail.planReady"))}</p>`),
    readOnly: false,
    actions: [
      { label: t(locale, "server.action.implement"), tone: "primary", url: `/api/items/plan/${encodeURIComponent(planRequest.token)}/implement`, body: {} },
      { label: t(locale, "server.action.reject"), tone: "secondary", url: `/api/items/plan/${encodeURIComponent(planRequest.token)}/decline`, body: {} },
    ],
  };
}

function normalizeDraftAnswersMap(value) {
  if (!isPlainObject(value)) {
    return {};
  }

  const output = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = cleanText(key);
    const normalizedValue = cleanText(rawValue ?? "");
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    output[normalizedKey] = normalizedValue;
  }
  return output;
}

function getChoicePagination(userInputRequest, config) {
  const questions = Array.isArray(userInputRequest.questions) ? userInputRequest.questions : [];
  const pageSize = Math.max(1, Number(config.choicePageSize) || 5);
  const totalPages = Math.max(1, Math.ceil(questions.length / pageSize));
  const requestedPage = Math.max(1, Number(userInputRequest.draftPage) || 1);
  const page = Math.min(requestedPage, totalPages);
  const startIndex = (page - 1) * pageSize;
  return {
    pageSize,
    totalPages,
    page,
    questions: questions.slice(startIndex, startIndex + pageSize),
  };
}

function buildChoiceDetail(userInputRequest, config, locale) {
  if (!userInputRequest.supported) {
    return {
      kind: "choice",
      token: userInputRequest.token,
      title: formatLocalizedTitle(locale, "server.title.choiceReadOnly", userInputRequest.threadLabel),
      threadLabel: userInputRequest.threadLabel || "",
      createdAtMs: Number(userInputRequest.createdAtMs) || 0,
      readOnly: true,
      supported: false,
      messageHtml: renderMessageHtml(
        `${userInputRequest.messageText}\n\n${t(locale, "choice.macOnly")}`,
        `<p>${escapeHtml(t(locale, "choice.macOnly"))}</p>`
      ),
      actions: [],
    };
  }

  const pagination = getChoicePagination(userInputRequest, config);
  return {
    kind: "choice",
    token: userInputRequest.token,
    title: formatLocalizedTitle(locale, "server.title.choice", userInputRequest.threadLabel),
    threadLabel: userInputRequest.threadLabel || "",
    createdAtMs: Number(userInputRequest.createdAtMs) || 0,
    supported: true,
    page: pagination.page,
    totalPages: pagination.totalPages,
    questions: pagination.questions,
    draftAnswers: normalizeDraftAnswersMap(userInputRequest.draftAnswers),
    readOnly: false,
    actions: [],
  };
}

function historyItemThreadId(item) {
  return cleanText(item?.threadId || extractConversationIdFromStableId(item?.stableId) || "");
}

const REPLYABLE_HISTORY_KINDS = new Set(["assistant_final"]);

function isLatestReplyableHistoryItem(runtime, item) {
  const itemKind = cleanText(item?.kind || "");
  if (!runtime || !REPLYABLE_HISTORY_KINDS.has(itemKind)) {
    return false;
  }

  const threadId = historyItemThreadId(item);
  const token = cleanText(item?.token || "");
  if (!threadId || !token) {
    return false;
  }

  // Find the latest replyable item (completion or assistant_final) for this thread
  // Sort by createdAtMs descending since array order is not guaranteed
  let latestForThread = null;
  let latestTs = 0;
  for (const entry of runtime.recentHistoryItems) {
    if (!REPLYABLE_HISTORY_KINDS.has(cleanText(entry?.kind || "")) || historyItemThreadId(entry) !== threadId) continue;
    const ts = Number(entry.createdAtMs) || 0;
    if (!latestForThread || ts > latestTs) {
      latestForThread = entry;
      latestTs = ts;
    }
  }
  return cleanText(latestForThread?.token || "") === token;
}

function findNewerThreadMessageAfterCompletion(runtime, completionItem) {
  const itemKind = cleanText(completionItem?.kind || "");
  if (!runtime || !REPLYABLE_HISTORY_KINDS.has(itemKind)) {
    return null;
  }

  const threadId = historyItemThreadId(completionItem);
  const completionCreatedAtMs = Number(completionItem?.createdAtMs) || 0;
  if (!threadId || !completionCreatedAtMs) {
    return null;
  }

  return runtime.recentTimelineEntries
    .filter((entry) => {
      if (!timelineMessageKinds.has(cleanText(entry?.kind || ""))) {
        return false;
      }
      if (cleanText(entry?.threadId || "") !== threadId) {
        return false;
      }
      return Number(entry?.createdAtMs) > completionCreatedAtMs;
    })
    .sort((left, right) => Number(right?.createdAtMs ?? 0) - Number(left?.createdAtMs ?? 0))[0] || null;
}

function buildHistoryDetail(item, locale, runtime = null) {
  const threadId = historyItemThreadId(item);
  const replyEnabled =
    REPLYABLE_HISTORY_KINDS.has(item.kind) &&
    Boolean(threadId) &&
    Boolean(runtime?.ipcClient) &&
    isLatestReplyableHistoryItem(runtime, item);
  return {
    kind: item.kind,
    token: item.token,
    threadId,
    title: item.threadLabel ? formatTitle(kindTitle(locale, item.kind), item.threadLabel) : item.title,
    threadLabel: item.threadLabel || "",
    createdAtMs: Number(item.createdAtMs) || 0,
    messageHtml: renderMessageHtml(item.messageText, `<p>${escapeHtml(t(locale, "detail.detailUnavailable"))}</p>`),
    fileRefs: normalizeTimelineFileRefs(item.fileRefs ?? []),
    diffText: normalizeTimelineDiffText(item.diffText ?? ""),
    diffAvailable: item.diffAvailable === true || Boolean(item.diffText),
    diffSource: normalizeTimelineDiffSource(item.diffSource ?? ""),
    diffAddedLines: Math.max(0, Number(item.diffAddedLines) || 0),
    diffRemovedLines: Math.max(0, Number(item.diffRemovedLines) || 0),
    interruptNotice: interruptedDetailNotice(item.messageText, locale),
    readOnly: true,
    reply: replyEnabled
      ? {
          enabled: true,
          supportsPlanMode: true,
          supportsImages: true,
        }
      : null,
    actions: [],
  };
}

function buildTimelineEntryImageUrls(entry) {
  const imagePaths = normalizeTimelineImagePaths(entry?.imagePaths ?? []);
  if (imagePaths.length === 0) {
    return [];
  }
  const token = cleanText(entry?.token || "");
  if (!token) {
    return [];
  }
  return imagePaths.map((_, index) => `/api/timeline/${encodeURIComponent(token)}/images/${index}`);
}

function buildTimelineMessageDetail(entry, locale, runtime = null) {
  return {
    kind: entry.kind,
    token: entry.token,
    threadId: cleanText(entry.threadId || ""),
    title: cleanText(entry.threadLabel || entry.title || "") || kindTitle(locale, entry.kind),
    threadLabel: entry.threadLabel || "",
    createdAtMs: Number(entry.createdAtMs) || 0,
    messageHtml: renderMessageHtml(entry.messageText, `<p>${escapeHtml(t(locale, "detail.detailUnavailable"))}</p>`),
    imageUrls: buildTimelineEntryImageUrls(entry),
    fileRefs: normalizeTimelineFileRefs(entry.fileRefs ?? []),
    previousContext: buildInterruptedTimelineContext(runtime, entry, locale),
    interruptNotice: interruptedDetailNotice(entry.messageText, locale),
    readOnly: true,
    actions: [],
  };
}

function buildAmbientSuggestionsDetail(entry, locale) {
  const suggestions = normalizeAmbientSuggestions(entry?.suggestions ?? []);
  return {
    kind: "ambient_suggestions",
    token: cleanText(entry?.token || ""),
    threadId: cleanText(entry?.threadId || ""),
    title: cleanText(entry?.title || "") || kindTitle(locale, "ambient_suggestions"),
    threadLabel: cleanText(entry?.threadLabel || ""),
    createdAtMs: Number(entry?.createdAtMs) || 0,
    messageHtml: renderMessageHtml(
      t(locale, "detail.ambientSuggestions.copy"),
      `<p>${escapeHtml(t(locale, "detail.detailUnavailable"))}</p>`
    ),
    suggestions,
    readOnly: true,
    actions: [],
  };
}

function buildTimelineFileEventDetail(entry, locale) {
  const fileEventType = normalizeTimelineFileEventType(entry?.fileEventType ?? "");
  return {
    kind: "file_event",
    token: entry.token,
    threadId: cleanText(entry.threadId || ""),
    title: cleanText(entry.threadLabel || entry.title || "") || kindTitle(locale, "file_event"),
    threadLabel: entry.threadLabel || "",
    fileEventType,
    createdAtMs: Number(entry.createdAtMs) || 0,
    messageHtml: renderMessageHtml(fileEventDetailCopy(locale, fileEventType, entry?.provider), `<p>${escapeHtml(t(locale, "detail.detailUnavailable"))}</p>`),
    fileRefs: normalizeTimelineFileRefs(entry.fileRefs ?? []),
    previousFileRefs: normalizeTimelineFileRefs(entry.previousFileRefs ?? []),
    diffAvailable: Boolean(entry.diffAvailable),
    diffText: normalizeTimelineDiffText(entry.diffText ?? ""),
    diffSource: normalizeTimelineDiffSource(entry.diffSource ?? ""),
    diffAddedLines: Math.max(0, Number(entry.diffAddedLines) || 0),
    diffRemovedLines: Math.max(0, Number(entry.diffRemovedLines) || 0),
    readOnly: true,
    actions: [],
  };
}

function buildDiffThreadDetail(group, locale) {
  const changedFileCount = Math.max(0, Number(group.changedFileCount) || 0);
  return {
    kind: "diff_thread",
    token: group.token,
    threadId: cleanText(group.threadId || ""),
    title: cleanText(group.threadLabel || "") || kindTitle(locale, "diff_thread"),
    threadLabel: group.threadLabel || "",
    sourceMode: cleanText(group.sourceMode || ""),
    createdAtMs: Number(group.latestChangedAtMs) || 0,
    changedFileCount,
    diffAddedLines: Math.max(0, Number(group.diffAddedLines) || 0),
    diffRemovedLines: Math.max(0, Number(group.diffRemovedLines) || 0),
    messageHtml: renderMessageHtml(
      diffThreadDetailCopy(locale, group.sourceMode, changedFileCount),
      `<p>${escapeHtml(t(locale, "detail.detailUnavailable"))}</p>`
    ),
    files: Array.isArray(group.files)
      ? group.files.map((fileGroup) => ({
          fileRef: cleanTimelineFileRef(fileGroup.fileRef),
          oldFileRef: cleanTimelineFileRef(fileGroup.oldFileRef || ""),
          newFileRef: cleanTimelineFileRef(fileGroup.newFileRef || fileGroup.fileRef || ""),
          fileLabel: cleanText(fileGroup.fileLabel || "") || path.basename(cleanTimelineFileRef(fileGroup.fileRef)) || cleanTimelineFileRef(fileGroup.fileRef),
          changeType: normalizeTimelineFileEventType(fileGroup.changeType ?? ""),
          fileEventTypes: Array.isArray(fileGroup.fileEventTypes)
            ? fileGroup.fileEventTypes.map((value) => normalizeTimelineFileEventType(value)).filter(Boolean)
            : [],
          addedLines: Math.max(0, Number(fileGroup.addedLines) || 0),
          removedLines: Math.max(0, Number(fileGroup.removedLines) || 0),
          latestChangedAtMs: Math.max(0, Number(fileGroup.latestChangedAtMs) || 0),
          sections: Array.isArray(fileGroup.sections)
            ? fileGroup.sections.map((section) => ({
                createdAtMs: Math.max(0, Number(section.createdAtMs) || 0),
                diffText: normalizeTimelineDiffText(section.diffText ?? ""),
                diffAvailable: section.diffAvailable === true || Boolean(section.diffText),
                diffSource: normalizeTimelineDiffSource(section.diffSource ?? ""),
                addedLines: Math.max(0, Number(section.addedLines) || 0),
                removedLines: Math.max(0, Number(section.removedLines) || 0),
                fileEventType: normalizeTimelineFileEventType(section.fileEventType ?? ""),
              }))
            : [],
        }))
      : [],
    readOnly: true,
    actions: [],
  };
}

function findLatestPersistedUserInputRequest({ config, runtime, state, token }) {
  let best = runtime.userInputRequestsByToken.get(token) ?? null;
  const pending = isPlainObject(state.pendingUserInputRequests) ? state.pendingUserInputRequests : {};
  for (const raw of Object.values(pending)) {
    if (!isPlainObject(raw) || cleanText(raw.token) !== token) {
      continue;
    }
    const restored = restoreGenericUserInputRequest({ config, raw });
    if (!restored) {
      continue;
    }
    if (!best || Number(restored.lastSeenAtMs ?? 0) > Number(best.lastSeenAtMs ?? 0)) {
      best = restored;
    }
  }

  if (best) {
    registerGenericUserInputRequest(runtime, best);
  }

  return best;
}

function mergeChoiceDraftAnswers(userInputRequest, partialAnswers) {
  const draftAnswers = normalizeDraftAnswersMap(userInputRequest.draftAnswers);
  const nextAnswers = normalizeDraftAnswersMap(partialAnswers);
  userInputRequest.draftAnswers = {
    ...draftAnswers,
    ...nextAnswers,
  };
}

function buildChoiceHistoryText(userInputRequest, submittedAnswers) {
  return formatSubmittedTestAnswers(userInputRequest, submittedAnswers) || t(DEFAULT_LOCALE, "server.message.choiceSummarySubmitted");
}

async function submitGenericUserInputDecision({ config, runtime, state, userInputRequest, submittedAnswers }) {
  if (!userInputRequest.testRequest && !runtime.ipcClient) {
    throw new Error("codex-ipc-not-connected");
  }

  const response = resolveGenericUserInputResponse(userInputRequest, submittedAnswers);
  if (!userInputRequest.testRequest) {
    await runtime.ipcClient.submitStructuredUserInput(
      userInputRequest.conversationId,
      userInputRequest.requestId,
      response,
      userInputRequest.ownerClientId
    );
  }

  userInputRequest.resolved = true;
  userInputRequest.resolving = false;
  userInputRequest.isLiveRequestActive = false;
  userInputRequest.lastSeenAtMs = Date.now();
  userInputRequest.expiresAtMs = Date.now() + config.planRequestTtlMs;
  userInputRequest.draftPage = 1;
  let stateChanged = storePendingUserInputRequest(state, userInputRequest);
  stateChanged = recordActionHistoryItem({
    config,
    runtime,
    state,
    kind: "choice",
    stableId: `choice:${userInputRequest.requestKey}:${userInputRequest.lastSeenAtMs}`,
    token: userInputRequest.token,
    title: userInputRequest.title,
    messageText: userInputRequest.testRequest
      ? `${t(config.defaultLocale, "server.message.choiceSubmittedTest")}\n\n${buildChoiceHistoryText(userInputRequest, submittedAnswers)}`
      : `${t(config.defaultLocale, "server.message.choiceSubmitted", { provider: providerDisplayName(config.defaultLocale, "codex") })}\n\n${buildChoiceHistoryText(userInputRequest, submittedAnswers)}`,
    summary: userInputRequest.testRequest
      ? t(config.defaultLocale, "server.message.choiceSummaryReceivedTest")
      : t(config.defaultLocale, "server.message.choiceSummarySubmitted"),
    outcome: "submitted",
  }) || stateChanged;
  if (stateChanged) {
    await saveState(config.stateFile, state);
  }
}

function normalizeCompletionReplyLocalImagePaths(paths) {
  if (!Array.isArray(paths)) {
    return [];
  }
  return paths
    .map((value) => resolvePath(cleanText(value || "")))
    .filter(Boolean);
}

function guessImageMimeTypeFromPath(filePath) {
  const extension = path.extname(cleanText(filePath || "")).toLowerCase();
  const mimeTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".heif": "image/heif",
  };
  return mimeTypes[extension] || "application/octet-stream";
}

async function buildCompletionReplyImageDataUrls(localImagePaths) {
  const urls = [];
  for (const filePath of localImagePaths) {
    const buffer = await fs.readFile(filePath);
    const mimeType = guessImageMimeTypeFromPath(filePath);
    urls.push(`data:${mimeType};base64,${buffer.toString("base64")}`);
  }
  return urls;
}

function scheduleBestEffortFileCleanup(paths, delayMs = COMPLETION_REPLY_WORKSPACE_STAGE_CLEANUP_DELAY_MS) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return;
  }

  const timer = setTimeout(async () => {
    await Promise.all(
      paths.map(async (filePath) => {
        try {
          await fs.rm(filePath, { force: true });
        } catch {
          // Ignore best-effort cleanup errors.
        }
      })
    );
  }, delayMs);
  timer.unref?.();
}

function buildDirectTurnStartPayload(conversationId, turnStartParams = {}) {
  return {
    threadId: cleanText(conversationId || ""),
    input: Array.isArray(turnStartParams.input) ? turnStartParams.input : [],
    cwd: cleanText(turnStartParams.cwd || "") || null,
    approvalPolicy: turnStartParams.approvalPolicy ?? null,
    approvalsReviewer: cleanText(turnStartParams.approvalsReviewer || "") || "user",
    sandboxPolicy: turnStartParams.sandboxPolicy ?? null,
    model: turnStartParams.model ?? null,
    serviceTier: turnStartParams.serviceTier ?? null,
    effort: turnStartParams.effort ?? null,
    summary: cleanText(turnStartParams.summary || "") || "none",
    personality: turnStartParams.personality ?? null,
    outputSchema: turnStartParams.outputSchema ?? null,
    collaborationMode: isPlainObject(turnStartParams.collaborationMode)
      ? turnStartParams.collaborationMode
      : null,
    attachments: Array.isArray(turnStartParams.attachments) ? turnStartParams.attachments : [],
  };
}

async function cleanupExpiredWorkspaceReplyImages(stageDir) {
  try {
    const entries = await fs.readdir(stageDir, { withFileTypes: true });
    const cutoffMs = Date.now() - COMPLETION_REPLY_WORKSPACE_STAGE_TTL_MS;
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) {
          return;
        }
        const filePath = path.join(stageDir, entry.name);
        try {
          const stat = await fs.stat(filePath);
          if (Number(stat.mtimeMs) < cutoffMs) {
            await fs.rm(filePath, { force: true });
          }
        } catch {
          // Ignore best-effort cleanup errors.
        }
      })
    );
  } catch {
    // Ignore missing stage dir.
  }
}

async function stageCompletionReplyImagesForThreadCwd(localImagePaths, cwd) {
  const normalizedCwd = resolvePath(cleanText(cwd || ""));
  if (!normalizedCwd || !Array.isArray(localImagePaths) || localImagePaths.length === 0) {
    return [];
  }

  const stageDir = path.join(normalizedCwd, COMPLETION_REPLY_WORKSPACE_STAGE_DIR);
  await cleanupExpiredWorkspaceReplyImages(stageDir);
  await fs.mkdir(stageDir, { recursive: true });

  const stagedPaths = [];
  for (const sourcePath of localImagePaths) {
    const extension = path.extname(cleanText(sourcePath || "")) || ".img";
    const stagedPath = path.join(stageDir, `${Date.now()}-${crypto.randomUUID()}${extension}`);
    await fs.copyFile(sourcePath, stagedPath);
    stagedPaths.push(stagedPath);
  }
  return stagedPaths;
}

async function buildCompletionReplyTurnCandidates(
  messageText,
  localImagePaths,
  collaborationMode,
  cwd = null,
  workspaceLocalImagePaths = []
) {
  const baseCandidate = {
    attachments: [],
    cwd: cleanText(cwd || "") || null,
    approvalPolicy: null,
    sandboxPolicy: null,
    model: null,
    serviceTier: null,
    effort: null,
    summary: "none",
    personality: null,
    outputSchema: null,
    collaborationMode,
  };

  if (!localImagePaths.length) {
    return [
      {
        name: "text-only",
        transport: "thread-follower",
        turnStartParams: {
          ...baseCandidate,
          input: buildTurnInput(messageText),
          localImagePaths: [],
          local_image_paths: [],
          remoteImageUrls: [],
          remote_image_urls: [],
        },
      },
    ];
  }

  const imageDataUrls = await buildCompletionReplyImageDataUrls(localImagePaths);
  const workspaceImagePaths = normalizeCompletionReplyLocalImagePaths(workspaceLocalImagePaths);
  const candidates = [];

  if (workspaceImagePaths.length) {
    candidates.push({
      // Match the Desktop composer path as closely as possible:
      // text + localImage(path) passed through the normal thread-follower route.
      name: "workspace-local-image-composer-input",
      transport: "thread-follower",
      turnStartParams: {
        ...baseCandidate,
        input: buildComposerStyleLocalImageInput(messageText, workspaceImagePaths),
        localImagePaths: [],
        local_image_paths: [],
        remoteImageUrls: [],
        remote_image_urls: [],
      },
    });
  }

  candidates.push(
    {
      // This mirrors the desktop composer input items before submission:
      // text + image(url=data:image/...).
      name: "image-data-url-composer-input",
      transport: "thread-follower",
      turnStartParams: {
        ...baseCandidate,
        input: buildComposerStyleImageInput(messageText, imageDataUrls),
        localImagePaths: [],
        local_image_paths: [],
        remoteImageUrls: [],
        remote_image_urls: [],
      },
    },
    {
      name: "local-image-composer-input",
      transport: "thread-follower",
      turnStartParams: {
        ...baseCandidate,
        input: buildComposerStyleLocalImageInput(messageText, localImagePaths),
        localImagePaths: [],
        local_image_paths: [],
        remoteImageUrls: [],
        remote_image_urls: [],
      },
    },
    {
      // This currently reaches Codex, but the image is dropped before the final
      // UserInput core submission. Keep it last as a diagnostic fallback.
      name: "remote-image-urls-data-url",
      transport: "thread-follower",
      turnStartParams: {
        ...baseCandidate,
        input: buildTurnInput(messageText),
        localImagePaths: [],
        local_image_paths: [],
        remoteImageUrls: imageDataUrls,
        remote_image_urls: imageDataUrls,
      },
    }
  );

  return candidates;
}

async function handleCompletionReply({
  config,
  runtime,
  state,
  completionItem,
  text,
  planMode = false,
  force = false,
  localImagePaths = [],
}) {
  const messageText = cleanText(text ?? "");
  const normalizedLocalImagePaths = normalizeCompletionReplyLocalImagePaths(localImagePaths);
  if (!messageText) {
    throw new Error("completion-reply-empty");
  }
  if (!runtime.ipcClient) {
    throw new Error("codex-ipc-not-connected");
  }

  const conversationId = cleanText(completionItem?.threadId || extractConversationIdFromStableId(completionItem?.stableId) || "");
  if (!conversationId) {
    throw new Error("completion-reply-unavailable");
  }
  // For assistant_final, check against timeline entries (avoids maxHistoryItems eviction).
  // For legacy completion, check against history items.
  const itemKind = cleanText(completionItem?.kind || "");
  if (itemKind === "assistant_final") {
    const itemTs = Number(completionItem.createdAtMs) || 0;
    const hasNewer = runtime.recentTimelineEntries.some(
      (e) => e.kind === "assistant_final" &&
        cleanText(e.threadId || "") === conversationId &&
        (Number(e.createdAtMs) || 0) > itemTs
    );
    if (hasNewer) {
      throw new Error("completion-reply-unavailable");
    }
  } else if (!isLatestReplyableHistoryItem(runtime, completionItem)) {
    throw new Error("completion-reply-unavailable");
  }
  const newerThreadMessage = findNewerThreadMessageAfterCompletion(runtime, completionItem);
  if (newerThreadMessage && !force) {
    const error = new Error("completion-reply-thread-advanced");
    error.warning = {
      kind: cleanText(newerThreadMessage.kind || ""),
      createdAtMs: Number(newerThreadMessage.createdAtMs) || 0,
      summary: cleanText(newerThreadMessage.summary || newerThreadMessage.messageText || newerThreadMessage.title || ""),
    };
    throw error;
  }

  const threadState = runtime.threadStates.get(conversationId) ?? null;
  const resolvedCwd = await resolveConversationCwd(runtime, conversationId);
  const stagedWorkspaceImagePaths = await stageCompletionReplyImagesForThreadCwd(
    normalizedLocalImagePaths,
    resolvedCwd
  );
  const timelineImageAliases = [];
  if (normalizedLocalImagePaths.length > 0) {
    const persistentTimelineImagePaths = await normalizePersistedTimelineImagePaths({
      config,
      state,
      imagePaths: normalizedLocalImagePaths,
    });
    for (let index = 0; index < persistentTimelineImagePaths.length; index += 1) {
      const persistentPath = cleanText(persistentTimelineImagePaths[index] || "");
      if (!persistentPath) {
        continue;
      }
      const uploadPath = cleanText(normalizedLocalImagePaths[index] || "");
      const stagedPath = cleanText(stagedWorkspaceImagePaths[index] || "");
      if (uploadPath) {
        timelineImageAliases.push([uploadPath, persistentPath]);
      }
      if (stagedPath) {
        timelineImageAliases.push([stagedPath, persistentPath]);
      }
    }
  }
  const collaborationMode = buildRequestedCollaborationMode(
    threadState,
    planMode ? "plan" : "default"
  );
  const turnCandidates = await buildCompletionReplyTurnCandidates(
    messageText,
    normalizedLocalImagePaths,
    collaborationMode,
    resolvedCwd,
    stagedWorkspaceImagePaths
  );
  let lastError = null;
  const ownerClientId = runtime.threadOwnerClientIds.get(conversationId) ?? null;

  for (const candidate of turnCandidates) {
    try {
      console.log(
        `[completion-reply] try candidate=${candidate.name} transport=${cleanText(candidate.transport || "thread-follower")} owner=${cleanText(ownerClientId || "") || "none"} images=${normalizedLocalImagePaths.length} workspaceImages=${stagedWorkspaceImagePaths.length} cwd=${cleanText(resolvedCwd || "") || "none"}`
      );
      if (candidate.transport === "direct-turn-start" && ownerClientId) {
        await runtime.ipcClient.startTurnDirect(
          conversationId,
          candidate.turnStartParams,
          ownerClientId
        );
      } else {
        await runtime.ipcClient.startTurn(
          conversationId,
          candidate.turnStartParams,
          ownerClientId
        );
      }
      console.log(
        `[completion-reply] success candidate=${candidate.name} transport=${cleanText(candidate.transport || "thread-follower")}`
      );
      if (timelineImageAliases.length > 0) {
        const aliases = isPlainObject(state.timelineImagePathAliases)
          ? state.timelineImagePathAliases
          : (state.timelineImagePathAliases = {});
        for (const [sourcePath, persistentPath] of timelineImageAliases) {
          aliases[sourcePath] = persistentPath;
        }
        await saveState(config.stateFile, state);
      }
      scheduleBestEffortFileCleanup(stagedWorkspaceImagePaths);
      return;
    } catch (error) {
      lastError = error;
      console.log(
        `[completion-reply] failed candidate=${candidate.name} transport=${cleanText(candidate.transport || "thread-follower")} error=${normalizeIpcErrorMessage(error)} raw=${inspect(error?.ipcError ?? error, { depth: 6, breakLength: 160 })}`
      );
    }
  }

  await Promise.all(
    stagedWorkspaceImagePaths.map(async (filePath) => {
      try {
        await fs.rm(filePath, { force: true });
      } catch {
        // Ignore best-effort cleanup errors.
      }
    })
  );
  throw lastError || new Error("completion-reply-image-send-failed");
}

async function handlePlanDecision({ config, runtime, state, planRequest, decision }) {
  let decisionTransport = "local-dismiss";
  if (decision === "implement") {
    if (!runtime.ipcClient) {
      throw new Error("codex-ipc-not-connected");
    }

    const questionAnswer = resolvePlanDecisionAnswer(planRequest, decision);
    if (!questionAnswer) {
      const collaborationMode = buildDefaultCollaborationMode(
        planRequest.latestCollaborationMode ??
          runtime.threadStates.get(planRequest.conversationId) ??
          planRequest.threadState
      );
      const turnStartParams = {
        input: buildTurnInput(buildImplementPlanPrompt(planRequest.rawPlanContent)),
        attachments: [],
        cwd: null,
        approvalPolicy: null,
        sandboxPolicy: null,
        model: null,
        serviceTier: null,
        effort: null,
        summary: "none",
        personality: null,
        outputSchema: null,
        collaborationMode,
      };
      await runtime.ipcClient.startTurn(
        planRequest.conversationId,
        turnStartParams,
        planRequest.ownerClientId
      );
      decisionTransport = "fallback";
    } else {
      await runtime.ipcClient.submitUserInputRequest(
        planRequest.conversationId,
        questionAnswer.requestId,
        [questionAnswer.answerText],
        questionAnswer.ownerClientId
      );
      decisionTransport = "user-input";
    }
  }

  planRequest.resolved = true;
  planRequest.resolving = false;
  planRequest.isLiveRequestActive = false;
  planRequest.lastSeenAtMs = Date.now();
  planRequest.expiresAtMs = Date.now() + config.planRequestTtlMs;
  let stateChanged = clearPlanTurnActive(state, planRequest.turnKey);
  stateChanged = markPlanTurnSuppressed(state, planRequest.turnKey, config.maxSeenEvents) || stateChanged;
  state.dismissedPlanRequests[planRequest.requestKey] = Date.now();
  trimSeenEvents(state.dismissedPlanRequests, config.maxSeenEvents);
  stateChanged = storePendingPlanRequest(state, planRequest) || stateChanged;
  stateChanged = recordActionHistoryItem({
    config,
    runtime,
    state,
    kind: "plan",
    stableId: `plan:${planRequest.requestKey}:${planRequest.lastSeenAtMs}`,
    token: planRequest.token,
    title: planRequest.title,
    messageText: `${planDecisionMessage(decision, config.defaultLocale)}\n\n${planRequest.messageText}`,
    summary: planDecisionMessage(decision, config.defaultLocale),
    outcome: decision === "implement" ? "implemented" : "dismissed",
  }) || stateChanged;
  if (stateChanged) {
    await saveState(config.stateFile, state);
  }
  console.log(`[plan-decision] ${planRequest.requestKey} | ${decision} | ${decisionTransport}`);
}

function claudeToolFingerprint(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  if (toolName === "Bash") {
    return String(toolInput.command || "").slice(0, 500);
  }
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    return String(toolInput.file_path || toolInput.path || "");
  }
  if (toolName === "AskUserQuestion") {
    // PostToolUse may include the user's `answers` in toolInput, which would
    // change a naive JSON.stringify fingerprint. Hash only the question texts.
    try {
      const qs = Array.isArray(toolInput.questions) ? toolInput.questions : [];
      return JSON.stringify(qs.map((q) => String(q?.question || q?.header || ""))).slice(0, 500);
    } catch {
      return "";
    }
  }
  if (toolName === "ExitPlanMode") {
    return String(toolInput.plan || "").slice(0, 500);
  }
  try {
    return JSON.stringify(toolInput).slice(0, 500);
  } catch {
    return "";
  }
}

function formatClaudeQuestionAnswers(questions, answers) {
  if (!Array.isArray(questions) || !Array.isArray(answers)) return "";
  const lines = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] || {};
    const ans = answers[i] || {};
    const questionText = String(q.question || q.header || "").trim();
    if (!questionText) continue;
    const options = Array.isArray(q.options) ? q.options : [];
    const optionIndices = Array.isArray(ans.optionIndices) ? ans.optionIndices : [];
    const labels = optionIndices
      .map((idx) => options[idx]?.label)
      .filter((label) => typeof label === "string" && label.length > 0);
    const note = typeof ans.note === "string" ? ans.note.trim() : "";
    let answerLine = "";
    if (labels.length > 0) {
      answerLine = labels.join(", ");
    }
    if (note) {
      answerLine = answerLine ? `${answerLine} (note: ${note})` : note;
    }
    if (!answerLine) {
      answerLine = "(no answer)";
    }
    lines.push(`Q${i + 1}: ${questionText}`);
    lines.push(`A: ${answerLine}`);
  }
  return lines.join("\n");
}

function findClaudePendingApprovalForTool(runtime, threadId, toolName, fingerprint) {
  let match = null;
  for (const approval of runtime.nativeApprovalsByToken.values()) {
    if (approval.resolved) continue;
    if (approval.conversationId !== threadId) continue;
    if (approval.claudeToolName && toolName && approval.claudeToolName !== toolName) continue;
    if (approval.claudeToolFingerprint && fingerprint && approval.claudeToolFingerprint !== fingerprint) continue;
    if (!match || approval.createdAtMs > match.createdAtMs) match = approval;
  }
  return match;
}

function maybeAutoApproveTrustedRead({ state, commandText, cwd, workspaceRoot }) {
  if (state?.autoPilotTrustedReads !== true) {
    return null;
  }
  return evaluateTrustedReadCommandPolicy({ commandText, cwd, workspaceRoot });
}

function isAutoPilotTrustedWritesEnabled(state) {
  return hasAnyAutoPilotWriteLaneEnabled(state);
}

function isDeniedTrustedWritePath(candidatePath) {
  const normalized = cleanText(candidatePath || "");
  if (!normalized) {
    return true;
  }
  const lower = normalized.toLowerCase();
  const segments = lower.split(/[\\/]+/u).filter(Boolean);
  const basename = segments[segments.length - 1] || "";
  if (isSensitiveCommandPath(normalized)) {
    return true;
  }
  if (segments.some((segment) => [".github", ".gitlab", ".terraform", ".claude", ".husky", ".vscode"].includes(segment))) {
    return true;
  }
  if (
    [
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lockb",
      "cargo.toml",
      "cargo.lock",
      "gemfile",
      "gemfile.lock",
      "podfile",
      "podfile.lock",
      "composer.json",
      "composer.lock",
      "pipfile",
      "pipfile.lock",
      "poetry.lock",
      "requirements.txt",
      "dockerfile",
      "wrangler.toml",
      "tsconfig.json",
      "tsconfig.tsbuildinfo",
    ].includes(basename)
  ) {
    return true;
  }
  return false;
}

function isAutoPilotContentWritePath(candidatePath) {
  const normalized = cleanText(candidatePath || "");
  if (!normalized || isDeniedTrustedWritePath(normalized)) {
    return false;
  }
  const lower = normalized.toLowerCase();
  const segments = lower.split(/[\\/]+/u).filter(Boolean);
  const basename = segments[segments.length - 1] || "";
  const extension = path.extname(basename);
  if ([".md", ".mdx", ".txt", ".rst", ".adoc"].includes(extension)) {
    return true;
  }
  if (["license", "notice", "copying", "readme", "changelog", "contributing"].includes(path.basename(basename, extension))) {
    return true;
  }
  if (segments.includes("i18n") && [".js", ".ts", ".json", ".yaml", ".yml"].includes(extension)) {
    return true;
  }
  if (segments.includes("messages") && extension === ".json") {
    return true;
  }
  return false;
}

function isAutoPilotUiTestWritePath(candidatePath) {
  const normalized = cleanText(candidatePath || "");
  if (!normalized || isDeniedTrustedWritePath(normalized)) {
    return false;
  }
  const lower = normalized.toLowerCase();
  const segments = lower.split(/[\\/]+/u).filter(Boolean);
  const basename = segments[segments.length - 1] || "";
  const extension = path.extname(basename);
  if ([".css", ".scss", ".sass", ".less", ".styl", ".pcss"].includes(extension)) {
    return true;
  }
  if (segments.includes("__tests__") || /\.(test|spec)\.[cm]?[jt]sx?$/u.test(basename)) {
    return true;
  }
  if ((segments.includes("web") || segments.includes("components")) && [".js", ".jsx", ".ts", ".tsx", ".html"].includes(extension)) {
    return true;
  }
  return false;
}

function isAutoPilotSourceWritePath(candidatePath) {
  const normalized = cleanText(candidatePath || "");
  if (!normalized || isDeniedTrustedWritePath(normalized)) {
    return false;
  }
  if (isAutoPilotContentWritePath(normalized) || isAutoPilotUiTestWritePath(normalized)) {
    return false;
  }
  const extension = path.extname(normalized.toLowerCase());
  return [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(extension);
}

function extractAddedDiffLines(diffText) {
  return normalizeTimelineDiffText(diffText)
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
}

function addedDiffLinesContain(diffText, pattern) {
  return extractAddedDiffLines(diffText).some((line) => pattern.test(line.slice(1)));
}

function hasUnsafeUiOrTestWriteDiff(diffText) {
  const patterns = [
    /\bprocess\.env\b/u,
    /\b(?:child_process|spawn|exec|execFile|fork)\b/u,
    /\bfs\.(?:write|append|rm|unlink|rename|chmod|chown|copyFile|cp)\b/u,
    /\b(?:fetch|axios|XMLHttpRequest)\s*\(/u,
    /\bcrypto\b/u,
    /\b(?:secret|token|password|privateKey|credential)\b/iu,
  ];
  return (
    addedDiffLinesContain(diffText, /^\s*(?:import\s|export\s+.*\s+from\s)/u) ||
    addedDiffLinesContain(diffText, /\brequire\s*\(/u) ||
    patterns.some((pattern) => addedDiffLinesContain(diffText, pattern))
  );
}

function hasUnsafeSourceWriteDiff(diffText) {
  const patterns = [
    /\bprocess\.env\b/u,
    /\b(?:child_process|spawn|exec|execFile|fork)\b/u,
    /\bfs\.(?:write|append|rm|unlink|rename|chmod|chown|copyFile|cp)\b/u,
    /\b(?:fetch|axios|XMLHttpRequest)\s*\(/u,
    /\b(?:net|tls|dgram|http2?)\b/u,
    /\bcrypto\b/u,
    /\b(?:secret|token|password|privateKey|credential)\b/iu,
  ];
  return (
    addedDiffLinesContain(diffText, /^\s*(?:import\s|export\s+.*\s+from\s)/u) ||
    addedDiffLinesContain(diffText, /\brequire\s*\(/u) ||
    patterns.some((pattern) => addedDiffLinesContain(diffText, pattern))
  );
}

const AUTO_PILOT_SOURCE_CONTINUITY_WINDOW_MS = 15 * 60 * 1000;

function isReadContinuityTimelineEntry(entry) {
  if (!isPlainObject(entry)) {
    return false;
  }
  if (cleanText(entry.kind || "") === "file_event" && cleanText(entry.fileEventType || "") === "read") {
    return true;
  }
  return (
    cleanText(entry.kind || "") === "approval" &&
    cleanText(entry.outcome || "") === "approved" &&
    !normalizeTimelineDiffText(entry.diffText ?? "") &&
    normalizeTimelineFileRefs(entry.fileRefs ?? []).length > 0
  );
}

function resolveRecentReadContinuityFileRefs({ entry, cwd, workspaceRoot }) {
  const normalizedRefs = normalizeTimelineFileRefs(entry?.fileRefs ?? []);
  if (normalizedRefs.length === 0) {
    return [];
  }
  const resolvedRefs = [];
  for (const fileRef of normalizedRefs) {
    const resolved = resolveTrustedReadTargetPath({
      token: fileRef,
      cwd,
      workspaceRoot,
    });
    if (resolved) {
      resolvedRefs.push(resolved);
    }
  }
  return normalizeTimelineFileRefs(resolvedRefs);
}

function hasRecentSourceReadContinuity({ runtime, state, approval, resolvedFileRefs }) {
  const normalizedTargets = normalizeTimelineFileRefs(resolvedFileRefs ?? []);
  if (normalizedTargets.length !== 1) {
    return false;
  }
  const targetFileRef = normalizedTargets[0];
  const conversationId = cleanText(approval?.conversationId || "");
  const cwd = cleanText(approval?.cwd || approval?.rawParams?.cwd || approval?.rawParams?.grantRoot || "");
  const workspaceRoot = cleanText(approval?.workspaceRoot || approval?.rawParams?.grantRoot || cwd);
  if (!cwd || !workspaceRoot) {
    return false;
  }
  const timelineEntries =
    Array.isArray(runtime?.recentTimelineEntries) && runtime.recentTimelineEntries.length > 0
      ? runtime.recentTimelineEntries
      : normalizeTimelineEntries(state?.recentTimelineEntries ?? [], 40);
  const now = Date.now();
  for (const entry of timelineEntries) {
    if (!isReadContinuityTimelineEntry(entry)) {
      continue;
    }
    const createdAtMs = Number(entry?.createdAtMs) || 0;
    if (!createdAtMs || now - createdAtMs > AUTO_PILOT_SOURCE_CONTINUITY_WINDOW_MS) {
      continue;
    }
    const entryThreadId = cleanText(entry?.threadId || extractConversationIdFromStableId(entry?.stableId) || "");
    if (conversationId && entryThreadId && entryThreadId !== conversationId) {
      continue;
    }
    const entryFileRefs = resolveRecentReadContinuityFileRefs({
      entry,
      cwd,
      workspaceRoot,
    });
    if (entryFileRefs.includes(targetFileRef)) {
      return true;
    }
  }
  return false;
}

function classifyTrustedWriteLane({ runtime, state, approval, resolvedFileRefs, diffText, totalChangedLines }) {
  const lanes = autoPilotWriteLaneState(state);
  if (
    lanes.content &&
    resolvedFileRefs.length >= 1 &&
    resolvedFileRefs.length <= 3 &&
    totalChangedLines <= 120 &&
    resolvedFileRefs.every((fileRef) => isAutoPilotContentWritePath(fileRef))
  ) {
    return "content";
  }
  if (
    lanes.uiTests &&
    resolvedFileRefs.length >= 1 &&
    resolvedFileRefs.length <= 2 &&
    totalChangedLines <= 80 &&
    resolvedFileRefs.every((fileRef) => isAutoPilotUiTestWritePath(fileRef)) &&
    !hasUnsafeUiOrTestWriteDiff(diffText)
  ) {
    return "ui_tests";
  }
  if (
    lanes.source &&
    resolvedFileRefs.length === 1 &&
    totalChangedLines <= 40 &&
    resolvedFileRefs.every((fileRef) => isAutoPilotSourceWritePath(fileRef)) &&
    !hasUnsafeSourceWriteDiff(diffText) &&
    hasRecentSourceReadContinuity({ runtime, state, approval, resolvedFileRefs })
  ) {
    return "source";
  }
  return "";
}

function resolveTrustedWriteFileRefs({ fileRefs, cwd, workspaceRoot }) {
  const normalizedRefs = normalizeTimelineFileRefs(fileRefs ?? []);
  if (normalizedRefs.length === 0 || normalizedRefs.length > 3) {
    return null;
  }
  const resolvedRefs = [];
  for (const fileRef of normalizedRefs) {
    const resolved = resolveTrustedReadTargetPath({
      token: fileRef,
      cwd,
      workspaceRoot,
    });
    if (!resolved || isDeniedTrustedWritePath(resolved)) {
      return null;
    }
    resolvedRefs.push(resolved);
  }
  return normalizeTimelineFileRefs(resolvedRefs);
}

function sameNormalizedFileRefSet(leftRefs, rightRefs) {
  const left = normalizeTimelineFileRefs(leftRefs ?? []);
  const right = normalizeTimelineFileRefs(rightRefs ?? []);
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function resolveTrustedWriteDiffSectionFileRefs({ diffSections, cwd, workspaceRoot }) {
  const resolvedSections = [];
  for (const section of diffSections) {
    const paths = extractUnifiedDiffSectionPaths(section);
    const sectionFileRef = cleanText(paths.newFileRef || paths.oldFileRef || "");
    if (!sectionFileRef) {
      return null;
    }
    if (paths.oldFileRef && paths.newFileRef && cleanText(paths.oldFileRef) !== cleanText(paths.newFileRef)) {
      return null;
    }
    const resolved = resolveTrustedDiffSectionPath({
      token: sectionFileRef,
      cwd,
      workspaceRoot,
    });
    if (!resolved || isDeniedTrustedWritePath(resolved)) {
      return null;
    }
    resolvedSections.push(resolved);
  }
  return normalizeTimelineFileRefs(resolvedSections);
}

function evaluateTrustedWriteApprovalCandidate({ runtime, state, approval }) {
  const cwd = cleanText(approval?.cwd || approval?.rawParams?.cwd || approval?.rawParams?.grantRoot || "");
  const workspaceRoot = cleanText(approval?.workspaceRoot || approval?.rawParams?.grantRoot || cwd);
  const resolvedFileRefs = resolveTrustedWriteFileRefs({
    fileRefs: approval?.fileRefs ?? [],
    cwd,
    workspaceRoot,
  });
  const diffText = normalizeTimelineDiffText(approval?.diffText ?? "");
  if (!cwd || !workspaceRoot || !resolvedFileRefs || !diffText) {
    return null;
  }
  const counts = diffLineCounts(diffText);
  const totalChangedLines =
    Math.max(0, Number(counts.addedLines) || 0) +
    Math.max(0, Number(counts.removedLines) || 0);
  if (totalChangedLines === 0 || totalChangedLines > 120) {
    return null;
  }
  const diffSections = splitUnifiedDiffTextByFile(diffText);
  if (diffSections.length === 0 || diffSections.length > 3) {
    return null;
  }
  if (
    /^(?:new file mode|deleted file mode|rename from|rename to|old mode|new mode|similarity index|dissimilarity index|GIT binary patch|Binary files )/mu.test(diffText)
  ) {
    return null;
  }
  const diffSectionRefs = resolveTrustedWriteDiffSectionFileRefs({
    diffSections,
    cwd,
    workspaceRoot,
  });
  if (!diffSectionRefs || !sameNormalizedFileRefSet(diffSectionRefs, resolvedFileRefs)) {
    return null;
  }
  const lane = classifyTrustedWriteLane({
    runtime,
    state: state ?? approval?.stateSnapshot ?? null,
    approval,
    resolvedFileRefs: diffSectionRefs,
    diffText,
    totalChangedLines,
  });
  if (!lane) {
    return null;
  }
  return {
    fileRefs: diffSectionRefs,
    diffText,
    diffAddedLines: Math.max(0, Number(counts.addedLines) || 0),
    diffRemovedLines: Math.max(0, Number(counts.removedLines) || 0),
    totalChangedLines,
    lane,
  };
}

function maybeAutoApproveTrustedWriteCandidate({ runtime, state, approval }) {
  if (!isAutoPilotTrustedWritesEnabled(state)) {
    return null;
  }
  if (cleanText(approval?.kind || "") !== "file") {
    return null;
  }
  return evaluateTrustedWriteApprovalCandidate({
    runtime,
    state,
    approval: { ...approval, stateSnapshot: state },
  });
}

function autoPilotTrustedWriteMessage(locale, approval, candidate) {
  const prefix = t(locale, "server.message.autoPilotTrustedWriteApproved");
  const fileBlock = candidate?.fileRefs?.length
    ? `${t(locale, "server.message.filesLabel")}\n\`\`\`text\n${candidate.fileRefs.join("\n")}\n\`\`\``
    : "";
  const sizeLine =
    candidate && Number.isFinite(candidate.diffAddedLines) && Number.isFinite(candidate.diffRemovedLines)
      ? `${t(locale, "server.message.diffSummaryLabel")} +${candidate.diffAddedLines} / -${candidate.diffRemovedLines}`
      : "";
  const originalMessage = cleanText(approval?.messageText || "");
  return [prefix, sizeLine, fileBlock, originalMessage].filter(Boolean).join("\n\n");
}

async function recordAutoApprovedTrustedRead({
  config,
  runtime,
  state,
  approval,
  policyMatch,
}) {
  const stateChanged = recordActionHistoryItem({
    config,
    runtime,
    state,
    kind: "approval",
    stableId: `approval:${approval.requestKey}:autopilot`,
    token: approval.token,
    title: approval.title,
    threadLabel: approval.threadLabel || "",
    messageText: autoPilotApprovalMessage(config.defaultLocale, policyMatch.commandText),
    summary: t(config.defaultLocale, "server.message.autoPilotTrustedReadSummary"),
    fileRefs: normalizeTimelineFileRefs(policyMatch.fileRefs ?? approval.fileRefs ?? []),
    diffText: "",
    diffSource: "",
    diffAvailable: false,
    diffAddedLines: 0,
    diffRemovedLines: 0,
    outcome: "approved",
    provider: approval.provider || "codex",
  });
  if (stateChanged) {
    await saveState(config.stateFile, state);
  }
}

async function recordAutoApprovedTrustedWrite({
  config,
  runtime,
  state,
  approval,
  candidate,
}) {
  const stateChanged = recordActionHistoryItem({
    config,
    runtime,
    state,
    kind: "approval",
    stableId: `approval:${approval.requestKey}:autopilot-write:${candidate.lane || "content"}`,
    token: approval.token,
    title: approval.title,
    threadLabel: approval.threadLabel || "",
    messageText: autoPilotTrustedWriteMessage(config.defaultLocale, approval, candidate),
    summary: t(config.defaultLocale, "server.message.autoPilotTrustedWriteSummary"),
    fileRefs: candidate.fileRefs,
    diffText: candidate.diffText,
    diffSource: normalizeTimelineDiffSource(approval.diffSource ?? ""),
    diffAvailable: true,
    diffAddedLines: candidate.diffAddedLines,
    diffRemovedLines: candidate.diffRemovedLines,
    outcome: "approved",
    provider: approval.provider || "codex",
  });
  if (stateChanged) {
    await saveState(config.stateFile, state);
  }
}

async function autoApproveTrustedRead({
  config,
  runtime,
  state,
  approval,
  policyMatch,
}) {
  if (approval.provider === "claude" && approval.resolveClaudeWaiter) {
    approval.resolveClaudeWaiter({
      permissionDecision: "allow",
      permissionDecisionReason: t(config.defaultLocale, "server.message.autoPilotTrustedReadReason"),
    });
  } else if (approval.provider !== "claude") {
    await runtime.ipcClient?.sendApprovalDecision(approval, "accept");
  }
  approval.resolved = true;
  approval.resolving = false;
  runtime.nativeApprovalsByToken.delete(approval.token);
  runtime.nativeApprovalsByRequestKey.delete(approval.requestKey);
  await recordAutoApprovedTrustedRead({
    config,
    runtime,
    state,
    approval,
    policyMatch,
  });
  console.log(`[auto-pilot-approved] ${approval.requestKey} | ${policyMatch.command}`);
}

async function autoApproveTrustedWrite({
  config,
  runtime,
  state,
  approval,
  candidate,
}) {
  if (approval.provider === "claude" && approval.resolveClaudeWaiter) {
    approval.resolveClaudeWaiter({
      permissionDecision: "allow",
      permissionDecisionReason: t(config.defaultLocale, "server.message.autoPilotTrustedWriteReason"),
    });
  } else if (approval.provider !== "claude") {
    await runtime.ipcClient?.sendApprovalDecision(approval, "accept");
  }
  approval.resolved = true;
  approval.resolving = false;
  runtime.nativeApprovalsByToken.delete(approval.token);
  runtime.nativeApprovalsByRequestKey.delete(approval.requestKey);
  await recordAutoApprovedTrustedWrite({
    config,
    runtime,
    state,
    approval,
    candidate,
  });
  console.log(`[auto-pilot-approved-write] ${approval.requestKey} | files=${candidate.fileRefs.length} | lines=${candidate.totalChangedLines}`);
}

async function handleNativeApprovalDecision({ config, runtime, state, approval, decision }) {
  if (approval.resolveClaudeWaiter) {
    if (approval.provider === "claude" && approval.kind === "plan") {
      // ExitPlanMode cannot be truly auto-approved via permissionDecision: "allow"
      // (Claude still shows the native PC plan dialog). Instead, deny the tool
      // call with a reason that tells Claude the user already decided on mobile.
      approval.resolveClaudeWaiter({
        permissionDecision: "deny",
        permissionDecisionReason:
          decision === "accept"
            ? "User approved the plan via the viveworker mobile app. Proceed with implementing the plan exactly as proposed and do not call ExitPlanMode again."
            : "User rejected the plan via the viveworker mobile app. Revise the plan based on the conversation context before calling ExitPlanMode again.",
      });
    } else {
      approval.resolveClaudeWaiter(decision);
    }
  } else if (approval.provider === "claude") {
    // notifyOnly Claude approvals have no long-poll waiter and no ipcClient
    // back-channel — the desktop user already answered. Nothing to send.
  } else {
    await runtime.ipcClient?.sendApprovalDecision(approval, decision);
  }
  approval.resolved = true;
  approval.resolving = false;
  runtime.nativeApprovalsByToken.delete(approval.token);
  runtime.nativeApprovalsByRequestKey.delete(approval.requestKey);
  const stateChanged = recordActionHistoryItem({
    config,
    runtime,
    state,
    kind: "approval",
    stableId: `approval:${approval.requestKey}:${Date.now()}`,
    token: approval.token,
    title: approval.title,
    threadLabel: approval.threadLabel || "",
    messageText: `${approvalDecisionMessage(decision, config.defaultLocale, approval.provider)}\n\n${approval.messageText}`,
    summary: formatNotificationBody(approval.messageText, 160) || approvalDecisionMessage(decision, config.defaultLocale, approval.provider),
    fileRefs: normalizeTimelineFileRefs(approval.fileRefs ?? []),
    diffText: normalizeTimelineDiffText(approval.diffText ?? ""),
    diffSource: normalizeTimelineDiffSource(approval.diffSource ?? ""),
    diffAvailable: approval.diffAvailable === true || Boolean(approval.diffText),
    diffAddedLines: Math.max(0, Number(approval.diffAddedLines) || 0),
    diffRemovedLines: Math.max(0, Number(approval.diffRemovedLines) || 0),
    outcome: decision === "accept" ? "approved" : "rejected",
    provider: approval.provider || "codex",
  });
  if (stateChanged) {
    await saveState(config.stateFile, state);
  }
  console.log(`[native-decision] ${approval.requestKey} | ${decision}`);
}

async function buildApiItemDetail({ config, runtime, state, kind, token, locale }) {
  if (kind === "diff_thread") {
    const group = (await getDiffThreadGroupsCached(runtime, state, config)).find((entry) => entry.token === token);
    return group ? buildDiffThreadDetail(group, locale) : null;
  }
  if (kind === "file_event") {
    const entry = timelineEntryByToken(runtime, token, kind);
    return entry ? buildTimelineFileEventDetail(entry, locale) : null;
  }
  if (kind === "ambient_suggestions") {
    const entry = timelineEntryByToken(runtime, token, kind);
    if (entry) {
      return buildAmbientSuggestionsDetail(entry, locale);
    }
    const historicalSource = (runtime.recentHistoryItems ?? []).find((item) => {
      if (cleanText(item?.token || "") !== cleanText(token || "")) {
        return false;
      }
      const itemKind = cleanText(item?.kind || "");
      if (itemKind !== "assistant_final" && itemKind !== "completion") {
        return false;
      }
      return parseAmbientSuggestionsPayload(item?.messageText ?? "") !== null;
    });
    if (!historicalSource) {
      return null;
    }
    return buildAmbientSuggestionsDetail({
      token: historicalSource.token,
      threadId: historyItemThreadId(historicalSource),
      threadLabel: historicalSource.threadLabel,
      title: kindTitle(locale, "ambient_suggestions"),
      createdAtMs: historicalSource.createdAtMs,
      suggestions: parseAmbientSuggestionsPayload(historicalSource.messageText ?? "") ?? [],
    }, locale);
  }
  if (timelineMessageKinds.has(kind)) {
    const entry = timelineEntryByToken(runtime, token, kind);
    if (!entry) return null;
    const detail = buildTimelineMessageDetail(entry, locale, runtime);
    // Add reply support for Codex assistant_final entries only (replaces completion reply).
    // Check directly against timeline entries (not history items) to avoid
    // maxHistoryItems eviction issues.
    if (kind === "assistant_final") {
      const entryProvider = normalizeProvider(entry.provider);
      if (entryProvider === "codex" && runtime?.ipcClient) {
        const entryThreadId = cleanText(entry.threadId || "");
        const entryTs = Number(entry.createdAtMs) || 0;
        let isLatestForThread = true;
        for (const other of runtime.recentTimelineEntries) {
          if (other.kind === "assistant_final" &&
            cleanText(other.threadId || "") === entryThreadId &&
            (Number(other.createdAtMs) || 0) > entryTs) {
            isLatestForThread = false;
            break;
          }
        }
        if (isLatestForThread) {
          detail.reply = { enabled: true, supportsPlanMode: true, supportsImages: true };
          detail.provider = entryProvider;
        }
      }
    }
    return detail;
  }
  if (kind === "approval") {
    const approval = runtime.nativeApprovalsByToken.get(token);
    if (approval) {
      return buildPendingApprovalDetail(runtime, state, approval, locale);
    }
    const historicalApproval = historyItemByToken(runtime, kind, token);
    return historicalApproval ? buildHistoryDetail(historicalApproval, locale, runtime) : null;
  }
  if (kind === "plan") {
    const planRequest = runtime.planRequestsByToken.get(token);
    if (planRequest && !planRequest.resolved && !isPlanRequestExpired(planRequest)) {
      return buildPendingPlanDetail(planRequest, locale);
    }
    const historicalPlan = historyItemByToken(runtime, kind, token);
    return historicalPlan ? buildHistoryDetail(historicalPlan, locale, runtime) : null;
  }
  if (kind === "choice") {
    const userInputRequest = findLatestPersistedUserInputRequest({ config, runtime, state, token });
    if (userInputRequest && !userInputRequest.resolved && !isGenericUserInputRequestExpired(userInputRequest)) {
      return buildChoiceDetail(userInputRequest, config, locale);
    }
    const historicalChoice = historyItemByToken(runtime, kind, token);
    return historicalChoice ? buildHistoryDetail(historicalChoice, locale, runtime) : null;
  }

  if (kind === "moltbook_reply") {
    const item = runtime.moltbookItemsByToken.get(token);
    // Fall back to the persisted timeline entry so that items which have
    // been resolved (removed from the pending map) still render their
    // detail view from history.
    const entry = item
      ? null
      : runtime.recentTimelineEntries.find((e) => e.kind === "moltbook_reply" && e.token === token);
    const source = item || entry;
    if (!source) return null;
    const contextText = item
      ? item.contextText || item.summary || ""
      : entry.messageText || entry.summary || "";
    const contextHtml = escapeHtml(contextText)
      .split("\n")
      .map((line) => `<p>${line}</p>`)
      .join("");
    return {
      kind: "moltbook_reply",
      token,
      threadId: source.threadId || "",
      threadLabel: source.threadLabel || "Moltbook",
      title: source.title || "Moltbook reply",
      summary: source.summary || "",
      messageHtml: contextHtml,
      postUrl: source.postUrl || "",
      postTitle: source.postTitle || "",
      commentAuthor: source.commentAuthor || "",
      provider: "moltbook",
      draftReply: item?.draftReply || "",
      createdAtMs: source.createdAtMs || Date.now(),
      readOnly: !item,
      actions: [],
      moltbookReplyEnabled: Boolean(item),
    };
  }

  if (kind === "moltbook_draft") {
    const draft = runtime.moltbookDraftsByToken.get(token);
    const entry = draft
      ? null
      : runtime.recentTimelineEntries.find((e) => e.kind === "moltbook_draft" && e.token === token);
    const source = draft || entry;
    if (!source) return null;
    const draftText = draft ? draft.draftText : entry.draftText || entry.messageText || "";
    const contextSummary = draft ? draft.contextSummary || "" : entry.summary || "";
    const messageHtml = escapeHtml(contextSummary)
      .split("\n")
      .map((line) => `<p>${line}</p>`)
      .join("");
    return {
      kind: "moltbook_draft",
      token,
      threadId: "moltbook",
      threadLabel: "Moltbook",
      title: source.title || "Moltbook draft",
      summary: source.summary || contextSummary || "",
      messageHtml,
      provider: "moltbook",
      draftText,
      postId: draft?.postId || entry?.postId || "",
      postUrl: draft?.postUrl || entry?.postUrl || "",
      postTitle: draft?.postTitle || entry?.postTitle || "",
      postAuthor: draft?.postAuthor || entry?.postAuthor || "",
      postBody: draft?.postBody || entry?.postBody || "",
      draftType: draft?.draftType || entry?.draftType || "reply",
      submoltName: draft?.submoltName || entry?.submoltName || "",
      intent: draft?.intent || entry?.intent || "",
      slot: draft?.slot || entry?.slot || "",
      createdAtMs: source.createdAtMs || Date.now(),
      readOnly: !draft || Boolean(draft?.decision),
      actions: [],
      moltbookDraftEnabled: Boolean(draft) && !draft.decision,
    };
  }

  if (kind === "a2a_task" || kind === "a2a_task_result") {
    const task = kind === "a2a_task" ? runtime.a2aTasksByToken.get(token) : null;
    const entry = task
      ? null
      : runtime.recentTimelineEntries.find((e) => e.kind === kind && e.token === token);
    const source = task || entry;
    if (!source) return null;
    const instruction = task ? task.instruction : entry.instruction || entry.summary || "";
    const responseText = kind === "a2a_task_result" && !task ? entry.messageText || "" : "";
    const messageHtml = escapeHtml(instruction)
      .split("\n")
      .map((line) => `<p>${line}</p>`)
      .join("");
    return {
      kind,
      token,
      threadId: "a2a",
      threadLabel: "A2A",
      title: source.title || `A2A Task`,
      summary: source.summary || cleanText(instruction).slice(0, 160),
      messageHtml,
      provider: "a2a",
      instruction,
      messageText: responseText,
      taskId: task?.id || "",
      taskStatus: task?.status || entry?.taskStatus || (kind === "a2a_task_result" ? "completed" : "submitted"),
      callerInfo: task?.callerInfo || {},
      createdAtMs: source.createdAtMs || Date.now(),
      readOnly: !task || task.status !== "submitted",
      actions: [],
      a2aTaskEnabled: Boolean(task) && task.status === "submitted",
    };
  }

  if (kind === "thread_share") {
    const share = runtime.threadSharesByToken.get(token);
    const entry = share
      ? null
      : runtime.recentTimelineEntries.find((e) => e.kind === "thread_share" && e.token === token);
    const source = share || entry;
    if (!source) return null;
    const content = share ? share.content : entry.messageText || entry.summary || "";
    const messageHtml = escapeHtml(content)
      .split("\n")
      .map((line) => `<p>${line}</p>`)
      .join("");
    return {
      kind: "thread_share",
      token,
      threadId: "thread_share",
      threadLabel: "Thread Share",
      title: source.title || "Thread Share",
      summary: source.summary || cleanText(content).slice(0, 160),
      messageHtml,
      provider: "viveworker",
      shareContent: content,
      shareType: share?.shareType || entry?.shareType || "message",
      sourceTool: share?.sourceTool || entry?.sourceTool || "",
      sourceLabel: share?.sourceLabel || entry?.sourceLabel || "",
      targetTool: share?.targetTool || entry?.targetTool || "",
      targetLabel: share?.targetLabel || entry?.targetLabel || "",
      targetConversationId: share?.targetConversationId || entry?.targetConversationId || "",
      contextFiles: share?.contextFiles || entry?.contextFiles || [],
      createdAtMs: source.createdAtMs || Date.now(),
      readOnly: !share || Boolean(share?.decision),
      actions: [],
      threadShareEnabled: Boolean(share) && !share.decision,
    };
  }

  const historyItem = historyItemByToken(runtime, kind, token);
  return historyItem ? buildHistoryDetail(historyItem, locale, runtime) : null;
}

function resolveTimelineEntryImagePath(runtime, token, index) {
  const entry = timelineEntryByToken(runtime, token);
  if (!entry) {
    return "";
  }
  const imagePaths = normalizeTimelineImagePaths(entry.imagePaths ?? []);
  const resolvedIndex = Math.max(0, Number(index) || 0);
  return cleanText(imagePaths[resolvedIndex] || "");
}

function resolveWebAsset(urlPath) {
  let relativePath = cleanText(urlPath || "");
  if (!relativePath || relativePath === "/") {
    relativePath = "/index.html";
  } else if (relativePath === "/app" || relativePath === "/app/") {
    relativePath = "/index.html";
  }

  const resolved = path.resolve(webRoot, `.${relativePath}`);
  if (!resolved.startsWith(`${webRoot}${path.sep}`) && resolved !== path.join(webRoot, "index.html")) {
    return null;
  }
  return resolved;
}

function contentTypeForFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    default:
      return "application/octet-stream";
  }
}

// Per-file cache of {raw, gzip, mtimeMs}. Gzip of the ~464KB app shell
// (app.js 278KB + app.css 76KB + i18n.js 110KB) takes a few ms to compute,
// and without this the bridge would recompress on every request. Keyed by
// resolved filePath so /app and /index.html share a cache slot.
const WEB_ASSET_CACHE = new Map();
const GZIPPABLE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".css",
  ".html",
  ".htm",
  ".json",
  ".webmanifest",
  ".svg",
  ".txt",
  ".map",
]);
const MIN_GZIP_BYTES = 512;

async function loadWebAssetEntry(filePath) {
  const stat = await fs.stat(filePath);
  const cached = WEB_ASSET_CACHE.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached;
  }
  const raw = await fs.readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();
  let gzip = null;
  if (GZIPPABLE_EXTENSIONS.has(extension) && raw.length >= MIN_GZIP_BYTES) {
    try {
      gzip = zlib.gzipSync(raw, { level: 6 });
    } catch {
      gzip = null;
    }
  }
  const entry = {
    raw,
    gzip,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    contentType: contentTypeForFile(filePath),
  };
  WEB_ASSET_CACHE.set(filePath, entry);
  return entry;
}

function clientAcceptsGzip(req) {
  const header = req?.headers?.["accept-encoding"];
  if (!header) return false;
  const value = Array.isArray(header) ? header.join(",") : String(header);
  return /\bgzip\b/i.test(value);
}

async function serveWebAsset(res, urlPath, req) {
  const filePath = resolveWebAsset(urlPath);
  if (!filePath) {
    return false;
  }

  try {
    const entry = await loadWebAssetEntry(filePath);
    const wantsGzip = entry.gzip && clientAcceptsGzip(req);
    res.statusCode = 200;
    res.setHeader("Content-Type", entry.contentType);
    res.setHeader("Cache-Control", "no-store, max-age=0");
    if (urlPath === "/sw.js") {
      res.setHeader("Service-Worker-Allowed", "/");
    }
    if (wantsGzip) {
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Vary", "Accept-Encoding");
      res.end(entry.gzip);
    } else {
      res.end(entry.raw);
    }
    return true;
  } catch {
    return false;
  }
}

function resolveManifestPairingToken({ config, state, requestedToken }) {
  const token = cleanText(requestedToken);
  if (!token) {
    return "";
  }
  if (!isPairingAvailable(config)) {
    return "";
  }
  return cleanText(config.pairingToken) === token ? token : "";
}

function buildWebManifest({ pairToken }) {
  const startPath = pairToken
    ? `/app?pairToken=${encodeURIComponent(pairToken)}`
    : "/app";
  return JSON.stringify(
    {
      id: "/app",
      name: "viveworker",
      short_name: "viveworker",
      start_url: startPath,
      scope: "/",
      display: "standalone",
      background_color: "#101418",
      theme_color: "#101418",
      icons: [
        {
          src: "/icons/viveworker-icon-192.png",
          sizes: "192x192",
          type: "image/png",
        },
        {
          src: "/icons/viveworker-icon-512.png",
          sizes: "512x512",
          type: "image/png",
        },
      ],
    },
    null,
    2
  );
}

function buildWebAppHtml({ pairToken }) {
  const manifestHref = pairToken
    ? `/manifest.webmanifest?pairToken=${encodeURIComponent(pairToken)}`
    : "/manifest.webmanifest";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#101418">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <link rel="manifest" href="${escapeHtml(manifestHref)}">
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
    <link rel="icon" type="image/png" sizes="192x192" href="/icons/viveworker-icon-192.png">
    <link rel="stylesheet" href="/app.css">
    <title>viveworker</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/app.js"></script>
  </body>
</html>`;
}

function resolvePagePairingToken({ req, config, state, requestedToken }) {
  return resolveManifestPairingToken({ config, state, requestedToken });
}

function createNativeApprovalServer({ config, runtime, state }) {
  const requestHandler = async (req, res) => {
    try {
      const url = new URL(req.url, config.nativeApprovalPublicBaseUrl);

      if (url.pathname === "/health") {
        return writeJson(res, 200, { ok: true });
      }

      if (url.pathname === "/ca/rootCA.pem" || url.pathname === "/downloads/rootCA.pem") {
        const filePath = config.mkcertRootCaFile;
        try {
          const body = await fs.readFile(filePath, "utf8");
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/x-pem-file");
          res.setHeader("Content-Disposition", 'attachment; filename="rootCA.pem"');
          res.end(body);
          return;
        } catch {
          return writeJson(res, 404, { error: "mkcert-root-ca-not-found" });
        }
      }

      if (url.pathname === "/manifest.webmanifest") {
        const pairToken = resolveManifestPairingToken({
          config,
          state,
          requestedToken: url.searchParams.get("pairToken"),
        });
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store, max-age=0");
        res.end(buildWebManifest({ pairToken }));
        return;
      }

      if (url.pathname === "/" || url.pathname === "/app" || url.pathname === "/app/") {
        const pairToken = resolvePagePairingToken({
          req,
          config,
          state,
          requestedToken: url.searchParams.get("pairToken"),
        });
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store, max-age=0");
        res.end(buildWebAppHtml({ pairToken }));
        return;
      }

      if (
        url.pathname === "/app.js" ||
        url.pathname === "/app.css" ||
        url.pathname === "/i18n.js" ||
        url.pathname === "/hazbase-passkey.js" ||
        url.pathname === "/sw.js" ||
        url.pathname.startsWith("/icons/")
      ) {
        const served = await serveWebAsset(res, url.pathname, req);
        if (served) {
          return;
        }
      }

      // ---------------------------------------------------------------
      // A2A (Agent2Agent) Protocol endpoints
      // ---------------------------------------------------------------

      if (url.pathname === "/.well-known/agent.json" && req.method === "GET") {
        if (!config.a2aApiKey) {
          return writeJson(res, 404, { error: "a2a-not-configured" });
        }
        return writeJson(res, 200, buildAgentCard(config));
      }

      if (url.pathname === "/a2a" && req.method === "POST") {
        if (!config.a2aApiKey) {
          return writeJson(res, 404, { error: "a2a-not-configured" });
        }
        let body;
        try {
          body = await parseJsonBody(req);
        } catch {
          return writeJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        }
        return handleA2ARequest({
          req, res, body, config, runtime, state,
          writeJson, recordTimelineEntry, deliverWebPushItem, saveState, historyToken, cleanText,
        });
      }

      // A2A task decision (user approves/denies from PWA)
      const apiA2ATaskDecide = url.pathname.match(/^\/api\/items\/a2a-task\/([^/]+)\/decision$/u);
      if (apiA2ATaskDecide && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) return;
        const token = decodeURIComponent(apiA2ATaskDecide[1]);
        const task = runtime.a2aTasksByToken.get(token);
        if (!task) return writeJson(res, 404, { error: "task-not-found" });
        let body;
        try {
          body = await parseJsonBody(req);
        } catch {
          return writeJson(res, 400, { error: "invalid-json-body" });
        }
        const action = String(body.action || "") === "approve" ? "approve" : "deny";
        const instruction = cleanText(body.instruction || "");
        const requestedExecutor = cleanText(body.executor || "");
        resolveA2ATaskDecision(task, { action, instruction });

        // Update task stats.
        if (!state.a2aTaskStats) state.a2aTaskStats = { received: 0, completed: 0, denied: 0 };
        if (action === "approve") {
          state.a2aTaskStats.completed += 1;
        } else {
          state.a2aTaskStats.denied += 1;
        }
        saveState(config.stateFile, state).catch(() => {});

        if (action === "approve") {
          // Resolve which executor to use.
          const available = runtime.a2aAvailableExecutors || { codex: false, claude: false };
          const preference = requestedExecutor || state.a2aExecutorPreference || "ask";
          let executor;
          if (preference === "codex" && available.codex) executor = "codex";
          else if (preference === "claude" && available.claude) executor = "claude";
          else if (available.codex) executor = "codex";
          else if (available.claude) executor = "claude";
          else executor = "codex"; // fallback

          // Execute task asynchronously
          (async () => {
            try {
              const { executeA2ATask } = await import("./a2a-executor.mjs");
              await executeA2ATask(task, config, runtime, state, { recordTimelineEntry, recordHistoryItem, saveState, deliverWebPushItem }, executor);
            } catch (error) {
              console.error(`[a2a-execute-error] ${error.message}`);
              failA2ATask(task, error.message);
            }
            // Post result to relay if this is a relay-originated task
            if (task.relayTaskId) {
              postRelayResult({ config, task }).catch((err) =>
                console.error(`[a2a-relay] Result post error: ${err.message}`)
              );
            }
          })();
        } else if (task.relayTaskId) {
          // Denied — post rejection back to relay
          postRelayResult({ config, task }).catch((err) =>
            console.error(`[a2a-relay] Rejection post error: ${err.message}`)
          );
        }

        // Keep entry briefly for polling
        setTimeout(() => {
          if (task.status === "rejected" || task.status === "canceled") {
            runtime.a2aTasksByToken.delete(token);
          }
        }, 300_000).unref?.(); // 5 min cleanup for rejected/canceled

        return writeJson(res, 200, { ok: true, action });
      }

      // A2A task status polling (for external callers, authenticated via A2A key)
      const apiA2ATaskStatus = url.pathname.match(/^\/api\/providers\/a2a\/tasks\/([^/]+)\/status$/u);
      if (apiA2ATaskStatus && req.method === "GET") {
        const apiKey = req.headers["x-a2a-key"] || "";
        if (!config.a2aApiKey || apiKey !== config.a2aApiKey) {
          return writeJson(res, 401, { error: "unauthorized" });
        }
        const token = decodeURIComponent(apiA2ATaskStatus[1]);
        const task = runtime.a2aTasksByToken.get(token);
        if (!task) return writeJson(res, 404, { error: "task-not-found" });
        return writeJson(res, 200, {
          id: task.id,
          status: task.status,
          statusMessage: task.statusMessage || "",
          artifacts: task.artifacts,
          updatedAtMs: task.updatedAtMs,
        });
      }

      if (url.pathname === "/api/session" && req.method === "GET") {
        const session = readSession(req, config, state);
        const localeInfo = resolveDeviceLocaleInfo(config, state, session.deviceId);
        if (session.authenticated && session.deviceId) {
          const trustChanged = touchDeviceTrust(state, config, session.deviceId);
          const metadataChanged = updateCurrentDeviceSnapshot(state, config, session.deviceId, {
            userAgent: requestUserAgent(req),
            lastLocale: localeInfo.locale,
          });
          if (trustChanged || metadataChanged) {
            await saveState(config.stateFile, state);
          }
        }
        if (session.authenticated && session.restoredFromDevice) {
          setSessionCookie(res, config);
        }
        return writeJson(res, 200, buildSessionPayload({ config, state, session }));
      }

      // Collapses the PWA's boot-time fan-out (session + inbox + timeline
      // + devices) into a single HTTPS round-trip. iOS Safari tears down
      // connections aggressively, so each parallel fetch pays its own
      // TLS handshake — and `JSON.stringify(state)` hiccups on other
      // requests make those handshakes bursty. One endpoint = one
      // handshake + one response, which drops the "Completed list is
      // blank for several seconds after launch" latency floor.
      if (url.pathname === "/api/bootstrap" && req.method === "GET") {
        const session = readSession(req, config, state);
        const localeInfo = resolveDeviceLocaleInfo(config, state, session.deviceId);
        if (session.authenticated && session.deviceId) {
          const trustChanged = touchDeviceTrust(state, config, session.deviceId);
          const metadataChanged = updateCurrentDeviceSnapshot(state, config, session.deviceId, {
            userAgent: requestUserAgent(req),
            lastLocale: localeInfo.locale,
          });
          if (trustChanged || metadataChanged) {
            await saveState(config.stateFile, state);
          }
        }
        if (session.authenticated && session.restoredFromDevice) {
          setSessionCookie(res, config);
        }
        const sessionPayload = buildSessionPayload({ config, state, session });
        if (!session.authenticated) {
          return writeJson(res, 200, { session: sessionPayload });
        }
        return writeJson(res, 200, {
          session: sessionPayload,
          inbox: buildInboxFastResponse(runtime, state, config, localeInfo.locale),
          timeline: buildTimelineResponse(runtime, state, config, localeInfo.locale),
          devices: buildDevicesResponse({ config, state, session, locale: localeInfo.locale }),
        });
      }

      if (url.pathname === "/api/session/pair" && req.method === "POST") {
        if (!requireTrustedMutationOrigin(req, res, config)) {
          return;
        }
        const remoteAddress = readRemoteAddress(req);
        const limitedRetryAfterSecs = getPairingRetryAfterSecs(runtime, remoteAddress);
        if (limitedRetryAfterSecs > 0) {
          return writePairingRateLimited(res, limitedRetryAfterSecs);
        }

        const payload = await parseJsonBody(req);
        const validation = validatePairingPayload(payload, config, state);
        if (!validation.ok) {
          const retryAfterSecs = recordPairingFailure(runtime, remoteAddress);
          if (retryAfterSecs > 0) {
            return writePairingRateLimited(res, retryAfterSecs);
          }
          return writeJson(res, 400, { error: validation.error });
        }

        if (payload?.temporary === true && cleanText(payload?.token || "")) {
          clearPairingFailures(runtime, remoteAddress);
          setTemporarySessionCookie(res, config);
          return writeJson(res, 200, {
            ok: true,
            authenticated: true,
            pairingAvailable: isPairingAvailableForState(config, state),
            temporaryPairing: true,
          });
        }

        const pairedDeviceId = readDeviceId(req, config) || crypto.randomUUID();
        if ("detectedLocale" in payload) {
          upsertDetectedDeviceLocale(state, pairedDeviceId, payload.detectedLocale);
        }
        markDevicePaired(
          state,
          config,
          pairedDeviceId,
          {
            userAgent: cleanText(payload?.userAgent ?? "") || requestUserAgent(req),
            standalone: payload?.standalone === true,
            lastLocale: normalizeSupportedLocale(payload?.detectedLocale),
          }
        );
        if (String(validation.credential || "").startsWith("code:")) {
          markPairingConsumed(state, validation.credential);
        }
        clearPairingFailures(runtime, remoteAddress);
        await saveState(config.stateFile, state);
        setPairingCookies(res, config, pairedDeviceId);
        return writeJson(res, 200, {
          ok: true,
          authenticated: true,
          pairingAvailable: isPairingAvailableForState(config, state),
        });
      }

      if (url.pathname === "/api/session/logout" && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) {
          return;
        }
        const payload = await parseJsonBody(req);
        const revokeCurrentDeviceTrust = payload?.revokeCurrentDeviceTrust === true;
        let changed = false;
        if (revokeCurrentDeviceTrust && session.deviceId) {
          changed = revokeDeviceTrust(state, config, session.deviceId) || changed;
          changed = deletePushSubscriptionsForDevice(state, session.deviceId) || changed;
        }
        if (changed) {
          await saveState(config.stateFile, state);
        }
        if (revokeCurrentDeviceTrust) {
          clearAuthCookies(res, config);
        } else {
          clearSessionCookie(res, config);
        }
        return writeJson(res, 200, {
          ok: true,
          revokeCurrentDeviceTrust,
          currentDeviceRevoked: revokeCurrentDeviceTrust && Boolean(session.deviceId),
        });
      }

      if (url.pathname === "/api/session/locale" && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) {
          return;
        }
        if (!session.deviceId) {
          return writeJson(res, 409, { error: "device-id-missing" });
        }

        const payload = await parseJsonBody(req);
        let changed = false;
        if ("detectedLocale" in payload) {
          changed = upsertDetectedDeviceLocale(state, session.deviceId, payload.detectedLocale) || changed;
        }
        if ("overrideLocale" in payload) {
          if (payload.overrideLocale == null || cleanText(payload.overrideLocale) === "") {
            changed = clearDeviceLocaleOverride(state, session.deviceId) || changed;
          } else {
            changed = setDeviceLocaleOverride(state, session.deviceId, payload.overrideLocale) || changed;
          }
        }
        changed = updateCurrentDeviceSnapshot(state, config, session.deviceId, {
          userAgent: requestUserAgent(req),
          lastLocale: resolveDeviceLocaleInfo(config, state, session.deviceId).locale,
        }) || changed;
        if (changed) {
          scheduleSaveState(config, state);
        }
        return writeJson(res, 200, {
          ok: true,
          ...buildSessionLocalePayload(config, state, session.deviceId),
        });
      }

      if (url.pathname === "/api/settings/claude-away-mode" && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) {
          return;
        }
        let payload;
        try {
          payload = await parseJsonBody(req);
        } catch {
          return writeJson(res, 400, { error: "invalid-json-body" });
        }
        const enabled = payload?.enabled === true;
        if (state.claudeAwayMode !== enabled) {
          state.claudeAwayMode = enabled;
          scheduleSaveState(config, state);
        }
        await syncClaudeAwayModeSentinel(config, enabled);
        return writeJson(res, 200, { ok: true, enabled });
      }

      if (url.pathname === "/api/settings/auto-pilot" && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) {
          return;
        }
        let payload;
        try {
          payload = await parseJsonBody(req);
        } catch {
          return writeJson(res, 400, { error: "invalid-json-body" });
        }
        const trustedReadsEnabled =
          typeof payload?.trustedReadsEnabled === "boolean"
            ? payload.trustedReadsEnabled === true
            : state.autoPilotTrustedReads === true;
        const hasLaneUpdate =
          typeof payload?.writeLaneContentEnabled === "boolean" ||
          typeof payload?.writeLaneUiTestsEnabled === "boolean" ||
          typeof payload?.writeLaneSourceEnabled === "boolean";
        const legacyTrustedWritesEnabled =
          typeof payload?.trustedWritesEnabled === "boolean"
            ? payload.trustedWritesEnabled === true
            : typeof payload?.trustedWritesShadowEnabled === "boolean"
              ? payload.trustedWritesShadowEnabled === true
              : null;
        const currentLanes = autoPilotWriteLaneState(state);
        const writeLaneContentEnabled =
          typeof payload?.writeLaneContentEnabled === "boolean"
            ? payload.writeLaneContentEnabled === true
            : !hasLaneUpdate && legacyTrustedWritesEnabled != null
              ? legacyTrustedWritesEnabled
              : currentLanes.content;
        const writeLaneUiTestsEnabled =
          typeof payload?.writeLaneUiTestsEnabled === "boolean"
            ? payload.writeLaneUiTestsEnabled === true
            : currentLanes.uiTests;
        const writeLaneSourceEnabled =
          typeof payload?.writeLaneSourceEnabled === "boolean"
            ? payload.writeLaneSourceEnabled === true
            : currentLanes.source;
        const trustedWritesEnabled =
          writeLaneContentEnabled || writeLaneUiTestsEnabled || writeLaneSourceEnabled;
        if (
          state.autoPilotTrustedReads !== trustedReadsEnabled ||
          state.autoPilotWriteLaneContent !== writeLaneContentEnabled ||
          state.autoPilotWriteLaneUiTests !== writeLaneUiTestsEnabled ||
          state.autoPilotWriteLaneSource !== writeLaneSourceEnabled ||
          isAutoPilotTrustedWritesEnabled(state) !== trustedWritesEnabled
        ) {
          state.autoPilotTrustedReads = trustedReadsEnabled;
          state.autoPilotTrustedWrites = trustedWritesEnabled;
          state.autoPilotTrustedWritesShadow = false;
          state.autoPilotWriteLaneContent = writeLaneContentEnabled;
          state.autoPilotWriteLaneUiTests = writeLaneUiTestsEnabled;
          state.autoPilotWriteLaneSource = writeLaneSourceEnabled;
          await saveState(config.stateFile, state);
        }
        return writeJson(res, 200, {
          ok: true,
          trustedReadsEnabled,
          trustedWritesEnabled,
          trustedWritesShadowEnabled: false,
          writeLaneContentEnabled,
          writeLaneUiTestsEnabled,
          writeLaneSourceEnabled,
        });
      }

      if (url.pathname === "/api/settings/a2a-executor" && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) return;
        let payload;
        try {
          payload = await parseJsonBody(req);
        } catch {
          return writeJson(res, 400, { error: "invalid-json-body" });
        }
        const valid = new Set(["auto", "codex", "claude", "ask"]);
        const preference = valid.has(payload?.preference) ? payload.preference : "auto";
        if (state.a2aExecutorPreference !== preference) {
          state.a2aExecutorPreference = preference;
          scheduleSaveState(config, state);
        }
        return writeJson(res, 200, { ok: true, preference });
      }

      if (url.pathname === "/api/moltbook/scout-status" && req.method === "GET") {
        const session = requireApiSession(req, res, config, state);
        if (!session) {
          return;
        }
        if (!config.moltbookApiKey) {
          return writeJson(res, 200, { enabled: false });
        }
        try {
          const { readScoutState, rollScoutDayIfNeeded, createMoltbookClient } = await import("./moltbook-api.mjs");
          const scoutState = rollScoutDayIfNeeded(await readScoutState());
          const batch = scoutState.batch;
          const batchInfo = batch && batch.candidates?.length ? {
            collecting: true,
            candidateCount: batch.candidates.length,
            topScore: Math.max(...batch.candidates.map((c) => c.score || 0)),
            remainingSeconds: Math.max(0, Math.round(((batch.startedAt || 0) + (batch.windowMs || 1800000) - Date.now()) / 1000)),
          } : null;

          // Agent profile — lazy-fetched, cached 1h. Stale cache survives
          // fetch failures so the UI never goes blank mid-outage.
          let account = null;
          try {
            const PROFILE_TTL_MS = 60 * 60 * 1000;
            const cached = runtime.moltbookAgentProfile;
            const nowMs = Date.now();
            if (!cached || nowMs - (cached.fetchedAtMs || 0) > PROFILE_TTL_MS) {
              const mb = createMoltbookClient(config.moltbookApiKey);
              const meRes = await mb("/agents/me");
              const name = cleanText(meRes?.agent?.name || meRes?.agent?.display_name || "");
              if (name) {
                runtime.moltbookAgentProfile = {
                  name,
                  profileUrl: `https://www.moltbook.com/u/${encodeURIComponent(name)}`,
                  fetchedAtMs: nowMs,
                };
              }
            }
          } catch {
            // Fall through — if fetch fails, use whatever's cached (possibly null).
          }
          if (runtime.moltbookAgentProfile) {
            account = {
              name: runtime.moltbookAgentProfile.name,
              profileUrl: runtime.moltbookAgentProfile.profileUrl,
            };
          }

          return writeJson(res, 200, {
            enabled: true,
            account,
            day: scoutState.day,
            sentToday: scoutState.sentToday,
            maxDaily: 5,
            seenPostCount: Object.keys(scoutState.seenPostIds || {}).length,
            batch: batchInfo,
            composedToday: scoutState.composedToday || 0,
            composeSlotsAttempted: Array.isArray(scoutState.composeSlotsAttempted) ? scoutState.composeSlotsAttempted : [],
            recentComposeTitles: Array.isArray(scoutState.recentComposeTitles) ? scoutState.recentComposeTitles : [],
          });
        } catch {
          return writeJson(res, 200, { enabled: true, day: "", sentToday: 0, maxDaily: 5, seenPostCount: 0 });
        }
      }

      // A2A relay status for the settings UI.
      if (url.pathname === "/api/a2a/relay-status" && req.method === "GET") {
        const session = requireApiSession(req, res, config, state);
        if (!session) return;
        const relayEnabled = Boolean(config.a2aRelayUrl && config.a2aRelayUserId);
        if (!relayEnabled) {
          return writeJson(res, 200, { enabled: false });
        }
        const relay = getRelayStatus();
        const stats = state.a2aTaskStats || { received: 0, completed: 0, denied: 0 };
        return writeJson(res, 200, {
          enabled: true,
          connected: relay.polling && relay.lastPollOk,
          polling: relay.polling,
          lastPollOk: relay.lastPollOk,
          lastPollAtMs: relay.lastPollAtMs,
          userId: config.a2aRelayUserId,
          relayUrl: config.a2aRelayUrl,
          apiKeyConfigured: Boolean(config.a2aApiKey),
          acceptPublicTasks: config.a2aAcceptPublicTasks === true,
          taskStats: stats,
        });
      }

      // A2A Share status (HTML hosting) for the settings UI. Reuses A2A
      // credentials; enabled iff both user id + API key are provisioned.
      // Results from the upstream `/api/list` call are cached for 30s so a
      // settings-page render doesn't hammer the worker on every refresh tick.
      if (url.pathname === "/api/share/status" && req.method === "GET") {
        const session = requireApiSession(req, res, config, state);
        if (!session) return;
        const enabled = Boolean(config.a2aRelayUserId && config.a2aApiKey);
        if (!enabled) {
          return writeJson(res, 200, { enabled: false });
        }
        const shareHost = (() => {
          try { return new URL(config.a2aShareUrl).host; } catch { return config.a2aShareUrl || ""; }
        })();
        // Mirror the constants baked into share-worker/worker.js. If those
        // change, bump here too — there's no shared module between the two.
        const limits = {
          maxFileBytes: 5 * 1024 * 1024,
          maxTotalBytes: 5 * 1024 * 1024,
          maxFiles: 10,
          defaultExpiresDays: 30,
          maxExpiresDays: 30,
          uploadRatePerHour: 10,
        };
        const cacheKey = `${config.a2aRelayUserId}|${config.a2aShareUrl}`;
        const nowMs = Date.now();
        const cached = runtime.a2aShareStatusCache;
        if (cached && cached.key === cacheKey && nowMs - cached.fetchedAtMs < 30_000) {
          return writeJson(res, 200, {
            enabled: true,
            userId: config.a2aRelayUserId,
            shareUrl: config.a2aShareUrl,
            shareHost,
            limits,
            ...cached.payload,
            fetchedAtMs: cached.fetchedAtMs,
          });
        }
        let upstream = { items: [], quota: null, error: null };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          const resUpstream = await fetch(`${config.a2aShareUrl}/api/list`, {
            method: "GET",
            headers: {
              "x-a2a-user": config.a2aRelayUserId,
              "x-a2a-key": config.a2aApiKey,
            },
            signal: controller.signal,
          });
          if (resUpstream.ok) {
            const body = await resUpstream.json().catch(() => ({}));
            upstream.items = Array.isArray(body.items) ? body.items : [];
            upstream.quota = body.quota || null;
          } else {
            upstream.error = `HTTP ${resUpstream.status}`;
          }
        } catch (error) {
          upstream.error = error?.name === "AbortError"
            ? "upstream timeout"
            : (error?.message || String(error));
        } finally {
          clearTimeout(timer);
        }
        runtime.a2aShareStatusCache = { key: cacheKey, fetchedAtMs: nowMs, payload: upstream };
        return writeJson(res, 200, {
          enabled: true,
          userId: config.a2aRelayUserId,
          shareUrl: config.a2aShareUrl,
          shareHost,
          limits,
          ...upstream,
          fetchedAtMs: nowMs,
        });
      }


if (url.pathname === "/api/hazbase/status" && req.method === "GET") {
  const hookSecret = req.headers["x-viveworker-hook-secret"] || "";
  const hookAuth = config.sessionSecret && hookSecret === config.sessionSecret;
  if (!hookAuth) {
    const session = requireApiSession(req, res, config, state);
    if (!session) return;
  }
  if (!config.hazbaseApiUrl) {
    return writeJson(res, 200, { enabled: false });
  }
  const hazbase = normalizeHazbaseState(state.hazbase);
  let payments = null;
  let chains = null;
  let error = "";
  try {
    payments = await listSupportedPayments();
  } catch (err) {
    error = err?.message || String(err);
  }
  try {
    chains = await listSupportedChains();
  } catch (err) {
    error = error || err?.message || String(err);
  }
  const supportedChains = Array.isArray(chains?.chains)
    ? chains.chains.filter((entry) => Number(entry.chainId) === 8453 || Number(entry.chainId) === 84532)
    : [];
  const payoutAddresses = {
    8453: resolveHazbaseAccountForChain(hazbase.accounts, 8453)?.smartAccountAddress || "",
    84532: resolveHazbaseAccountForChain(hazbase.accounts, 84532)?.smartAccountAddress || "",
  };
  return writeJson(res, 200, {
    enabled: true,
    apiUrl: config.hazbaseApiUrl,
    signedIn: Boolean(hazbase.accessToken),
    email: hazbase.email,
    userId: hazbase.userId,
    sessionId: hazbase.sessionId,
    deviceBindingId: hazbase.deviceBindingId,
    credentialId: hazbase.credentialId,
    highTrustExpiresAt: hazbase.highTrustExpiresAt,
    accounts: hazbase.accounts,
    supportedPayments: payments?.networks || [],
    supportedChains,
    defaultPaymentNetwork: payments?.defaultNetwork || "base-sepolia",
    payoutAddresses,
    error,
  });
}

if (url.pathname === "/api/hazbase/payout-address" && req.method === "GET") {
  const hookSecret = req.headers["x-viveworker-hook-secret"] || "";
  const hookAuth = config.sessionSecret && hookSecret === config.sessionSecret;
  if (!hookAuth) {
    const session = requireApiSession(req, res, config, state);
    if (!session) return;
  }
  const hazbase = normalizeHazbaseState(state.hazbase);
  if (!hazbase.accessToken) return writeJson(res, 401, { error: "hazbase-auth-required" });
  const chainId = Number(url.searchParams.get("chainId") || 0);
  if (chainId !== 8453 && chainId !== 84532) {
    return writeJson(res, 400, { error: "unsupported-chain" });
  }
  const account = resolveHazbaseAccountForChain(hazbase.accounts, chainId);
  if (!account?.smartAccountAddress) {
    return writeJson(res, 409, { error: "hazbase-wallet-account-missing" });
  }
  return writeJson(res, 200, {
    chainId,
    payoutMethod: "hazbase_wallet",
    payoutAddress: account.smartAccountAddress,
    smartAccountAddress: account.smartAccountAddress,
    accountVariant: account.accountVariant || "",
    relayMode: account.relayMode || "",
  });
}

if (url.pathname === "/api/hazbase/request-otp" && req.method === "POST") {
  const session = requireMutatingApiSession(req, res, config, state);
  if (!session) return;
  const body = await parseJsonBody(req);
  const email = cleanText(body?.email || "");
  if (!email) return writeJson(res, 400, { error: "email-required" });
  const result = await requestHazbaseEmailOtp({ email });
  state.hazbase = { ...normalizeHazbaseState(state.hazbase), email };
  await saveState(config.stateFile, state);
  return writeJson(res, 200, result);
}

if (url.pathname === "/api/hazbase/verify-otp" && req.method === "POST") {
  const session = requireMutatingApiSession(req, res, config, state);
  if (!session) return;
  const body = await parseJsonBody(req);
  const email = cleanText(body?.email || state.hazbase?.email || "");
  const code = cleanText(body?.code || "");
  if (!email || !code) return writeJson(res, 400, { error: "otp-required" });
  const result = await verifyHazbaseEmailOtp({ email, code });
  state.hazbase = {
    ...normalizeHazbaseState(state.hazbase),
    email: result.email || email,
    accessToken: cleanText(result.accessToken || ""),
    sessionId: cleanText(result.sessionId || ""),
    userId: cleanText(result.userId || ""),
    accounts: Array.isArray(result.accounts) ? result.accounts : [],
    highTrustToken: "",
    highTrustExpiresAt: "",
  };
  await saveState(config.stateFile, state);
  return writeJson(res, 200, result);
}

if (url.pathname === "/api/hazbase/passkey/register/challenge" && req.method === "POST") {
  const session = requireMutatingApiSession(req, res, config, state);
  if (!session) return;
  const hazbase = normalizeHazbaseState(state.hazbase);
  if (!hazbase.accessToken) return writeJson(res, 401, { error: "hazbase-auth-required" });
  const body = await parseJsonBody(req);
  const result = await requestPasskeyRegistrationChallenge({
    emailSession: hazbase.accessToken,
    deviceLabel: cleanText(body?.deviceLabel || config.hazbaseDeviceLabel || "") || undefined,
  });
  return writeJson(res, 200, result);
}

if (url.pathname === "/api/hazbase/passkey/register/complete" && req.method === "POST") {
  const session = requireMutatingApiSession(req, res, config, state);
  if (!session) return;
  const hazbase = normalizeHazbaseState(state.hazbase);
  if (!hazbase.accessToken) return writeJson(res, 401, { error: "hazbase-auth-required" });
  const body = await parseJsonBody(req);
  const result = await completePasskeyRegistration({
    emailSession: hazbase.accessToken,
    challengeId: cleanText(body?.challengeId || ""),
    credential: body?.credential,
    deviceLabel: cleanText(body?.deviceLabel || config.hazbaseDeviceLabel || "") || undefined,
  });
  state.hazbase = {
    ...hazbase,
    deviceBindingId: cleanText(result.deviceBindingId || hazbase.deviceBindingId || ""),
    credentialId: cleanText(result.credentialId || hazbase.credentialId || ""),
  };
  await saveState(config.stateFile, state);
  return writeJson(res, 200, result);
}

if (url.pathname === "/api/hazbase/passkey/assert/challenge" && req.method === "POST") {
  const session = requireMutatingApiSession(req, res, config, state);
  if (!session) return;
  const hazbase = normalizeHazbaseState(state.hazbase);
  if (!hazbase.accessToken) return writeJson(res, 401, { error: "hazbase-auth-required" });
  const body = await parseJsonBody(req);
  const result = await requestPasskeyAssertionChallenge({
    emailSession: hazbase.accessToken,
    purpose: cleanText(body?.purpose || "bootstrap") || "bootstrap",
    deviceBindingId: hazbase.deviceBindingId || undefined,
  });
  return writeJson(res, 200, result);
}

if (url.pathname === "/api/hazbase/passkey/assert/complete" && req.method === "POST") {
  const session = requireMutatingApiSession(req, res, config, state);
  if (!session) return;
  const hazbase = normalizeHazbaseState(state.hazbase);
  if (!hazbase.accessToken) return writeJson(res, 401, { error: "hazbase-auth-required" });
  const body = await parseJsonBody(req);
  const result = await completePasskeyAssertion({
    emailSession: hazbase.accessToken,
    challengeId: cleanText(body?.challengeId || ""),
    credential: body?.credential,
    purpose: cleanText(body?.purpose || "bootstrap") || "bootstrap",
    deviceBindingId: hazbase.deviceBindingId || undefined,
  });
  state.hazbase = {
    ...hazbase,
    deviceBindingId: cleanText(result.deviceBindingId || hazbase.deviceBindingId || ""),
    credentialId: cleanText(result.credentialId || hazbase.credentialId || ""),
    highTrustToken: cleanText(result.highTrustToken || ""),
    highTrustExpiresAt: cleanText(result.highTrustExpiresAt || ""),
  };
  await saveState(config.stateFile, state);
  return writeJson(res, 200, result);
}

if (url.pathname === "/api/hazbase/account/bootstrap" && req.method === "POST") {
  const session = requireMutatingApiSession(req, res, config, state);
  if (!session) return;
  const hazbase = normalizeHazbaseState(state.hazbase);
  if (!hazbase.accessToken || !hazbase.deviceBindingId || !hazbase.highTrustToken) {
    return writeJson(res, 409, { error: "hazbase-bootstrap-prerequisites-missing" });
  }
  const body = await parseJsonBody(req);
  const chainId = Number(body?.chainId || 0);
  if (chainId !== 8453 && chainId !== 84532) {
    return writeJson(res, 400, { error: "unsupported-chain" });
  }
  const result = await bootstrapPasskeyAccount({
    emailSession: hazbase.accessToken,
    deviceBindingId: hazbase.deviceBindingId,
    highTrustToken: hazbase.highTrustToken,
    chainId,
  });
  const nextAccounts = mergeHazbaseAccountSummaries(hazbase.accounts, [{
    smartAccountAddress: result.smartAccountAddress,
    chainId: result.chainId,
    accountVariant: result.accountVariant,
    relayMode: result.relayMode,
    primaryDeviceBindingId: result.deviceBindingId,
  }]);
  state.hazbase = {
    ...hazbase,
    accounts: nextAccounts,
  };
  await saveState(config.stateFile, state);
  return writeJson(res, 200, result);
}

if (url.pathname === "/api/hazbase/logout" && req.method === "POST") {
  const session = requireMutatingApiSession(req, res, config, state);
  if (!session) return;
  state.hazbase = normalizeHazbaseState(null);
  await saveState(config.stateFile, state);
  return writeJson(res, 200, { ok: true });
}

      // Toggle acceptPublicTasks on the A2A relay.
      if (url.pathname === "/api/a2a/public-tasks" && req.method === "POST") {
        const session = requireApiSession(req, res, config, state);
        if (!session) return;
        const body = await parseJsonBody(req);
        const accept = body?.accept === true;
        config.a2aAcceptPublicTasks = accept;
        state.a2aAcceptPublicTasks = accept;
        scheduleSaveState(config, state);
        // Re-register with relay to propagate the flag.
        if (config.a2aRelayUrl && config.a2aRelayUserId) {
          try {
            await updatePublicTasksFlag({ config, buildAgentCard, acceptPublicTasks: accept });
            console.log(`[a2a-relay] acceptPublicTasks updated to ${accept}`);
          } catch (error) {
            console.error(`[a2a-relay-public-update] ${error.message}`);
          }
        }
        return writeJson(res, 200, { ok: true, acceptPublicTasks: accept });
      }

      // ─── Thread sharing ──────────────────────────────────────────────

      function buildThreadShareContent(shareType, body) {
        if (shareType === "plan_review") {
          const sections = [];
          if (body.context) sections.push(`## Context\n${body.context}`);
          if (body.plan) sections.push(`## Plan\n${body.plan}`);
          if (Array.isArray(body.files) && body.files.length) {
            sections.push(`## Relevant files\n${body.files.map((f) => `- ${f}`).join("\n")}`);
          }
          sections.push(`## Instruction\n${body.instruction || "共有されたプランの内容を把握し、実現可能性や改善点を検討してください。"}`);
          return sections.join("\n\n");
        }
        if (shareType === "handoff") {
          const sections = [];
          if (body.summary) sections.push(`## Summary\n${body.summary}`);
          if (Array.isArray(body.completed) && body.completed.length) {
            sections.push(`## Completed\n${body.completed.map((t) => `- ${t}`).join("\n")}`);
          }
          if (Array.isArray(body.remaining) && body.remaining.length) {
            sections.push(`## Remaining\n${body.remaining.map((t) => `- ${t}`).join("\n")}`);
          }
          if (Array.isArray(body.decisions) && body.decisions.length) {
            sections.push(`## Key decisions\n${body.decisions.map((d) => `- ${d}`).join("\n")}`);
          }
          if (Array.isArray(body.modifiedFiles) && body.modifiedFiles.length) {
            sections.push(`## Modified files\n${body.modifiedFiles.map((f) => `- ${f}`).join("\n")}`);
          }
          sections.push(`## Instruction\n${body.instruction || "これまでの作業内容と経緯を把握した上で、次に何をすべきか検討してください。"}`);
          return sections.join("\n\n");
        }
        // Default: message type — use raw content.
        return cleanText(body?.content || "");
      }

      // List known threads (active + registry) for the share target picker.
      if (url.pathname === "/api/threads/list" && req.method === "GET") {
        const hookSecret = req.headers["x-viveworker-hook-secret"] || "";
        const hookAuth = config.sessionSecret && hookSecret === config.sessionSecret;
        if (!hookAuth) { const session = requireApiSession(req, res, config, state); if (!session) return; }
        const codexConnected = Boolean(runtime.ipcClient?.clientId);
        const activeIds = new Set();
        const threads = [];
        // Active Codex threads (from IPC).
        for (const [conversationId, threadState] of runtime.threadStates) {
          activeIds.add(conversationId);
          const label = getThreadName(
            runtime.sessionIndex,
            runtime.rolloutThreadLabels,
            conversationId,
            cleanText(threadState?.cwd || ""),
            ""
          );
          threads.push({
            conversationId,
            label: label || conversationId.slice(0, 8),
            tool: "codex",
            cwd: cleanText(threadState?.cwd || ""),
            hasOwner: runtime.threadOwnerClientIds.has(conversationId),
            active: true,
          });
        }
        // Registry entries not already covered by active threads.
        for (const entry of runtime.threadRegistry.values()) {
          if (!activeIds.has(entry.id)) {
            threads.push({
              conversationId: entry.id,
              label: entry.label || entry.id.slice(0, 8),
              tool: entry.tool || "codex",
              cwd: entry.cwd || "",
              hasOwner: false,
              active: false,
              lastSeenAtMs: entry.lastSeenAtMs || 0,
            });
          }
        }
        return writeJson(res, 200, { threads, codexConnected });
      }

      // Submit a thread share request (creates an approval item on the phone).
      if (url.pathname === "/api/threads/share" && req.method === "POST") {
        const hookSecret = req.headers["x-viveworker-hook-secret"] || "";
        const hookAuth = config.sessionSecret && hookSecret === config.sessionSecret;
        if (!hookAuth) { const session = requireApiSession(req, res, config, state); if (!session) return; }
        const body = await parseJsonBody(req);
        const shareType = cleanText(body?.shareType || "message");
        const sourceTool = cleanText(body?.sourceTool || "");
        const sourceLabel = cleanText(body?.sourceLabel || "");
        const targetConversationId = cleanText(body?.targetConversationId || "");
        let targetTool = cleanText(body?.targetTool || "");
        let targetCwd = cleanText(body?.targetCwd || "");
        const contextFiles = Array.isArray(body?.contextFiles)
          ? body.contextFiles.map((f) => cleanText(String(f))).filter(Boolean)
          : [];

        // Auto-resolve targetTool and targetCwd from registry if not provided.
        if (targetConversationId) {
          const regEntry = runtime.threadRegistry.get(targetConversationId);
          if (regEntry) {
            if (!targetTool) targetTool = regEntry.tool || "";
            if (!targetCwd) targetCwd = regEntry.cwd || "";
          }
        }

        // Build content from structured fields depending on shareType.
        const content = buildThreadShareContent(shareType, body);
        if (!content && contextFiles.length === 0) {
          return writeJson(res, 400, { error: "missing-content" });
        }
        if (!targetConversationId && !targetTool) {
          return writeJson(res, 400, { error: "missing-target" });
        }
        const shareId = crypto.randomUUID();
        const token = historyToken(`thread_share:${shareId}`);
        const targetLabel = targetConversationId
          ? (getThreadName(runtime.sessionIndex, runtime.rolloutThreadLabels, targetConversationId, runtime.threadStates.get(targetConversationId)?.cwd || "", "") || runtime.threadRegistry.get(targetConversationId)?.label || "")
          : targetTool;
        const share = {
          token,
          shareId,
          shareType,
          content: content || "",
          contextFiles,
          sourceTool,
          sourceLabel,
          targetConversationId,
          targetTool: targetTool || "codex",
          targetCwd,
          targetLabel,
          createdAtMs: Date.now(),
          decision: null,
          decisionWaiters: [],
        };
        runtime.threadSharesByToken.set(token, share);
        try {
          const title = sourceLabel
            ? `${sourceLabel} → ${targetLabel || targetTool}`
            : `→ ${targetLabel || targetTool}`;
          recordTimelineEntry({
            config, runtime, state,
            entry: {
              stableId: `thread_share:${shareId}`,
              token,
              kind: "thread_share",
              threadId: "thread_share",
              threadLabel: "Thread Share",
              title,
              summary: String(content).slice(0, 160),
              messageText: content,
              createdAtMs: share.createdAtMs,
              readOnly: false,
              provider: "viveworker",
            },
          });
          await saveState(config.stateFile, state);
        } catch (error) {
          console.error(`[thread-share-timeline] ${error.message}`);
        }
        try {
          await deliverWebPushItem({
            config, state,
            kind: "thread_share",
            tab: "inbox",
            subtab: "pending",
            token,
            stableId: `thread_share:${shareId}`,
            title: `Thread Share: ${sourceLabel || sourceTool || "agent"} → ${targetLabel || targetTool}`,
            body: String(content).slice(0, 160),
          });
        } catch (error) {
          console.error(`[thread-share-push] ${error.message}`);
        }
        return writeJson(res, 200, { ok: true, token, shareId });
      }

      // Decision endpoint for thread share (approve / deny from phone).
      const threadShareDecisionMatch = url.pathname.match(/^\/api\/threads\/share\/([^/]+)\/decision$/);
      if (threadShareDecisionMatch && req.method === "POST") {
        const session = requireApiSession(req, res, config, state);
        if (!session) return;
        const token = cleanText(threadShareDecisionMatch[1]);
        const share = runtime.threadSharesByToken.get(token);
        if (!share) {
          return writeJson(res, 404, { error: "not-found" });
        }
        if (share.decision) {
          return writeJson(res, 200, { ok: true, decision: share.decision });
        }
        const body = await parseJsonBody(req);
        const decision = cleanText(body?.decision || "");
        const editedContent = typeof body?.editedContent === "string" ? body.editedContent : null;
        if (decision !== "approve" && decision !== "deny") {
          return writeJson(res, 400, { error: "invalid-decision" });
        }
        share.decision = decision;
        if (editedContent !== null) {
          share.content = editedContent;
        }

        // Deliver the shared content to the target.
        let deliveryStatus = "delivered";
        if (decision === "approve") {
          const prefix = share.sourceLabel ? `[Shared from ${share.sourceLabel}]\n\n` : "[Shared from another thread]\n\n";
          // Append context file references if present.
          if (share.contextFiles && share.contextFiles.length > 0) {
            const fileList = share.contextFiles.map((f) => `- ${f}`).join("\n");
            share.content = (share.content ? share.content + "\n\n" : "")
              + `## Context files\n\nRead the following files for full conversation context:\n${fileList}`;
          }
          let injectedViaIpc = false;

          // Try Codex IPC injection if targeting a specific thread.
          if (share.targetConversationId && runtime.ipcClient?.clientId) {
            const ownerClientId = runtime.threadOwnerClientIds.get(share.targetConversationId) ?? null;
            const turnStartParams = { input: buildTurnInput(prefix + share.content) };
            // Try direct first, then fall back to thread-follower.
            for (const transport of ["direct", "follower"]) {
              try {
                if (transport === "direct" && ownerClientId) {
                  await runtime.ipcClient.startTurnDirect(share.targetConversationId, turnStartParams, ownerClientId);
                } else {
                  await runtime.ipcClient.startTurn(share.targetConversationId, turnStartParams, ownerClientId);
                }
                injectedViaIpc = true;
                console.log(`[thread-share] Delivered to Codex thread ${share.targetConversationId} via ${transport}`);
                break;
              } catch (error) {
                console.error(`[thread-share-ipc-${transport}] ${error.message}`);
              }
            }
          }

          // Write to file inbox (always for claude-code targets, fallback for failed Codex delivery).
          if (!injectedViaIpc) {
            try {
              const inboxDir = path.join(os.homedir(), ".viveworker", "thread-inbox");
              await fs.mkdir(inboxDir, { recursive: true });
              const inboxFile = path.join(inboxDir, `${share.shareId}.json`);
              await fs.writeFile(inboxFile, JSON.stringify({
                shareId: share.shareId,
                content: share.content,
                contextFiles: share.contextFiles || [],
                targetCwd: share.targetCwd || "",
                sourceTool: share.sourceTool,
                sourceLabel: share.sourceLabel,
                targetTool: share.targetTool,
                createdAtMs: share.createdAtMs,
                deliveredAtMs: Date.now(),
              }, null, 2), "utf8");
              console.log(`[thread-share] Written to inbox: ${inboxFile}`);
            } catch (error) {
              console.error(`[thread-share-inbox-write] ${error.message}`);
            }

            // If the user intended Codex but it wasn't reachable, notify.
            if (share.targetConversationId && share.targetTool !== "claude-code") {
              deliveryStatus = "inbox_fallback";
              try {
                await deliverWebPushItem({
                  config, state,
                  kind: "thread_share",
                  tab: "inbox",
                  subtab: "completed",
                  token: share.token,
                  stableId: `thread_share_fallback:${share.shareId}`,
                  title: "Thread Share: target unreachable",
                  body: `Codex thread "${share.targetLabel || share.targetConversationId.slice(0, 8)}" is not connected. Content saved to inbox.`,
                });
              } catch (error) {
                console.error(`[thread-share-fallback-push] ${error.message}`);
              }
            }
          }
        }

        // Wake any long-poll waiters.
        for (const waiter of share.decisionWaiters) {
          waiter({ decision: share.decision, content: share.content });
        }
        share.decisionWaiters = [];
        return writeJson(res, 200, { ok: true, decision: share.decision });
      }

      // Long-poll: wait for a thread share decision (used by the CLI or hook).
      const threadSharePollMatch = url.pathname.match(/^\/api\/threads\/share\/([^/]+)\/poll$/);
      if (threadSharePollMatch && req.method === "GET") {
        const session = requireApiSession(req, res, config, state);
        if (!session) return;
        const token = cleanText(threadSharePollMatch[1]);
        const share = runtime.threadSharesByToken.get(token);
        if (!share) {
          return writeJson(res, 404, { error: "not-found" });
        }
        if (share.decision) {
          return writeJson(res, 200, { decision: share.decision, content: share.content });
        }
        const timeoutMs = Math.min(Number(url.searchParams.get("timeout")) || 120_000, 300_000);
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            const idx = share.decisionWaiters.indexOf(done);
            if (idx >= 0) share.decisionWaiters.splice(idx, 1);
            resolve();
          }, timeoutMs);
          timer.unref?.();
          function done(result) {
            clearTimeout(timer);
            resolve(result);
          }
          share.decisionWaiters.push(done);
        });
        if (share.decision) {
          return writeJson(res, 200, { decision: share.decision, content: share.content });
        }
        return writeJson(res, 200, { decision: null, timeout: true });
      }

      // Activity summary for compose (original post) drafting.
      // Supports ?slot=morning|noon|evening and ?date=YYYY-MM-DD for
      // time-slot-based compose.  Defaults to full-day today.
      if (url.pathname === "/api/providers/moltbook/activity-summary" && req.method === "GET") {
        const hookSecret = req.headers["x-viveworker-hook-secret"] || "";
        if (!config.sessionSecret || hookSecret !== config.sessionSecret) {
          return writeJson(res, 403, { error: "forbidden" });
        }
        const slot = String(url.searchParams.get("slot") || "").toLowerCase();
        const dateParam = String(url.searchParams.get("date") || "");
        const now = new Date();
        const localHour = now.getHours();

        // Determine time range based on slot.
        let rangeStart, rangeEnd, rangeDate;
        if (slot === "morning" && dateParam) {
          // Morning slot: previous day's activities (dateParam = yesterday).
          const d = new Date(dateParam + "T00:00:00");
          rangeStart = d.getTime();
          rangeEnd = rangeStart + 24 * 60 * 60 * 1000;
          rangeDate = dateParam;
        } else if (slot === "noon") {
          // Noon slot: today 00:00 – 12:00 local.
          const d = new Date(now); d.setHours(0, 0, 0, 0);
          rangeStart = d.getTime();
          const noon = new Date(now); noon.setHours(12, 0, 0, 0);
          rangeEnd = noon.getTime();
          rangeDate = d.toISOString().slice(0, 10);
        } else if (slot === "evening") {
          // Evening slot: today full day.
          const d = new Date(now); d.setHours(0, 0, 0, 0);
          rangeStart = d.getTime();
          rangeEnd = Date.now();
          rangeDate = d.toISOString().slice(0, 10);
        } else {
          // Default: today full day (UTC midnight to now).
          const d = new Date(now);
          d.setUTCHours(0, 0, 0, 0);
          rangeStart = d.getTime();
          rangeEnd = Date.now();
          rangeDate = d.toISOString().slice(0, 10);
        }

        const relevantKinds = new Set(["file_event", "completion", "plan_ready", "assistant_final"]);
        const entries = (runtime.recentTimelineEntries || [])
          .filter((e) => e.createdAtMs >= rangeStart && e.createdAtMs < rangeEnd && relevantKinds.has(e.kind))
          .map((e) => ({
            kind: e.kind,
            title: e.title || "",
            summary: e.summary || "",
            threadLabel: e.threadLabel || "",
            createdAtMs: e.createdAtMs,
          }));
        return writeJson(res, 200, { date: rangeDate, slot: slot || "full", entries });
      }

      if (url.pathname === "/api/push/status" && req.method === "GET") {
        const session = requireApiSession(req, res, config, state);
        if (!session) {
          return;
        }
        return writeJson(res, 200, buildPushStatusResponse(config, state, session));
      }

      if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) {
          return;
        }
        if (!config.webPushEnabled) {
          return writeJson(res, 409, { error: "web-push-disabled" });
        }
        if (!session.deviceId) {
          return writeJson(res, 409, { error: "device-id-missing" });
        }

        const payload = await parseJsonBody(req);
        const subscription = normalizePushSubscriptionBody(payload, session.deviceId);
        if (!subscription) {
          return writeJson(res, 400, { error: "invalid-push-subscription" });
        }

        const changed = upsertPushSubscription(state, subscription);
        const metadataChanged = updateCurrentDeviceSnapshot(state, config, session.deviceId, {
          userAgent: subscription.userAgent || requestUserAgent(req),
          standalone: subscription.standalone === true,
          lastLocale: resolveDeviceLocaleInfo(config, state, session.deviceId).locale,
        });
        if (changed || metadataChanged) {
          scheduleSaveState(config, state);
        }
        return writeJson(res, 200, {
          ok: true,
          subscribed: true,
          subscriptionId: subscription.id,
        });
      }

      if (url.pathname === "/api/push/unsubscribe" && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) {
          return;
        }
        const payload = await parseJsonBody(req);
        let changed = false;
        const endpoint = cleanText(payload?.endpoint ?? "");
        if (endpoint) {
          changed = deletePushSubscriptionById(state, pushSubscriptionId(endpoint)) || changed;
        } else if (session.deviceId) {
          changed = deletePushSubscriptionsForDevice(state, session.deviceId) || changed;
        }
        if (changed) {
          scheduleSaveState(config, state);
        }
        return writeJson(res, 200, { ok: true, subscribed: false });
      }

      if (url.pathname === "/api/push/test" && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) {
          return;
        }
        try {
          await sendPushTestToDevice({ config, state, session });
          scheduleSaveState(config, state);
          return writeJson(res, 200, { ok: true });
        } catch (error) {
          const statusCode = Number(error?.statusCode) || 0;
          if (statusCode === 404 || statusCode === 410) {
            deletePushSubscriptionsForDevice(state, session.deviceId);
            scheduleSaveState(config, state);
            return writeJson(res, 410, { error: "push-subscription-expired" });
          }
          return writeJson(res, 500, {
            error: error.message,
            ipcError: error.ipcError ?? null,
          });
        }
      }

      if (url.pathname === "/api/devices" && req.method === "GET") {
        const session = requireApiSession(req, res, config, state);
        if (!session) {
          return;
        }
        const locale = resolveDeviceLocaleInfo(config, state, session.deviceId).locale;
        return writeJson(res, 200, buildDevicesResponse({ config, state, session, locale }));
      }

      const apiDeviceRevokeMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/revoke$/u);
      if (apiDeviceRevokeMatch && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) {
          return;
        }
        const deviceId = decodeURIComponent(apiDeviceRevokeMatch[1]);
        const existing = getActiveDeviceTrustRecord(state, config, deviceId);
        if (!existing) {
          return writeJson(res, 404, { error: "device-not-found" });
        }
        let changed = false;
        changed = revokeDeviceTrust(state, config, deviceId) || changed;
        changed = deletePushSubscriptionsForDevice(state, deviceId) || changed;
        if (changed) {
          await saveState(config.stateFile, state);
        }
        const currentDeviceRevoked = deviceId === session.deviceId;
        if (currentDeviceRevoked) {
          clearAuthCookies(res, config);
        }
        return writeJson(res, 200, {
          ok: true,
          deviceId,
          currentDeviceRevoked,
        });
      }

      if (url.pathname === "/api/providers/claude/events" && req.method === "POST") {
        const hookSecret = req.headers["x-viveworker-hook-secret"] || "";
        if (!config.sessionSecret || hookSecret !== config.sessionSecret) {
          return writeJson(res, 401, { error: "unauthorized" });
        }

        let body;
        try {
          body = await parseJsonBody(req);
        } catch {
          return writeJson(res, 400, { error: "invalid-json-body" });
        }

        const eventType = String(body.eventType || body.hookEventName || "");

        if (eventType === "Stop" || eventType === "SessionEnd") {
          // Agent turn ended — any still-pending native approvals for this
          // session were not resolved by PostToolUse, meaning the user
          // denied them on PC. Resolve as deny so iPhone clears them.
          const threadId = String(body.threadId || body.sessionId || "");
          console.log(`[claude-stop] threadId=${threadId} pendingTotal=${runtime.nativeApprovalsByToken.size}`);
          if (threadId) {
            const pending = [];
            for (const approval of runtime.nativeApprovalsByToken.values()) {
              if (!approval.resolved && approval.conversationId === threadId) {
                pending.push(approval);
              }
            }
            console.log(`[claude-stop] matched=${pending.length}`);
            for (const approval of pending) {
              try {
                await handleNativeApprovalDecision({ config, runtime, state, approval, decision: "reject" });
              } catch (error) {
                console.error(`[claude-stop-resolve-error] ${approval.requestKey} | ${error.message}`);
              }
            }
          }
          return writeJson(res, 200, {});
        }

        if (eventType === "file_event") {
          const threadId = String(body.threadId || body.sessionId || "");
          const filePath = String(body.filePath || "");
          const fileEventType = String(body.fileEventType || "");
          if (!threadId || !filePath || !fileEventType) {
            return writeJson(res, 200, {});
          }
          const eventCwd = String(body.cwd || "");
          const createdAtMs = Number(body.createdAtMs) || Date.now();
          const threadLabel =
            runtime.claudeSessionTitles.get(threadId) ||
            getNativeThreadLabel({ runtime, conversationId: threadId, cwd: eventCwd }) ||
            (eventCwd ? path.basename(eventCwd) : "") ||
            threadId.slice(0, 40);
          const stableId = `file_event:${fileEventType}:${threadId}:${historyToken(`${threadId}:${createdAtMs}:${filePath}`)}`;
          const token = historyToken(`file_event:${fileEventType}:${threadId}:${createdAtMs}:${filePath}`);
          const entry = {
            stableId,
            token,
            kind: "file_event",
            fileEventType,
            threadId,
            threadLabel,
            title: fileEventTitle(DEFAULT_LOCALE, fileEventType),
            summary: "",
            fileRefs: [filePath],
            diffText: String(body.diffText || ""),
            diffSource: "claude-hook",
            diffAvailable: body.diffAvailable === true || Boolean(body.diffText),
            diffAddedLines: Math.max(0, Number(body.diffAddedLines) || 0),
            diffRemovedLines: Math.max(0, Number(body.diffRemovedLines) || 0),
            createdAtMs,
            cwd: eventCwd,
            readOnly: true,
            provider: "claude",
          };
          const changed = recordTimelineEntry({ config, runtime, state, entry });
          if (changed) {
            try {
              await saveState(config.stateFile, state);
            } catch (error) {
              console.error(`[claude-file-event-save] ${error.message}`);
            }
          }
          return writeJson(res, 200, { ok: true });
        }

        if (eventType === "PostToolUse" || eventType === "PostToolUseFailure") {
          // The tool actually ran on PC — resolve any pending native approval
          // for this session/tool as accepted (so iPhone moves it to completed).
          const threadId = String(body.threadId || body.sessionId || "");
          const toolName = String(body.toolName || "");
          const fingerprint = claudeToolFingerprint(toolName, body.toolInput);
          console.log(`[claude-post-tool] threadId=${threadId} tool=${toolName} fp=${fingerprint.slice(0, 80)} pendingTotal=${runtime.nativeApprovalsByToken.size}`);
          const match = findClaudePendingApprovalForTool(runtime, threadId, toolName, fingerprint);
          console.log(`[claude-post-tool] match=${match ? match.requestKey : "none"}`);
          if (match) {
            try {
              await handleNativeApprovalDecision({ config, runtime, state, approval: match, decision: "accept" });
            } catch (error) {
              console.error(`[claude-post-tool-resolve-error] ${match.requestKey} | ${error.message}`);
            }
          }
          return writeJson(res, 200, {});
        }

        // Register Claude Code thread in persistent registry on every event.
        {
          const regThreadId = String(body.threadId || body.sessionId || "");
          const regCwd = String(body.cwd || "");
          if (regThreadId) {
            const regLabel = runtime.claudeSessionTitles.get(regThreadId)
              || (regCwd ? path.basename(regCwd) : "")
              || regThreadId.slice(0, 40);
            if (registerThread(runtime, {
              id: regThreadId,
              label: regLabel,
              tool: "claude-code",
              cwd: regCwd,
              lastSeenAtMs: Date.now(),
              active: eventType !== "Stop" && eventType !== "SessionEnd",
            })) {
              saveThreadRegistry(config.threadRegistryFile, runtime.threadRegistry).catch(() => {});
            }
          }
        }

        if (eventType !== "approval_request") {
          // Non-approval events (Notification, Stop, etc.) — acknowledge immediately
          return writeJson(res, 200, {});
        }

        // Approval request — register in shared map so UI can display it,
        // then long-poll until user decides (or 10 min timeout)
        const token = crypto.randomBytes(18).toString("hex");
        const threadId = String(body.threadId || "");
        const requestId = String(body.requestId || crypto.randomUUID());
        const requestKey = `${threadId}:${requestId}`;

        const approval = {
          token,
          requestKey,
          conversationId: threadId,
          requestId,
          ownerClientId: null,
          kind: String(body.approvalKind || "command"),
          threadLabel:
            runtime.claudeSessionTitles.get(threadId) ||
            (body.cwd ? path.basename(String(body.cwd))  : "") ||
            String(body.threadId || "").slice(0, 40),
          title: config.approvalTitle,
          messageText: String(body.messageText || ""),
          fileRefs: Array.isArray(body.fileRefs) ? body.fileRefs : [],
          previousFileRefs: [],
          diffText: String(body.diffText || ""),
          diffAvailable: Boolean(body.diffAvailable),
          diffSource: String(body.diffSource || "claude_permission_request"),
          diffAddedLines: Math.max(0, Number(body.diffAddedLines) || 0),
          diffRemovedLines: Math.max(0, Number(body.diffRemovedLines) || 0),
          cwd: body.cwd ? String(body.cwd) : "",
          workspaceRoot: body.cwd ? String(body.cwd) : "",
          createdAtMs: Number(body.createdAtMs) || Date.now(),
          resolved: false,
          resolving: false,
          resolveClaudeWaiter: null,
          claudeToolName: String(body.toolName || ""),
          claudeToolFingerprint: claudeToolFingerprint(String(body.toolName || ""), body.toolInput),
          provider: "claude",
          planText: String(body.planText || ""),
          questions: Array.isArray(body.questions) ? body.questions : [],
          notifyOnly: body.notifyOnly === true,
          readOnly: body.notifyOnly === true,
        };

        const claudeAutoPilotMatch =
          approval.kind === "command"
            ? maybeAutoApproveTrustedRead({
                state,
                commandText: body?.toolInput?.command ?? "",
                cwd: body.cwd ? String(body.cwd) : "",
                workspaceRoot: body.cwd ? String(body.cwd) : "",
              })
            : null;
        if (claudeAutoPilotMatch) {
          try {
            await recordAutoApprovedTrustedRead({
              config,
              runtime,
              state,
              approval,
              policyMatch: claudeAutoPilotMatch,
            });
            console.log(`[auto-pilot-approved] ${approval.requestKey} | ${claudeAutoPilotMatch.command}`);
            return writeJson(res, 200, {
              permissionDecision: "allow",
              permissionDecisionReason: t(config.defaultLocale, "server.message.autoPilotTrustedReadReason"),
            });
          } catch (error) {
            console.error(`[auto-pilot-error] ${approval.requestKey} | ${error.message}`);
          }
        }

        const claudeAutoPilotWriteCandidate =
          approval.kind === "file"
            ? maybeAutoApproveTrustedWriteCandidate({ runtime, state, approval })
            : null;
        if (claudeAutoPilotWriteCandidate) {
          try {
            await recordAutoApprovedTrustedWrite({
              config,
              runtime,
              state,
              approval,
              candidate: claudeAutoPilotWriteCandidate,
            });
            console.log(
              `[auto-pilot-approved-write] ${approval.requestKey} | files=${claudeAutoPilotWriteCandidate.fileRefs.length} | lines=${claudeAutoPilotWriteCandidate.totalChangedLines}`
            );
            return writeJson(res, 200, {
              permissionDecision: "allow",
              permissionDecisionReason: t(config.defaultLocale, "server.message.autoPilotTrustedWriteReason"),
            });
          } catch (error) {
            console.error(`[auto-pilot-write-error] ${approval.requestKey} | ${error.message}`);
          }
        }

        runtime.nativeApprovalsByToken.set(token, approval);
        runtime.nativeApprovalsByRequestKey.set(requestKey, approval);

        deliverWebPushItem({
          config,
          state,
          kind: "approval",
          tab: "inbox",
          subtab: "pending",
          token: approval.token,
          stableId: pendingApprovalStableId(approval),
          title: approval.title,
          body: approval.messageText,
          buildLocalizedContent: ({ locale }) => ({
            title: formatLocalizedTitle(locale, "server.title.approval", approval.threadLabel),
            body: approval.messageText,
          }),
        }).catch(() => {});

        // Notify-only path: phone gets a read-only entry + push, but the
        // hook does not block on a decision. The PostToolUse handler will
        // clean it up once the desktop user finishes the tool call.
        if (approval.notifyOnly) {
          return writeJson(res, 200, { ok: true, notifyOnly: true });
        }

        const CLAUDE_APPROVAL_WAIT_MS = 600_000; // 10 min

        const decisionPromise = new Promise((resolve) => {
          approval.resolveClaudeWaiter = resolve;
        });

        const timeoutPromise = new Promise((resolve) => {
          setTimeout(() => resolve("deny"), CLAUDE_APPROVAL_WAIT_MS);
        });

        const decision = await Promise.race([decisionPromise, timeoutPromise]);

        // Clean up if timed out (waiter was never called)
        if (!approval.resolved) {
          approval.resolved = true;
          approval.resolving = false;
          runtime.nativeApprovalsByToken.delete(token);
          runtime.nativeApprovalsByRequestKey.delete(requestKey);
        }

        // The waiter may resolve with either a string ("accept" / "reject" /
        // "deny") or an object { permissionDecision, permissionDecisionReason }.
        // The latter is used by the AskUserQuestion answer flow so the user's
        // chosen text is fed back to Claude.
        if (decision && typeof decision === "object") {
          const responseBody = {
            permissionDecision:
              decision.permissionDecision === "allow" ? "allow" : "deny",
          };
          if (typeof decision.permissionDecisionReason === "string" && decision.permissionDecisionReason) {
            responseBody.permissionDecisionReason = decision.permissionDecisionReason;
          }
          return writeJson(res, 200, responseBody);
        }

        return writeJson(res, 200, {
          permissionDecision: decision === "accept" ? "allow" : "deny",
        });
      }

      if (url.pathname === "/api/providers/moltbook/events" && req.method === "POST") {
        const hookSecret = req.headers["x-viveworker-hook-secret"] || "";
        if (!config.sessionSecret || hookSecret !== config.sessionSecret) {
          return writeJson(res, 401, { error: "unauthorized" });
        }
        let body;
        try {
          body = await parseJsonBody(req);
        } catch {
          return writeJson(res, 400, { error: "invalid-json-body" });
        }
        const sourceId = cleanText(body.sourceId || "");
        if (!sourceId) {
          return writeJson(res, 400, { error: "missing-sourceId" });
        }
        const eventType = String(body.eventType || "reply_request");
        if (eventType === "resolve") {
          const token = historyToken(`moltbook:${sourceId}`);
          runtime.moltbookItemsByToken.delete(token);
          // Flip the history item to readOnly so it moves from pending → completed.
          try {
            if (flipHistoryItemReadOnly({ runtime, state, stableId: `moltbook_reply:${sourceId}` })) {
              await saveState(config.stateFile, state);
            }
          } catch (error) {
            console.error(`[moltbook-reply-resolve] ${error.message}`);
          }
          return writeJson(res, 200, { ok: true });
        }
        const token = historyToken(`moltbook:${sourceId}`);
        const item = {
          token,
          sourceId,
          threadId: cleanText(body.threadId || "moltbook"),
          threadLabel: cleanText(body.threadLabel || "Moltbook"),
          title: cleanText(body.title || "Moltbook reply"),
          summary: cleanText(body.summary || ""),
          contextText: cleanText(body.contextText || ""),
          draftReply: cleanText(body.draftReply || ""),
          callbackUrl: cleanText(body.callbackUrl || ""),
          postUrl: cleanText(body.postUrl || ""),
          postTitle: cleanText(body.postTitle || ""),
          commentAuthor: cleanText(body.commentAuthor || ""),
          createdAtMs: Number(body.createdAtMs) || Date.now(),
          resolved: false,
        };
        runtime.moltbookItemsByToken.set(token, item);
        try {
          const historyEntry = {
            stableId: `moltbook_reply:${sourceId}`,
            token,
            kind: "moltbook_reply",
            threadId: item.threadId,
            threadLabel: item.threadLabel,
            title: item.title,
            summary: item.summary,
            messageText: item.contextText,
            createdAtMs: item.createdAtMs,
            readOnly: false,
            provider: "moltbook",
          };
          recordTimelineEntry({ config, runtime, state, entry: historyEntry });
          recordHistoryItem({ config, runtime, state, item: historyEntry });
          await saveState(config.stateFile, state);
        } catch (error) {
          console.error(`[moltbook-timeline-save] ${error.message}`);
        }
        try {
          await deliverWebPushItem({
            config,
            state,
            kind: "moltbook_reply",
            tab: "inbox",
            subtab: "pending",
            token,
            stableId: `moltbook_reply:${item.sourceId}`,
            title: item.title,
            body: item.summary,
          });
        } catch (error) {
          console.error(`[moltbook-push-error] ${error.message}`);
        }
        return writeJson(res, 200, { ok: true, token });
      }

      const apiMoltbookReplyMatch = url.pathname.match(/^\/api\/items\/moltbook\/([^/]+)\/reply$/u);
      if (apiMoltbookReplyMatch && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) {
          return;
        }
        const token = decodeURIComponent(apiMoltbookReplyMatch[1]);
        const item = runtime.moltbookItemsByToken.get(token);
        if (!item) {
          return writeJson(res, 404, { error: "item-not-found" });
        }
        let body;
        try {
          body = await parseJsonBody(req);
        } catch {
          return writeJson(res, 400, { error: "invalid-json-body" });
        }
        const action = String(body.action || "send");
        const text = cleanText(body.text || "");
        if (action === "send" && !text) {
          return writeJson(res, 400, { error: "empty-reply" });
        }
        if (item.callbackUrl) {
          try {
            const callbackRes = await fetch(item.callbackUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-viveworker-hook-secret": config.sessionSecret || "",
              },
              body: JSON.stringify({
                sourceId: item.sourceId,
                action,
                text,
              }),
            });
            if (!callbackRes.ok) {
              return writeJson(res, 502, { error: `callback-failed-${callbackRes.status}` });
            }
          } catch (error) {
            return writeJson(res, 502, { error: `callback-error: ${error.message}` });
          }
        }
        item.resolved = true;
        runtime.moltbookItemsByToken.delete(token);
        try {
          if (flipHistoryItemReadOnly({ runtime, state, stableId: `moltbook_reply:${item.sourceId}` })) {
            await saveState(config.stateFile, state);
          }
        } catch (error) {
          console.error(`[moltbook-reply-phone] ${error.message}`);
        }
        return writeJson(res, 200, { ok: true, action });
      }

      // ---------------------------------------------------------------
      // Moltbook scout draft channel
      //
      // The CLI submits a draft via POST /api/providers/moltbook/draft
      // and exits immediately (fire-and-forget).  The draft is persisted
      // to ~/.viveworker/moltbook-drafts/ and survives bridge restarts.
      // When the phone approves via POST /api/items/moltbook-draft/:token/decision,
      // the bridge posts to the Moltbook API and solves the verification
      // puzzle inline.
      // ---------------------------------------------------------------

      if (url.pathname === "/api/providers/moltbook/draft" && req.method === "POST") {
        const hookSecret = req.headers["x-viveworker-hook-secret"] || "";
        if (!config.sessionSecret || hookSecret !== config.sessionSecret) {
          return writeJson(res, 401, { error: "unauthorized" });
        }
        let body;
        try {
          body = await parseJsonBody(req);
        } catch {
          return writeJson(res, 400, { error: "invalid-json-body" });
        }
        const sourceId = cleanText(body.sourceId || "");
        const postId = cleanText(body.postId || "");
        const draftText = cleanText(body.draftText || "");
        const draftType = cleanText(body.draftType || "reply");
        const submoltName = cleanText(body.submoltName || "");
        if (!sourceId || !draftText) {
          return writeJson(res, 400, { error: "missing-sourceId-or-draftText" });
        }
        if (draftType === "reply" && !postId) {
          return writeJson(res, 400, { error: "missing-postId-for-reply" });
        }
        const token = historyToken(`moltbook_draft:${sourceId}`);
        const postTitle = cleanText(body.postTitle || "");
        const postUrl = cleanText(body.postUrl || `https://www.moltbook.com/post/${postId}`);
        const contextSummary = cleanText(body.contextSummary || "");
        const postAuthor = cleanText(body.postAuthor || "");
        const postBody = typeof body.postBody === "string" ? body.postBody : "";
        const intent = typeof body.intent === "string" ? body.intent : "";
        const slot = cleanText(body.slot || "");
        const ttlMs = Math.max(60000, Math.min(Number(body.ttlMs) || 86400000, 86400000));
        const draft = {
          token,
          sourceId,
          postId,
          postTitle,
          postAuthor,
          postBody,
          postUrl,
          parentCommentId: cleanText(body.parentCommentId || ""),
          draftText,
          draftType,
          submoltName,
          intent,
          slot,
          contextSummary,
          ttlMs,
          createdAtMs: Date.now(),
          decisionWaiters: [],
          decision: null,
        };
        runtime.moltbookDraftsByToken.set(token, draft);
        await writeDraft(draft).catch((e) => console.error(`[moltbook-draft-persist] ${e.message}`));
        try {
          const draftEntry = {
            stableId: `moltbook_draft:${sourceId}`,
            token,
            kind: "moltbook_draft",
            threadId: "moltbook",
            threadLabel: postTitle || "Moltbook",
            title: draftType === "original_post"
              ? (postTitle || "Moltbook new post")
              : (postTitle ? `draft → ${postTitle}` : "Moltbook draft"),
            summary: contextSummary || String(draftText).slice(0, 160),
            messageText: contextSummary || draftText,
            draftText,
            draftType,
            submoltName,
            intent,
            slot,
            postId,
            postUrl,
            postTitle,
            postAuthor,
            postBody,
            createdAtMs: draft.createdAtMs,
            readOnly: false,
            provider: "moltbook",
          };
          recordTimelineEntry({ config, runtime, state, entry: draftEntry });
          recordHistoryItem({ config, runtime, state, item: draftEntry });
          await saveState(config.stateFile, state);
        } catch (error) {
          console.error(`[moltbook-draft-timeline-save] ${error.message}`);
        }
        try {
          const pushTitle = (() => {
            if (draftType !== "original_post") {
              return postTitle ? `draft → ${postTitle}` : "Moltbook draft";
            }
            const greetings = {
              morning: { en: "Good morning! Share yesterday's highlights?", ja: "おはようございます！昨日の成果をシェアしませんか？" },
              noon: { en: "Nice progress! Ready to share your morning work?", ja: "午前中お疲れ様でした！進捗をシェアしませんか？" },
              evening: { en: "Great work today! Let's share what you built.", ja: "今日もお疲れ様でした！成果をシェアしませんか？" },
            };
            const locale = config.locale || "en";
            const lang = locale.startsWith("ja") ? "ja" : "en";
            const g = greetings[slot];
            return g ? g[lang] : (postTitle || "Moltbook new post");
          })();
          await deliverWebPushItem({
            config,
            state,
            kind: "moltbook_draft",
            tab: "inbox",
            subtab: "pending",
            token,
            stableId: `moltbook_draft:${sourceId}`,
            title: pushTitle,
            body: draftType === "original_post" ? (postTitle || String(draftText).slice(0, 160)) : String(draftText).slice(0, 160),
          });
        } catch (error) {
          console.error(`[moltbook-draft-push-error] ${error.message}`);
        }
        return writeJson(res, 200, { ok: true, token });
      }

      const apiMoltbookDraftDecisionGet = url.pathname.match(
        /^\/api\/providers\/moltbook\/draft\/([^/]+)\/decision$/u
      );
      if (apiMoltbookDraftDecisionGet && req.method === "GET") {
        const hookSecret = req.headers["x-viveworker-hook-secret"] || "";
        if (!config.sessionSecret || hookSecret !== config.sessionSecret) {
          return writeJson(res, 401, { error: "unauthorized" });
        }
        const token = decodeURIComponent(apiMoltbookDraftDecisionGet[1]);
        const draft = runtime.moltbookDraftsByToken.get(token);
        if (!draft) return writeJson(res, 404, { error: "draft-not-found" });
        if (draft.decision) {
          return writeJson(res, 200, { status: "decided", ...draft.decision });
        }
        const waitParam = Number(url.searchParams.get("wait")) || 25;
        const waitMs = Math.min(Math.max(waitParam, 1), 60) * 1000;
        const decided = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            const idx = draft.decisionWaiters.indexOf(resolve);
            if (idx !== -1) draft.decisionWaiters.splice(idx, 1);
            resolve(null);
          }, waitMs);
          draft.decisionWaiters.push((d) => {
            clearTimeout(timer);
            resolve(d);
          });
        });
        if (decided) return writeJson(res, 200, { status: "decided", ...decided });
        return writeJson(res, 200, { status: "pending" });
      }

      const apiMoltbookDraftDecide = url.pathname.match(
        /^\/api\/items\/moltbook-draft\/([^/]+)\/decision$/u
      );
      if (apiMoltbookDraftDecide && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) return;
        const token = decodeURIComponent(apiMoltbookDraftDecide[1]);
        const draft = runtime.moltbookDraftsByToken.get(token);
        if (!draft) return writeJson(res, 404, { error: "draft-not-found" });
        let body;
        try {
          body = await parseJsonBody(req);
        } catch {
          return writeJson(res, 400, { error: "invalid-json-body" });
        }
        const action = String(body.action || "") === "approve" ? "approve" : "deny";
        const editedText = cleanText(body.editedText || "");
        const editedTitle = cleanText(body.editedTitle || "");
        const decision = {
          action,
          text: action === "approve" ? editedText || draft.draftText : "",
          title: action === "approve" ? editedTitle || draft.postTitle : "",
          decidedAtMs: Date.now(),
        };
        draft.decision = decision;
        for (const waiter of draft.decisionWaiters.splice(0)) {
          try {
            waiter(decision);
          } catch {
            // ignore
          }
        }
        // Persist decision to disk.
        await writeDraft(draft).catch((e) => console.error(`[moltbook-draft-persist-decision] ${e.message}`));

        // Flip the history entry to readOnly so it moves from pending → completed.
        try {
          if (flipHistoryItemReadOnly({ runtime, state, stableId: `moltbook_draft:${draft.sourceId}` })) {
            await saveState(config.stateFile, state);
          }
        } catch (error) {
          console.error(`[moltbook-draft-decision-flip] ${error.message}`);
        }

        if (action === "approve") {
          // Execute posting asynchronously — fire-and-forget from the HTTP handler.
          (async () => {
            try {
              await executeMoltbookDraftPost(draft, config, runtime, state);
            } catch (postError) {
              console.error(`[moltbook-draft-post-error] ${postError.message}`);
              try {
                await deliverWebPushItem({
                  config, state, kind: "moltbook_draft", token: draft.token,
                  tab: "inbox",
                  subtab: "completed",
                  stableId: `moltbook_draft_failed:${draft.sourceId}`,
                  title: "Draft post failed",
                  body: String(postError.message || "").slice(0, 160),
                });
              } catch { /* ignore push error */ }
            }
            await deleteDraft(token).catch(() => {});
            setTimeout(() => runtime.moltbookDraftsByToken.delete(token), 120_000).unref?.();
          })();
        } else {
          // Deny — clean up.
          await deleteDraft(token).catch(() => {});
          setTimeout(() => runtime.moltbookDraftsByToken.delete(token), 120_000).unref?.();
        }
        return writeJson(res, 200, { ok: true, action });
      }

      if (url.pathname === "/api/inbox" && req.method === "GET") {
        const session = requireApiSession(req, res, config, state);
        if (!session) {
          return;
        }
        const locale = resolveDeviceLocaleInfo(config, state, session.deviceId).locale;
        return writeJson(res, 200, buildInboxFastResponse(runtime, state, config, locale));
      }

      if (url.pathname === "/api/inbox/diff" && req.method === "GET") {
        const session = requireApiSession(req, res, config, state);
        if (!session) {
          return;
        }
        const locale = resolveDeviceLocaleInfo(config, state, session.deviceId).locale;
        return writeJson(res, 200, await buildInboxDiffResponse(runtime, state, config, locale));
      }

      if (url.pathname === "/api/timeline" && req.method === "GET") {
        const session = requireApiSession(req, res, config, state);
        if (!session) {
          return;
        }
        const locale = resolveDeviceLocaleInfo(config, state, session.deviceId).locale;
        return writeJson(res, 200, buildTimelineResponse(runtime, state, config, locale));
      }

      const apiTimelineImageMatch = url.pathname.match(/^\/api\/timeline\/([^/]+)\/images\/(\d+)$/u);
      if (apiTimelineImageMatch && req.method === "GET") {
        const session = requireApiSession(req, res, config, state);
        if (!session) {
          return;
        }
        const token = decodeURIComponent(apiTimelineImageMatch[1]);
        const index = Number(apiTimelineImageMatch[2]) || 0;
        const filePath = resolveTimelineEntryImagePath(runtime, token, index);
        if (!filePath) {
          res.statusCode = 404;
          res.end("not-found");
          return;
        }
        try {
          const body = await fs.readFile(filePath);
          res.statusCode = 200;
          res.setHeader("Content-Type", contentTypeForFile(filePath));
          res.setHeader("Cache-Control", "private, max-age=300");
          res.end(body);
          return;
        } catch {
          res.statusCode = 404;
          res.end("not-found");
          return;
        }
      }

      const apiItemMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/([^/]+)$/u);
      if (apiItemMatch && req.method === "GET") {
        const session = requireApiSession(req, res, config, state);
        if (!session) {
          return;
        }
        const kind = decodeURIComponent(apiItemMatch[1]);
        const token = decodeURIComponent(apiItemMatch[2]);
        const locale = resolveDeviceLocaleInfo(config, state, session.deviceId).locale;
        const detail = await buildApiItemDetail({ config, runtime, state, kind, token, locale });
        if (!detail) {
          return writeJson(res, 404, { error: "item-not-found" });
        }
        return writeJson(res, 200, detail);
      }

      const apiCompletionReplyMatch = url.pathname.match(/^\/api\/items\/(completion|assistant_final)\/([^/]+)\/reply$/u);
      if (apiCompletionReplyMatch && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) {
          return;
        }

        const replyKind = apiCompletionReplyMatch[1];
        const token = decodeURIComponent(apiCompletionReplyMatch[2]);
        // Try history items first, fall back to timeline entries for assistant_final
        // (history items may be evicted by maxHistoryItems limit)
        const completionItem = historyItemByToken(runtime, replyKind, token)
          || (replyKind === "assistant_final" ? timelineEntryByToken(runtime, token, replyKind) : null);
        if (!completionItem) {
          return writeJson(res, 404, { error: "item-not-found" });
        }

        try {
          const contentType = String(req.headers["content-type"] || "");
          const payload = contentType.includes("multipart/form-data")
            ? await stageCompletionReplyImages(config, req)
            : await parseJsonBody(req);
          await handleCompletionReply({
            config,
            runtime,
            state,
            completionItem,
            text: payload?.text ?? "",
            planMode: payload?.planMode === true,
            force: payload?.force === true,
            localImagePaths: Array.isArray(payload?.localImagePaths) ? payload.localImagePaths : [],
          });
          return writeJson(res, 200, {
            ok: true,
            planMode: payload?.planMode === true,
            imageCount: Array.isArray(payload?.localImagePaths) ? payload.localImagePaths.length : 0,
          });
        } catch (error) {
          if (error.message === "completion-reply-empty") {
            return writeJson(res, 400, { error: error.message });
          }
          if (
            error.message === "completion-reply-image-limit" ||
            error.message === "completion-reply-image-invalid-type" ||
            error.message === "completion-reply-image-too-large" ||
            error.message === "completion-reply-image-invalid-upload"
          ) {
            return writeJson(res, 400, { error: error.message });
          }
          if (error.message === "completion-reply-unavailable") {
            return writeJson(res, 409, { error: error.message });
          }
          if (error.message === "completion-reply-thread-advanced") {
            return writeJson(res, 409, {
              error: error.message,
              warning: isPlainObject(error.warning) ? error.warning : null,
            });
          }
          if (error.message === "codex-ipc-not-connected") {
            return writeJson(res, 503, { error: error.message });
          }
          return writeJson(res, 500, { error: error.message });
        }
      }

      const apiApprovalDecisionMatch = url.pathname.match(/^\/api\/items\/approval\/([^/]+)\/(accept|decline)$/u);
      if (apiApprovalDecisionMatch && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) {
          return;
        }

        const token = decodeURIComponent(apiApprovalDecisionMatch[1]);
        const decision = apiApprovalDecisionMatch[2];
        const approval = runtime.nativeApprovalsByToken.get(token);
        if (!approval) {
          return writeJson(res, 404, { error: "approval-not-found" });
        }
        if (approval.resolved || approval.resolving) {
          return writeJson(res, 409, { error: "approval-already-handled" });
        }

        approval.resolving = true;
        try {
          await handleNativeApprovalDecision({ config, runtime, state, approval, decision });
          if (approval.provider === "claude") {
            activateClaudeDesktopIfMac(req);
          }
          return writeJson(res, 200, { ok: true, decision });
        } catch (error) {
          approval.resolving = false;
          return writeJson(res, 500, { error: error.message });
        }
      }

      const apiQuestionAnswerMatch = url.pathname.match(/^\/api\/items\/question\/([^/]+)\/answer$/u);
      if (apiQuestionAnswerMatch && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) {
          return;
        }

        const token = decodeURIComponent(apiQuestionAnswerMatch[1]);
        const approval = runtime.nativeApprovalsByToken.get(token);
        if (!approval) {
          return writeJson(res, 404, { error: "question-not-found" });
        }
        if (approval.kind !== "question") {
          return writeJson(res, 409, { error: "not-a-question" });
        }
        if (approval.resolved || approval.resolving) {
          return writeJson(res, 409, { error: "question-already-handled" });
        }

        let payload;
        try {
          payload = await parseJsonBody(req);
        } catch {
          return writeJson(res, 400, { error: "invalid-json-body" });
        }

        const answers = Array.isArray(payload?.answers) ? payload.answers : [];
        const reasonText = formatClaudeQuestionAnswers(approval.questions, answers);
        if (!reasonText) {
          return writeJson(res, 400, { error: "no-answers" });
        }

        approval.resolving = true;
        try {
          if (approval.resolveClaudeWaiter) {
            approval.resolveClaudeWaiter({
              permissionDecision: "deny",
              permissionDecisionReason: reasonText,
            });
          }
          approval.resolved = true;
          approval.resolving = false;
          runtime.nativeApprovalsByToken.delete(approval.token);
          runtime.nativeApprovalsByRequestKey.delete(approval.requestKey);

          const stateChanged = recordActionHistoryItem({
            config,
            runtime,
            state,
            kind: "approval",
            stableId: `approval:${approval.requestKey}:${Date.now()}`,
            token: approval.token,
            title: approval.title,
            threadLabel: approval.threadLabel || "",
            messageText: reasonText,
            summary: t(config.defaultLocale, "server.message.questionAnswered", {
              provider: providerDisplayName(config.defaultLocale, approval.provider),
            }),
            fileRefs: [],
            diffText: "",
            diffSource: "",
            diffAvailable: false,
            diffAddedLines: 0,
            diffRemovedLines: 0,
            outcome: "answered",
            provider: approval.provider || "claude",
          });
          if (stateChanged) {
            await saveState(config.stateFile, state);
          }
          console.log(`[claude-question-answer] ${approval.requestKey}`);
          activateClaudeDesktopIfMac(req);
          return writeJson(res, 200, { ok: true });
        } catch (error) {
          approval.resolving = false;
          return writeJson(res, 500, { error: error.message });
        }
      }

      const apiPlanDecisionMatch = url.pathname.match(/^\/api\/items\/plan\/([^/]+)\/(implement|decline)$/u);
      if (apiPlanDecisionMatch && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) {
          return;
        }

        const token = decodeURIComponent(apiPlanDecisionMatch[1]);
        const decision = apiPlanDecisionMatch[2];
        const planRequest = runtime.planRequestsByToken.get(token);
        if (!planRequest) {
          return writeJson(res, 404, { error: "plan-request-not-found" });
        }
        if (planRequest.resolved || planRequest.resolving) {
          return writeJson(res, 409, { error: "plan-request-already-handled" });
        }

        planRequest.resolving = true;
        try {
          await handlePlanDecision({ config, runtime, state, planRequest, decision });
          return writeJson(res, 200, { ok: true, decision });
        } catch (error) {
          planRequest.resolving = false;
          console.error(`[plan-decision-error] ${planRequest.requestKey} | ${error.message}`);
          return writeJson(res, 500, { error: error.message });
        }
      }

      const apiChoiceDraftMatch = url.pathname.match(/^\/api\/items\/choice\/([^/]+)\/draft$/u);
      if (apiChoiceDraftMatch && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) {
          return;
        }

        const token = decodeURIComponent(apiChoiceDraftMatch[1]);
        const userInputRequest = findLatestPersistedUserInputRequest({ config, runtime, state, token });
        if (!userInputRequest) {
          return writeJson(res, 404, { error: "choice-input-not-found" });
        }
        if (!userInputRequest.supported) {
          return writeJson(res, 409, { error: "choice-input-read-only" });
        }

        const payload = await parseJsonBody(req);
        mergeChoiceDraftAnswers(userInputRequest, payload?.answers ?? {});
        const totalPages = Math.max(1, Math.ceil(userInputRequest.questions.length / Math.max(1, config.choicePageSize)));
        userInputRequest.draftPage = Math.min(totalPages, Math.max(1, Number(payload?.page) || userInputRequest.draftPage || 1));
        userInputRequest.lastSeenAtMs = Date.now();
        const stateChanged = storePendingUserInputRequest(state, userInputRequest);
        if (stateChanged) {
          await saveState(config.stateFile, state);
        }
        return writeJson(res, 200, {
          ok: true,
          page: userInputRequest.draftPage,
        });
      }

      const apiChoiceSubmitMatch = url.pathname.match(/^\/api\/items\/choice\/([^/]+)\/submit$/u);
      if (apiChoiceSubmitMatch && req.method === "POST") {
        const session = requireMutatingApiSession(req, res, config, state);
        if (!session) {
          return;
        }

        const token = decodeURIComponent(apiChoiceSubmitMatch[1]);
        const userInputRequest = findLatestPersistedUserInputRequest({ config, runtime, state, token });
        if (!userInputRequest) {
          return writeJson(res, 404, { error: "choice-input-not-found" });
        }
        if (userInputRequest.resolved || userInputRequest.resolving) {
          return writeJson(res, 409, { error: "choice-input-already-handled" });
        }
        if (!userInputRequest.supported) {
          return writeJson(res, 409, { error: "choice-input-read-only" });
        }

        userInputRequest.resolving = true;
        try {
          const payload = await parseJsonBody(req);
          mergeChoiceDraftAnswers(userInputRequest, payload?.answers ?? {});
          await submitGenericUserInputDecision({
            config,
            runtime,
            state,
            userInputRequest,
            submittedAnswers: userInputRequest.draftAnswers,
          });
          return writeJson(res, 200, { ok: true });
        } catch (error) {
          userInputRequest.resolving = false;
          console.error(`[user-input-decision-error] ${userInputRequest.requestKey} | ${error.message}`);
          return writeJson(res, 500, { error: error.message });
        }
      }

      if (url.pathname === "/test/user-inputs") {
        if (!isLoopbackRequest(req)) {
          return writeJson(res, 403, { error: "Loopback only" });
        }

        if (req.method !== "POST") {
          return writeJson(res, 405, { error: "Method not allowed" });
        }

        const payload = await parseJsonBody(req);
        const userInputRequest = createTestGenericUserInputRequest({
          config,
          title: cleanText(payload?.title ?? "") || "Bridge test",
          questions: payload?.questions ?? [],
        });
        if (!userInputRequest.questions.length) {
          return writeJson(res, 400, { error: "questions required" });
        }

        registerGenericUserInputRequest(runtime, userInputRequest);
        const stateChanged = storePendingUserInputRequest(state, userInputRequest);
        if (stateChanged) {
          await saveState(config.stateFile, state);
        }

        await publishNtfy(config, {
          kind: userInputRequest.supported ? "user_input_test" : "user_input_test_read_only",
          title: userInputRequest.title,
          message: formatNotificationBody(
            userInputRequest.notificationText || userInputRequest.messageText,
            config.completionDetailThresholdChars
          ),
          priority: config.planPriority,
          tags: config.planTags,
          clickUrl: userInputRequest.reviewUrl,
          actions: userInputRequest.supported
            ? buildUserInputActions(userInputRequest.reviewUrl)
            : buildUserInputFallbackActions(userInputRequest.reviewUrl),
        });
        console.log(`[user-input-test] ${userInputRequest.requestKey} | ${userInputRequest.title}`);
        return writeJson(res, 200, {
          ok: true,
          title: userInputRequest.title,
          token: userInputRequest.token,
          supported: userInputRequest.supported,
        });
      }

      const completionMatch = url.pathname.match(/^\/completion-details\/([a-f0-9]+)$/u);
      if (completionMatch) {
        const detail = runtime.completionDetailsByToken.get(completionMatch[1]);
        if (!detail) {
          return writeCompletionMissing(res, req, 404, config.defaultLocale);
        }
        return writeHtml(
          res,
          200,
          renderMessagePage({
            eyebrow: t(config.defaultLocale, "server.title.complete"),
            title: detail.title,
            messageText: detail.messageText,
            locale: config.defaultLocale,
          })
        );
      }

      const planMatch = url.pathname.match(/^\/plan-details\/([a-f0-9]+)$/u);
      if (planMatch) {
        const detail = runtime.planDetailsByToken.get(planMatch[1]);
        if (!detail) {
          return writeCompletionMissing(res, req, 404, config.defaultLocale);
        }
        return writeHtml(
          res,
          200,
          renderMessagePage({
            eyebrow: t(config.defaultLocale, "server.title.planReady"),
            title: detail.title,
            messageText: detail.messageText,
            locale: config.defaultLocale,
          })
        );
      }

      const userInputMatch = url.pathname.match(/^\/user-inputs\/([a-f0-9]+)$/u);
      if (userInputMatch) {
        const userInputRequest = findLatestPersistedUserInputRequest({
          config,
          runtime,
          state,
          token: userInputMatch[1],
        });
        if (!userInputRequest) {
          return writeUserInputMissing(res, req, 404, config.defaultLocale);
        }
        if (isGenericUserInputRequestExpired(userInputRequest)) {
          expireGenericUserInputRequest(runtime, userInputRequest.requestKey);
          const stateChanged = deletePendingUserInputRequest(state, userInputRequest.requestKey);
          if (stateChanged) {
            await saveState(config.stateFile, state);
          }
          return writeUserInputMissing(res, req, 404, config.defaultLocale);
        }

        if (req.method === "GET") {
          if (userInputRequest.resolved || userInputRequest.resolving) {
            return writeApprovalHandled(res, req, userInputRequest.title, 409, config.defaultLocale);
          }

          if (!userInputRequest.supported) {
            return writeHtml(
              res,
              200,
              renderMessagePage({
                eyebrow: t(config.defaultLocale, "server.title.choiceReadOnly"),
                title: userInputRequest.title,
                messageText: `${userInputRequest.messageText}\n\n${t(config.defaultLocale, "choice.macOnly")}`,
                locale: config.defaultLocale,
              })
            );
          }

          return writeHtml(
            res,
            200,
            renderUserInputPage({
              eyebrow: t(config.defaultLocale, "server.title.choice"),
              title: userInputRequest.title,
              token: userInputRequest.token,
              questions: userInputRequest.questions,
              locale: config.defaultLocale,
            })
          );
        }

        if (req.method !== "POST") {
          return writeJson(res, 405, { error: "Method not allowed" });
        }

        if (!requireTrustedMutationOrigin(req, res, config)) {
          return;
        }

        if (userInputRequest.resolved || userInputRequest.resolving) {
          return writeApprovalHandled(res, req, userInputRequest.title, 409, config.defaultLocale);
        }

        if (!userInputRequest.supported) {
          return writeHtml(
            res,
            409,
            renderStatusPage({
              title: userInputRequest.title,
              body: t(config.defaultLocale, "error.choiceInputReadOnly"),
              tone: "neutral",
            })
          );
        }

        userInputRequest.resolving = true;
        try {
          const formValues = await parseFormBody(req);
          mergeChoiceDraftAnswers(userInputRequest, formValues);
          await submitGenericUserInputDecision({
            config,
            runtime,
            state,
            userInputRequest,
            submittedAnswers: userInputRequest.draftAnswers,
          });
          console.log(`[user-input-decision] ${userInputRequest.requestKey} | submit`);

          if (requestWantsHtml(req)) {
            return writeHtml(
              res,
              200,
              renderStatusPage({
                title: userInputRequest.title,
                body: userInputRequest.testRequest
                  ? `${t(config.defaultLocale, "server.message.choiceSubmittedTest")}\n\n${formatSubmittedTestAnswers(userInputRequest, userInputRequest.draftAnswers)}`
                  : t(config.defaultLocale, "server.message.choiceSubmitted", { provider: providerDisplayName(config.defaultLocale, "codex") }),
                tone: "ok",
              })
            );
          }

          return writeJson(res, 200, {
            ok: true,
            title: userInputRequest.title,
          });
        } catch (error) {
          userInputRequest.resolving = false;
          console.error(`[user-input-decision-error] ${userInputRequest.requestKey} | ${error.message}`);
          if (requestWantsHtml(req)) {
            return writeHtml(
              res,
              500,
              renderStatusPage({
                title: userInputRequest.title,
                body: error.message,
                tone: "warn",
              })
            );
          }
          return writeJson(res, 500, { error: error.message });
        }
      }

      const planRequestMatch = url.pathname.match(/^\/plan-requests\/([a-f0-9]+)$/u);
      if (planRequestMatch) {
        const planRequest = runtime.planRequestsByToken.get(planRequestMatch[1]);
        if (!planRequest) {
          return writeApprovalMissing(res, req, 404, config.defaultLocale);
        }
        if (isPlanRequestExpired(planRequest)) {
          expirePlanImplementationRequest(runtime, planRequest.requestKey);
          const stateChanged =
            deletePendingPlanRequest(state, planRequest.turnKey) ||
            clearPlanTurnActive(state, planRequest.turnKey);
          if (stateChanged) {
            await saveState(config.stateFile, state);
          }
          return writeApprovalMissing(res, req, 404, config.defaultLocale);
        }
        if (planRequest.resolved || planRequest.resolving) {
          return writeApprovalHandled(res, req, planRequest.title, 409, config.defaultLocale);
        }
        return writeHtml(
          res,
          200,
          renderApprovalPage({
            eyebrow: t(config.defaultLocale, "server.title.plan"),
            title: planRequest.title,
            messageText: planRequest.messageText,
            token: planRequest.token,
            basePath: "plan-requests",
            actions: [
              { label: t(config.defaultLocale, "server.action.implement"), decision: "implement", tone: "approve" },
              { label: t(config.defaultLocale, "server.action.reject"), decision: "decline", tone: "reject" },
            ],
            locale: config.defaultLocale,
          })
        );
      }

      const planDecisionMatch = url.pathname.match(/^\/plan-requests\/([a-f0-9]+)\/(implement|decline)$/u);
      if (planDecisionMatch) {
        const token = planDecisionMatch[1];
        const decision = planDecisionMatch[2];
        const planRequest = runtime.planRequestsByToken.get(token);
        if (!planRequest) {
          return writeApprovalMissing(res, req, 404, config.defaultLocale);
        }
        if (isPlanRequestExpired(planRequest)) {
          expirePlanImplementationRequest(runtime, planRequest.requestKey);
          const stateChanged =
            deletePendingPlanRequest(state, planRequest.turnKey) ||
            clearPlanTurnActive(state, planRequest.turnKey);
          if (stateChanged) {
            await saveState(config.stateFile, state);
          }
          return writeApprovalMissing(res, req, 404, config.defaultLocale);
        }

        if (req.method === "GET") {
          if (planRequest.resolved || planRequest.resolving) {
            return writeApprovalHandled(res, req, planRequest.title, 409, config.defaultLocale);
          }
          return writeHtml(
            res,
            200,
            renderDecisionPage({
              eyebrow: t(config.defaultLocale, "server.title.plan"),
              title: planRequest.title,
              messageText: planRequest.messageText,
              token,
              decision,
              basePath: "plan-requests",
              confirmBody:
                decision === "implement"
                  ? t(config.defaultLocale, "server.confirm.planImplement")
                  : t(config.defaultLocale, "server.message.planDismissed"),
              locale: config.defaultLocale,
            })
          );
        }

        if (!requireTrustedMutationOrigin(req, res, config)) {
          return;
        }

        if (planRequest.resolved || planRequest.resolving) {
          return writeApprovalHandled(res, req, planRequest.title, 409, config.defaultLocale);
        }

        planRequest.resolving = true;
        try {
          await handlePlanDecision({ config, runtime, state, planRequest, decision });

          if (requestWantsHtml(req)) {
            return writeHtml(
              res,
              200,
              renderStatusPage({
                title: planRequest.title,
                body: planDecisionMessage(decision, config.defaultLocale),
                tone: decision === "implement" ? "ok" : "neutral",
              })
            );
          }

          return writeJson(res, 200, {
            ok: true,
            decision,
            title: planRequest.title,
          });
        } catch (error) {
          planRequest.resolving = false;
          console.error(`[plan-decision-error] ${planRequest.requestKey} | ${error.message}`);
          if (requestWantsHtml(req)) {
            return writeHtml(
              res,
              500,
              renderStatusPage({
                title: planRequest.title,
                body: error.message,
                tone: "warn",
              })
            );
          }
          return writeJson(res, 500, { error: error.message });
        }
      }

      const pageMatch = url.pathname.match(/^\/native-approvals\/([a-f0-9]+)$/u);
      if (pageMatch) {
        const approval = runtime.nativeApprovalsByToken.get(pageMatch[1]);
        if (!approval) {
          return writeApprovalMissing(res, req, 404, config.defaultLocale);
        }
        return writeHtml(
          res,
          200,
          renderApprovalPage({
            eyebrow: t(config.defaultLocale, "server.title.approval"),
            title: approval.title,
            messageText: approval.messageText,
            token: approval.token,
            basePath: "native-approvals",
            actions: [
              { label: t(config.defaultLocale, "server.action.approve"), decision: "accept", tone: "approve" },
              { label: t(config.defaultLocale, "server.action.reject"), decision: "decline", tone: "reject" },
            ],
            locale: config.defaultLocale,
          })
        );
      }

      const match = url.pathname.match(/^\/native-approvals\/([a-f0-9]+)\/(accept|decline)$/u);
      if (!match) {
        if (requestWantsHtml(req)) {
          return writeHtml(
            res,
            404,
            renderStatusPage({
              title: t(config.defaultLocale, "server.page.notFoundTitle"),
              body: t(config.defaultLocale, "server.page.notFoundBody"),
              tone: "neutral",
            })
          );
        }
        return writeJson(res, 404, { error: "item-not-found" });
      }

      const token = match[1];
      const decision = match[2];
      const approval = runtime.nativeApprovalsByToken.get(token);
      if (!approval) {
        return writeApprovalMissing(res, req, 404, config.defaultLocale);
      }

      if (req.method === "GET") {
        return writeHtml(
          res,
          200,
          renderDecisionPage({
            eyebrow: t(config.defaultLocale, "server.title.approval"),
            title: approval.title,
            messageText: approval.messageText,
            token,
            decision,
            basePath: "native-approvals",
            locale: config.defaultLocale,
          })
        );
      }

      if (!requireTrustedMutationOrigin(req, res, config)) {
        return;
      }

      if (approval.resolved || approval.resolving) {
        return writeApprovalHandled(res, req, approval.title, 409, config.defaultLocale);
      }

      approval.resolving = true;
      try {
        await handleNativeApprovalDecision({ config, runtime, state, approval, decision });

        if (requestWantsHtml(req)) {
          return writeHtml(
            res,
            200,
            renderStatusPage({
              title: approval.title,
              body: approvalDecisionMessage(decision, config.defaultLocale),
              tone: decisionTone(decision),
            })
          );
        }

        return writeJson(res, 200, {
          ok: true,
          decision,
          title: approval.title,
        });
      } catch (error) {
        approval.resolving = false;
        if (requestWantsHtml(req)) {
          return writeHtml(
            res,
            500,
            renderStatusPage({
              title: approval.title,
              body: error.message,
              tone: "warn",
            })
          );
        }
        return writeJson(res, 500, { error: error.message });
      }
    } catch (error) {
      if (requestWantsHtml(req)) {
        return writeHtml(
          res,
          500,
          renderStatusPage({
            title: t(config.defaultLocale, "server.title.approval"),
            body: error.message,
            tone: "warn",
          })
        );
      }
      return writeJson(res, 500, { error: error.message });
    }
  };

  if (config.webPushEnabled) {
    return createHttpsServer({
      cert: readFileSync(config.tlsCertFile, "utf8"),
      key: readFileSync(config.tlsKeyFile, "utf8"),
    }, requestHandler);
  }

  return createHttpServer(requestHandler);
}

function requestWantsHtml(req) {
  if (req.method === "GET") {
    return true;
  }
  const accept = String(req.headers.accept || "");
  return accept.includes("text/html");
}

async function parseFormBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (body.length > 1024 * 1024) {
        reject(new Error("request-body-too-large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      const parsed = {};
      const params = new URLSearchParams(body);
      for (const [key, value] of params.entries()) {
        parsed[key] = value;
      }
      resolve(parsed);
    });
    req.on("error", reject);
  });
}

async function parseMultipartBody(req) {
  const contentLength = Number(req.headers["content-length"]) || 0;
  if (contentLength > 32 * 1024 * 1024) {
    throw new Error("request-body-too-large");
  }
  const request = new Request("http://localhost/upload", {
    method: req.method || "POST",
    headers: req.headers,
    body: req,
    duplex: "half",
  });
  return request.formData();
}

async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (body.length > 1024 * 1024) {
        reject(new Error("request-body-too-large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("invalid-json-body"));
      }
    });
    req.on("error", reject);
  });
}

function guessUploadExtension(fileName, mimeType) {
  const explicitExtension = path.extname(cleanText(fileName || ""));
  if (explicitExtension) {
    return explicitExtension.toLowerCase();
  }
  const normalizedMimeType = cleanText(mimeType || "").toLowerCase();
  const knownExtensions = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/heif": ".heif",
  };
  return knownExtensions[normalizedMimeType] || ".img";
}

async function cleanupExpiredCompletionReplyUploads(config) {
  try {
    const entries = await fs.readdir(config.replyUploadsDir, { withFileTypes: true });
    const cutoffMs = Date.now() - config.completionReplyUploadTtlMs;
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }
      const filePath = path.join(config.replyUploadsDir, entry.name);
      try {
        const stat = await fs.stat(filePath);
        if (Number(stat.mtimeMs) < cutoffMs) {
          await fs.rm(filePath, { force: true });
        }
      } catch {
        // Ignore best-effort cleanup errors.
      }
    }));
  } catch {
    // Ignore missing upload dir.
  }
}

async function stageCompletionReplyImages(config, req) {
  const formData = await parseMultipartBody(req);
  const files = formData
    .getAll("image")
    .filter((value) => typeof File !== "undefined" && value instanceof File);

  if (files.length > MAX_COMPLETION_REPLY_IMAGE_COUNT) {
    throw new Error("completion-reply-image-limit");
  }

  await cleanupExpiredCompletionReplyUploads(config);
  await fs.mkdir(config.replyUploadsDir, { recursive: true });

  const localImagePaths = [];
  for (const file of files) {
    const mimeType = cleanText(file.type || "").toLowerCase();
    if (!mimeType.startsWith("image/")) {
      throw new Error("completion-reply-image-invalid-type");
    }
    if (!Number.isFinite(file.size) || file.size <= 0) {
      throw new Error("completion-reply-image-invalid-upload");
    }
    if (file.size > config.completionReplyImageMaxBytes) {
      throw new Error("completion-reply-image-too-large");
    }

    const extension = guessUploadExtension(file.name, mimeType);
    const stagedFilePath = path.join(
      config.replyUploadsDir,
      `${Date.now()}-${crypto.randomUUID()}${extension}`
    );
    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(stagedFilePath, buffer, { mode: 0o600 });
    localImagePaths.push(stagedFilePath);
  }

  return {
    text: cleanText(formData.get("text") ?? ""),
    planMode: String(formData.get("planMode") ?? "") === "true",
    force: String(formData.get("force") ?? "") === "true",
    localImagePaths,
  };
}

function isLoopbackRequest(req) {
  const remoteAddress = cleanText(req.socket?.remoteAddress ?? "");
  return (
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1"
  );
}

function writeApprovalMissing(res, req, statusCode, locale = DEFAULT_LOCALE) {
  if (requestWantsHtml(req)) {
    return writeHtml(
      res,
      statusCode,
      renderStatusPage({
        title: t(locale, "server.page.approvalExpired"),
        body: t(locale, "error.approvalNotFound"),
        tone: "neutral",
      })
    );
  }
  return writeJson(res, statusCode, { error: "approval-not-found" });
}

function writeUserInputMissing(res, req, statusCode, locale = DEFAULT_LOCALE) {
  if (requestWantsHtml(req)) {
    return writeHtml(
      res,
      statusCode,
      renderStatusPage({
        title: t(locale, "server.page.choiceExpired"),
        body: t(locale, "error.choiceInputNotFound"),
        tone: "neutral",
      })
    );
  }
  return writeJson(res, statusCode, { error: "choice-input-not-found" });
}

function writeApprovalHandled(res, req, title, statusCode, locale = DEFAULT_LOCALE) {
  if (requestWantsHtml(req)) {
    return writeHtml(
      res,
      statusCode,
      renderStatusPage({
        title,
        body: t(locale, "error.approvalAlreadyHandled"),
        tone: "neutral",
      })
    );
  }
  return writeJson(res, statusCode, { error: "approval-already-handled" });
}

function writeCompletionMissing(res, req, statusCode, locale = DEFAULT_LOCALE) {
  if (requestWantsHtml(req)) {
    return writeHtml(
      res,
      statusCode,
      renderStatusPage({
        title: t(locale, "server.page.detailExpired"),
        body: t(locale, "server.page.detailMissing"),
        tone: "neutral",
      })
    );
  }
  return writeJson(res, statusCode, { error: "item-not-found" });
}

function writeJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(body)}\n`);
}

// Return focus to the Claude Desktop app when a Mac client just submitted a
// plan / question / approval decision, so the user can resume in Claude
// without manually switching apps. iOS / Android paired devices are skipped
// (UA match). If Claude is not running, we do nothing — the AppleScript
// `exists (process "Claude")` guard prevents an unwanted launch.
function activateClaudeDesktopIfMac(req) {
  try {
    const ua = String(req?.headers?.["user-agent"] || "");
    if (/iPhone|iPad|iPod|Android/iu.test(ua)) return;
    if (!/Macintosh|Mac OS X/iu.test(ua)) return;
    const script = `tell application "System Events"
  if exists (processes where name is "Claude") then
    tell application "Claude" to activate
  end if
end tell`;
    const child = spawn("osascript", ["-e", script], { stdio: "ignore" });
    child.unref();
  } catch {
    // Best effort.
  }
}

function writeHtml(res, statusCode, html) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`${html}\n`);
}

function startHttpServer(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function stopHttpServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function renderApprovalPage({ eyebrow, title, messageText, token, basePath, actions, locale = DEFAULT_LOCALE, provider = "codex" }) {
  const messageHtml = renderMessageHtml(messageText, `<p>${escapeHtml(t(locale, "detail.approvalRequested"))}</p>`);
  const actionsHtml = actions
    .map(
      (action) => `
      <form method="post" action="/${escapeHtml(basePath)}/${escapeHtml(token)}/${escapeHtml(action.decision)}">
          <button class="button ${action.tone}" type="submit">${escapeHtml(action.label)}</button>
        </form>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #101418;
        --panel: #172027;
        --text: #f7fbff;
        --muted: #9cb2c3;
        --approve: #2f8f67;
        --reject: #b94747;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top, rgba(61, 126, 93, 0.25), transparent 32%),
          linear-gradient(180deg, #0d1115 0%, var(--bg) 100%);
        color: var(--text);
      }
      main {
        max-width: 42rem;
        margin: 0 auto;
        padding: 2rem 1rem 3rem;
      }
      .card {
        background: rgba(23, 32, 39, 0.94);
        border: 1px solid rgba(156, 178, 195, 0.18);
        border-radius: 20px;
        padding: 1.25rem;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.24);
      }
      .eyebrow {
        margin: 0 0 0.75rem;
        color: var(--muted);
        font-size: 0.9rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        font-size: 1.65rem;
        line-height: 1.25;
      }
      ${markdownMessageStyles()}
      .hint {
        margin-top: 1rem;
        color: var(--muted);
        font-size: 0.95rem;
      }
      .actions {
        display: grid;
        gap: 0.8rem;
        margin-top: 1.5rem;
      }
      form {
        margin: 0;
      }
      .button {
        display: block;
        width: 100%;
        border: 0;
        border-radius: 14px;
        padding: 0.95rem 1rem;
        font: inherit;
        font-size: 1rem;
        font-weight: 700;
        text-align: center;
        text-decoration: none;
        color: white;
        cursor: pointer;
      }
      .link {
        background: rgba(156, 178, 195, 0.12);
        color: var(--text);
      }
      .approve { background: var(--approve); }
      .reject { background: var(--reject); }
    </style>
  </head>
  <body>
    <main>
      <section class="card">
        <p class="eyebrow">${escapeHtml(eyebrow)}</p>
        <h1>${escapeHtml(title)}</h1>
        <div class="message">
          ${messageHtml}
        </div>
        <p class="hint">${escapeHtml(t(locale, "summary.approval", { provider: providerDisplayName(locale, provider) }))}</p>
        <div class="actions">
          ${actionsHtml}
          <a class="button link" href="#" onclick="history.back(); return false;">${escapeHtml(t(locale, "common.back"))}</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function renderUserInputPage({ eyebrow, title, token, questions, locale = DEFAULT_LOCALE }) {
  const questionSections = (Array.isArray(questions) ? questions : [])
    .map((question, index) => {
      const prompt = question.prompt || question.header || t(locale, "choice.questionHeading", { index: index + 1 });
      const fieldsetLabel = question.header || t(locale, "choice.questionHeading", { index: index + 1 });
      const questionHint = normalizeQuestionHintText(question);
      const optionsHtml = (Array.isArray(question.options) ? question.options : [])
        .map((option) => {
          const optionValue = cleanText(option.id ?? "") || option.label;
          const optionDescription = cleanText(
            option.description ?? option.hint ?? option.hintText ?? option.helpText ?? option.subtitle ?? option.detail ?? ""
          );
          return `
            <label class="option">
              <input type="radio" name="${escapeHtml(question.id)}" value="${escapeHtml(optionValue)}" required>
              <span class="option-copy">
                <span>${escapeHtml(option.label)}</span>
                ${optionDescription ? `<small>${escapeHtml(optionDescription)}</small>` : ""}
              </span>
            </label>`;
        })
        .join("\n");

      return `
        <fieldset class="question">
          <legend>${escapeHtml(fieldsetLabel)}</legend>
          <p class="question-text">${escapeHtml(prompt)}</p>
          ${questionHint ? `<p class="question-hint">${escapeHtml(questionHint)}</p>` : ""}
          <div class="option-list">
            ${optionsHtml}
          </div>
        </fieldset>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #101418;
        --panel: #172027;
        --text: #f7fbff;
        --muted: #9cb2c3;
        --accent: #2f8f67;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top, rgba(61, 126, 93, 0.25), transparent 32%),
          linear-gradient(180deg, #0d1115 0%, var(--bg) 100%);
        color: var(--text);
      }
      main {
        max-width: 42rem;
        margin: 0 auto;
        padding: 2rem 1rem 3rem;
      }
      .card {
        background: rgba(23, 32, 39, 0.94);
        border: 1px solid rgba(156, 178, 195, 0.18);
        border-radius: 20px;
        padding: 1.25rem;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.24);
      }
      .eyebrow {
        margin: 0 0 0.75rem;
        color: var(--muted);
        font-size: 0.9rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        font-size: 1.65rem;
        line-height: 1.25;
      }
      .lead {
        margin-top: 0.9rem;
        color: #e8f0f7;
        line-height: 1.55;
      }
      form {
        margin-top: 1.4rem;
      }
      .question {
        margin: 0 0 1rem;
        border: 1px solid rgba(156, 178, 195, 0.18);
        border-radius: 16px;
        padding: 1rem;
      }
      .question:last-of-type {
        margin-bottom: 0;
      }
      legend {
        padding: 0 0.35rem;
        color: var(--muted);
        font-size: 0.95rem;
      }
      .question-text {
        margin: 0 0 0.9rem;
        line-height: 1.5;
      }
      .question-hint {
        margin: -0.35rem 0 0.9rem;
        color: var(--muted);
        font-size: 0.88rem;
        line-height: 1.45;
      }
      .option-list {
        display: grid;
        gap: 0.7rem;
      }
      .option {
        display: flex;
        gap: 0.75rem;
        align-items: flex-start;
        padding: 0.85rem 0.95rem;
        border-radius: 14px;
        background: rgba(156, 178, 195, 0.08);
      }
      .option-copy {
        display: grid;
        gap: 0.2rem;
      }
      .option-copy small {
        color: var(--muted);
        font-size: 0.88rem;
        line-height: 1.4;
      }
      input[type="radio"] {
        margin-top: 0.18rem;
      }
      .actions {
        display: grid;
        gap: 0.8rem;
        margin-top: 1.5rem;
      }
      .button,
      .link {
        display: block;
        width: 100%;
        border: 0;
        border-radius: 14px;
        padding: 0.95rem 1rem;
        font: inherit;
        font-size: 1rem;
        font-weight: 700;
        text-align: center;
        text-decoration: none;
      }
      .button {
        background: var(--accent);
        color: white;
        cursor: pointer;
      }
      .link {
        background: rgba(156, 178, 195, 0.12);
        color: var(--text);
      }
    </style>
  </head>
  <body>
    <main>
      <section class="card">
        <p class="eyebrow">${escapeHtml(eyebrow)}</p>
        <h1>${escapeHtml(title)}</h1>
        <p class="lead">${escapeHtml(t(locale, "choice.submitHelp"))}</p>
        <form method="post" action="/user-inputs/${escapeHtml(token)}">
          ${questionSections}
          <div class="actions">
            <button class="button" type="submit">${escapeHtml(t(locale, "choice.submit"))}</button>
            <a class="link" href="#" onclick="history.back(); return false;">${escapeHtml(t(locale, "common.back"))}</a>
          </div>
        </form>
      </section>
    </main>
  </body>
</html>`;
}

function renderDecisionPage({ eyebrow, title, messageText, token, decision, basePath, confirmBody = null, locale = DEFAULT_LOCALE }) {
  const label = decisionLabel(decision, locale);
  const tone = decisionToneClass(decision);
  const body = confirmBody ?? approvalDecisionConfirm(decision, locale);
  const messageHtml = renderMessageHtml(messageText, `<p>${escapeHtml(t(locale, "detail.approvalRequested"))}</p>`);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(label)} | ${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #101418;
        --panel: #172027;
        --text: #f7fbff;
        --muted: #9cb2c3;
        --approve: #2f8f67;
        --reject: #b94747;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top, rgba(61, 126, 93, 0.25), transparent 32%),
          linear-gradient(180deg, #0d1115 0%, var(--bg) 100%);
        color: var(--text);
      }
      main {
        max-width: 42rem;
        margin: 0 auto;
        padding: 2rem 1rem 3rem;
      }
      .card {
        background: rgba(23, 32, 39, 0.94);
        border: 1px solid rgba(156, 178, 195, 0.18);
        border-radius: 20px;
        padding: 1.25rem;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.24);
      }
      .eyebrow {
        margin: 0 0 0.75rem;
        color: var(--muted);
        font-size: 0.9rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        font-size: 1.65rem;
        line-height: 1.25;
      }
      .lead {
        margin-top: 0.85rem;
        color: #e8f0f7;
        line-height: 1.55;
      }
      ${markdownMessageStyles()}
      .actions {
        display: grid;
        gap: 0.8rem;
        margin-top: 1.5rem;
      }
      form {
        margin: 0;
      }
      .button,
      .link {
        display: block;
        width: 100%;
        border: 0;
        border-radius: 14px;
        padding: 0.95rem 1rem;
        font: inherit;
        font-size: 1rem;
        font-weight: 700;
        text-align: center;
        text-decoration: none;
      }
      .button {
        color: white;
        cursor: pointer;
      }
      .link {
        background: rgba(156, 178, 195, 0.12);
        color: var(--text);
      }
      .approve { background: var(--approve); }
      .reject { background: var(--reject); }
    </style>
  </head>
  <body>
    <main>
      <section class="card">
        <p class="eyebrow">${escapeHtml(eyebrow)}</p>
        <h1>${escapeHtml(label)}</h1>
        <p class="lead">${escapeHtml(body)}</p>
        <div class="message">
          ${messageHtml}
        </div>
        <div class="actions">
          <form method="post" action="/${escapeHtml(basePath)}/${escapeHtml(token)}/${escapeHtml(decision)}">
            <button class="button ${tone}" type="submit">${escapeHtml(label)}</button>
          </form>
          <a class="link" href="/${escapeHtml(basePath)}/${escapeHtml(token)}">${escapeHtml(t(locale, "common.back"))}</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function renderMessagePage({ eyebrow, title, messageText, locale = DEFAULT_LOCALE }) {
  const messageHtml = renderMessageHtml(messageText, `<p>${escapeHtml(t(locale, "server.message.taskFinished"))}</p>`);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #101418;
        --panel: #172027;
        --text: #f7fbff;
        --muted: #9cb2c3;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top, rgba(61, 126, 93, 0.24), transparent 32%),
          linear-gradient(180deg, #0d1115 0%, var(--bg) 100%);
        color: var(--text);
      }
      main {
        max-width: 46rem;
        margin: 0 auto;
        padding: 2rem 1rem 3rem;
      }
      .card {
        background: rgba(23, 32, 39, 0.94);
        border: 1px solid rgba(156, 178, 195, 0.18);
        border-radius: 20px;
        padding: 1.25rem;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.24);
      }
      .eyebrow {
        margin: 0 0 0.75rem;
        color: var(--muted);
        font-size: 0.9rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        font-size: 1.65rem;
        line-height: 1.25;
      }
      ${markdownMessageStyles()}
    </style>
  </head>
  <body>
    <main>
      <section class="card">
        <p class="eyebrow">${escapeHtml(eyebrow)}</p>
        <h1>${escapeHtml(title)}</h1>
        <div class="message">
          ${messageHtml}
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function renderStatusPage({ title, body, tone, provider = "codex", locale = DEFAULT_LOCALE }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #101418;
        --panel: #172027;
        --text: #f7fbff;
        --muted: #9cb2c3;
        --accent: ${statusAccent(tone)};
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 1rem;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top, rgba(61, 126, 93, 0.24), transparent 32%),
          linear-gradient(180deg, #0d1115 0%, var(--bg) 100%);
        color: var(--text);
      }
      .card {
        width: min(32rem, 100%);
        background: rgba(23, 32, 39, 0.94);
        border: 1px solid rgba(156, 178, 195, 0.18);
        border-radius: 20px;
        padding: 1.4rem;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.24);
      }
      .chip {
        display: inline-block;
        margin-bottom: 0.8rem;
        padding: 0.35rem 0.6rem;
        border-radius: 999px;
        background: var(--accent);
        color: white;
        font-size: 0.85rem;
        font-weight: 700;
      }
      h1 {
        margin: 0;
        font-size: 1.4rem;
      }
      p {
        margin: 0.9rem 0 0;
        color: #e8f0f7;
        line-height: 1.55;
      }
      .muted {
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <section class="card">
      <span class="chip">${escapeHtml(providerDisplayName(locale, provider))}</span>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(body)}</p>
      <p class="muted">このページは閉じて大丈夫です。</p>
    </section>
  </body>
</html>`;
}

function markdownMessageStyles() {
  return `
      .message {
        margin-top: 1rem;
        color: #e8f0f7;
        line-height: 1.6;
      }
      .message > :first-child {
        margin-top: 0;
      }
      .message > :last-child {
        margin-bottom: 0;
      }
      .message p,
      .message ul,
      .message ol,
      .message blockquote,
      .message pre,
      .message hr {
        margin: 0 0 0.9rem;
      }
      .message h1,
      .message h2,
      .message h3,
      .message h4,
      .message h5,
      .message h6 {
        margin: 1.2rem 0 0.7rem;
        line-height: 1.3;
      }
      .message h1 { font-size: 1.4rem; }
      .message h2 { font-size: 1.25rem; }
      .message h3 { font-size: 1.1rem; }
      .message ul,
      .message ol {
        padding-left: 1.35rem;
      }
      .message li {
        margin: 0.35rem 0;
      }
      .message blockquote {
        border-left: 3px solid rgba(156, 178, 195, 0.32);
        padding-left: 0.9rem;
        color: #d7e6f2;
      }
      .message code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        background: rgba(156, 178, 195, 0.14);
        border-radius: 8px;
        padding: 0.08rem 0.38rem;
        font-size: 0.94em;
      }
      .message pre {
        overflow: auto;
        padding: 0.9rem 1rem;
        border-radius: 14px;
        background: rgba(11, 16, 20, 0.92);
        border: 1px solid rgba(156, 178, 195, 0.12);
      }
      .message pre code {
        background: transparent;
        padding: 0;
        border-radius: 0;
      }
      .message a {
        color: #8dd2ff;
        text-decoration: none;
      }
      .message a:hover {
        text-decoration: underline;
      }
      .message hr {
        border: 0;
        height: 1px;
        background: rgba(156, 178, 195, 0.18);
      }`;
}

function approvalDecisionMessage(decision, locale = config?.defaultLocale || DEFAULT_LOCALE, provider = "codex") {
  const vars = { provider: providerDisplayName(locale, provider) };
  if (decision === "accept") {
    return t(locale, "server.message.approvalAccepted", vars);
  }
  return t(locale, "server.message.approvalRejected", vars);
}

function planDecisionMessage(decision, locale = config?.defaultLocale || DEFAULT_LOCALE, provider = "codex") {
  const vars = { provider: providerDisplayName(locale, provider) };
  if (decision === "implement") {
    return t(locale, "server.message.planImplemented", vars);
  }
  return t(locale, "server.message.planDismissed");
}

function decisionTone(decision) {
  return decision === "accept" || decision === "implement" ? "ok" : "warn";
}

function decisionLabel(decision, locale = config?.defaultLocale || DEFAULT_LOCALE) {
  if (decision === "implement") {
    return t(locale, "server.action.implement");
  }
  return decision === "accept" ? t(locale, "server.action.approve") : t(locale, "server.action.reject");
}

function approvalDecisionConfirm(decision, locale = config?.defaultLocale || DEFAULT_LOCALE, provider = "codex") {
  const vars = { provider: providerDisplayName(locale, provider) };
  if (decision === "implement") {
    return t(locale, "server.confirm.planImplement");
  }
  if (decision === "accept") {
    return t(locale, "server.confirm.approve", vars);
  }
  return t(locale, "server.confirm.reject", vars);
}

function resolvePlanDecisionAnswer(planRequest, decision) {
  const requestId = cleanText(planRequest?.questionRequestId ?? "");
  if (!requestId) {
    return null;
  }

  const option = selectPlanDecisionOption(planRequest.questionOptions, decision);
  if (!option) {
    return null;
  }

  return {
    requestId,
    answerText: option.label,
    ownerClientId: cleanText(planRequest.questionOwnerClientId ?? "") || planRequest.ownerClientId || null,
  };
}

function selectPlanDecisionOption(options, decision) {
  const normalizedOptions = Array.isArray(options) ? options : [];
  const preferredIdNeedles =
    decision === "implement"
      ? ["implement", "start_coding", "default"]
      : ["stay_in_plan", "stay", "decline"];
  const preferredLabelNeedles =
    decision === "implement"
      ? ["implement this plan", "start coding", "実装"]
      : ["stay in plan mode", "plan mode のまま", "plan mode"];

  for (const option of normalizedOptions) {
    const optionId = cleanText(option.id ?? "").toLowerCase();
    if (optionId && preferredIdNeedles.some((needle) => optionId.includes(needle))) {
      return option;
    }
  }

  for (const option of normalizedOptions) {
    const label = cleanText(option.label ?? "").toLowerCase();
    if (label && preferredLabelNeedles.some((needle) => label.includes(needle))) {
      return option;
    }
  }

  if (decision === "decline" && normalizedOptions.length >= 2) {
    const implementOption = selectPlanDecisionOption(normalizedOptions, "implement");
    const fallback = normalizedOptions.find((option) => option !== implementOption && !option.isOther);
    if (fallback) {
      return fallback;
    }
  }

  return null;
}

function resolveGenericUserInputResponse(userInputRequest, submittedAnswers) {
  const questions = Array.isArray(userInputRequest?.questions) ? userInputRequest.questions : [];
  const answers = {};

  for (const question of questions) {
    const questionId = cleanText(question.id ?? "");
    if (!questionId) {
      throw new Error("question-id-missing");
    }

    const submittedValue = cleanText(submittedAnswers?.[questionId] ?? "");
    if (!submittedValue) {
      throw new Error(`question-not-answered:${questionId}`);
    }

    const option = findQuestionOption(question, submittedValue);
    if (!option) {
      throw new Error(`option-not-found:${questionId}`);
    }

    answers[questionId] = {
      answers: [option.label],
    };
  }

  return { answers };
}

function formatSubmittedTestAnswers(userInputRequest, submittedAnswers) {
  const questions = Array.isArray(userInputRequest?.questions) ? userInputRequest.questions : [];
  return questions
    .map((question, index) => {
      const submittedValue = cleanText(submittedAnswers?.[question.id] ?? "");
      const option = findQuestionOption(question, submittedValue);
      const label = option?.label || submittedValue || "(none)";
      const title = question.header || question.prompt || `Question ${index + 1}`;
      return `${title}: ${label}`;
    })
    .join("\n");
}

function findQuestionOption(question, submittedValue) {
  const normalizedValue = cleanText(submittedValue);
  const options = Array.isArray(question?.options) ? question.options : [];
  for (const option of options) {
    if (cleanText(option.id ?? "") === normalizedValue) {
      return option;
    }
  }
  for (const option of options) {
    if (cleanText(option.label ?? "") === normalizedValue) {
      return option;
    }
  }
  return null;
}

function decisionToneClass(decision) {
  return decision === "accept" || decision === "implement" ? "approve" : "reject";
}

function statusAccent(tone) {
  if (tone === "ok") {
    return "#2f8f67";
  }
  if (tone === "warn") {
    return "#b94747";
  }
  return "#5d6670";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function serializeActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return "";
  }

  return actions
    .map((action) =>
      [
        `action=${action.action}`,
        `label=${quoteHeaderValue(action.label)}`,
        action.url ? `url=${quoteHeaderValue(action.url)}` : "",
        action.method ? `method=${action.method}` : "",
        action.clear ? "clear=true" : "",
      ]
        .filter(Boolean)
        .join(", ")
    )
    .join("; ");
}

function quoteHeaderValue(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9._~:/?#\[\]@!$&'()*+=-]+$/u.test(text)) {
    return text;
  }
  return `"${text.replace(/"/gu, '\\"')}"`;
}

function isLoopbackHostname(value) {
  const normalized = cleanText(value || "").toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function readA2AEnvKey() {
  try {
    const envPath = path.join(os.homedir(), ".viveworker", "a2a.env");
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/u)) {
      const m = line.match(/^\s*A2A_API_KEY\s*=\s*(.+?)\s*$/u);
      if (m) return m[1].replace(/^['"]|['"]$/gu, "");
    }
  } catch {
    // ignore
  }
  return "";
}

function readMoltbookEnvKey() {
  // Fall back to the standalone watcher's env file so the bridge can detect
  // a configured Moltbook integration without requiring MOLTBOOK_API_KEY to
  // be duplicated into its launchd plist.
  try {
    const envPath = path.join(os.homedir(), ".viveworker", "moltbook.env");
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/u)) {
      const m = line.match(/^\s*MOLTBOOK_API_KEY\s*=\s*(.+?)\s*$/u);
      if (m) return m[1].replace(/^['"]|['"]$/gu, "");
    }
  } catch {
    // ignore
  }
  return "";
}

// Post an approved Moltbook draft (reply or original post), solve the
// verification puzzle, and update scout state.  Called asynchronously from
// the decision handler.
async function executeMoltbookDraftPost(draft, config, runtime, state) {
  if (!config.moltbookApiKey) throw new Error("MOLTBOOK_API_KEY not configured");
  const mb = createMoltbookClient(config.moltbookApiKey);

  const finalText = draft.decision.text || draft.draftText;
  const finalTitle = draft.decision.title || draft.postTitle;

  let verification;
  // Captured so the post-verify history record knows which post/comment the
  // challenge_text was attached to. `draft.postId` only exists for replies;
  // for `original_post` drafts the id only shows up in the POST /posts
  // response.
  let createdPostId = null;
  let createdCommentId = null;

  if (draft.draftType === "original_post") {
    const result = await mb("/posts", {
      method: "POST",
      body: JSON.stringify({
        submolt_name: draft.submoltName,
        submolt: draft.submoltName,
        title: finalTitle,
        content: finalText,
      }),
    });
    const post = result?.post || null;
    verification = post?.verification || null;
    createdPostId = post?.id || null;
    console.log(`[moltbook-draft-post] Posted original post (id=${post?.id})`);

    const scoutState = rollScoutDayIfNeeded(await readScoutState());
    recordComposeAttempt(scoutState, finalTitle, post?.id, "post");
    await writeScoutState(scoutState);
  } else {
    const result = await mb(`/posts/${draft.postId}/comments`, {
      method: "POST",
      body: JSON.stringify({
        content: finalText,
        ...(draft.parentCommentId ? { parent_id: draft.parentCommentId } : {}),
      }),
    });
    const comment = result?.comment || null;
    verification = comment?.verification || null;
    createdPostId = draft.postId || null;
    createdCommentId = comment?.id || null;
    console.log(`[moltbook-draft-post] Posted reply (commentId=${comment?.id}) to post ${draft.postId}`);

    const scoutState = rollScoutDayIfNeeded(await readScoutState());
    scoutState.sentToday += 1;
    markPostSeen(scoutState, draft.postId, "published");
    // Append the reply to `recentComposeTitles` so it shows up in the
    // "最近の投稿" list with its reply badge. `recordComposeAttempt` knows
    // not to bump `composedToday` when type === "reply", so the
    // "本日の新規投稿数" counter only reflects original posts.
    recordComposeAttempt(scoutState, draft.postTitle || draft.postId, draft.postId, "reply");
    await writeScoutState(scoutState);
  }

  // Solve verification puzzle if present.
  //
  // Every attempt — success, server rejection, or complete failure — gets
  // recorded via `recordPuzzleAttempt` so we can build a corpus of
  // challenge_text at `~/.viveworker/moltbook-verify-history.jsonl`. This is
  // the only way to reconstruct failing puzzles; Moltbook only returns
  // `challenge_text` in the initial POST response.
  if (verification) {
    const solverAnswer = solveVerificationPuzzle(verification.challenge_text);
    let submittedAnswer = solverAnswer;
    let llmAnswer = null;
    let outcome = "unknown";
    let verifyError = null;

    if (submittedAnswer == null) {
      llmAnswer = await solvePuzzleWithLLM(verification.challenge_text);
      submittedAnswer = llmAnswer;
    }

    if (submittedAnswer != null) {
      try {
        await mb("/verify", {
          method: "POST",
          body: JSON.stringify({ verification_code: verification.verification_code, answer: submittedAnswer }),
        });
        console.log(`[moltbook-draft-verify] Verified with answer ${submittedAnswer}`);
        outcome = solverAnswer != null && llmAnswer == null ? "solver-verified" : "llm-verified";
      } catch (err) {
        verifyError = err.message;
        // Wrong answer from solver — retry with LLM.
        if (/incorrect/i.test(err.message) && solverAnswer != null && llmAnswer == null) {
          llmAnswer = await solvePuzzleWithLLM(verification.challenge_text);
          if (llmAnswer && llmAnswer !== solverAnswer) {
            try {
              await mb("/verify", {
                method: "POST",
                body: JSON.stringify({ verification_code: verification.verification_code, answer: llmAnswer }),
              });
              console.log(`[moltbook-draft-verify] Verified with LLM retry answer ${llmAnswer}`);
              submittedAnswer = llmAnswer;
              verifyError = null;
              outcome = "solver-incorrect-llm-verified";
            } catch (retryError) {
              console.error(`[moltbook-draft-verify] LLM retry failed: ${retryError.message}`);
              verifyError = retryError.message;
              outcome = "both-incorrect";
            }
          } else {
            outcome = "solver-incorrect-llm-agreed-or-null";
          }
        } else {
          console.error(`[moltbook-draft-verify] Failed: ${err.message}`);
          outcome = solverAnswer != null ? "solver-rejected" : "llm-rejected";
        }
      }
    } else {
      console.error(`[moltbook-draft-verify] Could not solve puzzle for draft ${draft.token}`);
      outcome = "both-failed-to-solve";
    }

    // Best-effort corpus write. Never throws.
    await recordPuzzleAttempt({
      draftToken: draft.token,
      draftType: draft.draftType,
      postId: createdPostId,
      commentId: createdCommentId,
      challenge_text: verification.challenge_text,
      verification_code: verification.verification_code,
      solverAnswer,
      llmAnswer,
      submittedAnswer,
      outcome,
      verifyError,
    });
  }

  // Push notification for successful post.
  try {
    const pushTitle = draft.draftType === "original_post" ? finalTitle : `Reply → ${draft.postTitle || "Moltbook"}`;
    await deliverWebPushItem({
      config, state, kind: "moltbook_draft", token: draft.token,
      tab: "inbox",
      subtab: "completed",
      stableId: `moltbook_draft_posted:${draft.sourceId}`,
      title: "Moltbook posted",
      body: truncate(singleLine(pushTitle), 160),
    });
  } catch { /* ignore push error */ }

  console.log(`[moltbook-draft] Successfully posted draft ${draft.token} (type=${draft.draftType})`);
}

function buildConfig(cli) {
  const codexHome = resolvePath(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const stateFile = resolvePath(process.env.STATE_FILE || path.join(workspaceRoot, ".viveworker-state.json"));
  return {
    dryRun: cli.dryRun || truthy(process.env.DRY_RUN),
    once: cli.once,
    codexHome,
    moltbookApiKey: cleanText(process.env.MOLTBOOK_API_KEY || readMoltbookEnvKey() || ""),
    a2aApiKey: cleanText(process.env.A2A_API_KEY || readA2AEnvKey() || ""),
    a2aPublicUrl: cleanText(process.env.A2A_PUBLIC_URL || ""),
    a2aDescription: cleanText(process.env.A2A_DESCRIPTION || ""),
    a2aSkills: cleanText(process.env.A2A_SKILLS || ""),
    a2aAvatar: cleanText(process.env.A2A_AVATAR || ""),
    version: appPackageVersion,
    a2aRelayUrl: cleanText(process.env.A2A_RELAY_URL || ""),
    a2aRelayUserId: cleanText(process.env.A2A_RELAY_USER_ID || ""),
    a2aRelaySecret: cleanText(process.env.A2A_RELAY_SECRET || ""),
    a2aRelayRegisterSecret: cleanText(process.env.A2A_RELAY_REGISTER_SECRET || ""),
    // share.viveworker.com — HTML hosting backed by the same A2A credentials.
    // Override for staging / self-hosted deployments via VIVEWORKER_SHARE_URL.
    a2aShareUrl: stripTrailingSlash(
      process.env.VIVEWORKER_SHARE_URL || "https://share.viveworker.com"
    ),
    hazbaseApiUrl: stripTrailingSlash(process.env.HAZBASE_API_URL || "https://passkey.hazbase.com"),
    hazbaseDeviceLabel: cleanText(process.env.HAZBASE_DEVICE_LABEL || "viveworker"),
    webUiEnabled: boolEnv("WEB_UI_ENABLED", true),
    authRequired: boolEnv("AUTH_REQUIRED", true),
    webPushEnabled: boolEnv("WEB_PUSH_ENABLED", false),
    allowInsecureLanHttp: boolEnv("ALLOW_INSECURE_LAN_HTTP", false),
    enableNtfy: boolEnv("ENABLE_NTFY", Boolean(process.env.NTFY_TOPIC)),
    sessionsDir: resolvePath(process.env.SESSIONS_DIR || path.join(codexHome, "sessions")),
    sessionIndexFile: resolvePath(process.env.SESSION_INDEX_FILE || path.join(codexHome, "session_index.jsonl")),
    historyFile: resolvePath(process.env.HISTORY_FILE || path.join(codexHome, "history.jsonl")),
    codexLogsDbFile: resolvePath(process.env.CODEX_LOGS_DB_FILE || ""),
    stateFile,
    threadRegistryFile: resolvePath(process.env.THREAD_REGISTRY_FILE || path.join(os.homedir(), ".viveworker", "thread-registry.json")),
    replyUploadsDir: resolvePath(process.env.REPLY_UPLOADS_DIR || path.join(path.dirname(stateFile), "uploads")),
    timelineAttachmentsDir: resolvePath(
      process.env.TIMELINE_ATTACHMENTS_DIR || path.join(path.dirname(stateFile), "timeline-attachments")
    ),
    pollIntervalMs: numberEnv("POLL_INTERVAL_MS", 2500),
    replaySeconds: numberEnv("REPLAY_SECONDS", 300),
    sessionIndexRefreshMs: numberEnv("SESSION_INDEX_REFRESH_MS", 30000),
    directoryScanIntervalMs: numberEnv("DIRECTORY_SCAN_INTERVAL_MS", 30000),
    planRequestTtlMs: numberEnv("PLAN_REQUEST_TTL_MS", 900000),
    notifyApprovals: boolEnv("NOTIFY_APPROVALS", true),
    notifyCompletions: boolEnv("NOTIFY_COMPLETIONS", true),
    notifyPlans: boolEnv("NOTIFY_PLANS", true),
    nativeApprovals: boolEnv("NATIVE_APPROVALS", true),
    ntfyBaseUrl: stripTrailingSlash(process.env.NTFY_BASE_URL || "https://ntfy.sh"),
    ntfyPublishBaseUrl: stripTrailingSlash(process.env.NTFY_PUBLISH_BASE_URL || process.env.NTFY_BASE_URL || "https://ntfy.sh"),
    ntfyTopic: process.env.NTFY_TOPIC || "",
    defaultLocale: normalizeSupportedLocale(process.env.DEFAULT_LOCALE, DEFAULT_LOCALE) || DEFAULT_LOCALE,
    approvalTitle: process.env.APPROVAL_TITLE || t(normalizeSupportedLocale(process.env.DEFAULT_LOCALE, DEFAULT_LOCALE), "server.title.approval"),
    completeTitle: process.env.COMPLETE_TITLE || t(normalizeSupportedLocale(process.env.DEFAULT_LOCALE, DEFAULT_LOCALE), "server.title.complete"),
    planTitle: process.env.PLAN_TITLE || t(normalizeSupportedLocale(process.env.DEFAULT_LOCALE, DEFAULT_LOCALE), "server.title.plan"),
    planReadyTitle: process.env.PLAN_READY_TITLE || t(normalizeSupportedLocale(process.env.DEFAULT_LOCALE, DEFAULT_LOCALE), "server.title.planReady"),
    approvalPriority: ntfyPriority("NTFY_APPROVAL_PRIORITY", "high"),
    completePriority: ntfyPriority("NTFY_COMPLETE_PRIORITY", "default"),
    planPriority: ntfyPriority("NTFY_PLAN_PRIORITY", "high"),
    approvalTags: csvEnv("NTFY_APPROVAL_TAGS", ["warning", "computer"]),
    completeTags: csvEnv("NTFY_COMPLETE_TAGS", ["white_check_mark", "computer"]),
    planTags: csvEnv("NTFY_PLAN_TAGS", ["memo", "computer"]),
    clickUrl: process.env.NTFY_CLICK_URL || "",
    maxSeenEvents: numberEnv("MAX_SEEN_EVENTS", 500),
    maxHistoryItems: numberEnv("MAX_HISTORY_ITEMS", 100),
    maxTimelineEntries: numberEnv("MAX_TIMELINE_ENTRIES", 250),
    maxCodeEvents: numberEnv("MAX_CODE_EVENTS", 1000),
    maxTimelineThreads: numberEnv("MAX_TIMELINE_THREADS", 20),
    maxReadBytes: numberEnv("MAX_READ_BYTES", 2 * 1024 * 1024),
    maxMessageChars: numberEnv("MAX_MESSAGE_CHARS", 320),
    maxCommandChars: numberEnv("MAX_COMMAND_CHARS", 220),
    maxJustificationChars: numberEnv("MAX_JUSTIFICATION_CHARS", 220),
    completionDetailThresholdChars: numberEnv("COMPLETION_DETAIL_THRESHOLD_CHARS", 100),
    maxCompletionDetails: numberEnv("MAX_COMPLETION_DETAILS", 200),
    ntfyConnectTimeoutSecs: numberEnv("NTFY_CONNECT_TIMEOUT_SECS", 5),
    ntfyMaxTimeSecs: numberEnv("NTFY_MAX_TIME_SECS", 12),
    nativeApprovalPublicBaseUrl: stripTrailingSlash(
      process.env.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "http://127.0.0.1:8789"
    ),
    nativeApprovalListenHost: process.env.NATIVE_APPROVAL_SERVER_HOST || "127.0.0.1",
    nativeApprovalListenPort: numberEnv("NATIVE_APPROVAL_SERVER_PORT", 8789),
    tlsCertFile: resolvePath(process.env.TLS_CERT_FILE || ""),
    tlsKeyFile: resolvePath(process.env.TLS_KEY_FILE || ""),
    webPushVapidPublicKey: cleanText(process.env.WEB_PUSH_VAPID_PUBLIC_KEY || ""),
    webPushVapidPrivateKey: cleanText(process.env.WEB_PUSH_VAPID_PRIVATE_KEY || ""),
    webPushSubject: cleanText(process.env.WEB_PUSH_SUBJECT || "mailto:viveworker@example.com"),
    mkcertRootCaFile: resolvePath(
      process.env.MKCERT_ROOT_CA_FILE || "~/Library/Application Support/mkcert/rootCA.pem"
    ),
    ipcSocketPath: resolvePath(process.env.CODEX_IPC_SOCKET_PATH || defaultIpcSocketPath()),
    ipcReconnectMs: numberEnv("IPC_RECONNECT_MS", 1500),
    ipcRequestTimeoutMs: numberEnv("IPC_REQUEST_TIMEOUT_MS", 12000),
    choicePageSize: numberEnv("CHOICE_PAGE_SIZE", 5),
    completionReplyImageMaxBytes: numberEnv(
      "COMPLETION_REPLY_IMAGE_MAX_BYTES",
      DEFAULT_COMPLETION_REPLY_IMAGE_MAX_BYTES
    ),
    completionReplyUploadTtlMs: numberEnv(
      "COMPLETION_REPLY_UPLOAD_TTL_MS",
      DEFAULT_COMPLETION_REPLY_UPLOAD_TTL_MS
    ),
    deviceTrustTtlMs: numberEnv("DEVICE_TRUST_TTL_MS", DEFAULT_DEVICE_TRUST_TTL_MS),
    sessionTtlMs: numberEnv("SESSION_TTL_MS", 30 * 24 * 60 * 60 * 1000),
    pairingCode: process.env.PAIRING_CODE || "",
    pairingToken: process.env.PAIRING_TOKEN || "",
    pairingExpiresAtMs: numberEnv("PAIRING_EXPIRES_AT_MS", 0),
    sessionSecret: process.env.SESSION_SECRET || "",
    claudeProjectsDir: resolvePath(process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects")),
  };
}


function normalizeHazbaseState(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    email: cleanText(value.email ?? ""),
    accessToken: cleanText(value.accessToken ?? ""),
    sessionId: cleanText(value.sessionId ?? ""),
    userId: cleanText(value.userId ?? ""),
    deviceBindingId: cleanText(value.deviceBindingId ?? ""),
    credentialId: cleanText(value.credentialId ?? ""),
    highTrustToken: cleanText(value.highTrustToken ?? ""),
    highTrustExpiresAt: cleanText(value.highTrustExpiresAt ?? ""),
    accounts: Array.isArray(value.accounts) ? value.accounts : [],
  };
}

function configureHazbaseClient(config) {
  try {
    setHazbaseClientKey(process.env.HAZBASE_CLIENT_KEY || "viveworker-internal");
    setHazbaseApiEndpoint(config.hazbaseApiUrl || "https://passkey.hazbase.com");
  } catch (error) {
    console.error(`[hazbase-config] ${error.message}`);
  }
}

function mergeHazbaseAccountSummaries(existing, incoming) {
  const merged = new Map();
  for (const entry of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!entry || !entry.smartAccountAddress) continue;
    const key = `${Number(entry.chainId) || 0}:${String(entry.smartAccountAddress).toLowerCase()}`;
    merged.set(key, entry);
  }
  return [...merged.values()];
}

function resolveHazbaseAccountForChain(accounts, chainId) {
  const normalizedChainId = Number(chainId || 0);
  if (!normalizedChainId) return null;
  const list = Array.isArray(accounts) ? accounts : [];
  return list.find((entry) => Number(entry?.chainId) === normalizedChainId && cleanText(entry?.smartAccountAddress || "")) || null;
}

function validateConfig(config) {
  let publicBaseUrl = null;
  try {
    publicBaseUrl = new URL(config.nativeApprovalPublicBaseUrl);
  } catch {
    throw new Error(`Invalid NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL: ${config.nativeApprovalPublicBaseUrl}`);
  }

  if (config.authRequired && !config.sessionSecret) {
    throw new Error("SESSION_SECRET is required when AUTH_REQUIRED=1");
  }

  const isHttps = publicBaseUrl.protocol === "https:";
  const isLoopback = isLoopbackHostname(publicBaseUrl.hostname);
  if (config.authRequired && !isHttps && !isLoopback && !config.allowInsecureLanHttp) {
    throw new Error(
      "LAN auth requires HTTPS. Use setup defaults, switch to a loopback URL, or set ALLOW_INSECURE_LAN_HTTP=1 intentionally."
    );
  }

  if (config.webPushEnabled) {
    if (!isHttps) {
      throw new Error("WEB_PUSH_ENABLED=1 requires NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL to use https://");
    }
    if (!config.tlsCertFile || !config.tlsKeyFile) {
      throw new Error("WEB_PUSH_ENABLED=1 requires TLS_CERT_FILE and TLS_KEY_FILE");
    }
    if (!config.webPushVapidPublicKey || !config.webPushVapidPrivateKey) {
      throw new Error("WEB_PUSH_ENABLED=1 requires WEB_PUSH_VAPID_PUBLIC_KEY and WEB_PUSH_VAPID_PRIVATE_KEY");
    }
  }
}

function defaultIpcSocketPath() {
  const uid = process.getuid?.();
  const socketName = uid ? `ipc-${uid}.sock` : "ipc.sock";
  return `${os.tmpdir()}/codex-ipc/${socketName}`;
}

function parseCliArgs(args) {
  const parsed = {
    dryRun: false,
    once: false,
    envFile: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--once") {
      parsed.once = true;
    } else if (arg === "--env-file") {
      parsed.envFile = args[index + 1] ?? null;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/viveworker-bridge.mjs [--dry-run] [--once] [--env-file path]`);
}

function resolveEnvFile(explicitPath) {
  if (explicitPath) {
    return resolvePath(explicitPath);
  }

  const fromEnv = process.env.VIVEWORKER_ENV_FILE;
  if (fromEnv) {
    return resolvePath(fromEnv);
  }

  return path.join(workspaceRoot, "viveworker.env");
}

function loadEnvFile(filePath) {
  try {
    const text = readFileSync(filePath, "utf8");
    for (const rawLine of text.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const separator = line.indexOf("=");
      if (separator === -1) {
        continue;
      }

      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // Optional env file.
  }
}

async function maybeRotateStartupPairingEnv(envFile) {
  if (!truthy(process.env.AUTH_REQUIRED)) {
    return;
  }

  const shouldRotate = shouldRotatePairing({
    pairingCode: process.env.PAIRING_CODE || "",
    pairingToken: process.env.PAIRING_TOKEN || "",
    pairingExpiresAtMs: process.env.PAIRING_EXPIRES_AT_MS || 0,
  });

  if (!shouldRotate) {
    return;
  }

  const nextPairing = generatePairingCredentials();
  const updates = {
    PAIRING_CODE: nextPairing.pairingCode,
    PAIRING_TOKEN: nextPairing.pairingToken,
    PAIRING_EXPIRES_AT_MS: String(nextPairing.pairingExpiresAtMs),
  };

  Object.assign(process.env, updates);

  if (!envFile) {
    return;
  }

  let currentText = "";
  try {
    currentText = readFileSync(envFile, "utf8");
  } catch {
    currentText = "";
  }

  const nextText = upsertEnvText(currentText, updates);
  await fs.mkdir(path.dirname(envFile), { recursive: true });
  await fs.writeFile(envFile, nextText, "utf8");
}

async function loadState(stateFile) {
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw);
    const hasExplicitWriteLaneState =
      typeof parsed.autoPilotWriteLaneContent === "boolean" ||
      typeof parsed.autoPilotWriteLaneUiTests === "boolean" ||
      typeof parsed.autoPilotWriteLaneSource === "boolean";
    const legacyTrustedWritesEnabled = parsed.autoPilotTrustedWrites === true || parsed.autoPilotTrustedWritesShadow === true;
    const autoPilotWriteLaneContent =
      typeof parsed.autoPilotWriteLaneContent === "boolean"
        ? parsed.autoPilotWriteLaneContent === true
        : !hasExplicitWriteLaneState && legacyTrustedWritesEnabled;
    const autoPilotWriteLaneUiTests =
      typeof parsed.autoPilotWriteLaneUiTests === "boolean"
        ? parsed.autoPilotWriteLaneUiTests === true
        : false;
    const autoPilotWriteLaneSource =
      typeof parsed.autoPilotWriteLaneSource === "boolean"
        ? parsed.autoPilotWriteLaneSource === true
        : false;
    return {
      fileOffsets: parsed.fileOffsets ?? {},
      seenEvents: parsed.seenEvents ?? {},
      pairedDevices: parsed.pairedDevices ?? {},
      deviceLocales: parsed.deviceLocales ?? {},
      pushDeliveries: parsed.pushDeliveries ?? {},
      pushSubscriptions: parsed.pushSubscriptions ?? {},
      activePlanRequestTurns: parsed.activePlanRequestTurns ?? {},
      dismissedPlanRequests: parsed.dismissedPlanRequests ?? {},
      suppressedPlanReadyTurns: parsed.suppressedPlanReadyTurns ?? {},
      pendingPlanRequests: parsed.pendingPlanRequests ?? {},
      pendingUserInputRequests: parsed.pendingUserInputRequests ?? {},
      recentHistoryItems: parsed.recentHistoryItems ?? [],
      recentTimelineEntries: parsed.recentTimelineEntries ?? [],
      recentCodeEvents: parsed.recentCodeEvents ?? null,
      timelineImagePathAliases: parsed.timelineImagePathAliases ?? {},
      sqliteCompletionCursorId: Number(parsed.sqliteCompletionCursorId) || 0,
      sqliteCompletionSourceFile: cleanText(parsed.sqliteCompletionSourceFile ?? ""),
      sqliteMessageCursorId: Number(parsed.sqliteMessageCursorId) || 0,
      sqliteMessageSourceFile: cleanText(parsed.sqliteMessageSourceFile ?? ""),
      historyFileOffset: Number(parsed.historyFileOffset) || 0,
      historyFileSourceFile: cleanText(parsed.historyFileSourceFile ?? ""),
      pairingConsumedAt: Number(parsed.pairingConsumedAt) || 0,
      pairingConsumedCredential: cleanText(parsed.pairingConsumedCredential ?? ""),
      claudeAwayMode: parsed.claudeAwayMode === true,
      autoPilotTrustedReads: parsed.autoPilotTrustedReads === true,
      autoPilotTrustedWrites: autoPilotWriteLaneContent || autoPilotWriteLaneUiTests || autoPilotWriteLaneSource,
      autoPilotTrustedWritesShadow: false,
      autoPilotWriteLaneContent,
      autoPilotWriteLaneUiTests,
      autoPilotWriteLaneSource,
      a2aAcceptPublicTasks: parsed.a2aAcceptPublicTasks === true,
      hazbase: normalizeHazbaseState(parsed.hazbase),
    };
  } catch {
    return {
      fileOffsets: {},
      seenEvents: {},
      pairedDevices: {},
      deviceLocales: {},
      pushDeliveries: {},
      pushSubscriptions: {},
      activePlanRequestTurns: {},
      dismissedPlanRequests: {},
      suppressedPlanReadyTurns: {},
      pendingPlanRequests: {},
      pendingUserInputRequests: {},
      recentHistoryItems: [],
      recentTimelineEntries: [],
      recentCodeEvents: null,
      timelineImagePathAliases: {},
      sqliteCompletionCursorId: 0,
      sqliteCompletionSourceFile: "",
      sqliteMessageCursorId: 0,
      sqliteMessageSourceFile: "",
      historyFileOffset: 0,
      historyFileSourceFile: "",
      pairingConsumedAt: 0,
      pairingConsumedCredential: "",
      claudeAwayMode: false,
      autoPilotTrustedReads: false,
      autoPilotTrustedWrites: false,
      autoPilotTrustedWritesShadow: false,
      autoPilotWriteLaneContent: false,
      autoPilotWriteLaneUiTests: false,
      autoPilotWriteLaneSource: false,
      hazbase: normalizeHazbaseState(null),
    };
  }
}

function claudeAwayModeSentinelPath(config) {
  const dir = config?.configDir || path.join(os.homedir(), ".viveworker");
  return path.join(dir, "claude-away-mode");
}

async function syncClaudeAwayModeSentinel(config, enabled) {
  const sentinel = claudeAwayModeSentinelPath(config);
  try {
    if (enabled) {
      await fs.mkdir(path.dirname(sentinel), { recursive: true });
      await fs.writeFile(sentinel, "on\n", "utf8");
    } else {
      await fs.unlink(sentinel).catch(() => {});
    }
  } catch (error) {
    console.error(`[claude-away-mode-sentinel-error] ${error.message}`);
  }
}

async function saveState(stateFile, state) {
  // No indent. The state file is ~8 MB and humans don't read it; pretty-print
  // just costs a few extra ms of stringify and ~10% more bytes on disk. The
  // single newline at the end keeps diffs/hexdumps working on the off chance
  // someone cats the file.
  const output = JSON.stringify(state);
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, `${output}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Thread registry — persistent record of all known threads (survives restarts)
// ---------------------------------------------------------------------------

async function loadThreadRegistry(filePath) {
  const registry = new Map();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const entry of arr) {
        if (entry && entry.id) {
          registry.set(entry.id, entry);
        }
      }
    }
  } catch {
    // Missing or corrupt file — start with empty registry.
  }
  return registry;
}

async function saveThreadRegistry(filePath, registry) {
  const arr = [...registry.values()].sort((a, b) => (b.lastSeenAtMs || 0) - (a.lastSeenAtMs || 0));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(arr, null, 2) + "\n", "utf8");
}

/** Upsert a thread in the registry. Returns true if something changed. */
function registerThread(runtime, entry) {
  const existing = runtime.threadRegistry.get(entry.id);
  const merged = {
    id: entry.id,
    label: entry.label || existing?.label || "",
    tool: entry.tool || existing?.tool || "codex",
    cwd: entry.cwd || existing?.cwd || "",
    lastSeenAtMs: Math.max(entry.lastSeenAtMs || Date.now(), existing?.lastSeenAtMs || 0),
    active: entry.active !== undefined ? entry.active : (existing?.active ?? true),
  };
  const changed = !existing
    || existing.label !== merged.label
    || existing.tool !== merged.tool
    || existing.cwd !== merged.cwd
    || existing.active !== merged.active
    || existing.lastSeenAtMs !== merged.lastSeenAtMs;
  if (changed) {
    runtime.threadRegistry.set(entry.id, merged);
  }
  return changed;
}

// ---------------------------------------------------------------------------

async function loadSessionIndex(filePath) {
  const result = new Map();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    for (const line of raw.split(/\r?\n/u)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line);
        if (entry.id) {
          result.set(entry.id, entry.thread_name || entry.title || entry.id);
        }
      } catch {
        // Ignore malformed rows.
      }
    }
  } catch {
    return result;
  }
  return result;
}

function extractThreadLabelFromState(threadState) {
  if (!isPlainObject(threadState)) {
    return "";
  }
  const candidates = [
    threadState.thread_name,
    threadState.threadName,
    threadState.title,
    threadState.name,
    threadState.conversationTitle,
    threadState.threadTitle,
    threadState.label,
    threadState.summary,
    threadState.metadata?.thread_name,
    threadState.metadata?.threadName,
    threadState.metadata?.title,
    threadState.thread?.title,
    threadState.thread?.name,
  ];
  for (const candidate of candidates) {
    const normalized = truncate(cleanText(candidate || ""), 90);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function sanitizeResolvedThreadLabel(value, conversationId) {
  const normalized = truncate(cleanText(value || ""), 90);
  if (!normalized) {
    return "";
  }

  const normalizedConversationId = cleanText(conversationId || "");
  if (normalizedConversationId) {
    if (normalized === normalizedConversationId || normalized === shortId(normalizedConversationId)) {
      return "";
    }
  }

  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}$/iu.test(normalized)) {
    return "";
  }

  if (looksLikeGeneratedThreadTitle(normalized)) {
    return "";
  }

  return normalized;
}

async function listRolloutFiles(rootDir) {
  const result = [];

  async function walk(currentDir) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        result.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  result.sort();
  return result;
}

function extractRolloutMessageText(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return cleanText(
    content
      .map((entry) =>
        isPlainObject(entry) && (entry.type === "input_text" || entry.type === "output_text")
          ? normalizeTimelineMessageText(entry.text ?? "")
          : ""
      )
      .filter(Boolean)
      .join("\n")
  );
}

function extractTitleOnlyJsonTitleFromRolloutContent(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  for (const entry of content) {
    if (!isPlainObject(entry) || (entry.type !== "input_text" && entry.type !== "output_text")) {
      continue;
    }
    const title = extractTitleOnlyJsonTitle(entry.text ?? "");
    if (title) {
      return title;
    }
  }
  return "";
}

function rolloutContentHasImages(content) {
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((entry) => {
    if (!isPlainObject(entry)) {
      return false;
    }
    if (entry.type === "input_image" || entry.type === "image" || entry.type === "localImage") {
      return true;
    }
    if (entry.type !== "input_text" && entry.type !== "output_text") {
      return false;
    }
    return isInlineImagePlaceholderText(entry.text ?? "");
  });
}

function deriveRolloutThreadTitleCandidate(text) {
  const normalized = cleanText(normalizeNotificationText(text));
  if (!normalized) {
    return "";
  }

  if (
    normalized.startsWith("# AGENTS.md instructions") ||
    normalized.startsWith("AGENTS.md instructions") ||
    normalized.startsWith("<INSTRUCTIONS>") ||
    normalized.startsWith("INSTRUCTIONS") ||
    normalized.startsWith("<environment_context>") ||
    normalized.startsWith("environment_context") ||
    normalized.startsWith("<permissions instructions>") ||
    normalized.startsWith("permissions instructions") ||
    normalized.startsWith("<collaboration_mode>") ||
    normalized.startsWith("collaboration_mode") ||
    normalized.startsWith("<skills_instructions>") ||
    normalized.startsWith("skills_instructions")
  ) {
    return "";
  }

  const withoutPlanPrefix = normalized.startsWith(IMPLEMENT_PLAN_PROMPT_PREFIX)
    ? cleanText(normalized.slice(IMPLEMENT_PLAN_PROMPT_PREFIX.length))
    : normalized;
  const sentence = summarizeNotificationText(withoutPlanPrefix) || withoutPlanPrefix;
  const candidate = truncate(cleanText(sentence), 90);

  if (!candidate) {
    return "";
  }

  if (/^(?:ok|okay|yes|no|thanks|thank you|はい|了解|お願い|お願いします|進めて|続けて)$/iu.test(candidate)) {
    return "";
  }

  return candidate;
}

async function extractRolloutThreadMetadata(filePath) {
  const metadata = {
    filePath,
    threadId: extractThreadIdFromRolloutPath(filePath),
    forkedFromId: "",
    cwd: "",
    titleCandidate: "",
  };

  let stream = null;
  let rl = null;
  try {
    stream = createReadStream(filePath, {
      encoding: "utf8",
      highWaterMark: 64 * 1024,
    });
    rl = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type === "session_meta" && isPlainObject(entry.payload)) {
        if (!metadata.threadId) {
          metadata.threadId = cleanText(entry.payload.id || metadata.threadId);
        }
        if (!metadata.forkedFromId) {
          metadata.forkedFromId = cleanText(entry.payload.forked_from_id || entry.payload.forkedFromId || "");
        }
        if (!metadata.cwd) {
          metadata.cwd = cleanText(entry.payload.cwd || "");
        }
        if (metadata.titleCandidate) {
          break;
        }
        continue;
      }

      if (!metadata.titleCandidate && entry.payload?.type === "message" && entry.payload?.role === "user") {
        const titleCandidate = deriveRolloutThreadTitleCandidate(extractRolloutMessageText(entry.payload.content));
        if (titleCandidate) {
          metadata.titleCandidate = titleCandidate;
          if (metadata.threadId) {
            break;
          }
        }
      } else if (!metadata.titleCandidate && entry.payload?.type === "message" && entry.payload?.role === "assistant") {
        const titleCandidate = truncate(cleanText(extractTitleOnlyJsonTitleFromRolloutContent(entry.payload.content)), 90);
        if (titleCandidate) {
          metadata.titleCandidate = titleCandidate;
          if (metadata.threadId) {
            break;
          }
        }
      } else if (!metadata.titleCandidate && entry.type === "event_msg" && entry.payload?.type === "task_complete") {
        const titleCandidate = truncate(cleanText(extractTitleOnlyJsonTitle(entry.payload.last_agent_message ?? "")), 90);
        if (titleCandidate) {
          metadata.titleCandidate = titleCandidate;
          if (metadata.threadId) {
            break;
          }
        }
      }
    }
  } catch {
    return null;
  } finally {
    rl?.close();
    stream?.destroy();
  }

  return metadata.threadId ? metadata : null;
}

async function buildRolloutThreadLabelIndex(knownFiles, sessionIndex) {
  const entries = new Map();
  for (const filePath of Array.isArray(knownFiles) ? knownFiles : []) {
    const metadata = await extractRolloutThreadMetadata(filePath);
    if (metadata?.threadId) {
      entries.set(metadata.threadId, metadata);
    }
  }

  const resolved = new Map();
  const resolving = new Set();

  function resolve(threadId) {
    const normalizedThreadId = cleanText(threadId || "");
    if (!normalizedThreadId) {
      return "";
    }
    if (resolved.has(normalizedThreadId)) {
      return resolved.get(normalizedThreadId) || "";
    }
    if (sessionIndex.has(normalizedThreadId)) {
      const label = truncate(cleanText(sessionIndex.get(normalizedThreadId) || ""), 90);
      if (label) {
        resolved.set(normalizedThreadId, label);
        return label;
      }
    }
    if (resolving.has(normalizedThreadId)) {
      return "";
    }

    resolving.add(normalizedThreadId);
    const metadata = entries.get(normalizedThreadId);
    const titleCandidate = metadata?.titleCandidate || "";
    const parentLabel = metadata?.forkedFromId ? resolve(metadata.forkedFromId) : "";
    let label = titleCandidate;

    // Forked threads often inherit the parent thread title before Codex writes
    // a fresh session index row. Prefer the parent title when the prompt-derived
    // fallback is very long or still looks like a question.
    if (titleCandidate && parentLabel && (titleCandidate.length > 48 || /[?？]$/u.test(titleCandidate))) {
      label = parentLabel;
    } else if (!label) {
      label = parentLabel;
    }
    if (!label && metadata?.cwd) {
      label = truncate(cleanText(path.basename(metadata.cwd)), 90);
    }
    if (!label && metadata?.filePath) {
      label = truncate(cleanText(path.basename(metadata.filePath, ".jsonl")), 90);
    }

    resolving.delete(normalizedThreadId);
    if (label) {
      resolved.set(normalizedThreadId, label);
    }
    return label;
  }

  for (const threadId of entries.keys()) {
    resolve(threadId);
  }

  return resolved;
}

async function findLatestCodexLogsDbFile(codexHome) {
  let entries;
  try {
    entries = await fs.readdir(codexHome, { withFileTypes: true });
  } catch {
    return "";
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!/^logs(?:_\d+)?\.sqlite$/u.test(entry.name)) {
      continue;
    }
    const fullPath = path.join(codexHome, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      candidates.push({ filePath: fullPath, mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore entries that disappear while scanning.
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.filePath ?? "";
}

function extractThreadIdFromRolloutPath(filePath) {
  const match = path
    .basename(filePath)
    .match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu);
  return match?.[1] ?? null;
}

function getThreadName(sessionIndex, rolloutThreadLabels, threadId, cwd, filePath) {
  if (threadId && sessionIndex.has(threadId)) {
    return sessionIndex.get(threadId);
  }
  if (threadId && rolloutThreadLabels?.has(threadId)) {
    return rolloutThreadLabels.get(threadId);
  }
  if (cwd) {
    return path.basename(cwd);
  }
  return path.basename(filePath, ".jsonl");
}

function describeContext({ threadName }) {
  const threadLabel = truncate(cleanText(threadName || ""), 90) || t(DEFAULT_LOCALE, "server.fallback.codexTask", { provider: providerDisplayName(DEFAULT_LOCALE, "codex") });
  return { threadLabel };
}

function extractConversationIdFromStableId(stableId) {
  return String(stableId || "").match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu)?.[1] ?? "";
}

function refreshResolvedThreadLabels({ config, runtime, state }) {
  let changed = false;

  for (const planRequest of runtime.planRequestsByTurnKey.values()) {
    const threadLabel = getNativeThreadLabel({
      runtime,
      conversationId: planRequest.conversationId,
      cwd: planRequest.threadState?.cwd ?? "",
    });
    const nextTitle = formatTitle(config.planTitle, threadLabel);
    if (threadLabel !== planRequest.threadLabel || nextTitle !== planRequest.title) {
      planRequest.threadLabel = threadLabel;
      planRequest.title = nextTitle;
      changed = storePendingPlanRequest(state, planRequest) || changed;
    }
  }

  for (const userInputRequest of runtime.userInputRequestsByToken.values()) {
    const threadLabel = getNativeThreadLabel({
      runtime,
      conversationId: userInputRequest.conversationId,
      cwd: "",
    });
    const nextTitle = formatTitle(
      userInputRequest.supported ? t(config.defaultLocale, "server.title.choice") : t(config.defaultLocale, "server.title.choiceReadOnly"),
      threadLabel
    );
    if (threadLabel !== userInputRequest.threadLabel || nextTitle !== userInputRequest.title) {
      userInputRequest.threadLabel = threadLabel;
      userInputRequest.title = nextTitle;
      changed = storePendingUserInputRequest(state, userInputRequest) || changed;
    }
  }

  const nextHistoryItems = normalizeHistoryItems(
    runtime.recentHistoryItems.map((item) => {
      // Moltbook / A2A / thread-share entries carry their own titles — skip relabel.
      const itemKind = item.kind || "";
      if (itemKind === "moltbook_reply" || itemKind === "moltbook_draft" || itemKind === "a2a_task" || itemKind === "a2a_task_result" || itemKind === "thread_share") {
        return item;
      }
      const conversationId = extractConversationIdFromStableId(item.stableId);
      if (!conversationId) {
        return item;
      }
      const claudeTitle = runtime.claudeSessionTitles.get(conversationId) || "";
      const nativeThreadLabel = claudeTitle || getNativeThreadLabel({
        runtime,
        conversationId,
        cwd: "",
      });
      const threadLabel = preferTitleOnlyJsonThreadLabel(nativeThreadLabel, conversationId, item.messageText, item.summary);
      const title = formatTitle(kindTitle(config.defaultLocale, item.kind), threadLabel);
      if (threadLabel === item.threadLabel && title === item.title) {
        return item;
      }
      changed = true;
      return {
        ...item,
        threadLabel,
        title,
      };
    }),
    config.maxHistoryItems
  );

  if (
    JSON.stringify(nextHistoryItems.map((item) => [item.stableId, item.title, item.threadLabel])) !==
    JSON.stringify(runtime.recentHistoryItems.map((item) => [item.stableId, item.title, item.threadLabel]))
  ) {
    runtime.recentHistoryItems = nextHistoryItems;
    state.recentHistoryItems = nextHistoryItems;
    changed = true;
  }

  const nextTimelineEntries = normalizeTimelineEntries(
    runtime.recentTimelineEntries.map((entry) => {
      // Moltbook / A2A / thread-share entries carry their own titles.
      // Skip the native-thread relabel pass so we don't overwrite them.
      const entryKind = entry.kind || "";
      if (entryKind === "moltbook_reply" || entryKind === "moltbook_draft" || entryKind === "a2a_task" || entryKind === "a2a_task_result" || entryKind === "thread_share") {
        return entry;
      }
      const threadId = cleanText(entry.threadId || "");
      if (!threadId) {
        return entry;
      }
      const claudeTitle = runtime.claudeSessionTitles.get(threadId) || "";
      const nativeThreadLabel = claudeTitle || getNativeThreadLabel({
        runtime,
        conversationId: threadId,
        cwd: cleanText(entry.cwd || ""),
      });
      const threadLabel = preferTitleOnlyJsonThreadLabel(nativeThreadLabel, threadId, entry.messageText, entry.summary);
      const title = threadLabel || kindTitle(config.defaultLocale, entry.kind);
      if (threadLabel === entry.threadLabel && title === entry.title) {
        return entry;
      }
      changed = true;
      return {
        ...entry,
        threadLabel,
        title,
      };
    }),
    config.maxTimelineEntries
  );

  if (
    JSON.stringify(nextTimelineEntries.map((entry) => [entry.stableId, entry.title, entry.threadLabel])) !==
    JSON.stringify(runtime.recentTimelineEntries.map((entry) => [entry.stableId, entry.title, entry.threadLabel]))
  ) {
    runtime.recentTimelineEntries = nextTimelineEntries;
    state.recentTimelineEntries = nextTimelineEntries;
    changed = true;
  }

  const nextCodeEvents = normalizeCodeEvents(
    runtime.recentCodeEvents.map((entry) => {
      const threadId = cleanText(entry.threadId || "");
      if (!threadId) {
        return entry;
      }
      const claudeTitle = runtime.claudeSessionTitles.get(threadId) || "";
      const nativeThreadLabel = claudeTitle || getNativeThreadLabel({
        runtime,
        conversationId: threadId,
        cwd: cleanText(entry.cwd || ""),
      });
      const threadLabel = preferTitleOnlyJsonThreadLabel(nativeThreadLabel, threadId, entry.messageText, entry.summary);
      const title = threadLabel || kindTitle(config.defaultLocale, entry.kind);
      if (threadLabel === entry.threadLabel && title === entry.title) {
        return entry;
      }
      changed = true;
      return {
        ...entry,
        threadLabel,
        title,
      };
    }),
    config.maxCodeEvents
  );

  if (
    JSON.stringify(nextCodeEvents.map((entry) => [entry.stableId, entry.title, entry.threadLabel])) !==
    JSON.stringify(runtime.recentCodeEvents.map((entry) => [entry.stableId, entry.title, entry.threadLabel]))
  ) {
    runtime.recentCodeEvents = nextCodeEvents;
    state.recentCodeEvents = nextCodeEvents;
    invalidateDiffThreadGroupsCache();
    changed = true;
  }

  return changed;
}

function formatMessage(lines, maxChars) {
  return truncate(
    lines
      .map((line) => cleanText(line))
      .filter(Boolean)
      .join("\n"),
    maxChars
  );
}

function formatCompletionDetailText(value, locale = config?.defaultLocale || DEFAULT_LOCALE) {
  const normalized = normalizeLongText(value);
  return normalized || t(locale, "server.message.taskFinished");
}

function formatPlanDetailText(value, locale = config?.defaultLocale || DEFAULT_LOCALE) {
  const normalized = normalizeLongText(value);
  return normalized || t(locale, "server.message.planReady");
}

function summarizeNotificationText(value) {
  const normalized = cleanText(normalizeNotificationText(value));
  if (!normalized) {
    return "";
  }

  const sentence = normalized.match(/^.+?[。.!?](?:\s|$)/u)?.[0]?.trim();
  if (sentence) {
    return sentence;
  }

  return normalized;
}

function normalizeLongText(value) {
  const titleOnlyJsonTitle = extractTitleOnlyJsonTitle(value);
  if (titleOnlyJsonTitle) {
    return titleOnlyJsonTitle;
  }
  return String(stripEnvironmentContextBlocks(stripMarkdownLinks(value)) || "")
    .replace(/\r\n/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function replaceTurnAbortedMarkup(value, locale = DEFAULT_LOCALE) {
  const raw = String(value || "");
  if (!/<turn_aborted>/iu.test(raw)) {
    return raw;
  }
  return raw.replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/giu, t(locale, "server.message.turnAborted"));
}

function isTurnAbortedDisplayMessage(value) {
  const normalized = normalizeLongText(String(value || ""));
  const englishMessage = normalizeLongText(t(DEFAULT_LOCALE, "server.message.turnAborted"));
  const japaneseMessage = normalizeLongText(t("ja", "server.message.turnAborted"));
  return /<turn_aborted>/iu.test(String(value || "")) || normalized === englishMessage || normalized === japaneseMessage;
}

function interruptedDetailNotice(value, locale = DEFAULT_LOCALE) {
  return isTurnAbortedDisplayMessage(value) ? t(locale, "detail.turnAbortedNotice") : "";
}

function stripInlineImagePlaceholderMarkup(value) {
  return String(value || "")
    .replace(/<image\b[^>]*>/giu, "")
    .replace(/<\/image>/giu, "");
}

function isInlineImagePlaceholderText(value) {
  return cleanText(stripInlineImagePlaceholderMarkup(value)) === "" && /<\/?image\b/iu.test(String(value || ""));
}

function normalizeTimelineMessageText(value, locale = DEFAULT_LOCALE) {
  return normalizeLongText(replaceTurnAbortedMarkup(stripInlineImagePlaceholderMarkup(value), locale));
}

function normalizeTimelineImagePaths(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => cleanText(entry || ""))
    .filter(Boolean);
}

function normalizeNotificationText(value, locale = DEFAULT_LOCALE) {
  return normalizeLongText(replaceTurnAbortedMarkup(stripNotificationMarkup(value), locale))
    .replace(/\n{2,}/gu, "\n")
    .trim();
}

function notificationNeedsDetail(value, thresholdChars) {
  return cleanText(value).length > thresholdChars;
}

function formatNotificationBody(value, thresholdChars) {
  const normalized = normalizeNotificationText(value);
  if (!notificationNeedsDetail(normalized, thresholdChars)) {
    return normalized;
  }
  return truncate(cleanText(normalized), thresholdChars);
}

function formatTitle(baseTitle, threadLabel) {
  if (!threadLabel) {
    return baseTitle;
  }
  return truncate(`${baseTitle} | ${threadLabel}`, 90);
}

function trimSeenEvents(seenEvents, maxEntries) {
  const entries = Object.entries(seenEvents);
  if (entries.length <= maxEntries) {
    return;
  }

  entries.sort((left, right) => right[1] - left[1]);
  for (const [key] of entries.slice(maxEntries)) {
    delete seenEvents[key];
  }
}

function trimMap(map, maxEntries) {
  while (map.size > maxEntries) {
    const firstKey = map.keys().next().value;
    if (firstKey == null) {
      break;
    }
    map.delete(firstKey);
  }
}

function safeJsonParse(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function extractTitleOnlyJsonTitle(value) {
  const rawText = String(value ?? "").trim();
  if (!rawText) {
    return "";
  }
  const parsed = safeJsonParse(rawText);
  if (!isPlainObject(parsed) || typeof parsed.title !== "string") {
    return "";
  }
  const meaningfulExtraKeys = Object.entries(parsed).filter(([key, entryValue]) => {
    if (key === "title") {
      return false;
    }
    if (entryValue == null) {
      return false;
    }
    if (typeof entryValue === "string" && cleanText(entryValue) === "") {
      return false;
    }
    if (Array.isArray(entryValue) && entryValue.length === 0) {
      return false;
    }
    if (isPlainObject(entryValue) && Object.keys(entryValue).length === 0) {
      return false;
    }
    return true;
  });
  if (meaningfulExtraKeys.length > 0) {
    return "";
  }
  return cleanText(parsed.title || "");
}

function preferTitleOnlyJsonThreadLabel(rawThreadLabel, conversationId, ...candidates) {
    const preferredThreadLabel = sanitizeResolvedThreadLabel(rawThreadLabel, conversationId);
  if (preferredThreadLabel && !isFallbackConversationLabel(preferredThreadLabel, conversationId)) {
    return preferredThreadLabel;
  }
  for (const candidate of candidates) {
    const titleOnlyJsonTitle = truncate(cleanText(extractTitleOnlyJsonTitle(candidate)), 90);
    if (titleOnlyJsonTitle) {
      return titleOnlyJsonTitle;
    }
    const derivedSdkCliLabel = deriveClaudeSdkCliThreadLabel(candidate, conversationId);
    if (derivedSdkCliLabel) {
      return derivedSdkCliLabel;
    }
  }
  return cleanText(preferredThreadLabel || rawThreadLabel || "");
}

function stripMarkdownLinks(value) {
  return String(value || "").replace(/\[([^\]]+)\]\(([^)]+)\)/gu, "$1");
}

function stripEnvironmentContextBlocks(value) {
  return String(value || "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>\s*/giu, "")
    .replace(/^\s*<environment_context>[\s\S]*$/giu, "")
    .replace(/^\s*environment_context\s*$/gimu, "");
}

function stripNotificationMarkup(value) {
  return String(value || "")
    .replace(/^\s*<\/?proposed_plan>\s*$/gimu, "")
    .replace(/<\/?proposed_plan>/giu, "")
    .replace(/<image\b[^>]*>/giu, "")
    .replace(/<\/image>/giu, "")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/gu, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s{0,3}>\s?/gmu, "")
    .replace(/^\s*[-*+]\s+\[(?: |x|X)\]\s+/gmu, "")
    .replace(/^\s*(?:[-*+])\s+/gmu, "")
    .replace(/^\s*\d+[.)]\s+/gmu, "")
    .replace(/```+[\s\S]*?```/gu, (match) =>
      match
        .replace(/```+[^\n]*\n?/gu, "")
        .replace(/```+/gu, "")
    )
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/(\*\*|__)(.*?)\1/gu, "$2")
    .replace(/(^|[^\w])(\*|_)([^*_]+)\2(?=[^\w]|$)/gu, "$1$3")
    .replace(/[ \t]+\n/gu, "\n");
}

function singleLine(value) {
  return cleanText(value);
}

function truncate(value, maxChars) {
  if (!value || value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function compactPath(value) {
  if (!value) {
    return "";
  }

  const home = os.homedir();
  if (value === home) {
    return "~";
  }
  if (value.startsWith(`${home}${path.sep}`)) {
    return `~${path.sep}${path.relative(home, value)}`;
  }
  return value;
}

function shortId(value) {
  const text = cleanText(value || "");
  if (!text) {
    return "";
  }
  return text.length > 8 ? text.slice(0, 8) : text;
}

function isFallbackTimelineTitle(rawTitle, kind, threadId) {
  const normalizedTitle = cleanText(rawTitle || "");
  const normalizedKind = cleanText(kind || "");
  const normalizedThreadId = cleanText(threadId || "");
  if (!normalizedTitle) {
    return true;
  }
  if (normalizedThreadId && normalizedTitle === shortId(normalizedThreadId)) {
    return true;
  }
  if (normalizedTitle === kindTitle(DEFAULT_LOCALE, normalizedKind)) {
    return true;
  }
  if (normalizedThreadId && normalizedTitle === formatTitle(kindTitle(DEFAULT_LOCALE, normalizedKind), shortId(normalizedThreadId))) {
    return true;
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvePath(value) {
  if (!value) {
    return value;
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function truthy(value) {
  return /^(1|true|yes|on)$/iu.test(String(value || "").trim());
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return fallback;
  }
  return truthy(raw);
}

function csvEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const values = raw
    .split(",")
    .map((value) => cleanText(value))
    .filter(Boolean);
  return values.length > 0 ? values : fallback;
}

function ntfyPriority(name, fallback) {
  const raw = cleanText(process.env[name] || "");
  if (!raw) {
    return fallback;
  }
  return raw;
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/u, "");
}

function buildTopicUrl(baseUrl, topic) {
  return `${stripTrailingSlash(baseUrl)}/${encodeURIComponent(topic)}`;
}

function buildAuthHeader() {
  const accessToken = cleanText(process.env.NTFY_ACCESS_TOKEN || "");
  if (accessToken) {
    return `Bearer ${accessToken}`;
  }

  const username = process.env.NTFY_USERNAME || "";
  const password = process.env.NTFY_PASSWORD || "";
  if (!username && !password) {
    return "";
  }

  const basic = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return `Basic ${basic}`;
}

function cloneJson(value) {
  if (value == null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

await main();

async function main() {
  if (!config.dryRun && config.enableNtfy) {
    const missing = ["NTFY_BASE_URL", "NTFY_TOPIC"].filter((key) => !process.env[key]);
    if (missing.length > 0) {
      console.error(`Missing required env vars: ${missing.join(", ")}`);
      process.exit(1);
    }
  }

  runtime.sessionIndex = await loadSessionIndex(config.sessionIndexFile);
  runtime.lastSessionIndexLoadAt = Date.now();
  runtime.knownFiles = await listRolloutFiles(config.sessionsDir);
  runtime.logsDbFile = config.codexLogsDbFile || (await findLatestCodexLogsDbFile(config.codexHome)) || "";
  runtime.lastDirectoryScanAt = Date.now();
  runtime.rolloutThreadLabels = await buildRolloutThreadLabelIndex(runtime.knownFiles, runtime.sessionIndex);

  console.log(
    [
      "viveworker bridge",
      `dryRun=${config.dryRun}`,
      `once=${config.once}`,
      `codexHome=${config.codexHome}`,
      `webUiEnabled=${config.webUiEnabled}`,
      `webPushEnabled=${config.webPushEnabled}`,
      `ntfyBaseUrl=${config.ntfyBaseUrl}`,
      `ntfyPublishBaseUrl=${config.ntfyPublishBaseUrl}`,
      `ntfyTopic=${config.ntfyTopic}`,
      `nativeApprovals=${config.nativeApprovals}`,
      `notifyPlans=${config.notifyPlans}`,
      `nativeApprovalServer=${config.nativeApprovalPublicBaseUrl}`,
      `pollMs=${config.pollIntervalMs}`,
      `replaySeconds=${config.replaySeconds}`,
    ].join(" | ")
  );

  let approvalServer = null;

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    if (config.webPushEnabled) {
      webPush.setVapidDetails(
        config.webPushSubject,
        config.webPushVapidPublicKey,
        config.webPushVapidPrivateKey
      );
    }

    if (
      normalizedHistoryStateChanged ||
      normalizedTimelineStateChanged ||
      migratedPairedDevicesStateChanged ||
      restoredPendingPlanStateChanged ||
      restoredTimelineImagePathsStateChanged ||
      backfilledAmbientSuggestionsStateChanged ||
      migratedRecentCodeEventsStateChanged ||
      restoredPendingUserInputStateChanged ||
      backfilledMoltbookInboxChanged ||
      recoveredMissingProviderStateChanged ||
      refreshResolvedThreadLabels({ config, runtime, state })
    ) {
      await saveState(config.stateFile, state);
    }

    if (
      !config.dryRun &&
      (
        config.webUiEnabled ||
        config.notifyCompletions ||
        config.notifyPlans ||
        (config.notifyApprovals && config.nativeApprovals)
      )
    ) {
      approvalServer = createNativeApprovalServer({ config, runtime, state });
      await startHttpServer(approvalServer, config.nativeApprovalListenHost, config.nativeApprovalListenPort);
      console.log(`Native approval server: ${config.nativeApprovalPublicBaseUrl}`);

      if (config.nativeApprovals && (config.notifyApprovals || config.webUiEnabled)) {
        runtime.ipcClient = new NativeIpcClient({
          config,
          runtime,
          onThreadStateChanged: async ({ conversationId, previousRequests, nextRequests, sourceClientId }) => {
            await syncNativeApprovals({
          config,
          runtime,
          state,
          conversationId,
          previousRequests,
          nextRequests,
              sourceClientId,
            });
            await syncPlanImplementationRequests({
              config,
              runtime,
              state,
              conversationId,
              previousRequests,
              nextRequests,
              sourceClientId,
            });
            await syncPlanUserInputRequests({
              config,
              runtime,
              state,
              conversationId,
              nextRequests,
              sourceClientId,
            });
            await syncGenericUserInputRequests({
              config,
              runtime,
              state,
              conversationId,
              previousRequests,
              nextRequests,
              sourceClientId,
            });
          },
          onUserInputRequested: async ({ conversationId, nextRequests, sourceClientId }) => {
            await syncPlanUserInputRequests({
              config,
              runtime,
              state,
              conversationId,
              nextRequests,
              sourceClientId,
            });
            await syncGenericUserInputRequests({
              config,
              runtime,
              state,
              conversationId,
              previousRequests: [],
              nextRequests,
              sourceClientId,
            });
          },
        });
        runtime.ipcClient.start();
      }
    }

    // --- A2A Relay ---
    if (config.a2aRelayUrl && config.a2aRelayUserId) {
      config.a2aAcceptPublicTasks = state.a2aAcceptPublicTasks === true;
      const regResult = await registerWithRelay({ config, buildAgentCard });
      if (regResult.ok) {
        startRelayPolling({
          config,
          runtime,
          state,
          helpers: { recordTimelineEntry, deliverWebPushItem, saveState, historyToken, cleanText },
        });
      } else {
        console.error(`[a2a-relay] Registration failed: ${regResult.error}`);
      }
    }

    let lastA2aEnvCheckAt = 0;
    const A2A_ENV_CHECK_INTERVAL_MS = 30_000; // check every 30 seconds

    while (!runtime.stopping) {
      try {
        const dirty = await scanOnce({ config, runtime, state });
        if (dirty) {
          // Fire-and-forget via the debouncer rather than awaiting — the
          // ~8 MB state file used to block the scan loop for ~50-100 ms on
          // every dirty iteration, which directly delays the next rollout /
          // history.jsonl read and therefore how quickly new user_message
          // entries reach the phone. runtime/state.recentTimelineEntries are
          // already updated synchronously inside recordTimelineEntry, so the
          // /api/timeline response sees fresh data the moment the client
          // next polls, regardless of when the disk write lands. Pending
          // writes are drained in the `finally` block below on SIGINT/SIGTERM.
          scheduleSaveState(config, state);
        }
      } catch (error) {
        console.error(`[scan-error] ${error.message}`);
      }

      // Hot-reload: detect a2a.env changes (new config or updated card)
      const now = Date.now();
      if (now - lastA2aEnvCheckAt > A2A_ENV_CHECK_INTERVAL_MS) {
        lastA2aEnvCheckAt = now;
        try {
          loadEnvFile(path.join(os.homedir(), ".viveworker", "a2a.env"));
          const newRelayUrl = cleanText(process.env.A2A_RELAY_URL || "");
          const newRelayUserId = cleanText(process.env.A2A_RELAY_USER_ID || "");
          const newRelayRegisterSecret = cleanText(process.env.A2A_RELAY_REGISTER_SECRET || "");
          const newDescription = cleanText(process.env.A2A_DESCRIPTION || "");
          const newSkills = cleanText(process.env.A2A_SKILLS || "");
          const newAvatar = cleanText(process.env.A2A_AVATAR || "");

          if (newRelayUrl && newRelayUserId) {
            // Check if this is a first-time connect or a card update
            const isNew = !config.a2aRelayUrl;
            const cardChanged = config.a2aDescription !== newDescription || config.a2aSkills !== newSkills || config.a2aAvatar !== newAvatar;

            if (isNew || cardChanged) {
              config.a2aRelayUrl = newRelayUrl;
              config.a2aRelayUserId = newRelayUserId;
              config.a2aRelayRegisterSecret = newRelayRegisterSecret;
              config.a2aApiKey = cleanText(process.env.A2A_API_KEY || config.a2aApiKey || "");
              config.a2aDescription = newDescription;
              config.a2aSkills = newSkills;
              config.a2aAvatar = newAvatar;

              if (isNew) {
                console.log(`[a2a-relay] Detected new relay config, registering...`);
              } else {
                console.log(`[a2a-relay] Agent Card changed, re-registering...`);
              }

              const regResult = await registerWithRelay({ config, buildAgentCard });
              if (regResult.ok) {
                if (isNew) {
                  startRelayPolling({
                    config,
                    runtime,
                    state,
                    helpers: { recordTimelineEntry, deliverWebPushItem, saveState, historyToken, cleanText },
                  });
                }
              } else {
                console.error(`[a2a-relay] Registration failed: ${regResult.error}`);
              }
            }
          }
        } catch (error) {
          // ignore — env file may not exist yet
        }
      }

      if (config.once) {
        break;
      }

      await sleep(config.pollIntervalMs);
    }
  } finally {
    runtime.stopping = true;

    stopRelayPolling();

    if (runtime.ipcClient) {
      runtime.ipcClient.stop();
    }

    if (approvalServer) {
      await stopHttpServer(approvalServer);
    }

    // Drain any state mutations that were queued via scheduleSaveState but
    // not yet written to disk — otherwise SIGINT/SIGTERM mid-debounce would
    // silently drop the last ~500 ms of settings/notification changes.
    await flushPendingStateWrite(config, state);
  }
}
