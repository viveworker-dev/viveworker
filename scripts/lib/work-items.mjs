const WORK_ITEM_SCHEMA_VERSION = 1;

const TERMINAL_STATES = new Set(["completed", "failed", "canceled"]);
const STATE_PRIORITY = new Map([
  ["in_progress", 1],
  ["needs_action", 2],
  ["completed", 3],
  ["failed", 3],
  ["canceled", 3],
]);

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeProvider(value) {
  const provider = cleanText(value).toLowerCase();
  if (["claude", "moltbook", "a2a", "viveworker", "mcp"].includes(provider)) {
    return provider;
  }
  return "codex";
}

function workItemCategory(item) {
  switch (cleanText(item?.kind)) {
    case "approval":
      return cleanText(item?.approvalKind).includes("payment") ? "payment" : "approval";
    case "plan":
    case "plan_ready":
      return "plan";
    case "choice":
      return "question";
    case "moltbook_draft":
      return "draft";
    case "moltbook_reply":
      return "reply";
    case "thread_share":
      return "handoff";
    case "a2a_task":
      return "delegation";
    case "a2a_task_result":
      return "delegation_result";
    case "activity_status":
      return "agent_run";
    case "completion":
    case "assistant_final":
      return "result";
    default:
      return "work";
  }
}

function terminalState(item) {
  const taskStatus = cleanText(item?.taskStatus).toLowerCase();
  if (["failed", "error"].includes(taskStatus)) {
    return "failed";
  }
  if (["canceled", "cancelled", "rejected"].includes(taskStatus)) {
    return "canceled";
  }
  return "completed";
}

function workItemPriority(item, state) {
  if (workItemCategory(item) === "payment") {
    return "urgent";
  }
  if (state === "needs_action") {
    return cleanText(item?.kind) === "thread_share" ? "normal" : "high";
  }
  return state === "in_progress" ? "normal" : "low";
}

function workItemId(item) {
  const provider = normalizeProvider(item?.provider);
  const kind = cleanText(item?.kind) || "item";
  const token = cleanText(item?.token);
  const fallback = [item?.threadId, item?.createdAtMs, item?.title]
    .map(cleanText)
    .filter(Boolean)
    .join(":");
  return `${provider}:${kind}:${token || fallback || "unknown"}`;
}

function workItemThreadKey(item) {
  const threadId = cleanText(item?.threadId);
  return threadId ? `${normalizeProvider(item?.provider)}:${threadId}` : "";
}

function enrichWorkItem(item, state) {
  const normalizedState = TERMINAL_STATES.has(state) ? state : cleanText(state) || "needs_action";
  const requiresAction = normalizedState === "needs_action" && item?.supported !== false;
  return {
    ...item,
    provider: normalizeProvider(item?.provider),
    work: {
      schemaVersion: WORK_ITEM_SCHEMA_VERSION,
      id: workItemId(item),
      state: normalizedState,
      category: workItemCategory(item),
      priority: workItemPriority(item, normalizedState),
      requiresAction,
      sourceRef: {
        provider: normalizeProvider(item?.provider),
        kind: cleanText(item?.kind),
        token: cleanText(item?.token),
        threadId: cleanText(item?.threadId),
      },
      occurredAtMs: Math.max(0, Number(item?.createdAtMs) || 0),
    },
  };
}

function compareWorkItems(left, right) {
  const priorityRank = { urgent: 3, high: 2, normal: 1, low: 0 };
  const priorityDelta = (priorityRank[right?.work?.priority] ?? 0) - (priorityRank[left?.work?.priority] ?? 0);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return Number(right?.createdAtMs ?? 0) - Number(left?.createdAtMs ?? 0);
}

function normalizeBucket(items, state) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item === "object")
    .map((item) => enrichWorkItem(item, state));
}

function dedupeAcrossStates(items) {
  const byId = new Map();
  for (const item of items) {
    const id = cleanText(item?.work?.id);
    if (!id) {
      continue;
    }
    const previous = byId.get(id);
    if (!previous) {
      byId.set(id, item);
      continue;
    }
    const previousRank = STATE_PRIORITY.get(previous.work.state) ?? 0;
    const nextRank = STATE_PRIORITY.get(item.work.state) ?? 0;
    if (nextRank > previousRank || (nextRank === previousRank && Number(item.createdAtMs) > Number(previous.createdAtMs))) {
      byId.set(id, item);
    }
  }
  return [...byId.values()];
}

export function buildWorkItemResponse({ pending = [], inProgress = [], completed = [], generatedAtMs = Date.now() } = {}) {
  const pendingItems = normalizeBucket(pending, "needs_action");
  const blockedThreadKeys = new Set(pendingItems.map(workItemThreadKey).filter(Boolean));
  const activeItems = normalizeBucket(inProgress, "in_progress")
    .filter((item) => !blockedThreadKeys.has(workItemThreadKey(item)));
  const completedItems = (Array.isArray(completed) ? completed : [])
    .filter((item) => item && typeof item === "object")
    .map((item) => enrichWorkItem(item, terminalState(item)));

  const deduped = dedupeAcrossStates([...activeItems, ...pendingItems, ...completedItems]);
  const needsAction = deduped.filter((item) => item.work.state === "needs_action").sort(compareWorkItems);
  const active = deduped.filter((item) => item.work.state === "in_progress").sort(compareWorkItems);
  const terminal = deduped.filter((item) => TERMINAL_STATES.has(item.work.state)).sort(compareWorkItems);

  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    generatedAtMs: Math.max(0, Number(generatedAtMs) || Date.now()),
    counts: {
      needsAction: needsAction.length,
      inProgress: active.length,
      completed: terminal.filter((item) => item.work.state === "completed").length,
      failed: terminal.filter((item) => item.work.state === "failed").length,
    },
    pending: needsAction,
    inProgress: active,
    completed: terminal,
  };
}

export { WORK_ITEM_SCHEMA_VERSION };
