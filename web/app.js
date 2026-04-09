import { DEFAULT_LOCALE, SUPPORTED_LOCALES, localeDisplayName, normalizeLocale, resolveLocalePreference, t } from "./i18n.js";

const DESKTOP_BREAKPOINT = 980;
const INSTALL_BANNER_DISMISS_KEY = "viveworker-install-banner-dismissed-v2";
const PUSH_BANNER_DISMISS_KEY = "viveworker-push-banner-dismissed-v1";
const INITIAL_DETECTED_LOCALE = detectBrowserLocale();
const TIMELINE_MESSAGE_KINDS = new Set(["user_message", "assistant_commentary", "assistant_final"]);
const TIMELINE_OPERATIONAL_KINDS = new Set(["approval", "plan", "plan_ready", "choice", "completion"]);
const THREAD_FILTER_INTERACTION_DEFER_MS = 8000;
const MAX_COMPLETION_REPLY_IMAGE_COUNT = 4;
const NOTIFICATION_INTENT_CACHE = "viveworker-notification-intent-v1";
const NOTIFICATION_INTENT_PATH = "/__viveworker_notification_intent__";

const state = {
  session: null,
  inbox: null,
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
  diffThreadExpandedFiles: {},
  detailDiffExpanded: {},
  choiceLocalDrafts: {},
  completionReplyDrafts: {},
  pendingActionUrls: new Set(),
  pairError: "",
  pairNotice: "",
  pushStatus: null,
  pushNotice: "",
  pushError: "",
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
};

let detailLoadSequence = 0;

const app = document.querySelector("#app");
const params = new URLSearchParams(window.location.search);
const initialItem = params.get("item") || "";
const initialPairToken = params.get("pairToken") || "";
const initialFocusPending = params.get("focusPending") || "";
let didReloadForServiceWorker = false;
let lastViewportMode = isDesktopLayout();

