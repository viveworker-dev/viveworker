// Shared Moltbook API helpers used by the watcher and the CLI.
// Keeps credential loading + request plumbing in one place.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const API_BASE = "https://www.moltbook.com/api/v1";

export const DEFAULT_ENV_FILE = path.join(os.homedir(), ".viveworker", "moltbook.env");
export const DEFAULT_INBOX_DIR = path.join(os.homedir(), ".viveworker", "moltbook-inbox");

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
