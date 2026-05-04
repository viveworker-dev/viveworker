import { DEFAULT_LOCALE, SUPPORTED_LOCALES, localeDisplayName, normalizeLocale, resolveLocalePreference, t } from "./i18n.js";
import { ensureIdentityKeypair, bytesToHex } from "./remote-pairing/keys.js";
import {
  loadPairingState as loadRemotePairingState,
  savePairingState as saveRemotePairingState,
  clearPairingState as clearRemotePairingState,
} from "./remote-pairing/pairing-state.js";
const APP_BUILD_ID = "__VIVEWORKER_APP_BUILD_ID__";
const { getRoutingTelemetry, routedFetch } = await import(`./remote-pairing/api-router.js?v=${encodeURIComponent(APP_BUILD_ID)}`);

const DESKTOP_BREAKPOINT = 980;
const INSTALL_BANNER_DISMISS_KEY = "viveworker-install-banner-dismissed-v2";
const PUSH_BANNER_DISMISS_KEY = "viveworker-push-banner-dismissed-v1";
const INITIAL_DETECTED_LOCALE = detectBrowserLocale();
const TIMELINE_MESSAGE_KINDS = new Set(["user_message", "assistant_commentary", "assistant_final"]);
const TIMELINE_OPERATIONAL_KINDS = new Set(["approval", "plan", "plan_ready", "choice"]);
const EXTERNAL_TARGET_TABS = new Set(["inbox", "timeline", "diff"]);
const EXTERNAL_TARGET_INBOX_SUBTABS = new Set(["pending", "completed"]);
const THREAD_FILTER_INTERACTION_DEFER_MS = 8000;
const SCROLLABLE_CONTENT_INTERACTION_DEFER_MS = 8000;
const MAX_COMPLETION_REPLY_IMAGE_COUNT = 4;
const NOTIFICATION_INTENT_CACHE = "viveworker-notification-intent-v1";
const NOTIFICATION_INTENT_PATH = "/__viveworker_notification_intent__";
const MAX_TIMELINE_IMAGE_OBJECT_URLS = 80;
const REMOTE_PAIRING_STATE_STORAGE_KEY = "viveworker.remote-pairing.state";
const REMOTE_PAIRING_STATE_SCHEMA_VERSION = 2;
const REMOTE_PAIRING_STATE_LEGACY_SCHEMA_VERSION = 1;
const BOOT_SPLASH_SLOW_HINT_MS = 10000;
const BOOT_SPLASH_REMOTE_SWITCHING_MIN_MS = 650;
const BOOTSTRAP_REMOTE_TIMEOUT_MS = 12_000;
const REMOTE_PAIRING_TOKEN_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const BOOT_TRACE_MAX_EVENTS = 90;
const BOOT_TRACE_MAX_VALUE_LENGTH = 120;
const BOOT_SPLASH_STAGE = Object.freeze({
  initial: -1,
  checking: 0,
  switching: 1,
  establishing: 2,
  loading: 3,
});
const DETAIL_FETCH_TIMEOUT_MS = 12_000;
const DETAIL_REFRESH_FALLBACK_TIMEOUT_MS = 2_500;
const DETAIL_STICKY_LAN_PROBE_TIMEOUT_MS = 350;
const COMPLETION_REPLY_SEND_TIMEOUT_MS = 22_000;
const COMPLETION_REPLY_OPTIMISTIC_SENT_MS = 1_600;
const TIMELINE_REFRESH_TIMEOUT_MS = 8_000;
const TIMELINE_POLL_TIMEOUT_MS = 4_500;
const FAST_POLL_STEP_TIMEOUT_MS = 4_500;
const TIMELINE_STICKY_LAN_PROBE_TIMEOUT_MS = 350;
const CLIENT_EVENT_REPORT_TIMEOUT_MS = 1_800;
const TIMELINE_LIVE_REFRESH_TIMEOUT_MS = 2_000;
const TIMELINE_LIVE_RETRY_MS = 5_000;
const timelineImageObjectUrlCache = new Map();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function runFastPollStep(label, fn, timeoutMs = FAST_POLL_STEP_TIMEOUT_MS) {
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      wait(timeoutMs).then(() => {
        const error = new Error(`${label}-poll-timeout`);
        error.code = "poll-timeout";
        throw error;
      }),
    ]);
    return { label, ok: true };
  } catch (error) {
    console.warn(`[poll:${label}]`, error?.message || error);
    return { label, ok: false };
  }
}

const state = {
  session: null,
  inbox: null,
  // Flips to true after the first /api/inbox/diff response resolves
  // (success OR failure). Until then the Code/diff tab shows skeleton
  // shimmer cards instead of the "no entries" empty state, because the
  // initial diff scan spawns git subprocesses per tracked repo and can
  // take 1–3 seconds — the empty state was misleading during that window.
  inboxDiffLoaded: false,
  timeline: null,
  devices: [],
  currentTab: "inbox",
  currentItem: null,
  currentDetail: null,
  currentDetailLoading: false,
  detailLoadingItem: null,
  detailOpen: false,
  inboxSubtab: "pending",
  timelineThreadFilter: "all",
  timelineKindFilter: "all",
  providerFilter: "all",
  timelineKindFilterOpen: false,
  diffThreadFilter: "all",
  completedThreadFilter: "all",
  settingsSubpage: "",
  settingsScrollState: null,
  pendingSettingsSubpageScrollReset: false,
  pendingSettingsScrollRestore: false,
  launchItemIntent: null,
  detailOverride: null,
  pendingDetailScrollReset: false,
  listScrollState: null,
  pendingListScrollRestore: false,
  threadFilterInteractionUntilMs: 0,
  scrollableContentInteractionUntilMs: 0,
  diffThreadExpandedFiles: {},
  detailDiffExpanded: {},
  choiceLocalDrafts: {},
  completionReplyDrafts: {},
  completionReplySheetToken: "",
  pendingActionUrls: new Set(),
  pairError: "",
  pairNotice: "",
  pushStatus: null,
  moltbookScoutStatus: null,
  moltbookRecentTitlesExpanded: 0,
  a2aRelayStatus: null,
  a2aShareStatus: null,
  a2aShareRecentExpanded: 0,
  // Remote-pairing relay snapshot — { enabled, relayUrl, configuredRelayUrl,
  // identityFingerprint, sessions: [...], pairings: [...] } | null.
  // Populated by fetchRemotePairingStatus() on settings page open and after
  // toggle/revoke actions. Null until first fetch completes.
  remotePairingStatus: null,
  // Notice / error flashes for the remote-pairing settings page (consumed
  // and cleared after a single render, mirroring `pushNotice` / `pushError`
  // from the push UI).
  remotePairingNotice: "",
  remotePairingError: "",
  // Pending action key for in-flight toggle / revoke / relay-url save —
  // used to disable buttons while the round-trip is in progress so a fast
  // double-click doesn't fire two POSTs.
  remotePairingPending: "",
  remotePairingDetailsOpen: false,
  hazbaseStatus: null,
  hazbaseNotice: "",
  hazbaseError: "",
  // Session-only flag: once the Sepolia wallet is ready, the mainnet step
  // is hidden behind a subtle opt-in link (most beta users won't activate
  // it). Flipping this reveals the full mainnet step card for the rest of
  // the session. Not persisted — reopening Wallet next visit starts hidden
  // again, which is the desired default for the closed beta.
  hazbaseMainnetOptIn: false,
  // Sign-in OTP flow is a two-step send→verify dance. Showing both
  // buttons side-by-side confused users; they clicked "Verify" before
  // ever requesting a code. We gate the verify button behind a
  // successful send by tracking that a code was just issued in this
  // session (plus the email it was sent to, so verify doesn't re-prompt).
  // Both reset on successful verify (or on page reload — losing the flag
  // just means the user re-clicks "send", which is idempotent on the
  // server side). Email + code are also mirrored here so re-renders
  // triggered by polls/notices don't wipe what the user was typing —
  // the <input value="..."> attributes read these back.
  hazbaseOtpRequested: false,
  hazbaseOtpEmail: "",
  hazbaseOtpCode: "",
  // Wallet logout is reversible in principle (same account + same passkey
  // re-derives the same smart account address), but it still wipes the
  // current session + any in-flight approvals and forces an OTP round-trip
  // to recover — cheap to gate behind an explicit confirm. Session-only
  // flag; flipped by the signOut button and cleared on confirm/cancel.
  hazbaseLogoutConfirmOpen: false,
  a2aTaskExecutorPick: "codex",
  pushNotice: "",
  pushError: "",
  ambientSuggestionCopyState: null,
  deviceNotice: "",
  deviceError: "",
  imageViewer: null,
  serviceWorkerRegistration: null,
  installGuideOpen: false,
  logoutConfirmOpen: false,
  installBannerDismissed: readInstallBannerDismissed(),
  pushBannerDismissed: readPushBannerDismissed(),
  detectedLocale: INITIAL_DETECTED_LOCALE,
  locale: INITIAL_DETECTED_LOCALE || DEFAULT_LOCALE,
  localeSource: "fallback",
  defaultLocale: DEFAULT_LOCALE,
  supportedLocales: [...SUPPORTED_LOCALES],
  appVersion: "",
  appBuildId: APP_BUILD_ID,
  serverAppBuildId: "",
  clientUpdateRequired: false,
  versionStatus: null,
  versionStatusError: "",
};

let detailLoadSequence = 0;
let timelineHydrationSequence = 0;
let authenticatedPollInFlight = false;
let hazbasePasskeyModulePromise = null;
let lastTimelineRenderReportKey = "";
let timelineLiveStream = null;
let timelineLiveStreamRetryTimer = 0;
let timelineLiveRefreshInFlight = false;
let timelineLiveRefreshPending = false;
let lastTimelineLiveRevision = 0;
const reportedTimelineRenderTokens = new Set();

async function loadHazbasePasskeyModule() {
  if (!hazbasePasskeyModulePromise) {
    hazbasePasskeyModulePromise = import("./hazbase-passkey.js");
  }
  return hazbasePasskeyModulePromise;
}

function hazbasePasskeyHostSupport() {
  const protocol = normalizeClientText(window.location?.protocol || "");
  const hostname = normalizeClientText(window.location?.hostname || "").toLowerCase();
  const eligible = protocol === "https:" && Boolean(hostname) && hostname.endsWith(".local");
  return {
    eligible,
    hostname,
    detail: eligible ? "" : L("settings.hazbase.passkey.localHostRequired"),
  };
}

const app = document.querySelector("#app");
let bootSplashDismissed = false;
let bootSplashHintTimer = null;
let bootSplashHintVisible = false;
let bootSplashDeferredStatusTimer = null;
let bootSplashRemoteRouteSeen = false;
let bootSplashRemoteSwitchingShownAtMs = 0;
let bootSplashStatusStage = BOOT_SPLASH_STAGE.initial;
let bootSplashPendingStatusStage = BOOT_SPLASH_STAGE.initial;
const bootTraceStartedAtMs = Date.now();
const bootTraceStartPerfMs = bootTraceNow();
const bootTraceId = makeBootTraceId();
let bootTraceEvents = [];
let bootTraceClosed = false;
let bootTraceSent = false;

if (typeof window !== "undefined") {
  window.__viveworkerAppBuild = APP_BUILD_ID;
  window.__viveworkerBootTraceId = bootTraceId;
}

function bootTraceNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function makeBootTraceId() {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${randomPart}`;
}

function sanitizeBootTraceValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).slice(0, BOOT_TRACE_MAX_VALUE_LENGTH);
}

function sanitizeBootTraceUrl(value) {
  const raw = sanitizeBootTraceValue(value);
  if (!raw) {
    return "";
  }
  try {
    const base = window.location?.origin || "https://localhost";
    const url = new URL(raw, base);
    return url.pathname;
  } catch {
    return raw.split("?")[0].slice(0, BOOT_TRACE_MAX_VALUE_LENGTH);
  }
}

function recordBootTraceEvent(type, detail = {}) {
  if (bootTraceClosed) {
    return;
  }
  const event = {
    type: sanitizeBootTraceValue(type),
    tMs: Math.max(0, Math.round(bootTraceNow() - bootTraceStartPerfMs)),
  };
  const phase = sanitizeBootTraceValue(detail.phase);
  const url = sanitizeBootTraceUrl(detail.url);
  const stateValue = sanitizeBootTraceValue(detail.state);
  const previousState = sanitizeBootTraceValue(detail.previousState);
  const reason = sanitizeBootTraceValue(detail.reason);
  if (phase) event.phase = phase;
  if (url) event.url = url;
  if (stateValue) event.state = stateValue;
  if (previousState) event.previousState = previousState;
  if (reason) event.reason = reason;
  if (detail.sticky === true || detail.sticky === false) event.sticky = detail.sticky;
  if (Number.isFinite(Number(detail.code))) event.code = Number(detail.code);
  if (detail.resumed === true || detail.resumed === false) event.resumed = detail.resumed;
  bootTraceEvents.push(event);
  if (bootTraceEvents.length > BOOT_TRACE_MAX_EVENTS) {
    bootTraceEvents = bootTraceEvents.slice(-BOOT_TRACE_MAX_EVENTS);
  }
}

function flushBootTrace(reason, extra = {}) {
  if (bootTraceSent) {
    return;
  }
  bootTraceSent = true;
  bootTraceClosed = true;
  const payload = {
    traceId: bootTraceId,
    reason: sanitizeBootTraceValue(reason),
    appBuildId: APP_BUILD_ID,
    locale: state.locale || DEFAULT_LOCALE,
    startedAtMs: bootTraceStartedAtMs,
    totalMs: Math.max(0, Math.round(bootTraceNow() - bootTraceStartPerfMs)),
    remoteRouteSeen: bootSplashRemoteRouteSeen,
    finalStage: bootSplashStatusStage,
    userAgent: navigator.userAgent || "",
    events: bootTraceEvents,
    ...extra,
  };
  queueMicrotask(() => {
    routedFetch("/api/remote-pairing/boot-trace", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    }, { suppressRoutingStatus: true }).catch(() => {});
  });
}

function syncVisualViewportMetrics() {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const viewport = window.visualViewport;
  const width = viewport?.width || window.innerWidth || root.clientWidth || 0;
  const left = viewport?.offsetLeft || 0;
  root.style.setProperty("--visual-viewport-width", `${Math.max(0, width)}px`);
  root.style.setProperty("--visual-viewport-left", `${Math.max(0, left)}px`);
}

function resetHorizontalViewportScroll() {
  syncVisualViewportMetrics();
  const scrollingElement = document.scrollingElement || document.documentElement;
  if (scrollingElement) {
    scrollingElement.scrollLeft = 0;
  }
  document.documentElement.scrollLeft = 0;
  document.body.scrollLeft = 0;
  syncVisualViewportMetrics();
  window.requestAnimationFrame?.(syncVisualViewportMetrics);
}

function dismissBootSplash() {
  if (bootSplashDismissed || typeof document === "undefined") {
    return;
  }
  bootSplashDismissed = true;
  clearBootSplashHintTimer();
  clearBootSplashDeferredStatusTimer();
  if (typeof window !== "undefined") {
    window.removeEventListener("viveworker:remote-routing-status", handleBootRoutingStatus);
  }
  const splash = document.querySelector("#boot-splash");
  document.body?.classList.add("viveworker-ready");
  if (!splash) {
    return;
  }
  splash.setAttribute("aria-hidden", "true");
  window.setTimeout(() => {
    splash.remove();
  }, 280);
}

function setBootSplashStatus(key, stage = bootSplashStatusStage) {
  if (bootSplashDismissed || typeof document === "undefined") {
    return false;
  }
  if (stage < bootSplashStatusStage) {
    return false;
  }
  const message = L(key);
  const status = document.querySelector("#boot-splash-status");
  const splash = document.querySelector("#boot-splash");
  if (status && status.textContent !== message) {
    status.textContent = message;
  }
  if (splash) {
    splash.setAttribute("aria-label", `${L("common.appName")} ${message}`);
  }
  if (bootSplashRemoteRouteSeen) {
    ensureBootSplashHintTimer();
  }
  bootSplashStatusStage = Math.max(bootSplashStatusStage, stage);
  return true;
}

function ensureBootSplashHintTimer() {
  if (bootSplashHintTimer != null || bootSplashHintVisible || bootSplashDismissed) {
    return;
  }
  bootSplashHintTimer = window.setTimeout(() => {
    bootSplashHintTimer = null;
    showBootSplashHint();
  }, BOOT_SPLASH_SLOW_HINT_MS);
}

function clearBootSplashHintTimer() {
  if (bootSplashHintTimer != null) {
    window.clearTimeout(bootSplashHintTimer);
    bootSplashHintTimer = null;
  }
}

function clearBootSplashDeferredStatusTimer() {
  if (bootSplashDeferredStatusTimer != null) {
    window.clearTimeout(bootSplashDeferredStatusTimer);
    bootSplashDeferredStatusTimer = null;
  }
  bootSplashPendingStatusStage = BOOT_SPLASH_STAGE.initial;
}

function showBootSplashHint() {
  if (bootSplashDismissed || bootSplashHintVisible || typeof document === "undefined") {
    return;
  }
  const hint = document.querySelector("#boot-splash-hint");
  if (!hint) {
    return;
  }
  bootSplashHintVisible = true;
  hint.textContent = L("boot.status.slowHint");
  hint.hidden = false;
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => {
      hint.classList.add("is-visible");
    });
  } else {
    hint.classList.add("is-visible");
  }
}

function bootSplashNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function showBootRemoteSwitchingStatus() {
  bootSplashRemoteRouteSeen = true;
  const effectiveStage = Math.max(bootSplashStatusStage, bootSplashPendingStatusStage);
  if (effectiveStage >= BOOT_SPLASH_STAGE.switching) {
    ensureBootSplashHintTimer();
    return;
  }
  bootSplashRemoteSwitchingShownAtMs = bootSplashNow();
  clearBootSplashDeferredStatusTimer();
  setBootSplashStatus("boot.status.switchingRemote", BOOT_SPLASH_STAGE.switching);
}

function setBootRemoteStatusAfterSwitching(key, stage) {
  bootSplashRemoteRouteSeen = true;
  const effectiveStage = Math.max(bootSplashStatusStage, bootSplashPendingStatusStage);
  if (stage <= effectiveStage) {
    ensureBootSplashHintTimer();
    return;
  }
  if (bootSplashStatusStage < BOOT_SPLASH_STAGE.switching) {
    showBootRemoteSwitchingStatus();
  }
  const elapsedMs = bootSplashRemoteSwitchingShownAtMs > 0
    ? bootSplashNow() - bootSplashRemoteSwitchingShownAtMs
    : BOOT_SPLASH_REMOTE_SWITCHING_MIN_MS;
  const delayMs = Math.max(0, BOOT_SPLASH_REMOTE_SWITCHING_MIN_MS - elapsedMs);
  clearBootSplashDeferredStatusTimer();
  if (delayMs <= 0) {
    setBootSplashStatus(key, stage);
    return;
  }
  bootSplashDeferredStatusTimer = window.setTimeout(() => {
    bootSplashDeferredStatusTimer = null;
    bootSplashPendingStatusStage = BOOT_SPLASH_STAGE.initial;
    setBootSplashStatus(key, stage);
  }, delayMs);
  bootSplashPendingStatusStage = stage;
}

function handleBootRoutingStatus(event) {
  if (bootSplashDismissed) {
    return;
  }
  recordBootTraceEvent("route", event?.detail || {});
  const phase = event?.detail?.phase || "";
  switch (phase) {
    case "lan-checking":
      setBootSplashStatus("boot.status.checkingLan", BOOT_SPLASH_STAGE.checking);
      break;
    case "lan-failed":
    case "remote-switching":
      showBootRemoteSwitchingStatus();
      break;
    case "remote-connecting":
      setBootRemoteStatusAfterSwitching("boot.status.establishingRemote", BOOT_SPLASH_STAGE.establishing);
      break;
    case "lan-connected":
      // Same-LAN startup is fast and already covered by the checking message.
      break;
    case "remote-connected":
      setBootRemoteStatusAfterSwitching("boot.status.loadingData", BOOT_SPLASH_STAGE.loading);
      break;
    default:
      break;
  }
}
const params = new URLSearchParams(window.location.search);
const initialItem = params.get("item") || "";
const initialTargetTab = params.get("tab") || "";
const initialTargetSubtab = params.get("subtab") || "";
const initialPairToken = params.get("pairToken") || "";
const initialFocusPending = params.get("focusPending") || "";
let didReloadForServiceWorker = false;
let lastViewportMode = isDesktopLayout();

boot().catch((error) => {
  const message = bootErrorMessage(error);
  const hint = shouldShowNetworkHint(error, message)
    ? `<p class="muted">${escapeHtml(L("error.networkHint"))}</p>`
    : "";
  flushBootTrace("boot-error", {
    error: sanitizeBootTraceValue(error?.code || error?.name || message),
  });
  dismissBootSplash();
  app.innerHTML = `
    <main class="onboarding-shell">
      <section class="onboarding-card">
        <span class="eyebrow-pill">${escapeHtml(L("common.codex"))}</span>
        <h1 class="hero-title">${escapeHtml(L("common.appName"))}</h1>
        <p class="hero-copy">${escapeHtml(message)}</p>
        ${hint}
      </section>
    </main>
  `;
});

function bootErrorMessage(error) {
  if (isRemotePairingEnrollmentRequired(error)) {
    return L("error.remotePairingNeedsLanRefresh");
  }
  if (isRemotePairingUnavailable(error)) {
    return L("error.remotePairingUnavailable");
  }
  return error?.message || String(error);
}

function shouldShowNetworkHint(error, message) {
  if (isRemotePairingEnrollmentRequired(error) || isRemotePairingUnavailable(error)) {
    return false;
  }
  return /Load failed|Failed to fetch|NetworkError|fetch/i.test(message);
}

function isRemotePairingEnrollmentRequired(error) {
  return error?.code === "remote-pairing-enrollment-required" ||
    error?.name === "RemotePairingEnrollmentRequiredError";
}

function isRemotePairingUnavailable(error) {
  return error?.code === "remote-pairing-unavailable" ||
    error?.code === "remote-pairing-unreachable" ||
    error?.name === "RemotePairingUnavailableError" ||
    error?.name === "RpcTimeoutError" ||
    error?.name === "RpcTransportError" ||
    error?.name === "RpcTransportFailedError";
}

function inspectRemotePairingStateForEnrollment() {
  let store;
  try {
    store = globalThis.localStorage ?? null;
  } catch {
    return { status: "storage-unavailable", needsEnrollment: false };
  }
  if (!store) {
    return { status: "storage-unavailable", needsEnrollment: false };
  }

  let raw;
  try {
    raw = store.getItem(REMOTE_PAIRING_STATE_STORAGE_KEY);
  } catch {
    return { status: "storage-unavailable", needsEnrollment: false };
  }
  if (!raw) {
    return { status: "missing", needsEnrollment: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "malformed", needsEnrollment: true };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "malformed", needsEnrollment: true };
  }
  if (parsed.version === REMOTE_PAIRING_STATE_LEGACY_SCHEMA_VERSION) {
    return { status: "legacy-v1", needsEnrollment: true };
  }
  if (parsed.version !== REMOTE_PAIRING_STATE_SCHEMA_VERSION) {
    return { status: "unsupported-version", needsEnrollment: true };
  }
  if (typeof parsed.relayToken !== "string" || parsed.relayToken.length === 0) {
    return { status: "missing-token", needsEnrollment: true };
  }
  return { status: "ready", needsEnrollment: false };
}

async function boot() {
  recordBootTraceEvent("boot-start", {
    url: window.location?.pathname || "/app",
  });
  updateManifestHref(initialPairToken);
  syncVisualViewportMetrics();
  setBootSplashStatus("boot.status.checkingLan", BOOT_SPLASH_STAGE.checking);
  // SW register + update() can take hundreds of ms and does not need to gate
  // first paint. Fire and forget; the `controllerchange` reload handler wired
  // up inside `registerServiceWorker` still picks up new versions.
  registerServiceWorker().catch(() => {});
  window.addEventListener("viveworker:remote-routing-status", handleBootRoutingStatus);
  navigator.serviceWorker?.addEventListener("message", handleServiceWorkerMessage);
  window.addEventListener("resize", syncVisualViewportMetrics, { passive: true });
  window.visualViewport?.addEventListener("resize", syncVisualViewportMetrics, { passive: true });
  window.visualViewport?.addEventListener("scroll", syncVisualViewportMetrics, { passive: true });
  window.addEventListener("resize", handleViewportChange, { passive: true });
  window.addEventListener("focus", handlePotentialExternalNavigation, { passive: true });
  window.addEventListener("pageshow", handlePotentialExternalNavigation, { passive: true });
  document.addEventListener("visibilitychange", handleDocumentVisibilityChange);

  // Single round-trip for session + inbox(pending/completed) + timeline +
  // devices. See `refreshBootstrap` for why we collapsed the boot fan-out.
  await refreshBootstrap();
  if (bootSplashRemoteRouteSeen) {
    setBootRemoteStatusAfterSwitching("boot.status.loadingData", BOOT_SPLASH_STAGE.loading);
  }
  flushBootTrace("bootstrap-complete");

  if (!state.session?.authenticated && initialPairToken && shouldAutoPairFromBootstrapToken()) {
    try {
      const pairResult = await pair({
        token: initialPairToken,
        temporary: shouldUseTemporaryBootstrapPairing(),
      });
      // Mirror the manual #pair-form path: register with the bridge so
      // off-LAN reconnect via the relay works without a second pair step.
      // Skipped when the bridge graced this tab a temporary session
      // (Safari non-PWA bootstrap), since those don't survive the tab.
      if (pairResult?.temporaryPairing !== true) {
        await enrollRemotePairing();
      }
    } catch (error) {
      state.pairError = error.message || String(error);
    }
    await refreshBootstrap();
  }

  syncPairingTokenState(desiredBootstrapPairingToken());

  const parsedInitialItem = parseItemRef(initialItem);
  if (parsedInitialItem) {
    const targetTab = sanitizeExternalTargetTab(initialTargetTab) || tabForItemKind(parsedInitialItem.kind, state.currentTab);
    const targetSubtab = sanitizeExternalTargetInboxSubtab(initialTargetSubtab);
    state.currentItem = parsedInitialItem;
    state.currentTab = targetTab;
    if (state.currentTab === "inbox") {
      state.inboxSubtab = inboxSubtabForItemKind(parsedInitialItem.kind, targetSubtab);
    }
    state.detailOpen = true;
    if (isFastPathItemRef(parsedInitialItem)) {
      state.launchItemIntent = {
        ...parsedInitialItem,
        status: "pending",
      };
    }
  }

  if (!state.session?.authenticated) {
    renderPair();
    return;
  }

  await maybeAutoEnrollRemotePairingFromLan();
  await consumePendingNotificationIntent();
  // `?focusPending=claude` marks this tab as the Claude-hook-opened popup:
  // auto-navigate to the newest unresolved Claude pending (plan/question)
  // detail view — but only when the user is not already in the middle of
  // answering another pending item. Handled by `maybeAutoFocusClaudePending`
  // both on boot and on every polling refresh below.
  if (initialFocusPending === "claude" && !state.currentItem) {
    state.claudePopupMode = true;
  }

  // Bootstrap already populated session + inbox(pending/completed) +
  // timeline + devices, so the shell renders with real data on first
  // paint. No null-state fallback needed here.
  ensureCurrentSelection();
  maybeAutoFocusClaudePending();
  await renderShell();
  refreshVersionStatusForTechnicalPage();

  // Diff fetch runs as a background phase because `/api/inbox/diff`
  // spawns `git` subprocesses per tracked repo and can stall for several
  // seconds. The Code/diff tab lights up when this resolves.
  refreshInboxDiff()
    .then(async () => {
      if (!shouldDeferRenderForActiveInteraction()) {
        await renderShell();
      } else {
        renderDeferredInteractionShellUpdates();
      }
    })
    .catch(() => {});

  // Remote status probes (push/moltbook/a2a-relay/a2a-share — the share
  // worker round-trip alone can block up to 10s). Re-renders when it
  // resolves.
  refreshAuthenticatedStateRemote()
    .then(async () => {
      if (!shouldDeferRenderForActiveInteraction()) {
        await renderShell();
      } else {
        renderDeferredInteractionShellUpdates();
      }
    })
    .catch(() => {});
  syncDetectedLocalePreference().catch(() => {});

  setInterval(async () => {
    if (!state.session?.authenticated || authenticatedPollInFlight) {
      return;
    }
    authenticatedPollInFlight = true;
    try {
      const consumedNotificationIntent = await consumePendingNotificationIntent();
      if (consumedNotificationIntent) {
        return;
      }
      // Keep timeline freshness independent from secondary status probes.
      // Remote relay reconnects can make one small API call wait for a full
      // transport timeout; the timeline should still render on the next tick.
      await Promise.all([
        runFastPollStep(
          "timeline",
          () => refreshTimeline({ timeoutMs: TIMELINE_POLL_TIMEOUT_MS }),
          TIMELINE_POLL_TIMEOUT_MS + 500,
        ),
        runFastPollStep(
          "inbox",
          () => refreshInbox({ timeoutMs: FAST_POLL_STEP_TIMEOUT_MS }),
          FAST_POLL_STEP_TIMEOUT_MS + 500,
        ),
        runFastPollStep(
          "devices",
          () => refreshDevices({ timeoutMs: FAST_POLL_STEP_TIMEOUT_MS }),
          FAST_POLL_STEP_TIMEOUT_MS + 500,
        ),
        runFastPollStep(
          "push",
          () => refreshPushStatus({ timeoutMs: FAST_POLL_STEP_TIMEOUT_MS }),
          FAST_POLL_STEP_TIMEOUT_MS + 500,
        ),
        runFastPollStep(
          "a2a-relay",
          () => fetchA2aRelayStatus({ timeoutMs: FAST_POLL_STEP_TIMEOUT_MS }),
          FAST_POLL_STEP_TIMEOUT_MS + 500,
        ),
      ]);
      ensureCurrentSelection();
      maybeAutoFocusClaudePending();
      if (!shouldDeferRenderForActiveInteraction()) {
        await renderShell();
      } else {
        renderDeferredInteractionShellUpdates();
      }

      Promise.allSettled([
        refreshInboxDiff(),
        fetchMoltbookScoutStatus(),
        fetchA2aShareStatus(),
        fetchRemotePairingStatus(),
      ])
        .then(async () => {
          if (!shouldDeferRenderForActiveInteraction()) {
            await renderShell();
          } else {
            renderDeferredInteractionShellUpdates();
          }
        })
        .catch(() => {});
    } finally {
      authenticatedPollInFlight = false;
    }
  }, 3000);
}

async function maybeAutoEnrollRemotePairingFromLan() {
  if (!state.session?.authenticated) {
    return null;
  }
  const pairingState = inspectRemotePairingStateForEnrollment();
  const telemetry = getRoutingTelemetry();
  if (!telemetry || telemetry.lanOk <= 0) {
    return null;
  }
  if (!pairingState.needsEnrollment) {
    const record = pairingState.record || loadRemotePairingState();
    if (!shouldRefreshRemotePairingTokenFromLan(record)) {
      return null;
    }
  }
  return enrollRemotePairing();
}

function shouldRefreshRemotePairingTokenFromLan(record) {
  if (!record) {
    return false;
  }
  const updatedAt = Number(record.relayTokenUpdatedAtMs) || 0;
  if (!updatedAt) {
    return true;
  }
  return Date.now() - updatedAt >= REMOTE_PAIRING_TOKEN_REFRESH_MS;
}

function isRemotePairingUsingRelay() {
  const telemetry = getRoutingTelemetry();
  if (!telemetry) {
    return false;
  }
  if (telemetry.lastRoute === "lan") {
    return false;
  }
  if (telemetry.lastRoute === "relay") {
    return true;
  }
  return telemetry.relayOk > 0 && Number(telemetry.stickyRelayUntilMs || 0) > Date.now();
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  try {
    state.serviceWorkerRegistration = await navigator.serviceWorker.register("/sw.js");
    await state.serviceWorkerRegistration.update().catch(() => {});
    navigator.serviceWorker?.addEventListener("controllerchange", () => {
      if (didReloadForServiceWorker) {
        return;
      }
      didReloadForServiceWorker = true;
      window.location.reload();
    });
  } catch {
    state.serviceWorkerRegistration = null;
  }
}

async function forceAppRefreshFromLan() {
  try {
    const healthInit = {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      healthInit.signal = AbortSignal.timeout(2500);
    }
    await fetch("/health", healthInit);
  } catch {
    state.pushError = L("error.clientUpdateNeedsLan");
    return;
  }

  try {
    const registration = state.serviceWorkerRegistration || await navigator.serviceWorker?.getRegistration?.();
    await registration?.update?.();
  } catch {
    // Reload below is still useful; the next boot can retry SW update.
  }

  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => /^viveworker-v/.test(key))
          .map((key) => caches.delete(key))
      );
    }
  } catch {
    // Cache deletion is best-effort; network-first app routes still help.
  }

  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("appRefresh", String(Date.now()));
  window.location.replace(nextUrl.toString());
}

function handleViewportChange() {
  const nextViewportMode = isDesktopLayout();
  if (nextViewportMode === lastViewportMode) {
    return;
  }
  lastViewportMode = nextViewportMode;
  if (nextViewportMode) {
    state.detailOpen = false;
    ensureCurrentSelection();
    if (state.currentTab !== "settings") {
      syncCurrentItemUrl(state.currentItem);
    }
  } else if (!parseItemRef(new URLSearchParams(window.location.search).get("item"))) {
    state.detailOpen = false;
    syncCurrentItemUrl(null);
  }
  renderCurrentSurface();
}

async function refreshAuthenticatedState() {
  // Fire the two inbox halves in parallel so the diff's git subprocesses
  // don't serialize behind pending+completed (or vice versa).
  await Promise.all([refreshInbox(), refreshInboxDiff()]);
  await refreshTimeline();
  await refreshDevices();
  await refreshPushStatus();
  await fetchMoltbookScoutStatus();
  await fetchA2aRelayStatus();
  await fetchA2aShareStatus();
  await fetchRemotePairingStatus();
  if (state.currentTab === "settings") {
    await fetchHazbaseStatus();
  }
  ensureCurrentSelection();
}

// Boot-time split: the first paint should not wait on cross-origin status
// probes. `Local` covers in-memory bridge lookups (fast). `Remote` covers
// everything that can stall on an external service (push config,
// moltbook/a2a worker calls — the a2a share worker has a 10s timeout) and
// runs in the background after the shell renders.
async function refreshAuthenticatedStateLocal() {
  await Promise.all([
    refreshInbox({ timeoutMs: FAST_POLL_STEP_TIMEOUT_MS }),
    refreshTimeline({ timeoutMs: TIMELINE_POLL_TIMEOUT_MS }),
    refreshDevices({ timeoutMs: FAST_POLL_STEP_TIMEOUT_MS }),
  ]);
  ensureCurrentSelection();
}

async function refreshAuthenticatedStateRemote() {
  await Promise.allSettled([
    refreshPushStatus(),
    fetchMoltbookScoutStatus(),
    fetchA2aRelayStatus(),
    fetchA2aShareStatus(),
    fetchRemotePairingStatus(),
  ]);
}

async function refreshSession() {
  state.session = await apiGet("/api/session");
  applyServerAppBuildId(state.session?.webAppBuildId);
  syncPairingTokenState(desiredBootstrapPairingToken());
  applyResolvedLocale();
}

// One-shot boot fetch: hits `/api/bootstrap` which bundles session,
// inbox (pending + completed), timeline, and devices into a single
// HTTPS round-trip. Saves 3 additional TLS handshakes versus calling
// the four endpoints in parallel, which is the dominant boot cost on
// iOS PWAs where connection reuse is aggressive. Leaves the diff and
// external-status probes as separate background phases in `boot()`.
async function refreshBootstrap() {
  recordBootTraceEvent("bootstrap-start", { url: "/api/bootstrap" });
  const bootstrap = await apiGet("/api/bootstrap", {
    timeoutMs: BOOTSTRAP_REMOTE_TIMEOUT_MS,
    preferRelayError: true,
  });
  recordBootTraceEvent("bootstrap-response", { url: "/api/bootstrap" });
  state.session = bootstrap?.session || null;
  applyServerAppBuildId(bootstrap?.appBuildId || state.session?.webAppBuildId);
  syncPairingTokenState(desiredBootstrapPairingToken());
  applyResolvedLocale();

  if (!state.session?.authenticated) {
    state.devices = [];
    state.deviceError = "";
    return;
  }

  const fastInbox = bootstrap?.inbox || {};
  const previousDiff = Array.isArray(state.inbox?.diff) ? state.inbox.diff : [];
  state.inbox = {
    pending: Array.isArray(fastInbox.pending) ? fastInbox.pending : [],
    completed: Array.isArray(fastInbox.completed) ? fastInbox.completed : [],
    diff: previousDiff,
  };
  syncDiffThreadFilter();
  syncCompletedThreadFilter();
  syncInboxSubtab();

  setTimelinePayload(bootstrap?.timeline || null, { hydrateImages: true, renderOnHydrate: false });

  const devicesPayload = bootstrap?.devices;
  state.devices = Array.isArray(devicesPayload?.devices) ? devicesPayload.devices : [];
  state.deviceError = "";
}

function applyServerAppBuildId(value) {
  const buildId = normalizeClientText(value);
  state.serverAppBuildId = buildId;
  state.clientUpdateRequired = Boolean(buildId && buildId !== APP_BUILD_ID);
}

async function syncDetectedLocalePreference() {
  if (!state.session?.authenticated || !state.session?.deviceId || !state.detectedLocale) {
    return;
  }
  if (normalizeLocale(state.session?.deviceDetectedLocale || "") === state.detectedLocale) {
    return;
  }
  const result = await apiPost("/api/session/locale", {
    detectedLocale: state.detectedLocale,
  });
  state.session = {
    ...state.session,
    ...result,
  };
  applyResolvedLocale();
}

// Two-phase override: flip state.session + applyResolvedLocale synchronously
// so the caller can renderShell() in the new language before the POST
// round-trip, then reconcile with the server response. On failure the
// previous session snapshot is restored so the UI rolls back.
function applyLocaleOverrideOptimistically(nextLocale) {
  if (!state.session) return null;
  const previousSession = { ...state.session };
  const optimistic = resolveLocalePreference({
    overrideLocale: nextLocale || "",
    detectedLocale: state.session?.deviceDetectedLocale || state.detectedLocale,
    defaultLocale: state.session?.defaultLocale || DEFAULT_LOCALE,
    fallbackLocale: DEFAULT_LOCALE,
  });
  state.session = {
    ...state.session,
    deviceOverrideLocale: nextLocale || "",
    locale: optimistic.locale,
    localeSource: optimistic.source,
  };
  applyResolvedLocale();
  return previousSession;
}

async function persistLocaleOverride(nextLocale, previousSession) {
  try {
    const result = await apiPost("/api/session/locale", {
      detectedLocale: state.detectedLocale,
      overrideLocale: nextLocale || null,
    });
    state.session = {
      ...state.session,
      ...result,
    };
    applyResolvedLocale();
  } catch (error) {
    if (previousSession) {
      state.session = previousSession;
      applyResolvedLocale();
    }
    throw error;
  }
}

function applyResolvedLocale() {
  state.defaultLocale = normalizeLocale(state.session?.defaultLocale || "") || DEFAULT_LOCALE;
  state.supportedLocales = Array.isArray(state.session?.supportedLocales)
    ? state.session.supportedLocales.map((value) => normalizeLocale(value)).filter(Boolean)
    : [...SUPPORTED_LOCALES];
  state.appVersion = normalizeClientText(state.session?.appVersion || "");
  const resolved = resolveLocalePreference({
    overrideLocale: state.session?.deviceOverrideLocale,
    detectedLocale: state.session?.deviceDetectedLocale || state.detectedLocale,
    defaultLocale: state.defaultLocale,
    fallbackLocale: DEFAULT_LOCALE,
  });
  state.locale = normalizeLocale(state.session?.locale || "") || resolved.locale;
  state.localeSource = state.session?.localeSource || resolved.source;
}

function L(key, vars = {}) {
  return t(state.locale || DEFAULT_LOCALE, key, vars);
}



function detectBrowserLocale() {
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    for (const value of navigator.languages) {
      const normalized = normalizeLocale(value);
      if (normalized) {
        return normalized;
      }
    }
  }
  return normalizeLocale(navigator.language || "") || DEFAULT_LOCALE;
}

async function refreshPushStatus(opts = {}) {
  const client = await getClientPushState();
  const { clientSubscription, ...clientStatus } = client;
  if (!state.session?.authenticated) {
    state.pushStatus = {
      ...clientStatus,
      enabled: false,
      subscribed: false,
      serverSubscribed: false,
      lastSuccessfulDeliveryAtMs: 0,
      vapidPublicKey: "",
    };
    return;
  }

  try {
    let server = await apiGet("/api/push/status", opts);
    if (
      server?.enabled === true &&
      server?.subscribed !== true &&
      clientSubscription &&
      clientStatus.notificationPermission === "granted"
    ) {
      try {
        await apiPost("/api/push/subscribe", {
          subscription: clientSubscription,
          userAgent: navigator.userAgent,
          standalone: isStandaloneMode(),
        }, opts);
        server = await apiGet("/api/push/status", opts);
      } catch {
        // Best effort: if the browser still has a local subscription, the
        // status row can reflect that while the enable action repairs it.
      }
    }
    state.pushStatus = {
      ...server,
      ...clientStatus,
      serverSubscribed: Boolean(server.subscribed),
      subscribed: Boolean(server.subscribed || clientStatus.clientSubscribed),
    };
  } catch (error) {
    state.pushStatus = {
      ...clientStatus,
      enabled: false,
      subscribed: false,
      serverSubscribed: false,
      lastSuccessfulDeliveryAtMs: 0,
      vapidPublicKey: "",
      error: error.message || String(error),
    };
  }
}

async function fetchMoltbookScoutStatus() {
  if (!state.session?.moltbookEnabled) {
    state.moltbookScoutStatus = null;
    return;
  }
  try {
    state.moltbookScoutStatus = await apiGet("/api/moltbook/scout-status");
  } catch {
    state.moltbookScoutStatus = null;
  }
}

async function fetchA2aRelayStatus(opts = {}) {
  if (!state.session?.a2aRelayEnabled) {
    state.a2aRelayStatus = null;
    return;
  }
  try {
    state.a2aRelayStatus = await apiGet("/api/a2a/relay-status", opts);
  } catch {
    state.a2aRelayStatus = null;
  }
}

async function fetchRemotePairingStatus() {
  if (!state.session?.remotePairingAvailable) {
    state.remotePairingStatus = null;
    return;
  }
  try {
    state.remotePairingStatus = await apiGet("/api/remote-pairing/status");
  } catch {
    state.remotePairingStatus = null;
  }
}

async function fetchA2aShareStatus() {
  if (!state.session?.a2aShareEnabled) {
    state.a2aShareStatus = null;
    return;
  }
  try {
    state.a2aShareStatus = await apiGet("/api/share/status");
  } catch {
    state.a2aShareStatus = null;
  }
}


async function fetchHazbaseStatus() {
  try {
    state.hazbaseStatus = await apiGet("/api/hazbase/status");
  } catch {
    state.hazbaseStatus = null;
  }
}

async function fetchVersionStatus() {
  try {
    state.versionStatus = await apiGet("/api/version/status");
    state.versionStatusError = "";
  } catch (error) {
    state.versionStatus = null;
    state.versionStatusError = error.message || String(error);
  }
}

function refreshVersionStatusForTechnicalPage() {
  if (state.currentTab !== "settings" || state.settingsSubpage !== "advanced") {
    return;
  }
  fetchVersionStatus()
    .then(async () => {
      if (state.currentTab === "settings" && state.settingsSubpage === "advanced" && !shouldDeferRenderForActiveInteraction()) {
        await renderShell();
      }
    })
    .catch(() => {});
}

async function getClientPushState() {
  const registration = state.serviceWorkerRegistration || (await navigator.serviceWorker?.ready.catch(() => null));
  if (registration) {
    state.serviceWorkerRegistration = registration;
  }
  const subscription =
    registration && "pushManager" in registration
      ? await registration.pushManager.getSubscription().catch(() => null)
      : null;
  return {
    secureContext: window.isSecureContext === true,
    standalone: isStandaloneMode(),
    notificationPermission: "Notification" in window ? Notification.permission : "unsupported",
    supportsPush:
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window,
    clientSubscribed: Boolean(subscription),
    clientSubscription: subscription ? subscription.toJSON() : null,
  };
}

async function refreshInbox(opts = {}) {
  const fast = await apiGet("/api/inbox", opts);
  // `/api/inbox` now returns only `{ pending, completed }`. The `diff`
  // half lives at `/api/inbox/diff` because it spawns `git` subprocesses
  // server-side and was blocking first paint of the completed/pending
  // lists. Preserve whatever diff entries we already have in memory so
  // polling doesn't wipe the diff tab between diff refetches.
  const previousDiff = Array.isArray(state.inbox?.diff) ? state.inbox.diff : [];
  state.inbox = {
    pending: Array.isArray(fast?.pending) ? fast.pending : [],
    completed: Array.isArray(fast?.completed) ? fast.completed : [],
    diff: previousDiff,
  };
  syncDiffThreadFilter();
  syncCompletedThreadFilter();
  syncInboxSubtab();
}

async function refreshInboxDiff() {
  try {
    const response = await apiGet("/api/inbox/diff");
    const previous = state.inbox || { pending: [], completed: [] };
    state.inbox = {
      pending: Array.isArray(previous.pending) ? previous.pending : [],
      completed: Array.isArray(previous.completed) ? previous.completed : [],
      diff: Array.isArray(response?.diff) ? response.diff : [],
    };
    syncDiffThreadFilter();
    syncInboxSubtab();
  } finally {
    // Always flip off the skeleton — a persistent error shouldn't leave the
    // Code tab perpetually shimmering. The next poll cycle will retry.
    state.inboxDiffLoaded = true;
  }
}

async function refreshTimeline(opts = {}) {
  const requestOpts = {
    timeoutMs: TIMELINE_REFRESH_TIMEOUT_MS,
    probeLanWhileSticky: true,
    stickyLanProbeTimeoutMs: TIMELINE_STICKY_LAN_PROBE_TIMEOUT_MS,
    ...opts,
  };
  setTimelinePayload(await apiGet("/api/timeline", requestOpts), { hydrateImages: true });
}

async function refreshTimelineDirectLan(opts = {}) {
  setTimelinePayload(await apiGetDirectLan("/api/timeline", opts), { hydrateImages: true });
}

function closeTimelineLiveStream() {
  if (timelineLiveStream) {
    try {
      timelineLiveStream.close();
    } catch {}
  }
  timelineLiveStream = null;
  if (timelineLiveStreamRetryTimer) {
    clearTimeout(timelineLiveStreamRetryTimer);
    timelineLiveStreamRetryTimer = 0;
  }
}

function shouldUseTimelineLiveStream() {
  if (!state.session?.authenticated || typeof EventSource !== "function") {
    return false;
  }
  const telemetry = getRoutingTelemetry() || {};
  return telemetry.lastRoute === "lan";
}

function scheduleTimelineLiveStreamRetry() {
  if (timelineLiveStreamRetryTimer || !state.session?.authenticated) {
    return;
  }
  timelineLiveStreamRetryTimer = setTimeout(() => {
    timelineLiveStreamRetryTimer = 0;
    syncTimelineLiveStream();
  }, TIMELINE_LIVE_RETRY_MS);
}

function syncTimelineLiveStream() {
  if (!state.session?.authenticated) {
    closeTimelineLiveStream();
    return;
  }
  if (timelineLiveStream) {
    return;
  }
  if (!shouldUseTimelineLiveStream()) {
    return;
  }
  try {
    const stream = new EventSource("/api/timeline/stream");
    timelineLiveStream = stream;
    stream.addEventListener("hello", (event) => {
      const data = parseTimelineLiveEvent(event);
      lastTimelineLiveRevision = Math.max(lastTimelineLiveRevision, Number(data?.revision) || 0);
    });
    stream.addEventListener("timeline:update", (event) => {
      const data = parseTimelineLiveEvent(event);
      handleTimelineLiveUpdate(data).catch((err) => {
        console.warn("[timeline-live]", err?.message || err);
      });
    });
    stream.addEventListener("heartbeat", (event) => {
      const data = parseTimelineLiveEvent(event);
      lastTimelineLiveRevision = Math.max(lastTimelineLiveRevision, Number(data?.revision) || 0);
    });
    stream.onerror = () => {
      if (timelineLiveStream === stream) {
        closeTimelineLiveStream();
        scheduleTimelineLiveStreamRetry();
      }
    };
  } catch (err) {
    console.warn("[timeline-live]", err?.message || err);
    closeTimelineLiveStream();
    scheduleTimelineLiveStreamRetry();
  }
}

function parseTimelineLiveEvent(event) {
  try {
    return JSON.parse(event?.data || "{}");
  } catch {
    return null;
  }
}

async function handleTimelineLiveUpdate(data) {
  const revision = Number(data?.revision) || 0;
  if (revision && revision <= lastTimelineLiveRevision) {
    return;
  }
  lastTimelineLiveRevision = Math.max(lastTimelineLiveRevision, revision);
  if (timelineLiveRefreshInFlight) {
    timelineLiveRefreshPending = true;
    return;
  }
  timelineLiveRefreshInFlight = true;
  try {
    do {
      timelineLiveRefreshPending = false;
      try {
        await refreshTimelineDirectLan({ timeoutMs: TIMELINE_LIVE_REFRESH_TIMEOUT_MS });
      } catch {
        await refreshTimeline({
          timeoutMs: TIMELINE_LIVE_REFRESH_TIMEOUT_MS,
          probeLanWhileSticky: true,
          stickyLanProbeTimeoutMs: TIMELINE_STICKY_LAN_PROBE_TIMEOUT_MS,
        });
      }
      renderAfterBackgroundDataRefresh();
    } while (timelineLiveRefreshPending);
  } finally {
    timelineLiveRefreshInFlight = false;
  }
}

function setTimelinePayload(payload, options = {}) {
  const requestId = ++timelineHydrationSequence;
  const normalizedPayload = payload && typeof payload === "object" ? payload : null;
  state.timeline = normalizedPayload;
  syncTimelineThreadFilter();
  syncTimelineKindFilter();
  syncTimelineLiveStream();

  if (options.hydrateImages !== true || !timelinePayloadHasImages(normalizedPayload)) {
    return;
  }

  hydrateTimelinePayloadImages(normalizedPayload)
    .then((hydrated) => {
      if (requestId !== timelineHydrationSequence || !hydrated) {
        return;
      }
      state.timeline = hydrated;
      syncTimelineThreadFilter();
      syncTimelineKindFilter();
      if (options.renderOnHydrate === false || !state.session?.authenticated) {
        return;
      }
      renderAfterBackgroundDataRefresh();
    })
    .catch(() => {});
}

function latestTimelineEntryForClientEvent() {
  const entries = Array.isArray(state.timeline?.entries) ? state.timeline.entries : [];
  return entries.length > 0 ? entries[0] : null;
}

function newlyRenderedTimelineTokensForClientEvent(visible) {
  if (!visible) {
    return [];
  }
  const entries = Array.isArray(state.timeline?.entries) ? state.timeline.entries : [];
  const rendered = [];
  for (const entry of entries.slice(0, 20)) {
    const token = normalizeClientText(entry?.token || entry?.createdAtMs || "");
    const kind = normalizeClientText(entry?.kind || "");
    if (!token || !kind || reportedTimelineRenderTokens.has(token)) {
      continue;
    }
    reportedTimelineRenderTokens.add(token);
    rendered.push({
      token,
      kind,
      createdAtMs: Number(entry?.createdAtMs) || 0,
    });
    if (rendered.length >= 5) {
      break;
    }
  }
  if (reportedTimelineRenderTokens.size > 500) {
    const keep = new Set(entries.slice(0, 250).map((entry) => normalizeClientText(entry?.token || entry?.createdAtMs || "")).filter(Boolean));
    for (const token of reportedTimelineRenderTokens) {
      if (!keep.has(token)) {
        reportedTimelineRenderTokens.delete(token);
      }
    }
  }
  return rendered;
}

function reportTimelineRendered(reason = "render") {
  if (!state.session?.authenticated) {
    return;
  }
  const latest = latestTimelineEntryForClientEvent();
  if (!latest) {
    return;
  }
  const latestToken = normalizeClientText(latest.token || latest.createdAtMs || "");
  const latestKind = normalizeClientText(latest.kind || "");
  if (!latestToken || !latestKind) {
    return;
  }
  const desktop = isDesktopLayout();
  const visible = state.currentTab === "timeline" && (desktop || !state.detailOpen);
  const telemetry = getRoutingTelemetry() || {};
  const route = normalizeClientText(telemetry.lastRoute || "unknown");
  const renderedTokens = newlyRenderedTimelineTokensForClientEvent(visible);
  const reportKey = [
    latestKind,
    latestToken,
    state.currentTab,
    visible ? "visible" : "hidden",
    route,
    renderedTokens.map((item) => item.token).join(","),
  ].join(":");
  if (lastTimelineRenderReportKey === reportKey) {
    return;
  }
  lastTimelineRenderReportKey = reportKey;

  const send = () => {
    const latestNow = latestTimelineEntryForClientEvent();
    if (!latestNow) {
      return;
    }
    const telemetryNow = getRoutingTelemetry() || telemetry;
    apiPost(
      "/api/client-events",
      {
        type: "timeline-render",
        reason,
        latestToken: normalizeClientText(latestNow.token || latestNow.createdAtMs || ""),
        latestKind: normalizeClientText(latestNow.kind || ""),
        latestCreatedAtMs: Number(latestNow.createdAtMs) || 0,
        renderedTokens,
        entryCount: Array.isArray(state.timeline?.entries) ? state.timeline.entries.length : 0,
        currentTab: state.currentTab,
        visible,
        route: normalizeClientText(telemetryNow.lastRoute || route || "unknown"),
        clientAtMs: Date.now(),
        appBuildId: APP_BUILD_ID,
      },
      {
        timeoutMs: CLIENT_EVENT_REPORT_TIMEOUT_MS,
        probeLanWhileSticky: false,
        suppressRoutingStatus: true,
      },
    ).catch(() => {});
  };

  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(send);
  } else {
    queueMicrotask(send);
  }
}

function timelinePayloadHasImages(payload) {
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  return entries.some((entry) => Array.isArray(entry?.imageUrls) && entry.imageUrls.length > 0);
}

function renderAfterBackgroundDataRefresh() {
  ensureCurrentSelection();
  if (shouldDeferRenderForActiveInteraction()) {
    if (renderDeferredInteractionShellUpdates()) {
      reportTimelineRendered("deferred-refresh");
    }
    return;
  }
  renderCurrentSurface();
}

async function refreshPrimaryTabData(tab = state.currentTab) {
  if (tab === "inbox") {
    await refreshInbox();
    return;
  }
  if (tab === "timeline") {
    await refreshTimeline();
    return;
  }
  if (tab === "diff") {
    await refreshInboxDiff();
  }
}

function refreshPrimaryTabAfterNavigation(tab = state.currentTab) {
  if (!state.session?.authenticated || tab === "settings") {
    return;
  }
  refreshPrimaryTabData(tab)
    .then(() => {
      if (state.currentTab !== tab || state.currentTab === "settings") {
        return;
      }
      renderAfterBackgroundDataRefresh();
    })
    .catch(() => {});
}

async function refreshDevices(opts = {}) {
  if (!state.session?.authenticated) {
    state.devices = [];
    state.deviceError = "";
    return;
  }

  try {
    const payload = await apiGet("/api/devices", opts);
    state.devices = Array.isArray(payload?.devices) ? payload.devices : [];
    state.deviceError = "";
  } catch (error) {
    state.deviceError = error.message || String(error);
  }
}

function ensureCurrentSelection() {
  if ((!state.inbox && !state.timeline) || state.currentTab === "settings") {
    return;
  }

  const allEntries = allSelectableEntries();
  const preferredEntries = listEntriesForCurrentTab();
  const previousItem = state.currentItem ? { ...state.currentItem } : null;
  const currentEntry = state.currentItem
    ? allEntries.find((entry) => isSameItemRef(state.currentItem, entry.item))
    : null;
  const currentStatus = currentEntry?.status || null;
  if (state.currentItem && currentStatus && state.currentItemStatus && currentStatus !== state.currentItemStatus) {
    // Status transitioned (e.g. pending → completed because PC user answered).
    // Drop the cached detail so the next render fetches the updated view.
    state.currentDetail = null;
  }
  state.currentItemStatus = currentStatus;
  const hasCurrent = Boolean(currentEntry);
  const hasCurrentInPreferred = state.currentItem
    ? preferredEntries.some((entry) => isSameItemRef(state.currentItem, entry.item))
    : false;

  if (!hasCurrent) {
    if (!shouldPreserveCurrentItem()) {
      clearChoiceLocalDraftForItem(previousItem);
      state.currentItem = null;
      state.currentDetail = null;
      clearDetailOverride();
    }
  }

  if (isDesktopLayout()) {
    const fallback = preferredEntries[0] || allEntries[0] || null;
    if (!state.currentItem && fallback) {
      state.currentItem = toItemRef(fallback.item);
    } else if (state.currentItem && !hasCurrentInPreferred && fallback && !shouldPreserveCurrentItem()) {
      state.currentItem = toItemRef(fallback.item);
      state.currentDetail = null;
    }
  }

  if (state.detailOpen && !state.currentItem) {
    state.detailOpen = false;
    syncCurrentItemUrl(null);
  }
}

function allInboxEntries() {
  if (!state.inbox) {
    return [];
  }
  return [
    ...(Array.isArray(state.inbox.pending) ? state.inbox.pending.map((item) => ({ item, status: "pending" })) : []),
    ...(Array.isArray(state.inbox.diff) ? state.inbox.diff.map((item) => ({ item, status: "diff" })) : []),
    ...(Array.isArray(state.inbox.completed) ? state.inbox.completed.map((item) => ({ item, status: "completed" })) : []),
  ];
}

function pickNewestClaudePendingItem() {
  const pending = Array.isArray(state.inbox?.pending) ? state.inbox.pending : [];
  let best = null;
  let bestTs = -Infinity;
  for (const item of pending) {
    if (normalizeProviderClient(item?.provider) !== "claude") continue;
    const kind = normalizeClientText(item?.kind);
    if (kind !== "approval" && kind !== "question") continue;
    const ts = Number(item?.createdAtMs) || 0;
    if (ts > bestTs) {
      best = item;
      bestTs = ts;
    }
  }
  return best;
}

// True when the user is currently viewing the detail of an item that still
// exists in `state.inbox.pending` — i.e. they are actively answering it. In
// that case we must not yank them to a different pending.
function isViewingUnresolvedPendingItem() {
  if (!state.currentItem || !state.detailOpen) return false;
  const pending = Array.isArray(state.inbox?.pending) ? state.inbox.pending : [];
  return pending.some(
    (item) =>
      normalizeClientText(item?.kind) === normalizeClientText(state.currentItem?.kind) &&
      normalizeClientText(item?.token) === normalizeClientText(state.currentItem?.token)
  );
}

// Claude-hook popup mode: auto-navigate to the newest unresolved Claude
// pending item whenever a new one appears, but only when the user is idle on
// the list/completed view (so we never disturb an in-progress answer).
function maybeAutoFocusClaudePending() {
  if (!state.claudePopupMode) return;
  const newest = pickNewestClaudePendingItem();
  if (!newest) return;
  const ts = Number(newest.createdAtMs) || 0;
  if (ts <= (state.lastSeenClaudePendingTs || 0)) return;
  // Preserve the user's current answer-in-progress view. Do NOT record
  // `lastSeenClaudePendingTs` here, so the next polling cycle re-evaluates
  // once the user finishes their current item.
  if (isViewingUnresolvedPendingItem()) return;
  state.lastSeenClaudePendingTs = ts;
  state.currentItem = { kind: newest.kind, token: newest.token };
  state.currentTab = tabForItemKind(newest.kind, state.currentTab);
  if (state.currentTab === "inbox") {
    state.inboxSubtab = inboxSubtabForItemKind(newest.kind);
  }
  state.detailOpen = true;
  syncCurrentItemUrl(state.currentItem);
}

function allTimelineEntries() {
  if (!state.timeline?.entries) {
    return [];
  }
  return state.timeline.entries.map((item) => ({ item, status: "timeline" }));
}

function allSelectableEntries() {
  return [...allInboxEntries(), ...allTimelineEntries()];
}

function listEntriesForTab(tab) {
  if (!state.inbox) {
    if (tab !== "timeline") {
      return [];
    }
  }
  if (tab === "inbox") {
    return listInboxEntries();
  }
  if (tab === "timeline") {
    return filteredTimelineEntries().map((item) => ({ item, status: "timeline" }));
  }
  if (tab === "diff") {
    return filteredDiffEntries().map((item) => ({ item, status: "diff" }));
  }
  return [];
}

function listEntriesForCurrentTab() {
  return listEntriesForTab(state.currentTab);
}

function listInboxEntries() {
  if (!state.inbox) {
    return [];
  }
  if (state.inboxSubtab === "completed") {
    return filteredCompletedEntries().map((item) => ({ item, status: "completed" }));
  }
  return (Array.isArray(state.inbox.pending) ? state.inbox.pending : [])
    .filter((item) => entryMatchesProviderFilter(item))
    .map((item) => ({ item, status: "pending" }));
}

function normalizeProviderClient(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "claude") return "claude";
  if (normalized === "moltbook") return "moltbook";
  if (normalized === "a2a") return "a2a";
  if (normalized === "viveworker") return "viveworker";
  if (normalized === "mcp") return "mcp";
  return "codex";
}

function providerDisplayName(provider) {
  const p = normalizeProviderClient(provider);
  if (p === "claude") return L("common.claude");
  if (p === "moltbook") return "Moltbook";
  if (p === "a2a") return "A2A";
  if (p === "viveworker") return L("common.appName");
  if (p === "mcp") return "MCP";
  return L("common.codex");
}

function entryMatchesProviderFilter(item) {
  if (!state.providerFilter || state.providerFilter === "all") {
    return true;
  }
  return normalizeProviderClient(item?.provider) === state.providerFilter;
}

function filteredTimelineEntries() {
  const entries = Array.isArray(state.timeline?.entries) ? state.timeline.entries : [];
  if (!entries.length) {
    return [];
  }
  let filtered = entries;
  if (state.timelineThreadFilter && state.timelineThreadFilter !== "all") {
    filtered = filtered.filter((entry) => entry.threadId === state.timelineThreadFilter);
  }
  filtered = filtered.filter((entry) => entryMatchesProviderFilter(entry));
  if (!state.timelineKindFilter || state.timelineKindFilter === "all") {
    return filtered;
  }
  return filtered.filter((entry) => timelineEntryMatchesKindFilter(entry, state.timelineKindFilter));
}

function filteredCompletedEntries() {
  const entries = Array.isArray(state.inbox?.completed) ? state.inbox.completed : [];
  if (!entries.length) {
    return [];
  }
  let filtered = entries.filter((entry) => entryMatchesProviderFilter(entry));
  if (!state.completedThreadFilter || state.completedThreadFilter === "all") {
    return filtered;
  }
  return filtered.filter((entry) => entry.threadId === state.completedThreadFilter);
}

function filteredDiffEntries() {
  const entries = Array.isArray(state.inbox?.diff) ? state.inbox.diff : [];
  if (!entries.length) {
    return [];
  }
  return entries.slice();
}

function syncTimelineThreadFilter() {
  if (!state.timelineThreadFilter || state.timelineThreadFilter === "all") {
    state.timelineThreadFilter = "all";
    return;
  }
  const provider = state.providerFilter || "all";
  let validThreadIds;
  if (provider === "all") {
    const threads = Array.isArray(state.timeline?.threads) ? state.timeline.threads : [];
    validThreadIds = new Set(threads.map((t) => t.id));
  } else {
    validThreadIds = new Set(timelineThreadsForProvider(provider).map((t) => t.id));
  }
  if (!validThreadIds.has(state.timelineThreadFilter)) {
    state.timelineThreadFilter = "all";
  }
}

function syncTimelineKindFilter() {
  const validIds = new Set(timelineKindFilterOptions().map((option) => option.id));
  if (!state.timelineKindFilter || !validIds.has(state.timelineKindFilter)) {
    state.timelineKindFilter = "all";
  }
}

function timelineKindFilterOptions() {
  const provider = state.providerFilter || "all";
  const allOption = { id: "all", label: L("timeline.kindFilter.all"), icon: "filter" };

  if (provider === "moltbook") {
    return [
      allOption,
      { id: "moltbook_reply_drafts", label: L("timeline.kindFilter.moltbookReplyDrafts"), icon: "moltbook-reply" },
      { id: "moltbook_post_drafts", label: L("timeline.kindFilter.moltbookPostDrafts"), icon: "moltbook-draft" },
      { id: "moltbook_comments", label: L("timeline.kindFilter.moltbookComments"), icon: "moltbook-comment" },
    ];
  }
  if (provider === "a2a") {
    return [
      allOption,
      { id: "a2a_requests", label: L("timeline.kindFilter.a2aRequests"), icon: "item" },
      { id: "a2a_results", label: L("timeline.kindFilter.a2aResults"), icon: "completion-item" },
    ];
  }

  const codexClaudeOptions = [
    allOption,
    { id: "messages", label: L("timeline.kindFilter.messages"), icon: "timeline" },
    { id: "suggestions", label: L("timeline.kindFilter.suggestions"), icon: "suggestions" },
    { id: "files", label: L("timeline.kindFilter.files"), icon: "file-event" },
    { id: "commands", label: L("timeline.kindFilter.commands"), icon: "command" },
    { id: "approvals", label: L("timeline.kindFilter.approvals"), icon: "approval" },
    { id: "plans", label: L("timeline.kindFilter.plans"), icon: "plan" },
    { id: "choices", label: L("timeline.kindFilter.choices"), icon: "choice" },
    { id: "final_answers", label: L("timeline.kindFilter.finalAnswers"), icon: "assistant-final" },
  ];

  if (provider === "codex" || provider === "claude") {
    return codexClaudeOptions;
  }

  // "all" — union of everything
  return [
    ...codexClaudeOptions,
    { id: "moltbook_reply_drafts", label: L("timeline.kindFilter.moltbookReplyDrafts"), icon: "moltbook-reply" },
    { id: "moltbook_post_drafts", label: L("timeline.kindFilter.moltbookPostDrafts"), icon: "moltbook-draft" },
    { id: "moltbook_comments", label: L("timeline.kindFilter.moltbookComments"), icon: "moltbook-comment" },
    { id: "a2a_requests", label: L("timeline.kindFilter.a2aRequests"), icon: "item" },
    { id: "a2a_results", label: L("timeline.kindFilter.a2aResults"), icon: "completion-item" },
  ];
}

function currentTimelineKindFilterOption() {
  return (
    timelineKindFilterOptions().find((option) => option.id === state.timelineKindFilter) ||
    timelineKindFilterOptions()[0]
  );
}

function timelineEntryMatchesKindFilter(entry, filterId) {
  const kind = normalizeClientText(entry?.kind || entry?.item?.kind || "");
  switch (filterId) {
    case "messages":
      return TIMELINE_MESSAGE_KINDS.has(kind);
    case "suggestions":
      return kind === "ambient_suggestions";
    case "files":
      return kind === "file_event";
    case "commands":
      return kind === "command_event";
    case "approvals":
      return kind === "approval";
    case "plans":
      return kind === "plan" || kind === "plan_ready";
    case "choices":
      return kind === "choice";
    case "completions":
      return kind === "completion";
    case "final_answers":
      return kind === "assistant_final";
    case "moltbook_drafts":
      return kind === "moltbook_draft";
    case "moltbook_reply_drafts":
      return kind === "moltbook_draft" && entry?.draftType === "reply";
    case "moltbook_post_drafts":
      return kind === "moltbook_draft" && entry?.draftType !== "reply";
    case "moltbook_comments":
      return kind === "moltbook_reply";
    case "a2a_requests":
      return kind === "a2a_task";
    case "a2a_results":
      return kind === "a2a_task_result";
    default:
      return true;
  }
}

function isMoltbookThreadId(threadId, item) {
  if (threadId === "moltbook") return true;
  if (typeof threadId === "string" && threadId.startsWith("draft:")) return true;
  const kind = normalizeClientText(item?.kind || "");
  if (kind === "moltbook_draft" || kind === "moltbook_reply") return true;
  const label = normalizeClientText(item?.threadLabel || "").toLowerCase();
  if (label === "moltbook") return true;
  return false;
}

function completedThreads() {
  const items = Array.isArray(state.inbox?.completed) ? state.inbox.completed : [];
  if (!items.length) {
    return [];
  }
  const provider = state.providerFilter || "all";
  const byThread = new Map();
  for (const item of items) {
    const threadId = normalizeClientText(item.threadId || "");
    if (!threadId) {
      continue;
    }
    // Skip Moltbook threads unless Moltbook tab is active
    if (provider !== "moltbook" && isMoltbookThreadId(threadId, item)) {
      continue;
    }
    // Filter by provider
    if (provider !== "all" && normalizeProviderClient(item.provider) !== provider) {
      continue;
    }
    const latestAtMs = Number(item.createdAtMs || 0);
    const label = resolvedThreadLabel(threadId, item.threadLabel || "");
    const previous = byThread.get(threadId);
    if (!previous || latestAtMs >= previous.latestAtMs) {
      byThread.set(threadId, {
        id: threadId,
        label,
        latestAtMs,
      });
    }
  }
  return [...byThread.values()].sort((left, right) => right.latestAtMs - left.latestAtMs);
}

function diffThreads() {
  const items = Array.isArray(state.inbox?.diff) ? state.inbox.diff : [];
  if (!items.length) {
    return [];
  }
  const byThread = new Map();
  for (const item of items) {
    const threadId = normalizeClientText(item.threadId || "");
    if (!threadId || isMoltbookThreadId(threadId, item)) {
      continue;
    }
    const latestAtMs = Number(item.createdAtMs || 0);
    const label = resolvedThreadLabel(threadId, item.threadLabel || "");
    const previous = byThread.get(threadId);
    if (!previous || latestAtMs >= previous.latestAtMs) {
      byThread.set(threadId, {
        id: threadId,
        label,
        latestAtMs,
      });
    }
  }
  return [...byThread.values()].sort((left, right) => right.latestAtMs - left.latestAtMs);
}

function syncDiffThreadFilter() {
  const threads = diffThreads();
  if (!state.diffThreadFilter || state.diffThreadFilter === "all") {
    state.diffThreadFilter = "all";
    return;
  }
  if (!threads.some((thread) => thread.id === state.diffThreadFilter)) {
    state.diffThreadFilter = "all";
  }
}

function syncCompletedThreadFilter() {
  const threads = completedThreads();
  if (!state.completedThreadFilter || state.completedThreadFilter === "all") {
    state.completedThreadFilter = "all";
    return;
  }
  if (!threads.some((thread) => thread.id === state.completedThreadFilter)) {
    state.completedThreadFilter = "all";
  }
}

function syncInboxSubtab() {
  if (state.inboxSubtab === "completed") {
    state.inboxSubtab = "completed";
    return;
  }
  state.inboxSubtab = "pending";
}

function renderPair() {
  const shouldInstallFromHomeScreen = Boolean(initialPairToken) && !shouldAutoPairFromBootstrapToken();
  app.innerHTML = `
    <main class="onboarding-shell">
      <section class="onboarding-card">
        <span class="eyebrow-pill">${escapeHtml(L("common.codex"))}</span>
        <h1 class="hero-title">${escapeHtml(L("common.appName"))}</h1>
        <p class="hero-copy">${escapeHtml(L("pair.copy"))}</p>
        ${state.pairNotice ? `<p class="inline-alert inline-alert--success">${escapeHtml(state.pairNotice)}</p>` : ""}
        ${state.pairError ? `<p class="inline-alert inline-alert--danger">${escapeHtml(state.pairError)}</p>` : ""}
        ${shouldInstallFromHomeScreen ? `<p class="inline-alert inline-alert--warning">${escapeHtml(L("pair.installFromHomeScreen"))}</p>` : ""}
        <form id="pair-form" class="pair-form">
          <label class="field">
            <span class="field-label">${escapeHtml(L("pair.codeLabel"))}</span>
            <input name="code" placeholder="${escapeHtml(L("pair.codePlaceholder"))}" autocomplete="one-time-code">
          </label>
          <button class="primary primary--wide" type="submit">${escapeHtml(L("pair.connect"))}</button>
        </form>
        <section class="helper-card">
          <div class="helper-copy">
            <strong>${escapeHtml(L("pair.helperTitle"))}</strong>
            <p class="muted">${escapeHtml(L("pair.helperCopy"))}</p>
          </div>
          <div class="actions">
            <button class="secondary secondary--wide" type="button" data-install-guide-open>${escapeHtml(L("common.addToHomeScreen"))}</button>
          </div>
        </section>
      </section>
      ${renderInstallGuideModal()}
    </main>
  `;

  document.querySelector("#pair-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const pairResult = await pair({ code: String(form.get("code") || "") });
      state.pairError = "";
      state.pairNotice = "";
      // Best-effort: register this phone's X25519 pubkey with the bridge
      // so it can reach us via the relay later. Doesn't block the shell
      // render; failures (older bridge, IndexedDB blocked, …) are swallowed
      // inside the helper.
      if (pairResult?.temporaryPairing !== true) {
        await enrollRemotePairing();
      }
      await refreshSession();
      await refreshAuthenticatedState();
      await renderShell();
    } catch (error) {
      state.pairError = error.message || String(error);
      renderPair();
    }
  });

  bindSharedUi(renderPair);
  requestAnimationFrame(dismissBootSplash);
}

async function pair(payload) {
  const result = await apiPost("/api/session/pair", payload);
  if (result?.temporaryPairing !== true) {
    syncPairingTokenState("");
  }
  return result;
}

/**
 * Best-effort post-pair enrollment: hand the bridge our X25519 static
 * pubkey + a friendly label, persist the bridge's response in localStorage,
 * and return the saved record (or null on any failure).
 *
 * Always called after a successful LAN pair (regardless of whether the
 * remote relay is currently ON). Reasoning:
 *
 *   - Enrollment is idempotent on phonePub server-side; re-pairing the same
 *     phone keeps its existing pairingId and bridge identity.
 *   - Doing it eagerly means flipping the relay toggle later "just works"
 *     without forcing the user to repair-on-LAN to register their key.
 *   - LAN-only basic auth keeps working even if this fails (e.g. older
 *     bridge predating the lan-enroll endpoint, IndexedDB blocked, etc.) —
 *     we explicitly swallow errors and let the caller continue rendering
 *     the authenticated shell.
 *
 * Skipped when the surrounding `pair()` returned `temporaryPairing: true`
 * — temporary sessions are an opt-in shape that doesn't outlive the tab,
 * so persisting a pairing record would be misleading.
 *
 * @param {string} [label]  user-visible device label; defaults to a
 *                          "LAN paired YYYY-MM-DD" stamp.
 * @returns {Promise<import("./remote-pairing/pairing-state.js").RemotePairingState | null>}
 */
async function enrollRemotePairing(label) {
  try {
    const keypair = await ensureIdentityKeypair();
    const phonePubHex = bytesToHex(keypair.pub);
    const effectiveLabel = (label && String(label).trim()) || buildDefaultEnrollLabel();
    const response = await apiPost("/api/remote-pairing/lan-enroll", {
      phonePubHex,
      label: effectiveLabel,
    });
    if (!response || response.ok !== true) {
      return null;
    }
    const saved = saveRemotePairingState({
      pairingId: response.pairingId,
      relayToken: response.relayToken,
      phonePub: response.phonePub,
      phoneFingerprint: response.phoneFingerprint,
      bridgePubHex: response.bridgePubHex,
      bridgeFingerprint: response.bridgeFingerprint,
      relayUrl: response.relayUrl,
      label: response.label || "",
      addedAtMs: Number.isFinite(response.addedAtMs) ? response.addedAtMs : Date.now(),
      relayTokenUpdatedAtMs: Number.isFinite(response.relayTokenUpdatedAtMs)
        ? response.relayTokenUpdatedAtMs
        : Date.now(),
    });
    if (!saved) {
      // Storage is full / disabled; the bridge still has the pairing,
      // so future toggle-on works — just no localStorage cache for the
      // PWA's own routing decisions.
      return null;
    }
    return loadRemotePairingState();
  } catch (error) {
    console.warn("[remote-pairing] lan-enroll skipped:", error?.message || error);
    return null;
  }
}

function buildDefaultEnrollLabel() {
  // YYYY-MM-DD so re-enrolls produce stable, sortable labels in the
  // settings list. (The user can rename in the settings page later.)
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `LAN paired ${y}-${m}-${d}`;
}

async function logout({ revokeCurrentDeviceTrust = false } = {}) {
  await apiPost("/api/session/logout", { revokeCurrentDeviceTrust });
  resetAuthenticatedState();
  state.pairNotice = revokeCurrentDeviceTrust
    ? L("notice.loggedOutDeviceRemoved")
    : L("notice.loggedOutKeepTrusted");
  syncPairingTokenState("");
  renderPair();
}

function resetAuthenticatedState() {
  closeTimelineLiveStream();
  state.session = null;
  state.inbox = null;
  // Reset the diff-loaded flag so the next sign-in shows the skeleton
  // again during the fresh /api/inbox/diff fetch instead of flashing the
  // empty state from the previous session's terminal value.
  state.inboxDiffLoaded = false;
  state.timeline = null;
  state.devices = [];
  state.currentItem = null;
  state.currentDetail = null;
  state.currentDetailLoading = false;
  state.detailLoadingItem = null;
  state.detailOpen = false;
  state.choiceLocalDrafts = {};
  clearAllCompletionReplyDrafts();
  state.completionReplyDrafts = {};
  state.completionReplySheetToken = "";
  state.settingsSubpage = "";
  state.settingsScrollState = null;
  state.listScrollState = null;
  clearPinnedDetailState();
  state.pushStatus = null;
  state.pushNotice = "";
  state.pushError = "";
  state.deviceNotice = "";
  state.deviceError = "";
  state.logoutConfirmOpen = false;
  state.pairError = "";
  state.remotePairingDetailsOpen = false;
}

async function revokeTrustedDevice(deviceId) {
  if (!deviceId) {
    return;
  }
  const result = await apiPost(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, {});
  if (result?.currentDeviceRevoked) {
    resetAuthenticatedState();
    state.pairNotice = L("notice.loggedOutDeviceRemoved");
    syncPairingTokenState("");
    renderPair();
    return;
  }
  state.deviceNotice = L("notice.deviceRevoked");
  state.deviceError = "";
  await refreshAuthenticatedState();
  await renderShell();
}

/**
 * `renderShell()` rebuilds the entire `#app` subtree by reassigning
 * `innerHTML`, which destroys every <pre> element in the DOM — including
 * any horizontal scroll position the user dragged into a wide code block.
 * On a polling interval, that means a long line of code keeps snapping
 * back to the start while the reader is mid-line.
 *
 * `snapshotScrollableContentScrolls()` records each scrollable code/diff
 * block's scrollLeft
 * keyed by its trimmed textContent (so the key survives a fresh render
 * regardless of position in the DOM tree). `restoreScrollableContentScrolls()`
 * walks the new DOM and restores any scrollLeft we still have a key for.
 *
 * Content-keyed matching is intentional: if the underlying code text
 * changes mid-scroll, the new <pre> is logically different and we let it
 * start at scrollLeft=0 rather than landing the reader somewhere unrelated.
 */
// Blocks the user can scroll horizontally — we preserve their position
// across innerHTML rebuilds and defer background renders while the user is
// actively scrolling/selecting them. <pre> for fenced code; <table> for
// pipe-style markdown tables; `.detail-diff-viewer` for file diffs.
const SCROLLABLE_CONTENT_SELECTORS = ".markdown pre, .markdown table, .detail-diff-viewer";

function snapshotScrollableContentScrolls() {
  if (typeof document === "undefined") return null;
  const blocks = document.querySelectorAll(SCROLLABLE_CONTENT_SELECTORS);
  if (blocks.length === 0) return null;
  const map = new Map();
  for (const el of blocks) {
    const key = el.textContent ? el.textContent.trim() : "";
    if (!key) continue;
    if (el.scrollLeft === 0 && el.scrollTop === 0) continue;
    map.set(`${el.tagName}:${key}`, {
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    });
  }
  return map.size > 0 ? map : null;
}

function restoreScrollableContentScrolls(snapshot) {
  if (!snapshot || typeof document === "undefined") return;
  for (const el of document.querySelectorAll(SCROLLABLE_CONTENT_SELECTORS)) {
    const key = el.textContent ? el.textContent.trim() : "";
    const saved = key ? snapshot.get(`${el.tagName}:${key}`) : null;
    if (!saved) continue;
    if (saved.scrollLeft) el.scrollLeft = saved.scrollLeft;
    if (saved.scrollTop) el.scrollTop = saved.scrollTop;
  }
}

async function renderShell() {
  syncVisualViewportMetrics();
  const desktop = isDesktopLayout();
  const shouldShowDetail = state.currentTab !== "settings" && state.currentItem && (desktop || state.detailOpen);
  let detail = null;
  if (shouldShowDetail) {
    detail = renderableCurrentDetail();
    if (!detail) {
      queueCurrentDetailLoad();
    }
  }

  const shellClassName = [
    "app-shell",
    desktop ? "app-shell--desktop" : "app-shell--mobile",
    !desktop && (state.detailOpen || isSettingsSubpageOpen()) ? "app-shell--detail" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const scrollableContentSnapshot = snapshotScrollableContentScrolls();

  app.innerHTML = `
    <div class="${shellClassName}">
      ${desktop ? renderDesktopHeader(detail) : renderMobileTopBar(detail)}
      ${renderTopBanner()}
      ${renderGlobalErrorBanner()}
      <main class="app-main">
        ${desktop ? renderDesktopWorkspace(detail) : renderMobileWorkspace(detail)}
      </main>
      ${desktop || state.detailOpen || isSettingsSubpageOpen() ? "" : renderBottomTabs()}
      ${renderImageViewerModal()}
      ${renderInstallGuideModal()}
      ${renderLogoutConfirmModal()}
      ${renderHazbaseLogoutConfirmModal()}
    </div>
    ${!desktop && detail ? renderCompletionReplySheet(detail) : ""}
  `;

  bindShellInteractions();
  if (state.completionReplySheetToken) {
    resetHorizontalViewportScroll();
  }
  applyPendingDetailScrollReset();
  applyPendingListScrollRestore();
  applyPendingSettingsSubpageScrollReset();
  applyPendingSettingsScrollRestore();
  // Reapply any horizontal scroll the user dragged into a code block before
  // this re-render. Done after the imperative scroll resets above so they
  // can't fight each other.
  restoreScrollableContentScrolls(scrollableContentSnapshot);
  requestAnimationFrame(dismissBootSplash);
  reportTimelineRendered("shell");
}

function applyPendingDetailScrollReset() {
  if (!state.pendingDetailScrollReset || isDesktopLayout() || !state.detailOpen) {
    return;
  }
  state.pendingDetailScrollReset = false;
  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    const detailScroll = document.querySelector(".mobile-detail-scroll");
    if (detailScroll) {
      detailScroll.scrollTop = 0;
    }
  });
}

function applyPendingListScrollRestore() {
  if (!state.pendingListScrollRestore || isDesktopLayout() || state.detailOpen || !state.listScrollState) {
    return;
  }
  state.pendingListScrollRestore = false;
  const targetY = Number.isFinite(state.listScrollState.y) ? state.listScrollState.y : 0;
  requestAnimationFrame(() => {
    window.scrollTo({ top: targetY, left: 0, behavior: "auto" });
  });
}

function applyPendingSettingsSubpageScrollReset() {
  if (!state.pendingSettingsSubpageScrollReset || isDesktopLayout() || !isSettingsSubpageOpen()) {
    return;
  }
  state.pendingSettingsSubpageScrollReset = false;
  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  });
}

function applyPendingSettingsScrollRestore() {
  if (!state.pendingSettingsScrollRestore || isDesktopLayout() || isSettingsSubpageOpen() || !state.settingsScrollState) {
    return;
  }
  state.pendingSettingsScrollRestore = false;
  const targetY = Number.isFinite(state.settingsScrollState.y) ? state.settingsScrollState.y : 0;
  requestAnimationFrame(() => {
    window.scrollTo({ top: targetY, left: 0, behavior: "auto" });
  });
}

function renderDeferredInteractionShellUpdates() {
  if (typeof document === "undefined") {
    return false;
  }
  if (state.currentTab === "settings") {
    return false;
  }
  const desktop = isDesktopLayout();
  // On mobile detail screens the list is intentionally not mounted, so the
  // latest state will appear as soon as the user backs out. On desktop the
  // list and detail are side-by-side, so updating only the list keeps new
  // timeline/inbox cards flowing without disturbing the detail pane.
  if (!desktop && state.detailOpen) {
    return false;
  }
  if (isListSurfaceInteractionActive()) {
    return false;
  }
  const listSurface = document.querySelector("[data-list-surface]");
  if (!listSurface) {
    return false;
  }
  const scrollLeft = listSurface.scrollLeft;
  const scrollTop = listSurface.scrollTop;
  listSurface.innerHTML = renderListPanel({
    tab: state.currentTab,
    entries: listEntriesForTab(state.currentTab),
    desktop,
  });
  listSurface.scrollLeft = scrollLeft;
  listSurface.scrollTop = scrollTop;
  bindPartialListSurfaceInteractions(listSurface);
  reportTimelineRendered("deferred-list");
  return true;
}

function isListSurfaceInteractionActive() {
  if (state.threadFilterInteractionUntilMs > Date.now() || state.timelineKindFilterOpen) {
    return true;
  }
  if (typeof document === "undefined" || typeof Element === "undefined") {
    return false;
  }
  const activeElement = document.activeElement;
  return activeElement instanceof Element && Boolean(activeElement.closest("[data-list-surface]"));
}

function currentViewportScrollY() {
  return window.scrollY || window.pageYOffset || document.documentElement?.scrollTop || 0;
}

function markThreadFilterInteraction() {
  state.threadFilterInteractionUntilMs = Date.now() + THREAD_FILTER_INTERACTION_DEFER_MS;
}

function clearThreadFilterInteraction() {
  state.threadFilterInteractionUntilMs = 0;
}

function markScrollableContentInteraction() {
  state.scrollableContentInteractionUntilMs = Date.now() + SCROLLABLE_CONTENT_INTERACTION_DEFER_MS;
}

function selectionIntersectsScrollableContent() {
  if (typeof document === "undefined" || typeof Element === "undefined") {
    return false;
  }
  const selection = document.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    const node = range.commonAncestorContainer;
    const element = node instanceof Element ? node : node?.parentElement;
    if (element?.closest?.(SCROLLABLE_CONTENT_SELECTORS)) {
      return true;
    }
  }
  return false;
}

function shouldDeferRenderForActiveInteraction() {
  const activeElement = document.activeElement;
  if (state.completionReplySheetToken) {
    return true;
  }
  if (state.scrollableContentInteractionUntilMs > Date.now()) {
    return true;
  }
  if (selectionIntersectsScrollableContent()) {
    return true;
  }
  if (
    activeElement instanceof HTMLTextAreaElement &&
    activeElement.matches("[data-completion-reply-textarea]") &&
    normalizeClientText(activeElement.dataset.replyToken) === normalizeClientText(state.currentItem?.token)
  ) {
    return true;
  }
  if (
    activeElement instanceof HTMLTextAreaElement &&
    activeElement.matches("[data-moltbook-draft-textarea]")
  ) {
    return true;
  }
  if (state.currentDetail?.kind === "moltbook_draft") {
    return true;
  }
  if (state.currentDetail?.kind === "thread_share" && state.currentDetail?.threadShareEnabled) {
    return true;
  }
  if (
    activeElement instanceof HTMLTextAreaElement &&
    activeElement.matches("[data-claude-question-note]")
  ) {
    return true;
  }
  if (
    activeElement instanceof HTMLInputElement &&
    activeElement.matches("[data-moltbook-draft-title]")
  ) {
    return true;
  }
  if (
    activeElement instanceof HTMLInputElement &&
    activeElement.matches("[data-hazbase-input]")
  ) {
    // User is mid-edit on the wallet sign-in email/OTP field. A poll tick
    // that re-renders here would blur the input and interrupt typing
    // (state mirroring restores value + caret position, but the blur
    // itself is still jarring, especially on iOS where it also dismisses
    // the keyboard).
    return true;
  }
  if (
    activeElement instanceof HTMLSelectElement &&
    activeElement.matches("[data-timeline-thread-select], [data-diff-thread-select], [data-completed-thread-select]")
  ) {
    return true;
  }
  if (state.timelineKindFilterOpen) {
    return true;
  }
  return state.threadFilterInteractionUntilMs > Date.now();
}

function normalizeChoiceAnswersMap(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  const output = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = String(key || "").trim();
    const normalizedValue = String(rawValue ?? "").trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    output[normalizedKey] = normalizedValue;
  }
  return output;
}

function getChoiceLocalDraft(token) {
  if (!token) {
    return {};
  }
  return normalizeChoiceAnswersMap(state.choiceLocalDrafts?.[token]);
}

function mergeChoiceLocalDraft(token, answers) {
  if (!token) {
    return;
  }
  const nextDraft = {
    ...getChoiceLocalDraft(token),
    ...normalizeChoiceAnswersMap(answers),
  };
  if (Object.keys(nextDraft).length === 0) {
    clearChoiceLocalDraft(token);
    return;
  }
  state.choiceLocalDrafts[token] = nextDraft;
}

function clearChoiceLocalDraft(token) {
  if (!token || !state.choiceLocalDrafts?.[token]) {
    return;
  }
  delete state.choiceLocalDrafts[token];
}

function clearChoiceLocalDraftForItem(itemRef) {
  if (itemRef?.kind !== "choice") {
    return;
  }
  clearChoiceLocalDraft(itemRef.token);
}

function getEffectiveChoiceDraftAnswers(detail) {
  return {
    ...normalizeChoiceAnswersMap(detail?.draftAnswers),
    ...getChoiceLocalDraft(detail?.token),
  };
}

function normalizeReplyMode(value) {
  return normalizeClientText(value).toLowerCase() === "plan" ? "plan" : "default";
}

function normalizeCompletionReplyAttachment(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const file = typeof File !== "undefined" && value.file instanceof File ? value.file : null;
  const name = normalizeClientText(value.name || file?.name || "");
  const type = normalizeClientText(value.type || file?.type || "");
  const size = Number(value.size ?? file?.size) || 0;
  const previewUrl = normalizeClientText(value.previewUrl || "");
  if (!file || !name || !type.startsWith("image/") || size <= 0) {
    return null;
  }
  return {
    file,
    name,
    type,
    size,
    previewUrl,
  };
}

function createCompletionReplyAttachment(file) {
  if (!(typeof File !== "undefined" && file instanceof File)) {
    return null;
  }
  if (!normalizeClientText(file.type).startsWith("image/")) {
    return null;
  }
  return normalizeCompletionReplyAttachment({
    file,
    name: file.name,
    type: file.type,
    size: file.size,
    previewUrl: typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(file)
      : "",
  });
}

function releaseCompletionReplyAttachment(attachment) {
  if (!attachment?.previewUrl || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    return;
  }
  try {
    URL.revokeObjectURL(attachment.previewUrl);
  } catch {
    // Ignore best-effort object URL cleanup errors.
  }
}

function getCompletionReplyDraft(token) {
  if (!token) {
    return {
      text: "",
      sentText: "",
      attachments: [],
      mode: "default",
      notice: "",
      error: "",
      warning: null,
      confirmOverride: false,
      collapsedAfterSend: false,
      sending: false,
    };
  }

  const draft = state.completionReplyDrafts?.[token] || {};
  return {
    text: String(draft.text ?? ""),
    sentText: normalizeClientText(draft.sentText ?? ""),
    attachments: normalizeCompletionReplyAttachments(draft.attachments ?? draft.attachment),
    mode: normalizeReplyMode(draft.mode),
    notice: normalizeClientText(draft.notice),
    error: normalizeClientText(draft.error),
    warning: normalizeCompletionReplyWarning(draft.warning),
    confirmOverride: draft.confirmOverride === true,
    collapsedAfterSend: draft.collapsedAfterSend === true,
    sending: draft.sending === true,
  };
}

function normalizeCompletionReplyWarning(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const createdAtMs = Number(value.createdAtMs) || 0;
  const summary = normalizeClientText(value.summary || "");
  const kind = normalizeClientText(value.kind || "");
  if (!createdAtMs && !summary && !kind) {
    return null;
  }
  return {
    createdAtMs,
    summary,
    kind,
  };
}

function normalizeCompletionReplyCompareText(value) {
  return normalizeClientText(value)
    .replace(/\s+/gu, " ")
    .trim();
}

function completionReplyWarningMatchesSentText(error, text, attachmentCount = 0) {
  if (error?.errorKey !== "completion-reply-thread-advanced") {
    return false;
  }
  if (attachmentCount > 0) {
    return false;
  }
  const warning = normalizeCompletionReplyWarning(error?.payload?.warning);
  const warningText = normalizeCompletionReplyCompareText(warning?.summary || "");
  const sentText = normalizeCompletionReplyCompareText(text);
  return Boolean(warningText && sentText && warningText === sentText);
}

function normalizeCompletionReplyAttachments(values) {
  const rawValues = Array.isArray(values)
    ? values
    : values
      ? [values]
      : [];
  return rawValues
    .map((value) => normalizeCompletionReplyAttachment(value))
    .filter(Boolean);
}

function setCompletionReplyDraft(token, partialDraft) {
  if (!token) {
    return;
  }
  const previousStoredDraft = state.completionReplyDrafts?.[token] || {};
  const previousAttachments = normalizeCompletionReplyAttachments(
    previousStoredDraft.attachments ?? previousStoredDraft.attachment
  );
  const nextDraft = {
    ...getCompletionReplyDraft(token),
    ...(partialDraft || {}),
  };
  const nextAttachments = Object.prototype.hasOwnProperty.call(partialDraft || {}, "attachments")
    ? normalizeCompletionReplyAttachments(partialDraft?.attachments)
    : Object.prototype.hasOwnProperty.call(partialDraft || {}, "attachment")
      ? normalizeCompletionReplyAttachments(partialDraft?.attachment)
      : normalizeCompletionReplyAttachments(nextDraft.attachments);
  const nextPreviewUrls = new Set(nextAttachments.map((attachment) => attachment.previewUrl).filter(Boolean));
  for (const previousAttachment of previousAttachments) {
    if (previousAttachment?.previewUrl && !nextPreviewUrls.has(previousAttachment.previewUrl)) {
      releaseCompletionReplyAttachment(previousAttachment);
    }
  }
  state.completionReplyDrafts[token] = {
    text: String(nextDraft.text ?? ""),
    sentText: normalizeClientText(nextDraft.sentText ?? ""),
    attachments: nextAttachments,
    mode: normalizeReplyMode(nextDraft.mode),
    notice: normalizeClientText(nextDraft.notice),
    error: normalizeClientText(nextDraft.error),
    warning: normalizeCompletionReplyWarning(nextDraft.warning),
    confirmOverride: nextDraft.confirmOverride === true,
    collapsedAfterSend: nextDraft.collapsedAfterSend === true,
    sending: nextDraft.sending === true,
  };
}

function clearCompletionReplyDraft(token) {
  if (!token || !state.completionReplyDrafts?.[token]) {
    return;
  }
  for (const attachment of normalizeCompletionReplyAttachments(
    state.completionReplyDrafts[token]?.attachments ?? state.completionReplyDrafts[token]?.attachment
  )) {
    releaseCompletionReplyAttachment(attachment);
  }
  delete state.completionReplyDrafts[token];
}

function clearAllCompletionReplyDrafts() {
  for (const token of Object.keys(state.completionReplyDrafts || {})) {
    clearCompletionReplyDraft(token);
  }
}

function syncCompletionReplyComposerLiveState(replyForm, draft) {
  if (!replyForm) {
    return;
  }
  const normalizedDraft = draft || {
    text: "",
    confirmOverride: false,
    sending: false,
  };
  const submitButton = replyForm.querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = normalizedDraft.sending === true || !normalizeClientText(normalizedDraft.text);
    if (!normalizedDraft.sending) {
      const providerAttr = replyForm.getAttribute("data-provider") || "";
      submitButton.textContent = L(
        normalizedDraft.confirmOverride ? "reply.sendConfirm" : "reply.send",
        { provider: providerDisplayName(providerAttr) },
      );
    }
  }

  const composer = replyForm.closest(".reply-composer");
  if (!composer) {
    return;
  }
  for (const alert of composer.querySelectorAll(".inline-alert--success, .inline-alert--danger, .inline-alert--warning")) {
    alert.remove();
  }
}

function renderDesktopHeader(detail) {
  return `
    <header class="app-header">
      <div class="brand-lockup">
        <span class="eyebrow-pill">${escapeHtml(L("common.codex"))}</span>
        <div class="brand-copy">
          <h1 class="brand-title">${escapeHtml(L("common.appName"))}</h1>
          <p class="brand-subtitle">${escapeHtml(subtitleForCurrentView(detail))}</p>
        </div>
      </div>
      ${renderDesktopTabs()}
    </header>
  `;
}

function renderMobileTopBar(detail) {
  if (isSettingsSubpageOpen()) {
    const page = settingsPageMeta(state.settingsSubpage);
    return `
      <header class="mobile-topbar mobile-topbar--detail">
        <button class="mobile-topbar__back" type="button" data-settings-back>
          <span class="mobile-topbar__back-icon" aria-hidden="true">${renderIcon("back")}</span>
          <span class="mobile-topbar__back-label">${escapeHtml(L("common.back"))}</span>
        </button>
        <div class="mobile-topbar__heading mobile-topbar__heading--detail">
          <span class="mobile-topbar__eyebrow">${escapeHtml(L("common.settings"))}</span>
          <h1 class="mobile-topbar__title mobile-topbar__title--detail">${escapeHtml(page.title)}</h1>
        </div>
      </header>
    `;
  }

  if (state.detailOpen && (detail || state.currentItem)) {
    const loadingDetail = detail || buildDetailLoadingSnapshot();
    const detailKind = kindMeta(loadingDetail.kind);
    return `
      <header class="mobile-topbar mobile-topbar--detail">
        <button class="mobile-topbar__back" type="button" data-back-to-list>
          <span class="mobile-topbar__back-icon" aria-hidden="true">${renderIcon("back")}</span>
          <span class="mobile-topbar__back-label">${escapeHtml(L("common.back"))}</span>
        </button>
        <div class="mobile-topbar__heading mobile-topbar__heading--detail">
          <span class="mobile-topbar__eyebrow mobile-topbar__eyebrow--kind">
            <span class="mobile-topbar__eyebrow-icon" aria-hidden="true">${renderIcon(detailKind.icon)}</span>
            <span>${escapeHtml(detailKind.label)}</span>
          </span>
          <h1 class="mobile-topbar__title mobile-topbar__title--detail">${escapeHtml(detailDisplayTitle(loadingDetail))}</h1>
        </div>
      </header>
    `;
  }

  const meta = tabMeta(state.currentTab);
  return `
    <header class="mobile-topbar">
      <div class="mobile-topbar__heading">
        <h1 class="mobile-topbar__title">${escapeHtml(meta.title)}</h1>
      </div>
    </header>
  `;
}

function renderableCurrentDetail(itemRef = state.currentItem) {
  if (!itemRef) {
    return null;
  }
  if (hasDetailOverride(itemRef)) {
    return state.detailOverride.detail;
  }
  if (state.currentDetail && isSameItemRef(state.currentDetail, itemRef)) {
    return state.currentDetail;
  }
  return null;
}

function selectedEntryForItem(itemRef = state.currentItem) {
  if (!itemRef) {
    return null;
  }
  return allSelectableEntries().find((entry) => isSameItemRef(entry.item, itemRef)) || null;
}

function buildDetailLoadingSnapshot(itemRef = state.currentItem) {
  if (!itemRef) {
    return null;
  }
  const entry = selectedEntryForItem(itemRef);
  const item = entry?.item || {};
  return {
    kind: itemRef.kind,
    token: itemRef.token,
    title: item.title || kindMeta(itemRef.kind).label,
    threadLabel: item.threadLabel || "",
    createdAtMs: Number(item.createdAtMs) || 0,
    readOnly:
      entry?.status === "completed" ||
      TIMELINE_MESSAGE_KINDS.has(itemRef.kind) ||
      (itemRef.kind === "choice" && item.supported === false),
    loading: true,
  };
}

async function fetchCurrentDetailForItem(itemRef = state.currentItem) {
  if (!itemRef) {
    return null;
  }
  if (hasDetailOverride(itemRef)) {
    return state.detailOverride.detail;
  }
  const detailUrl = `/api/items/${encodeURIComponent(itemRef.kind)}/${encodeURIComponent(itemRef.token)}`;
  try {
    const detail = await hydrateDetailImages(
      await apiGet(detailUrl, {
        timeoutMs: DETAIL_FETCH_TIMEOUT_MS,
        probeLanWhileSticky: true,
        stickyLanProbeTimeoutMs: DETAIL_STICKY_LAN_PROBE_TIMEOUT_MS,
        preferRelayError: true,
      })
    );
    if (hasLaunchItemIntent(itemRef)) {
      state.launchItemIntent.status = "loaded";
    }
    return detail;
  } catch (error) {
    if (error.status === 401) {
      state.session = null;
      state.currentDetail = null;
      renderPair();
      return null;
    }
    await Promise.race([
      refreshInbox(),
      wait(DETAIL_REFRESH_FALLBACK_TIMEOUT_MS),
    ]).catch(() => {});
    try {
      const detail = await hydrateDetailImages(
        await apiGet(detailUrl, {
          timeoutMs: DETAIL_FETCH_TIMEOUT_MS,
          probeLanWhileSticky: true,
          stickyLanProbeTimeoutMs: DETAIL_STICKY_LAN_PROBE_TIMEOUT_MS,
          preferRelayError: true,
        })
      );
      if (hasLaunchItemIntent(itemRef)) {
        state.launchItemIntent.status = "loaded";
      }
      return detail;
    } catch (retryError) {
      if (hasLaunchItemIntent(itemRef)) {
        clearChoiceLocalDraftForItem(itemRef);
        const fallbackDetail = buildLaunchItemFallbackDetail(itemRef);
        state.detailOverride = {
          ...itemRef,
          detail: fallbackDetail,
        };
        state.launchItemIntent.status = "resolved";
        return fallbackDetail;
      }
      ensureCurrentSelection();
      if (!state.currentItem) {
        return null;
      }
      return buildDetailLoadErrorDetail(itemRef, retryError || error);
    }
  }
}

function queueCurrentDetailLoad(itemRef = state.currentItem) {
  if (!itemRef || hasDetailOverride(itemRef)) {
    return;
  }
  if (state.currentDetailLoading && isSameItemRef(state.detailLoadingItem, itemRef)) {
    return;
  }

  const requestedItem = { ...itemRef };
  const requestId = ++detailLoadSequence;
  const hadRenderableDetailAtStart = Boolean(renderableCurrentDetail(requestedItem));
  state.currentDetailLoading = true;
  state.detailLoadingItem = requestedItem;

  fetchCurrentDetailForItem(requestedItem)
    .then((detail) => {
      if (requestId !== detailLoadSequence) {
        return;
      }
      if (!detail) {
        if (!state.currentItem || !isSameItemRef(state.currentItem, requestedItem)) {
          return;
        }
        state.currentDetail = null;
        return;
      }
      if (!state.currentItem || !isSameItemRef(state.currentItem, requestedItem)) {
        return;
      }
      state.currentDetail = detail;
    })
    .finally(() => {
      if (requestId !== detailLoadSequence) {
        return;
      }
      state.currentDetailLoading = false;
      state.detailLoadingItem = null;
      const completedInitialDetailLoad =
        !hadRenderableDetailAtStart &&
        Boolean(state.currentDetail) &&
        isSameItemRef(state.currentDetail, requestedItem) &&
        Boolean(state.currentItem) &&
        isSameItemRef(state.currentItem, requestedItem);
      if (shouldDeferRenderForActiveInteraction() && !completedInitialDetailLoad) {
        renderDeferredInteractionShellUpdates();
        return;
      }
      renderCurrentSurface();
    });
}

function buildLaunchItemFallbackDetail(itemRef) {
  const itemStillVisible = allInboxEntries().some((entry) => isSameItemRef(itemRef, entry.item));
  const isHandled = !itemStillVisible;
  const body = resolveLaunchFallbackMessage(itemRef.kind, isHandled);
  return {
    kind: itemRef.kind,
    token: itemRef.token,
    title: state.currentDetail?.title || kindMeta(itemRef.kind).label,
    messageHtml: `<p>${escapeHtml(body)}</p><p>${escapeHtml(L("server.page.notFoundHint"))}</p>`,
    readOnly: true,
    actions: [],
  };
}

function buildDetailLoadErrorDetail(itemRef, error) {
  const snapshot = buildDetailLoadingSnapshot(itemRef) || {};
  const entry = selectedEntryForItem(itemRef);
  const item = entry?.item || {};
  const fallbackText = normalizeClientText(item.messageText || item.summary || item.title || "");
  const messageParts = [
    fallbackText ? `<p>${escapeHtml(fallbackText)}</p>` : "",
  ].filter(Boolean);
  return {
    kind: itemRef.kind,
    token: itemRef.token,
    title: item.title || snapshot.title || kindMeta(itemRef.kind).label,
    threadId: item.threadId || "",
    threadLabel: item.threadLabel || snapshot.threadLabel || "",
    summary: item.summary || fallbackText || "",
    messageHtml: messageParts.join(""),
    provider: item.provider || normalizeProviderClient(item.provider) || "",
    createdAtMs: Number(item.createdAtMs || snapshot.createdAtMs) || Date.now(),
    readOnly: true,
    actions: [],
    loadError: true,
    loadErrorMessage: normalizeClientText(error?.message || String(error || "")),
  };
}

function resolveLaunchFallbackMessage(kind, isHandled) {
  if (kind === "approval") {
    return isHandled ? L("error.approvalAlreadyHandled") : L("error.approvalNotFound");
  }
  if (kind === "choice") {
    return isHandled ? L("error.choiceInputAlreadyHandled") : L("error.choiceInputNotFound");
  }
  return L("error.itemNotFound");
}

function shouldKeepDetailAfterAction(itemRef = state.currentItem) {
  return Boolean(itemRef && hasLaunchItemIntent(itemRef) && isFastPathItemRef(itemRef));
}

function pinActionOutcomeDetail(itemRef, detail) {
  if (!itemRef || !detail) {
    return;
  }
  state.currentItem = { ...itemRef };
  state.detailOverride = {
    ...itemRef,
    detail,
  };
  state.currentDetail = detail;
  state.detailOpen = true;
  if (hasLaunchItemIntent(itemRef)) {
    state.launchItemIntent.status = "resolved";
  }
}

function buildActionOutcomeDetail({ kind, title, message }) {
  return {
    kind,
    token: state.currentItem?.token || "",
    title: title || kindMeta(kind).label,
    messageHtml: `<p>${escapeHtml(message)}</p>`,
    readOnly: true,
    actions: [],
  };
}

function approvalOutcomeMessage(actionUrl, provider) {
  const vars = { provider: providerDisplayName(provider) };
  const normalizedUrl = String(actionUrl || "");
  if (/\/api\/payments\/x402\/hazbase-wallet\/[^/]+\/pay$/u.test(normalizedUrl)) {
    return L("server.message.paymentSubmitted");
  }
  return /\/accept$/u.test(normalizedUrl)
    ? L("server.message.approvalAccepted", vars)
    : L("server.message.approvalRejected", vars);
}

function renderDesktopWorkspace(detail) {
  if (state.currentTab === "settings") {
    return `<section class="screen-block">${renderSettingsDetail({ mobile: false })}</section>`;
  }

  const entries = listEntriesForTab(state.currentTab);
  const shouldShowLoading =
    Boolean(state.currentItem) &&
    !detail &&
    (state.currentDetailLoading || !renderableCurrentDetail());
  return `
    <section class="desktop-workspace">
      <aside class="surface surface--list" data-list-surface>
        ${renderListPanel({
          tab: state.currentTab,
          entries,
          desktop: true,
        })}
      </aside>
      <section class="surface surface--detail">
        ${detail ? renderDetailContent(detail, { mobile: false }) : shouldShowLoading ? renderDetailLoading({ mobile: false }) : renderDetailEmpty()}
      </section>
    </section>
  `;
}

function renderMobileWorkspace(detail) {
  if (state.currentTab === "settings") {
    return `<section class="screen-block ${isSettingsSubpageOpen() ? "screen-block--detail" : ""}">${renderSettingsDetail({ mobile: true })}</section>`;
  }

  if (state.detailOpen && detail) {
    return `<section class="screen-block screen-block--detail">${renderDetailContent(detail, { mobile: true })}</section>`;
  }

  if (state.detailOpen && state.currentItem) {
    return `<section class="screen-block screen-block--detail">${renderDetailLoading({ mobile: true })}</section>`;
  }

  return `
    <section class="screen-block" data-list-surface>
      ${renderListPanel({
        tab: state.currentTab,
        entries: listEntriesForTab(state.currentTab),
        desktop: false,
      })}
    </section>
  `;
}

function renderListPanel({ tab, entries, desktop }) {
  if (tab === "inbox") {
    return renderInboxPanel({ entries, desktop });
  }
  if (tab === "timeline") {
    return renderTimelinePanel({ entries, desktop });
  }
  if (tab === "diff") {
    return renderDiffPanel({ entries, desktop });
  }
  const meta = tabMeta(tab);
  if (!desktop) {
    return `
      <div class="screen-shell screen-shell--mobile">
        <div class="screen-header screen-header--mobile">
          <p class="screen-copy">${escapeHtml(meta.description)}</p>
          <span class="count-chip">${entries.length}</span>
        </div>
        ${
          entries.length
            ? `<div class="card-list">
                ${entries.map((entry) => renderItemCard(entry, tab, false)).join("")}
              </div>`
            : renderEmptyList(tab)
        }
      </div>
    `;
  }

  return `
    <div class="screen-shell">
      <div class="screen-header">
        <div>
          <p class="screen-eyebrow">${escapeHtml(meta.eyebrow)}</p>
          <h2 class="screen-title">${escapeHtml(meta.title)}</h2>
        </div>
        <span class="count-chip">${entries.length}</span>
      </div>
      <p class="screen-copy">${escapeHtml(meta.description)}</p>
      ${
        entries.length
          ? `<div class="card-list ${desktop ? "card-list--desktop" : ""}">
              ${entries.map((entry) => renderItemCard(entry, tab, true)).join("")}
            </div>`
          : renderEmptyList(tab)
      }
    </div>
  `;
}

function renderInboxPanel({ entries, desktop }) {
  const meta = tabMeta("inbox");
  const subtabControls = renderInboxSubtabs();
  const providerFilterHtml = renderProviderFilter();
  const threadFilterHtml = state.inboxSubtab === "completed" ? renderCompletedThreadDropdown() : "";
  const bodyHtml = entries.length
    ? `<div class="card-list ${desktop ? "card-list--desktop" : ""}">
        ${entries.map((entry) => renderItemCard(entry, "inbox", desktop)).join("")}
      </div>`
    : renderInboxEmptyState();

  if (!desktop) {
    return `
      <div class="screen-shell screen-shell--mobile">
        <div class="screen-header screen-header--mobile">
          <p class="screen-copy">${escapeHtml(meta.description)}</p>
          <span class="count-chip">${entries.length}</span>
        </div>
        ${subtabControls}
        ${providerFilterHtml}
        ${threadFilterHtml}
        ${bodyHtml}
      </div>
    `;
  }

  return `
    <div class="screen-shell">
      <div class="screen-header">
        <div>
          <p class="screen-eyebrow">${escapeHtml(meta.eyebrow)}</p>
          <h2 class="screen-title">${escapeHtml(meta.title)}</h2>
        </div>
        <span class="count-chip">${entries.length}</span>
      </div>
      <p class="screen-copy">${escapeHtml(meta.description)}</p>
      ${subtabControls}
      ${providerFilterHtml}
      ${threadFilterHtml}
      ${bodyHtml}
    </div>
  `;
}

function renderInboxSubtabs() {
  const pendingCount = pendingInboxCount();
  return `
    <div class="inbox-subtabs" role="tablist" aria-label="${escapeHtml(tabMeta("inbox").title)}">
      ${inboxSubtabOptions()
        .map(
          (option) => {
            const showPendingBadge = option.id === "pending" && pendingCount > 0;
            const badgeHtml = showPendingBadge
              ? `<span class="inbox-subtabs__badge" aria-hidden="true">${pendingCount}</span>`
              : "";
            const ariaLabel = showPendingBadge ? `${option.label} (${pendingCount})` : option.label;
            return `
            <button
              type="button"
              class="inbox-subtabs__button ${state.inboxSubtab === option.id ? "is-active" : ""}"
              data-inbox-subtab="${escapeHtml(option.id)}"
              role="tab"
              aria-selected="${state.inboxSubtab === option.id ? "true" : "false"}"
              aria-label="${escapeHtml(ariaLabel)}"
            >
              <span class="inbox-subtabs__button-label">${escapeHtml(option.label)}</span>
              ${badgeHtml}
            </button>
          `
          }
        )
        .join("")}
    </div>
  `;
}

function inboxSubtabOptions() {
  return [
    { id: "pending", label: L("inbox.subtab.pending") },
    { id: "completed", label: L("inbox.subtab.completed") },
  ];
}

function renderInboxEmptyState() {
  const isCompletedView = state.inboxSubtab === "completed";
  return `
    <div class="empty-state">
      <p class="empty-state__title">${escapeHtml(L(isCompletedView ? "inbox.subtab.completed" : "inbox.subtab.pending"))}</p>
      <p class="muted">${escapeHtml(L(isCompletedView ? "empty.completed" : "empty.pending"))}</p>
    </div>
  `;
}

function providerBadgeMeta(provider) {
  const normalized = normalizeProviderClient(provider);
  if (normalized === "claude") {
    return { id: "claude", label: L("common.claude"), glyph: "C" };
  }
  if (normalized === "moltbook") {
    return { id: "moltbook", label: "Moltbook", glyph: "M" };
  }
  if (normalized === "a2a") {
    return { id: "a2a", label: "A2A", glyph: "A" };
  }
  return { id: "codex", label: L("common.codex"), glyph: "X" };
}

function renderProviderBadge(provider) {
  const meta = providerBadgeMeta(provider);
  return `<span class="provider-badge provider-badge--${escapeHtml(meta.id)}" aria-label="${escapeHtml(meta.label)}" title="${escapeHtml(meta.label)}"><span class="provider-badge__icon" aria-hidden="true">${escapeHtml(meta.glyph)}</span><span class="provider-badge__label">${escapeHtml(meta.label)}</span></span>`;
}

function providerFilterOptions() {
  const options = [
    { id: "all", label: L("timeline.allThreads") },
    { id: "codex", label: L("common.codex") },
    { id: "claude", label: L("common.claude") },
  ];
  if (state.session?.moltbookEnabled === true) {
    options.push({ id: "moltbook", label: "Moltbook" });
  }
  if (state.session?.a2aEnabled === true) {
    options.push({ id: "a2a", label: "A2A" });
  }
  return options;
}

function renderProviderFilter() {
  const options = providerFilterOptions();
  const current = state.providerFilter || "all";
  return `
    <div class="provider-filter" role="tablist" aria-label="Provider filter">
      ${options
        .map(
          (option) => `
            <button
              type="button"
              class="provider-filter__button ${current === option.id ? "is-active" : ""}"
              data-provider-filter="${escapeHtml(option.id)}"
              role="tab"
              aria-selected="${current === option.id ? "true" : "false"}"
            >${escapeHtml(option.label)}</button>
          `
        )
        .join("")}
    </div>
  `;
}

const COMPLETED_CARD_KINDS = new Set(["assistant_final", "approval", "moltbook_reply", "moltbook_draft", "a2a_task_result", "thread_share"]);

function renderItemCard(entry, sourceTab, desktop) {
  if (entry.status === "completed" && COMPLETED_CARD_KINDS.has(entry.item.kind)) {
    return renderCompletedCompletionCard(entry, sourceTab);
  }
  const kindInfo = kindMeta(entry.item.kind, entry.item);
  const cardTitle = cardTitleForEntry(entry);
  const statusText = entry.status === "completed" ? L("common.completed") : L("common.actionNeeded");
  const intentText = itemIntentText(entry.item.kind, entry.status, entry.item.provider);
  const showCompletedTimestamp = entry.status === "completed" && sourceTab === "completed";
  const timestampLabel = showCompletedTimestamp ? formatTimelineTimestamp(entry.item.createdAtMs) : "";
  return `
    <button
      class="item-card item-card--${escapeHtml(kindInfo.tone)}"
      data-open-item-kind="${escapeHtml(entry.item.kind)}"
      data-open-item-token="${escapeHtml(entry.item.token)}"
      data-source-tab="${escapeHtml(sourceTab)}"
    >
      <div class="item-card__header">
        <div class="item-card__meta">
          <span class="type-pill type-pill--${escapeHtml(kindInfo.tone)}">${escapeHtml(kindInfo.label)}</span>
          ${renderProviderBadge(entry.item.provider)}
          ${
            desktop && sourceTab === "inbox"
              ? `<span class="status-pill status-pill--${escapeHtml(entry.status)}">${escapeHtml(statusText)}</span>`
              : ""
          }
        </div>
        <div class="item-card__header-right">
          ${timestampLabel ? `<span class="item-card__timestamp">${escapeHtml(timestampLabel)}</span>` : ""}
          <span class="item-card__chevron" aria-hidden="true">${renderIcon("chevron-right")}</span>
        </div>
      </div>
      <div class="item-card__content">
        <h3 class="item-card__title">${escapeHtml(cardTitle || L("common.untitledItem"))}</h3>
        <p class="item-card__intent">
          <span class="item-card__intent-icon" aria-hidden="true">${renderIcon(kindInfo.icon)}</span>
          <span>${escapeHtml(intentText)}</span>
        </p>
        <p class="item-card__summary">${escapeHtml(entry.item.summary || fallbackSummaryForKind(entry.item.kind, entry.status, entry.item.provider))}</p>
        ${
          !desktop && sourceTab === "inbox"
            ? `<p class="item-card__status-note">${escapeHtml(statusText)}</p>`
            : ""
        }
      </div>
    </button>
  `;
}

function cardTitleForEntry(entry) {
  const item = entry?.item || {};
  const rawTitle = normalizeClientText(item.title || "");
  if (!rawTitle) {
    return "";
  }
  if (item.kind !== "approval") {
    return rawTitle;
  }

  const threadLabel = resolvedThreadLabel(item.threadId || "", item.threadLabel || "");
  if (threadLabel) {
    return threadLabel;
  }

  const approvalPrefix = `${normalizeClientText(kindMeta("approval").label)} | `;
  if (approvalPrefix.trim() && rawTitle.startsWith(approvalPrefix)) {
    return normalizeClientText(rawTitle.slice(approvalPrefix.length)) || rawTitle;
  }
  return rawTitle;
}

function renderCompletedCompletionCard(entry, sourceTab) {
  const item = entry.item;
  const kindInfo = kindMeta(item.kind, item);
  const summaryText = item.summary || fallbackSummaryForKind(item.kind, entry.status, item.provider);
  const threadLabel = timelineEntryThreadLabel(item, true);
  const timestampLabel = formatTimelineTimestamp(item.createdAtMs);
  const pillLabel = item.kind === "completion" ? L("common.task") : kindInfo.label;
  const pillTone = item.kind === "completion" ? "completion" : kindInfo.tone;
  const compactSummary = normalizeClientText(summaryText);
  const useThreadAsPrimaryTitle = Boolean(threadLabel) && /^\d+$/u.test(compactSummary);
  const titleText = useThreadAsPrimaryTitle ? threadLabel : (summaryText || L("common.untitledItem"));
  const secondarySummaryHtml = useThreadAsPrimaryTitle
    ? `<p class="item-card__summary">${escapeHtml(summaryText)}</p>`
    : "";

  return `
    <button
      class="item-card item-card--${escapeHtml(kindInfo.tone)} item-card--completion-readonly"
      data-open-item-kind="${escapeHtml(item.kind)}"
      data-open-item-token="${escapeHtml(item.token)}"
      data-source-tab="${escapeHtml(sourceTab)}"
      data-source-subtab="completed"
    >
      <div class="item-card__header">
        <div class="item-card__meta">
          <span class="type-pill type-pill--${escapeHtml(pillTone)}">${escapeHtml(pillLabel)}</span>
          ${renderProviderBadge(item.provider)}
        </div>
        <div class="item-card__header-right">
          ${timestampLabel ? `<span class="item-card__timestamp">${escapeHtml(timestampLabel)}</span>` : ""}
          <span class="item-card__chevron" aria-hidden="true">${renderIcon("chevron-right")}</span>
        </div>
      </div>
      <div class="item-card__content">
        ${threadLabel ? `<p class="item-card__thread">${escapeHtml(threadLabel)}</p>` : ""}
        <h3 class="item-card__title">${escapeHtml(titleText)}</h3>
        ${secondarySummaryHtml}
      </div>
    </button>
  `;
}

function renderTimelinePanel({ entries, desktop }) {
  const meta = tabMeta("timeline");
  const listClassName = desktop ? "timeline-list timeline-list--desktop" : "timeline-list";
  const providerFilterHtml = renderProviderFilter();
  const threadsHtml = renderTimelineThreadDropdown();
  const bodyHtml = entries.length
    ? `<div class="${listClassName}">${entries.map((entry) => renderTimelineEntry(entry, { desktop })).join("")}</div>`
    : renderEmptyList("timeline");

  if (!desktop) {
    return `
      <div class="screen-shell screen-shell--mobile timeline-shell timeline-shell--mobile">
        <div class="screen-header screen-header--mobile">
          <p class="screen-copy">${escapeHtml(meta.description)}</p>
          <span class="count-chip">${entries.length}</span>
        </div>
        ${providerFilterHtml}
        ${threadsHtml}
        ${bodyHtml}
      </div>
    `;
  }

  return `
    <div class="screen-shell timeline-shell">
      <div class="screen-header">
        <div>
          <p class="screen-eyebrow">${escapeHtml(meta.eyebrow)}</p>
          <h2 class="screen-title">${escapeHtml(meta.title)}</h2>
        </div>
        <span class="count-chip">${entries.length}</span>
      </div>
      <p class="screen-copy">${escapeHtml(meta.description)}</p>
      ${providerFilterHtml}
      ${threadsHtml}
      ${bodyHtml}
    </div>
  `;
}

function renderDiffPanel({ entries, desktop }) {
  const meta = tabMeta("diff");
  const listClassName = desktop ? "diff-list diff-list--desktop" : "diff-list";
  let bodyHtml;
  if (entries.length) {
    bodyHtml = `<div class="${listClassName}">${entries.map((entry) => renderDiffEntry(entry)).join("")}</div>`;
  } else if (!state.inboxDiffLoaded) {
    // First /api/inbox/diff still in flight — show shimmer cards so the
    // user sees something is happening instead of "no entries".
    bodyHtml = renderDiffSkeleton(listClassName);
  } else {
    bodyHtml = renderEmptyList("diff");
  }

  if (!desktop) {
    return `
      <div class="screen-shell screen-shell--mobile diff-shell diff-shell--mobile">
        <div class="screen-header screen-header--mobile">
          <p class="screen-copy">${escapeHtml(meta.description)}</p>
          <span class="count-chip">${entries.length}</span>
        </div>
        ${bodyHtml}
      </div>
    `;
  }

  return `
    <div class="screen-shell diff-shell">
      <div class="screen-header">
        <div>
          <p class="screen-eyebrow">${escapeHtml(meta.eyebrow)}</p>
          <h2 class="screen-title">${escapeHtml(meta.title)}</h2>
        </div>
        <span class="count-chip">${entries.length}</span>
      </div>
      <p class="screen-copy">${escapeHtml(meta.description)}</p>
      ${bodyHtml}
    </div>
  `;
}

// Placeholder shimmer shown while the first /api/inbox/diff response is
// pending. Shape mirrors `.diff-entry` so the tab doesn't visually jump when
// real entries land. Three cards with decreasing prominence is enough to
// signal activity without pretending to be a specific number of results.
function renderDiffSkeleton(listClassName) {
  const card = `
    <div class="diff-entry diff-entry--skeleton" aria-hidden="true">
      <div class="diff-entry__header">
        <span class="diff-skeleton-line diff-skeleton-line--thread"></span>
        <span class="diff-skeleton-line diff-skeleton-line--time"></span>
      </div>
      <span class="diff-skeleton-line diff-skeleton-line--title"></span>
      <div class="diff-entry__files">
        <span class="diff-skeleton-chip"></span>
        <span class="diff-skeleton-chip diff-skeleton-chip--narrow"></span>
      </div>
    </div>
  `;
  return `
    <div class="${listClassName}" role="status" aria-busy="true" aria-label="${escapeHtml(L("common.loading"))}">
      ${card}${card}${card}
    </div>
  `;
}

function timelineThreadsForProvider(provider) {
  const entries = Array.isArray(state.timeline?.entries) ? state.timeline.entries : [];
  const byThread = new Map();
  for (const entry of entries) {
    const threadId = entry.threadId || "";
    if (!threadId) continue;
    if (normalizeProviderClient(entry.provider) !== provider) continue;
    const latestAtMs = Number(entry.createdAtMs) || 0;
    const label = entry.threadLabel || "";
    const existing = byThread.get(threadId);
    if (!existing || latestAtMs > existing.latestAtMs) {
      byThread.set(threadId, { id: threadId, label, latestAtMs });
    }
  }
  return [...byThread.values()]
    .sort((a, b) => b.latestAtMs - a.latestAtMs)
    .map((t) => ({ id: t.id, label: dropdownThreadLabel(t.id, t.label) }));
}

function renderTimelineThreadDropdown() {
  const provider = state.providerFilter || "all";
  const kindFilterHtml = renderTimelineKindFilterControls();

  let threads;
  if (provider === "all") {
    // "All" view — use the server-provided thread list
    threads = (Array.isArray(state.timeline?.threads) ? state.timeline.threads : []).map((thread) => ({
      id: thread.id,
      label: dropdownThreadLabel(thread.id, thread.label || ""),
    }));
  } else {
    // Provider-specific view — build from entries matching this provider
    threads = timelineThreadsForProvider(provider);
  }

  return renderThreadDropdown({
    inputId: "timeline-thread-select",
    dataAttribute: "data-timeline-thread-select",
    selectedThreadId: state.timelineThreadFilter,
    controlsHtml: kindFilterHtml,
    threads,
  });
}

function renderCompletedThreadDropdown() {
  return renderThreadDropdown({
    inputId: "completed-thread-select",
    dataAttribute: "data-completed-thread-select",
    selectedThreadId: state.completedThreadFilter,
    threads: completedThreads(),
  });
}

function renderDiffThreadDropdown() {
  return renderThreadDropdown({
    inputId: "diff-thread-select",
    dataAttribute: "data-diff-thread-select",
    selectedThreadId: state.diffThreadFilter,
    threads: diffThreads(),
  });
}

function renderThreadDropdown({ inputId, dataAttribute, selectedThreadId, threads, controlsHtml = "" }) {
  const options = [
    {
      id: "all",
      label: L("timeline.allThreads"),
    },
    ...threads.map((thread) => ({
      id: thread.id,
      label: dropdownThreadLabel(thread.id, thread.label || ""),
    })),
  ];

  return `
    <div class="timeline-thread-filter">
      <label class="timeline-thread-filter__label" for="${escapeHtml(inputId)}">${escapeHtml(L("timeline.filterLabel"))}</label>
      <div class="timeline-thread-filter__row">
        <div class="timeline-thread-select-wrap">
          <select id="${escapeHtml(inputId)}" class="timeline-thread-select" ${dataAttribute}>
            ${options
              .map(
                (thread) => `
                  <option value="${escapeHtml(thread.id)}" ${selectedThreadId === thread.id ? "selected" : ""}>
                    ${escapeHtml(thread.label)}
                  </option>
                `
              )
              .join("")}
          </select>
          <span class="timeline-thread-select__chevron" aria-hidden="true">${renderIcon("chevron-down")}</span>
        </div>
        ${controlsHtml}
      </div>
    </div>
  `;
}

function renderTimelineKindFilterControls() {
  const current = currentTimelineKindFilterOption();
  const options = timelineKindFilterOptions();
  return `
    <div class="timeline-kind-filter" data-timeline-kind-filter-root>
      <button
        type="button"
        class="timeline-kind-filter__button ${current.id !== "all" ? "is-active" : ""}"
        data-timeline-kind-filter-toggle
        aria-expanded="${state.timelineKindFilterOpen ? "true" : "false"}"
        aria-label="${escapeHtml(L("timeline.kindFilterButtonLabel"))}"
      >
        <span class="timeline-kind-filter__button-icon" aria-hidden="true">${renderIcon(current.icon)}</span>
      </button>
      ${
        state.timelineKindFilterOpen
          ? `
            <div class="timeline-kind-filter__popover" role="menu" aria-label="${escapeHtml(L("timeline.kindFilterLabel"))}">
              ${options
                .map(
                  (option) => `
                    <button
                      type="button"
                      class="timeline-kind-filter__option ${option.id === current.id ? "is-selected" : ""}"
                      data-timeline-kind-filter-option="${escapeHtml(option.id)}"
                      role="menuitemradio"
                      aria-checked="${option.id === current.id ? "true" : "false"}"
                    >
                      <span class="timeline-kind-filter__option-icon" aria-hidden="true">${renderIcon(option.icon)}</span>
                      <span class="timeline-kind-filter__option-label">${escapeHtml(option.label)}</span>
                      <span class="timeline-kind-filter__option-check" aria-hidden="true">${
                        option.id === current.id ? renderIcon("check") : ""
                      }</span>
                    </button>
                  `
                )
                .join("")}
            </div>
          `
          : ""
      }
    </div>
  `;
}

function renderTimelineEntry(entry, { desktop }) {
  const item = entry.item;
  const kindInfo = kindMeta(item.kind, item);
  const kindClassName = escapeHtml(kindInfo.tone || "neutral");
  const kindNameClass = escapeHtml(String(item.kind || "item").replace(/_/gu, "-"));
  const isMoltbookOrA2A = item.kind === "moltbook_reply" || item.kind === "moltbook_draft" || item.kind === "a2a_task" || item.kind === "a2a_task_result" || item.kind === "thread_share";
  const isMessageLike = TIMELINE_MESSAGE_KINDS.has(item.kind) || isMoltbookOrA2A;
  const isFileEvent = item.kind === "file_event";
  const isCommandEvent = item.kind === "command_event";
  const imageUrls = Array.isArray(item.imageUrls) ? item.imageUrls.filter(Boolean) : [];
  const fileRefs = normalizeClientFileRefs(item.fileRefs);
  const primaryText = timelineEntryPrimaryText(item, entry.status, { isMessageLike, isFileEvent, isCommandEvent });
  const secondaryText = timelineEntrySecondaryText(item, entry.status, primaryText, { isMessageLike, isFileEvent, isCommandEvent });
  const threadLabel = timelineEntryThreadLabel(item, isMessageLike);
  const timestampLabel = formatTimelineTimestamp(item.createdAtMs);
  const statusLabel = timelineEntryStatusLabel(item, isMessageLike);
  const fileEventFileSummary = isFileEvent ? timelineFileEventFileSummary(item) : "";
  const fileEventDiffStatsHtml = isFileEvent ? renderDiffEntryStatsHtml(item) : "";
  const commandEventCommand = isCommandEvent ? timelineCommandEventCommand(item) : "";

  return `
    <button
      class="timeline-entry timeline-entry--${kindClassName} timeline-entry--kind-${kindNameClass} ${isMessageLike ? "timeline-entry--message" : "timeline-entry--operational"}"
      data-open-item-kind="${escapeHtml(item.kind)}"
      data-open-item-token="${escapeHtml(item.token)}"
      data-source-tab="timeline"
    >
      <div class="timeline-entry__meta">
        <span class="timeline-entry__kind">
          <span class="timeline-entry__kind-icon" aria-hidden="true">${renderIcon(kindInfo.icon)}</span>
          <span>${escapeHtml(kindInfo.label)}</span>
          ${renderProviderBadge(item.provider)}
        </span>
        <span class="timeline-entry__meta-right">
          <span class="timeline-entry__time">${escapeHtml(timestampLabel)}</span>
          <span class="timeline-entry__chevron" aria-hidden="true">${renderIcon("chevron-right")}</span>
        </span>
      </div>
      ${threadLabel ? `<p class="timeline-entry__thread">${escapeHtml(threadLabel)}</p>` : ""}
      <div class="timeline-entry__body">
        <p class="timeline-entry__title">${escapeHtml(primaryText)}</p>
        ${commandEventCommand ? `<pre class="timeline-entry__command"><code>${escapeHtml(commandEventCommand)}</code></pre>` : ""}
        ${secondaryText ? `<p class="timeline-entry__summary">${escapeHtml(secondaryText)}</p>` : ""}
        ${
          isFileEvent && fileEventFileSummary
            ? `<p class="timeline-entry__file-summary" title="${escapeHtml(
                normalizeClientFileChangeEntries(item)
                  .map((entry) => fileChangeEntryTitle(entry))
                  .join("\n")
              )}">${escapeHtml(fileEventFileSummary)}</p>`
            : ""
        }
        ${isFileEvent && fileEventDiffStatsHtml ? `<div class="timeline-entry__file-diff-stats diff-entry__stats">${fileEventDiffStatsHtml}</div>` : ""}
        ${renderTimelineEntryImageStrip(imageUrls)}
        ${isFileEvent ? "" : renderTimelineEntryFileStrip(fileRefs)}
      </div>
      ${statusLabel ? `<div class="timeline-entry__footer"><span class="timeline-entry__status">${escapeHtml(statusLabel)}</span></div>` : ""}
    </button>
  `;
}

function renderDiffEntry(entry) {
  const item = entry.item;
  const threadLabel = diffThreadCardTitle(item);
  const fileChipsHtml = renderDiffEntryFileChips(item);
  const fallbackSummary = fileChipsHtml ? "" : diffThreadSummaryLabel(item);
  const statsHtml = renderDiffEntryStatsHtml(item);
  const latestChangeSummary = diffThreadLatestChangeSummary(item);

  return `
    <button
      class="diff-entry diff-entry--thread"
      data-open-item-kind="${escapeHtml(item.kind)}"
      data-open-item-token="${escapeHtml(item.token)}"
      data-source-tab="diff"
    >
      <div class="diff-entry__header">
        <p class="timeline-entry__thread diff-entry__thread">${escapeHtml(threadLabel)}</p>
        <span class="diff-entry__chevron" aria-hidden="true">${renderIcon("chevron-right")}</span>
      </div>
      <div class="diff-entry__body">
        ${fileChipsHtml ? `<div class="diff-entry__files">${fileChipsHtml}</div>` : ""}
        ${fallbackSummary ? `<p class="diff-entry__title">${escapeHtml(fallbackSummary)}</p>` : ""}
        ${statsHtml ? `<div class="diff-entry__stats">${statsHtml}</div>` : ""}
        ${latestChangeSummary ? `<p class="diff-entry__summary">${escapeHtml(latestChangeSummary)}</p>` : ""}
      </div>
    </button>
  `;
}

function timelineEntryStatusLabel(item, isMessageLike) {
  if (isMessageLike || item?.kind === "file_event" || item?.kind === "command_event") {
    return "";
  }

  const outcome = normalizeClientText(item?.outcome || "");
  switch (outcome) {
    case "pending":
      return L("common.actionNeeded");
    case "approved":
      return L("timeline.status.approved");
    case "rejected":
      return L("timeline.status.rejected");
    case "failed":
      return L("timeline.status.failed");
    case "implemented":
      return L("timeline.status.implemented");
    case "dismissed":
      return L("timeline.status.dismissed");
    case "submitted":
      return L("timeline.status.submitted");
    default:
      break;
  }

  if (item?.kind === "approval" || item?.kind === "plan" || item?.kind === "plan_ready" || item?.kind === "choice") {
    return L("common.actionNeeded");
  }
  return "";
}

function renderTimelineEntryImageStrip(imageUrls) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return "";
  }

  return `
    <div class="timeline-entry__images" aria-hidden="true">
      ${imageUrls
        .slice(0, 4)
        .map(
          (imageUrl, index) => `
            <span class="timeline-entry__image-frame">
              <img
                class="timeline-entry__image"
                src="${escapeHtml(imageUrl)}"
                alt="${escapeHtml(L("detail.imageAlt", { index: index + 1 }))}"
                loading="lazy"
              >
            </span>
          `
        )
        .join("")}
    </div>
  `;
}

function renderTimelineEntryFileStrip(fileRefs) {
  if (!Array.isArray(fileRefs) || fileRefs.length === 0) {
    return "";
  }

  return `
    <div class="timeline-entry__files" aria-label="${escapeHtml(L("detail.filesTitle"))}">
      ${fileRefs
        .slice(0, 4)
        .map(
          (fileRef) => `
            <span class="file-ref-chip" title="${escapeHtml(fileRef)}">
              <span class="file-ref-chip__icon" aria-hidden="true">${renderIcon("item")}</span>
              <span class="file-ref-chip__label">${escapeHtml(fileRefLabel(fileRef))}</span>
            </span>
          `
        )
        .join("")}
    </div>
  `;
}

function timelineEntryThreadLabel(item, isMessage) {
  const threadLabel = resolvedThreadLabel(item.threadId || "", item.threadLabel || "");
  return threadLabel || "";
}

function timelineEntryPrimaryText(item, status, { isMessageLike = false, isFileEvent = false, isCommandEvent = false } = {}) {
  if (item?.kind === "ambient_suggestions") {
    return item.summary || fallbackSummaryForKind(item.kind, status, item.provider);
  }

  if (isMessageLike) {
    return item.summary || fallbackSummaryForKind(item.kind, status, item.provider);
  }

  if (isFileEvent) {
    return fileEventTimelineCountLabel(item) || fallbackSummaryForKind(item.kind, status, item.provider);
  }

  if (isCommandEvent) {
    return L("common.commandEvent");
  }

  return timelineDisplayTitleWithoutThread(item, { allowFallbackSummary: true }) || L("common.untitledItem");
}

function timelineEntrySecondaryText(item, status, primaryText, { isMessageLike = false, isFileEvent = false, isCommandEvent = false } = {}) {
  if (item?.kind === "ambient_suggestions") {
    return "";
  }

  if (isMessageLike) {
    return "";
  }

  const summaryText = normalizeClientText(item.summary || fallbackSummaryForKind(item.kind, status, item.provider));
  if (!summaryText || summaryText === normalizeClientText(primaryText || "")) {
    return "";
  }

  if (isFileEvent) {
    return "";
  }

  if (isCommandEvent) {
    return "";
  }

  const compactTitle = timelineDisplayTitleWithoutThread(item, { allowFallbackSummary: false });
  return compactTitle ? summaryText : "";
}

function timelineDisplayTitleWithoutThread(item, { allowFallbackSummary = false } = {}) {
  const rawTitle = normalizeClientText(item?.title || "");
  const threadLabel = resolvedThreadLabel(item?.threadId || "", item?.threadLabel || "");
  if (!rawTitle) {
    return allowFallbackSummary ? normalizeClientText(item?.summary || "") : "";
  }

  let displayTitle = rawTitle;
  const removablePrefixes = timelineGeneratedTitlePrefixes();
  const hadGeneratedPrefix = removablePrefixes.some((prefix) => {
    const normalizedPrefix = normalizeClientText(prefix || "");
    return normalizedPrefix && rawTitle.startsWith(`${normalizedPrefix} | `);
  });

  for (const prefix of removablePrefixes) {
    const normalizedPrefix = normalizeClientText(prefix || "");
    if (normalizedPrefix && displayTitle.startsWith(`${normalizedPrefix} | `)) {
      displayTitle = normalizeClientText(displayTitle.slice(normalizedPrefix.length + 3));
      break;
    }
  }

  if (hadGeneratedPrefix) {
    if (!displayTitle || (threadLabel && displayTitle === threadLabel)) {
      return allowFallbackSummary ? normalizeClientText(item?.summary || "") : "";
    }
  }

  if (threadLabel && displayTitle === threadLabel) {
    return allowFallbackSummary ? normalizeClientText(item?.summary || "") : "";
  }

  return displayTitle || (allowFallbackSummary ? normalizeClientText(item?.summary || "") : "");
}

function timelineGeneratedTitlePrefixes() {
  return [
    kindMeta("approval").label,
    kindMeta("plan").label,
    kindMeta("choice").label,
    kindMeta("completion").label,
    kindMeta("user_message").label,
    kindMeta("assistant_commentary").label,
    kindMeta("assistant_final").label,
    L("common.fileEvent"),
    L("common.commandEvent"),
    "Approval",
    "Plan",
    "Choice",
    "Completed",
    "User message",
    "Commentary",
    "Final answer",
    "Files",
    "Command",
    "承認",
    "プラン",
    "選択",
    "完了",
    "メッセージ",
    "途中経過",
    "最終回答",
    "ファイル",
    "コマンド",
  ];
}

function timelineCommandEventCommand(item) {
  return truncateUiText(firstMarkdownCodeFence(item?.messageText || "") || item?.summary || item?.title || "", 220);
}

function fileEventDisplayLabel(fileEventType) {
  switch (normalizeClientText(fileEventType || "")) {
    case "read":
      return L("fileEvent.read");
    case "search":
      return L("fileEvent.search");
    case "command":
      return L("fileEvent.command");
    case "write":
      return L("fileEvent.write");
    case "create":
      return L("fileEvent.create");
    case "delete":
      return L("fileEvent.delete");
    case "rename":
      return L("fileEvent.rename");
    default:
      return "";
  }
}

function fileEventTimelineCountLabel(item) {
  const fileEventType = normalizeClientText(item?.fileEventType || "");
  const count = normalizeClientFileRefs(item?.fileRefs).length;
  if (count <= 0) {
    return fileEventDisplayLabel(fileEventType) || L("common.fileEvent");
  }
  switch (fileEventType) {
    case "read":
      return L("fileEvent.timeline.read", { count });
    case "search":
      return L("fileEvent.timeline.search", { count });
    case "command":
      return L("fileEvent.timeline.command", { count });
    case "write":
      return L("fileEvent.timeline.write", { count });
    case "create":
      return L("fileEvent.timeline.create", { count });
    case "delete":
      return L("fileEvent.timeline.delete", { count });
    case "rename":
      return L("fileEvent.timeline.rename", { count });
    default:
      return L("common.fileEvent");
  }
}

function diffThreadSummaryLabel(item) {
  const count = Math.max(0, Number(item?.changedFileCount) || 0);
  if (count <= 0) {
    return L("common.diff");
  }
  return L("diff.threadSummary", { count });
}

function diffThreadCardTitle(item) {
  return resolvedThreadLabel(item?.threadId || "", item?.threadLabel || "") || L("timeline.unknownThread");
}

function diffThreadCardSummary(item) {
  const parts = [];
  const filesLabel = diffThreadFilesSummary(item);
  if (filesLabel) {
    parts.push(filesLabel);
  } else {
    const summaryLabel = diffThreadSummaryLabel(item);
    if (summaryLabel && summaryLabel !== L("common.diff")) {
      parts.push(summaryLabel);
    }
  }
  const statsLabel = diffEntryStatsLabel(item);
  if (statsLabel) {
    parts.push(statsLabel);
  }
  return parts.join(" • ");
}

function diffThreadFilesSummary(item) {
  const labels = normalizeClientFileChangeEntries(item)
    .map((entry) => fileChangeEntryLabel(entry))
    .filter(Boolean);
  if (labels.length === 0) {
    return truncateUiText(firstMarkdownCodeFence(item?.messageText || "") || item?.summary || "");
  }
  const visibleLabels = labels.slice(0, 3);
  const hiddenCount = labels.length - visibleLabels.length;
  if (hiddenCount > 0) {
    visibleLabels.push(`+${hiddenCount}`);
  }
  return visibleLabels.join(", ");
}

function diffThreadLatestChangeSummary(item) {
  const prefix = L("diff.latestChange");
  const timestampLabel = formatDiffCardTimestamp(item?.latestChangedAtMs || item?.createdAtMs);
  if (timestampLabel) {
    return `${prefix}: ${timestampLabel}`;
  }
  if (Number(item?.latestChangedAtMs) > 0 || Number(item?.createdAtMs) > 0) {
    return L("diff.latestChangeFallback");
  }
  return "";
}

function renderDiffEntryFileChips(item) {
  const fileEntries = normalizeClientFileChangeEntries(item);
  if (fileEntries.length === 0) {
    return "";
  }
  const visibleEntries = fileEntries.slice(0, 4);
  const hiddenCount = fileEntries.length - visibleEntries.length;
  const chips = visibleEntries.map(
    (entry) => `
      <span class="file-ref-chip" title="${escapeHtml(fileChangeEntryTitle(entry))}">
        <span class="file-ref-chip__icon" aria-hidden="true">${renderIcon("item")}</span>
        <span class="file-ref-chip__label">${escapeHtml(fileChangeEntryLabel(entry))}</span>
      </span>
    `
  );
  if (hiddenCount > 0) {
    chips.push(`
      <span class="file-ref-chip file-ref-chip--count">
        <span class="file-ref-chip__label">+${hiddenCount}</span>
      </span>
    `);
  }
  return chips.join("");
}

function renderDiffEntryStatsHtml(item) {
  const addedLines = Math.max(0, Number(item?.diffAddedLines ?? item?.addedLines) || 0);
  const removedLines = Math.max(0, Number(item?.diffRemovedLines ?? item?.removedLines) || 0);
  if (!addedLines && !removedLines) {
    return "";
  }
  const parts = [];
  if (addedLines) {
    parts.push(`<span class="diff-entry__stat diff-entry__stat--added">+${escapeHtml(String(addedLines))}</span>`);
  }
  if (removedLines) {
    parts.push(`<span class="diff-entry__stat diff-entry__stat--removed">-${escapeHtml(String(removedLines))}</span>`);
  }
  return parts.join('<span class="diff-entry__stats-separator">/</span>');
}

function formatDiffCardTimestamp(value) {
  const timestamp = Number(value) || 0;
  if (!timestamp) {
    return "";
  }
  try {
    return new Intl.DateTimeFormat(state.locale || DEFAULT_LOCALE, {
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

function normalizeClientFileChangeEntries(item) {
  const files = Array.isArray(item?.files) ? item.files.filter(Boolean) : [];
  if (files.length > 0) {
    return files
      .map((file) => ({
        fileRef: normalizeClientText(file?.fileRef || file?.newFileRef || ""),
        oldFileRef: normalizeClientText(file?.oldFileRef || ""),
        newFileRef: normalizeClientText(file?.newFileRef || file?.fileRef || ""),
        changeType: normalizeClientText(file?.changeType || file?.fileEventType || ""),
      }))
      .filter((entry) => entry.fileRef || entry.oldFileRef || entry.newFileRef);
  }

  const fileEventType = normalizeClientText(item?.changeType || item?.fileEventType || "");
  const fileRefs = normalizeClientFileRefs(item?.fileRefs);
  const previousFileRefs = normalizeClientFileRefs(item?.previousFileRefs);
  if (fileEventType === "rename") {
    const pairCount = Math.max(fileRefs.length, previousFileRefs.length);
    return Array.from({ length: pairCount }, (_, index) => ({
      fileRef: normalizeClientText(fileRefs[index] || previousFileRefs[index] || ""),
      oldFileRef: normalizeClientText(previousFileRefs[index] || ""),
      newFileRef: normalizeClientText(fileRefs[index] || ""),
      changeType: fileEventType,
    })).filter((entry) => entry.fileRef || entry.oldFileRef || entry.newFileRef);
  }

  return fileRefs.map((fileRef) => ({
    fileRef,
    oldFileRef: "",
    newFileRef: fileEventType === "delete" ? "" : fileRef,
    changeType: fileEventType,
  }));
}

function fileChangeEntryLabel(entry) {
  const changeType = normalizeClientText(entry?.changeType || "");
  const oldFileRef = normalizeClientText(entry?.oldFileRef || "");
  const newFileRef = normalizeClientText(entry?.newFileRef || entry?.fileRef || "");
  if (changeType === "rename" && oldFileRef && newFileRef) {
    return `${fileRefLabel(oldFileRef)} → ${fileRefLabel(newFileRef)}`;
  }
  return fileRefLabel(changeType === "delete" ? oldFileRef || newFileRef : newFileRef || oldFileRef);
}

function fileChangeEntryTitle(entry) {
  const changeType = normalizeClientText(entry?.changeType || "");
  const oldFileRef = normalizeClientText(entry?.oldFileRef || "");
  const newFileRef = normalizeClientText(entry?.newFileRef || entry?.fileRef || "");
  if (changeType === "rename" && oldFileRef && newFileRef) {
    return `${oldFileRef} → ${newFileRef}`;
  }
  return changeType === "delete" ? oldFileRef || newFileRef : newFileRef || oldFileRef;
}

function diffThreadFileExpansionKey(token, fileRef) {
  return `${normalizeClientText(token || "")}:${normalizeClientText(fileRef || "")}`;
}

function isDiffThreadFileExpanded(token, fileRef) {
  const key = diffThreadFileExpansionKey(token, fileRef);
  return state.diffThreadExpandedFiles?.[key] === true;
}

function toggleDiffThreadFileExpanded(token, fileRef) {
  const key = diffThreadFileExpansionKey(token, fileRef);
  if (!key || key === ":") {
    return;
  }
  state.diffThreadExpandedFiles = {
    ...(state.diffThreadExpandedFiles || {}),
    [key]: !isDiffThreadFileExpanded(token, fileRef),
  };
}

function detailDiffExpansionKey(detail) {
  return `${normalizeClientText(detail?.kind || "")}:${normalizeClientText(detail?.token || "")}`;
}

function isDetailDiffExpanded(detail) {
  const key = detailDiffExpansionKey(detail);
  return Boolean(key && state.detailDiffExpanded?.[key] === true);
}

function toggleDetailDiffExpanded(detail) {
  const key = detailDiffExpansionKey(detail);
  if (!key || key === ":") {
    return;
  }
  state.detailDiffExpanded = {
    ...(state.detailDiffExpanded || {}),
    [key]: !isDetailDiffExpanded(detail),
  };
}

function timelineFileEventFileSummary(item) {
  const labels = normalizeClientFileChangeEntries(item)
    .map((entry) => fileChangeEntryLabel(entry))
    .filter(Boolean);
  if (labels.length === 0) {
    return "";
  }
  const visibleLabels = labels.slice(0, 3);
  const hiddenCount = labels.length - visibleLabels.length;
  if (hiddenCount > 0) {
    visibleLabels.push(`+${hiddenCount}`);
  }
  return visibleLabels.join(", ");
}

function diffEntryStatsLabel(item) {
  const addedLines = Math.max(0, Number(item?.diffAddedLines ?? item?.addedLines) || 0);
  const removedLines = Math.max(0, Number(item?.diffRemovedLines ?? item?.removedLines) || 0);
  if (!addedLines && !removedLines) {
    return "";
  }
  return `+${addedLines} / -${removedLines}`;
}

function sanitizeThreadLabelForDisplay(label = "", threadId = "") {
  const normalizedLabel = normalizeClientText(label || "");
  if (!normalizedLabel) {
    return "";
  }

  const normalizedThreadId = normalizeClientText(threadId || "");
  if (normalizedThreadId && (normalizedLabel === normalizedThreadId || normalizedLabel === normalizedThreadId.slice(0, 8))) {
    return "";
  }

  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}$/i.test(normalizedLabel)) {
    return "";
  }

  if (looksLikeGeneratedThreadTitle(normalizedLabel)) {
    return "";
  }

  return normalizedLabel;
}

function looksLikeGeneratedThreadTitle(label = "") {
  const normalizedLabel = normalizeClientText(label || "");
  if (!normalizedLabel.includes("|")) {
    return false;
  }
  const prefix = normalizeClientText(normalizedLabel.split("|", 1)[0] || "");
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

function resolvedThreadLabel(threadId, explicitLabel = "") {
  const normalizedThreadId = normalizeClientText(threadId || "");
  const normalizedLabel = sanitizeThreadLabelForDisplay(explicitLabel || "", normalizedThreadId);
  if (normalizedLabel) {
    return normalizedLabel;
  }
  if (!normalizedThreadId) {
    return "";
  }
  const timelineThreads = Array.isArray(state.timeline?.threads) ? state.timeline.threads : [];
  const matchingThread = timelineThreads.find((thread) => thread.id === normalizedThreadId);
  const fallbackLabel = sanitizeThreadLabelForDisplay(matchingThread?.label || "", normalizedThreadId);
  return fallbackLabel || "";
}

function compactDropdownThreadLabel(label) {
  const normalized = normalizeClientText(label || "");
  if (!normalized) {
    return "";
  }

  const glyphs = Array.from(normalized);
  if (glyphs.length <= 28) {
    return normalized;
  }

  return `${glyphs.slice(0, 28).join("")}...`;
}

function dropdownThreadLabel(threadId, explicitLabel = "") {
  return compactDropdownThreadLabel(resolvedThreadLabel(threadId, explicitLabel)) || L("timeline.unknownThread");
}

function formatTimelineTimestamp(value) {
  const createdAtMs = Number(value) || 0;
  if (!createdAtMs) {
    return "";
  }
  const date = new Date(createdAtMs);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const options = sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat(state.locale || DEFAULT_LOCALE, options).format(date);
  } catch {
    return sameDay ? date.toLocaleTimeString() : date.toLocaleString();
  }
}

function formatSettingsTimestamp(value) {
  const timestamp = Number(value) || 0;
  if (!timestamp) {
    return L("common.unavailable");
  }
  try {
    return new Intl.DateTimeFormat(state.locale || DEFAULT_LOCALE, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

function renderSettingsDetail({ mobile }) {
  const context = buildSettingsContext();
  if (state.settingsSubpage) {
    return renderSettingsSubpage(context, { mobile });
  }
  return renderSettingsRoot(context, { mobile });
}

function buildSettingsContext() {
  const push = state.pushStatus || {};
  const permission = push.notificationPermission || "default";
  const secureContext = push.secureContext === true;
  const standalone = push.standalone === true;
  const supportsPushValue = push.supportsPush === true;
  const serverEnabled = push.enabled === true;
  const canEnable =
    serverEnabled &&
    supportsPushValue &&
    secureContext &&
    standalone &&
    permission !== "denied" &&
    push.serverSubscribed !== true;
  const setupState = buildSettingsSetupState({
    serverEnabled,
    secureContext,
    standalone,
    supportsPushValue,
    permission,
    subscribed: push.subscribed === true,
  });

  return {
    push,
    permission,
    secureContext,
    standalone,
    supportsPushValue,
    serverEnabled,
    canEnable,
    setupState,
    devices: Array.isArray(state.devices) ? state.devices : [],
    devicesError: state.deviceError,
    diagnostics: collectSettingsDiagnostics({
      push,
      permission,
      secureContext,
      standalone,
      supportsPushValue,
      serverEnabled,
    }),
    moltbookScout: state.moltbookScoutStatus,
    a2aRelay: state.a2aRelayStatus,
    a2aShare: state.a2aShareStatus,
    hazbase: state.hazbaseStatus,
    remotePairing: state.remotePairingStatus,
  };
}

function buildSettingsSetupState({ serverEnabled, secureContext, standalone, supportsPushValue, permission, subscribed }) {
  const notifications = (() => {
    if (!serverEnabled) {
      return { tone: "muted", labelKey: "settings.status.notAvailable", copyKey: "settings.notifications.serverDisabled" };
    }
    if (!supportsPushValue) {
      return { tone: "muted", labelKey: "settings.status.unsupported", copyKey: "error.pushUnsupported" };
    }
    if (!secureContext) {
      return { tone: "warning", labelKey: "settings.status.needsHttps", copyKey: "settings.notifications.openHttps" };
    }
    if (!standalone) {
      return { tone: "warning", labelKey: "settings.status.needsHomeScreen", copyKey: "settings.notifications.openHomeScreen" };
    }
    if (permission === "denied") {
      return { tone: "danger", labelKey: "settings.status.blocked", copyKey: "banner.push.copy.denied" };
    }
    if (subscribed) {
      return { tone: "success", labelKey: "settings.status.ready", copyKey: "notice.notificationsEnabled" };
    }
    return { tone: "warning", labelKey: "settings.status.actionNeeded", copyKey: "banner.push.copy.default" };
  })();

  const install = standalone
    ? { tone: "success", labelKey: "settings.status.installed" }
    : { tone: "warning", labelKey: "settings.status.notInstalled" };

  const pairing = { tone: "success", labelKey: "settings.status.connected" };

  let nextStep = {
    titleKey: "settings.nextStep.enableNotifications.title",
    copyKey: "settings.nextStep.enableNotifications.copy",
  };
  let primaryAction = { kind: "push-enable", disabled: false };

  if (!serverEnabled) {
    nextStep = {
      titleKey: "settings.nextStep.serverDisabled.title",
      copyKey: "settings.nextStep.serverDisabled.copy",
    };
    primaryAction = { kind: "open-technical" };
  } else if (!secureContext) {
    nextStep = {
      titleKey: "settings.nextStep.openHttps.title",
      copyKey: "settings.nextStep.openHttps.copy",
    };
    primaryAction = { kind: "none" };
  } else if (!standalone) {
    nextStep = {
      titleKey: "settings.nextStep.install.title",
      copyKey: "settings.nextStep.install.copy",
    };
    primaryAction = { kind: "install-guide" };
  } else if (permission === "denied") {
    nextStep = {
      titleKey: "settings.nextStep.permissionBlocked.title",
      copyKey: "settings.nextStep.permissionBlocked.copy",
    };
    primaryAction = { kind: "none" };
  } else if (subscribed) {
    nextStep = {
      titleKey: "settings.nextStep.test.title",
      copyKey: "settings.nextStep.test.copy",
    };
    primaryAction = { kind: "push-test" };
  }

  return {
    notifications,
    install,
    pairing,
    nextStep,
    primaryAction,
  };
}

function collectSettingsDiagnostics({ permission, secureContext, standalone, supportsPushValue, serverEnabled }) {
  const issues = [];
  if (!serverEnabled) {
    issues.push(L("settings.notifications.serverDisabled"));
  }
  if (!supportsPushValue) {
    issues.push(L("error.pushUnsupported"));
  }
  if (!secureContext) {
    issues.push(L("settings.notifications.openHttps"));
  }
  if (secureContext && !standalone) {
    issues.push(L("settings.notifications.openHomeScreen"));
  }
  if (permission === "denied") {
    issues.push(L("banner.push.copy.denied"));
  }
  if (state.pushError) {
    issues.push(state.pushError);
  }
  return Array.from(new Set(issues.filter(Boolean)));
}

function hasAutoPilotWriteLaneEnabled(session = state.session) {
  return Boolean(
    session?.autoPilotTrustedWrites === true ||
    session?.autoPilotWriteLaneContent === true ||
    session?.autoPilotWriteLaneUiTests === true ||
    session?.autoPilotWriteLaneSource === true,
  );
}

function hasAutoPilotEnabled(session = state.session) {
  return Boolean(session?.autoPilotTrustedReads === true || hasAutoPilotWriteLaneEnabled(session));
}

function settingsEnabledValue(enabled) {
  return enabled ? L("common.enabled") : L("common.disabled");
}

function settingsNeedsActionValue() {
  return L("settings.status.actionNeeded");
}

function settingsDisconnectedValue() {
  return L("settings.status.disconnected");
}

function settingsSupportedValue(supported) {
  return supported ? L("settings.status.supported") : L("settings.status.unsupported");
}

function settingsInstalledValue(installed) {
  return installed ? L("settings.status.installed") : L("settings.status.notInstalled");
}

function settingsNotificationRootValue(context) {
  if (context.push?.serverSubscribed === true) {
    return L("common.enabled");
  }
  if (context.push?.clientSubscribed === true) {
    return settingsNeedsActionValue();
  }
  if (context.permission === "denied") {
    return settingsNeedsActionValue();
  }
  return L("common.disabled");
}

function notificationPermissionValue(permission) {
  const key = `settings.permission.${permission || "default"}`;
  const translated = L(key);
  return translated === key ? String(permission || "") : translated;
}

function notificationReceiveValue(push) {
  if (push?.serverSubscribed === true) {
    return L("common.enabled");
  }
  if (push?.clientSubscribed === true) {
    return L("settings.status.actionNeeded");
  }
  return L("common.disabled");
}

function notificationOverallValue(context) {
  if (context.push?.serverSubscribed === true) {
    return L("common.enabled");
  }
  if (context.permission === "denied") {
    return L("settings.status.blocked");
  }
  if (!context.serverEnabled) {
    return L("settings.status.notAvailable");
  }
  if (!context.supportsPushValue) {
    return L("settings.status.unsupported");
  }
  if (!context.secureContext || !context.standalone || context.permission !== "granted") {
    return L("settings.status.actionNeeded");
  }
  return L("common.disabled");
}

function settingsMoltbookRootValue(context) {
  return context.moltbookScout?.enabled === true
    ? L("common.enabled")
    : settingsNeedsActionValue();
}

function settingsA2aRelayRootValue(context) {
  const relay = context.a2aRelay;
  if (relay?.enabled === true && relay?.connected === true) {
    return L("common.enabled");
  }
  return settingsDisconnectedValue();
}

function settingsA2aShareRootValue(context) {
  const share = context.a2aShare;
  if (share?.enabled === true && !share?.error) {
    return L("common.enabled");
  }
  return settingsNeedsActionValue();
}

function settingsWalletRootValue(context) {
  if (context.hazbase?.enabled !== true) {
    return L("common.disabled");
  }
  return deriveHazbaseWalletFlow(context.hazbase).coreReady
    ? L("common.enabled")
    : settingsNeedsActionValue();
}

function isRemotePairingSessionConnected(session) {
  const value = normalizeClientText(session?.state).toLowerCase();
  return value === "connected" || value === "open" || value === "running";
}

function isRemotePairingSessionReachable(session) {
  const value = normalizeClientText(session?.state).toLowerCase();
  return value === "connected" || value === "open" || value === "running" || value === "opening" || value === "handshaking" || value === "resuming";
}

function remotePairingStatusModel(status, opts = {}) {
  const enabled = status?.enabled === true;
  const sessions = Array.isArray(status?.sessions) ? status.sessions : [];
  const pairings = Array.isArray(status?.pairings) ? status.pairings : [];
  const usingRelay = opts.usingRelay === true;
  if (!enabled) {
    return { key: "disabled", tone: "muted", label: L("settings.remotePairing.status.disabled") };
  }
  if (usingRelay && sessions.some(isRemotePairingSessionConnected)) {
    return { key: "connected", tone: "success", label: L("settings.remotePairing.status.connected") };
  }
  if (sessions.some(isRemotePairingSessionReachable)) {
    return { key: "available", tone: "success", label: L("settings.remotePairing.status.available") };
  }
  if (pairings.length > 0) {
    return { key: "waiting", tone: "warning", label: L("settings.remotePairing.status.waiting") };
  }
  return { key: "waiting", tone: "muted", label: L("settings.remotePairing.status.waiting") };
}

function remotePairingAuditTypeLabel(type) {
  const key = `settings.remotePairing.audit.type.${type || "unknown"}`;
  const translated = L(key);
  return translated === key ? L("settings.remotePairing.audit.type.unknown") : translated;
}

function remotePairingAuditOutcomeTone(outcome) {
  if (outcome === "success") return "success";
  if (outcome === "failure") return "danger";
  return "muted";
}

function remotePairingAuditMeta(event) {
  return [
    event?.label,
    event?.phoneFingerprint,
    event?.relayHost,
    event?.reason,
  ].filter(Boolean).join(" / ");
}

function renderRemotePairingAudit(events) {
  const list = Array.isArray(events) ? events.slice(0, 10) : [];
  if (!list.length) {
    return `<div class="settings-copy-block"><p class="muted">${escapeHtml(L("settings.remotePairing.audit.empty"))}</p></div>`;
  }
  return `
    <div class="settings-remote-audit-list">
      ${list.map((event) => {
        const tone = remotePairingAuditOutcomeTone(event?.outcome);
        const title = remotePairingAuditTypeLabel(event?.type);
        const meta = remotePairingAuditMeta(event);
        return `
          <article class="settings-remote-audit-item">
            <span class="settings-remote-audit-dot settings-remote-audit-dot--${escapeHtml(tone)}" aria-hidden="true"></span>
            <div class="settings-remote-audit-body">
              <p class="settings-remote-audit-title">${escapeHtml(title)}</p>
              ${meta ? `<p class="settings-remote-audit-meta">${escapeHtml(meta)}</p>` : ""}
            </div>
            <time class="settings-remote-audit-time">${escapeHtml(formatSettingsTimestamp(event?.atMs))}</time>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function settingsPageMeta(page) {
  switch (page) {
    case "notifications":
      return {
        id: "notifications",
        title: L("settings.notifications.title"),
        description: L("settings.notifications.copy"),
        icon: "notifications",
      };
    case "language":
      return {
        id: "language",
        title: L("settings.language.title"),
        description: L("settings.language.copy"),
        icon: "language",
      };
    case "install":
      return {
        id: "install",
        title: L("settings.install.title"),
        description: L("settings.install.copy"),
        icon: "homescreen",
      };
    case "device":
      return {
        id: "device",
        title: L("settings.device.title"),
        description: L("settings.device.copy"),
        icon: "iphone",
      };
    case "advanced":
      return {
        id: "advanced",
        title: L("settings.technical.title"),
        description: L("settings.technical.copy"),
        icon: "settings",
      };
    case "awayMode":
      return {
        id: "awayMode",
        title: L("settings.awayMode.title"),
        description: L("settings.awayMode.copy"),
        icon: "settings",
      };
    case "autoPilot":
      return {
        id: "autoPilot",
        title: L("settings.autoPilot.title"),
        description: L("settings.autoPilot.copy"),
        icon: "approval",
      };
    case "moltbook":
      return {
        id: "moltbook",
        title: L("settings.moltbook.title"),
        description: L("settings.moltbook.copy"),
        icon: "item",
      };
    case "a2aRelay":
      return {
        id: "a2aRelay",
        title: L("settings.a2aRelay.title"),
        description: L("settings.a2aRelay.copy"),
        icon: "agent-network",
      };
    case "a2aShare":
      return {
        id: "a2aShare",
        title: L("settings.a2aShare.title"),
        description: L("settings.a2aShare.copy"),
        icon: "file-event",
      };
    case "wallet":
      return {
        id: "wallet",
        title: L("settings.wallet.title"),
        description: L("settings.wallet.copy"),
        icon: "coin",
      };
    case "remotePairing":
      return {
        id: "remotePairing",
        title: L("settings.remotePairing.title"),
        description: L("settings.remotePairing.copy"),
        icon: "remote-connection",
      };
    case "a2aExecutor":
      // Executor settings integrated into a2aRelay page — redirect.
      return settingsPageMeta("a2aRelay");
    default:
      return settingsPageMeta("notifications");
  }
}

function renderSettingsRoot(context, { mobile }) {
  const languageValue = localeDisplayName(state.locale, state.locale) || state.locale;
  const generalRows = [
    renderSettingsNavRow({
      page: "notifications",
      icon: "notifications",
      title: L("settings.notifications.title"),
      value: settingsNotificationRootValue(context),
    }),
    renderSettingsNavRow({
      page: "language",
      icon: "language",
      title: L("settings.language.title"),
      value: languageValue,
    }),
    !context.standalone
      ? renderSettingsNavRow({
          page: "install",
          icon: "homescreen",
          title: L("settings.install.title"),
          value: settingsEnabledValue(context.standalone),
        })
      : "",
    renderSettingsNavRow({
      page: "awayMode",
      icon: "settings",
      title: L("settings.awayMode.title"),
      value: settingsEnabledValue(state.session?.claudeAwayMode === true),
    }),
    renderSettingsNavRow({
      page: "autoPilot",
      icon: "approval",
      title: L("settings.autoPilot.title"),
      value: settingsEnabledValue(hasAutoPilotEnabled()),
    }),
  ].filter(Boolean);
  const deviceRows = [
    renderSettingsNavRow({
      page: "device",
      icon: "iphone",
      title: L("settings.device.title"),
      value: context.devices.length
        ? L("settings.device.count", { count: context.devices.length })
        : L("settings.pairing.connected"),
    }),
    state.session?.remotePairingAvailable ? renderSettingsNavRow({
      page: "remotePairing",
      icon: "remote-connection",
      title: L("settings.remotePairing.title"),
      value: settingsEnabledValue(context.remotePairing?.enabled === true),
    }) : "",
  ];
  const advancedRows = [
    renderSettingsNavRow({
      page: "advanced",
      icon: "settings",
      title: L("settings.technical.title"),
      value: context.diagnostics.length ? L("settings.status.actionNeeded") : L("settings.status.info"),
    }),
  ];

  return `
    <div class="settings-screen">
      ${
        mobile
          ? ""
          : `
            <div class="screen-header">
              <div>
                <p class="screen-eyebrow">${escapeHtml(L("tab.settings.eyebrow"))}</p>
                <h2 class="screen-title">${escapeHtml(L("tab.settings.title"))}</h2>
              </div>
            </div>
          `
      }
      ${renderSettingsGroup(L("settings.group.general"), generalRows)}
      ${(state.session?.moltbookEnabled || state.session?.a2aRelayEnabled || state.session?.a2aShareEnabled || context.hazbase?.enabled) ? renderSettingsGroup(L("settings.group.integrations"), [
        state.session?.moltbookEnabled ? renderSettingsNavRow({
          page: "moltbook",
          icon: "item",
          title: L("settings.moltbook.title"),
          value: settingsMoltbookRootValue(context),
        }) : "",
        state.session?.a2aRelayEnabled ? renderSettingsNavRow({
          page: "a2aRelay",
          icon: "agent-network",
          title: L("settings.a2aRelay.title"),
          value: settingsA2aRelayRootValue(context),
        }) : "",
        state.session?.a2aShareEnabled ? renderSettingsNavRow({
          page: "a2aShare",
          icon: "file-event",
          title: L("settings.a2aShare.title"),
          value: settingsA2aShareRootValue(context),
        }) : "",
        context.hazbase?.enabled ? renderSettingsNavRow({
          page: "wallet",
          icon: "coin",
          title: L("settings.wallet.title"),
          badge: "beta",
          value: settingsWalletRootValue(context),
        }) : "",
      ].filter(Boolean)) : ""}
      ${renderSettingsGroup(L("settings.pairing.title"), deviceRows)}
      ${renderSettingsGroup(L("settings.group.advanced"), advancedRows)}
    </div>
  `;
}

function renderSettingsSubpage(context, { mobile }) {
  const page = settingsPageMeta(state.settingsSubpage);
  const desktopHeader = !mobile
    ? `
      <div class="settings-page-header">
        <button class="secondary settings-inline-back" type="button" data-settings-back>
          <span aria-hidden="true">${renderIcon("back")}</span>
          <span>${escapeHtml(L("common.back"))}</span>
        </button>
        <div>
          <p class="screen-eyebrow">${escapeHtml(L("common.settings"))}</p>
          <h2 class="screen-title">${escapeHtml(page.title)}</h2>
        </div>
      </div>
    `
    : "";

  let content = "";
  switch (state.settingsSubpage) {
    case "notifications":
      content = renderSettingsNotificationsPage(context);
      break;
    case "language":
      content = renderSettingsLanguagePage();
      break;
    case "install":
      content = renderSettingsInstallPage();
      break;
    case "device":
      content = renderSettingsDevicePage(context);
      break;
    case "advanced":
      content = renderSettingsAdvancedPage(context);
      break;
    case "awayMode":
      content = renderSettingsAwayModePage();
      break;
    case "autoPilot":
      content = renderSettingsAutoPilotPage();
      break;
    case "moltbook":
      content = renderSettingsMoltbookPage(context);
      break;
    case "a2aRelay":
    case "a2aExecutor":
      content = renderSettingsA2aRelayPage(context);
      break;
    case "a2aShare":
      content = renderSettingsA2aSharePage(context);
      break;
    case "wallet":
      content = renderSettingsWalletPage(context);
      break;
    case "remotePairing":
      content = renderSettingsRemotePairingPage(context);
      break;
    default:
      content = "";
  }

  return `
    <div class="settings-screen settings-screen--subpage">
      ${desktopHeader}
      <p class="settings-page-copy muted">${escapeHtml(page.description)}</p>
      ${content}
    </div>
  `;
}

function renderSettingsNotificationsPage(context) {
  const { push, permission, standalone } = context;
  const notificationEnabled = push.serverSubscribed === true;
  const statusRows = [
    renderSettingsInfoRow(L("settings.row.status"), notificationOverallValue(context)),
    renderSettingsInfoRow(L("settings.row.notificationPermission"), notificationPermissionValue(permission), {
      valueTone: permission === "granted" ? "enabled" : permission === "denied" ? "attention" : "disabled",
    }),
    renderSettingsInfoRow(L("settings.row.currentDeviceSubscribed"), notificationReceiveValue(push)),
    push.lastSuccessfulDeliveryAtMs
      ? renderSettingsInfoRow(
          L("settings.row.lastSuccessfulDelivery"),
          new Date(push.lastSuccessfulDeliveryAtMs).toLocaleString(state.locale)
        )
      : "",
  ].filter(Boolean);
  return `
    <div class="settings-page">
      ${renderSettingsGroup("", statusRows)}
      ${state.pushNotice ? `<p class="inline-alert inline-alert--success">${escapeHtml(state.pushNotice)}</p>` : ""}
      ${state.pushError ? `<p class="inline-alert inline-alert--danger">${escapeHtml(state.pushError)}</p>` : ""}
      ${renderSettingsActionPanel(renderSettingsNotificationActions({
        push,
        canEnable: context.canEnable,
        standalone,
      }), L("settings.group.actions"))}
    </div>
  `;
}

function renderSettingsLanguagePage() {
  const overrideLocale = normalizeLocale(state.session?.deviceOverrideLocale || "");
  const options = [
    { value: "", label: L("common.useDeviceLanguage") },
    { value: "en", label: localeDisplayName("en", state.locale) },
    { value: "ja", label: localeDisplayName("ja", state.locale) },
  ];

  return `
    <div class="settings-page">
      ${renderSettingsGroup("", options.map(({ value, label }) => {
        const isSelected = (value || "") === overrideLocale;
        return `
          <button class="settings-choice-row" type="button" data-locale-option="${escapeHtml(value)}" aria-pressed="${isSelected ? "true" : "false"}">
            <span class="settings-row__body">
              <span class="settings-row__title">${escapeHtml(label)}</span>
            </span>
            <span class="settings-choice-row__check" aria-hidden="true">${isSelected ? renderIcon("check") : ""}</span>
          </button>
        `;
      }), { listClassName: "settings-list settings-list--compact" })}
      ${renderSettingsGroup(L("settings.group.values"), [
        renderSettingsInfoRow(L("settings.row.currentLanguage"), localeDisplayName(state.locale, state.locale) || state.locale),
        renderSettingsInfoRow(L("settings.row.languageSource"), L(`language.source.${state.localeSource}`)),
        renderSettingsInfoRow(L("settings.row.defaultLanguage"), localeDisplayName(state.defaultLocale, state.locale) || state.defaultLocale),
      ], { listClassName: "settings-list settings-list--compact" })}
    </div>
  `;
}

function renderSettingsInstallPage() {
  return `
    <div class="settings-page">
      <section class="settings-copy-block">
        <p class="muted">${escapeHtml(L("settings.install.copy"))}</p>
      </section>
      ${renderSettingsActionPanel(
        `<button class="primary primary--wide" type="button" data-install-guide-open>${escapeHtml(L("common.addToHomeScreen"))}</button>`
      , L("settings.group.actions"))}
    </div>
  `;
}

function renderSettingsDevicePage(context) {
  const devices = Array.isArray(context.devices) ? context.devices : [];
  const currentDevice = devices.find((device) => device.currentDevice) || null;
  const otherDevices = devices.filter((device) => !device.currentDevice);
  return `
    <div class="settings-page">
      ${state.deviceNotice ? `<p class="inline-alert inline-alert--success">${escapeHtml(state.deviceNotice)}</p>` : ""}
      ${(state.deviceError || context.devicesError) ? `<p class="inline-alert inline-alert--danger">${escapeHtml(state.deviceError || context.devicesError)}</p>` : ""}
      ${renderDeviceSection(L("settings.device.section.current"), currentDevice ? [currentDevice] : [], L("settings.device.emptyCurrent"))}
      ${renderDeviceSection(L("settings.device.section.other"), otherDevices, L("settings.device.emptyOther"))}
      <section class="settings-group">
        <p class="settings-group__title">${escapeHtml(L("settings.device.addAnother.title"))}</p>
        <div class="settings-copy-block settings-copy-block--stacked">
          <div class="helper-copy">
            <strong>${escapeHtml(L("settings.device.addAnother.heading"))}</strong>
            <p class="muted">${escapeHtml(L("settings.device.addAnother.copy"))}</p>
          </div>
          <div class="settings-command-card">
            <span class="settings-command-card__label">${escapeHtml(L("settings.device.addAnother.commandLabel"))}</span>
            <code class="settings-command-card__value">npx viveworker pair</code>
          </div>
        </div>
      </section>
      ${renderSettingsActionPanel(
        `<button class="secondary secondary--wide" type="button" data-open-logout-confirm>${escapeHtml(L("common.logOut"))}</button>`,
        L("settings.group.actions")
      )}
    </div>
  `;
}

function renderSettingsAdvancedPage(context) {
  const versionNotice = renderVersionUpdateNotice();
  return `
    <div class="settings-page">
      ${context.diagnostics.map((message) => `<p class="inline-alert">${escapeHtml(message)}</p>`).join("")}
      ${renderSettingsGroup("", [
        renderSettingsInfoRow(L("settings.row.serverWebPush"), context.serverEnabled ? L("common.enabled") : L("common.disabled")),
        renderSettingsInfoRow(L("settings.row.secureContext"), context.secureContext ? L("common.enabled") : L("common.disabled")),
        renderSettingsInfoRow(L("settings.row.homeScreenApp"), settingsInstalledValue(context.standalone), {
          valueTone: context.standalone ? "enabled" : "disabled",
        }),
        renderSettingsInfoRow(L("settings.row.browserSupport"), settingsSupportedValue(context.supportsPushValue), {
          valueTone: context.supportsPushValue ? "enabled" : "disabled",
        }),
        renderSettingsInfoRow(L("settings.row.version"), state.appVersion || L("common.unavailable")),
      ].filter(Boolean), { listClassName: "settings-list settings-list--compact" })}
      ${versionNotice}
    </div>
  `;
}

function renderVersionUpdateNotice() {
  const status = state.versionStatus;
  if (!status?.updateAvailable || !status.latestVersion) {
    return "";
  }
  return `
    <section class="settings-copy-block settings-copy-block--compact settings-update-notice">
      <p class="settings-update-notice__title">${escapeHtml(L("settings.updateAvailable.title"))}</p>
      <p class="muted">${escapeHtml(L("settings.updateAvailable.copy", {
        current: status.currentVersion || state.appVersion || "",
        latest: status.latestVersion,
      }))}</p>
      <code class="settings-update-notice__command">npx viveworker update</code>
    </section>
  `;
}

function renderSettingsNotificationActions({ push, canEnable, standalone }) {
  if (push.serverSubscribed) {
    return `
      <button class="primary primary--wide" data-push-action="test">${escapeHtml(L("settings.action.sendTest"))}</button>
      <button class="secondary secondary--wide" data-push-action="disable">${escapeHtml(L("settings.action.disableNotifications"))}</button>
    `;
  }

  if (!push.enabled || push.supportsPush === false || push.secureContext === false) {
    return `<button class="secondary secondary--wide" type="button" data-open-technical>${escapeHtml(L("settings.action.reviewTechnical"))}</button>`;
  }

  if (push.notificationPermission === "denied") {
    return `<button class="secondary secondary--wide" type="button" data-open-technical>${escapeHtml(L("settings.action.reviewTechnical"))}</button>`;
  }

  if (!standalone) {
    return `<button class="secondary secondary--wide" type="button" data-install-guide-open>${escapeHtml(L("common.addToHomeScreen"))}</button>`;
  }

  return `<button class="primary primary--wide" data-push-action="enable" ${canEnable ? "" : "disabled"}>${escapeHtml(L("settings.action.enableNotifications"))}</button>`;
}

function renderSettingsGroup(title, rows, options = {}) {
  const listClassName = options.listClassName || "settings-list";
  return `
    <section class="settings-group">
      ${title ? `<p class="settings-group__title">${escapeHtml(title)}</p>` : ""}
      <div class="${escapeHtml(listClassName)}">
        ${rows.join("")}
      </div>
    </section>
  `;
}

function settingsNavValueTone(value, explicitTone = "") {
  if (explicitTone) {
    return explicitTone;
  }
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (text === L("common.enabled") || text === L("settings.status.enabled")) {
    return "enabled";
  }
  if (text === L("common.disabled") || text === L("settings.status.disabled")) {
    return "disabled";
  }
  if (text === L("settings.status.actionNeeded") || text === L("settings.status.blocked")) {
    return "attention";
  }
  if (text === L("settings.status.supported") || text === L("settings.status.installed")) {
    return "enabled";
  }
  if (text === L("settings.status.disconnected")) {
    return "disconnected";
  }
  return "";
}

function renderSettingsNavRow({ page, icon, title, badge, subtitle, value, valueTone }) {
  const tone = settingsNavValueTone(value, valueTone);
  const valueClass = tone
    ? `settings-row__value settings-row__value--${escapeHtml(tone)}`
    : "settings-row__value";
  return `
    <button class="settings-nav-row" type="button" data-settings-subpage="${escapeHtml(page)}">
      <span class="settings-row__icon" aria-hidden="true">${renderIcon(icon)}</span>
      <span class="settings-row__body">
        <span class="settings-row__title-line">
          <span class="settings-row__title">${escapeHtml(title)}</span>
          ${badge ? `<span class="settings-row__badge">${escapeHtml(badge)}</span>` : ""}
        </span>
        ${subtitle ? `<span class="settings-row__subtitle">${escapeHtml(subtitle)}</span>` : ""}
      </span>
      <span class="${valueClass}">${escapeHtml(value || "")}</span>
      <span class="settings-row__chevron" aria-hidden="true">${renderIcon("chevron-right")}</span>
    </button>
  `;
}

function renderSettingsAwayModePage() {
  const enabled = state.session?.claudeAwayMode === true;
  const stateLabel = enabled ? L("settings.claudeAway.on") : L("settings.claudeAway.off");
  return `
    <div class="settings-page">
      ${renderSettingsGroup("", [`
        <label class="reply-mode-switch reply-mode-switch--settings" data-claude-away-toggle>
          <input type="checkbox" class="reply-mode-switch__input" ${enabled ? "checked" : ""} data-claude-away-checkbox />
          <span class="reply-mode-switch__copy">
            <span class="reply-mode-switch__title">
              <span>${escapeHtml(L("settings.claudeAway.title"))}</span>
            </span>
            <span class="reply-mode-switch__hint">${escapeHtml(L("settings.claudeAway.description"))}</span>
          </span>
          <span class="reply-mode-switch--settings__toggle">
            <span class="reply-mode-switch__track" aria-hidden="true"><span class="reply-mode-switch__thumb"></span></span>
            <span class="reply-mode-switch__state">${escapeHtml(stateLabel)}</span>
          </span>
        </label>
      `])}
      <p class="settings-page-copy muted">${escapeHtml(L("settings.awayMode.codexNote"))}</p>
    </div>
  `;
}

function renderSettingsAutoPilotPage() {
  const trustedReadsEnabled = state.session?.autoPilotTrustedReads === true;
  const trustedReadsStateLabel = trustedReadsEnabled ? L("common.enabled") : L("common.disabled");
  const writeLaneContentEnabled = state.session?.autoPilotWriteLaneContent === true;
  const writeLaneUiTestsEnabled = state.session?.autoPilotWriteLaneUiTests === true;
  const writeLaneSourceEnabled = state.session?.autoPilotWriteLaneSource === true;
  const trustedWritesEnabled = hasAutoPilotWriteLaneEnabled();
  const trustedWritesStateLabel = trustedWritesEnabled ? L("common.enabled") : L("common.disabled");
  const recentEntries = recentAutoPilotEntries();
  const suggestions = recentAutoPilotSuggestions();
  return `
    <div class="settings-page">
      ${renderSettingsGroup("", [`
        <label class="reply-mode-switch reply-mode-switch--settings reply-mode-switch--grouped" data-auto-pilot-toggle>
          <input type="checkbox" class="reply-mode-switch__input" ${trustedReadsEnabled ? "checked" : ""} data-auto-pilot-checkbox />
          <span class="reply-mode-switch__copy">
            <span class="reply-mode-switch__title">
              <span>${escapeHtml(L("settings.autoPilot.trustedReadsTitle"))}</span>
            </span>
            <span class="reply-mode-switch__hint">${escapeHtml(L("settings.autoPilot.trustedReadsDescription"))}</span>
          </span>
          <span class="reply-mode-switch--settings__toggle">
            <span class="reply-mode-switch__track" aria-hidden="true"><span class="reply-mode-switch__thumb"></span></span>
            <span class="reply-mode-switch__state">${escapeHtml(trustedReadsStateLabel)}</span>
          </span>
        </label>
      `, `
        <div class="settings-toggle-subhead" role="presentation">
          <span class="settings-toggle-subhead__title">${escapeHtml(L("settings.autoPilot.trustedWritesTitle"))}</span>
          <span class="settings-toggle-subhead__state">${escapeHtml(trustedWritesStateLabel)}</span>
        </div>
      `, `
        <div class="settings-toggle-subcopy muted">${escapeHtml(L("settings.autoPilot.trustedWritesDescription"))}</div>
      `, `
        <label class="reply-mode-switch reply-mode-switch--settings reply-mode-switch--grouped" data-auto-pilot-write-lane="content">
          <input type="checkbox" class="reply-mode-switch__input" ${writeLaneContentEnabled ? "checked" : ""} data-auto-pilot-write-lane-checkbox="content" />
          <span class="reply-mode-switch__copy">
            <span class="reply-mode-switch__title">
              <span>${escapeHtml(L("settings.autoPilot.writeLaneContentTitle"))}</span>
            </span>
            <span class="reply-mode-switch__hint">${escapeHtml(L("settings.autoPilot.writeLaneContentDescription"))}</span>
          </span>
          <span class="reply-mode-switch--settings__toggle">
            <span class="reply-mode-switch__track" aria-hidden="true"><span class="reply-mode-switch__thumb"></span></span>
            <span class="reply-mode-switch__state">${escapeHtml(writeLaneContentEnabled ? L("common.enabled") : L("common.disabled"))}</span>
          </span>
        </label>
      `, `
        <label class="reply-mode-switch reply-mode-switch--settings reply-mode-switch--grouped" data-auto-pilot-write-lane="ui-tests">
          <input type="checkbox" class="reply-mode-switch__input" ${writeLaneUiTestsEnabled ? "checked" : ""} data-auto-pilot-write-lane-checkbox="ui-tests" />
          <span class="reply-mode-switch__copy">
            <span class="reply-mode-switch__title">
              <span>${escapeHtml(L("settings.autoPilot.writeLaneUiTestsTitle"))}</span>
            </span>
            <span class="reply-mode-switch__hint">${escapeHtml(L("settings.autoPilot.writeLaneUiTestsDescription"))}</span>
          </span>
          <span class="reply-mode-switch--settings__toggle">
            <span class="reply-mode-switch__track" aria-hidden="true"><span class="reply-mode-switch__thumb"></span></span>
            <span class="reply-mode-switch__state">${escapeHtml(writeLaneUiTestsEnabled ? L("common.enabled") : L("common.disabled"))}</span>
          </span>
        </label>
      `, `
        <label class="reply-mode-switch reply-mode-switch--settings reply-mode-switch--grouped" data-auto-pilot-write-lane="source">
          <input type="checkbox" class="reply-mode-switch__input" ${writeLaneSourceEnabled ? "checked" : ""} data-auto-pilot-write-lane-checkbox="source" />
          <span class="reply-mode-switch__copy">
            <span class="reply-mode-switch__title">
              <span>${escapeHtml(L("settings.autoPilot.writeLaneSourceTitle"))}</span>
            </span>
            <span class="reply-mode-switch__hint">${escapeHtml(L("settings.autoPilot.writeLaneSourceDescription"))}</span>
          </span>
          <span class="reply-mode-switch--settings__toggle">
            <span class="reply-mode-switch__track" aria-hidden="true"><span class="reply-mode-switch__thumb"></span></span>
            <span class="reply-mode-switch__state">${escapeHtml(writeLaneSourceEnabled ? L("common.enabled") : L("common.disabled"))}</span>
          </span>
        </label>
      `], { listClassName: "settings-list settings-list--toggle-group" })}
      <p class="settings-page-copy muted">${escapeHtml(L("settings.autoPilot.scopeNote"))}</p>
      ${
        suggestions.length
          ? renderSettingsGroup(
              L("settings.autoPilot.suggestionsTitle"),
              suggestions.map((suggestion) => renderSettingsAutoPilotSuggestion(suggestion))
            )
          : ""
      }
      ${
        recentEntries.length
          ? renderSettingsGroup(
              L("settings.autoPilot.recentTitle"),
              recentEntries.map((item) => renderSettingsAutoPilotRecentEntry(item))
            )
          : `
            <section class="settings-group">
              <p class="settings-group__title">${escapeHtml(L("settings.autoPilot.recentTitle"))}</p>
              <div class="settings-copy-block settings-copy-block--compact">
                <p class="muted">${escapeHtml(L("settings.autoPilot.recentEmpty"))}</p>
              </div>
            </section>
          `
      }
    </div>
  `;
}

function recentAutoPilotEntries(limit = 5) {
  const entries = Array.isArray(state.timeline?.entries) ? state.timeline.entries : [];
  return entries
    .filter((entry) => isAutoPilotApprovalEntry(entry))
    .sort((a, b) => (Number(b.createdAtMs) || 0) - (Number(a.createdAtMs) || 0))
    .slice(0, limit);
}

function isAutoPilotApprovalEntry(entry) {
  const stableId = normalizeClientText(entry?.stableId || "");
  return (
    normalizeClientText(entry?.kind || "") === "approval" &&
    normalizeClientText(entry?.outcome || "") === "approved" &&
    (stableId.endsWith(":autopilot") || stableId.includes(":autopilot-write"))
  );
}

function autoPilotEntryMode(item) {
  const stableId = normalizeClientText(item?.stableId || "");
  return stableId.includes(":autopilot-write") ? "write" : "read";
}

function autoPilotEntryWriteLane(item) {
  const stableId = normalizeClientText(item?.stableId || "");
  const match = stableId.match(/:autopilot-write:([a-z_-]+)$/u);
  return normalizeClientText(match?.[1] || "");
}

function isManualApprovedWriteEntry(entry) {
  const stableId = normalizeClientText(entry?.stableId || "");
  return (
    normalizeClientText(entry?.kind || "") === "approval" &&
    normalizeClientText(entry?.outcome || "") === "approved" &&
    !stableId.includes(":autopilot") &&
    normalizeClientFileRefs(entry?.fileRefs).length > 0 &&
    normalizeClientText(entry?.diffText || "").length > 0
  );
}

function autoPilotDeniedWritePathClient(fileRef) {
  const normalized = normalizeClientText(fileRef || "");
  if (!normalized) {
    return true;
  }
  const lower = normalized.toLowerCase();
  const segments = lower.split(/[\\/]+/u).filter(Boolean);
  const basename = segments[segments.length - 1] || "";
  if (
    segments.some((segment) => [".ssh", ".aws", ".gnupg", ".azure", ".kube", ".github", ".gitlab", ".terraform", ".claude", ".husky", ".vscode"].includes(segment))
  ) {
    return true;
  }
  if (basename === ".npmrc" || basename === ".netrc" || basename === ".env" || basename.startsWith(".env.")) {
    return true;
  }
  if (basename.endsWith(".pem") || basename.endsWith(".key") || basename.endsWith(".p12") || basename.endsWith(".pfx")) {
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
  return /^id_[a-z0-9._-]+$/iu.test(basename) || basename.includes("secret") || basename.includes("credential");
}

function autoPilotContentWritePathClient(fileRef) {
  const normalized = normalizeClientText(fileRef || "");
  if (!normalized || autoPilotDeniedWritePathClient(normalized)) {
    return false;
  }
  const lower = normalized.toLowerCase();
  const segments = lower.split(/[\\/]+/u).filter(Boolean);
  const basename = segments[segments.length - 1] || "";
  const extension = basename.includes(".") ? `.${basename.split(".").pop().toLowerCase()}` : "";
  const basenameWithoutExtension = extension ? basename.slice(0, -extension.length) : basename;
  if ([".md", ".mdx", ".txt", ".rst", ".adoc"].includes(extension)) {
    return true;
  }
  if (["license", "notice", "copying", "readme", "changelog", "contributing"].includes(basenameWithoutExtension.toLowerCase())) {
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

function autoPilotUiTestsWritePathClient(fileRef) {
  const normalized = normalizeClientText(fileRef || "");
  if (!normalized || autoPilotDeniedWritePathClient(normalized)) {
    return false;
  }
  const lower = normalized.toLowerCase();
  const segments = lower.split(/[\\/]+/u).filter(Boolean);
  const basename = segments[segments.length - 1] || "";
  const extension = basename.includes(".") ? `.${basename.split(".").pop().toLowerCase()}` : "";
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

function autoPilotSourceWritePathClient(fileRef) {
  const normalized = normalizeClientText(fileRef || "");
  if (!normalized || autoPilotDeniedWritePathClient(normalized)) {
    return false;
  }
  if (autoPilotContentWritePathClient(normalized) || autoPilotUiTestsWritePathClient(normalized)) {
    return false;
  }
  return /\.(?:[cm]?[jt]sx?)$/u.test(normalized);
}

function diffAddedLinesClient(diffText) {
  return String(diffText || "")
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

function addedDiffLinesContainClient(diffText, pattern) {
  return diffAddedLinesClient(diffText).some((line) => pattern.test(line));
}

function hasUnsafeUiOrTestWriteDiffClient(diffText) {
  const patterns = [
    /\bprocess\.env\b/u,
    /\b(?:child_process|spawn|exec|execFile|fork)\b/u,
    /\bfs\.(?:write|append|rm|unlink|rename|chmod|chown|copyFile|cp)\b/u,
    /\b(?:fetch|axios|XMLHttpRequest)\s*\(/u,
    /\bcrypto\b/u,
    /\b(?:secret|token|password|privateKey|credential)\b/iu,
  ];
  return (
    addedDiffLinesContainClient(diffText, /^\s*(?:import\s|export\s+.*\s+from\s)/u) ||
    addedDiffLinesContainClient(diffText, /\brequire\s*\(/u) ||
    patterns.some((pattern) => addedDiffLinesContainClient(diffText, pattern))
  );
}

function hasUnsafeSourceWriteDiffClient(diffText) {
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
    addedDiffLinesContainClient(diffText, /^\s*(?:import\s|export\s+.*\s+from\s)/u) ||
    addedDiffLinesContainClient(diffText, /\brequire\s*\(/u) ||
    patterns.some((pattern) => addedDiffLinesContainClient(diffText, pattern))
  );
}

function classifyManualWriteLaneSuggestion(entry) {
  const fileRefs = normalizeClientFileRefs(entry?.fileRefs);
  const diffText = normalizeClientText(entry?.diffText || "");
  const added = Math.max(0, Number(entry?.diffAddedLines) || 0);
  const removed = Math.max(0, Number(entry?.diffRemovedLines) || 0);
  const totalChangedLines = added + removed;
  if (!fileRefs.length || !diffText || totalChangedLines === 0) {
    return "";
  }
  if (/^(?:new file mode|deleted file mode|rename from|rename to|old mode|new mode|similarity index|dissimilarity index|GIT binary patch|Binary files )/mu.test(diffText)) {
    return "";
  }
  if (
    fileRefs.length >= 1 &&
    fileRefs.length <= 3 &&
    totalChangedLines <= 120 &&
    fileRefs.every((fileRef) => autoPilotContentWritePathClient(fileRef))
  ) {
    return "content";
  }
  if (
    fileRefs.length >= 1 &&
    fileRefs.length <= 2 &&
    totalChangedLines <= 80 &&
    fileRefs.every((fileRef) => autoPilotUiTestsWritePathClient(fileRef)) &&
    !hasUnsafeUiOrTestWriteDiffClient(diffText)
  ) {
    return "ui_tests";
  }
  if (
    fileRefs.length === 1 &&
    totalChangedLines <= 40 &&
    fileRefs.every((fileRef) => autoPilotSourceWritePathClient(fileRef)) &&
    !hasUnsafeSourceWriteDiffClient(diffText)
  ) {
    return "source";
  }
  return "";
}

function isWriteLaneEnabled(lane) {
  return lane === "content"
    ? state.session?.autoPilotWriteLaneContent === true
    : lane === "ui_tests"
      ? state.session?.autoPilotWriteLaneUiTests === true
      : state.session?.autoPilotWriteLaneSource === true;
}

function recentAutoPilotSuggestions(limit = 40, minCount = 3) {
  const entries = Array.isArray(state.timeline?.entries) ? state.timeline.entries : [];
  const counts = new Map();
  for (const entry of entries
    .filter((item) => isManualApprovedWriteEntry(item))
    .sort((a, b) => (Number(b.createdAtMs) || 0) - (Number(a.createdAtMs) || 0))
    .slice(0, limit)) {
    const lane = classifyManualWriteLaneSuggestion(entry);
    if (!lane || isWriteLaneEnabled(lane)) {
      continue;
    }
    counts.set(lane, (counts.get(lane) || 0) + 1);
  }
  return ["content", "ui_tests", "source"]
    .map((lane) => ({ lane, count: counts.get(lane) || 0 }))
    .filter((item) => item.count >= minCount);
}

function firstMarkdownCodeFence(text) {
  const match = String(text || "").match(/```(?:\w+)?\n([\s\S]*?)\n```/u);
  return normalizeClientText(match?.[1] || "");
}

function truncateUiText(value, maxGlyphs = 92) {
  const normalized = normalizeClientText(value || "");
  if (!normalized) {
    return "";
  }
  const glyphs = Array.from(normalized);
  return glyphs.length > maxGlyphs ? `${glyphs.slice(0, maxGlyphs).join("")}…` : normalized;
}

function autoPilotEntryHeadline(item) {
  const mode = autoPilotEntryMode(item);
  if (mode === "read") {
    return truncateUiText(firstMarkdownCodeFence(item?.messageText || "") || item?.summary || item?.title || "");
  }

  const fileRefs = normalizeClientFileRefs(item?.fileRefs);
  const primaryRef = fileRefs[0] || item?.summary || item?.title || "";
  const extraCount = Math.max(0, fileRefs.length - 1);
  const stats =
    Number.isFinite(Number(item?.diffAddedLines)) && Number.isFinite(Number(item?.diffRemovedLines))
      ? ` (+${Math.max(0, Number(item?.diffAddedLines) || 0)} / -${Math.max(0, Number(item?.diffRemovedLines) || 0)})`
      : "";
  return truncateUiText(`${primaryRef}${extraCount > 0 ? ` +${extraCount}` : ""}${stats}`);
}

function renderSettingsAutoPilotRecentEntry(item) {
  const mode = autoPilotEntryMode(item);
  const badgeLabel = mode === "write" ? L("settings.autoPilot.recentWrite") : L("settings.autoPilot.recentRead");
  const badgeClass = mode === "write" ? "settings-compose-badge--write" : "settings-compose-badge--read";
  const iconName = mode === "write" ? "file-event" : "approval";
  const iconToneClass = mode === "write" ? "settings-icon-entry__icon--write" : "settings-icon-entry__icon--read";
  const headline = autoPilotEntryHeadline(item) || L("common.untitledItem");
  const threadLabel = resolvedThreadLabel(item?.threadId || "", item?.threadLabel || "");
  const laneLabel = ({
    content: L("settings.autoPilot.recentContent"),
    "ui_tests": L("settings.autoPilot.recentUiTests"),
    source: L("settings.autoPilot.recentSource"),
  }[autoPilotEntryWriteLane(item)] || "");
  const metaParts = [providerDisplayName(item?.provider), formatTimelineTimestamp(item?.createdAtMs)].filter(Boolean);

  return `
    <button
      type="button"
      class="settings-compose-entry settings-icon-entry settings-autopilot-entry"
      data-open-item-kind="${escapeHtml(item.kind)}"
      data-open-item-token="${escapeHtml(item.token)}"
      data-source-tab="timeline"
    >
      <span class="settings-icon-entry__icon ${iconToneClass}" aria-hidden="true">${renderIcon(iconName)}</span>
      <span class="settings-icon-entry__body">
        <span class="settings-icon-entry__title-row">
          <span class="settings-compose-entry__title">${escapeHtml(headline)}</span>
          <span class="settings-compose-badge ${badgeClass}">${escapeHtml(badgeLabel)}</span>
          ${mode === "write" && laneLabel ? `<span class="settings-compose-badge settings-compose-badge--lane">${escapeHtml(laneLabel)}</span>` : ""}
        </span>
        <span class="settings-autopilot-entry__meta">${escapeHtml(metaParts.join(" · "))}</span>
        ${threadLabel ? `<span class="settings-autopilot-entry__thread">${escapeHtml(threadLabel)}</span>` : ""}
      </span>
    </button>
  `;
}

function renderSettingsAutoPilotSuggestion({ lane, count }) {
  const title =
    lane === "content"
      ? L("settings.autoPilot.suggestionContentTitle")
      : lane === "ui_tests"
        ? L("settings.autoPilot.suggestionUiTestsTitle")
        : L("settings.autoPilot.suggestionSourceTitle");
  const body =
    lane === "content"
      ? L("settings.autoPilot.suggestionContentBody", { count })
      : lane === "ui_tests"
        ? L("settings.autoPilot.suggestionUiTestsBody", { count })
        : L("settings.autoPilot.suggestionSourceBody", { count });
  return `
    <div class="settings-suggestion-card">
      <div class="settings-suggestion-card__header">
        <div>
          <p class="settings-suggestion-card__title">${escapeHtml(title)}</p>
          <p class="settings-suggestion-card__body">${escapeHtml(body)}</p>
        </div>
        <button
          type="button"
          class="primary settings-suggestion-card__action"
          data-auto-pilot-suggest-lane="${escapeHtml(lane)}"
        >${escapeHtml(L("settings.autoPilot.suggestionEnable"))}</button>
      </div>
    </div>
  `;
}

function renderSettingsExternalLink({ href, label }) {
  return `
    <a class="settings-external-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;justify-content:flex-end;gap:.32rem;text-decoration:none;color:#8fd7ff;max-width:100%;">
      <span class="settings-external-link__label">${escapeHtml(label)}</span>
      <span class="settings-external-link__icon" aria-hidden="true" style="display:inline-flex;width:.86rem;height:.86rem;flex:0 0 auto;">${renderIcon("external-link")}</span>
    </a>
  `.trim();
}

function renderSettingsMoltbookPage(context) {
  const scout = context.moltbookScout;
  if (!scout?.enabled) {
    return `
      <div class="settings-page">
        <p class="settings-page-copy muted">${escapeHtml(L("settings.moltbook.unavailable"))}</p>
      </div>
    `;
  }
  const batchRows = scout.batch ? [
    renderSettingsInfoRow(L("settings.row.moltbookBatchCandidates"), String(scout.batch.candidateCount)),
    renderSettingsInfoRow(L("settings.row.moltbookBatchTopScore"), String(scout.batch.topScore)),
    renderSettingsInfoRow(L("settings.row.moltbookBatchRemaining"), `${Math.floor(scout.batch.remainingSeconds / 60)}:${String(scout.batch.remainingSeconds % 60).padStart(2, "0")}`),
  ] : [];
  const accountProfileLink = scout.account?.name && scout.account?.profileUrl
    ? renderSettingsExternalLink({
        href: scout.account.profileUrl,
        label: scout.account.name,
      })
    : "";
  const accountRow = accountProfileLink
    ? renderSettingsInfoRow(
        L("settings.row.moltbookAccount"),
        accountProfileLink,
        { rawValue: true }
      )
    : null;
  return `
    <div class="settings-page">
      ${accountRow ? renderSettingsGroup("", [accountRow]) : ""}
      ${renderSettingsGroup("", [
        renderSettingsInfoRow(L("settings.row.moltbookQuota"), `${scout.sentToday} / ${scout.maxDaily}`),
        renderSettingsInfoRow(L("settings.row.moltbookComposed"), `${scout.composedToday || 0} / 3`),
        renderSettingsInfoRow(L("settings.row.moltbookSeenPosts"), String(scout.seenPostCount)),
      ])}
      ${batchRows.length ? renderSettingsGroup(L("settings.moltbook.batchTitle"), batchRows) : ""}
      ${(() => {
        const titles = Array.isArray(scout.recentComposeTitles) ? scout.recentComposeTitles : [];
        if (!titles.length) return "";
        const PAGE_SIZE = 5;
        const visibleCount = state.moltbookRecentTitlesExpanded || PAGE_SIZE;
        const visible = titles.slice(0, visibleCount);
        const hasMore = titles.length > visibleCount;
        const rows = visible.map((t) => {
          const title = typeof t === "string" ? t : (t.title || "");
          const postId = typeof t === "object" ? t.postId : "";
          const type = typeof t === "object" ? (t.type || "post") : "post";
          const badge = type === "reply"
            ? `<span class="settings-compose-badge settings-compose-badge--reply">${escapeHtml(L("settings.moltbook.typeReply"))}</span>`
            : `<span class="settings-compose-badge settings-compose-badge--post">${escapeHtml(L("settings.moltbook.typePost"))}</span>`;
          const link = postId
            ? `<a href="https://www.moltbook.com/post/${escapeHtml(postId)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`
            : escapeHtml(title);
          const iconName = type === "reply" ? "moltbook-reply" : "moltbook-draft";
          const iconTone = type === "reply" ? "settings-icon-entry__icon--reply" : "settings-icon-entry__icon--post";
          return `
            <div class="settings-compose-entry settings-icon-entry">
              <span class="settings-icon-entry__icon ${iconTone}" aria-hidden="true">${renderIcon(iconName)}</span>
              <span class="settings-icon-entry__body">
                <span class="settings-icon-entry__title-row">
                  <span class="settings-compose-entry__title">${link}</span>
                  ${badge}
                </span>
              </span>
            </div>
          `;
        });
        if (hasMore) {
          const remaining = titles.length - visibleCount;
          rows.push(`<button type="button" class="settings-compose-more" data-moltbook-titles-more>${escapeHtml(L("settings.moltbook.showMore", { count: remaining }))}</button>`);
        } else if (titles.length > PAGE_SIZE) {
          rows.push(`<button type="button" class="settings-compose-more" data-moltbook-titles-collapse>${escapeHtml(L("settings.moltbook.showLess"))}</button>`);
        }
        return renderSettingsGroup(L("settings.row.moltbookRecentTitles"), rows);
      })()}
    </div>
  `;
}

function renderSettingsA2aRelayPage(context) {
  const relay = context.a2aRelay;
  if (!relay?.enabled) {
    return `
      <div class="settings-page">
        <p class="settings-page-copy muted">${escapeHtml(L("settings.a2aRelay.unavailable"))}</p>
      </div>
    `;
  }
  const statusLabel = relay.connected
    ? L("settings.status.connected")
    : relay.polling
      ? L("settings.a2aRelay.status.polling")
      : L("settings.a2aRelay.status.disconnected");
  const profileUrl = `${relay.relayUrl}/u/${relay.userId}`;
  const userIdLink = renderSettingsExternalLink({
    href: profileUrl,
    label: relay.userId,
  });
  const relayHost = (() => { try { return new URL(relay.relayUrl).host; } catch { return relay.relayUrl; } })();
  const publicChecked = relay.acceptPublicTasks === true;

  // Executor preference section
  const executors = state.session?.a2aExecutors || { codex: false, claude: false };
  const currentExec = state.session?.a2aExecutorPreference || "ask";
  const bothAvailable = executors.codex && executors.claude;
  const execOptions = [
    { id: "ask", label: L("settings.a2aExecutor.ask") },
  ];
  if (executors.codex) execOptions.push({ id: "codex", label: L("settings.a2aExecutor.codex"), detected: true });
  if (executors.claude) execOptions.push({ id: "claude", label: L("settings.a2aExecutor.claude"), detected: true });
  if (bothAvailable) {
    execOptions.push({ id: "auto", label: L("settings.a2aExecutor.auto") });
  }

  return `
    <div class="settings-page">
      ${renderSettingsGroup("", [
        renderSettingsInfoRow(L("settings.row.a2aStatus"), statusLabel),
        renderSettingsInfoRow(L("settings.row.a2aUserId"), userIdLink, { rawValue: true }),
        renderSettingsInfoRow(L("settings.row.a2aRelay"), relayHost),
        renderSettingsInfoRow(L("settings.row.a2aApiKey"), relay.apiKeyConfigured ? L("settings.a2aRelay.apiKey.configured") : L("settings.a2aRelay.apiKey.notConfigured")),
        relay.lastPollAtMs
          ? renderSettingsInfoRow(L("settings.row.a2aLastPoll"), new Date(relay.lastPollAtMs).toLocaleString(state.locale))
          : "",
      ].filter(Boolean))}
      ${(() => {
        const stats = relay.taskStats || { received: 0, completed: 0, denied: 0 };
        return renderSettingsGroup(L("settings.a2aRelay.taskStats.title"), [
          renderSettingsInfoRow(L("settings.row.a2aTaskReceived"), String(stats.received)),
          renderSettingsInfoRow(L("settings.row.a2aTaskCompleted"), String(stats.completed)),
          renderSettingsInfoRow(L("settings.row.a2aTaskDenied"), String(stats.denied)),
        ]);
      })()}
      <section class="settings-group">
        <p class="settings-group__title">${escapeHtml(L("settings.a2aRelay.publicTasks.title"))}</p>
        <label class="reply-mode-switch reply-mode-switch--settings" data-a2a-public-toggle>
          <input type="checkbox" class="reply-mode-switch__input" ${publicChecked ? "checked" : ""} data-a2a-public-checkbox />
          <span class="reply-mode-switch--settings__toggle">
            <span class="reply-mode-switch__track" aria-hidden="true"><span class="reply-mode-switch__thumb"></span></span>
            <span class="reply-mode-switch__state">${escapeHtml(publicChecked ? L("settings.claudeAway.on") : L("settings.claudeAway.off"))}</span>
          </span>
          <span class="reply-mode-switch__hint">${escapeHtml(L("settings.a2aRelay.publicTasks.description"))}</span>
        </label>
      </section>
      ${renderSettingsGroup(L("settings.a2aExecutor.title"), [
        `<p class="settings-group__description">${escapeHtml(L("settings.a2aExecutor.copy"))}</p>`,
        ...execOptions.map((opt) => `
          <label class="settings-radio-row" data-a2a-executor-option="${escapeHtml(opt.id)}">
            <input type="radio" name="a2aExecutor" value="${escapeHtml(opt.id)}"
              ${currentExec === opt.id ? "checked" : ""} />
            <span class="settings-radio-row__label">${escapeHtml(opt.label)}</span>
            ${opt.detected ? `<span class="settings-radio-row__badge">✓ ${escapeHtml(L("settings.a2aExecutor.detected"))}</span>` : ""}
          </label>
        `),
      ])}
    </div>
  `;
}

function renderSettingsA2aSharePage(context) {
  const share = context.a2aShare;
  if (!share?.enabled) {
    return `
      <div class="settings-page">
        <p class="settings-page-copy muted">${escapeHtml(L("settings.a2aShare.unavailable"))}</p>
      </div>
    `;
  }
  const quota = share.quota || { bytes: 0, maxBytes: 0, count: 0, maxCount: 0 };
  const limits = share.limits || {};
  const items = Array.isArray(share.items) ? share.items : [];
  const statusLabel = share.error
    ? L("settings.a2aShare.status.unreachable")
    : L("settings.status.enabled");
  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes)) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };
  const storageValue = share.quota
    ? `${formatBytes(quota.bytes)} / ${formatBytes(quota.maxBytes || limits.maxTotalBytes || 0)}`
    : "—";
  const filesValue = share.quota
    ? `${quota.count} / ${quota.maxCount || limits.maxFiles || 0}`
    : "—";
  const storageRows = [
    renderSettingsInfoRow(L("settings.row.a2aShareStorage"), storageValue),
    renderSettingsInfoRow(L("settings.row.a2aShareFiles"), filesValue),
    renderSettingsInfoRow(L("settings.row.a2aShareMaxFileSize"), formatBytes(limits.maxFileBytes || 0)),
    renderSettingsInfoRow(
      L("settings.row.a2aShareDefaultExpiry"),
      L("settings.a2aShare.days", { count: limits.defaultExpiresDays || 30 })
    ),
    renderSettingsInfoRow(
      L("settings.row.a2aShareUploadRate"),
      L("settings.a2aShare.ratePerHour", { count: limits.uploadRatePerHour || 10 })
    ),
  ];

  const PAGE_SIZE = 5;
  const visibleCount = state.a2aShareRecentExpanded || PAGE_SIZE;
  const visible = items.slice(0, visibleCount);
  const hasMore = items.length > visibleCount;
  const filesList = visible.map((item) => {
    // Badges use SVG icons (see renderIcon "lock" / "coin") to match the
    // rest of the settings UI. `title` drives the hover tooltip;
    // `aria-label` names the span for screen readers since the SVG itself
    // is decorative.
    const passwordLabel = L("settings.a2aShare.passwordProtected");
    const lock = item.hasPassword
      ? `<span class="settings-compose-badge settings-compose-badge--reply" role="img" title="${escapeHtml(passwordLabel)}" aria-label="${escapeHtml(passwordLabel)}">${renderIcon("lock")}</span>`
      : "";
    // Paid-share badge. `price` is atomic USDC (6-decimals) on the item.
    // Mutually exclusive with hasPassword at upload time, so the two badges
    // never both render, but the HTML doesn't assume that — it just renders
    // whichever are set.
    const paidLabel = item.price
      ? L("settings.a2aShare.paidShare", {
          price: formatUsdcAtomic(item.price),
          network: item.network || "?",
        })
      : "";
    const paid = item.price
      ? `<span class="settings-compose-badge settings-compose-badge--paid" role="img" title="${escapeHtml(paidLabel)}" aria-label="${escapeHtml(paidLabel)}">${renderIcon("coin")}</span>`
      : "";
    const label = escapeHtml(item.originalName || item.slug);
    const link = item.url
      ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${label}</a>`
      : label;
    const sizeText = escapeHtml(formatBytes(item.size || 0));
    const createdText = item.createdAtMs
      ? escapeHtml(formatRelativeAge(Date.now() - item.createdAtMs))
      : "";
    const expiresText = item.expiresAtMs
      ? escapeHtml(formatExpiresIn(item.expiresAtMs - Date.now()))
      : "";
    const meta = [sizeText, createdText, expiresText].filter(Boolean).join(" · ");
    return `
      <div class="settings-compose-entry settings-icon-entry">
        <span class="settings-icon-entry__icon settings-icon-entry__icon--file" aria-hidden="true">${renderIcon("file-event")}</span>
        <span class="settings-icon-entry__body">
          <span class="settings-icon-entry__title-row">
            <span class="settings-compose-entry__title">${link}</span>
            ${lock}${paid}
          </span>
          ${meta ? `<span class="settings-compose-entry__meta muted">${meta}</span>` : ""}
        </span>
      </div>
    `;
  });
  if (hasMore) {
    const remaining = items.length - visibleCount;
    filesList.push(
      `<button type="button" class="settings-compose-more" data-a2a-share-files-more>${escapeHtml(L("settings.a2aShare.showMore", { count: remaining }))}</button>`
    );
  } else if (items.length > PAGE_SIZE) {
    filesList.push(
      `<button type="button" class="settings-compose-more" data-a2a-share-files-collapse>${escapeHtml(L("settings.a2aShare.showLess"))}</button>`
    );
  }

  return `
    <div class="settings-page">
      ${renderSettingsGroup("", [
        renderSettingsInfoRow(L("settings.row.a2aShareStatus"), statusLabel),
        renderSettingsInfoRow(L("settings.row.a2aShareEndpoint"), share.shareHost || share.shareUrl || ""),
        renderSettingsInfoRow(L("settings.row.a2aShareUserId"), share.userId || ""),
      ])}
      ${renderSettingsGroup(L("settings.a2aShare.storage.title"), storageRows)}
      ${items.length
        ? renderSettingsGroup(L("settings.a2aShare.files.title"), filesList)
        : renderSettingsGroup(L("settings.a2aShare.files.title"), [
            `<p class="settings-group__description muted">${escapeHtml(L("settings.a2aShare.files.empty"))}</p>`,
          ])}
      ${share.error ? `<p class="settings-page-copy muted">${escapeHtml(L("settings.a2aShare.error", { reason: share.error }))}</p>` : ""}
    </div>
  `;
}

function renderSettingsRemotePairingPage(context) {
  // Always render — remote pairing is a feature toggle, not a credential-
  // gated integration. If the bridge hasn't responded with a status payload
  // yet, fall back to a default-disabled view so the toggle still works.
  const status = context.remotePairing || {
    enabled: false,
    relayUrl: "",
    configuredRelayUrl: "",
    identityFingerprint: null,
    sessions: [],
    pairings: [],
    auditEvents: [],
  };

  const enabled = status.enabled === true;
  const sessions = Array.isArray(status.sessions) ? status.sessions : [];
  const pairings = Array.isArray(status.pairings) ? status.pairings : [];
  const auditEvents = Array.isArray(status.auditEvents) ? status.auditEvents : [];
  const usingRelay = isRemotePairingUsingRelay();
  const statusModel = remotePairingStatusModel(status, { usingRelay });
  const sessionsByPub = new Map(
    sessions.map((s) => [String(s.phonePub || "").toLowerCase(), s]),
  );
  const sessionsByPairingId = new Map(
    sessions.map((s) => [String(s.pairingId || ""), s]),
  );
  const togglePending = state.remotePairingPending === "toggle";
  const relayPending = state.remotePairingPending === "relayUrl";

  // "This device" — the locally-stored enrollment record (if any). Read
  // synchronously from localStorage on each render so the badge shows up
  // immediately after a successful lan-enroll without waiting for state
  // refresh. Returns null in storage-disabled contexts (Safari private
  // mode etc.) — the page just renders without the indicator.
  const localPairing = (() => {
    try {
      return loadRemotePairingState();
    } catch {
      return null;
    }
  })();
  const localPhonePub = (localPairing?.phonePub || "").toLowerCase();
  const localRegistered = Boolean(localPairing);

  // Identity fingerprint row — shows the bridge's stable public key short-
  // form so the human can verify what the phone is pairing against.
  const fpRow = renderSettingsInfoRow(
    L("settings.remotePairing.identity.fingerprint"),
    status.identityFingerprint || L("settings.remotePairing.identity.empty"),
  );

  const connectionSection = `
    <section class="settings-remote-connection">
      <header class="settings-remote-connection__header">
        <div class="settings-remote-connection__copy">
          <p class="settings-remote-connection__title">${escapeHtml(L("settings.remotePairing.connection.title"))}</p>
        </div>
        <span class="settings-remote-status settings-remote-status--${escapeHtml(statusModel.tone)}">${escapeHtml(statusModel.label)}</span>
      </header>
      <label class="reply-mode-switch reply-mode-switch--settings" data-remote-pairing-toggle>
        <input type="checkbox" class="reply-mode-switch__input"
          ${enabled ? "checked" : ""}
          ${togglePending ? "disabled" : ""}
          data-remote-pairing-toggle-checkbox />
        <span class="reply-mode-switch--settings__toggle">
          <span class="reply-mode-switch__track" aria-hidden="true"><span class="reply-mode-switch__thumb"></span></span>
          <span class="reply-mode-switch__state">${escapeHtml(enabled ? L("settings.claudeAway.on") : L("settings.claudeAway.off"))}</span>
        </span>
        <span class="reply-mode-switch__hint">${escapeHtml(L("settings.remotePairing.toggle.description"))}</span>
      </label>
      <p class="settings-remote-connection__trust">${escapeHtml(L("settings.remotePairing.security.copy"))}</p>
    </section>
  `;

  // Relay URL editor. When empty, the bridge falls back to the compiled-in
  // default — surfacing that here would require leaking it to the client,
  // so we just show "" and lean on the placeholder.
  const relayUrlValue = String(status.configuredRelayUrl || "");
  const relayUrlSection = `
    <section class="settings-group">
      <p class="settings-group__title">${escapeHtml(L("settings.remotePairing.relayUrl.title"))}</p>
      <div class="settings-input-row">
        <input type="text"
          class="settings-input"
          data-remote-pairing-relay-url-input
          value="${escapeHtml(relayUrlValue)}"
          placeholder="${escapeHtml(L("settings.remotePairing.relayUrl.placeholder"))}"
          ${relayPending ? "disabled" : ""}
          autocomplete="off"
          spellcheck="false" />
        <button type="button"
          class="secondary"
          data-remote-pairing-relay-url-save
          ${relayPending ? "disabled" : ""}>
          ${escapeHtml(L("settings.remotePairing.relayUrl.save"))}
        </button>
      </div>
      <p class="settings-group__description">${escapeHtml(L("settings.remotePairing.relayUrl.help"))}</p>
    </section>
  `;

  // Pairings list — one card per phonePub on disk. "Live" badge if there's
  // an open session; otherwise show the last-seen timestamp. The phone
  // currently rendering this page gets an extra "This device" badge so the
  // user can identify themselves in the list (especially useful when more
  // than one phone is paired to the same Mac).
  const otherPairings = localPhonePub
    ? pairings.filter((p) => String(p.phonePub || "").toLowerCase() !== localPhonePub)
    : pairings;
  const pairingsRows = otherPairings.length === 0
    ? `<div class="settings-copy-block"><p class="muted">${escapeHtml(L("settings.remotePairing.pairings.empty"))}</p></div>`
    : `<div class="device-list">
        ${otherPairings.map((p) => {
        const session = sessionsByPub.get(String(p.phonePub || "").toLowerCase())
          || sessionsByPairingId.get(String(p.pairingId || ""));
        const live = isRemotePairingSessionConnected(session);
        const lastSeenAtMs = Number(session?.lastSeenAtMs || p.lastSeenAtMs) || 0;
        const lastSeen = lastSeenAtMs
          ? new Date(lastSeenAtMs).toLocaleString(state.locale)
          : L("settings.remotePairing.pairings.never");
        const added = p.addedAtMs
          ? new Date(p.addedAtMs).toLocaleString(state.locale)
          : L("settings.remotePairing.pairings.never");
        const pendingThis = state.remotePairingPending === `revoke:${p.phonePub}`;
        return `
          <article class="device-card" data-remote-pairing-row="${escapeHtml(p.phonePub)}">
            <div class="device-card__header">
              <div class="device-card__title-wrap">
                <div class="device-card__headline">
                  <span class="device-card__icon" aria-hidden="true">${renderIcon("iphone")}</span>
                  <h3 class="device-card__title">${escapeHtml(p.label || p.phoneFingerprint || p.pairingId)}</h3>
                </div>
                <p class="device-card__subtitle">${escapeHtml(p.phoneFingerprint || p.phonePub.slice(0, 16))}</p>
              </div>
              <div class="device-card__badges">
                <span class="device-card__badge ${live ? "device-card__badge--live" : "device-card__badge--offline"}">
                  ${escapeHtml(live ? L("settings.remotePairing.pairings.live") : L("settings.remotePairing.pairings.offline"))}
                </span>
              </div>
            </div>
            <div class="device-card__meta">
              ${renderDeviceMetaRow(L("settings.remotePairing.pairings.added"), added)}
              ${renderDeviceMetaRow(L("settings.remotePairing.pairings.lastSeen"), lastSeen)}
            </div>
            <div class="device-card__actions">
              <button type="button"
                class="secondary secondary--wide"
                data-remote-pairing-revoke="${escapeHtml(p.phonePub)}"
                ${pendingThis ? "disabled" : ""}>
                ${escapeHtml(L("settings.remotePairing.pairings.revoke"))}
              </button>
            </div>
          </article>
        `;
      }).join("")}
      </div>`;

  // "This device" group — sits above the pairings list and tells the user
  // explicitly whether *this phone* (the one rendering the page) is the
  // enrolled one. Two states:
  //   1. Enrolled: show the phone fingerprint + a confirmation copy.
  //   2. Not enrolled: surface a hint that re-pairing on LAN registers
  //      the device. (The hint applies even when other phones are paired
  //      — they're not relevant to this device's relay status.)
  const thisDeviceSection = (() => {
    if (localRegistered) {
      const fingerprint = localPairing.phoneFingerprint
        || localPairing.phonePub.slice(0, 16);
      const rotatePending = state.remotePairingPending === "rotateToken";
      return renderSettingsGroup(L("settings.remotePairing.thisDevice.title"), [
        `
          <div class="device-list">
            <article class="device-card">
              <div class="device-card__header">
                <div class="device-card__title-wrap">
                  <div class="device-card__headline">
                    <span class="device-card__icon" aria-hidden="true">${renderIcon("iphone")}</span>
                    <h3 class="device-card__title">${escapeHtml(L("settings.remotePairing.thisDevice.registeredTitle"))}</h3>
                  </div>
                  <p class="device-card__subtitle">${escapeHtml(fingerprint)}</p>
                </div>
                <span class="device-card__badge">${escapeHtml(L("settings.remotePairing.pairings.thisDevice"))}</span>
              </div>
              <div class="device-card__meta">
                ${renderDeviceMetaRow(L("settings.remotePairing.status.title"), statusModel.label)}
                ${renderDeviceMetaRow(L("settings.remotePairing.thisDevice.fingerprint"), fingerprint)}
              </div>
              <div class="device-card__actions">
                <button type="button"
                  class="secondary secondary--wide"
                  data-remote-pairing-rotate-token
                  ${rotatePending || usingRelay ? "disabled" : ""}>
                  ${escapeHtml(L("settings.remotePairing.token.rotate"))}
                </button>
              </div>
              ${usingRelay ? `<p class="settings-page-copy muted settings-remote-device-hint">${escapeHtml(L("settings.remotePairing.token.lanOnly"))}</p>` : ""}
            </article>
          </div>
        `,
      ]);
    }
    return renderSettingsGroup(L("settings.remotePairing.thisDevice.title"), [
      `
        <div class="device-list">
          <article class="device-card">
            <div class="device-card__header">
              <div class="device-card__title-wrap">
                <div class="device-card__headline">
                  <span class="device-card__icon" aria-hidden="true">${renderIcon("iphone")}</span>
                  <h3 class="device-card__title">${escapeHtml(L("settings.remotePairing.thisDevice.notEnrolledTitle"))}</h3>
                </div>
              </div>
            </div>
            <div class="device-card__meta">
              ${renderDeviceMetaRow(L("settings.remotePairing.status.title"), L("settings.remotePairing.status.disabled"))}
              ${renderDeviceMetaRow(L("settings.remotePairing.thisDevice.fingerprint"), L("common.unavailable"))}
            </div>
            <p class="settings-page-copy muted settings-remote-device-hint">${escapeHtml(L("settings.remotePairing.thisDevice.notEnrolled"))}</p>
          </article>
        </div>
      `,
    ]);
  })();

  const detailsSection = `
    <details class="settings-disclosure settings-remote-details" data-remote-pairing-details ${state.remotePairingDetailsOpen ? "open" : ""}>
      <summary>${escapeHtml(L("settings.remotePairing.details.title"))}</summary>
      <div class="settings-disclosure__body">
        ${relayUrlSection}
        ${renderSettingsGroup(L("settings.remotePairing.identity.title"), [fpRow])}
      </div>
    </details>
  `;
  const auditSection = renderSettingsGroup(L("settings.remotePairing.audit.title"), [
    renderRemotePairingAudit(auditEvents),
  ]);

  const noticeBlock = state.remotePairingNotice
    ? `<p class="settings-page-copy">${escapeHtml(state.remotePairingNotice)}</p>`
    : "";
  const errorBlock = state.remotePairingError
    ? `<p class="settings-page-copy danger">${escapeHtml(state.remotePairingError)}</p>`
    : "";

  return `
    <div class="settings-page">
      ${noticeBlock}
      ${errorBlock}
      ${connectionSection}
      ${thisDeviceSection}
      ${renderSettingsGroup(L("settings.remotePairing.pairings.otherTitle"), [pairingsRows])}
      ${auditSection}
      ${detailsSection}
    </div>
  `;
}

function renderSettingsWalletPage(context) {
  const hazbase = context.hazbase || { enabled: false };
  if (!hazbase?.enabled) {
    return `
      <div class="settings-page">
        <p class="settings-page-copy muted">${escapeHtml(L("settings.wallet.unavailable"))}</p>
      </div>
    `;
  }
  const flow = deriveHazbaseWalletFlow(hazbase);

  // Progressive disclosure. Previous layout rendered the full status summary
  // plus all four full-sized step cards at once; new account flows were
  // dominated by locked-looking cards and it was hard to tell which step was
  // actionable. Now we:
  //  - skip `locked` steps entirely (still-unreachable actions add noise),
  //  - collapse `complete` steps to a compact one-line row that keeps the
  //    verified value visible (email / address) without a full card,
  //  - keep the single `current`/`pending` step in the full action card so
  //    the CTA is unambiguous,
  //  - hide the optional mainnet step behind a subtle opt-in link until the
  //    user explicitly requests it (see `state.hazbaseMainnetOptIn`).
  // The compact rows also replace the former "Current status" summary group
  // above the flow, so signed-in email / passkey state / addresses are no
  // longer duplicated.
  const guideRows = [
    renderHazbaseWalletBanner(flow),
    renderHazbaseWalletBetaNotice(),
    state.hazbaseNotice
      ? `<div class="settings-copy-block settings-copy-block--compact wallet-flow-message wallet-flow-message--notice"><p>${escapeHtml(state.hazbaseNotice)}</p></div>`
      : "",
    state.hazbaseError
      ? `<div class="settings-copy-block settings-copy-block--compact wallet-flow-message wallet-flow-message--error"><p>${escapeHtml(state.hazbaseError)}</p></div>`
      : "",
    renderHazbaseWalletStepList(flow),
  ].filter(Boolean);
  const canRefreshSession = Boolean(hazbase.sessionInvalid);
  const advancedActions = canRefreshSession || hazbase.signedIn
    ? [
        canRefreshSession
          ? `<button class="secondary secondary--wide" type="button" data-hazbase-action="refresh-session">${escapeHtml(L("settings.hazbase.action.refreshSession"))}</button>`
          : "",
        hazbase.signedIn
          ? `<button class="secondary secondary--wide" type="button" data-hazbase-action="logout">${escapeHtml(L("settings.hazbase.action.signOut"))}</button>`
          : "",
      ].filter(Boolean).join("")
    : "";
  // Render the wallet flow without `renderSettingsGroup`'s `.settings-list`
  // wrapper. The banner (`.settings-copy-block`), notice/error blocks, and
  // each step card (`.wallet-step-card`) already have their own rounded
  // frame — wrapping them in another `.settings-list` produced a visible
  // "box inside a box" nest. The title (`.settings-group__title`) still
  // sits above a flat stack of sibling cards via `.wallet-setup-stack`.
  const flowTitle = L("settings.wallet.flow.title");
  // Brand attribution. The wallet stack (factory + validator + bundler +
  // paymaster) is provided by hazBase; the link points to their LP so
  // curious users can discover what's running the signing path.
  const poweredBy = `
    <p class="wallet-powered-by muted">
      powered by <a href="https://lp.hazbase.com" target="_blank" rel="noopener noreferrer">hazBase</a>
    </p>
  `;
  return `
    <div class="settings-page">
      <section class="settings-group">
        ${flowTitle ? `<p class="settings-group__title">${escapeHtml(flowTitle)}</p>` : ""}
        <div class="wallet-setup-stack">
          ${guideRows.join("")}
        </div>
      </section>
      ${advancedActions ? renderSettingsActionPanel(advancedActions, L("settings.wallet.advanced.title")) : ""}
      ${poweredBy}
    </div>
  `;
}

function renderHazbaseWalletStepList(flow) {
  const rendered = [];
  for (const step of flow.steps) {
    // Keep the Base mainnet roadmap visible only after the usable Base Sepolia
    // wallet is ready. Showing Step 4 during email/passkey setup makes the
    // sequential flow feel like there is another action competing for focus.
    if (step.number === 4 && step.status === "comingSoon" && !flow.coreReady) {
      continue;
    }

    // Locked steps don't render. Revealing them only adds grayed-out
    // placeholders below the active step; users mistake the placeholder
    // status chips for inactive buttons.
    if (step.status === "locked") {
      continue;
    }

    const mode = step.status === "complete" ? "compact" : "full";
    rendered.push(renderHazbaseWalletStepCard(step, { mode }));
  }
  return `<div class="wallet-step-list">${rendered.join("")}</div>`;
}

function renderHazbaseWalletMainnetOptIn() {
  return `
    <button class="wallet-mainnet-optin" type="button" data-hazbase-action="mainnet-opt-in">
      <span class="wallet-mainnet-optin__body">
        <span class="wallet-mainnet-optin__label">${escapeHtml(L("settings.wallet.mainnet.optIn"))}</span>
        <span class="wallet-mainnet-optin__hint muted">${escapeHtml(L("settings.wallet.mainnet.optInHint"))}</span>
      </span>
      <span class="wallet-mainnet-optin__chevron" aria-hidden="true">→</span>
    </button>
  `;
}

function deriveHazbaseWalletFlow(hazbase) {
  const accounts = Array.isArray(hazbase.accounts) ? hazbase.accounts : [];
  const baseSepolia = accounts.find((entry) => Number(entry.chainId) === 84532) || null;
  const baseMainnet = accounts.find((entry) => Number(entry.chainId) === 8453) || null;
  const sessionInvalid = Boolean(hazbase.sessionInvalid);
  const signedIn = Boolean(hazbase.signedIn) && !sessionInvalid;
  const passkeyHost = hazbasePasskeyHostSupport();
  const hasPasskey = Boolean(hazbase.credentialId || hazbase.deviceBindingId);
  const hasBaseSepolia = Boolean(baseSepolia?.smartAccountAddress);
  const hasBaseMainnet = Boolean(baseMainnet?.smartAccountAddress);
  const coreReady = signedIn && hasPasskey && hasBaseSepolia;

  const actionButton = (labelKey, action, { primary = false, disabled = false } = {}) => `
    <button
      class="${primary ? "primary" : "secondary"} ${primary ? "primary--wide" : "secondary--wide"}"
      type="button"
      data-hazbase-action="${action}"
      ${disabled ? "disabled" : ""}
    >${escapeHtml(L(labelKey))}</button>
  `;

  return {
    hasPasskey,
    baseSepolia,
    baseMainnet,
    sessionInvalid,
    coreReady,
    steps: [
      {
        number: 1,
        icon: "approval",
        title: sessionInvalid ? L("settings.wallet.step.refreshSession.title") : L("settings.wallet.step.signIn.title"),
        copy: sessionInvalid ? L("settings.wallet.step.refreshSession.copy") : L("settings.wallet.step.signIn.copy"),
        detail: signedIn
          ? hazbase.email || L("settings.hazbase.status.signedIn")
          : state.hazbaseOtpRequested
            ? L("settings.hazbase.status.otpAwaitingVerify")
            : sessionInvalid
            ? L("settings.hazbase.status.sessionExpired")
            : L("settings.hazbase.status.signedOut"),
        status: signedIn ? "complete" : "current",
        // Inline form: email input (always visible pre-sign-in) and the
        // one-time password input (revealed after a successful send).
        // Putting the field immediately above its submit button is the
        // whole point — users don't have to guess "what does this button
        // ask me?" before clicking.
        form: signedIn
          ? ""
          : renderHazbaseSignInForm({
              email: state.hazbaseOtpEmail || hazbase.email || "",
              otpRequested: Boolean(state.hazbaseOtpRequested),
              code: state.hazbaseOtpCode || "",
            }),
        // Sequential flow: before a code is requested, only the primary
        // "send" action is visible. After a successful send we swap the
        // primary CTA to "verify" and demote "send" to a quieter "resend"
        // option in case the email never arrives. This keeps the user's
        // next move unambiguous.
        actions: signedIn
          ? []
          : state.hazbaseOtpRequested
            ? [
                actionButton("settings.hazbase.action.verifyOtp", "verify-otp", { primary: true }),
                actionButton("settings.hazbase.action.resendOtp", "request-otp"),
              ]
            : [
                actionButton(sessionInvalid ? "settings.hazbase.action.refreshSession" : "settings.hazbase.action.requestOtp", "request-otp", { primary: true }),
              ],
      },
      {
        number: 2,
        icon: "lock",
        title: L("settings.wallet.step.passkey.title"),
        copy: L("settings.wallet.step.passkey.copy"),
        detail: hasPasskey
          ? L("settings.hazbase.passkey.ready")
          : passkeyHost.eligible
            ? L("settings.hazbase.passkey.missing")
            : passkeyHost.detail,
        status: hasPasskey ? "complete" : signedIn ? "current" : "locked",
        actions: hasPasskey
          ? []
          : [
              actionButton("settings.hazbase.action.registerPasskey", "register-passkey", {
                primary: signedIn && passkeyHost.eligible,
                disabled: !signedIn || !passkeyHost.eligible,
              }),
            ],
      },
      {
        number: 3,
        icon: "coin",
        title: L("settings.wallet.step.baseSepolia.title"),
        copy: L("settings.wallet.step.baseSepolia.copy"),
        detail: baseSepolia?.smartAccountAddress || L("settings.hazbase.wallet.missing"),
        monoDetail: Boolean(baseSepolia?.smartAccountAddress),
        status: hasBaseSepolia ? "complete" : signedIn && hasPasskey ? "current" : "locked",
        actions: hasBaseSepolia
          ? []
          : [
              actionButton("settings.hazbase.action.bootstrapBaseSepolia", "bootstrap-base-sepolia", {
                primary: signedIn && hasPasskey,
                disabled: !signedIn || !hasPasskey,
              }),
            ],
      },
      {
        number: 4,
        icon: "coin",
        title: L("settings.wallet.step.base.title"),
        copy: L("settings.wallet.step.base.copy"),
        detail: baseMainnet?.smartAccountAddress || L("settings.wallet.step.base.comingSoonDetail"),
        monoDetail: Boolean(baseMainnet?.smartAccountAddress),
        status: hasBaseMainnet ? "complete" : "comingSoon",
        actions: [],
      },
    ],
  };
}

function renderHazbaseWalletBanner(flow) {
  const title = flow.sessionInvalid
    ? L("settings.wallet.sessionExpired.title")
    : flow.coreReady ? L("settings.wallet.ready.title") : L("settings.wallet.flow.banner.title");
  const className = flow.coreReady
    ? "settings-copy-block settings-copy-block--stacked wallet-flow-banner wallet-flow-banner--ready"
    : flow.sessionInvalid
      ? "settings-copy-block settings-copy-block--stacked wallet-flow-banner wallet-flow-banner--session-expired"
    : "settings-copy-block settings-copy-block--stacked wallet-flow-banner";
  // Ready state: surface the smart-account address prominently so the user
  // can see at a glance which wallet agents will use as `--pay-to` when
  // gating paid shares / A2A payouts. The address is the single most
  // actionable fact on this page once setup is complete — muted filler
  // copy buries it.
  const payoutAddress = flow.baseSepolia?.smartAccountAddress || "";
  const copyLabel = L("settings.wallet.ready.copyAddress");
  const body = flow.coreReady && payoutAddress
    ? `
      <p class="wallet-flow-banner__copy muted">${escapeHtml(L("settings.wallet.ready.payoutIntro"))}</p>
      <button
        class="wallet-flow-banner__address"
        type="button"
        data-wallet-address-copy="${escapeHtml(payoutAddress)}"
        aria-label="${escapeHtml(copyLabel)}: ${escapeHtml(payoutAddress)}"
      >
        <span class="wallet-flow-banner__address-text">${escapeHtml(payoutAddress)}</span>
        <span class="wallet-flow-banner__address-icon-slot">
          <span class="wallet-flow-banner__address-icon wallet-flow-banner__address-icon--copy" aria-hidden="true">${renderIcon("copy")}</span>
          <span class="wallet-flow-banner__address-icon wallet-flow-banner__address-icon--check" aria-hidden="true">${renderIcon("check")}</span>
        </span>
      </button>
    `
    : `<p class="wallet-flow-banner__copy muted">${escapeHtml(
        flow.sessionInvalid
          ? L("settings.wallet.sessionExpired.copy")
          : flow.coreReady ? L("settings.wallet.ready.copy") : L("settings.wallet.flow.copy"),
      )}</p>`;
  return `
    <div class="${className}">
      <p class="wallet-flow-banner__eyebrow">${escapeHtml(L("settings.hazbase.title"))}</p>
      <p class="wallet-flow-banner__title">${escapeHtml(title)}</p>
      ${body}
    </div>
  `;
}

function renderHazbaseWalletBetaNotice() {
  return `
    <div class="settings-copy-block settings-copy-block--compact wallet-beta-notice">
      <p>${escapeHtml(L("settings.wallet.betaNotice"))}</p>
    </div>
  `;
}

function renderHazbaseWalletStepCard(step, { mode = "full" } = {}) {
  const statusMeta = {
    complete: { label: L("settings.wallet.status.complete"), icon: "completed" },
    current: { label: L("settings.wallet.status.current"), icon: "pending" },
    locked: { label: L("settings.wallet.status.locked"), icon: "lock" },
    optional: { label: L("settings.wallet.status.optional"), icon: "coin" },
    comingSoon: { label: L("settings.wallet.status.comingSoon"), icon: "coin" },
    pending: { label: L("settings.wallet.status.pending"), icon: "pending" },
  }[step.status] || { label: L("settings.wallet.status.pending"), icon: "pending" };
  const statusChipHtml = step.status === "current"
    ? ""
    : `<span class="wallet-step-card__status wallet-step-card__status--${escapeHtml(step.status)}">
          <span class="wallet-step-card__status-icon" aria-hidden="true">${renderIcon(statusMeta.icon)}</span>
          <span>${escapeHtml(statusMeta.label)}</span>
        </span>`;

  if (mode === "compact") {
    // Compact row for finished steps. Keeps the check icon + title + one-line
    // detail visible (so the user can scan what's done at a glance) but
    // drops the copy/actions to stop the page from being four blocks tall.
    const detailClass = step.monoDetail
      ? "wallet-step-card__compact-detail wallet-step-card__compact-detail--mono"
      : "wallet-step-card__compact-detail";
    return `
      <div class="wallet-step-card wallet-step-card--compact wallet-step-card--${escapeHtml(step.status)}">
        <span class="wallet-step-card__compact-icon" aria-hidden="true">${renderIcon(statusMeta.icon)}</span>
        <div class="wallet-step-card__compact-body">
          <p class="wallet-step-card__compact-title">${escapeHtml(step.title)}</p>
          ${step.detail ? `<p class="${detailClass}">${escapeHtml(step.detail)}</p>` : ""}
        </div>
        <span class="wallet-step-card__compact-status" aria-hidden="true">${escapeHtml(statusMeta.label)}</span>
      </div>
    `;
  }

  return `
    <article class="wallet-step-card wallet-step-card--${escapeHtml(step.status)}">
      <div class="wallet-step-card__header">
        <div class="wallet-step-card__headline">
          <span class="wallet-step-card__icon" aria-hidden="true">${renderIcon(step.icon)}</span>
          <div class="wallet-step-card__title-wrap">
            <p class="wallet-step-card__eyebrow">${escapeHtml(L("settings.wallet.stepNumber", { count: step.number }))}</p>
            <h3 class="wallet-step-card__title">${escapeHtml(step.title)}</h3>
          </div>
        </div>
        ${statusChipHtml}
      </div>
      <p class="wallet-step-card__copy">${escapeHtml(step.copy)}</p>
      <p class="wallet-step-card__detail ${step.monoDetail ? "wallet-step-card__detail--mono" : ""}">${escapeHtml(step.detail)}</p>
      ${step.form || ""}
      ${step.actions.length ? `<div class="wallet-step-card__actions">${step.actions.join("")}</div>` : ""}
    </article>
  `;
}

// Sign-in form sits inside step 1 when the user hasn't signed in yet.
// Email field is always rendered (editable so users can correct a typo
// and resend); OTP field only appears once a code has been issued. Both
// inputs carry value="..." sourced from state so a poll-triggered
// re-render doesn't wipe what the user was typing mid-edit.
function renderHazbaseSignInForm({ email, otpRequested, code }) {
  // Once the OTP has been sent we lock the email field so accidental edits
  // can't invalidate the pending code. A small "change email" link is shown
  // as the intentional escape hatch — clicking it reverts the form to the
  // pre-sent state (code discarded, email stays for easy typo recovery).
  const emailLocked = Boolean(otpRequested);
  const emailLabelRow = emailLocked
    ? `<span class="wallet-step-card__field-label-row">
        <span class="wallet-step-card__field-label">${escapeHtml(L("settings.hazbase.field.emailLabel"))}</span>
        <button
          type="button"
          class="wallet-step-card__field-link"
          data-hazbase-action="change-email"
        >${escapeHtml(L("settings.hazbase.action.changeEmail"))}</button>
      </span>`
    : `<span class="wallet-step-card__field-label">${escapeHtml(L("settings.hazbase.field.emailLabel"))}</span>`;
  const emailField = `
    <label class="wallet-step-card__field">
      ${emailLabelRow}
      <input
        type="email"
        class="wallet-step-card__field-input${emailLocked ? " wallet-step-card__field-input--locked" : ""}"
        data-hazbase-input="otp-email"
        value="${escapeHtml(email || "")}"
        placeholder="${escapeHtml(L("settings.hazbase.field.emailPlaceholder"))}"
        autocomplete="email"
        inputmode="email"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        ${emailLocked ? "disabled aria-disabled=\"true\"" : ""}
      />
    </label>
  `;
  const otpField = otpRequested
    ? `
    <label class="wallet-step-card__field">
      <span class="wallet-step-card__field-label">${escapeHtml(L("settings.hazbase.field.otpLabel"))}</span>
      <input
        type="text"
        class="wallet-step-card__field-input wallet-step-card__field-input--mono"
        data-hazbase-input="otp-code"
        value="${escapeHtml(code || "")}"
        placeholder="${escapeHtml(L("settings.hazbase.field.otpPlaceholder"))}"
        autocomplete="one-time-code"
        inputmode="numeric"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        maxlength="12"
      />
    </label>
  `
    : "";
  return `<div class="wallet-step-card__form">${emailField}${otpField}</div>`;
}

function formatRelativeAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  // Intl.RelativeTimeFormat with numeric:"auto" gives us locale-aware phrasing
  // ("5 minutes ago" / "5分前") without needing dedicated translation keys.
  const locale = state.locale || DEFAULT_LOCALE;
  let rtf;
  try {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  } catch {
    rtf = null;
  }
  const sec = Math.floor(ms / 1000);
  const pick = (value, unit, fallback) => (rtf ? rtf.format(-value, unit) : fallback);
  if (sec < 60) return pick(sec, "second", `${sec}s ago`);
  const min = Math.floor(sec / 60);
  if (min < 60) return pick(min, "minute", `${min}m ago`);
  const hr = Math.floor(min / 60);
  if (hr < 24) return pick(hr, "hour", `${hr}h ago`);
  const day = Math.floor(hr / 24);
  if (day < 30) return pick(day, "day", `${day}d ago`);
  const mo = Math.floor(day / 30);
  if (mo < 12) return pick(mo, "month", `${mo}mo ago`);
  return pick(Math.floor(mo / 12), "year", `${Math.floor(mo / 12)}y ago`);
}

function formatExpiresIn(ms) {
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return L("settings.a2aShare.expired");
  const locale = state.locale || DEFAULT_LOCALE;
  let rtf;
  try {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  } catch {
    rtf = null;
  }
  const day = Math.floor(ms / 86400000);
  if (day >= 1) return rtf ? rtf.format(day, "day") : `in ${day}d`;
  const hr = Math.max(1, Math.floor(ms / 3600000));
  return rtf ? rtf.format(hr, "hour") : `in ${hr}h`;
}

// USDC has 6 decimals, stored as atomic units in a string (e.g. "100000" ⇒
// $0.10). Mirrors formatUsdc() in scripts/share-cli.mjs — kept as a small
// standalone helper rather than a shared module since the app bundle has no
// build step that pulls from scripts/.
function formatUsdcAtomic(atomic) {
  let n;
  try {
    n = BigInt(String(atomic ?? "0"));
  } catch {
    return "0.00";
  }
  if (n < 0n) n = -n;
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  if (!frac) return `${whole}.00`;
  return `${whole}.${frac.padEnd(2, "0")}`;
}

function renderSettingsInfoRow(label, value, options = {}) {
  const tone = settingsNavValueTone(value, options.valueTone || "");
  const rowClassName = [
    "settings-info-row",
    options.stacked ? "settings-info-row--stacked" : "",
    options.rowClassName || "",
  ].filter(Boolean).join(" ");
  const valueClassName = [
    "settings-info-row__value",
    tone ? `settings-info-row__value--${tone}` : "",
    options.mono ? "settings-info-row__value--mono" : "",
    options.valueClassName || "",
  ].filter(Boolean).join(" ");
  const displayValue = options.rawValue ? value : escapeHtml(value);
  return `
    <div class="${rowClassName}">
      <span class="settings-info-row__label">${escapeHtml(label)}</span>
      <span class="${valueClassName}">${displayValue}</span>
    </div>
  `;
}

function renderSettingsActionPanel(content, title = "") {
  return `
    <section class="settings-group">
      ${title ? `<p class="settings-group__title">${escapeHtml(title)}</p>` : ""}
      <div class="settings-action-panel">
        <div class="actions actions--stack">
          ${content}
        </div>
      </div>
    </section>
  `;
}

function renderDeviceSection(title, devices, emptyMessage) {
  return `
    <section class="settings-group">
      <p class="settings-group__title">${escapeHtml(title)}</p>
      ${
        devices.length
          ? `<div class="device-list">
              ${devices.map((device) => renderTrustedDeviceCard(device)).join("")}
            </div>`
          : `<div class="settings-copy-block"><p class="muted">${escapeHtml(emptyMessage)}</p></div>`
      }
    </section>
  `;
}

function renderTrustedDeviceCard(device) {
  const localeLabel = localeDisplayName(device.locale, state.locale) || device.locale || L("common.unavailable");
  const pushLabel = device.pushSubscribed ? L("common.enabled") : L("common.disabled");
  const badge = device.currentDevice
    ? `<span class="device-card__badge">${escapeHtml(L("settings.device.thisDevice"))}</span>`
    : "";
  const actions = device.currentDevice
    ? ""
    : `
      <div class="device-card__actions">
        <button
          class="secondary secondary--wide"
          type="button"
          data-device-revoke="${escapeHtml(device.deviceId)}"
        >${escapeHtml(L("settings.action.revokeDevice"))}</button>
      </div>
    `;

  return `
    <article class="device-card">
      <div class="device-card__header">
        <div class="device-card__title-wrap">
          <div class="device-card__headline">
            <span class="device-card__icon" aria-hidden="true">${renderIcon(device.standalone ? "homescreen" : "iphone")}</span>
            <h3 class="device-card__title">${escapeHtml(device.displayName || L("settings.device.fallbackName"))}</h3>
          </div>
          <p class="device-card__subtitle">${escapeHtml(device.deviceId || "")}</p>
        </div>
        ${badge}
      </div>
      <div class="device-card__meta">
        ${renderDeviceMetaRow(L("settings.row.lastUsed"), formatSettingsTimestamp(device.lastAuthenticatedAtMs))}
        ${renderDeviceMetaRow(L("settings.row.pairedAt"), formatSettingsTimestamp(device.pairedAtMs))}
        ${renderDeviceMetaRow(L("settings.row.trustedUntil"), formatSettingsTimestamp(device.trustedUntilMs))}
        ${renderDeviceMetaRow(L("settings.row.pushStatus"), pushLabel)}
        ${renderDeviceMetaRow(L("settings.row.currentLanguage"), localeLabel)}
      </div>
      ${actions}
    </article>
  `;
}

function renderDeviceMetaRow(label, value) {
  return `
    <div class="device-card__meta-row">
      <span class="device-card__meta-label">${escapeHtml(label)}</span>
      <span class="device-card__meta-value">${escapeHtml(value)}</span>
    </div>
  `;
}

function renderDetailContent(detail, { mobile }) {
  if (mobile) {
    if (detail.kind === "choice" && detail.supported) {
      return renderChoiceDetailMobile(detail);
    }
    return renderStandardDetailMobile(detail);
  }

  if (detail.kind === "choice" && detail.supported) {
    return renderChoiceDetailDesktop(detail);
  }

  return renderStandardDetailDesktop(detail);
}

function renderStandardDetailDesktop(detail) {
  const kindInfo = kindMeta(detail.kind, detail);
  const spaciousBodyDetail = TIMELINE_MESSAGE_KINDS.has(detail.kind);
  const plainIntro = renderDetailPlainIntro(detail);
  return `
    <div class="detail-shell">
      ${renderDetailMetaRow(detail, kindInfo)}
      <h2 class="detail-title detail-title--desktop">${renderDetailTitle(detail)}</h2>
      ${renderDetailLoadErrorNotice(detail)}
      ${detail.readOnly || detail.kind === "approval" || detail.kind === "moltbook_draft" || detail.kind === "moltbook_reply" || detail.kind === "thread_share" ? "" : renderDetailLead(detail, kindInfo)}
      ${renderPreviousContextCard(detail)}
      ${renderAutoPilotManualReview(detail)}
      ${renderInterruptedDetailNotice(detail)}
      ${renderMoltbookReplyComposer(detail)}
      ${renderMoltbookDraftComposer(detail)}
      ${renderA2ATaskDetail(detail)}
      ${renderThreadShareDetail(detail)}
      ${renderAmbientSuggestionsSection(detail)}
      ${
        detail.kind === "moltbook_draft" || detail.kind === "moltbook_reply" || detail.kind === "a2a_task" || detail.kind === "a2a_task_result" || detail.kind === "thread_share" || detail.kind === "ambient_suggestions"
          ? ""
          : plainIntro
            ? plainIntro
            : `
            <section class="detail-card detail-card--body ${spaciousBodyDetail ? "detail-card--message-body" : ""}">
              <div class="detail-body ${spaciousBodyDetail ? "detail-body--message " : ""}markdown">${detail.messageHtml || ""}</div>
            </section>
          `
      }
      ${renderCommandEventDetail(detail)}
      ${renderClaudePlanSection(detail)}
      ${renderClaudeQuestionSection(detail)}
      ${renderDetailImageGallery(detail)}
      ${renderDetailDiffPanel(detail)}
      ${renderDetailDiffThreadGroups(detail)}
      ${renderDetailFileRefs(detail)}
      ${renderCompletionReplyComposer(detail)}
      ${detail.readOnly ? "" : renderActionButtons(detail.actions || [])}
    </div>
  `;
}

function renderStandardDetailMobile(detail) {
  const kindInfo = kindMeta(detail.kind, detail);
  const spaciousBodyDetail = TIMELINE_MESSAGE_KINDS.has(detail.kind);
  const plainIntro = renderDetailPlainIntro(detail, { mobile: true });
  const hasCompletionReply = isCompletionReplyAvailable(detail);
  return `
    <div class="mobile-detail-screen ${hasCompletionReply ? "mobile-detail-screen--has-reply-dock" : ""}">
      <div class="detail-shell detail-shell--mobile">
        <div class="mobile-detail-scroll mobile-detail-scroll--detail">
          ${renderDetailMetaRow(detail, kindInfo, { mobile: true })}
          ${renderDetailLoadErrorNotice(detail, { mobile: true })}
          ${renderPreviousContextCard(detail, { mobile: true })}
          ${renderAutoPilotManualReview(detail, { mobile: true })}
          ${renderInterruptedDetailNotice(detail, { mobile: true })}
          ${renderMoltbookReplyComposer(detail, { mobile: true })}
          ${renderMoltbookDraftComposer(detail, { mobile: true })}
          ${renderA2ATaskDetail(detail, { mobile: true })}
          ${renderThreadShareDetail(detail, { mobile: true })}
          ${renderAmbientSuggestionsSection(detail, { mobile: true })}
          ${
            detail.kind === "moltbook_draft" || detail.kind === "moltbook_reply" || detail.kind === "a2a_task" || detail.kind === "a2a_task_result" || detail.kind === "thread_share" || detail.kind === "ambient_suggestions"
              ? ""
              : plainIntro
                ? plainIntro
                : `
                <section class="detail-card detail-card--body detail-card--mobile ${spaciousBodyDetail ? "detail-card--message-body" : ""}">
                  ${detail.readOnly || detail.kind === "approval" ? "" : renderDetailLead(detail, kindInfo, { mobile: true })}
                  <div class="detail-body ${spaciousBodyDetail ? "detail-body--message " : ""}markdown">${detail.messageHtml || ""}</div>
                </section>
              `
          }
          ${renderCommandEventDetail(detail, { mobile: true })}
          ${renderClaudePlanSection(detail, { mobile: true })}
          ${renderClaudeQuestionSection(detail, { mobile: true })}
          ${renderDetailImageGallery(detail, { mobile: true })}
          ${renderDetailDiffPanel(detail, { mobile: true })}
          ${renderDetailDiffThreadGroups(detail, { mobile: true })}
          ${renderDetailFileRefs(detail, { mobile: true })}
        </div>
        ${detail.readOnly ? "" : renderActionButtons(detail.actions || [], { mobileSticky: true })}
      </div>
      ${renderCompletionReplyDock(detail)}
    </div>
  `;
}

function renderAmbientSuggestionsSection(detail, options = {}) {
  if (detail?.kind !== "ambient_suggestions") {
    return "";
  }

  const suggestions = normalizeClientAmbientSuggestions(detail?.suggestions);
  if (suggestions.length === 0) {
    return `
      <section class="detail-card detail-card--body ${options.mobile ? "detail-card--mobile" : ""}">
        <div class="detail-body markdown">${detail.messageHtml || ""}</div>
      </section>
    `;
  }

  return `
    <section class="detail-card detail-card--body ${options.mobile ? "detail-card--mobile" : ""}">
      <div class="ambient-suggestions">
        ${detail.messageHtml ? `<div class="ambient-suggestions__intro markdown">${detail.messageHtml}</div>` : ""}
        <div class="ambient-suggestions__list">
          ${suggestions
            .map((suggestion, index) => renderAmbientSuggestionCard(detail, suggestion, index))
            .join("")}
        </div>
      </div>
    </section>
  `;
}

function renderCommandEventDetail(detail, options = {}) {
  if (detail?.kind !== "command_event") {
    return "";
  }
  const commandText = normalizeClientText(detail?.commandText || "");
  if (!commandText) {
    return "";
  }
  return `
    <section class="detail-card detail-card--command ${options.mobile ? "detail-card--mobile" : ""}">
      <div class="detail-files-card__header">
        <span class="detail-files-card__icon" aria-hidden="true">${renderIcon("command")}</span>
        <span>${escapeHtml(L("common.commandEvent"))}</span>
      </div>
      <pre class="detail-command-block"><code>${escapeHtml(commandText)}</code></pre>
    </section>
  `;
}

function renderDetailLoadErrorNotice(detail, options = {}) {
  if (detail?.loadError !== true) {
    return "";
  }
  const errorText = normalizeClientText(detail.loadErrorMessage || "");
  return `
    <section class="detail-card detail-card--body ${options.mobile ? "detail-card--mobile" : ""}">
      <div class="detail-body markdown">
        <p><strong>${escapeHtml(L("detail.loadFailedTitle"))}</strong></p>
        <p>${escapeHtml(L("detail.loadFailedCopy"))}</p>
        ${errorText ? `<p class="muted">${escapeHtml(errorText)}</p>` : ""}
      </div>
      <div class="actions actions--stack">
        <button class="secondary secondary--wide" type="button" data-detail-retry>
          ${escapeHtml(L("detail.loadRetry"))}
        </button>
      </div>
    </section>
  `;
}

function renderAmbientSuggestionCard(detail, suggestion, index) {
  const copyKey = ambientSuggestionCopyKey(detail?.token || "", suggestion?.id || "", index);
  const copyStatus = state.ambientSuggestionCopyState?.key === copyKey
    ? state.ambientSuggestionCopyState?.status || ""
    : "";
  const copyLabel = copyStatus === "success"
    ? L("detail.ambientSuggestions.copyPromptDone")
    : copyStatus === "error"
      ? L("detail.ambientSuggestions.copyPromptFailed")
      : L("detail.ambientSuggestions.copyPrompt");
  return `
    <article class="ambient-suggestion-card">
      <div class="ambient-suggestion-card__header">
        <h3 class="ambient-suggestion-card__title">${escapeHtml(suggestion.title)}</h3>
        <button
          type="button"
          class="secondary ambient-suggestion-card__copy-button"
          data-copy-ambient-suggestion
          data-copy-ambient-suggestion-token="${escapeHtml(detail?.token || "")}"
          data-copy-ambient-suggestion-index="${escapeHtml(String(index))}"
        >${escapeHtml(copyLabel)}</button>
      </div>
      ${suggestion.description ? `<p class="ambient-suggestion-card__description">${escapeHtml(suggestion.description)}</p>` : ""}
      <div class="ambient-suggestion-card__prompt-wrap">
        <p class="ambient-suggestion-card__prompt-label">${escapeHtml(L("detail.ambientSuggestions.prompt"))}</p>
        <pre class="ambient-suggestion-card__prompt">${escapeHtml(suggestion.prompt)}</pre>
      </div>
    </article>
  `;
}

function renderDetailPlainIntro(detail, options = {}) {
  if (!["approval", "diff_thread", "file_event", "command_event"].includes(detail?.kind || "")) {
    return "";
  }
  const ak = normalizeClientText(detail?.approvalKind || "");
  if (detail?.kind === "approval" && ak !== "file" && ak !== "plan" && ak !== "question") {
    return "";
  }
  if (!detail?.messageHtml) {
    return "";
  }
  const approvalClass = detail?.kind === "approval" ? " detail-page-copy--approval" : "";
  const approvalLead =
    detail?.kind === "approval"
      ? `<p>${escapeHtml(detailIntentText(detail))}</p>`
      : "";
  return `
    <div class="detail-page-copy${approvalClass} ${options.mobile ? "detail-page-copy--mobile" : ""} markdown">
      ${approvalLead}
      ${detail.messageHtml}
    </div>
  `;
}

function renderDetailMetaRow(detail, kindInfo, options = {}) {
  const timestampLabel = detail.createdAtMs ? formatTimelineTimestamp(detail.createdAtMs) : "";
  const progressPill = options.progressLabel
    ? `<span class="status-pill status-pill--pending">${escapeHtml(options.progressLabel)}</span>`
    : detail.readOnly
      ? ""
      : `<span class="status-pill status-pill--pending">${escapeHtml(L("common.actionable"))}</span>`;
  return `
    <section class="detail-meta-row ${options.mobile ? "detail-meta-row--mobile" : ""}">
      <div class="detail-meta-row__left">
        <span class="type-pill type-pill--${escapeHtml(kindInfo.tone)}">${renderTypePillContent(kindInfo)}</span>
        ${progressPill}
      </div>
      ${timestampLabel ? `<span class="detail-meta-row__time">${escapeHtml(timestampLabel)}</span>` : ""}
    </section>
  `;
}

function renderDetailLead(detail, kindInfo, options = {}) {
  return `
    <p class="detail-lead ${options.mobile ? "detail-lead--mobile" : ""}">
      <span class="detail-lead__icon" aria-hidden="true">${renderIcon(kindInfo.icon)}</span>
      <span>${escapeHtml(detailIntentText(detail))}</span>
    </p>
  `;
}

function renderInterruptedDetailNotice(detail, options = {}) {
  const message = normalizeClientText(detail?.interruptNotice || "");
  if (!message) {
    return "";
  }
  return `
    <section class="detail-card detail-card--interrupt ${options.mobile ? "detail-card--mobile" : ""}">
      <p class="detail-interrupt-copy">
        <span class="detail-interrupt-copy__icon" aria-hidden="true">${renderIcon("pending")}</span>
        <span>${escapeHtml(message)}</span>
      </p>
    </section>
  `;
}

function renderPreviousContextCard(detail, options = {}) {
  const context = detail?.previousContext;
  if (!context?.messageHtml) {
    return "";
  }

  const contextKind = kindMeta(context.kind || "assistant_commentary");
  const timestampLabel = context.createdAtMs ? formatTimelineTimestamp(context.createdAtMs) : "";
  return `
    <section class="detail-card detail-card--context ${options.mobile ? "detail-card--mobile" : ""}">
      <div class="detail-context-card__header">
        <div class="detail-context-card__eyebrow">
          <span class="detail-context-card__icon" aria-hidden="true">${renderIcon(contextKind.icon)}</span>
          <span>${escapeHtml(context.label || L("detail.previousMessage"))}</span>
        </div>
        ${timestampLabel ? `<span class="detail-context-card__time">${escapeHtml(timestampLabel)}</span>` : ""}
      </div>
      <p class="detail-context-card__kind">${escapeHtml(contextKind.label)}</p>
      <div class="detail-body detail-body--context markdown">${context.messageHtml}</div>
    </section>
  `;
}

function renderAutoPilotManualReview(detail, options = {}) {
  const review = detail?.autoPilotReview;
  if (!review?.title || !review?.body) {
    return "";
  }
  return `
    <section class="detail-card detail-card--autopilot ${options.mobile ? "detail-card--mobile" : ""}">
      <div class="detail-context-card__header">
        <div class="detail-context-card__eyebrow">
          <span class="detail-context-card__icon" aria-hidden="true">${renderIcon("settings")}</span>
          <span>${escapeHtml(L("detail.autoPilotManualEyebrow"))}</span>
        </div>
      </div>
      <p class="detail-context-card__kind">${escapeHtml(review.title)}</p>
      <p class="detail-autopilot-copy">${escapeHtml(review.body)}</p>
    </section>
  `;
}

function renderDetailImageGallery(detail, options = {}) {
  const imageUrls = Array.isArray(detail?.imageUrls) ? detail.imageUrls.filter(Boolean) : [];
  if (imageUrls.length === 0) {
    return "";
  }

  return `
    <section class="detail-card detail-card--images ${options.mobile ? "detail-card--mobile" : ""}">
      <div class="detail-image-grid">
        ${imageUrls
          .map((imageUrl, index) => {
            const altText = L("detail.imageAlt", { index: index + 1 });
            return `
              <button
                class="detail-image-link"
                type="button"
                data-open-image-viewer="${escapeHtml(imageUrl)}"
                data-image-alt="${escapeHtml(altText)}"
              >
                <img
                  class="detail-image"
                  src="${escapeHtml(imageUrl)}"
                  alt="${escapeHtml(altText)}"
                  loading="lazy"
                >
              </button>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderDetailFileRefs(detail, options = {}) {
  if (detail?.kind === "diff_thread") {
    return "";
  }
  const fileEntries = normalizeClientFileChangeEntries(detail);
  if (fileEntries.length === 0) {
    return "";
  }

  return `
    <section class="detail-card detail-card--files ${options.mobile ? "detail-card--mobile" : ""}">
      <div class="detail-files-card__header">
        <span class="detail-files-card__icon" aria-hidden="true">${renderIcon("item")}</span>
        <span>${escapeHtml(L("detail.filesTitle"))}</span>
      </div>
      <div class="detail-file-grid">
        ${fileEntries
          .map(
            (entry) => `
              <div class="detail-file-chip" title="${escapeHtml(fileChangeEntryTitle(entry))}">
                <span class="detail-file-chip__label">${escapeHtml(fileChangeEntryLabel(entry))}</span>
                <span class="detail-file-chip__path">${escapeHtml(fileChangeEntryTitle(entry))}</span>
              </div>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderDetailDiffPanel(detail, options = {}) {
  const detailKind = normalizeClientText(detail?.kind || "");
  if (!["file_event", "approval"].includes(detailKind)) {
    return "";
  }

  const fileEventType = normalizeClientText(detail?.fileEventType || "");
  if (detailKind === "file_event" && !["write", "create", "delete", "rename"].includes(fileEventType)) {
    return "";
  }
  if (
    detailKind === "approval" &&
    !String(detail?.diffText || "").trim() &&
    !detail?.diffAvailable &&
    normalizeClientFileRefs(detail?.fileRefs).length === 0
  ) {
    return "";
  }

  const diffText = String(detail?.diffText || "").replace(/\r\n/g, "\n").trim();
  const statsHtml = renderDiffEntryStatsHtml(detail);
  const expanded = isDetailDiffExpanded(detail);

  return `
    <section class="detail-card detail-card--diff ${options.mobile ? "detail-card--mobile" : ""}">
      <button
        type="button"
        class="detail-diff-card__toggle ${expanded ? "is-open" : ""}"
        data-detail-diff-toggle
      >
        <div class="detail-diff-card__header">
          <div class="detail-diff-card__title-wrap">
            <span class="detail-diff-card__icon" aria-hidden="true">${renderIcon("diff")}</span>
            <span>${escapeHtml(L("detail.diffTitle"))}</span>
          </div>
          <div class="detail-diff-card__header-right">
            ${statsHtml ? `<span class="detail-diff-card__stats diff-entry__stats">${statsHtml}</span>` : ""}
            <span class="detail-diff-card__chevron" aria-hidden="true">${renderIcon("chevron-right")}</span>
          </div>
        </div>
      </button>
      ${expanded
        ? diffText
          ? `<div class="detail-diff-viewer">${renderDiffLines(diffText)}</div>`
          : `<p class="detail-diff-card__notice">${escapeHtml(L("detail.diffUnavailable"))}</p>`
        : ""}
    </section>
  `;
}

function renderDetailDiffThreadGroups(detail, options = {}) {
  if (detail?.kind !== "diff_thread") {
    return "";
  }

  const files = Array.isArray(detail?.files) ? detail.files.filter(Boolean) : [];
  if (files.length === 0) {
    return "";
  }

  return files
    .map((fileGroup) => renderDetailDiffThreadFileGroup(detail, fileGroup, options))
    .join("");
}

function renderDetailDiffThreadFileGroup(detail, fileGroup, options = {}) {
  const fileRef = normalizeClientText(fileGroup?.fileRef || "");
  const changeType = normalizeClientText(fileGroup?.changeType || "");
  const fileEntry = {
    fileRef,
    oldFileRef: normalizeClientText(fileGroup?.oldFileRef || ""),
    newFileRef: normalizeClientText(fileGroup?.newFileRef || fileRef || ""),
    changeType,
  };
  const fileLabel = fileChangeEntryLabel(fileEntry) || normalizeClientText(fileGroup?.fileLabel || "") || fileRefLabel(fileRef) || L("common.unavailable");
  const filePathLabel = fileChangeEntryTitle(fileEntry) || fileRef;
  const statsHtml = renderDiffEntryStatsHtml(fileGroup);
  const sections = Array.isArray(fileGroup?.sections) ? fileGroup.sections.filter(Boolean) : [];
  const expanded = isDiffThreadFileExpanded(detail?.token, fileRef);

  return `
    <section class="detail-card detail-card--diff-thread ${options.mobile ? "detail-card--mobile" : ""}">
      <button
        type="button"
        class="detail-diff-thread__header ${expanded ? "is-open" : ""}"
        data-diff-thread-file-toggle
        data-diff-thread-token="${escapeHtml(detail?.token || "")}"
        data-diff-thread-file="${escapeHtml(fileRef)}"
      >
        <div class="detail-diff-thread__title-wrap">
          <span class="detail-diff-thread__icon" aria-hidden="true">${renderIcon("item")}</span>
          <div class="detail-diff-thread__title-text">
            <span class="detail-diff-thread__label">${escapeHtml(fileLabel)}</span>
            ${filePathLabel ? `<span class="detail-diff-thread__path">${escapeHtml(filePathLabel)}</span>` : ""}
          </div>
        </div>
        <div class="detail-diff-thread__header-right">
          ${statsHtml ? `<span class="detail-diff-thread__stats diff-entry__stats">${statsHtml}</span>` : ""}
          <span class="detail-diff-thread__chevron" aria-hidden="true">${renderIcon("chevron-right")}</span>
        </div>
      </button>
      ${
        expanded
          ? `
            <div class="detail-diff-thread__sections">
              ${sections.map((section) => renderDetailDiffThreadSection(section)).join("")}
            </div>
          `
          : ""
      }
    </section>
  `;
}

function renderDetailDiffThreadSection(section) {
  const sectionLabel = fileEventDisplayLabel(section?.fileEventType || "") || L("common.diff");
  const timestampLabel = section?.createdAtMs ? formatTimelineTimestamp(section.createdAtMs) : "";
  const statsHtml = renderDiffEntryStatsHtml(section);
  const diffText = String(section?.diffText || "").replace(/\r\n/g, "\n").trim();

  return `
    <div class="detail-diff-thread__section">
      <div class="detail-diff-thread__section-meta">
        <span class="detail-diff-thread__section-label">${escapeHtml(sectionLabel)}</span>
        <div class="detail-diff-thread__section-right">
          ${statsHtml ? `<span class="detail-diff-thread__section-stats diff-entry__stats">${statsHtml}</span>` : ""}
          ${timestampLabel ? `<span class="detail-diff-thread__section-time">${escapeHtml(timestampLabel)}</span>` : ""}
        </div>
      </div>
      ${
        diffText
          ? `<div class="detail-diff-viewer">${renderDiffLines(diffText)}</div>`
          : `<p class="detail-diff-card__notice">${escapeHtml(L("detail.diffUnavailable"))}</p>`
      }
    </div>
  `;
}

function renderDiffLines(diffText) {
  return String(diffText || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const className = diffLineClassName(line);
      return `<div class="detail-diff-line ${className}">${escapeHtml(line || " ")}</div>`;
    })
    .join("");
}

function diffLineClassName(line) {
  const text = String(line || "");
  if (text.startsWith("diff --git") || text.startsWith("index ") || text.startsWith("new file mode")) {
    return "detail-diff-line--meta";
  }
  if (text.startsWith("@@")) {
    return "detail-diff-line--hunk";
  }
  if (text.startsWith("+++ ") || text.startsWith("--- ")) {
    return "detail-diff-line--file";
  }
  if (text.startsWith("+")) {
    return "detail-diff-line--add";
  }
  if (text.startsWith("-")) {
    return "detail-diff-line--remove";
  }
  return "detail-diff-line--context";
}

function renderClaudePlanSection(detail, options = {}) {
  if (detail?.kind !== "approval") return "";
  if (normalizeClientText(detail?.approvalKind || "") !== "plan") return "";
  const planText = String(detail.planText || "");
  if (!planText) return "";
  const planHtml = String(detail.planHtml || "");
  const provider = providerDisplayName(detail.provider);
  const readOnlyNotice = detail.readOnly
    ? `<p class="claude-question-notice">${escapeHtml(L("claudeAway.notifyOnly.notice", { provider }))}</p>`
    : "";
  const bodyHtml = planHtml
    ? `<div class="detail-body detail-body--message markdown">${planHtml}</div>`
    : `<pre class="detail-body detail-body--message" style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(planText)}</pre>`;
  return `
    <section class="detail-card detail-card--body ${options.mobile ? "detail-card--mobile" : ""}">
      <h3 class="detail-section-title">${escapeHtml(L("claudePlan.title", { provider }))}</h3>
      ${bodyHtml}
      ${readOnlyNotice}
    </section>
  `;
}

function renderClaudeQuestionSection(detail, options = {}) {
  if (detail?.kind !== "approval") return "";
  if (normalizeClientText(detail?.approvalKind || "") !== "question") return "";
  const questions = Array.isArray(detail.questions) ? detail.questions : [];
  if (questions.length === 0) return "";
  const provider = providerDisplayName(detail.provider);
  const token = detail.token || "";
  const draft = getClaudeQuestionDraft(token);
  const isReadOnly = detail.readOnly === true;
  const isSent = Boolean(draft.sent) || isReadOnly;

  const questionsHtml = questions
    .map((q, qi) => {
      const inputType = q.multiSelect ? "checkbox" : "radio";
      const options = Array.isArray(q.options) ? q.options : [];
      const selected = new Set((draft.answers?.[qi]?.optionIndices) || []);
      const optionsHtml = options
        .map((opt, oi) => {
          const checked = selected.has(oi) ? "checked" : "";
          return `
            <label class="claude-question-option">
              <input type="${inputType}" name="q-${qi}" value="${oi}" ${checked} ${isSent ? "disabled" : ""} data-claude-question-input data-q-index="${qi}" data-o-index="${oi}" />
              <span class="claude-question-option__label"><strong>${escapeHtml(String(opt.label || ""))}</strong></span>
              ${opt.description ? `<span class="claude-question-option__desc">${escapeHtml(String(opt.description))}</span>` : ""}
            </label>
          `;
        })
        .join("");
      const noteValue = String(draft.answers?.[qi]?.note || "");
      return `
        <div class="claude-question-item">
          <p class="claude-question-text"><strong>${escapeHtml(String(q.question || ""))}</strong></p>
          <div class="claude-question-options">${optionsHtml}</div>
          <textarea
            class="claude-question-note"
            data-claude-question-note
            data-q-index="${qi}"
            placeholder="${escapeHtml(L("claudeQuestion.notePlaceholder"))}"
            rows="2"
            ${isSent ? "disabled" : ""}
          >${escapeHtml(noteValue)}</textarea>
        </div>
      `;
    })
    .join("");

  const noticeHtml = isReadOnly
    ? `<p class="claude-question-notice">${escapeHtml(L("claudeAway.notifyOnly.notice", { provider }))}</p>`
    : draft.notice
      ? `<p class="claude-question-notice">${escapeHtml(draft.notice)}</p>`
      : "";
  const errorHtml = draft.error
    ? `<p class="claude-question-error">${escapeHtml(draft.error)}</p>`
    : "";
  const sendLabel = L("claudeQuestion.send", { provider });

  return `
    <section class="detail-card detail-card--body ${options.mobile ? "detail-card--mobile" : ""}">
      <h3 class="detail-section-title">${escapeHtml(L("claudeQuestion.title", { provider }))}</h3>
      <form data-claude-question-form data-token="${escapeHtml(token)}" data-answer-url="${escapeHtml(detail.answerUrl || "")}">
        ${questionsHtml}
        ${errorHtml}
        ${noticeHtml}
        ${isReadOnly ? "" : `
          <div class="claude-question-actions">
            <button type="submit" class="primary primary--wide" ${isSent || draft.sending ? "disabled" : ""}>
              ${escapeHtml(draft.sending ? L("claudeQuestion.send", { provider }) + "…" : sendLabel)}
            </button>
          </div>
        `}
      </form>
    </section>
  `;
}

const claudeQuestionDrafts = new Map();
function getClaudeQuestionDraft(token) {
  if (!claudeQuestionDrafts.has(token)) {
    claudeQuestionDrafts.set(token, { answers: {}, sending: false, sent: false, notice: "", error: "" });
  }
  return claudeQuestionDrafts.get(token);
}
function setClaudeQuestionDraft(token, partial) {
  const next = { ...getClaudeQuestionDraft(token), ...partial };
  claudeQuestionDrafts.set(token, next);
  return next;
}

function renderMoltbookReplyComposer(detail, options = {}) {
  if (detail.kind !== "moltbook_reply") return "";
  const rawTitle = normalizeClientText(detail.title || "");
  const match = rawTitle.match(/^@([^\s]+)/u);
  const authorHandle = match ? match[1] : detail.commentAuthor || "";
  const postUrl = detail.postUrl || (detail.threadId ? `https://www.moltbook.com/post/${detail.threadId}` : "");
  const postTitle = normalizeClientText(detail.postTitle || detail.threadLabel || "").replace(/^Moltbook\s*·\s*/iu, "");
  const postLink = postTitle
    ? (postUrl
      ? `<p class="reply-composer__post-title"><a href="${escapeHtml(postUrl)}" target="_blank" rel="noopener">${escapeHtml(postTitle)}</a></p>`
      : `<p class="reply-composer__post-title">${escapeHtml(postTitle)}</p>`)
    : "";
  const bodyHtml = detail.messageHtml
    ? `<div class="reply-composer__context-body markdown">${detail.messageHtml}</div>`
    : "";
  return `
    <section class="detail-card detail-card--reply ${options.mobile ? "detail-card--mobile" : ""}">
      <div class="reply-composer reply-composer--readonly">
        <div class="reply-composer__copy">
          <span class="eyebrow-pill eyebrow-pill--quiet">Moltbook</span>
          ${authorHandle ? `<p class="reply-composer__author">from <strong>@${escapeHtml(authorHandle)}</strong></p>` : ""}
          ${postLink}
        </div>
        ${bodyHtml}
      </div>
    </section>
  `;
}

function renderMoltbookDraftComposer(detail, options = {}) {
  if (detail.kind !== "moltbook_draft") return "";
  const enabled = detail.moltbookDraftEnabled !== false && detail.readOnly !== true;
  const draftText = detail.draftText || "";
  const isOriginalPost = detail.draftType === "original_post";
  const postAuthorLine = !isOriginalPost && detail.postAuthor
    ? `<p class="reply-composer__author-meta muted">@${escapeHtml(detail.postAuthor)}</p>`
    : "";
  const draftPostUrl = detail.postUrl || (detail.threadId ? `https://www.moltbook.com/post/${detail.threadId}` : "");
  const draftPostTitle = normalizeClientText(detail.postTitle || detail.threadLabel || "").replace(/^Moltbook\s*·\s*/iu, "");
  const postLink = !isOriginalPost && draftPostTitle
    ? (draftPostUrl
      ? `<p class="reply-composer__post-title"><a href="${escapeHtml(draftPostUrl)}" target="_blank" rel="noopener">${escapeHtml(draftPostTitle)}</a></p>`
      : `<p class="reply-composer__post-title">${escapeHtml(draftPostTitle)}</p>`)
    : "";
  const postBodyBlock = !isOriginalPost && detail.postBody
    ? `<details class="reply-composer__context"><summary>元の投稿</summary><div class="reply-composer__context-body">${escapeHtml(detail.postBody).replace(/\n/g, "<br>")}</div></details>`
    : "";
  const intentBlock = detail.intent
    ? `<div class="reply-composer__intent"><span class="eyebrow-pill eyebrow-pill--quiet">${escapeHtml(L("moltbook.draft.intent"))}</span><p>${escapeHtml(detail.intent).replace(/\n/g, "<br>")}</p></div>`
    : "";
  const titleInput = isOriginalPost && enabled
    ? `<label class="field reply-field reply-field--title"><span class="field-label">${escapeHtml(L("moltbook.draft.titleLabel"))}</span><input type="text" name="title" class="reply-field__input" value="${escapeHtml(detail.postTitle || "")}" data-moltbook-draft-title /></label>`
    : isOriginalPost
      ? `<p class="reply-composer__title-display"><strong>${escapeHtml(detail.postTitle || "")}</strong></p>`
      : "";
  const submoltBadge = isOriginalPost && detail.submoltName
    ? `<span class="eyebrow-pill eyebrow-pill--subtle">${escapeHtml(detail.submoltName)}</span>`
    : "";
  const eyebrowLabel = isOriginalPost ? L("moltbook.draft.eyebrowPost") : L("moltbook.draft.eyebrowReply");
  const approveLabel = isOriginalPost ? L("moltbook.draft.approvePost") : L("moltbook.draft.approveReply");
  const greetingBlock = (() => {
    if (!isOriginalPost) return "";
    const slot = detail.slot || "";
    const icons = { morning: "\u2600\ufe0f", noon: "\u26c5", evening: "\ud83c\udf19" };
    const keys = { morning: "moltbook.draft.greetMorning", noon: "moltbook.draft.greetNoon", evening: "moltbook.draft.greetEvening" };
    const icon = icons[slot] || "\u270d\ufe0f";
    const msg = keys[slot] ? L(keys[slot]) : L("moltbook.draft.greetFallback");
    return `<div class="compose-greeting"><span class="compose-greeting__icon">${icon}</span><span class="compose-greeting__text">${escapeHtml(msg)}</span></div>`;
  })();
  const buttons = enabled
    ? `
      <div class="actions actions--stack${options.mobile ? " actions--sticky" : ""}">
        <button type="submit" data-action="approve" class="primary primary--wide">${escapeHtml(approveLabel)}</button>
        <button type="submit" data-action="deny" class="danger danger--wide">Deny</button>
      </div>
    `
    : `<p class="muted reply-composer__description">${escapeHtml(L("moltbook.draft.resolved"))}</p>`;
  const buttonsWrapped = enabled && options.mobile ? `<div class="detail-action-bar">${buttons}</div>` : buttons;
  return `
    <section class="detail-card detail-card--reply ${options.mobile ? "detail-card--mobile" : ""}">
      <form class="reply-composer" data-moltbook-draft-form data-token="${escapeHtml(detail.token || "")}" ${isOriginalPost ? 'data-draft-type="original_post"' : ""}>
        <div class="reply-composer__copy">
          <span class="eyebrow-pill eyebrow-pill--quiet">${escapeHtml(eyebrowLabel)}</span>
          ${submoltBadge}
          ${greetingBlock}
          ${postLink}
          ${postAuthorLine}
          ${titleInput}
          ${postBodyBlock}
          ${intentBlock}
          <p class="muted reply-composer__description">${escapeHtml(L("moltbook.draft.editHint"))}</p>
        </div>
        <textarea name="text" class="reply-composer__textarea" data-moltbook-draft-textarea rows="8" ${enabled ? "" : "readonly"}>${escapeHtml(draftText)}</textarea>
        ${buttonsWrapped}
      </form>
    </section>
  `;
}

function renderA2ATaskDetail(detail, options = {}) {
  if (detail.kind !== "a2a_task" && detail.kind !== "a2a_task_result") return "";
  const enabled = detail.a2aTaskEnabled !== false && detail.readOnly !== true;
  const instruction = detail.instruction || "";
  const callerIp = detail.callerInfo?.ip || "";
  const callerAgent = detail.callerInfo?.userAgent || "";
  const callerLine = callerIp
    ? `<p class="reply-composer__author-meta muted">${escapeHtml(L("a2a.task.from"))}: ${escapeHtml(callerIp)}${callerAgent ? ` (${escapeHtml(callerAgent.slice(0, 60))})` : ""}</p>`
    : "";

  const statusKey = {
    submitted: "a2a.task.statusSubmitted",
    working: "a2a.task.statusWorking",
    completed: "a2a.task.statusCompleted",
    failed: "a2a.task.statusFailed",
    canceled: "a2a.task.statusCanceled",
    rejected: "a2a.task.statusRejected",
  }[detail.taskStatus] || "a2a.task.statusSubmitted";

  const statusBadge = !enabled && detail.kind === "a2a_task_result"
    ? `<span class="eyebrow-pill eyebrow-pill--subtle">${escapeHtml(L(statusKey))}</span>`
    : "";
  const viveworkerTask = detail.viveworker || {};
  const payment = viveworkerTask.payment || {};
  const priceLabel = payment.price
    ? `${payment.price} USDC`
    : detail.paidDeliverable?.price
      ? `${detail.paidDeliverable.price} USDC`
      : "";
  const paidDeliverableBlock = viveworkerTask.paidDeliverable || detail.paidDeliverable
    ? `
      <div class="reply-composer__context">
        <span class="eyebrow-pill eyebrow-pill--quiet">${escapeHtml(L("a2a.task.paidDeliverable"))}</span>
        <div class="reply-composer__context-body">
          ${viveworkerTask.requestedTier ? `<p><strong>${escapeHtml(L("a2a.task.requestedTier"))}</strong>: ${escapeHtml(viveworkerTask.requestedTier)}</p>` : ""}
          ${viveworkerTask.requestedExecutor ? `<p><strong>${escapeHtml(L("a2a.task.requestedExecutor"))}</strong>: ${escapeHtml(viveworkerTask.requestedExecutor)}</p>` : ""}
          ${viveworkerTask.requestedModel ? `<p><strong>${escapeHtml(L("a2a.task.requestedModel"))}</strong>: ${escapeHtml(viveworkerTask.requestedModel)}</p>` : ""}
          ${viveworkerTask.deliverableType ? `<p><strong>${escapeHtml(L("a2a.task.deliverableType"))}</strong>: ${escapeHtml(viveworkerTask.deliverableType)}</p>` : ""}
          ${priceLabel ? `<p><strong>${escapeHtml(L("a2a.task.price"))}</strong>: ${escapeHtml(priceLabel)}</p>` : ""}
          ${payment.payTo ? `<p><strong>${escapeHtml(L("a2a.task.payTo"))}</strong>: <code>${escapeHtml(payment.payTo)}</code></p>` : ""}
          ${detail.paidDeliverable?.url ? `<p><strong>${escapeHtml(L("a2a.task.unlockUrl"))}</strong>: <a href="${escapeHtml(detail.paidDeliverable.url)}" target="_blank" rel="noopener">${escapeHtml(detail.paidDeliverable.url)}</a></p>` : ""}
        </div>
      </div>
    `
    : "";

  // Show executor selector when "ask" mode is active and both CLIs are available.
  const executors = state.session?.a2aExecutors || { codex: false, claude: false };
  const executorPref = state.session?.a2aExecutorPreference || "auto";
  const showExecutorPicker = enabled && executorPref === "ask" && executors.codex && executors.claude;
  const pickedExecutor = state.a2aTaskExecutorPick || "codex";
  const executorPicker = showExecutorPicker
    ? `
      <div class="reply-composer__instruction">
        <label class="field-label">${escapeHtml(L("a2a.task.executor"))}</label>
        <div class="a2a-executor-picker">
          <label class="a2a-executor-picker__option">
            <input type="radio" name="executor" value="codex" ${pickedExecutor === "codex" ? "checked" : ""} />
            <span>${escapeHtml(L("a2a.executor.codex"))}</span>
          </label>
          <label class="a2a-executor-picker__option">
            <input type="radio" name="executor" value="claude" ${pickedExecutor === "claude" ? "checked" : ""} />
            <span>${escapeHtml(L("a2a.executor.claude"))}</span>
          </label>
        </div>
      </div>
    `
    : "";

  const buttons = enabled
    ? `
      <div class="actions actions--stack${options.mobile ? " actions--sticky" : ""}">
        <button type="submit" data-action="approve" class="primary primary--wide">${escapeHtml(L("a2a.task.approve"))}</button>
        <button type="submit" data-action="deny" class="danger danger--wide">${escapeHtml(L("a2a.task.deny"))}</button>
      </div>
    `
    : `<p class="muted reply-composer__description">${escapeHtml(L("a2a.task.resolved"))}</p>`;
  const buttonsWrapped = enabled && options.mobile ? `<div class="detail-action-bar">${buttons}</div>` : buttons;

  return `
    <section class="detail-card detail-card--reply ${options.mobile ? "detail-card--mobile" : ""}">
      <form class="reply-composer" data-a2a-task-form data-token="${escapeHtml(detail.token || "")}">
        <div class="reply-composer__copy">
          <span class="eyebrow-pill eyebrow-pill--quiet">${escapeHtml(L("a2a.task.eyebrow"))}</span>
          ${statusBadge}
          ${callerLine}
          ${paidDeliverableBlock}
          <p class="muted reply-composer__description">${enabled ? escapeHtml(L("a2a.task.editHint")) : ""}</p>
        </div>
        <div class="reply-composer__instruction">
          <label class="field-label">${escapeHtml(L("a2a.task.instruction"))}</label>
          <textarea name="instruction" class="reply-composer__textarea" rows="6" ${enabled ? "" : "readonly"}>${escapeHtml(instruction)}</textarea>
        </div>
        ${executorPicker}
        ${!enabled && detail.messageText ? `
        <div class="reply-composer__instruction">
          <label class="field-label">${escapeHtml(L("a2a.task.response"))}</label>
          <pre class="a2a-task-response">${escapeHtml(detail.messageText)}</pre>
        </div>
        ` : ""}
        ${buttonsWrapped}
      </form>
    </section>
  `;
}

function renderThreadShareDetail(detail, options = {}) {
  if (detail.kind !== "thread_share") return "";
  const enabled = detail.threadShareEnabled !== false && detail.readOnly !== true;
  const content = detail.shareContent || "";
  const fromLabel = detail.sourceLabel || detail.sourceTool || "agent";
  const toLabel = detail.targetLabel || detail.targetConversationId?.slice(0, 8) || detail.targetTool || "thread";
  const contextFiles = Array.isArray(detail.contextFiles) ? detail.contextFiles : [];
  const shareTypeLabel = {
    plan_review: L("threadShare.type.planReview"),
    handoff: L("threadShare.type.handoff"),
    message: L("threadShare.type.message"),
  }[detail.shareType] || L("threadShare.type.message");

  const contextFilesHtml = contextFiles.length > 0
    ? `<div class="reply-composer__instruction">
        <label class="field-label">${escapeHtml(L("threadShare.contextFiles"))}</label>
        <ul class="context-files-list">${contextFiles.map((f) => `<li class="context-file-item"><code>${escapeHtml(f)}</code></li>`).join("")}</ul>
      </div>`
    : "";

  const buttons = enabled
    ? `
      <div class="actions actions--stack${options.mobile ? " actions--sticky" : ""}">
        <button type="submit" data-action="approve" class="primary primary--wide">${escapeHtml(L("threadShare.approve"))}</button>
        <button type="submit" data-action="deny" class="danger danger--wide">${escapeHtml(L("threadShare.deny"))}</button>
      </div>
    `
    : `<p class="muted reply-composer__description">${escapeHtml(L("threadShare.resolved"))}</p>`;
  const buttonsWrapped = enabled && options.mobile ? `<div class="detail-action-bar">${buttons}</div>` : buttons;

  return `
    <section class="detail-card detail-card--reply ${options.mobile ? "detail-card--mobile" : ""}">
      <form class="reply-composer" data-thread-share-form data-token="${escapeHtml(detail.token || "")}">
        <div class="reply-composer__copy">
          <span class="eyebrow-pill eyebrow-pill--quiet">${escapeHtml(L("threadShare.eyebrow"))}</span>
          <span class="eyebrow-pill eyebrow-pill--subtle">${escapeHtml(shareTypeLabel)}</span>
          <p class="reply-composer__author-meta muted">${escapeHtml(fromLabel)} → ${escapeHtml(toLabel)}</p>
          <p class="muted reply-composer__description">${enabled ? escapeHtml(L("threadShare.editHint")) : ""}</p>
        </div>
        ${contextFilesHtml}
        <div class="reply-composer__instruction">
          <label class="field-label">${escapeHtml(L("threadShare.content"))}</label>
          <textarea name="shareContent" class="reply-composer__textarea" rows="12" ${enabled ? "" : "readonly"}>${escapeHtml(content)}</textarea>
        </div>
        ${buttonsWrapped}
      </form>
    </section>
  `;
}

function renderCompletionReplyComposer(detail, options = {}) {
  if (!isCompletionReplyAvailable(detail)) {
    return "";
  }

  const draft = getCompletionReplyDraft(detail.token);
  const planMode = draft.mode === "plan";
  const providerVars = { provider: providerDisplayName(detail?.provider) };
  const sendLabel = draft.sending
    ? L("reply.sendSending")
    : draft.confirmOverride
      ? L("reply.sendConfirm")
      : L("reply.send", providerVars);
  const disabled = draft.sending || !normalizeClientText(draft.text);
  const warningTimestamp = draft.warning?.createdAtMs ? formatTimelineTimestamp(draft.warning.createdAtMs) : "";
  const showCollapsedState =
    draft.collapsedAfterSend && Boolean(draft.notice) && !draft.error && !draft.warning && !draft.sending;
  const attachments = Array.isArray(draft.attachments) ? draft.attachments : [];

  return `
    <section class="detail-card detail-card--reply ${options.mobile ? "detail-card--mobile" : ""}">
      <div class="reply-composer">
        <div class="reply-composer__copy">
          <span class="eyebrow-pill eyebrow-pill--quiet">${escapeHtml(L("reply.eyebrow"))}</span>
          <h3 class="reply-composer__title">${escapeHtml(L("reply.title", providerVars))}</h3>
          <p class="muted reply-composer__description">${escapeHtml(L("reply.copy", providerVars))}</p>
        </div>
        ${draft.notice ? `<p class="inline-alert inline-alert--success">${escapeHtml(draft.notice)}</p>` : ""}
        ${draft.error ? `<p class="inline-alert inline-alert--danger">${escapeHtml(draft.error)}</p>` : ""}
        ${
          draft.warning
            ? `
              <div class="inline-alert inline-alert--warning reply-warning">
                <p class="reply-warning__title">${escapeHtml(L("reply.warning.title"))}</p>
                <p class="reply-warning__copy">${escapeHtml(L("reply.warning.copy"))}</p>
                ${
                  draft.warning.summary || warningTimestamp
                    ? `
                      <p class="reply-warning__meta">
                        ${warningTimestamp ? `<span>${escapeHtml(warningTimestamp)}</span>` : ""}
                        ${draft.warning.summary ? `<span>${escapeHtml(draft.warning.summary)}</span>` : ""}
                      </p>
                    `
                    : ""
                }
              </div>
            `
            : ""
        }
        ${
          showCollapsedState
            ? `
              <div class="reply-sent-summary">
                ${
                  draft.sentText
                    ? `
                      <div class="reply-sent-summary__preview">
                        <p class="reply-sent-summary__label">${escapeHtml(L("reply.sentPreviewLabel"))}</p>
                        <p class="reply-sent-summary__text">${escapeHtml(draft.sentText)}</p>
                      </div>
                    `
                    : ""
                }
                <div class="actions actions--stack">
                  <button class="secondary secondary--wide" type="button" data-reopen-completion-reply data-token="${escapeHtml(detail.token)}">
                    ${escapeHtml(L("reply.sendAnother"))}
                  </button>
                </div>
              </div>
            `
            : `
              <form class="reply-composer__form" data-completion-reply-form data-token="${escapeHtml(detail.token)}" data-provider="${escapeHtml(normalizeProviderClient(detail?.provider))}" data-reply-kind="${escapeHtml(detail.kind)}">
                <label class="field reply-field">
                  <span class="field-label">${escapeHtml(L("reply.fieldLabel"))}</span>
                  <div class="reply-field__shell">
                    <textarea
                      class="reply-field__input"
                      name="text"
                      rows="4"
                      placeholder="${escapeHtml(L("reply.placeholder", providerVars))}"
                      data-completion-reply-textarea
                      data-reply-token="${escapeHtml(detail.token)}"
                    >${escapeHtml(draft.text)}</textarea>
                    <div class="reply-field__toolbar">
                      ${
                        detail.reply?.supportsImages
                          ? `
                            <label class="reply-attachment-trigger" aria-label="${escapeHtml(L(attachments.length ? "reply.imageAddMore" : "reply.imageAdd"))}">
                              <input
                                class="reply-attachment-trigger__input"
                                type="file"
                                accept="image/*"
                                multiple
                                data-reply-image-input
                                data-reply-token="${escapeHtml(detail.token)}"
                              >
                              <span class="reply-attachment-trigger__icon" aria-hidden="true">${renderIcon("clip")}</span>
                              ${
                                attachments.length
                                  ? `<span class="reply-attachment-trigger__count">${escapeHtml(String(attachments.length))}</span>`
                                  : ""
                              }
                            </label>
                          `
                          : ""
                      }
                      ${
                        detail.reply?.supportsPlanMode
                          ? `
                            <label class="reply-mode-toggle" data-reply-mode-switch>
                              <span class="reply-mode-toggle__label">${escapeHtml(L("reply.mode.planLabel"))}</span>
                              <input
                                class="reply-mode-toggle__input"
                                type="checkbox"
                                ${planMode ? "checked" : ""}
                                data-reply-mode-toggle
                                data-reply-token="${escapeHtml(detail.token)}"
                              >
                              <span class="reply-mode-toggle__track" aria-hidden="true">
                                <span class="reply-mode-toggle__thumb"></span>
                              </span>
                            </label>
                          `
                          : ""
                      }
                    </div>
                  </div>
                </label>
                ${
                  detail.reply?.supportsImages
                    ? `
                      ${
                        attachments.length
                          ? `
                            <div class="reply-image-preview-list">
                              ${attachments
                                .map(
                                  (attachment, index) => `
                                    <div class="reply-image-preview">
                                      <img class="reply-image-preview__image" src="${escapeHtml(attachment.previewUrl || "")}" alt="${escapeHtml(attachment.name || "")}">
                                      <div class="reply-image-preview__copy">
                                        <p class="reply-image-preview__name">${escapeHtml(attachment.name || "")}</p>
                                        <p class="reply-image-preview__meta">${escapeHtml(L("reply.imageAttached"))}</p>
                                      </div>
                                      <button
                                        class="secondary secondary--compact"
                                        type="button"
                                        data-reply-image-remove
                                        data-reply-token="${escapeHtml(detail.token)}"
                                        data-reply-image-index="${index}"
                                      >
                                        ${escapeHtml(L("reply.imageRemove"))}
                                      </button>
                                    </div>
                                  `
                                )
                                .join("")}
                            </div>
                          `
                          : ""
                      }
                    `
                    : ""
                }
                <div class="actions actions--stack">
                  <button class="primary primary--wide" type="submit" ${disabled ? "disabled" : ""}>${escapeHtml(sendLabel)}</button>
                </div>
              </form>
            `
        }
      </div>
    </section>
  `;
}

function isCompletionReplyAvailable(detail) {
  return Boolean(
    detail &&
    (detail.kind === "completion" || detail.kind === "assistant_final") &&
    detail.reply?.enabled === true &&
    detail.token
  );
}

function renderCompletionReplyDock(detail) {
  if (!isCompletionReplyAvailable(detail)) {
    return "";
  }
  const providerVars = { provider: providerDisplayName(detail?.provider) };
  return `
    <div class="reply-dock" role="region" aria-label="${escapeHtml(L("reply.eyebrow"))}">
      <button
        class="reply-dock__button"
        type="button"
        data-open-completion-reply-sheet
        data-token="${escapeHtml(detail.token)}"
      >
        <span class="reply-dock__label">${escapeHtml(L("reply.title", providerVars))}</span>
      </button>
    </div>
  `;
}

function renderCompletionReplySheet(detail) {
  if (!isCompletionReplyAvailable(detail) || state.completionReplySheetToken !== detail.token) {
    return "";
  }
  const providerVars = { provider: providerDisplayName(detail?.provider) };
  return `
    <div class="reply-sheet-backdrop" data-close-completion-reply-sheet aria-hidden="true"></div>
    <section class="reply-sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(L("reply.title", providerVars))}">
      <div class="reply-sheet__handle" aria-hidden="true"></div>
      <button class="reply-sheet__close" type="button" data-close-completion-reply-sheet aria-label="${escapeHtml(L("common.close"))}">
        <span aria-hidden="true">&times;</span>
      </button>
      ${renderCompletionReplyComposer(detail, { mobile: true, sheet: true })}
    </section>
  `;
}

function renderChoiceQuestions(detail) {
  const effectiveAnswers = getEffectiveChoiceDraftAnswers(detail);
  return detail.questions
    .map((question) => {
      const questionTitle = question.header || question.prompt;
      const promptCopy = question.prompt && question.prompt !== questionTitle ? question.prompt : "";
      const questionHint = choiceQuestionHintText(question);
      return `
        <fieldset class="choice-question">
          <legend>${escapeHtml(questionTitle)}</legend>
          ${promptCopy ? `<p class="muted choice-question__prompt">${escapeHtml(promptCopy)}</p>` : ""}
          ${questionHint ? `<p class="choice-question__hint">${escapeHtml(questionHint)}</p>` : ""}
          <div class="choice-options">
            ${question.options
              .map((option) => {
                const value = option.id || option.label;
                const checked = effectiveAnswers?.[question.id] === value ? "checked" : "";
                const optionDescription = choiceOptionHintText(option);
                return `
                  <label class="choice-option">
                    <input type="radio" name="${escapeHtml(question.id)}" value="${escapeHtml(value)}" ${checked} required>
                    <span class="choice-option__content">
                      <span class="choice-option__label">${escapeHtml(option.label)}</span>
                      ${optionDescription ? `<span class="choice-option__description">${escapeHtml(optionDescription)}</span>` : ""}
                    </span>
                  </label>
                `;
              })
              .join("")}
          </div>
        </fieldset>
      `;
    })
    .join("");
}

function choiceQuestionHintText(question) {
  if (!question || typeof question !== "object") {
    return "";
  }
  const title = normalizeClientText(question.header || question.prompt || "");
  const prompt = normalizeClientText(question.prompt || question.header || "");
  const hint =
    [
      question.tooltip,
      question.toolTip,
      question.hint,
      question.hintText,
      question.helpText,
      question.description,
      question.subtitle,
      question.detail,
    ]
      .map((value) => normalizeClientText(value))
      .find(Boolean) || "";

  if (!hint || hint === title || hint === prompt) {
    return "";
  }

  return hint;
}

function choiceOptionHintText(option) {
  if (!option || typeof option !== "object") {
    return "";
  }
  return [
    option.description,
    option.hint,
    option.hintText,
    option.helpText,
    option.subtitle,
    option.detail,
  ]
    .map((value) => normalizeClientText(value))
    .find(Boolean) || "";
}

function renderChoiceActionBar(detail) {
  return `
    <div class="detail-action-bar">
      <div class="actions actions--stack actions--sticky">
        ${detail.page > 1 ? `<button class="secondary secondary--wide" type="submit" data-flow="prev">${escapeHtml(L("common.back"))}</button>` : ""}
        ${
          detail.page < detail.totalPages
            ? `<button class="primary primary--wide" type="submit" data-flow="next">${escapeHtml(L("common.next"))}</button>`
            : `<button class="primary primary--wide" type="submit" data-flow="submit">${escapeHtml(L("choice.submit"))}</button>`
        }
      </div>
    </div>
  `;
}

function renderChoiceDetailDesktop(detail) {
  const kindInfo = kindMeta("choice");
  return `
    <div class="detail-shell">
      ${renderDetailMetaRow(detail, kindInfo, {
        progressLabel: L("detail.pageProgress", { page: detail.page, totalPages: detail.totalPages }),
      })}
      <h2 class="detail-title detail-title--desktop">${escapeHtml(detailDisplayTitle(detail))}</h2>
      ${renderDetailLead(detail, kindInfo)}
      <form class="choice-form" data-choice-form data-token="${escapeHtml(detail.token)}" data-page="${detail.page}" data-total-pages="${detail.totalPages}">
        <section class="detail-card detail-card--choice">
          <div class="choice-stack">
          ${renderChoiceQuestions(detail)}
          </div>
        </section>
        <div class="actions actions--stack">
          ${detail.page > 1 ? `<button class="secondary secondary--wide" type="submit" data-flow="prev">${escapeHtml(L("common.back"))}</button>` : ""}
          ${
            detail.page < detail.totalPages
              ? `<button class="primary primary--wide" type="submit" data-flow="next">${escapeHtml(L("common.next"))}</button>`
              : `<button class="primary primary--wide" type="submit" data-flow="submit">${escapeHtml(L("choice.submit"))}</button>`
          }
        </div>
      </form>
    </div>
  `;
}

function renderChoiceDetailMobile(detail) {
  const kindInfo = kindMeta("choice");
  return `
    <form class="choice-form choice-form--mobile" data-choice-form data-token="${escapeHtml(detail.token)}" data-page="${detail.page}" data-total-pages="${detail.totalPages}">
      <div class="mobile-detail-screen">
        <div class="detail-shell detail-shell--mobile">
          <div class="mobile-detail-scroll mobile-detail-scroll--detail">
            ${renderDetailMetaRow(detail, kindInfo, {
              mobile: true,
              progressLabel: L("detail.pageProgress", { page: detail.page, totalPages: detail.totalPages }),
            })}
            <section class="detail-card detail-card--choice detail-card--mobile">
              ${renderDetailLead(detail, kindInfo, { mobile: true })}
              <div class="choice-stack">
                ${renderChoiceQuestions(detail)}
              </div>
            </section>
          </div>
          ${renderChoiceActionBar(detail)}
        </div>
      </div>
    </form>
  `;
}

function renderActionButtons(actions, options = {}) {
  if (!actions.length) {
    return "";
  }
  const pendingUrl = actions.find((a) => state.pendingActionUrls.has(a.url))?.url ?? null;
  const actionsHtml = `
    <div class="actions actions--stack ${options.mobileSticky ? "actions--sticky" : ""}">
      ${actions
        .map((action) => {
          const isPending = pendingUrl === action.url;
          const isDisabled = pendingUrl !== null;
          return `
            <button
              class="${escapeHtml(actionClassForTone(action.tone))}${isPending ? " is-loading" : ""}"
              data-action-url="${escapeHtml(action.url)}"
              data-action-body='${escapeHtml(JSON.stringify(action.body || {}))}'
              ${isDisabled ? 'disabled aria-busy="true"' : ""}
            >
              ${isPending ? `<span class="action-spinner" aria-hidden="true"></span><span>${escapeHtml(action.label)}</span>` : escapeHtml(action.label)}
            </button>
          `;
        })
        .join("")}
    </div>
  `;

  if (options.mobileSticky) {
    return `<div class="detail-action-bar">${actionsHtml}</div>`;
  }

  return actionsHtml;
}

function renderDetailLoading({ mobile }) {
  const snapshot = buildDetailLoadingSnapshot();
  if (!snapshot) {
    return renderDetailEmpty();
  }
  const kindInfo = kindMeta(snapshot.kind);
  const content = `
    ${renderDetailMetaRow(snapshot, kindInfo, {
      mobile,
      progressLabel: L("common.loading"),
    })}
    <section class="detail-card detail-card--body ${mobile ? "detail-card--mobile" : ""}">
      <div class="detail-loading">
        <p class="detail-loading__copy">${escapeHtml(L("detail.loadingCopy"))}</p>
        <div class="detail-loading__lines" aria-hidden="true">
          <span class="detail-loading__line detail-loading__line--long"></span>
          <span class="detail-loading__line detail-loading__line--mid"></span>
          <span class="detail-loading__line detail-loading__line--short"></span>
        </div>
      </div>
    </section>
  `;

  if (mobile) {
    return `
      <div class="mobile-detail-screen">
        <div class="detail-shell detail-shell--mobile">
          <div class="mobile-detail-scroll mobile-detail-scroll--detail">
            ${content}
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="detail-shell">
      ${content}
    </div>
  `;
}

function renderDetailEmpty() {
  return `
    <div class="detail-empty">
      <span class="eyebrow-pill">${escapeHtml(L("common.select"))}</span>
      <h2 class="detail-title">${escapeHtml(L("detail.selectTitle"))}</h2>
      <p class="muted">${escapeHtml(L("detail.selectCopy"))}</p>
    </div>
  `;
}

function renderInstallBanner() {
  if (!shouldShowInstallBanner()) {
    return "";
  }
  return `
    <section class="install-banner">
      <div class="install-banner__copy">
        <strong>${escapeHtml(L("banner.install.title"))}</strong>
        <p class="muted">${escapeHtml(installBannerCopy())}</p>
      </div>
      <div class="actions install-banner__actions">
        <button class="secondary" type="button" data-install-guide-open>${escapeHtml(L("common.addToHomeScreen"))}</button>
        <button class="ghost" type="button" data-dismiss-install>${escapeHtml(L("common.notNow"))}</button>
      </div>
    </section>
  `;
}

function renderClientUpdateBanner() {
  return `
    <section class="install-banner install-banner--push">
      <div class="install-banner__copy">
        <strong>${escapeHtml(L("banner.clientUpdate.title"))}</strong>
        <p class="muted">${escapeHtml(L("banner.clientUpdate.copy"))}</p>
      </div>
      <div class="actions install-banner__actions">
        <button class="secondary" type="button" data-force-app-refresh>${escapeHtml(L("banner.clientUpdate.action"))}</button>
      </div>
    </section>
  `;
}

function renderTopBanner() {
  if (!isDesktopLayout() && (state.detailOpen || isSettingsSubpageOpen())) {
    return "";
  }
  if (state.clientUpdateRequired) {
    return renderClientUpdateBanner();
  }
  if (shouldShowInstallBanner()) {
    return renderInstallBanner();
  }
  if (shouldShowPushBanner()) {
    return renderPushBanner();
  }
  return "";
}

function renderGlobalErrorBanner() {
  if (!state.pushError) {
    return "";
  }
  return `
    <section class="install-banner install-banner--push">
      <div class="install-banner__copy">
        <strong>${escapeHtml(state.locale === "ja" ? "エラー" : "Error")}</strong>
        <p class="muted">${escapeHtml(state.pushError)}</p>
      </div>
    </section>
  `;
}

function renderPushBanner() {
  if (!shouldShowPushBanner()) {
    return "";
  }
  const canEnable = canEnableNotificationsFromCurrentContext();
  return `
    <section class="install-banner install-banner--push">
      <div class="install-banner__copy">
        <strong>${escapeHtml(L("banner.push.title"))}</strong>
        <p class="muted">${escapeHtml(pushBannerCopy())}</p>
      </div>
      <div class="actions install-banner__actions">
        ${
          canEnable
            ? `<button class="primary" type="button" data-push-action="enable">${escapeHtml(L("common.enableNow"))}</button>`
            : `<button class="secondary" type="button" data-open-settings-page="notifications">${escapeHtml(L("common.notificationSettings"))}</button>`
        }
        <button class="ghost" type="button" data-dismiss-push-banner>${escapeHtml(L("common.notNow"))}</button>
      </div>
    </section>
  `;
}

function renderInstallGuideModal() {
  if (!state.installGuideOpen) {
    return "";
  }
  return `
    <div class="modal-backdrop" data-install-guide-close>
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="install-guide-title">
        <div class="stack">
          <span class="eyebrow-pill">${escapeHtml(L("common.appName"))}</span>
          <h2 id="install-guide-title" class="detail-title">${escapeHtml(L("install.guide.title"))}</h2>
          <p class="muted">${escapeHtml(installGuideIntro())}</p>
          <ol class="install-steps">
            ${installGuideSteps()
              .map((step) => `<li>${escapeHtml(step)}</li>`)
              .join("")}
          </ol>
          <div class="actions actions--stack">
            <button class="primary primary--wide" type="button" data-install-guide-close>${escapeHtml(L("common.gotIt"))}</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderImageViewerModal() {
  const imageViewer = state.imageViewer;
  if (!imageViewer?.url) {
    return "";
  }

  return `
    <div class="modal-backdrop modal-backdrop--image-viewer" data-close-image-viewer>
      <section class="image-viewer" role="dialog" aria-modal="true" aria-label="${escapeHtml(imageViewer.alt || L("common.detail"))}">
        <div class="image-viewer__chrome">
          <button class="secondary image-viewer__close" type="button" data-close-image-viewer>${escapeHtml(L("common.back"))}</button>
        </div>
        <div class="image-viewer__body">
          <img class="image-viewer__image" src="${escapeHtml(imageViewer.url)}" alt="${escapeHtml(imageViewer.alt || "")}">
        </div>
      </section>
    </div>
  `;
}

function renderHazbaseLogoutConfirmModal() {
  if (!state.hazbaseLogoutConfirmOpen) {
    return "";
  }
  const email = state.hazbaseStatus?.email || "";
  // Mirror the session-logout dialog's shape but drop the split-choice
  // options — wallet sign-out is a single binary (log out or don't), no
  // "keep this device trusted" toggle applies.
  // Note: the backdrop uses a dedicated `data-close-hazbase-logout-confirm`
  // marker (bound in bindSharedUi) rather than a `data-hazbase-action`.
  // If we reused the action dispatcher here, an inside-card click would
  // bubble up to the backdrop's handler and run a second async dispatch
  // in parallel with the button's own handler — which races against the
  // API call. The mirror approach matches the session-logout modal.
  return `
    <div class="modal-backdrop" data-close-hazbase-logout-confirm>
      <section class="modal-card modal-card--confirm" role="dialog" aria-modal="true" aria-labelledby="hazbase-logout-confirm-title">
        <div class="helper-copy">
          <strong id="hazbase-logout-confirm-title">${escapeHtml(L("settings.hazbase.logout.confirm.title"))}</strong>
          <p class="muted">${escapeHtml(L("settings.hazbase.logout.confirm.copy"))}</p>
          ${email ? `<p class="muted"><code>${escapeHtml(email)}</code></p>` : ""}
        </div>
        <button class="secondary secondary--wide" type="button" data-hazbase-action="logout-confirm">${escapeHtml(L("settings.hazbase.logout.confirm.confirmLabel"))}</button>
        <button class="ghost ghost--wide" type="button" data-close-hazbase-logout-confirm>${escapeHtml(L("common.cancel"))}</button>
      </section>
    </div>
  `;
}

function renderLogoutConfirmModal() {
  if (!state.logoutConfirmOpen || !state.session?.authenticated) {
    return "";
  }

  return `
    <div class="modal-backdrop" data-close-logout-confirm>
      <section class="modal-card modal-card--confirm" role="dialog" aria-modal="true" aria-labelledby="logout-confirm-title">
        <div class="helper-copy">
          <strong id="logout-confirm-title">${escapeHtml(L("logout.confirm.title"))}</strong>
          <p class="muted">${escapeHtml(L("logout.confirm.copy"))}</p>
        </div>
        <button class="secondary secondary--wide" type="button" data-logout-mode="session">${escapeHtml(L("logout.action.keepTrusted"))}</button>
        <button class="ghost ghost--wide" type="button" data-close-logout-confirm>${escapeHtml(L("common.cancel"))}</button>
      </section>
    </div>
  `;
}

function renderDesktopTabs() {
  return `
    <nav class="segmented-nav" aria-label="Sections">
      ${renderTabButtons({ buttonClass: "segmented-nav__button", withIcons: false })}
    </nav>
  `;
}

function renderBottomTabs() {
  return `
    <nav class="bottom-nav" aria-label="Sections">
      ${renderTabButtons({ buttonClass: "bottom-nav__button", withIcons: true })}
    </nav>
  `;
}

function renderTabButtons({ buttonClass, withIcons }) {
  const pendingCount = pendingInboxCount();
  return tabs()
    .map(
      (tab) => {
        const showAttentionDot = withIcons && buttonClass === "bottom-nav__button" && tab.id === "inbox" && pendingCount > 0;
        const ariaLabel = showAttentionDot ? `${tab.label} (${pendingCount})` : tab.label;
        return `
        <button class="${buttonClass} ${state.currentTab === tab.id ? "is-active" : ""}" data-tab="${escapeHtml(tab.id)}" aria-label="${escapeHtml(ariaLabel)}">
          ${withIcons ? `<span class="tab-icon-wrap"><span class="tab-icon" aria-hidden="true">${renderIcon(tab.icon)}</span>${showAttentionDot ? `<span class="bottom-nav__attention-dot" aria-hidden="true"></span>` : ""}</span>` : ""}
          <span class="tab-label">${escapeHtml(tab.label)}</span>
        </button>
      `
      }
    )
    .join("");
}

function bindShellInteractions() {
  bindScrollableContentRenderDeferral();

  for (const button of document.querySelectorAll("[data-tab]")) {
    button.addEventListener("click", async () => {
      await switchTab(button.dataset.tab);
    });
  }

  for (const button of document.querySelectorAll("[data-open-settings], [data-open-settings-page]")) {
    button.addEventListener("click", async () => {
      clearChoiceLocalDraftForItem(state.currentItem);
      state.currentTab = "settings";
      state.detailOpen = false;
      state.settingsSubpage = "";
      clearPinnedDetailState();
      syncCurrentItemUrl(null);
      const nextPage = button.dataset.openSettingsPage || "";
      if (nextPage) {
        openSettingsSubpage(nextPage);
      }
      await renderShell();
      refreshVersionStatusForTechnicalPage();
    });
  }

  for (const button of document.querySelectorAll("[data-open-technical]")) {
    button.addEventListener("click", async () => {
      clearChoiceLocalDraftForItem(state.currentItem);
      state.currentTab = "settings";
      state.detailOpen = false;
      clearPinnedDetailState();
      syncCurrentItemUrl(null);
      openSettingsSubpage("advanced");
      await renderShell();
      refreshVersionStatusForTechnicalPage();
    });
  }

  for (const button of document.querySelectorAll("[data-settings-subpage]")) {
    button.addEventListener("click", async () => {
      openSettingsSubpage(button.dataset.settingsSubpage || "");
      await renderShell();
      refreshVersionStatusForTechnicalPage();
    });
  }

  for (const button of document.querySelectorAll("[data-settings-back]")) {
    button.addEventListener("click", async () => {
      closeSettingsSubpage();
      await renderShell();
    });
  }



  for (const select of document.querySelectorAll("[data-timeline-thread-select]")) {
    const handleInteractionStart = () => {
      markThreadFilterInteraction();
    };
    const handleInteractionEnd = () => {
      clearThreadFilterInteraction();
    };
    select.addEventListener("pointerdown", handleInteractionStart);
    select.addEventListener("click", handleInteractionStart);
    select.addEventListener("focus", handleInteractionStart);
    select.addEventListener("blur", handleInteractionEnd);
    select.addEventListener("change", async () => {
      clearThreadFilterInteraction();
      state.timelineThreadFilter = select.value || "all";
      state.timelineKindFilterOpen = false;
      alignCurrentItemToVisibleEntries();
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-provider-filter]")) {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      const next = button.dataset.providerFilter || "all";
      if (state.providerFilter === next) {
        return;
      }
      state.providerFilter = next;
      // Reset thread/kind filters — each provider has its own set of valid options
      state.timelineThreadFilter = "all";
      state.timelineKindFilter = "all";
      state.timelineKindFilterOpen = false;
      state.completedThreadFilter = "all";
      state.diffThreadFilter = "all";
      alignCurrentItemToVisibleEntries();
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-timeline-kind-filter-toggle]")) {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      markThreadFilterInteraction();
      state.timelineKindFilterOpen = !state.timelineKindFilterOpen;
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-timeline-kind-filter-option]")) {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      clearThreadFilterInteraction();
      state.timelineKindFilter = button.dataset.timelineKindFilterOption || "all";
      state.timelineKindFilterOpen = false;
      alignCurrentItemToVisibleEntries();
      await renderShell();
    });
  }

  for (const select of document.querySelectorAll("[data-diff-thread-select]")) {
    const handleInteractionStart = () => {
      markThreadFilterInteraction();
    };
    const handleInteractionEnd = () => {
      clearThreadFilterInteraction();
    };
    select.addEventListener("pointerdown", handleInteractionStart);
    select.addEventListener("click", handleInteractionStart);
    select.addEventListener("focus", handleInteractionStart);
    select.addEventListener("blur", handleInteractionEnd);
    select.addEventListener("change", async () => {
      clearThreadFilterInteraction();
      state.diffThreadFilter = select.value || "all";
      alignCurrentItemToVisibleEntries();
      await renderShell();
    });
  }

  for (const select of document.querySelectorAll("[data-completed-thread-select]")) {
    const handleInteractionStart = () => {
      markThreadFilterInteraction();
    };
    const handleInteractionEnd = () => {
      clearThreadFilterInteraction();
    };
    select.addEventListener("pointerdown", handleInteractionStart);
    select.addEventListener("click", handleInteractionStart);
    select.addEventListener("focus", handleInteractionStart);
    select.addEventListener("blur", handleInteractionEnd);
    select.addEventListener("change", async () => {
      clearThreadFilterInteraction();
      state.completedThreadFilter = select.value || "all";
      alignCurrentItemToVisibleEntries();
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-inbox-subtab]")) {
    button.addEventListener("click", async () => {
      const nextSubtab = button.dataset.inboxSubtab === "completed" ? "completed" : "pending";
      if (nextSubtab === state.inboxSubtab) {
        return;
      }
      state.inboxSubtab = nextSubtab;
      if (isDesktopLayout()) {
        alignCurrentItemToVisibleEntries();
        syncCurrentItemUrl(state.currentItem);
      }
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-open-item-kind][data-open-item-token]")) {
    button.addEventListener("click", async () => {
      openItem({
        kind: button.dataset.openItemKind,
        token: button.dataset.openItemToken,
        sourceTab: button.dataset.sourceTab,
        sourceSubtab: button.dataset.sourceSubtab,
      });
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-open-image-viewer]")) {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.imageViewer = {
        url: button.dataset.openImageViewer || "",
        alt: button.dataset.imageAlt || "",
      };
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-copy-ambient-suggestion]")) {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const detail = state.currentDetail;
      if (!detail || detail.kind !== "ambient_suggestions") {
        return;
      }
      if ((button.dataset.copyAmbientSuggestionToken || "") !== (detail.token || "")) {
        return;
      }
      const index = Math.max(0, Number(button.dataset.copyAmbientSuggestionIndex) || 0);
      const suggestions = normalizeClientAmbientSuggestions(detail.suggestions);
      const suggestion = suggestions[index];
      if (!suggestion?.prompt) {
        return;
      }
      const copyKey = ambientSuggestionCopyKey(detail.token || "", suggestion.id || "", index);
      try {
        await copyTextToClipboard(suggestion.prompt);
        state.ambientSuggestionCopyState = { key: copyKey, status: "success" };
      } catch {
        state.ambientSuggestionCopyState = { key: copyKey, status: "error" };
      }
      await renderShell();
      window.setTimeout(async () => {
        if (state.ambientSuggestionCopyState?.key !== copyKey) {
          return;
        }
        state.ambientSuggestionCopyState = null;
        await renderShell();
      }, 1600);
    });
  }

  for (const button of document.querySelectorAll("[data-diff-thread-file-toggle]")) {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleDiffThreadFileExpanded(button.dataset.diffThreadToken || "", button.dataset.diffThreadFile || "");
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-detail-diff-toggle]")) {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!state.currentDetail) {
        return;
      }
      toggleDetailDiffExpanded(state.currentDetail);
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-detail-retry]")) {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!state.currentItem) {
        return;
      }
      state.currentDetail = null;
      state.currentDetailLoading = false;
      state.detailLoadingItem = null;
      queueCurrentDetailLoad(state.currentItem);
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-back-to-list]")) {
    button.addEventListener("click", async () => {
      const nextTab = state.currentTab;
      clearChoiceLocalDraftForItem(state.currentItem);
      state.detailOpen = false;
      state.pendingListScrollRestore = !isDesktopLayout() && Boolean(state.listScrollState);
      clearPinnedDetailState();
      syncCurrentItemUrl(null);
      await renderShell();
      refreshPrimaryTabAfterNavigation(nextTab);
    });
  }

  for (const button of document.querySelectorAll("[data-action-url]")) {
    button.addEventListener("click", async () => {
      const actionUrl = button.dataset.actionUrl;
      if (state.pendingActionUrls.has(actionUrl)) {
        return;
      }
      const body = button.dataset.actionBody ? JSON.parse(button.dataset.actionBody) : {};
      const activeItem = state.currentItem ? { ...state.currentItem } : null;
      const keepDetailOpen = shouldKeepDetailAfterAction(activeItem);

      // Mark as pending in state so re-renders during the request also show loading
      state.pendingActionUrls.add(actionUrl);

      // Visual feedback on current DOM nodes (before any re-render)
      const siblingButtons = button.parentElement
        ? Array.from(button.parentElement.querySelectorAll("[data-action-url]"))
        : [button];
      const originalLabels = new Map();
      for (const sibling of siblingButtons) {
        originalLabels.set(sibling, sibling.innerHTML);
        sibling.disabled = true;
        sibling.setAttribute("aria-busy", "true");
      }
      button.classList.add("is-loading");
      button.innerHTML = `<span class="action-spinner" aria-hidden="true"></span><span>${escapeHtml(L("reply.sendSending"))}</span>`;

      try {
        let postBody = body;
        if (body?.hazbaseReauth === true) {
          if (!hazbasePasskeyHostSupport().eligible) {
            throw new Error(L("error.hazbasePasskeyLocalHostRequired"));
          }
          const { createPasskeyAssertionCredential } = await loadHazbasePasskeyModule();
          const challenge = await apiPost("/api/hazbase/passkey/assert/challenge", { purpose: "reauth" });
          const credential = await createPasskeyAssertionCredential(challenge);
          await apiPost("/api/hazbase/passkey/assert/complete", {
            challengeId: challenge.challengeId,
            credential,
            purpose: "reauth",
          });
          postBody = { ...body };
          delete postBody.hazbaseReauth;
        }
        await apiPost(actionUrl, postBody);
        if (keepDetailOpen && activeItem?.kind === "approval") {
          pinActionOutcomeDetail(
            activeItem,
            buildActionOutcomeDetail({
              kind: "approval",
              title: state.currentDetail?.title,
              message: approvalOutcomeMessage(actionUrl, activeItem?.provider),
            })
          );
        }
        await refreshAuthenticatedState();
        if (!keepDetailOpen && !isDesktopLayout()) {
          state.detailOpen = false;
          syncCurrentItemUrl(null);
        }
        await renderShell();
        state.pendingActionUrls.delete(actionUrl);
      } catch (error) {
        state.pendingActionUrls.delete(actionUrl);
        const approvalFinalized = Boolean(error?.payload?.approvalFinalized);
        if (error?.errorKey === "hazbase-session-expired") {
          await fetchHazbaseStatus();
        }
        if (activeItem?.kind === "approval" && isAlreadyHandledApprovalError(error)) {
          const recovered = await recoverHandledApprovalDetail(activeItem);
          if (recovered) {
            pinActionOutcomeDetail(activeItem, recovered);
            await renderShell();
            return;
          }
        }
        if (approvalFinalized) {
          await refreshAuthenticatedState();
          if (keepDetailOpen && activeItem?.kind === "approval") {
            pinActionOutcomeDetail(
              activeItem,
              buildActionOutcomeDetail({
                kind: "approval",
                title: state.currentDetail?.title,
                message: L("server.message.paymentFailed", { reason: error.message || String(error) }),
              })
            );
          }
        } else {
          // Restore buttons on recoverable failure so the user can retry the same action.
          for (const sibling of siblingButtons) {
            if (originalLabels.has(sibling)) {
              sibling.innerHTML = originalLabels.get(sibling);
            }
            sibling.disabled = false;
            sibling.removeAttribute("aria-busy");
          }
          button.classList.remove("is-loading");
        }
        state.pushError = error.message || String(error);
        await renderShell();
      }
    });
  }

  for (const button of document.querySelectorAll("[data-open-completion-reply-sheet][data-token]")) {
    button.addEventListener("click", async () => {
      state.completionReplySheetToken = button.dataset.token || "";
      resetHorizontalViewportScroll();
      await renderShell();
      resetHorizontalViewportScroll();
    });
  }

  for (const trigger of document.querySelectorAll("[data-close-completion-reply-sheet]")) {
    trigger.addEventListener("click", async () => {
      state.completionReplySheetToken = "";
      resetHorizontalViewportScroll();
      await renderShell();
    });
  }

  for (const input of document.querySelectorAll("[data-reply-mode-toggle][data-reply-token]")) {
    input.addEventListener("change", async () => {
      const token = input.dataset.replyToken || "";
      setCompletionReplyDraft(token, {
        mode: input.checked ? "plan" : "default",
        notice: "",
        error: "",
        warning: null,
        confirmOverride: false,
      });
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-reopen-completion-reply][data-token]")) {
    button.addEventListener("click", async () => {
      const token = button.dataset.token || "";
      setCompletionReplyDraft(token, {
        notice: "",
        error: "",
        warning: null,
        confirmOverride: false,
        collapsedAfterSend: false,
      });
      await renderShell();
    });
  }

  for (const input of document.querySelectorAll("[data-reply-image-input][data-reply-token]")) {
    input.addEventListener("change", async () => {
      const token = input.dataset.replyToken || "";
      const files = Array.from(input.files || []);
      const nextAttachments = files.map((file) => createCompletionReplyAttachment(file)).filter(Boolean);
      if (files.length > 0 && nextAttachments.length !== files.length) {
        setCompletionReplyDraft(token, {
          error: L("error.completionReplyImageInvalidType"),
          notice: "",
          warning: null,
          confirmOverride: false,
        });
        input.value = "";
        await renderShell();
        return;
      }
      const existingAttachments = getCompletionReplyDraft(token).attachments || [];
      const mergedAttachments = [...existingAttachments, ...nextAttachments].slice(0, MAX_COMPLETION_REPLY_IMAGE_COUNT);
      if (existingAttachments.length + nextAttachments.length > MAX_COMPLETION_REPLY_IMAGE_COUNT) {
        for (const attachment of nextAttachments.slice(Math.max(0, MAX_COMPLETION_REPLY_IMAGE_COUNT - existingAttachments.length))) {
          releaseCompletionReplyAttachment(attachment);
        }
        setCompletionReplyDraft(token, {
          error: L("error.completionReplyImageLimit", { count: MAX_COMPLETION_REPLY_IMAGE_COUNT }),
          notice: "",
          warning: null,
          confirmOverride: false,
          attachments: mergedAttachments,
        });
        input.value = "";
        await renderShell();
        return;
      }
      setCompletionReplyDraft(token, {
        attachments: mergedAttachments,
        notice: "",
        error: "",
        warning: null,
        confirmOverride: false,
      });
      input.value = "";
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-reply-image-remove][data-reply-token]")) {
    button.addEventListener("click", async () => {
      const token = button.dataset.replyToken || "";
      const index = Number(button.dataset.replyImageIndex ?? "-1");
      const existingAttachments = getCompletionReplyDraft(token).attachments || [];
      setCompletionReplyDraft(token, {
        attachments:
          index >= 0
            ? existingAttachments.filter((_, attachmentIndex) => attachmentIndex !== index)
            : [],
        notice: "",
        error: "",
        warning: null,
        confirmOverride: false,
      });
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-open-logout-confirm]")) {
    button.addEventListener("click", async () => {
      state.logoutConfirmOpen = true;
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-logout-mode]")) {
    button.addEventListener("click", async () => {
      try {
        await logout({ revokeCurrentDeviceTrust: button.dataset.logoutMode === "revoke" });
      } catch (error) {
        state.deviceError = error.message || String(error);
        state.logoutConfirmOpen = false;
        await renderShell();
      }
    });
  }

  for (const button of document.querySelectorAll("[data-device-revoke]")) {
    button.addEventListener("click", async () => {
      state.deviceNotice = "";
      state.deviceError = "";
      state.logoutConfirmOpen = false;
      try {
        await revokeTrustedDevice(button.dataset.deviceRevoke || "");
      } catch (error) {
        state.deviceError = error.message || String(error);
        await renderShell();
      }
    });
  }

  for (const button of document.querySelectorAll("[data-push-action]")) {
    button.addEventListener("click", async () => {
      const action = button.dataset.pushAction;
      state.pushError = "";
      state.pushNotice = "";
      // Immediate visual feedback — enable/disable inherently wait on
      // Web Push APIs (permission prompt → pushManager.subscribe() →
      // server POST → refreshPushStatus), which can take 1–3 seconds.
      // Without this the button just sat there looking inert the whole
      // time. The .is-loading + aria-busy pair matches the pattern used
      // by approval action buttons elsewhere in this file.
      const wasDisabled = button.disabled;
      button.classList.add("is-loading");
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      try {
        if (action === "enable") {
          await enableNotifications();
          state.pushBannerDismissed = false;
          writePushBannerDismissed(false);
          state.pushNotice = L("notice.notificationsEnabled");
        } else if (action === "disable") {
          await disableNotifications();
          state.pushBannerDismissed = false;
          writePushBannerDismissed(false);
          state.pushNotice = L("notice.notificationsDisabled");
        } else if (action === "test") {
          await apiPost("/api/push/test", {});
          state.pushNotice = L("notice.testNotificationSent");
        }
        await refreshPushStatus();
      } catch (error) {
        state.pushError = error.message || String(error);
        // Restore this specific button on failure; renderShell() below
        // would rebuild it anyway but leaving it disabled between
        // exception and render flashes a dead button.
        button.classList.remove("is-loading");
        button.disabled = wasDisabled;
        button.removeAttribute("aria-busy");
      }
      await renderShell();
    });
  }

  for (const checkbox of document.querySelectorAll("[data-claude-away-checkbox]")) {
    checkbox.addEventListener("change", async () => {
      const next = checkbox.checked === true;
      const previous = state.session?.claudeAwayMode === true;
      // Optimistic flip — the server round-trip and the old post-toggle
      // refreshAuthenticatedState() (7 endpoints) used to gate the UI
      // update. Flip state now, POST in background, roll back on error.
      if (state.session) {
        state.session.claudeAwayMode = next;
      }
      await renderShell();
      try {
        const result = await apiPost("/api/settings/claude-away-mode", { enabled: next });
        if (state.session && result && Object.prototype.hasOwnProperty.call(result, "enabled")) {
          const reconciled = result.enabled === true;
          if (reconciled !== next) {
            state.session.claudeAwayMode = reconciled;
            await renderShell();
          }
        }
      } catch (error) {
        if (state.session) {
          state.session.claudeAwayMode = previous;
        }
        state.pushError = error.message || String(error);
        await renderShell();
      }
    });
  }

  function applyAutoPilotSettingsResult(result) {
    if (!state.session) {
      return;
    }
    state.session.autoPilotTrustedReads = result?.trustedReadsEnabled === true;
    state.session.autoPilotTrustedWrites = result?.trustedWritesEnabled === true;
    state.session.autoPilotWriteLaneContent = result?.writeLaneContentEnabled === true;
    state.session.autoPilotWriteLaneUiTests = result?.writeLaneUiTestsEnabled === true;
    state.session.autoPilotWriteLaneSource = result?.writeLaneSourceEnabled === true;
  }

  function snapshotAutoPilotSettings() {
    return {
      trustedReads: state.session?.autoPilotTrustedReads === true,
      trustedWrites: state.session?.autoPilotTrustedWrites === true,
      writeLaneContent: state.session?.autoPilotWriteLaneContent === true,
      writeLaneUiTests: state.session?.autoPilotWriteLaneUiTests === true,
      writeLaneSource: state.session?.autoPilotWriteLaneSource === true,
    };
  }

  function restoreAutoPilotSettings(snapshot) {
    if (!state.session || !snapshot) {
      return;
    }
    state.session.autoPilotTrustedReads = snapshot.trustedReads === true;
    state.session.autoPilotTrustedWrites = snapshot.trustedWrites === true;
    state.session.autoPilotWriteLaneContent = snapshot.writeLaneContent === true;
    state.session.autoPilotWriteLaneUiTests = snapshot.writeLaneUiTests === true;
    state.session.autoPilotWriteLaneSource = snapshot.writeLaneSource === true;
  }

  function reconcileAutoPilotTrustedWrites() {
    if (!state.session) {
      return;
    }
    state.session.autoPilotTrustedWrites = Boolean(
      state.session.autoPilotWriteLaneContent === true ||
      state.session.autoPilotWriteLaneUiTests === true ||
      state.session.autoPilotWriteLaneSource === true,
    );
  }

  for (const checkbox of document.querySelectorAll("[data-auto-pilot-checkbox]")) {
    checkbox.addEventListener("change", async () => {
      const next = checkbox.checked === true;
      const previous = snapshotAutoPilotSettings();
      if (state.session) {
        state.session.autoPilotTrustedReads = next;
      }
      await renderShell();
      try {
        const result = await apiPost("/api/settings/auto-pilot", { trustedReadsEnabled: next });
        applyAutoPilotSettingsResult(result);
      } catch (error) {
        restoreAutoPilotSettings(previous);
        state.pushError = error.message || String(error);
      }
      await renderShell();
    });
  }

  for (const checkbox of document.querySelectorAll("[data-auto-pilot-write-lane-checkbox]")) {
    checkbox.addEventListener("change", async () => {
      const next = checkbox.checked === true;
      const lane = normalizeClientText(checkbox.getAttribute("data-auto-pilot-write-lane-checkbox") || "");
      const previous = snapshotAutoPilotSettings();
      const payload =
        lane === "content"
          ? { writeLaneContentEnabled: next }
          : lane === "ui-tests"
            ? { writeLaneUiTestsEnabled: next }
            : { writeLaneSourceEnabled: next };
      if (state.session) {
        if (lane === "content") {
          state.session.autoPilotWriteLaneContent = next;
        } else if (lane === "ui-tests") {
          state.session.autoPilotWriteLaneUiTests = next;
        } else {
          state.session.autoPilotWriteLaneSource = next;
        }
        reconcileAutoPilotTrustedWrites();
      }
      await renderShell();
      try {
        const result = await apiPost("/api/settings/auto-pilot", payload);
        applyAutoPilotSettingsResult(result);
      } catch (error) {
        restoreAutoPilotSettings(previous);
        state.pushError = error.message || String(error);
      }
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-auto-pilot-suggest-lane]")) {
    button.addEventListener("click", async () => {
      const lane = normalizeClientText(button.getAttribute("data-auto-pilot-suggest-lane") || "");
      const payload =
        lane === "content"
          ? { writeLaneContentEnabled: true }
          : lane === "ui_tests"
            ? { writeLaneUiTestsEnabled: true }
            : lane === "source"
              ? { writeLaneSourceEnabled: true }
              : null;
      if (!payload) {
        return;
      }
      const previous = snapshotAutoPilotSettings();
      if (state.session) {
        if (lane === "content") {
          state.session.autoPilotWriteLaneContent = true;
        } else if (lane === "ui_tests") {
          state.session.autoPilotWriteLaneUiTests = true;
        } else {
          state.session.autoPilotWriteLaneSource = true;
        }
        reconcileAutoPilotTrustedWrites();
      }
      await renderShell();
      try {
        const result = await apiPost("/api/settings/auto-pilot", payload);
        applyAutoPilotSettingsResult(result);
      } catch (error) {
        restoreAutoPilotSettings(previous);
        state.pushError = error.message || String(error);
      }
      await renderShell();
    });
  }

  for (const checkbox of document.querySelectorAll("[data-a2a-public-checkbox]")) {
    checkbox.addEventListener("change", async () => {
      const next = checkbox.checked === true;
      const previous = state.a2aRelayStatus?.acceptPublicTasks === true;
      // Optimistic flip — POST + a follow-up GET of the (remote-worker)
      // relay-status endpoint used to gate the visual update. Flip the
      // local flag, render, then reconcile in background.
      if (state.a2aRelayStatus) {
        state.a2aRelayStatus = { ...state.a2aRelayStatus, acceptPublicTasks: next };
      }
      await renderShell();
      try {
        await apiPost("/api/a2a/public-tasks", { accept: next });
        apiGet("/api/a2a/relay-status")
          .then((fresh) => {
            state.a2aRelayStatus = fresh;
            renderShell();
          })
          .catch(() => {});
      } catch (error) {
        if (state.a2aRelayStatus) {
          state.a2aRelayStatus = { ...state.a2aRelayStatus, acceptPublicTasks: previous };
        }
        state.pushError = error.message || String(error);
        await renderShell();
      }
    });
  }

  for (const radio of document.querySelectorAll("[data-a2a-executor-option] input[type='radio']")) {
    radio.addEventListener("change", async () => {
      if (!radio.checked) return;
      const preference = radio.value || "auto";
      const previous = state.session?.a2aExecutorPreference || "ask";
      // Optimistic flip — the POST + refreshSession() GET used to gate
      // any re-render that depends on the preference (e.g. downstream
      // picker defaults). Flip locally and reconcile in background.
      if (state.session) {
        state.session.a2aExecutorPreference = preference;
      }
      await renderShell();
      try {
        await apiPost("/api/settings/a2a-executor", { preference });
        refreshSession().catch(() => {});
      } catch (error) {
        if (state.session) {
          state.session.a2aExecutorPreference = previous;
        }
        state.pushError = error.message || String(error);
        await renderShell();
      }
    });
  }

  for (const btn of document.querySelectorAll("[data-moltbook-titles-more]")) {
    btn.addEventListener("click", async () => {
      state.moltbookRecentTitlesExpanded = (state.moltbookRecentTitlesExpanded || 5) + 5;
      await renderShell();
    });
  }
  for (const btn of document.querySelectorAll("[data-moltbook-titles-collapse]")) {
    btn.addEventListener("click", async () => {
      state.moltbookRecentTitlesExpanded = 0;
      await renderShell();
    });
  }

  for (const btn of document.querySelectorAll("[data-a2a-share-files-more]")) {
    btn.addEventListener("click", async () => {
      state.a2aShareRecentExpanded = (state.a2aShareRecentExpanded || 5) + 5;
      await renderShell();
    });
  }
  for (const btn of document.querySelectorAll("[data-a2a-share-files-collapse]")) {
    btn.addEventListener("click", async () => {
      state.a2aShareRecentExpanded = 0;
      await renderShell();
    });
  }

  // ─── Remote pairing (Phase 5c) ─────────────────────────────────────
  // Optimistic flips with bridge-side reconciliation. The bridge endpoints
  // hot-restart the orchestrator, so the post-POST `fetchRemotePairingStatus`
  // call can briefly observe a transient state — that's fine, the next
  // render will land on the steady state.
  for (const details of document.querySelectorAll("[data-remote-pairing-details]")) {
    details.addEventListener("toggle", () => {
      state.remotePairingDetailsOpen = details.open === true;
    });
  }

  for (const checkbox of document.querySelectorAll("[data-remote-pairing-toggle-checkbox]")) {
    checkbox.addEventListener("change", async () => {
      const next = checkbox.checked === true;
      const previous = state.remotePairingStatus?.enabled === true;
      if (!next && isRemotePairingUsingRelay() && !window.confirm(L("settings.remotePairing.toggle.offConfirm"))) {
        checkbox.checked = previous;
        return;
      }
      state.remotePairingNotice = "";
      state.remotePairingError = "";
      state.remotePairingPending = "toggle";
      // Optimistic flip — render once with the new value disabled-during-pending,
      // then reconcile with the bridge.
      if (state.remotePairingStatus) {
        state.remotePairingStatus = { ...state.remotePairingStatus, enabled: next };
      } else {
        state.remotePairingStatus = {
          enabled: next,
          relayUrl: "",
          configuredRelayUrl: "",
          identityFingerprint: null,
          sessions: [],
          pairings: [],
          auditEvents: [],
        };
      }
      await renderShell();
      try {
        await apiPost("/api/remote-pairing/toggle", { enabled: next });
        state.remotePairingNotice = next
          ? L("settings.remotePairing.notice.toggleOn")
          : L("settings.remotePairing.notice.toggleOff");
        await fetchRemotePairingStatus();
      } catch (error) {
        // Roll back to the previous value so the checkbox visually reverts.
        if (state.remotePairingStatus) {
          state.remotePairingStatus = { ...state.remotePairingStatus, enabled: previous };
        }
        state.remotePairingError = L("settings.remotePairing.error.toggleFailed");
      } finally {
        state.remotePairingPending = "";
        await renderShell();
      }
    });
  }

  for (const button of document.querySelectorAll("[data-remote-pairing-relay-url-save]")) {
    button.addEventListener("click", async () => {
      // The input lives on the same page; querySelector grabs the (single)
      // visible field. If we ever add multiple URL editors we'd need to
      // scope this to a container — but right now there's exactly one.
      const input = document.querySelector("[data-remote-pairing-relay-url-input]");
      const trimmed = (input?.value || "").trim();
      state.remotePairingNotice = "";
      state.remotePairingError = "";
      state.remotePairingPending = "relayUrl";
      await renderShell();
      try {
        await apiPost("/api/remote-pairing/relay-url", { relayUrl: trimmed });
        state.remotePairingNotice = L("settings.remotePairing.notice.relayUrlSaved");
        await fetchRemotePairingStatus();
      } catch (error) {
        // Distinguish the validation error from a generic save failure so
        // the user knows whether to fix the URL or retry.
        state.remotePairingError = error?.errorKey === "invalid-relay-url"
          ? L("settings.remotePairing.error.invalidRelayUrl")
          : L("settings.remotePairing.error.relayUrlFailed");
      } finally {
        state.remotePairingPending = "";
        await renderShell();
      }
    });
  }

  for (const button of document.querySelectorAll("[data-remote-pairing-rotate-token]")) {
    button.addEventListener("click", async () => {
      const local = loadRemotePairingState();
      if (!local?.phonePub) return;
      state.remotePairingNotice = "";
      state.remotePairingError = "";
      state.remotePairingPending = "rotateToken";
      await renderShell();
      try {
        const response = await apiPost("/api/remote-pairing/rotate-token", { phonePub: local.phonePub });
        saveRemotePairingState({
          pairingId: response.pairingId,
          relayToken: response.relayToken,
          phonePub: response.phonePub,
          phoneFingerprint: response.phoneFingerprint,
          bridgePubHex: response.bridgePubHex,
          bridgeFingerprint: response.bridgeFingerprint,
          relayUrl: response.relayUrl,
          label: response.label || local.label || "",
          addedAtMs: Number.isFinite(response.addedAtMs) ? response.addedAtMs : local.addedAtMs,
          relayTokenUpdatedAtMs: Number.isFinite(response.relayTokenUpdatedAtMs)
            ? response.relayTokenUpdatedAtMs
            : Date.now(),
        });
        state.remotePairingNotice = L("settings.remotePairing.notice.tokenRotated");
        await fetchRemotePairingStatus();
      } catch (error) {
        state.remotePairingError = L("settings.remotePairing.error.tokenRotateFailed");
      } finally {
        state.remotePairingPending = "";
        await renderShell();
      }
    });
  }

  for (const button of document.querySelectorAll("[data-remote-pairing-revoke]")) {
    button.addEventListener("click", async () => {
      const phonePub = button.dataset.remotePairingRevoke || "";
      if (!phonePub) return;
      if (!window.confirm(L("settings.remotePairing.pairings.revokeConfirm"))) return;
      state.remotePairingNotice = "";
      state.remotePairingError = "";
      // Per-pub pending key so the renderer only disables this card's
      // button, not every revoke button on the page.
      state.remotePairingPending = `revoke:${phonePub}`;
      await renderShell();
      try {
        await apiPost("/api/remote-pairing/revoke", { phonePub });
        // If the revoked phone is THIS device, drop the local enrollment
        // record too — otherwise the "this device" indicator would keep
        // claiming the (now-revoked) record is live, and a future fetch
        // routing layer would try to reuse the stale pairingId. Best
        // effort: storage failures don't change the revoke outcome.
        try {
          const local = loadRemotePairingState();
          if (
            local
            && local.phonePub.toLowerCase() === phonePub.toLowerCase()
          ) {
            clearRemotePairingState();
          }
        } catch {
          // ignore — same fall-through as savePairingState
        }
        state.remotePairingNotice = L("settings.remotePairing.notice.revoked");
        await fetchRemotePairingStatus();
      } catch (error) {
        state.remotePairingError = L("settings.remotePairing.error.revokeFailed");
      } finally {
        state.remotePairingPending = "";
        await renderShell();
      }
    });
  }


for (const button of document.querySelectorAll("[data-hazbase-action]")) {
  button.addEventListener("click", async () => {
    state.hazbaseNotice = "";
    state.hazbaseError = "";
    const action = button.dataset.hazbaseAction || "";
    try {
      if (action === "request-otp") {
        // Read from the DOM input, not just state. The state mirror is
        // populated on every keystroke, but a pre-filled value (returning
        // user whose email came back from hazbase status) never fires
        // `input`, so state stays empty while the DOM shows the address.
        // Treat DOM as authoritative and fall back to state.
        const emailInput = document.querySelector('[data-hazbase-input="otp-email"]');
        const email = (emailInput?.value || state.hazbaseOtpEmail || "").trim();
        if (!email) throw new Error(L("error.hazbaseEmailRequired"));
        const result = await apiPost("/api/hazbase/request-otp", { email });
        state.hazbaseOtpEmail = email;
        state.hazbaseOtpRequested = true;
        state.hazbaseOtpCode = "";
        state.hazbaseNotice = result?.debugCode
          ? `${L("settings.hazbase.notice.otpRequested")} (${result.debugCode})`
          : L("settings.hazbase.notice.otpRequested");
      } else if (action === "verify-otp") {
        // Same pattern — DOM wins, state fallback covers the rare case
        // where the field was removed/re-added between type and click.
        const emailInput = document.querySelector('[data-hazbase-input="otp-email"]');
        const codeInput = document.querySelector('[data-hazbase-input="otp-code"]');
        const email = (emailInput?.value || state.hazbaseOtpEmail || "").trim();
        const code = (codeInput?.value || state.hazbaseOtpCode || "").trim();
        if (!email) throw new Error(L("error.hazbaseEmailRequired"));
        if (!code) throw new Error(L("error.hazbaseOtpRequired"));
        await apiPost("/api/hazbase/verify-otp", { email, code });
        state.hazbaseOtpRequested = false;
        state.hazbaseOtpEmail = "";
        state.hazbaseOtpCode = "";
        state.hazbaseNotice = L("settings.hazbase.notice.otpVerified");
      } else if (action === "register-passkey") {
        if (!hazbasePasskeyHostSupport().eligible) {
          throw new Error(L("error.hazbasePasskeyLocalHostRequired"));
        }
        const { createPasskeyRegistrationCredential } = await loadHazbasePasskeyModule();
        const challenge = await apiPost("/api/hazbase/passkey/register/challenge", {});
        const credential = await createPasskeyRegistrationCredential(challenge);
        await apiPost("/api/hazbase/passkey/register/complete", {
          challengeId: challenge.challengeId,
          credential,
        });
        state.hazbaseNotice = L("settings.hazbase.notice.passkeyRegistered");
      } else if (action === "bootstrap-base-sepolia" || action === "bootstrap-base") {
        if (!hazbasePasskeyHostSupport().eligible) {
          throw new Error(L("error.hazbasePasskeyLocalHostRequired"));
        }
        const { createPasskeyAssertionCredential } = await loadHazbasePasskeyModule();
        const chainId = action === "bootstrap-base" ? 8453 : 84532;
        const challenge = await apiPost("/api/hazbase/passkey/assert/challenge", { purpose: "bootstrap" });
        const credential = await createPasskeyAssertionCredential(challenge);
        await apiPost("/api/hazbase/passkey/assert/complete", {
          challengeId: challenge.challengeId,
          credential,
          purpose: "bootstrap",
        });
        await apiPost("/api/hazbase/account/bootstrap", { chainId });
        state.hazbaseNotice = L("settings.hazbase.notice.walletBootstrapped", { chainId });
      } else if (action === "logout") {
        // Gate wallet logout behind an explicit confirm — the modal's
        // "confirm" button dispatches `logout-confirm`, which actually
        // hits the API. Short-circuit here so the initial click only
        // opens the dialog.
        state.hazbaseLogoutConfirmOpen = true;
        await renderShell();
        return;
      } else if (action === "logout-confirm") {
        state.hazbaseLogoutConfirmOpen = false;
        await apiPost("/api/hazbase/logout", {});
        state.hazbaseNotice = L("settings.hazbase.notice.signedOut");
      } else if (action === "refresh-session") {
        await apiPost("/api/hazbase/session/refresh", {});
        state.hazbaseOtpRequested = false;
        state.hazbaseOtpCode = "";
        state.hazbaseNotice = L("settings.hazbase.notice.sessionRefreshStarted");
      } else if (action === "change-email") {
        // Flip the form back to pre-send mode. We keep the email so typo
        // recovery ("hoshin" → "hoshino") stays one edit away, but drop
        // the now-stale OTP code. No server call — hazbase invalidates
        // the previous OTP automatically when a fresh one is requested.
        state.hazbaseOtpRequested = false;
        state.hazbaseOtpCode = "";
        state.hazbaseNotice = "";
        state.hazbaseError = "";
        await renderShell();
        // Move focus back to the (now re-enabled) email input so the user
        // can start editing immediately.
        document.querySelector('[data-hazbase-input="otp-email"]')?.focus();
        return;
      } else if (action === "mainnet-opt-in") {
        // Pure client-side reveal — the mainnet step is always in the flow
        // data, we just hide it behind an opt-in link to keep the default
        // path (testnet only) focused. No network call; no status refetch.
        state.hazbaseMainnetOptIn = true;
        await renderShell();
        return;
      }
      await fetchHazbaseStatus();
    } catch (error) {
      if (error?.errorKey === "hazbase-session-expired") {
        state.hazbaseOtpRequested = false;
        state.hazbaseOtpCode = "";
        await fetchHazbaseStatus();
      }
      state.hazbaseError = error.message || String(error);
    }
    await renderShell();
  });
}

// Mirror every keystroke into state so a background re-render (poll tick,
// notice clear, etc.) can repopulate `value="..."` without wiping what
// the user was typing. Reads happen at button-click time against state,
// which is why we don't need to also query the DOM in the handler.
for (const input of document.querySelectorAll("[data-hazbase-input]")) {
  const name = input.dataset.hazbaseInput || "";
  input.addEventListener("input", () => {
    if (name === "otp-email") state.hazbaseOtpEmail = input.value;
    else if (name === "otp-code") state.hazbaseOtpCode = input.value;
  });
  // Enter key submits the step. In the email field it triggers "send"
  // (or "verify" once a code was already issued — the email field stays
  // editable post-send to support typo recovery via resend). In the OTP
  // field it always submits verify.
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    const target = name === "otp-code"
      ? "verify-otp"
      : state.hazbaseOtpRequested ? "verify-otp" : "request-otp";
    const btn = document.querySelector(`[data-hazbase-action="${target}"]`);
    btn?.click();
  });
}

// Tap-to-copy the wallet payout address. We swap the clipboard icon to a
// check mark for ~1.5s via CSS (toggling `.is-copied`) rather than a full
// re-render, so focus stays on the button and the rest of the settings
// page doesn't flicker. The address sits inside a banner that doesn't
// otherwise re-render on every tick, so an ephemeral class flip is the
// cleanest way to acknowledge the copy.
for (const button of document.querySelectorAll("[data-wallet-address-copy]")) {
  button.addEventListener("click", async () => {
    const text = button.dataset.walletAddressCopy || "";
    if (!text) return;
    try {
      await copyTextToClipboard(text);
      button.classList.add("is-copied");
      if (button._copyResetTimer) clearTimeout(button._copyResetTimer);
      button._copyResetTimer = setTimeout(() => {
        button.classList.remove("is-copied");
        button._copyResetTimer = null;
      }, 1500);
    } catch {
      // Copy failed (permissions denied, execCommand unsupported, etc).
      // We intentionally stay silent — the address is still visible and
      // `user-select: all` on the text span lets the user long-press to
      // select manually on iOS.
    }
  });
}

  for (const button of document.querySelectorAll("[data-locale-option]")) {
    button.addEventListener("click", async () => {
      state.pushError = "";
      state.pushNotice = "";
      const nextLocale = button.dataset.localeOption || "";
      // Flip language synchronously and render before the POST — the
      // UI switches in one frame instead of waiting on the round-trip
      // plus the 7-endpoint refreshAuthenticatedState() that followed.
      const previousSession = applyLocaleOverrideOptimistically(nextLocale);
      await renderShell();
      try {
        await persistLocaleOverride(nextLocale, previousSession);
        // Server-rendered inbox/timeline strings (kind labels, summaries)
        // are localised; refresh them in the background so the user
        // doesn't wait. Polling would eventually pick this up anyway,
        // but this makes the switch feel instant.
        Promise.all([
          refreshInbox().catch(() => {}),
          refreshInboxDiff().catch(() => {}),
          refreshTimeline().catch(() => {}),
        ]).then(() => renderShell());
      } catch (error) {
        state.pushError = error.message || String(error);
        await renderShell();
      }
    });
  }

  const draftForm = document.querySelector("[data-choice-form]");
  if (draftForm) {
    draftForm.addEventListener("change", () => {
      const token = draftForm.dataset.token;
      const form = new FormData(draftForm);
      mergeChoiceLocalDraft(token, Object.fromEntries(form.entries()));
    });

    draftForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(draftForm);
      const answers = Object.fromEntries(form.entries());
      const token = draftForm.dataset.token;
      const page = Number(draftForm.dataset.page || "1");
      const totalPages = Number(draftForm.dataset.totalPages || "1");
      const action = event.submitter?.dataset.flow || "submit";
      mergeChoiceLocalDraft(token, answers);
      if (action === "next" || action === "prev") {
        const delta = action === "next" ? 1 : -1;
        await apiPost(`/api/items/choice/${encodeURIComponent(token)}/draft`, {
          answers,
          page: Math.max(1, Math.min(totalPages, page + delta)),
        });
      } else {
        const activeItem = state.currentItem ? { ...state.currentItem } : null;
        const keepDetailOpen = shouldKeepDetailAfterAction(activeItem);
        await apiPost(`/api/items/choice/${encodeURIComponent(token)}/submit`, { answers });
        clearChoiceLocalDraft(token);
        if (keepDetailOpen && activeItem?.kind === "choice") {
          pinActionOutcomeDetail(
            activeItem,
            buildActionOutcomeDetail({
              kind: "choice",
              title: state.currentDetail?.title,
              message: L("server.message.choiceSubmitted", { provider: providerDisplayName(activeItem?.provider) }),
            })
          );
        } else if (!isDesktopLayout()) {
          state.detailOpen = false;
          syncCurrentItemUrl(null);
        }
      }
      await refreshAuthenticatedState();
      await renderShell();
    });
  }

  const moltbookDraftForm = document.querySelector("[data-moltbook-draft-form]");
  if (moltbookDraftForm) {
    const token = moltbookDraftForm.dataset.token || "";
    let submittedAction = "approve";
    moltbookDraftForm.querySelectorAll("button[type='submit']").forEach((btn) => {
      btn.addEventListener("click", () => {
        submittedAction = btn.dataset.action || "approve";
      });
    });
    moltbookDraftForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (moltbookDraftForm.dataset.submitting === "1") return;
      moltbookDraftForm.dataset.submitting = "1";
      const buttons = moltbookDraftForm.querySelectorAll("button[type='submit']");
      const textarea = moltbookDraftForm.querySelector("textarea");
      const labelCache = new Map();
      buttons.forEach((btn) => {
        labelCache.set(btn, btn.innerHTML);
        btn.disabled = true;
        if (btn.dataset.action === submittedAction) {
          btn.innerHTML = submittedAction === "approve" ? "送信中…" : "処理中…";
          btn.classList.add("is-loading");
        } else {
          btn.classList.add("is-dimmed");
        }
      });
      if (textarea) textarea.readOnly = true;
      const editedText = normalizeClientText(new FormData(moltbookDraftForm).get("text"));
      const titleInput = moltbookDraftForm.querySelector("[data-moltbook-draft-title]");
      const editedTitle = titleInput ? normalizeClientText(titleInput.value) : "";
      try {
        const decisionBody = { action: submittedAction, editedText };
        if (editedTitle) decisionBody.editedTitle = editedTitle;
        // apiPost routes through LAN-first / relay-fallback and throws on
        // !ok — the existing catch below handles both transport and HTTP
        // failures uniformly.
        await apiPost(
          `/api/items/moltbook-draft/${encodeURIComponent(token)}/decision`,
          decisionBody,
        );
        // Mark local detail as resolved so re-render shows "already resolved" immediately.
        if (state.currentDetail?.kind === "moltbook_draft") {
          state.currentDetail.moltbookDraftEnabled = false;
          state.currentDetail.readOnly = true;
        }
        await refreshAuthenticatedState();
        await renderShell();
      } catch (error) {
        alert(`Moltbook draft ${submittedAction} failed: ${error.message}`);
        buttons.forEach((btn) => {
          btn.disabled = false;
          btn.classList.remove("is-loading", "is-dimmed");
          btn.innerHTML = labelCache.get(btn);
        });
        if (textarea) textarea.readOnly = false;
        moltbookDraftForm.dataset.submitting = "";
      }
    });
  }

  for (const radio of document.querySelectorAll(".a2a-executor-picker input[type='radio']")) {
    radio.addEventListener("change", () => {
      if (radio.checked) state.a2aTaskExecutorPick = radio.value;
    });
  }

  const a2aTaskForm = document.querySelector("[data-a2a-task-form]");
  if (a2aTaskForm) {
    const token = a2aTaskForm.dataset.token || "";
    let submittedAction = "approve";
    a2aTaskForm.querySelectorAll("button[type='submit']").forEach((btn) => {
      btn.addEventListener("click", () => {
        submittedAction = btn.dataset.action || "approve";
      });
    });
    a2aTaskForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (a2aTaskForm.dataset.submitting === "1") return;
      a2aTaskForm.dataset.submitting = "1";
      const buttons = a2aTaskForm.querySelectorAll("button[type='submit']");
      const textarea = a2aTaskForm.querySelector("textarea");
      const labelCache = new Map();
      buttons.forEach((btn) => {
        labelCache.set(btn, btn.innerHTML);
        btn.disabled = true;
        if (btn.dataset.action === submittedAction) {
          btn.innerHTML = submittedAction === "approve" ? "Executing…" : "Denying…";
          btn.classList.add("is-loading");
        } else {
          btn.classList.add("is-dimmed");
        }
      });
      if (textarea) textarea.readOnly = true;
      const instruction = normalizeClientText(new FormData(a2aTaskForm).get("instruction"));
      const executorRadio = a2aTaskForm.querySelector("input[name='executor']:checked");
      const executor = executorRadio ? executorRadio.value : "";
      try {
        const decisionBody = { action: submittedAction, instruction };
        if (executor) decisionBody.executor = executor;
        await apiPost(
          `/api/items/a2a-task/${encodeURIComponent(token)}/decision`,
          decisionBody,
        );
        if (state.currentDetail?.kind === "a2a_task") {
          state.currentDetail.a2aTaskEnabled = false;
          state.currentDetail.readOnly = true;
        }
        await refreshAuthenticatedState();
        await renderShell();
      } catch (error) {
        alert(`A2A task ${submittedAction} failed: ${error.message}`);
        buttons.forEach((btn) => {
          btn.disabled = false;
          btn.classList.remove("is-loading", "is-dimmed");
          btn.innerHTML = labelCache.get(btn);
        });
        if (textarea) textarea.readOnly = false;
        a2aTaskForm.dataset.submitting = "";
      }
    });
  }

  const threadShareForm = document.querySelector("[data-thread-share-form]");
  if (threadShareForm) {
    const token = threadShareForm.dataset.token || "";
    let submittedAction = "approve";
    threadShareForm.querySelectorAll("button[type='submit']").forEach((btn) => {
      btn.addEventListener("click", () => {
        submittedAction = btn.dataset.action || "approve";
      });
    });
    threadShareForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (threadShareForm.dataset.submitting === "1") return;
      threadShareForm.dataset.submitting = "1";
      const buttons = threadShareForm.querySelectorAll("button[type='submit']");
      const textarea = threadShareForm.querySelector("textarea");
      const labelCache = new Map();
      buttons.forEach((btn) => {
        labelCache.set(btn, btn.innerHTML);
        btn.disabled = true;
        if (btn.dataset.action === submittedAction) {
          btn.innerHTML = submittedAction === "approve" ? "Sharing…" : "Denying…";
          btn.classList.add("is-loading");
        } else {
          btn.classList.add("is-dimmed");
        }
      });
      if (textarea) textarea.readOnly = true;
      const editedContent = normalizeClientText(new FormData(threadShareForm).get("shareContent"));
      try {
        await apiPost(
          `/api/threads/share/${encodeURIComponent(token)}/decision`,
          { decision: submittedAction, editedContent },
        );
        if (state.currentDetail?.kind === "thread_share") {
          state.currentDetail.threadShareEnabled = false;
          state.currentDetail.readOnly = true;
        }
        await refreshAuthenticatedState();
        await renderShell();
      } catch (error) {
        alert(`Thread share ${submittedAction} failed: ${error.message}`);
        buttons.forEach((btn) => {
          btn.disabled = false;
          btn.classList.remove("is-loading", "is-dimmed");
          btn.innerHTML = labelCache.get(btn);
        });
        if (textarea) textarea.readOnly = false;
        threadShareForm.dataset.submitting = "";
      }
    });
  }

  const replyForm = document.querySelector("[data-completion-reply-form]");
  if (replyForm) {
    const token = replyForm.dataset.token || "";
    const textarea = replyForm.querySelector("[data-completion-reply-textarea]");
    textarea?.addEventListener("input", () => {
      const nextDraft = {
        text: textarea.value,
        notice: "",
        error: "",
        warning: null,
        confirmOverride: false,
      };
      setCompletionReplyDraft(token, nextDraft);
      syncCompletionReplyComposerLiveState(replyForm, {
        ...getCompletionReplyDraft(token),
        ...nextDraft,
      });
    });

    replyForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const replyProvider = replyForm.dataset.provider || "";
      const draft = getCompletionReplyDraft(token);
      const text = normalizeClientText(new FormData(replyForm).get("text"));
      if (!text) {
        setCompletionReplyDraft(token, {
          text,
          error: L("error.completionReplyEmpty"),
          notice: "",
          warning: null,
          confirmOverride: false,
          sending: false,
        });
        await renderShell();
        return;
      }

      setCompletionReplyDraft(token, {
        text,
        error: "",
        notice: "",
        warning: null,
        sending: true,
      });
      await renderShell();

      try {
        const attachments = (draft.attachments || []).filter((attachment) => attachment?.file);
        let requestBody;
        if (attachments.length > 0) {
          requestBody = new FormData();
          requestBody.set("text", text);
          requestBody.set("planMode", draft.mode === "plan" ? "true" : "false");
          requestBody.set("force", draft.confirmOverride === true ? "true" : "false");
        } else {
          requestBody = {
            text,
            planMode: draft.mode === "plan",
            force: draft.confirmOverride === true,
          };
        }
        for (const attachment of attachments) {
          requestBody.append("image", attachment.file, attachment.name || attachment.file.name);
        }
        const sentNotice = L(draft.mode === "plan" ? "reply.notice.sentPlan" : "reply.notice.sentDefault", { provider: providerDisplayName(replyProvider) });
        const renderOptimisticSent = () => {
          const currentDraft = getCompletionReplyDraft(token);
          if (!currentDraft.sending || currentDraft.text !== text) {
            return;
          }
          setCompletionReplyDraft(token, {
            text: "",
            sentText: text,
            attachments: currentDraft.attachments,
            mode: draft.mode,
            sending: false,
            error: "",
            notice: sentNotice,
            warning: null,
            confirmOverride: false,
            collapsedAfterSend: true,
          });
          renderShell().catch((renderError) => {
            console.warn("[completion-reply-optimistic-render]", renderError?.message || renderError);
          });
        };
        const optimisticSentTimer = setTimeout(renderOptimisticSent, COMPLETION_REPLY_OPTIMISTIC_SENT_MS);
        let replyResult = null;
        try {
          const replyKind = replyForm.dataset.replyKind || "completion";
          replyResult = await apiPost(
            `/api/items/${encodeURIComponent(replyKind)}/${encodeURIComponent(token)}/reply`,
            requestBody,
            {
              timeoutMs: COMPLETION_REPLY_SEND_TIMEOUT_MS,
              preferRelayError: true,
            },
          );
        } finally {
          clearTimeout(optimisticSentTimer);
        }
        setCompletionReplyDraft(token, {
          text: "",
          sentText: text,
          attachments: [],
          mode: draft.mode,
          sending: false,
          error: "",
          notice: sentNotice,
          warning: null,
          confirmOverride: false,
          collapsedAfterSend: true,
        });
        if (replyResult?.ackTimeout === true) {
          console.info("[completion-reply] accepted after slow Codex ACK");
        }
        await renderShell();
        refreshAuthenticatedState()
          .then(renderShell)
          .catch((refreshError) => console.warn("[completion-reply-refresh]", refreshError?.message || refreshError));
        return;
      } catch (error) {
        const optimisticDraft = getCompletionReplyDraft(token);
        if (
          error.errorKey === "request-timeout" &&
          optimisticDraft.collapsedAfterSend &&
          optimisticDraft.sentText === text
        ) {
          refreshAuthenticatedState()
            .then(renderShell)
            .catch((refreshError) => console.warn("[completion-reply-refresh]", refreshError?.message || refreshError));
          return;
        }
        if (error.errorKey === "completion-reply-thread-advanced") {
          if (completionReplyWarningMatchesSentText(error, text, attachments.length)) {
            setCompletionReplyDraft(token, {
              text: "",
              sentText: text,
              attachments: [],
              mode: draft.mode,
              sending: false,
              error: "",
              notice: L(draft.mode === "plan" ? "reply.notice.sentPlan" : "reply.notice.sentDefault", { provider: providerDisplayName(replyProvider) }),
              warning: null,
              confirmOverride: false,
              collapsedAfterSend: true,
            });
            await renderShell();
            refreshAuthenticatedState()
              .then(renderShell)
              .catch((refreshError) => console.warn("[completion-reply-refresh]", refreshError?.message || refreshError));
            return;
          }
          setCompletionReplyDraft(token, {
            text,
            sentText: "",
            attachments: draft.attachments,
            mode: draft.mode,
            sending: false,
            notice: "",
            error: "",
            warning: error.payload?.warning ?? null,
            confirmOverride: true,
            collapsedAfterSend: false,
          });
          await renderShell();
          return;
        }
        setCompletionReplyDraft(token, {
          text,
          sentText: "",
          attachments: draft.attachments,
          mode: draft.mode,
          sending: false,
          notice: "",
          error: error.message || String(error),
          warning: null,
          confirmOverride: false,
          collapsedAfterSend: false,
        });
      }

      await renderShell();
    });
  }

  bindClaudeQuestionForm(renderShell);
  bindSharedUi(renderShell);
}

function bindClaudeQuestionForm(renderShell) {
  const form = document.querySelector("[data-claude-question-form]");
  if (!form) return;
  const token = form.dataset.token || "";
  const answerUrl = form.dataset.answerUrl || "";

  const updateAnswerForInput = (input) => {
    const draft = getClaudeQuestionDraft(token);
    const qi = Number(input.dataset.qIndex || 0);
    const oi = Number(input.dataset.oIndex || 0);
    const answers = { ...(draft.answers || {}) };
    const existing = answers[qi] || { optionIndices: [], note: "" };
    let optionIndices = Array.isArray(existing.optionIndices) ? [...existing.optionIndices] : [];
    if (input.type === "radio") {
      optionIndices = input.checked ? [oi] : [];
    } else if (input.type === "checkbox") {
      if (input.checked) {
        if (!optionIndices.includes(oi)) optionIndices.push(oi);
      } else {
        optionIndices = optionIndices.filter((idx) => idx !== oi);
      }
    }
    answers[qi] = { ...existing, optionIndices };
    setClaudeQuestionDraft(token, { answers });
  };

  for (const input of form.querySelectorAll("[data-claude-question-input]")) {
    input.addEventListener("change", () => updateAnswerForInput(input));
  }
  for (const note of form.querySelectorAll("[data-claude-question-note]")) {
    note.addEventListener("input", () => {
      const draft = getClaudeQuestionDraft(token);
      const qi = Number(note.dataset.qIndex || 0);
      const answers = { ...(draft.answers || {}) };
      const existing = answers[qi] || { optionIndices: [], note: "" };
      answers[qi] = { ...existing, note: note.value };
      setClaudeQuestionDraft(token, { answers });
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!answerUrl) return;
    const draft = getClaudeQuestionDraft(token);
    const answersMap = draft.answers || {};
    const answersArr = [];
    const totalQuestions = form.querySelectorAll(".claude-question-item").length;
    let allAnswered = true;
    for (let i = 0; i < totalQuestions; i++) {
      const a = answersMap[i] || { optionIndices: [], note: "" };
      const hasSelection = Array.isArray(a.optionIndices) && a.optionIndices.length > 0;
      const hasNote = typeof a.note === "string" && a.note.trim().length > 0;
      if (!hasSelection && !hasNote) {
        allAnswered = false;
      }
      answersArr.push({ questionIndex: i, optionIndices: a.optionIndices || [], note: a.note || "" });
    }
    if (!allAnswered) {
      setClaudeQuestionDraft(token, { error: L("claudeQuestion.requireAll"), notice: "" });
      await renderShell();
      return;
    }

    setClaudeQuestionDraft(token, { sending: true, error: "", notice: "" });
    await renderShell();

    try {
      await apiPost(answerUrl, { answers: answersArr });
      setClaudeQuestionDraft(token, {
        sending: false,
        sent: true,
        notice: L("claudeQuestion.sent", { provider: providerDisplayName("claude") }),
        error: "",
      });
      await refreshAuthenticatedState();
    } catch (error) {
      setClaudeQuestionDraft(token, {
        sending: false,
        error: error.message || String(error),
      });
    }
    await renderShell();
  });
}

function bindSharedUi(renderFn) {
  for (const button of document.querySelectorAll("[data-close-image-viewer]")) {
    button.addEventListener("click", async (event) => {
      if (button.classList.contains("modal-backdrop") && event.target.closest(".image-viewer")) {
        return;
      }
      state.imageViewer = null;
      await renderFn();
    });
  }

  for (const button of document.querySelectorAll("[data-install-guide-open]")) {
    button.addEventListener("click", async () => {
      state.installGuideOpen = true;
      await renderFn();
    });
  }

  for (const button of document.querySelectorAll("[data-force-app-refresh]")) {
    button.addEventListener("click", async () => {
      await forceAppRefreshFromLan();
      await renderFn();
    });
  }

  for (const button of document.querySelectorAll("[data-install-guide-close]")) {
    button.addEventListener("click", async (event) => {
      if (button.classList.contains("modal-backdrop")) {
        if (event.target.closest(".modal-card")) {
          return;
        }
      }
      state.installGuideOpen = false;
      await renderFn();
    });
  }

  for (const button of document.querySelectorAll("[data-close-logout-confirm]")) {
    button.addEventListener("click", async (event) => {
      if (button.classList.contains("modal-backdrop")) {
        if (event.target.closest(".modal-card")) {
          return;
        }
      }
      state.logoutConfirmOpen = false;
      await renderFn();
    });
  }

  for (const button of document.querySelectorAll("[data-close-hazbase-logout-confirm]")) {
    // Mirror the session-logout modal: the backdrop swallows outside-clicks
    // to dismiss, but inside-card clicks bubble up through here too — skip
    // those so the Confirm button's own handler can run alone.
    button.addEventListener("click", async (event) => {
      if (button.classList.contains("modal-backdrop")) {
        if (event.target.closest(".modal-card")) {
          return;
        }
      }
      state.hazbaseLogoutConfirmOpen = false;
      await renderFn();
    });
  }

  for (const button of document.querySelectorAll("[data-dismiss-install]")) {
    button.addEventListener("click", async () => {
      state.installBannerDismissed = true;
      writeInstallBannerDismissed(true);
      await renderFn();
    });
  }

  for (const button of document.querySelectorAll("[data-dismiss-push-banner]")) {
    button.addEventListener("click", async () => {
      state.pushBannerDismissed = true;
      writePushBannerDismissed(true);
      await renderFn();
    });
  }
}

function bindScrollableContentRenderDeferral() {
  const mark = () => {
    markScrollableContentInteraction();
  };
  for (const el of document.querySelectorAll(SCROLLABLE_CONTENT_SELECTORS)) {
    el.addEventListener("scroll", mark, { passive: true });
    el.addEventListener("wheel", mark, { passive: true });
    el.addEventListener("touchstart", mark, { passive: true });
    el.addEventListener("touchmove", mark, { passive: true });
    el.addEventListener("pointerdown", mark);
    el.addEventListener("copy", mark);
  }
}

function bindPartialListSurfaceInteractions(listSurface) {
  if (!listSurface || listSurface.dataset.partialListInteractionsBound === "true") {
    return;
  }
  listSurface.dataset.partialListInteractionsBound = "true";

  const targetElement = (event) => {
    const target = event.target;
    return target instanceof Element ? target : target?.parentElement || null;
  };
  const threadSelectSelector = "[data-timeline-thread-select], [data-diff-thread-select], [data-completed-thread-select]";

  listSurface.addEventListener("pointerdown", (event) => {
    if (targetElement(event)?.closest(threadSelectSelector)) {
      markThreadFilterInteraction();
    }
  });
  listSurface.addEventListener("focusin", (event) => {
    if (targetElement(event)?.closest(threadSelectSelector)) {
      markThreadFilterInteraction();
    }
  });
  listSurface.addEventListener("focusout", (event) => {
    if (targetElement(event)?.closest(threadSelectSelector)) {
      clearThreadFilterInteraction();
    }
  });

  listSurface.addEventListener("change", async (event) => {
    const target = targetElement(event);
    const timelineSelect = target?.closest("[data-timeline-thread-select]");
    const diffSelect = target?.closest("[data-diff-thread-select]");
    const completedSelect = target?.closest("[data-completed-thread-select]");
    if (!timelineSelect && !diffSelect && !completedSelect) {
      return;
    }
    clearThreadFilterInteraction();
    if (timelineSelect) {
      state.timelineThreadFilter = timelineSelect.value || "all";
      state.timelineKindFilterOpen = false;
    } else if (diffSelect) {
      state.diffThreadFilter = diffSelect.value || "all";
    } else if (completedSelect) {
      state.completedThreadFilter = completedSelect.value || "all";
    }
    alignCurrentItemToVisibleEntries();
    await renderShell();
  });

  listSurface.addEventListener("click", async (event) => {
    const target = targetElement(event);
    const threadSelect = target?.closest(threadSelectSelector);
    if (threadSelect) {
      markThreadFilterInteraction();
      return;
    }

    const providerButton = target?.closest("[data-provider-filter]");
    if (providerButton) {
      event.preventDefault();
      const next = providerButton.dataset.providerFilter || "all";
      if (state.providerFilter === next) {
        return;
      }
      state.providerFilter = next;
      state.timelineThreadFilter = "all";
      state.timelineKindFilter = "all";
      state.timelineKindFilterOpen = false;
      state.completedThreadFilter = "all";
      state.diffThreadFilter = "all";
      alignCurrentItemToVisibleEntries();
      await renderShell();
      return;
    }

    const kindToggle = target?.closest("[data-timeline-kind-filter-toggle]");
    if (kindToggle) {
      event.preventDefault();
      markThreadFilterInteraction();
      state.timelineKindFilterOpen = !state.timelineKindFilterOpen;
      await renderShell();
      return;
    }

    const kindOption = target?.closest("[data-timeline-kind-filter-option]");
    if (kindOption) {
      event.preventDefault();
      clearThreadFilterInteraction();
      state.timelineKindFilter = kindOption.dataset.timelineKindFilterOption || "all";
      state.timelineKindFilterOpen = false;
      alignCurrentItemToVisibleEntries();
      await renderShell();
      return;
    }

    const subtabButton = target?.closest("[data-inbox-subtab]");
    if (subtabButton) {
      const nextSubtab = subtabButton.dataset.inboxSubtab === "completed" ? "completed" : "pending";
      if (nextSubtab === state.inboxSubtab) {
        return;
      }
      state.inboxSubtab = nextSubtab;
      if (isDesktopLayout()) {
        alignCurrentItemToVisibleEntries();
        syncCurrentItemUrl(state.currentItem);
      }
      await renderShell();
      return;
    }

    const itemButton = target?.closest("[data-open-item-kind][data-open-item-token]");
    if (itemButton) {
      openItem({
        kind: itemButton.dataset.openItemKind,
        token: itemButton.dataset.openItemToken,
        sourceTab: itemButton.dataset.sourceTab,
        sourceSubtab: itemButton.dataset.sourceSubtab,
      });
      await renderShell();
    }
  });
}

function openSettingsSubpage(page) {
  if (!page) {
    return;
  }
  if (!isDesktopLayout()) {
    state.settingsScrollState = {
      y: currentViewportScrollY(),
    };
    state.pendingSettingsScrollRestore = false;
    state.pendingSettingsSubpageScrollReset = true;
  }
  state.settingsSubpage = page;
}

function closeSettingsSubpage() {
  if (!state.settingsSubpage) {
    return;
  }
  state.settingsSubpage = "";
  if (!isDesktopLayout() && state.settingsScrollState) {
    state.pendingSettingsScrollRestore = true;
  }
}

async function switchTab(tab) {
  state.currentTab = tab;
  state.timelineKindFilterOpen = false;
  state.pushNotice = "";
  state.pushError = "";
  state.settingsSubpage = "";
  if (tab === "settings" || !isDesktopLayout()) {
    clearChoiceLocalDraftForItem(state.currentItem);
    state.detailOpen = false;
    clearPinnedDetailState();
    syncCurrentItemUrl(null);
  } else {
    ensureCurrentSelection();
    alignCurrentItemToVisibleEntries();
    syncCurrentItemUrl(state.currentItem);
  }
  await renderShell();
  refreshPrimaryTabAfterNavigation(tab);
  if (tab === "settings") {
    void fetchHazbaseStatus()
      .then(() => {
        if (state.currentTab === "settings") {
          renderCurrentSurface();
        }
      })
      .catch(() => {});
  }
}

function openItem({ kind, token, sourceTab, sourceSubtab }) {
  const previousItem = state.currentItem ? { ...state.currentItem } : null;
  clearPinnedDetailState();
  const nextTab = sourceTab || tabForItemKind(kind, state.currentTab);
  if (nextTab === "inbox") {
    state.inboxSubtab = inboxSubtabForItemKind(kind, sourceSubtab);
  }
  state.timelineKindFilterOpen = false;
  if (previousItem && (previousItem.kind !== kind || previousItem.token !== token)) {
    clearChoiceLocalDraftForItem(previousItem);
  }
  if (!isDesktopLayout()) {
    state.listScrollState = {
      tab: nextTab,
      y: currentViewportScrollY(),
    };
    state.pendingListScrollRestore = false;
  }
  state.currentItem = { kind, token };
  state.currentTab = nextTab;
  state.detailOpen = !isDesktopLayout();
  state.pendingDetailScrollReset = state.detailOpen;
  syncCurrentItemUrl(state.currentItem);
}

function subtitleForCurrentView(detail) {
  if (state.currentTab === "settings") {
    if (state.settingsSubpage) {
      return settingsPageMeta(state.settingsSubpage).description;
    }
    return L("shell.subtitle.settings");
  }
  if (detail && state.detailOpen && !isDesktopLayout()) {
    return L("shell.subtitle.detail");
  }
  return tabMeta(state.currentTab).description;
}

function alignCurrentItemToVisibleEntries() {
  if (!isDesktopLayout() || state.currentTab === "settings") {
    return;
  }
  const preferredEntries = listEntriesForCurrentTab();
  if (!preferredEntries.length) {
    state.currentItem = null;
    state.currentDetail = null;
    syncCurrentItemUrl(null);
    return;
  }
  if (!state.currentItem || !preferredEntries.some((entry) => isSameItemRef(state.currentItem, entry.item))) {
    state.currentItem = toItemRef(preferredEntries[0].item);
    state.currentDetail = null;
  }
}

function renderStatusRow(label, value) {
  return `
    <div class="status-row">
      <span class="status-row__label">${escapeHtml(label)}</span>
      <span class="status-row__value">${escapeHtml(value)}</span>
    </div>
  `;
}

function renderEmptyList(tab) {
  return `
    <div class="empty-state">
      <p class="empty-state__title">${escapeHtml(tabMeta(tab).title)}</p>
      <p class="muted">${escapeHtml(L(`empty.${tab}`))}</p>
    </div>
  `;
}

function isSettingsSubpageOpen() {
  return state.currentTab === "settings" && Boolean(state.settingsSubpage) && !isDesktopLayout();
}

function tabMeta(tab) {
  switch (tab) {
    case "inbox":
      return {
        id: "inbox",
        title: L("tab.inbox.title"),
        label: L("tab.inbox.label"),
        icon: "pending",
        eyebrow: L("tab.inbox.eyebrow"),
        description: L("tab.inbox.description"),
      };
    case "timeline":
      return {
        id: "timeline",
        title: L("tab.timeline.title"),
        label: L("tab.timeline.label"),
        icon: "timeline",
        eyebrow: L("tab.timeline.eyebrow"),
        description: L("tab.timeline.description"),
      };
    case "diff":
      return {
        id: "diff",
        title: L("tab.code.title"),
        label: L("tab.code.label"),
        icon: "file-event",
        eyebrow: L("tab.code.eyebrow"),
        description: L("tab.code.description"),
      };
    case "settings":
      return {
        id: "settings",
        title: L("tab.settings.title"),
        label: L("tab.settings.label"),
        icon: "settings",
        eyebrow: L("tab.settings.eyebrow"),
        description: L("tab.settings.description"),
      };
    default:
      return tabMeta("timeline");
  }
}

function tabs() {
  return [
    tabMeta("inbox"),
    tabMeta("timeline"),
    tabMeta("diff"),
    tabMeta("settings"),
  ];
}

function pendingInboxCount() {
  return Array.isArray(state.inbox?.pending) ? state.inbox.pending.length : 0;
}

function tabForItemKind(kind, fallback) {
  if (kind === "completion" || kind === "plan_ready" || kind === "moltbook_draft" || kind === "moltbook_reply" || kind === "thread_share" || kind === "a2a_task" || kind === "a2a_task_result") {
    return "inbox";
  }
  if (kind === "diff_thread") {
    return "diff";
  }
  if (kind === "file_event" || kind === "ambient_suggestions") {
    return "timeline";
  }
  if (TIMELINE_MESSAGE_KINDS.has(kind)) {
    return "timeline";
  }
  if (fallback === "timeline") {
    return "timeline";
  }
  return kind === "approval" || kind === "plan" || kind === "choice"
    ? "inbox"
    : "inbox";
}

function inboxSubtabForItemKind(kind, sourceSubtab = "") {
  if (normalizeClientText(sourceSubtab || "") === "completed") {
    return "completed";
  }
  const completedKinds = new Set(["completion", "assistant_final", "plan_ready", "moltbook_reply", "thread_share", "a2a_task_result"]);
  return completedKinds.has(kind) ? "completed" : "pending";
}

function kindMeta(kind, item) {
  switch (kind) {
    case "user_message":
      return { label: L("common.userMessage"), tone: "neutral", icon: "user-message" };
    case "assistant_commentary":
      return { label: L("common.assistantCommentary"), tone: "plan", icon: "assistant-commentary" };
    case "assistant_final":
      return { label: L("common.assistantFinal"), tone: "completion", icon: "assistant-final" };
    case "ambient_suggestions":
      return { label: L("common.ambientSuggestions"), tone: "neutral", icon: "suggestions" };
    case "approval":
      return { label: L("common.approval"), tone: "approval", icon: "approval" };
    case "plan":
    case "plan_ready":
      return { label: L("common.plan"), tone: "plan", icon: "plan" };
    case "choice":
      return { label: L("common.choice"), tone: "choice", icon: "choice" };
    case "completion":
      return { label: L("common.completion"), tone: "completion", icon: "completion-item" };
    case "diff_thread":
      return { label: L("common.diff"), tone: "neutral", icon: "diff" };
    case "file_event":
      return { label: L("common.fileEvent"), tone: "neutral", icon: "file-event" };
    case "command_event":
      return { label: L("common.commandEvent"), tone: "neutral", icon: "command" };
    case "moltbook_reply":
      return { label: L("common.moltbookReply"), tone: "neutral", icon: "moltbook-comment" };
    case "moltbook_draft":
      return item?.draftType === "reply"
        ? { label: L("common.moltbookDraftReply"), tone: "neutral", icon: "moltbook-reply" }
        : { label: L("common.moltbookDraft"), tone: "neutral", icon: "moltbook-draft" };
    case "thread_share":
      return { label: L("common.threadShare"), tone: "neutral", icon: "link" };
    case "a2a_task":
      return { label: L("common.a2aTaskRequest"), tone: "neutral", icon: "item" };
    case "a2a_task_result":
      return { label: L("common.a2aTaskResult"), tone: "completion", icon: "completion-item" };
    default:
      return { label: L("common.item"), tone: "neutral", icon: "item" };
  }
}

function renderTypePillContent(kindInfo) {
  return `
    <span class="type-pill__icon" aria-hidden="true">${renderIcon(kindInfo.icon)}</span>
    <span>${escapeHtml(kindInfo.label)}</span>
  `;
}

function itemIntentText(kind, status = "pending", provider) {
  const vars = { provider: providerDisplayName(provider) };
  if (kind === "diff_thread") {
    return L("intent.diffThread");
  }
  if (kind === "file_event") {
    return L("intent.fileEvent");
  }
  if (kind === "command_event") {
    return L("intent.commandEvent");
  }
  if (kind === "ambient_suggestions") {
    return L("intent.ambientSuggestions");
  }
  if (kind === "user_message") {
    return L("intent.userMessage");
  }
  if (kind === "assistant_commentary") {
    return L("intent.assistantCommentary");
  }
  if (kind === "assistant_final") {
    return L("intent.assistantFinal", vars);
  }
  if (status === "completed") {
    return L("intent.completed");
  }
  switch (kind) {
    case "approval":
      return L("intent.approval");
    case "plan":
      return L("intent.plan", vars);
    case "choice":
      return L("intent.choice", vars);
    case "completion":
      return L("intent.completed");
    default:
      return L("summary.default");
  }
}

function detailIntentText(detail) {
  const provider = detail?.provider;
  if (detail.kind === "diff_thread") {
    return itemIntentText(detail.kind, "diff", provider);
  }
  if (detail.kind === "file_event") {
    return itemIntentText(detail.kind, "timeline", provider);
  }
  if (detail.kind === "command_event") {
    return itemIntentText(detail.kind, "timeline", provider);
  }
  if (detail.kind === "ambient_suggestions") {
    return itemIntentText(detail.kind, "timeline", provider);
  }
  if (TIMELINE_MESSAGE_KINDS.has(detail.kind)) {
    return itemIntentText(detail.kind, "timeline", provider);
  }
  if (detail.readOnly) {
    return L("intent.completed");
  }
  return itemIntentText(detail.kind, "pending", provider);
}

function renderDetailTitle(detail) {
  const title = escapeHtml(detailDisplayTitle(detail));
  if ((detail.kind === "moltbook_reply" || detail.kind === "moltbook_draft") && detail.postUrl) {
    return `<a href="${escapeHtml(detail.postUrl)}" target="_blank" rel="noopener" class="detail-title__link">${title}</a>`;
  }
  return title;
}

function detailDisplayTitle(detail) {
  const threadLabel = sanitizeThreadLabelForDisplay(detail?.threadLabel || "", detail?.threadId || "");
  if (detail?.kind === "ambient_suggestions") {
    const ambientTitle = sanitizeThreadLabelForDisplay(detail?.title || "", detail?.threadId || "");
    return ambientTitle || L("common.ambientSuggestions");
  }
  if (threadLabel) {
    return threadLabel;
  }
  const title = normalizeClientText(detail?.title || "");
  if (!title) {
    return L("common.untitledItem");
  }
  const [prefix, ...rest] = title.split(" | ");
  const knownPrefixes = new Set([
    L("common.approval"),
    L("common.plan"),
    L("common.choice"),
    L("common.completion"),
    L("common.userMessage"),
    L("common.assistantCommentary"),
    L("common.assistantFinal"),
    "Approval",
    "Plan",
    "Choice",
    "Completed",
    "User message",
    "Commentary",
    "Final answer",
    "完了",
    "承認",
    "プラン",
    "選択",
    "メッセージ",
    "途中経過",
    "最終回答",
  ]);
  if (rest.length > 0 && knownPrefixes.has(prefix)) {
    return rest.join(" | ");
  }
  return title;
}

function fallbackSummaryForKind(kind, status, provider) {
  const vars = { provider: providerDisplayName(provider) };
  if (status === "completed") {
    return L("summary.completed");
  }
  switch (kind) {
    case "diff_thread":
      return L("summary.diffThread");
    case "file_event":
      return L("summary.fileEvent", vars);
    case "command_event":
      return L("summary.commandEvent", vars);
    case "ambient_suggestions":
      return L("summary.ambientSuggestions", { count: 0, firstTitle: "", more: 0 });
    case "user_message":
      return L("summary.userMessage");
    case "assistant_commentary":
      return L("summary.assistantCommentary", vars);
    case "assistant_final":
      return L("summary.assistantFinal", vars);
    case "approval":
      return L("summary.approval", vars);
    case "plan":
    case "plan_ready":
      return L("summary.plan", vars);
    case "choice":
      return L("summary.choice", vars);
    default:
      return L("summary.default");
  }
}

function actionClassForTone(tone) {
  if (tone === "danger" || tone === "warn" || tone === "reject") {
    return "danger danger--wide";
  }
  if (tone === "primary" || tone === "ok" || tone === "approve") {
    return "primary primary--wide";
  }
  return "secondary secondary--wide";
}

function shouldShowInstallBanner() {
  if (state.installBannerDismissed || isStandaloneMode()) {
    return false;
  }
  return !isDesktopLayout();
}

function shouldShowPushBanner() {
  if (!state.session?.authenticated || state.currentTab === "settings") {
    return false;
  }
  const push = state.pushStatus || {};
  if (!push.enabled || !push.standalone || push.serverSubscribed || state.pushBannerDismissed) {
    return false;
  }
  return true;
}

function installBannerCopy() {
  if (isProbablySafari()) {
    return L("banner.install.copy.safari");
  }
  return L("banner.install.copy.other");
}

function installGuideIntro() {
  if (isProbablySafari()) {
    return L("install.guide.intro.safari");
  }
  return L("install.guide.intro.other");
}

function installGuideSteps() {
  const steps = [];
  if (!isProbablySafari()) {
    steps.push(L("install.guide.step.openSafari"));
  }
  steps.push(L("install.guide.step.tapShare"));
  steps.push(L("install.guide.step.chooseAdd"));
  steps.push(L("install.guide.step.tapAdd"));
  return steps;
}

function pushBannerCopy() {
  const push = state.pushStatus || {};
  if (!push.secureContext) {
    return L("banner.push.copy.https");
  }
  if (!push.standalone) {
    return L("banner.push.copy.standalone");
  }
  if (push.notificationPermission === "denied") {
    return L("banner.push.copy.denied");
  }
  return L("banner.push.copy.default");
}

function canEnableNotificationsFromCurrentContext() {
  const push = state.pushStatus || {};
  return (
    push.enabled === true &&
    push.supportsPush === true &&
    push.secureContext === true &&
    push.standalone === true &&
    push.notificationPermission !== "denied" &&
    push.serverSubscribed !== true
  );
}

function readInstallBannerDismissed() {
  try {
    return window.localStorage.getItem(INSTALL_BANNER_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeInstallBannerDismissed(value) {
  try {
    if (value) {
      window.localStorage.setItem(INSTALL_BANNER_DISMISS_KEY, "1");
    } else {
      window.localStorage.removeItem(INSTALL_BANNER_DISMISS_KEY);
    }
  } catch {
    // Ignore storage errors on private browsing or restricted environments.
  }
}

function readPushBannerDismissed() {
  try {
    return window.localStorage.getItem(PUSH_BANNER_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writePushBannerDismissed(value) {
  try {
    if (value) {
      window.localStorage.setItem(PUSH_BANNER_DISMISS_KEY, "1");
    } else {
      window.localStorage.removeItem(PUSH_BANNER_DISMISS_KEY);
    }
  } catch {
    // Ignore storage errors on private browsing or restricted environments.
  }
}

function isProbablySafari() {
  const userAgent = navigator.userAgent || "";
  return /Safari/iu.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/iu.test(userAgent);
}

function isDesktopLayout() {
  return window.innerWidth >= DESKTOP_BREAKPOINT;
}

function toItemRef(item) {
  return {
    kind: item.kind,
    token: item.token,
  };
}

function isSameItemRef(left, right) {
  return left?.kind === right?.kind && left?.token === right?.token;
}

function isFastPathItemRef(itemRef) {
  return itemRef?.kind === "approval" || itemRef?.kind === "choice";
}

function hasLaunchItemIntent(itemRef = state.currentItem) {
  return Boolean(state.launchItemIntent && isSameItemRef(state.launchItemIntent, itemRef));
}

function hasDetailOverride(itemRef = state.currentItem) {
  return Boolean(state.detailOverride && isSameItemRef(state.detailOverride, itemRef));
}

function isAlreadyHandledApprovalError(error) {
  return error?.errorKey === "approval-not-found" || error?.errorKey === "approval-already-handled";
}

async function recoverHandledApprovalDetail(itemRef) {
  try {
    await refreshAuthenticatedState();
    const detail = await hydrateDetailImages(
      await apiGet(`/api/items/${encodeURIComponent(itemRef.kind)}/${encodeURIComponent(itemRef.token)}`)
    );
    return detail?.kind === "approval" && detail.readOnly === true ? detail : null;
  } catch {
    return null;
  }
}

function shouldPreserveCurrentItem(itemRef = state.currentItem) {
  return Boolean(itemRef && (hasLaunchItemIntent(itemRef) || hasDetailOverride(itemRef)));
}

function clearLaunchItemIntent() {
  state.launchItemIntent = null;
}

function clearDetailOverride() {
  state.detailOverride = null;
}

function clearPinnedDetailState() {
  detailLoadSequence += 1;
  clearLaunchItemIntent();
  clearDetailOverride();
  state.currentDetail = null;
  state.currentDetailLoading = false;
  state.detailLoadingItem = null;
}

function renderIcon(name) {
  switch (name) {
    case "approval":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 18.5 6v5.4c0 4-2.7 7.6-6.5 9.1-3.8-1.5-6.5-5.1-6.5-9.1V6z"/><path d="m8.9 12 2.1 2.1 4.1-4.4"/></svg>`;
    case "plan":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7.5"/><path d="m12 12 3.6-2.2"/><path d="M12 4.5v1.7"/><path d="M19.5 12h-1.7"/><path d="M12 19.5v-1.7"/><path d="M4.5 12h1.7"/></svg>`;
    case "choice":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="5.5" width="15" height="13" rx="2.5"/><path d="m8.2 12 1.6 1.6 3-3.2"/><path d="M13.8 10.2h2.2"/><path d="M13.8 13.8h2.2"/></svg>`;
    case "completion-item":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="m8.7 12.1 2 2.1 4.7-4.9"/></svg>`;
    case "item":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4.5" width="14" height="15" rx="2.5"/><path d="M8.5 9h7"/><path d="M8.5 12h7"/><path d="M8.5 15h4.5"/></svg>`;
    case "file-event":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.8h5.9l4.3 4.3v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-12.3a2 2 0 0 1 2-2Z"/><path d="M13.9 3.8v4.3h4.3"/><path d="M9.2 13.1h5.6"/><path d="M9.2 16.2h4"/></svg>`;
    case "command":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4.2" y="5" width="15.6" height="14" rx="2.6"/><path d="m7.8 10 2.4 2-2.4 2"/><path d="M12.2 14h4"/></svg>`;
    case "diff":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 5.5v13"/><path d="M4.8 8.2 7.5 5.5 10.2 8.2"/><path d="M16.5 18.5v-13"/><path d="m13.8 15.8 2.7 2.7 2.7-2.7"/><path d="M11.8 7.5h1.2"/><path d="M11 12h2.8"/><path d="M11.8 16.5h1.2"/></svg>`;
    case "pending":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v5"/><path d="M12 16v5"/><path d="M4.8 6.8l3.5 3.5"/><path d="M15.7 15.7l3.5 3.5"/><path d="M3 12h5"/><path d="M16 12h5"/><path d="M4.8 17.2l3.5-3.5"/><path d="M15.7 8.3l3.5-3.5"/></svg>`;
    case "timeline":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H11l-3.5 3.1v-3.1H6.5a2 2 0 0 1-2-2z"/><path d="M8 8.8h8"/><path d="M8 11.8h5.5"/></svg>`;
    case "user-message":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5.2a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2Z"/><path d="M6.5 18.2a5.8 5.8 0 0 1 11 0"/></svg>`;
    case "assistant-commentary":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.2v5.6"/><path d="M9.2 9h5.6"/><path d="M6 14.8a6.7 6.7 0 0 0 12 0"/><path d="M8 4.8a7.6 7.6 0 0 1 8 0"/></svg>`;
    case "assistant-final":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6.5h12a1.8 1.8 0 0 1 1.8 1.8v6.1A1.8 1.8 0 0 1 18 16.2h-5.3L9 19.4v-3.2H6a1.8 1.8 0 0 1-1.8-1.8V8.3A1.8 1.8 0 0 1 6 6.5Z"/><path d="m9.2 11.3 1.7 1.7 3.6-3.8"/></svg>`;
    case "suggestions":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.8 13 6.7l3 .5-2.2 2.2.5 3-2.3-1.2-2.3 1.2.5-3L8 7.2l3-.5Z"/><path d="M6.2 14.6h11.6"/><path d="M8.4 18.2h7.2"/></svg>`;
    case "completed":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="m8.7 12.2 2.1 2.1 4.6-4.8"/></svg>`;
    case "settings":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 13.4 6a1 1 0 0 0 .82.5l2.84.28 1.16 2.02-1.8 2.22a1 1 0 0 0-.2.95l.62 2.78-2.04 1.18-2.58-1.1a1 1 0 0 0-.78 0l-2.58 1.1-2.04-1.18.62-2.78a1 1 0 0 0-.2-.95L5.78 8.8l1.16-2.02 2.84-.28a1 1 0 0 0 .82-.5L12 3.5Z"/><circle cx="12" cy="12" r="2.7"/></svg>`;
    case "notifications":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5a4 4 0 0 0-4 4v2.1c0 .9-.28 1.79-.8 2.52L6 15.2h12l-1.2-2.08a4.9 4.9 0 0 1-.8-2.52V8.5a4 4 0 0 0-4-4Z"/><path d="M10.2 18a2 2 0 0 0 3.6 0"/></svg>`;
    case "homescreen":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.8" width="10" height="18.4" rx="2.6"/><path d="M10 6.8h4"/><path d="M10.7 17.2h2.6"/></svg>`;
    case "iphone":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect x="7.2" y="2.8" width="9.6" height="18.4" rx="2.4"/><path d="M10 6.7h4"/><circle cx="12" cy="17.6" r="0.7" fill="currentColor" stroke="none"/></svg>`;
    case "language":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5c3.8 0 7 3.8 7 8.5s-3.2 8.5-7 8.5-7-3.8-7-8.5 3.2-8.5 7-8.5Z"/><path d="M5.8 9h12.4"/><path d="M5.8 15h12.4"/><path d="M12 3.8c1.9 2 3 4.9 3 8.2s-1.1 6.2-3 8.2c-1.9-2-3-4.9-3-8.2s1.1-6.2 3-8.2Z"/></svg>`;
    case "agent-network":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.8" cy="7.2" r="2.7"/><circle cx="17.2" cy="7.2" r="2.7"/><circle cx="12" cy="17" r="3"/><path d="M9.2 8.8 11 14.1"/><path d="m14.8 8.8-1.9 5.3"/><path d="M9.5 7.2h5"/></svg>`;
    case "remote-connection":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="12" width="14" height="7" rx="2"/><path d="M9 19h6"/><path d="M12 12v7"/><path d="M8.2 8.8a5.4 5.4 0 0 1 7.6 0"/><path d="M10.2 6.3a8.2 8.2 0 0 1 3.6 0"/><path d="M11.2 9.8a1.2 1.2 0 0 1 1.6 0"/></svg>`;
    case "link":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10.4 13.6 8.3 15.7a3 3 0 0 1-4.2-4.2l2.8-2.8a3 3 0 0 1 4.2 0"/><path d="m13.6 10.4 2.1-2.1a3 3 0 1 1 4.2 4.2l-2.8 2.8a3 3 0 0 1-4.2 0"/><path d="m9.5 14.5 5-5"/></svg>`;
    case "external-link":
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6H6.8A2.8 2.8 0 0 0 4 8.8v8.4A2.8 2.8 0 0 0 6.8 20h8.4a2.8 2.8 0 0 0 2.8-2.8V14"/><path d="M14 4h6v6"/><path d="m12.5 11.5 7-7"/></svg>`;
    case "clip":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m9.5 12.5 5.9-5.9a3 3 0 1 1 4.2 4.2l-7.7 7.7a5 5 0 1 1-7.1-7.1l8.1-8.1"/></svg>`;
    case "moltbook-draft":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15.2 3.8 20.2 8.8 8.5 20.5 3.5 20.5 3.5 15.5Z"/><path d="M12.5 6.5l5 5"/></svg>`;
    case "moltbook-reply":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4 4 9l5 5"/><path d="M4 9h11a4 4 0 0 1 4 4v3"/></svg>`;
    case "moltbook-comment":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 5.5h15a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H11l-4 3.5v-3.5H4.5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z"/><path d="M8 10h8"/><path d="M8 13h5"/></svg>`;
    case "filter":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14"/><path d="M8 12h8"/><path d="M10.5 17h3"/></svg>`;
    case "check":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6.8 12.5 3.2 3.2 7.2-7.4"/></svg>`;
    case "copy":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3.5" width="11" height="14" rx="2"/><path d="M6.5 7.5H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-.5"/></svg>`;
    case "lock":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>`;
    case "coin":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v10"/><path d="M14.5 9.3c-.6-.8-1.5-1.3-2.5-1.3-1.4 0-2.5 1-2.5 2.2 0 1.3 1.1 2 2.5 2s2.5.7 2.5 2c0 1.2-1.1 2.2-2.5 2.2-1 0-1.9-.5-2.5-1.3"/></svg>`;
    case "back":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`;
    case "chevron-down":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
    case "chevron-right":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`;
    default:
      return "";
  }
}

function renderCurrentSurface() {
  if (!state.session?.authenticated) {
    renderPair();
    return;
  }
  renderShell().catch((error) => {
    const message = error.message || String(error);
    app.innerHTML = `
      <main class="onboarding-shell">
        <section class="onboarding-card">
          <span class="eyebrow-pill">${escapeHtml(L("common.codex"))}</span>
          <h1 class="hero-title">${escapeHtml(L("common.appName"))}</h1>
          <p class="hero-copy">${escapeHtml(message)}</p>
        </section>
      </main>
    `;
  });
}

async function enableNotifications() {
  if (!state.session?.webPushEnabled) {
    throw new Error(L("error.webPushDisabled"));
  }
  if (!window.isSecureContext) {
    throw new Error(L("error.notificationsRequireHttps"));
  }
  if (!supportsPush()) {
    throw new Error(L("error.pushUnsupported"));
  }
  if (!isStandaloneMode()) {
    throw new Error(L("error.openHomeScreen"));
  }

  const registration = await ensureServiceWorkerReady();
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(L("error.notificationPermission", { status: permission }));
  }

  const status = await apiGet("/api/push/status");
  if (!status.enabled || !status.vapidPublicKey) {
    throw new Error(L("error.pushServerNotReady"));
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(status.vapidPublicKey),
  });

  await apiPost("/api/push/subscribe", {
    subscription: subscription.toJSON(),
    userAgent: navigator.userAgent,
    standalone: isStandaloneMode(),
  });
}

async function disableNotifications() {
  const registration = await ensureServiceWorkerReady();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await subscription.unsubscribe().catch(() => {});
    await apiPost("/api/push/unsubscribe", { endpoint: subscription.endpoint });
    return;
  }
  await apiPost("/api/push/unsubscribe", {});
}

async function ensureServiceWorkerReady() {
  if (state.serviceWorkerRegistration) {
    return state.serviceWorkerRegistration;
  }
  if (!("serviceWorker" in navigator)) {
    throw new Error(L("error.serviceWorkerUnavailable"));
  }
  state.serviceWorkerRegistration = await navigator.serviceWorker.ready;
  return state.serviceWorkerRegistration;
}

function supportsPush() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function isStandaloneMode() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
}

function handleServiceWorkerMessage(event) {
  const type = event?.data?.type || "";
  if (type === "pushsubscriptionchange") {
    refreshPushStatus().then(renderCurrentSurface).catch(() => {});
    return;
  }
  if (type === "open-target-url" && event?.data?.url) {
    applyExternalTargetUrl(event.data.url).catch(() => {});
  }
}

function handlePotentialExternalNavigation() {
  consumePendingNotificationIntent()
    .then((consumed) => {
      if (consumed) {
        return;
      }
      return applyExternalTargetUrl(window.location.href, { allowRefresh: false });
    })
    .catch(() => {});
}

function handleDocumentVisibilityChange() {
  if (document.visibilityState !== "visible") {
    return;
  }
  handlePotentialExternalNavigation();
}

async function hydrateTimelinePayloadImages(payload) {
  if (!payload || !Array.isArray(payload.entries)) {
    return payload;
  }

  const entries = await Promise.all(
    payload.entries.map(async (entry) => hydrateItemImageUrls(entry))
  );
  return { ...payload, entries };
}

async function hydrateDetailImages(detail) {
  if (!detail || !Array.isArray(detail.imageUrls)) {
    return detail;
  }
  return hydrateItemImageUrls(detail);
}

async function hydrateItemImageUrls(item) {
  const imageUrls = Array.isArray(item?.imageUrls) ? item.imageUrls.filter(Boolean) : [];
  if (imageUrls.length === 0) {
    return item;
  }

  const hydratedUrls = await Promise.all(imageUrls.map((url) => routedTimelineImageUrl(url)));
  return {
    ...item,
    imageUrls: hydratedUrls.filter(Boolean),
  };
}

async function routedTimelineImageUrl(imageUrl) {
  const sourceUrl = normalizeClientText(imageUrl);
  if (!sourceUrl || /^(?:blob:|data:)/iu.test(sourceUrl)) {
    return sourceUrl;
  }

  const existing = timelineImageObjectUrlCache.get(sourceUrl);
  if (existing?.objectUrl) {
    existing.lastUsedMs = Date.now();
    return existing.objectUrl;
  }

  try {
    const response = await routedFetch(sourceUrl, {
      credentials: "same-origin",
      headers: {
        Accept: "image/*",
      },
    });
    if (!response.ok) {
      return unavailableTimelineImageDataUrl();
    }
    const arrayBuffer = await response.arrayBuffer();
    const contentType = responseHeader(response.headers, "content-type") || "application/octet-stream";
    const objectUrl = URL.createObjectURL(new Blob([arrayBuffer], { type: contentType }));
    timelineImageObjectUrlCache.set(sourceUrl, {
      objectUrl,
      lastUsedMs: Date.now(),
    });
    pruneTimelineImageObjectUrlCache();
    return objectUrl;
  } catch {
    return unavailableTimelineImageDataUrl();
  }
}

function unavailableTimelineImageDataUrl() {
  const title = L("detail.imageUnavailable");
  const subtitle = L("detail.imageUnavailableHint");
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#132026"/>
          <stop offset="1" stop-color="#0a1116"/>
        </linearGradient>
      </defs>
      <rect width="640" height="640" rx="34" fill="url(#bg)"/>
      <rect x="24" y="24" width="592" height="592" rx="28" fill="none" stroke="#9cb5c5" stroke-opacity=".18" stroke-width="2"/>
      <circle cx="320" cy="266" r="50" fill="#26343d"/>
      <path d="M294 266h52M320 240v52" stroke="#d7e5ed" stroke-width="12" stroke-linecap="round" opacity=".78"/>
      <text x="320" y="360" text-anchor="middle" fill="#d7e5ed" font-family="Avenir Next, Helvetica, Arial, sans-serif" font-size="31" font-weight="700">${escapeSvgText(title)}</text>
      <text x="320" y="410" text-anchor="middle" fill="#9cb5c5" font-family="Avenir Next, Helvetica, Arial, sans-serif" font-size="22">${escapeSvgText(subtitle)}</text>
    </svg>
  `.trim();
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function escapeSvgText(value) {
  return normalizeClientText(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function responseHeader(headers, name) {
  const key = String(name || "").toLowerCase();
  if (!headers || !key) {
    return "";
  }
  if (typeof headers.get === "function") {
    return headers.get(key) || "";
  }
  return headers[key] || headers[name] || "";
}

function pruneTimelineImageObjectUrlCache() {
  if (timelineImageObjectUrlCache.size <= MAX_TIMELINE_IMAGE_OBJECT_URLS) {
    return;
  }
  const staleEntries = [...timelineImageObjectUrlCache.entries()]
    .sort((left, right) => Number(left[1]?.lastUsedMs || 0) - Number(right[1]?.lastUsedMs || 0))
    .slice(0, Math.max(0, timelineImageObjectUrlCache.size - MAX_TIMELINE_IMAGE_OBJECT_URLS));
  for (const [sourceUrl, entry] of staleEntries) {
    if (entry?.objectUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(entry.objectUrl);
    }
    timelineImageObjectUrlCache.delete(sourceUrl);
  }
}

function withRequestTimeout(init, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 0;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof AbortController === "undefined") {
    return { init, cleanup: () => {} };
  }
  if (init.signal?.aborted) {
    return { init, cleanup: () => {} };
  }
  const controller = new AbortController();
  let timer = null;
  const externalAbortHandler = init.signal
    ? () => controller.abort(init.signal.reason)
    : null;
  if (init.signal && externalAbortHandler) {
    init.signal.addEventListener("abort", externalAbortHandler, { once: true });
  }
  timer = setTimeout(() => {
    const error = new Error("request-timeout");
    error.name = "AbortError";
    controller.abort(error);
  }, timeoutMs);
  return {
    init: { ...init, signal: controller.signal },
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (init.signal && externalAbortHandler) {
        init.signal.removeEventListener("abort", externalAbortHandler);
      }
    },
  };
}

function normalizeRequestError(error, opts = {}) {
  if (error?.name === "AbortError" && Number(opts.timeoutMs) > 0) {
    const timeoutError = new Error(L("error.requestTimedOut"));
    timeoutError.code = 0;
    timeoutError.status = 0;
    timeoutError.errorKey = "request-timeout";
    return timeoutError;
  }
  return error;
}

async function apiGet(url, opts = {}) {
  // routedFetch tries LAN first, then falls back to the relay tunnel when
  // the phone is off-LAN. Returns a fetch-Response-compatible object so the
  // rest of this function is identical to a plain `fetch()` call.
  const timed = withRequestTimeout({
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
    },
  }, opts);
  try {
    const response = await routedFetch(url, timed.init, opts);
    if (!response.ok) {
      const errorInfo = await readError(response);
      const error = new Error(errorInfo.message);
      error.code = response.status;
      error.status = response.status;
      error.errorKey = errorInfo.errorKey || "";
      throw error;
    }
    return await response.json();
  } catch (error) {
    throw normalizeRequestError(error, opts);
  } finally {
    timed.cleanup();
  }
}

async function apiGetDirectLan(url, opts = {}) {
  const timed = withRequestTimeout({
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
    },
  }, opts);
  try {
    const response = await fetch(url, timed.init);
    if (!response.ok) {
      const errorInfo = await readError(response);
      const error = new Error(errorInfo.message);
      error.code = response.status;
      error.status = response.status;
      error.errorKey = errorInfo.errorKey || "";
      throw error;
    }
    return await response.json();
  } catch (error) {
    throw normalizeRequestError(error, opts);
  } finally {
    timed.cleanup();
  }
}

async function apiPost(url, body, opts = {}) {
  const isFormDataBody = typeof FormData !== "undefined" && body instanceof FormData;
  // Keep native FormData for LAN; routedFetch serializes it to multipart
  // bytes only when the request has to travel through the remote relay.
  const timed = withRequestTimeout({
    method: "POST",
    credentials: "same-origin",
    headers: isFormDataBody
      ? {
          Accept: "application/json",
        }
      : {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
    body: isFormDataBody ? body : JSON.stringify(body || {}),
  }, opts);
  try {
    const response = await routedFetch(url, timed.init, opts);
    if (!response.ok) {
      const errorInfo = await readError(response);
      const error = new Error(errorInfo.message);
      error.code = response.status;
      error.status = response.status;
      error.errorKey = errorInfo.errorKey || "";
      error.payload = errorInfo.payload ?? null;
      throw error;
    }
    return await response.json();
  } catch (error) {
    throw normalizeRequestError(error, opts);
  } finally {
    timed.cleanup();
  }
}

async function readError(response) {
  try {
    const payload = await response.json();
    const errorKey = typeof payload.error === "string" ? payload.error : "";
    const message = localizeApiError(errorKey || payload.message || response.statusText);
    return { message, errorKey, payload };
  } catch {
    return { message: localizeApiError(response.statusText), errorKey: "", payload: null };
  }
}

function localizeApiError(value) {
  const raw = normalizeClientText(value);
  if (!raw) {
    return "";
  }
  const map = {
    "pairing-unavailable": "error.pairingUnavailable",
    "invalid-pairing-credentials": "error.invalidPairingCredentials",
    "pairing-rate-limited": "error.pairingRateLimited",
    "authentication-required": "error.authenticationRequired",
    "origin-not-allowed": "error.originNotAllowed",
    "device-not-found": "error.deviceNotFound",
    "web-push-disabled": "error.webPushDisabled",
    "push-subscription-expired": "error.pushSubscriptionExpired",
    "request-timeout": "error.requestTimedOut",
    "item-not-found": "error.itemNotFound",
    "completion-reply-unavailable": "error.completionReplyUnavailable",
    "completion-reply-thread-advanced": "error.completionReplyThreadAdvanced",
    "completion-reply-empty": "error.completionReplyEmpty",
    "completion-reply-image-invalid-type": "error.completionReplyImageInvalidType",
    "completion-reply-image-too-large": "error.completionReplyImageTooLarge",
    "completion-reply-image-limit": "error.completionReplyImageLimit",
    "completion-reply-image-invalid-upload": "error.completionReplyImageInvalidUpload",
    "codex-ipc-not-connected": "error.codexIpcNotConnected",
    "approval-not-found": "error.approvalNotFound",
    "approval-already-handled": "error.approvalAlreadyHandled",
    "plan-request-not-found": "error.planRequestNotFound",
    "plan-request-already-handled": "error.planRequestAlreadyHandled",
    "choice-input-not-found": "error.choiceInputNotFound",
    "choice-input-read-only": "error.choiceInputReadOnly",
    "choice-input-already-handled": "error.choiceInputAlreadyHandled",
    "mkcert-root-ca-not-found": "error.mkcertRootCaNotFound",
    "hazbase-auth-required": "error.hazbaseAuthRequired",
    "hazbase-session-expired": "error.hazbaseSessionExpired",
    "hazbase-passkey-local-host-required": "error.hazbasePasskeyLocalHostRequired",
    "hazbase-wallet-account-missing": "error.hazbaseWalletAccountMissing",
    "unsupported-chain": "error.unsupportedChain",
  };
  const key = map[raw];
  return key ? L(key) : raw;
}

function normalizeClientText(value) {
  return String(value ?? "").trim();
}

function normalizeClientFileRefs(fileRefs) {
  if (!Array.isArray(fileRefs)) {
    return [];
  }
  const deduped = [];
  const seen = new Set();
  for (const fileRef of fileRefs) {
    const normalized = normalizeClientText(fileRef);
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

function normalizeClientAmbientSuggestions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const title = normalizeClientText(entry?.title);
      const prompt = normalizeClientText(entry?.prompt);
      if (!title || !prompt) {
        return null;
      }
      return {
        id: normalizeClientText(entry?.id),
        title,
        prompt,
        description: normalizeClientText(entry?.description),
      };
    })
    .filter(Boolean);
}

function ambientSuggestionCopyKey(token, suggestionId, index) {
  return [normalizeClientText(token), normalizeClientText(suggestionId), String(Math.max(0, Number(index) || 0))].join(":");
}

async function copyTextToClipboard(text) {
  const normalized = String(text ?? "");
  if (!normalized) {
    throw new Error("empty");
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(normalized);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = normalized;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error("copy-failed");
  }
}

function fileRefLabel(fileRef) {
  const normalized = normalizeClientText(fileRef);
  if (!normalized) {
    return "";
  }
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] || normalized;
}

function parseItemRef(value) {
  const [kind, token] = String(value || "").split(":");
  return kind && token ? { kind, token } : null;
}

function sanitizeExternalTargetTab(value) {
  const normalized = normalizeClientText(value || "");
  return EXTERNAL_TARGET_TABS.has(normalized) ? normalized : "";
}

function sanitizeExternalTargetInboxSubtab(value) {
  const normalized = normalizeClientText(value || "");
  return EXTERNAL_TARGET_INBOX_SUBTABS.has(normalized) ? normalized : "";
}

async function applyExternalTargetUrl(urlString, { allowRefresh = true } = {}) {
  if (!state.session?.authenticated) {
    return;
  }

  let nextUrl;
  try {
    nextUrl = new URL(urlString, window.location.origin);
  } catch {
    return;
  }

  const itemRef = parseItemRef(nextUrl.searchParams.get("item"));
  if (!itemRef) {
    return;
  }
  const explicitTargetTab = sanitizeExternalTargetTab(nextUrl.searchParams.get("tab"));
  const explicitTargetSubtab = sanitizeExternalTargetInboxSubtab(nextUrl.searchParams.get("subtab"));
  const targetTab = explicitTargetTab || tabForItemKind(itemRef.kind, state.currentTab);
  const targetSubtab = targetTab === "inbox" ? inboxSubtabForItemKind(itemRef.kind, explicitTargetSubtab) : "";

  const sameItem =
    Boolean(state.currentItem) &&
    isSameItemRef(state.currentItem, itemRef) &&
    state.currentTab === targetTab &&
    (targetTab !== "inbox" || state.inboxSubtab === targetSubtab) &&
    (isDesktopLayout() || state.detailOpen);
  if (sameItem) {
    if (allowRefresh) {
      await refreshAuthenticatedState();
      ensureCurrentSelection();
      await renderShell();
    }
    return;
  }

  openItem({
    kind: itemRef.kind,
    token: itemRef.token,
    sourceTab: targetTab,
    sourceSubtab: targetSubtab,
  });
  if (isFastPathItemRef(itemRef)) {
    state.launchItemIntent = {
      ...itemRef,
      status: "pending",
    };
  }
  await renderShell();

  if (!allowRefresh) {
    return;
  }
  await refreshAuthenticatedState();
  ensureCurrentSelection();
  await renderShell();
}

async function consumePendingNotificationIntent() {
  if (!state.session?.authenticated || typeof caches === "undefined") {
    return false;
  }
  let cache;
  try {
    cache = await caches.open(NOTIFICATION_INTENT_CACHE);
  } catch {
    return false;
  }

  const request = new Request(NOTIFICATION_INTENT_PATH);
  const match = await cache.match(request).catch(() => null);
  if (!match) {
    return false;
  }

  let payload = null;
  try {
    payload = await match.json();
  } catch {
    payload = null;
  }
  await cache.delete(request).catch(() => {});

  const url = normalizeClientText(payload?.url || "");
  if (!url) {
    return false;
  }
  await applyExternalTargetUrl(url, { allowRefresh: true });
  return true;
}

function buildAppUrl(nextParams) {
  const query = nextParams.toString();
  return `/app${query ? `?${query}` : ""}`;
}

function syncCurrentItemUrl(itemRef) {
  const nextParams = new URLSearchParams(window.location.search);
  if (itemRef?.kind && itemRef?.token) {
    nextParams.set("item", `${itemRef.kind}:${itemRef.token}`);
  } else {
    nextParams.delete("item");
  }
  const nextUrl = buildAppUrl(nextParams);
  if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
    history.replaceState({}, "", nextUrl);
  }
}

function updateManifestHref(pairToken) {
  const manifestLink = document.querySelector('link[rel="manifest"]');
  if (!manifestLink) {
    return;
  }
  const token = String(pairToken || "");
  const href = token
    ? `/manifest.webmanifest?pairToken=${encodeURIComponent(token)}`
    : "/manifest.webmanifest";
  if (manifestLink.getAttribute("href") === href) {
    return;
  }
  manifestLink.setAttribute("href", href);
}

function syncPairingTokenState(pairToken) {
  const token = String(pairToken || "");
  updateManifestHref(token);

  const nextParams = new URLSearchParams(window.location.search);
  if (token) {
    nextParams.set("pairToken", token);
  } else {
    nextParams.delete("pairToken");
  }
  const nextUrl = buildAppUrl(nextParams);
  if (`${window.location.pathname}${window.location.search}` === nextUrl) {
    return;
  }
  history.replaceState({}, "", nextUrl);
}

function desiredBootstrapPairingToken() {
  if (state.session?.authenticated && !state.session?.temporaryPairing) {
    return "";
  }
  return initialPairToken;
}

function shouldAutoPairFromBootstrapToken() {
  if (!initialPairToken) {
    return false;
  }
  return true;
}

function shouldUseTemporaryBootstrapPairing() {
  return Boolean(initialPairToken) && !isStandaloneMode() && isProbablySafari();
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const normalized = `${base64String}${padding}`.replace(/-/gu, "+").replace(/_/gu, "/");
  const rawData = window.atob(normalized);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
