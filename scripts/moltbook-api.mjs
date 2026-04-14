// Shared Moltbook API helpers used by the watcher and the CLI.
// Keeps credential loading + request plumbing in one place.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const API_BASE = "https://www.moltbook.com/api/v1";

export const DEFAULT_ENV_FILE = path.join(os.homedir(), ".viveworker", "moltbook.env");
export const DEFAULT_INBOX_DIR = path.join(os.homedir(), ".viveworker", "moltbook-inbox");
export const DEFAULT_SCOUT_STATE_FILE = path.join(os.homedir(), ".viveworker", "moltbook-scout-state.json");
export const DEFAULT_DRAFTS_DIR = path.join(os.homedir(), ".viveworker", "moltbook-drafts");

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
  // Use local timezone with AM 5:00 as the day boundary — hours before 5am
  // count as the previous day so late-night work doesn't consume the next
  // day's quota.
  const d = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
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

export function recordComposeAttempt(state, title, postId) {
  state.composedToday = (state.composedToday || 0) + 1;
  state.lastComposeDay = todayKey();
  if (!Array.isArray(state.recentComposeTitles)) state.recentComposeTitles = [];
  state.recentComposeTitles.unshift(
    postId ? { title: String(title || ""), postId: String(postId) } : String(title || "")
  );
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

// ---------- Draft persistence ----------
//
// Pending Moltbook drafts (reply proposals and original-post proposals) are
// written to disk so they survive bridge restarts.  One JSON file per draft,
// keyed by its bridge-assigned token.

export async function ensureDraftsDir(dir = DEFAULT_DRAFTS_DIR) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function draftPathFor(token, dir = DEFAULT_DRAFTS_DIR) {
  // Token may contain colons — encode for safe filenames.
  const safe = encodeURIComponent(token);
  return path.join(dir, `${safe}.json`);
}

export async function writeDraft(draft, dir = DEFAULT_DRAFTS_DIR) {
  await ensureDraftsDir(dir);
  // Exclude runtime-only fields (decisionWaiters is an array of callbacks).
  const { decisionWaiters, ...serializable } = draft;
  await fs.writeFile(draftPathFor(draft.token, dir), JSON.stringify(serializable, null, 2) + "\n", "utf8");
}

export async function readDraft(token, dir = DEFAULT_DRAFTS_DIR) {
  try {
    const raw = await fs.readFile(draftPathFor(token, dir), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function deleteDraft(token, dir = DEFAULT_DRAFTS_DIR) {
  try {
    await fs.unlink(draftPathFor(token, dir));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function listPendingDrafts(dir = DEFAULT_DRAFTS_DIR) {
  try {
    const files = await fs.readdir(dir);
    const drafts = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(dir, file), "utf8");
        const draft = JSON.parse(raw);
        if (draft && !draft.decision) drafts.push(draft);
      } catch {
        // skip bad file
      }
    }
    return drafts;
  } catch {
    return [];
  }
}

// ---------- Verification puzzle solvers ----------
//
// Shared by the CLI (for manual `reply` flow) and the bridge (for fire-and-
// forget draft posting on approval).

// Naive verification-puzzle solver. Handles the obfuscated two-number
// arithmetic Moltbook currently uses (add / subtract / multiply). Returns
// `null` if it can't confidently solve — caller falls back to LLM or manual.
export function solveVerificationPuzzle(challengeText) {
  if (!challengeText) return null;
  const cleaned = String(challengeText)
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .toLowerCase();
  const numberWords = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  };
  const collapseRuns = (w) => w.replace(/([a-z])\1+/g, "$1");
  const rawTokens = cleaned
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const operationWords = new Set([
    "total", "combined", "force", "velocity", "speed", "gains", "plus", "and",
    "subtract", "minus", "less", "difference", "decreased", "loses", "lost", "slower", "slows", "slowed",
    "multiply", "times", "product", "multiplied",
    "divide", "divided", "ratio",
    "how", "much", "what", "exerts", "new",
  ]);
  const isKnown = (w) => numberWords[w] != null || numberWords[collapseRuns(w)] != null || operationWords.has(w) || operationWords.has(collapseRuns(w));
  const merged = [];
  let ti = 0;
  while (ti < rawTokens.length) {
    let best = rawTokens[ti];
    let bestLen = 1;
    let candidate = rawTokens[ti];
    for (let span = 2; span <= Math.min(4, rawTokens.length - ti); span++) {
      candidate += rawTokens[ti + span - 1];
      if (isKnown(candidate) || isKnown(collapseRuns(candidate))) {
        best = candidate;
        bestLen = span;
      }
    }
    merged.push(best);
    ti += bestLen;
  }
  const words = merged.map((w) => {
    if (/^\d+$/.test(w)) return w;
    if (numberWords[w] != null) return w;
    const collapsed = collapseRuns(w);
    if (numberWords[collapsed] != null) return collapsed;
    return collapsed;
  });
  const numbers = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^\d+$/.test(w)) {
      numbers.push(Number(w));
      i += 1;
      continue;
    }
    if (numberWords[w] != null) {
      let total = numberWords[w];
      i += 1;
      while (i < words.length && numberWords[words[i]] != null) {
        const next = numberWords[words[i]];
        if (next === 100) total *= 100;
        else if (next < 100 && total < 100) total += next;
        else break;
        i += 1;
      }
      numbers.push(total);
      continue;
    }
    i += 1;
  }
  if (numbers.length < 2) return null;
  const a = numbers[0];
  const b = numbers[1];
  const hasWord = (w) => words.includes(w);
  const hasAny = (...ws) => ws.some(hasWord);
  let result;
  if (hasAny("subtract", "minus", "less", "difference", "decreased", "loses", "lost", "slower", "slows", "slowed")) {
    result = a - b;
  } else if (hasAny("multiply", "times", "product", "multiplied")) {
    result = a * b;
  } else if (hasAny("divide", "divided", "ratio")) {
    result = b !== 0 ? a / b : a;
  } else {
    result = a + b;
  }
  return result.toFixed(2);
}