boot().catch((error) => {
  const message = error.message || String(error);
  const hint = /Load failed|Failed to fetch|NetworkError|fetch/i.test(message)
    ? `<p class="muted">${escapeHtml(L("error.networkHint"))}</p>`
    : "";
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

async function boot() {
  updateManifestHref(initialPairToken);
  await registerServiceWorker();
  navigator.serviceWorker?.addEventListener("message", handleServiceWorkerMessage);
  window.addEventListener("resize", handleViewportChange, { passive: true });
  window.addEventListener("focus", handlePotentialExternalNavigation, { passive: true });
  window.addEventListener("pageshow", handlePotentialExternalNavigation, { passive: true });
  document.addEventListener("visibilitychange", handleDocumentVisibilityChange);

  await refreshSession();

  if (!state.session?.authenticated && initialPairToken && shouldAutoPairFromBootstrapToken()) {
    try {
      await pair({
        token: initialPairToken,
        temporary: shouldUseTemporaryBootstrapPairing(),
      });
    } catch (error) {
      state.pairError = error.message || String(error);
    }
    await refreshSession();
  }

  syncPairingTokenState(desiredBootstrapPairingToken());

  const parsedInitialItem = parseItemRef(initialItem);
  if (parsedInitialItem) {
    state.currentItem = parsedInitialItem;
    state.currentTab = tabForItemKind(parsedInitialItem.kind, state.currentTab);
    if (state.currentTab === "inbox") {
      state.inboxSubtab = inboxSubtabForItemKind(parsedInitialItem.kind);
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

  await consumePendingNotificationIntent();
  await syncDetectedLocalePreference();
  await refreshAuthenticatedState();
  // `?focusPending=claude` marks this tab as the Claude-hook-opened popup:
  // auto-navigate to the newest unresolved Claude pending (plan/question)
  // detail view — but only when the user is not already in the middle of
  // answering another pending item. Handled by `maybeAutoFocusClaudePending`
  // both on boot and on every polling refresh below.
  if (initialFocusPending === "claude" && !state.currentItem) {
    state.claudePopupMode = true;
  }
  maybeAutoFocusClaudePending();
  ensureCurrentSelection();
  await renderShell();

  setInterval(async () => {
    if (!state.session?.authenticated) {
      return;
    }
    const consumedNotificationIntent = await consumePendingNotificationIntent();
    if (consumedNotificationIntent) {
      return;
    }
    await refreshAuthenticatedState();
    maybeAutoFocusClaudePending();
    if (!shouldDeferRenderForActiveInteraction()) {
      await renderShell();
    }
  }, 3000);
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
  await refreshInbox();
  await refreshTimeline();
  await refreshDevices();
  await refreshPushStatus();
  ensureCurrentSelection();
}

async function refreshSession() {
  state.session = await apiGet("/api/session");
  syncPairingTokenState(desiredBootstrapPairingToken());
  applyResolvedLocale();
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

async function setLocaleOverride(nextLocale) {
  const result = await apiPost("/api/session/locale", {
    detectedLocale: state.detectedLocale,
    overrideLocale: nextLocale || null,
  });
  state.session = {
    ...state.session,
    ...result,
  };
  applyResolvedLocale();
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

async function refreshPushStatus() {
  const client = await getClientPushState();
  if (!state.session?.authenticated) {
    state.pushStatus = {
      ...client,
      enabled: false,
      subscribed: false,
      serverSubscribed: false,
      lastSuccessfulDeliveryAtMs: 0,
      vapidPublicKey: "",
    };
    return;
  }

  try {
    const server = await apiGet("/api/push/status");
    state.pushStatus = {
      ...server,
      ...client,
      serverSubscribed: Boolean(server.subscribed),
      subscribed: Boolean(server.subscribed || client.clientSubscribed),
    };
  } catch (error) {
    state.pushStatus = {
      ...client,
      enabled: false,
      subscribed: false,
      serverSubscribed: false,
      lastSuccessfulDeliveryAtMs: 0,
      vapidPublicKey: "",
      error: error.message || String(error),
    };
  }
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
  };
}

async function refreshInbox() {
  state.inbox = await apiGet("/api/inbox");
  syncDiffThreadFilter();
  syncCompletedThreadFilter();
  syncInboxSubtab();
}

async function refreshTimeline() {
  state.timeline = await apiGet("/api/timeline");
  syncTimelineThreadFilter();
  syncTimelineKindFilter();
}

async function refreshDevices() {
  if (!state.session?.authenticated) {
    state.devices = [];
    state.deviceError = "";
    return;
  }

  try {
    const payload = await apiGet("/api/devices");
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
    ...state.inbox.pending.map((item) => ({ item, status: "pending" })),
    ...(Array.isArray(state.inbox.diff) ? state.inbox.diff.map((item) => ({ item, status: "diff" })) : []),
    ...state.inbox.completed.map((item) => ({ item, status: "completed" })),
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
  return state.inbox.pending
    .filter((item) => entryMatchesProviderFilter(item))
    .map((item) => ({ item, status: "pending" }));
}

function normalizeProviderClient(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "claude") return "claude";
  if (normalized === "moltbook") return "moltbook";
  return "codex";
}

function providerDisplayName(provider) {
  const p = normalizeProviderClient(provider);
  if (p === "claude") return L("common.claude");
  if (p === "moltbook") return "Moltbook";
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
  const threads = Array.isArray(state.timeline?.threads) ? state.timeline.threads : [];
  if (!state.timelineThreadFilter || state.timelineThreadFilter === "all") {
    state.timelineThreadFilter = "all";
    return;
  }
  if (!threads.some((thread) => thread.id === state.timelineThreadFilter)) {
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
  return [
    { id: "all", label: L("timeline.kindFilter.all"), icon: "filter" },
    { id: "messages", label: L("timeline.kindFilter.messages"), icon: "timeline" },
    { id: "files", label: L("timeline.kindFilter.files"), icon: "file-event" },
    { id: "approvals", label: L("timeline.kindFilter.approvals"), icon: "approval" },
    { id: "plans", label: L("timeline.kindFilter.plans"), icon: "plan" },
    { id: "choices", label: L("timeline.kindFilter.choices"), icon: "choice" },
    { id: "completions", label: L("timeline.kindFilter.completions"), icon: "completion-item" },
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
    case "files":
      return kind === "file_event";
    case "approvals":
      return kind === "approval";
    case "plans":
      return kind === "plan" || kind === "plan_ready";
    case "choices":
      return kind === "choice";
    case "completions":
      return kind === "completion";
    default:
      return true;
  }
}

function completedThreads() {
  const items = Array.isArray(state.inbox?.completed) ? state.inbox.completed : [];
  if (!items.length) {
    return [];
  }
  const byThread = new Map();
  for (const item of items) {
    const threadId = normalizeClientText(item.threadId || "");
    if (!threadId) {
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
    if (!threadId) {
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
      await pair({ code: String(form.get("code") || "") });
      state.pairError = "";
      state.pairNotice = "";
      await refreshSession();
      await refreshAuthenticatedState();
      await renderShell();
    } catch (error) {
      state.pairError = error.message || String(error);
      renderPair();
    }
  });

  bindSharedUi(renderPair);
}

async function pair(payload) {
  const result = await apiPost("/api/session/pair", payload);
  if (result?.temporaryPairing !== true) {
    syncPairingTokenState("");
  }
  return result;
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
  state.session = null;
  state.inbox = null;
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

async function renderShell() {
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

  app.innerHTML = `
    <div class="${shellClassName}">
      ${desktop ? renderDesktopHeader(detail) : renderMobileTopBar(detail)}
      ${renderTopBanner()}
      <main class="app-main">
        ${desktop ? renderDesktopWorkspace(detail) : renderMobileWorkspace(detail)}
      </main>
      ${desktop || state.detailOpen || isSettingsSubpageOpen() ? "" : renderBottomTabs()}
      ${renderImageViewerModal()}
      ${renderInstallGuideModal()}
      ${renderLogoutConfirmModal()}
    </div>
  `;

  bindShellInteractions();
  applyPendingDetailScrollReset();
  applyPendingListScrollRestore();
  applyPendingSettingsSubpageScrollReset();
  applyPendingSettingsScrollRestore();
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

function currentViewportScrollY() {
  return window.scrollY || window.pageYOffset || document.documentElement?.scrollTop || 0;
}

function markThreadFilterInteraction() {
  state.threadFilterInteractionUntilMs = Date.now() + THREAD_FILTER_INTERACTION_DEFER_MS;
}

function clearThreadFilterInteraction() {
  state.threadFilterInteractionUntilMs = 0;
}

function shouldDeferRenderForActiveInteraction() {
  const activeElement = document.activeElement;
  if (
    activeElement instanceof HTMLTextAreaElement &&
    activeElement.matches("[data-completion-reply-textarea]") &&
    normalizeClientText(activeElement.dataset.replyToken) === normalizeClientText(state.currentItem?.token)
  ) {
    return true;
  }
  if (
    activeElement instanceof HTMLSelectElement &&
    activeElement.matches("[data-timeline-thread-select], [data-diff-thread-select], [data-completed-thread-select]")
  ) {
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
        <span class="eyebrow-pill eyebrow-pill--quiet">${escapeHtml(L("common.appName"))}</span>
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
      itemRef.kind === "completion" ||
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
  try {
    const detail = await apiGet(`/api/items/${encodeURIComponent(itemRef.kind)}/${encodeURIComponent(itemRef.token)}`);
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
    await refreshInbox();
    try {
      const detail = await apiGet(`/api/items/${encodeURIComponent(itemRef.kind)}/${encodeURIComponent(itemRef.token)}`);
      if (hasLaunchItemIntent(itemRef)) {
        state.launchItemIntent.status = "loaded";
      }
      return detail;
    } catch {
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
      return null;
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
  return /\/accept$/u.test(String(actionUrl || ""))
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
      <aside class="surface surface--list">
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
    <section class="screen-block">
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

function renderItemCard(entry, sourceTab, desktop) {
  if (entry.status === "completed" && entry.item.kind === "completion") {
    return renderCompletedCompletionCard(entry, sourceTab);
  }
  const kindInfo = kindMeta(entry.item.kind);
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
  const kindInfo = kindMeta(item.kind);
  const summaryText = item.summary || fallbackSummaryForKind(item.kind, entry.status, item.provider);
  const threadLabel = timelineEntryThreadLabel(item, true);
  const timestampLabel = formatTimelineTimestamp(item.createdAtMs);

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
          <span class="type-pill type-pill--completion">${escapeHtml(L("common.task"))}</span>
          ${renderProviderBadge(item.provider)}
        </div>
        <div class="item-card__header-right">
          ${timestampLabel ? `<span class="item-card__timestamp">${escapeHtml(timestampLabel)}</span>` : ""}
          <span class="item-card__chevron" aria-hidden="true">${renderIcon("chevron-right")}</span>
        </div>
      </div>
      <div class="item-card__content">
        ${threadLabel ? `<p class="item-card__thread">${escapeHtml(threadLabel)}</p>` : ""}
        <h3 class="item-card__title">${escapeHtml(summaryText || L("common.untitledItem"))}</h3>
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
  const bodyHtml = entries.length
    ? `<div class="${listClassName}">${entries.map((entry) => renderDiffEntry(entry)).join("")}</div>`
    : renderEmptyList("diff");

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

function renderTimelineThreadDropdown() {
  const threads = Array.isArray(state.timeline?.threads) ? state.timeline.threads : [];
  return renderThreadDropdown({
    inputId: "timeline-thread-select",
    dataAttribute: "data-timeline-thread-select",
    selectedThreadId: state.timelineThreadFilter,
    controlsHtml: renderTimelineKindFilterControls(),
    threads: threads.map((thread) => ({
      id: thread.id,
      label: dropdownThreadLabel(thread.id, thread.label || ""),
    })),
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
  const kindInfo = kindMeta(item.kind);
  const kindClassName = escapeHtml(kindInfo.tone || "neutral");
  const kindNameClass = escapeHtml(String(item.kind || "item").replace(/_/gu, "-"));
  const isMessageLike = TIMELINE_MESSAGE_KINDS.has(item.kind) || item.kind === "completion";
  const isFileEvent = item.kind === "file_event";
  const imageUrls = Array.isArray(item.imageUrls) ? item.imageUrls.filter(Boolean) : [];
  const fileRefs = normalizeClientFileRefs(item.fileRefs);
  const primaryText = timelineEntryPrimaryText(item, entry.status, { isMessageLike, isFileEvent });
  const secondaryText = timelineEntrySecondaryText(item, entry.status, primaryText, { isMessageLike, isFileEvent });
  const threadLabel = timelineEntryThreadLabel(item, isMessageLike);
  const timestampLabel = formatTimelineTimestamp(item.createdAtMs);
  const statusLabel = timelineEntryStatusLabel(item, isMessageLike);
  const fileEventFileSummary = isFileEvent ? timelineFileEventFileSummary(item) : "";
  const fileEventDiffStatsHtml = isFileEvent ? renderDiffEntryStatsHtml(item) : "";

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
  if (isMessageLike || item?.kind === "file_event") {
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

function timelineEntryPrimaryText(item, status, { isMessageLike = false, isFileEvent = false } = {}) {
  if (isMessageLike) {
    return item.summary || fallbackSummaryForKind(item.kind, status, item.provider);
  }

  if (isFileEvent) {
    return fileEventTimelineCountLabel(item) || fallbackSummaryForKind(item.kind, status, item.provider);
  }

  return timelineDisplayTitleWithoutThread(item, { allowFallbackSummary: true }) || L("common.untitledItem");
}

function timelineEntrySecondaryText(item, status, primaryText, { isMessageLike = false, isFileEvent = false } = {}) {
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
    "Approval",
    "Plan",
    "Choice",
    "Completed",
    "User message",
    "Commentary",
    "Final answer",
    "Files",
    "承認",
    "プラン",
    "選択",
    "完了",
    "メッセージ",
    "途中経過",
    "最終回答",
    "ファイル",
  ];
}

function fileEventDisplayLabel(fileEventType) {
  switch (normalizeClientText(fileEventType || "")) {
    case "read":
      return L("fileEvent.read");
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
    return "";
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
    subscribed: push.serverSubscribed === true,
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
      value: L(context.setupState.notifications.labelKey),
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
          value: L(context.setupState.install.labelKey),
        })
      : "",
    renderSettingsNavRow({
      page: "awayMode",
      icon: "settings",
      title: L("settings.awayMode.title"),
      value: state.session?.claudeAwayMode === true ? L("settings.claudeAway.on") : L("settings.claudeAway.off"),
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
  const { push, permission, secureContext, standalone, supportsPushValue, serverEnabled } = context;
  const statusRows = [
    renderSettingsInfoRow(L("settings.row.status"), L(context.setupState.notifications.labelKey)),
    renderSettingsInfoRow(L("settings.row.notificationPermission"), permission),
    renderSettingsInfoRow(L("settings.row.currentDeviceSubscribed"), push.serverSubscribed ? L("common.yes") : L("common.no")),
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
      ${renderSettingsGroup(L("settings.group.advanced"), [
        renderSettingsInfoRow(L("settings.row.serverWebPush"), serverEnabled ? L("common.yes") : L("common.no")),
        renderSettingsInfoRow(L("settings.row.secureContext"), secureContext ? L("common.yes") : L("common.no")),
        renderSettingsInfoRow(L("settings.row.homeScreenApp"), standalone ? L("common.yes") : L("common.no")),
        renderSettingsInfoRow(L("settings.row.browserSupport"), supportsPushValue ? L("common.yes") : L("common.no")),
      ])}
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
            <code class="settings-command-card__value">npx viveworker setup --pair</code>
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
  return `
    <div class="settings-page">
      ${context.diagnostics.map((message) => `<p class="inline-alert">${escapeHtml(message)}</p>`).join("")}
      ${renderSettingsGroup("", [
        renderSettingsInfoRow(L("settings.row.serverWebPush"), context.serverEnabled ? L("common.yes") : L("common.no")),
        renderSettingsInfoRow(L("settings.row.secureContext"), context.secureContext ? L("common.yes") : L("common.no")),
        renderSettingsInfoRow(L("settings.row.homeScreenApp"), context.standalone ? L("common.yes") : L("common.no")),
        renderSettingsInfoRow(L("settings.row.notificationPermission"), context.permission),
        renderSettingsInfoRow(L("settings.row.browserSupport"), context.supportsPushValue ? L("common.yes") : L("common.no")),
        renderSettingsInfoRow(L("settings.row.currentDeviceSubscribed"), context.push.serverSubscribed ? L("common.yes") : L("common.no")),
        context.push.lastSuccessfulDeliveryAtMs
          ? renderSettingsInfoRow(
              L("settings.row.lastSuccessfulDelivery"),
              new Date(context.push.lastSuccessfulDeliveryAtMs).toLocaleString(state.locale)
            )
          : "",
        renderSettingsInfoRow(L("settings.row.version"), state.appVersion || L("common.unavailable")),
      ].filter(Boolean), { listClassName: "settings-list settings-list--compact" })}
    </div>
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

function renderSettingsNavRow({ page, icon, title, subtitle, value }) {
  return `
    <button class="settings-nav-row" type="button" data-settings-subpage="${escapeHtml(page)}">
      <span class="settings-row__icon" aria-hidden="true">${renderIcon(icon)}</span>
      <span class="settings-row__body">
        <span class="settings-row__title">${escapeHtml(title)}</span>
        ${subtitle ? `<span class="settings-row__subtitle">${escapeHtml(subtitle)}</span>` : ""}
      </span>
      <span class="settings-row__value">${escapeHtml(value || "")}</span>
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
        <label class="reply-mode-switch" data-claude-away-toggle>
          <input type="checkbox" class="reply-mode-switch__input" ${enabled ? "checked" : ""} data-claude-away-checkbox />
          <span class="reply-mode-switch__track" aria-hidden="true"><span class="reply-mode-switch__thumb"></span></span>
          <span class="reply-mode-switch__copy">
            <span class="reply-mode-switch__title">
              <span>${escapeHtml(L("settings.claudeAway.title"))}</span>
              <span class="reply-mode-switch__state">${escapeHtml(stateLabel)}</span>
            </span>
            <span class="reply-mode-switch__hint">${escapeHtml(L("settings.claudeAway.description"))}</span>
          </span>
        </label>
      `])}
      <p class="settings-page-copy muted">${escapeHtml(L("settings.awayMode.codexNote"))}</p>
    </div>
  `;
}

function renderSettingsInfoRow(label, value, options = {}) {
  const rowClassName = ["settings-info-row", options.rowClassName || ""].filter(Boolean).join(" ");
  const valueClassName = ["settings-info-row__value", options.valueClassName || ""].filter(Boolean).join(" ");
  return `
    <div class="${rowClassName}">
      <span class="settings-info-row__label">${escapeHtml(label)}</span>
      <span class="${valueClassName}">${escapeHtml(value)}</span>
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
  const pushLabel = device.pushSubscribed ? L("common.yes") : L("common.no");
  const badge = device.currentDevice
    ? `<span class="device-card__badge">${escapeHtml(L("settings.device.thisDevice"))}</span>`
    : "";
  const actionLabel = device.currentDevice
    ? L("settings.action.removeThisDevice")
    : L("settings.action.revokeDevice");

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
      <div class="device-card__actions">
        <button
          class="secondary secondary--wide"
          type="button"
          data-device-revoke="${escapeHtml(device.deviceId)}"
          data-device-current="${device.currentDevice ? "true" : "false"}"
        >${escapeHtml(actionLabel)}</button>
      </div>
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
  const kindInfo = kindMeta(detail.kind);
  const spaciousBodyDetail = TIMELINE_MESSAGE_KINDS.has(detail.kind) || detail.kind === "completion";
  const plainIntro = renderDetailPlainIntro(detail);
  return `
    <div class="detail-shell">
      ${renderDetailMetaRow(detail, kindInfo)}
      <h2 class="detail-title detail-title--desktop">${escapeHtml(detailDisplayTitle(detail))}</h2>
      ${detail.readOnly || detail.kind === "approval" ? "" : renderDetailLead(detail, kindInfo)}
      ${renderPreviousContextCard(detail)}
      ${renderInterruptedDetailNotice(detail)}
      ${renderMoltbookReplyComposer(detail)}
      ${
        plainIntro
          ? plainIntro
          : `
            <section class="detail-card detail-card--body ${spaciousBodyDetail ? "detail-card--message-body" : ""}">
              <div class="detail-body ${spaciousBodyDetail ? "detail-body--message " : ""}markdown">${detail.messageHtml || ""}</div>
            </section>
          `
      }
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
  const kindInfo = kindMeta(detail.kind);
  const spaciousBodyDetail = TIMELINE_MESSAGE_KINDS.has(detail.kind) || detail.kind === "completion";
  const plainIntro = renderDetailPlainIntro(detail, { mobile: true });
  return `
    <div class="mobile-detail-screen">
      <div class="detail-shell detail-shell--mobile">
        <div class="mobile-detail-scroll mobile-detail-scroll--detail">
          ${renderDetailMetaRow(detail, kindInfo, { mobile: true })}
          ${renderPreviousContextCard(detail, { mobile: true })}
          ${renderInterruptedDetailNotice(detail, { mobile: true })}
          ${renderMoltbookReplyComposer(detail, { mobile: true })}
          ${
            plainIntro
              ? plainIntro
              : `
                <section class="detail-card detail-card--body detail-card--mobile ${spaciousBodyDetail ? "detail-card--message-body" : ""}">
                  ${detail.readOnly || detail.kind === "approval" ? "" : renderDetailLead(detail, kindInfo, { mobile: true })}
                  <div class="detail-body ${spaciousBodyDetail ? "detail-body--message " : ""}markdown">${detail.messageHtml || ""}</div>
                </section>
              `
          }
          ${renderClaudePlanSection(detail, { mobile: true })}
          ${renderClaudeQuestionSection(detail, { mobile: true })}
          ${renderDetailImageGallery(detail, { mobile: true })}
          ${renderDetailDiffPanel(detail, { mobile: true })}
          ${renderDetailDiffThreadGroups(detail, { mobile: true })}
          ${renderDetailFileRefs(detail, { mobile: true })}
          ${renderCompletionReplyComposer(detail, { mobile: true })}
        </div>
        ${detail.readOnly ? "" : renderActionButtons(detail.actions || [], { mobileSticky: true })}
      </div>
    </div>
  `;
}

function renderDetailPlainIntro(detail, options = {}) {
  if (!["approval", "diff_thread", "file_event"].includes(detail?.kind || "")) {
    return "";
  }
  if (detail?.kind === "approval" && normalizeClientText(detail?.approvalKind || "") !== "file") {
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
            <button type="submit" class="action-button action-button--primary" ${isSent || draft.sending ? "disabled" : ""}>
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
  // Reply drafting is delegated to the Codex/Claude Desktop CLI, so the
  // mobile UI is read-only. Surface the commenter's handle instead.
  const rawTitle = normalizeClientText(detail.title || "");
  const match = rawTitle.match(/^@([^\s]+)/u);
  const authorHandle = match ? match[1] : "";
  if (!authorHandle) return "";
  return `
    <section class="detail-card detail-card--reply ${options.mobile ? "detail-card--mobile" : ""}">
      <div class="reply-composer reply-composer--readonly">
        <div class="reply-composer__copy">
          <span class="eyebrow-pill eyebrow-pill--quiet">Moltbook</span>
          <p class="reply-composer__author">from <strong>@${escapeHtml(authorHandle)}</strong></p>
        </div>
      </div>
    </section>
  `;
}

function renderCompletionReplyComposer(detail, options = {}) {
  if (detail.kind !== "completion" || detail.reply?.enabled !== true) {
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
              <form class="reply-composer__form" data-completion-reply-form data-token="${escapeHtml(detail.token)}" data-provider="${escapeHtml(normalizeProviderClient(detail?.provider))}">
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

function renderTopBanner() {
  if (!isDesktopLayout() && (state.detailOpen || isSettingsSubpageOpen())) {
    return "";
  }
  if (shouldShowInstallBanner()) {
    return renderInstallBanner();
  }
  if (shouldShowPushBanner()) {
    return renderPushBanner();
  }
  return "";
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
        <div class="logout-option">
          <div class="logout-option__copy">
            <strong>${escapeHtml(L("logout.confirm.keepTrustedTitle"))}</strong>
            <p class="muted">${escapeHtml(L("logout.confirm.keepTrustedCopy"))}</p>
          </div>
          <button class="primary primary--wide" type="button" data-logout-mode="session">${escapeHtml(L("logout.action.keepTrusted"))}</button>
        </div>
        <div class="logout-option logout-option--danger">
          <div class="logout-option__copy">
            <strong>${escapeHtml(L("logout.confirm.removeTitle"))}</strong>
            <p class="muted">${escapeHtml(L("logout.confirm.removeCopy"))}</p>
          </div>
          <button class="secondary secondary--wide" type="button" data-logout-mode="revoke">${escapeHtml(L("logout.action.removeDevice"))}</button>
        </div>
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
    });
  }

  for (const button of document.querySelectorAll("[data-settings-subpage]")) {
    button.addEventListener("click", async () => {
      openSettingsSubpage(button.dataset.settingsSubpage || "");
      await renderShell();
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

  for (const button of document.querySelectorAll("[data-back-to-list]")) {
    button.addEventListener("click", async () => {
      clearChoiceLocalDraftForItem(state.currentItem);
      state.detailOpen = false;
      state.pendingListScrollRestore = !isDesktopLayout() && Boolean(state.listScrollState);
      clearPinnedDetailState();
      syncCurrentItemUrl(null);
      await renderShell();
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
        await apiPost(actionUrl, body);
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
        // Restore buttons on failure so the user can retry
        for (const sibling of siblingButtons) {
          if (originalLabels.has(sibling)) {
            sibling.innerHTML = originalLabels.get(sibling);
          }
          sibling.disabled = false;
          sibling.removeAttribute("aria-busy");
        }
        button.classList.remove("is-loading");
        throw error;
      }
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
      }
      await renderShell();
    });
  }

  for (const checkbox of document.querySelectorAll("[data-claude-away-checkbox]")) {
    checkbox.addEventListener("change", async () => {
      const next = checkbox.checked === true;
      try {
        const result = await apiPost("/api/settings/claude-away-mode", { enabled: next });
        if (state.session) {
          state.session.claudeAwayMode = result?.enabled === true;
        }
        await refreshAuthenticatedState();
      } catch (error) {
        state.pushError = error.message || String(error);
      }
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-locale-option]")) {
    button.addEventListener("click", async () => {
      state.pushError = "";
      state.pushNotice = "";
      try {
        await setLocaleOverride(button.dataset.localeOption || "");
        await refreshSession();
        await refreshAuthenticatedState();
      } catch (error) {
        state.pushError = error.message || String(error);
      }
      await renderShell();
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

  const moltbookForm = document.querySelector("[data-moltbook-reply-form]");
  if (moltbookForm) {
    const token = moltbookForm.dataset.token || "";
    let submittedAction = "send";
    moltbookForm.querySelectorAll("button[type='submit']").forEach((btn) => {
      btn.addEventListener("click", () => {
        submittedAction = btn.dataset.action || "send";
      });
    });
    moltbookForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = normalizeClientText(new FormData(moltbookForm).get("text"));
      try {
        const res = await fetch(`/api/items/moltbook/${encodeURIComponent(token)}/reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ action: submittedAction, text }),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          alert(`Moltbook reply failed: ${errBody.error || res.status}`);
          return;
        }
        await renderShell();
      } catch (error) {
        alert(`Moltbook reply error: ${error.message}`);
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
        const requestBody = new FormData();
        requestBody.set("text", text);
        requestBody.set("planMode", draft.mode === "plan" ? "true" : "false");
        requestBody.set("force", draft.confirmOverride === true ? "true" : "false");
        for (const attachment of draft.attachments || []) {
          if (attachment?.file) {
            requestBody.append("image", attachment.file, attachment.name || attachment.file.name);
          }
        }
        await apiPost(`/api/items/completion/${encodeURIComponent(token)}/reply`, requestBody);
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
        await refreshAuthenticatedState();
      } catch (error) {
        if (error.errorKey === "completion-reply-thread-advanced") {
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
  if (kind === "diff_thread") {
    return "diff";
  }
  if (kind === "file_event") {
    return "timeline";
  }
  if (TIMELINE_MESSAGE_KINDS.has(kind)) {
    return "timeline";
  }
  if (kind === "completion") {
    return "inbox";
  }
  if (fallback === "timeline") {
    return "timeline";
  }
  return kind === "approval" || kind === "plan" || kind === "choice"
    ? "inbox"
    : fallback || "inbox";
}

function inboxSubtabForItemKind(kind, sourceSubtab = "") {
  if (normalizeClientText(sourceSubtab || "") === "completed") {
    return "completed";
  }
  return kind === "completion" ? "completed" : "pending";
}

function kindMeta(kind) {
  switch (kind) {
    case "user_message":
      return { label: L("common.userMessage"), tone: "neutral", icon: "user-message" };
    case "assistant_commentary":
      return { label: L("common.assistantCommentary"), tone: "plan", icon: "assistant-commentary" };
    case "assistant_final":
      return { label: L("common.assistantFinal"), tone: "completion", icon: "assistant-final" };
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
  if (TIMELINE_MESSAGE_KINDS.has(detail.kind)) {
    return itemIntentText(detail.kind, "timeline", provider);
  }
  if (detail.readOnly) {
    return L("intent.completed");
  }
  return itemIntentText(detail.kind, "pending", provider);
}

function detailDisplayTitle(detail) {
  const threadLabel = normalizeClientText(detail?.threadLabel || "");
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
    case "link":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10.4 13.6 8.3 15.7a3 3 0 0 1-4.2-4.2l2.8-2.8a3 3 0 0 1 4.2 0"/><path d="m13.6 10.4 2.1-2.1a3 3 0 1 1 4.2 4.2l-2.8 2.8a3 3 0 0 1-4.2 0"/><path d="m9.5 14.5 5-5"/></svg>`;
    case "clip":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m9.5 12.5 5.9-5.9a3 3 0 1 1 4.2 4.2l-7.7 7.7a5 5 0 1 1-7.1-7.1l8.1-8.1"/></svg>`;
    case "filter":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14"/><path d="M8 12h8"/><path d="M10.5 17h3"/></svg>`;
    case "check":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6.8 12.5 3.2 3.2 7.2-7.4"/></svg>`;
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

async function apiGet(url) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const errorInfo = await readError(response);
    const error = new Error(errorInfo.message);
    error.code = response.status;
    error.status = response.status;
    error.errorKey = errorInfo.errorKey || "";
    throw error;
  }
  return response.json();
}

async function apiPost(url, body) {
  const isFormDataBody = typeof FormData !== "undefined" && body instanceof FormData;
  const response = await fetch(url, {
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
  });
  if (!response.ok) {
    const errorInfo = await readError(response);
    const error = new Error(errorInfo.message);
    error.code = response.status;
    error.status = response.status;
    error.errorKey = errorInfo.errorKey || "";
    error.payload = errorInfo.payload ?? null;
    throw error;
  }
  return response.json();
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

  const sameItem =
    Boolean(state.currentItem) &&
    isSameItemRef(state.currentItem, itemRef) &&
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
    sourceTab: tabForItemKind(itemRef.kind, state.currentTab),
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
