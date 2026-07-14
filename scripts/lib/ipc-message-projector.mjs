const THREAD_STATE_SCALAR_KEYS = [
  "id",
  "cwd",
  "thread_name",
  "threadName",
  "title",
  "name",
  "conversationTitle",
  "threadTitle",
  "label",
  "summary",
  "archived",
  "isArchived",
  "hidden",
  "isHidden",
  "deleted",
  "isDeleted",
  "closed",
  "isClosed",
  "status",
  "state",
  "visibility",
  "lifecycle",
];

const METADATA_KEYS = [
  "thread_name",
  "threadName",
  "title",
  "archived",
  "isArchived",
  "hidden",
  "isHidden",
  "deleted",
  "isDeleted",
  "status",
  "state",
  "visibility",
];

const THREAD_KEYS = [
  "id",
  "title",
  "name",
  "archived",
  "isArchived",
  "hidden",
  "isHidden",
  "deleted",
  "isDeleted",
  "status",
  "state",
  "visibility",
];

const RELEVANT_PATCH_ROOTS = new Set([
  ...THREAD_STATE_SCALAR_KEYS,
  "requests",
  "latestCollaborationMode",
  "metadata",
  "thread",
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function boundedLabelValue(value) {
  return typeof value === "string" && value.length > 512 ? value.slice(0, 512) : value;
}

function pickObject(value, keys) {
  if (!isObject(value)) return undefined;
  const projected = {};
  for (const key of keys) {
    if (own(value, key)) projected[key] = boundedLabelValue(value[key]);
  }
  return projected;
}

function projectCollaborationMode(value) {
  if (!isObject(value)) return undefined;
  const projected = {};
  if (own(value, "mode")) projected.mode = value.mode;
  if (isObject(value.settings)) {
    projected.settings = {
      ...(own(value.settings, "model") ? { model: value.settings.model } : {}),
      ...(own(value.settings, "reasoning_effort")
        ? { reasoning_effort: value.settings.reasoning_effort }
        : {}),
    };
  }
  return projected;
}

function projectRequest(value) {
  if (!isObject(value)) return value;
  return {
    ...(own(value, "id") ? { id: value.id } : {}),
    ...(own(value, "method") ? { method: value.method } : {}),
    ...(own(value, "params") ? { params: value.params } : {}),
  };
}

function projectRequests(value) {
  return Array.isArray(value) ? value.map(projectRequest) : value;
}

export function projectConversationState(value) {
  if (!isObject(value)) return {};
  const projected = {};
  for (const key of THREAD_STATE_SCALAR_KEYS) {
    if (own(value, key)) projected[key] = boundedLabelValue(value[key]);
  }
  if (own(value, "requests")) projected.requests = projectRequests(value.requests);
  if (own(value, "latestCollaborationMode")) {
    projected.latestCollaborationMode = projectCollaborationMode(value.latestCollaborationMode);
  }
  if (own(value, "metadata")) projected.metadata = pickObject(value.metadata, METADATA_KEYS);
  if (own(value, "thread")) projected.thread = pickObject(value.thread, THREAD_KEYS);
  return projected;
}

function pointerSegments(pointer) {
  if (Array.isArray(pointer)) return pointer.map(String);
  if (!pointer || pointer === "/") return [];
  return String(pointer)
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

function projectPatchValue(segments, value) {
  if (segments.length === 0) return projectConversationState(value);
  const root = segments[0];
  if (root === "requests") {
    if (segments.length === 1) return projectRequests(value);
    if (segments.length === 2) return projectRequest(value);
    return value;
  }
  if (root === "latestCollaborationMode" && segments.length === 1) {
    return projectCollaborationMode(value);
  }
  if (root === "metadata" && segments.length === 1) return pickObject(value, METADATA_KEYS);
  if (root === "thread" && segments.length === 1) return pickObject(value, THREAD_KEYS);
  return boundedLabelValue(value);
}

function isRelevantPatchPath(segments) {
  if (segments.length === 0) return true;
  const root = segments[0];
  if (!RELEVANT_PATCH_ROOTS.has(root)) return false;
  if (root === "metadata") return segments.length === 1 || METADATA_KEYS.includes(segments[1]);
  if (root === "thread") return segments.length === 1 || THREAD_KEYS.includes(segments[1]);
  if (root === "latestCollaborationMode") {
    return (
      segments.length === 1 ||
      segments[1] === "mode" ||
      (segments[1] === "settings" && [undefined, "model", "reasoning_effort"].includes(segments[2]))
    );
  }
  return true;
}

function projectPatch(patch) {
  if (!isObject(patch)) return null;
  const segments = pointerSegments(patch.path);
  if (!isRelevantPatchPath(segments)) return null;
  return {
    op: patch.op,
    path: patch.path,
    ...(own(patch, "value") ? { value: projectPatchValue(segments, patch.value) } : {}),
  };
}

function projectPatches(value) {
  const patches = Array.isArray(value) ? value : value ? [value] : [];
  return patches.map(projectPatch).filter(Boolean);
}

function projectThreadStateParams(params) {
  const source = isObject(params) ? params : {};
  const projected = {};
  for (const key of ["conversationId", "threadId", "id"]) {
    if (own(source, key)) projected[key] = source[key];
  }
  if (isObject(source.change)) {
    if (source.change.type === "snapshot") {
      projected.change = {
        type: "snapshot",
        conversationState: projectConversationState(source.change.conversationState),
      };
    } else if (source.change.type === "patches") {
      projected.change = { type: "patches", patches: projectPatches(source.change.patches) };
    }
  }
  if (own(source, "state")) projected.state = projectConversationState(source.state);
  if (own(source, "conversation")) projected.conversation = projectConversationState(source.conversation);
  if (own(source, "thread")) projected.thread = projectConversationState(source.thread);
  if (own(source, "requests")) projected.requests = projectRequests(source.requests);
  for (const key of ["patch", "patches", "operations", "ops"]) {
    if (own(source, key)) projected[key] = projectPatches(source[key]);
  }
  return projected;
}

export function projectIpcMessage(message) {
  if (!isObject(message) || message.type !== "broadcast" || message.method !== "thread-stream-state-changed") {
    return message;
  }
  return {
    type: message.type,
    method: message.method,
    ...(own(message, "sourceClientId") ? { sourceClientId: message.sourceClientId } : {}),
    params: projectThreadStateParams(message.params),
  };
}