// LLM-based verification puzzle solver. Shells out to claude or codex CLI.
// Returns the answer as "XX.XX" string, or null if unavailable.
export async function solvePuzzleWithLLM(challengeText) {
  if (!challengeText) return null;
  const prompt =
    `The following text is an obfuscated arithmetic word problem from Moltbook (an AI social network). ` +
    `The text has random capitalization, doubled letters, and stray punctuation — ignore all of that. ` +
    `CRITICAL: ALL symbols (/, *, ^, ~, [, ], etc.) are NOISE, NOT arithmetic operators. ` +
    `The operation is ALWAYS expressed in natural language words only. ` +
    `Extract the numbers (written as words like "thirty five" = 35), determine the operation from WORDS ONLY ` +
    `(addition: "total", "combined", "and", "plus", "gains", "new velocity"; ` +
    `subtraction: "difference", "minus", "less", "loses"; ` +
    `multiplication: "times", "product", "multiplied"; ` +
    `division: "divided by", "ratio", "per"). ` +
    `If no operation word is found, default to addition. ` +
    `Compute the result and output ONLY the number with exactly 2 decimal places (e.g. "58.00"). No other text.\n\n` +
    `Puzzle: ${challengeText}`;
  for (const cmd of ["claude", "codex"]) {
    let bin;
    try {
      bin = await new Promise((resolve) => {
        const p = spawn("command", ["-v", cmd], { shell: "/bin/bash", stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        p.stdout.on("data", (d) => (out += d.toString()));
        p.on("exit", (code) => resolve(code === 0 ? out.trim() : ""));
        p.on("error", () => resolve(""));
      });
    } catch { bin = ""; }
    if (!bin) continue;
    const args = cmd === "claude" ? ["-p", prompt, "--output-format", "text"] : ["exec", prompt];
    try {
      const result = await new Promise((resolve, reject) => {
        const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
        let out = "";
        p.stdout.on("data", (d) => (out += d.toString()));
        p.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))));
        p.on("error", reject);
      });
      const match = result.match(/(\d+\.\d{2})/);
      if (match) return match[1];
      const intMatch = result.match(/^(\d+)$/m);
      if (intMatch) return `${intMatch[1]}.00`;
    } catch {
      // try next
    }
  }
  return null;
}
