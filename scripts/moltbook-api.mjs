// Shared Moltbook API helpers used by the watcher and the CLI.
// Keeps credential loading + request plumbing in one place.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const API_BASE = "https://www.moltbook.com/api/v1";

export const DEFAULT_ENV_FILE = path.join(os.homedir(), ".viveworker", "moltbook.env");
export const DEFAULT_INBOX_DIR = path.join(os.homedir(), ".viveworker", "moltbook-inbox");
export const DEFAULT_SCOUT_STATE_FILE = path.join(os.homedir(), ".viveworker", "moltbook-scout-state.json");

export async function loadMoltbookEnv(envFile = DEFAULT_ENV_FILE) {
  const env = {};
  try {
    const raw = await fs.readFile(envFile, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // Missing env file is fine — caller will validate required keys.
  }
  // Fall back to process.env for anything not in the file.
  for (const key of ["MOLTBOOK_API_KEY", "MOLTBOOK_AGENT_ID", "VIVEWORKER_HOOK_SECRET", "VIVEWORKER_BASE_URL"]) {
    if (!env[key] && process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export function createMoltbookClient(apiKey) {
  if (!apiKey) {
    throw new Error("MOLTBOOK_API_KEY is required");
  }
  return async function mb(pathname, init = {}) {
    const res = await fetch(`${API_BASE}${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(init.headers || {}),
      },
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`moltbook ${res.status} ${pathname}: ${text}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
}

export function extractNotifications(payload) {
  const list = [];
  const candidates = [
    payload?.notifications,
    payload?.data?.notifications,
    payload?.unread_notifications,
    payload?.activity,
  ];
  for (const arr of candidates) {
    if (Array.isArray(arr)) list.push(...arr);
  }
  return list;
}

export function isCommentNotification(n) {
  const type = String(n?.type || n?.kind || "").toLowerCase();
  return type.includes("comment") || type.includes("reply") || type.includes("mention");
}

export async function ensureInboxDir(dir = DEFAULT_INBOX_DIR) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function inboxPathFor(commentId, dir = DEFAULT_INBOX_DIR) {
  return path.join(dir, `${commentId}.json`);
}

export async function writeInboxItem(item, dir = DEFAULT_INBOX_DIR) {
  await ensureInboxDir(dir);
  await fs.writeFile(inboxPathFor(item.commentId, dir), JSON.stringify(item, null, 2) + "\n", "utf8");
}

export async function readInboxItem(commentId, dir = DEFAULT_INBOX_DIR) {
  try {
    const raw = await fs.readFile(inboxPathFor(commentId, dir), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function updateInboxStatus(commentId, status, extra = {}, dir = DEFAULT_INBOX_DIR) {
  const existing = await readInboxItem(commentId, dir);
  if (!existing) return null;
  const updated = { ...existing, ...extra, status, updatedAt: new Date().toISOString() };
  await writeInboxItem(updated, dir);
  return updated;
}

// ---------- Scout state ----------
//
// Tracks per-day usage of the Moltbook scouting loop so we can enforce a
// simple daily quota and avoid re-proposing drafts against the same post.

export async function readScoutState(file = DEFAULT_SCOUT_STATE_FILE) {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultScoutState();
    return {
      day: String(parsed.day || ""),
      sentToday: Number(parsed.sentToday) || 0,
      seenPostIds: parsed.seenPostIds && typeof parsed.seenPostIds === "object" ? parsed.seenPostIds : {},
      batch: parsed.batch && typeof parsed.batch === "object" ? parsed.batch : null,
      lastComposeDay: String(parsed.lastComposeDay || ""),
      composedToday: Number(parsed.composedToday) || 0,
      composeSlotsAttempted: Array.isArray(parsed.composeSlotsAttempted) ? parsed.composeSlotsAttempted : [],
      recentComposeTitles: Array.isArray(parsed.recentComposeTitles) ? parsed.recentComposeTitles : [],
    };
  } catch {
    return defaultScoutState();
  }
}

export async function writeScoutState(state, file = DEFAULT_SCOUT_STATE_FILE) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function defaultScoutState() {
  return { day: todayKey(), sentToday: 0, seenPostIds: {}, batch: null, lastComposeDay: "", composedToday: 0, composeSlotsAttempted: [], recentComposeTitles: [] };
}

export function todayKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function rollScoutDayIfNeeded(state) {
  const today = todayKey();
  if (state.day !== today) {
    state.day = today;
    state.sentToday = 0;
    state.composedToday = 0;
    state.composeSlotsAttempted = [];
  }
  // Evict seenPostIds entries older than 30 days to keep the file small.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(state.seenPostIds)) {
    // Support both legacy (bare timestamp) and new ({ ts, outcome }) formats.
    const ts = typeof entry === "number" ? entry : (entry?.ts ?? 0);
    if (!Number.isFinite(ts) || ts < cutoff) delete state.seenPostIds[id];
  }
  return state;
}

export function recordComposeAttempt(state, title) {
  state.composedToday = (state.composedToday || 0) + 1;
  state.lastComposeDay = todayKey();
  if (!Array.isArray(state.recentComposeTitles)) state.recentComposeTitles = [];
  state.recentComposeTitles.unshift(String(title || ""));
  if (state.recentComposeTitles.length > 10) state.recentComposeTitles.length = 10;
  return state;
}

export function markPostSeen(state, postId, outcome = "seen") {
  state.seenPostIds[String(postId)] = { ts: Date.now(), outcome };
  return state;
}

export async function listInboxItems(dir = DEFAULT_INBOX_DIR) {
  try {
    const files = await fs.readdir(dir);
    const items = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(dir, file), "utf8");
        items.push(JSON.parse(raw));
      } catch {
        // skip bad file
      }
    }
    return items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  } catch {
    return [];
  }
}
