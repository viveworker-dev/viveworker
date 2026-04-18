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
    const { timeoutMs: overrideTimeoutMs, ...fetchInit } = init;
    const method = String(fetchInit.method || "GET").toUpperCase();
    const isWrite = method !== "GET" && method !== "HEAD";
    // Reads get 30s, writes 60s. A flaky upstream must not be able to hang
    // the process indefinitely — this exact failure mode took out the
    // moltbook-watcher in mid-April 2026 when /notifications started
    // returning 500s and later stopped responding entirely. Bare fetch has
    // no default timeout and the undici connection pool saturated, leaving
    // the process alive but unable to log, poll, or push anything.
    // Writes get a longer budget because POST /posts and /comments do
    // synchronous spam-screening on the server side.
    const timeoutMs = typeof overrideTimeoutMs === "number"
      ? overrideTimeoutMs
      : (isWrite ? 60_000 : 30_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${API_BASE}${pathname}`, {
        ...fetchInit,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          ...(fetchInit.headers || {}),
        },
      });
      const text = await res.text().catch(() => "");
      if (controller.signal.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      if (!res.ok) {
        throw new Error(`moltbook ${res.status} ${pathname}: ${text}`);
      }
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        const hint = isWrite
          ? " — may have succeeded server-side; run `moltbook reconcile` before retrying"
          : "";
        throw new Error(`moltbook timeout after ${timeoutMs}ms ${method} ${pathname}${hint}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
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

export function recordComposeAttempt(state, title, postId, type = "post") {
  // Only original posts count against the daily "本日の新規投稿数" quota
  // (composedToday). Replies are still appended to recentComposeTitles so
  // the "最近の投稿" list in settings shows them with their reply badge,
  // but they intentionally do not inflate the counter.
  if (type === "post") {
    state.composedToday = (state.composedToday || 0) + 1;
  }
  state.lastComposeDay = todayKey();
  if (!Array.isArray(state.recentComposeTitles)) state.recentComposeTitles = [];
  const entry = { title: String(title || ""), type };
  if (postId) entry.postId = String(postId);
  state.recentComposeTitles.unshift(entry);
  if (state.recentComposeTitles.length > 30) state.recentComposeTitles.length = 30;
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
//
// Moltbook's verification puzzles are obfuscated word problems — e.g.
// `lOoB-stErR ClAw FoRcE iS tHiRtY fIvE NoOtOnS aNd iT s OtHeR ClAw Is tWeNtY
// tHrEe NooToNs, tOtAl/ FoRcE?` → 35 + 23 = 58.00. The solver strips
// non-letter noise, identifies number words (including compounds like
// "one hundred forty two" = 142), identifies operator words around each
// number, and evaluates left-to-right. See `scripts/test-puzzle-solver.mjs`
// for the regression corpus; add new cases there whenever we observe a
// failure in the wild via the `~/.viveworker/moltbook-verify-history.jsonl`
// log.

// Operator encoding: 0=add, 1=sub, 2=mul, 3=div.
const OP_ADD = 0;
const OP_SUB = 1;
const OP_MUL = 2;
const OP_DIV = 3;

const NUMBER_WORDS = Object.freeze({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000,
  // Cultural shortcuts that occasionally appear in the generator.
  dozen: 12, score: 20,
});

// Operator words. Keep contextual/framing words (force, velocity, total, etc.)
// mapped to OP_ADD so their presence doesn't crash the parser — the binary-
// sequence builder drops ops that have no number to operate against.
const OP_WORDS = Object.freeze({
  // Addition / neutral-context.
  add: OP_ADD, added: OP_ADD, adds: OP_ADD, plus: OP_ADD, and: OP_ADD,
  sum: OP_ADD, summed: OP_ADD, combined: OP_ADD, combine: OP_ADD, together: OP_ADD,
  total: OP_ADD, totaled: OP_ADD, totals: OP_ADD, both: OP_ADD,
  gain: OP_ADD, gains: OP_ADD, gained: OP_ADD,
  increase: OP_ADD, increased: OP_ADD, increases: OP_ADD,
  boost: OP_ADD, boosted: OP_ADD, boosts: OP_ADD,
  faster: OP_ADD, accelerates: OP_ADD, accelerated: OP_ADD, more: OP_ADD,
  force: OP_ADD, velocity: OP_ADD, speed: OP_ADD, exerts: OP_ADD, new: OP_ADD,
  // Subtraction.
  minus: OP_SUB, less: OP_SUB, difference: OP_SUB, subtract: OP_SUB,
  subtracts: OP_SUB, subtracted: OP_SUB,
  decrease: OP_SUB, decreased: OP_SUB, decreases: OP_SUB,
  loses: OP_SUB, lost: OP_SUB, lose: OP_SUB,
  reduce: OP_SUB, reduced: OP_SUB, reduces: OP_SUB, reducing: OP_SUB, reduction: OP_SUB,
  drop: OP_SUB, drops: OP_SUB, dropped: OP_SUB,
  slower: OP_SUB, slows: OP_SUB, slowed: OP_SUB,
  remove: OP_SUB, removes: OP_SUB, removed: OP_SUB,
  // Multiplication.
  multiply: OP_MUL, multiplied: OP_MUL, multiplies: OP_MUL,
  times: OP_MUL, product: OP_MUL,
  twice: OP_MUL, double: OP_MUL, doubled: OP_MUL,
  triple: OP_MUL, tripled: OP_MUL,
  squared: OP_MUL, square: OP_MUL,
  // Division.
  divide: OP_DIV, divided: OP_DIV, divides: OP_DIV, division: OP_DIV,
  ratio: OP_DIV,
  // NOTE: "per" intentionally NOT mapped here — "per second" / "per hour"
  // are units, not division operators. When a puzzle really means division
  // it uses "divided by" or "ratio of" or "split".
  half: OP_DIV, halved: OP_DIV, halves: OP_DIV,
  split: OP_DIV,
});

// Collapse runs of the same letter: the generator often doubles consonants
// (e.g. "NoOtOnS" → "nootons"; "lOoB-stErR" → "loobsterr"). Collapsing means
// known-word detection still fires on the de-doubled form.
const collapseRuns = (w) => w.replace(/([a-z])\1+/g, "$1");

function lookupWord(word) {
  if (NUMBER_WORDS[word] != null) return { type: "num", value: NUMBER_WORDS[word] };
  if (OP_WORDS[word] != null) return { type: "op", value: OP_WORDS[word] };
  const collapsed = collapseRuns(word);
  if (collapsed !== word) {
    if (NUMBER_WORDS[collapsed] != null) return { type: "num", value: NUMBER_WORDS[collapsed] };
    if (OP_WORDS[collapsed] != null) return { type: "op", value: OP_WORDS[collapsed] };
  }
  return null;
}

// Naive verification-puzzle solver. Returns answer as "XX.XX" or null if we
// can't confidently recover two numbers. Caller falls back to LLM.
export function solveVerificationPuzzle(challengeText) {
  if (!challengeText) return null;

  // Strip everything that isn't a letter or digit. Symbols (/, *, ^, ~, [, ])
  // are deliberately NOT operators — the generator sprinkles them as pure
  // noise. All real operators are spelled out in words.
  const rawTokens = String(challengeText)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  // The generator sometimes splits a known word into pieces separated by
  // stripped punctuation (e.g. "tHiR-tY" → "thir" "ty"). Try to re-merge
  // adjacent tokens if their concatenation is a known number or operator.
  const merged = [];
  let ti = 0;
  while (ti < rawTokens.length) {
    let bestLen = 1;
    let best = rawTokens[ti];
    let candidate = rawTokens[ti];
    for (let span = 2; span <= Math.min(4, rawTokens.length - ti); span++) {
      candidate += rawTokens[ti + span - 1];
      if (lookupWord(candidate)) {
        best = candidate;
        bestLen = span;
      }
    }
    merged.push(best);
    ti += bestLen;
  }

  // Convert the token stream into a sequence of {type:"num"|"op", value}.
  // Compound numbers ("one hundred forty two" = 142) are collected greedily.
  const tokens = [];
  let j = 0;
  while (j < merged.length) {
    const w = merged[j];

    // Bare digit.
    if (/^\d+$/.test(w)) {
      tokens.push({ type: "num", value: Number(w) });
      j += 1;
      continue;
    }

    const lookup = lookupWord(w);
    if (!lookup) { j += 1; continue; }

    if (lookup.type === "num") {
      // Greedy compound-number consumption. Examples:
      //   "thirty five"                =  35  (chunk += 30 then chunk += 5)
      //   "one hundred forty two"      = 142  (chunk=1 → *100 → +40 → +2)
      //   "three thousand four hundred fifty" = 3450
      let sum = 0;
      let chunk = 0;
      let consumed = false;
      while (j < merged.length) {
        const cur = merged[j];
        if (/^\d+$/.test(cur)) {
          if (consumed) break; // mixing word-number + digit-number, stop
          sum = Number(cur);
          consumed = true;
          j += 1;
          break;
        }
        const inner = lookupWord(cur);
        if (!inner || inner.type !== "num") break;
        const n = inner.value;
        if (n === 1000) {
          sum += (chunk || 1) * 1000;
          chunk = 0;
        } else if (n === 100) {
          chunk = (chunk || 1) * 100;
        } else {
          // n < 100: tens + ones accumulate into the current chunk.
          chunk += n;
        }
        consumed = true;
        j += 1;
      }
      if (consumed) tokens.push({ type: "num", value: sum + chunk });
      continue;
    }

    // Operator.
    tokens.push({ type: "op", value: lookup.value });
    j += 1;
  }

  // Capture the first non-default op that appears BEFORE the first number.
  // Phrases like "product of X and Y", "difference between X and Y", and
  // "ratio of X to Y" put the real operation at the front and leave only a
  // weak connector ("and", "to", "of") between the numbers. Without this,
  // the solver would drop the leading op and default to addition.
  let leadingStrongOp = null;
  for (const t of tokens) {
    if (t.type === "num") break;
    if (t.type === "op" && t.value !== OP_ADD) { leadingStrongOp = t.value; break; }
  }

  // Normalise into a strict alternation [num, op, num, op, num, ...].
  //   - Drop leading ops (framing words like "total force is ...").
  //   - If two ops appear back-to-back, prefer the STRONGER (non-ADD) one
  //     over the default ADD. This is because contextual framing verbs
  //     (force / velocity / speed / exerts) are mapped to OP_ADD so their
  //     presence doesn't crash the parser, but they should NOT clobber a
  //     real operator (OP_SUB / OP_MUL / OP_DIV) that appears right next
  //     to them. Example: "reducing speed by four" → tokens end up as
  //     [OP_SUB(reducing), OP_ADD(speed)] — SUB must survive.
  //     When both ops are the same strength, the latter wins (closest to
  //     the following number).
  //   - If two nums appear with no op between them, insert a default add.
  //   - Drop trailing ops.
  const seq = [];
  for (const t of tokens) {
    if (seq.length === 0) {
      if (t.type === "num") seq.push(t);
      continue;
    }
    const last = seq[seq.length - 1];
    if (t.type === "num") {
      if (last.type === "num") {
        seq.push({ type: "op", value: OP_ADD });
      }
      seq.push(t);
    } else {
      if (last.type === "op") {
        // Prefer strong over default (ADD). Otherwise latter wins.
        if (last.value === OP_ADD && t.value !== OP_ADD) {
          seq[seq.length - 1] = t;
        } else if (last.value !== OP_ADD && t.value === OP_ADD) {
          // Keep last — strong op survives over a trailing framing verb.
        } else {
          seq[seq.length - 1] = t;
        }
      } else {
        seq.push(t);
      }
    }
  }
  while (seq.length > 0 && seq[seq.length - 1].type === "op") seq.pop();

  if (seq.length < 3) return null;
  if (seq[0].type !== "num") return null;

  // Promote the leading op if no strong op appeared between the numbers. We
  // only do this when every internal op is the default OP_ADD — otherwise
  // the internal ops were the real signal (e.g. "a+b-c" should stay mixed,
  // even if the sentence started with "total").
  if (leadingStrongOp != null) {
    const hasStrongInternal = seq.some((t) => t.type === "op" && t.value !== OP_ADD);
    if (!hasStrongInternal) {
      for (const t of seq) {
        if (t.type === "op") t.value = leadingStrongOp;
      }
    }
  }

  // Evaluate strictly left-to-right (no precedence — Moltbook puzzles are
  // binary in practice, so this only matters for the rare 3-number case).
  let result = seq[0].value;
  for (let k = 1; k < seq.length; k += 2) {
    const op = seq[k];
    const rhs = seq[k + 1];
    if (!op || !rhs || op.type !== "op" || rhs.type !== "num") break;
    switch (op.value) {
      case OP_ADD: result += rhs.value; break;
      case OP_SUB: result -= rhs.value; break;
      case OP_MUL: result *= rhs.value; break;
      case OP_DIV: result = rhs.value !== 0 ? result / rhs.value : result; break;
      default: break;
    }
  }

  if (!Number.isFinite(result)) return null;
  // Refuse answers the puzzle generator shouldn't produce. A negative answer
  // usually means we mis-identified the operator direction; returning null
  // lets the LLM take a clean shot rather than submitting a definitely-wrong
  // value.
  if (result < 0) return null;

  return result.toFixed(2);
}

// LLM-based verification puzzle solver. Shells out to claude or codex CLI.
// Returns the answer as "XX.XX" string, or null if unavailable.
//
// The naive solver misses ~13% of Moltbook's puzzles (mostly 3-number or
// unusual-vocabulary cases). The LLM fallback has been the same ~13% blind
// spot because parsing was too strict — it only accepted "XX.XX" on its own
// or a pure-integer line, and many CLI wrappers prepend banners or reason
// step-by-step before emitting the final number. `extractPuzzleAnswerFromText`
// is now shared with `solvePuzzleWithLLM` and is much more forgiving:
// prefer explicit decimals, fall back to the last standalone integer, then
// the last integer anywhere in the response. Exported for tests.
export function extractPuzzleAnswerFromText(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  if (!trimmed) return null;

  // 1. Prefer an exact "NN.NN" (two decimals) token. This is what the prompt
  //    explicitly asks for and what every happy-path response contains.
  const twoDecimal = trimmed.match(/(?:^|[^\d])(\d+\.\d{2})(?:[^\d]|$)/);
  if (twoDecimal) return twoDecimal[1];

  // 2. Accept a one-decimal form and pad — e.g. "58.5" → "58.50".
  const oneDecimal = trimmed.match(/(?:^|[^\d])(\d+\.\d)(?:[^\d]|$)/);
  if (oneDecimal) return `${oneDecimal[1]}0`;

  // 3. If the response contains any integer at all, use the LAST one. The LLM
  //    often reasons step-by-step ("thirty-five = 35, twenty-three = 23,
  //    sum is 58"), and the final integer is the answer. This is less
  //    precise than step (1) but beats returning null on otherwise-correct
  //    reasoning.
  const ints = [...trimmed.matchAll(/\b(\d+)\b/g)].map((m) => m[1]);
  if (ints.length > 0) {
    const pick = Number(ints[ints.length - 1]);
    if (Number.isFinite(pick) && pick >= 0) return `${pick}.00`;
  }

  return null;
}

export async function solvePuzzleWithLLM(challengeText) {
  if (!challengeText) return null;
  const prompt =
    `The following text is an obfuscated arithmetic word problem from Moltbook (an AI social network). ` +
    `The text has random capitalization, doubled letters, and stray punctuation — ignore all of that. ` +
    `CRITICAL: ALL symbols (/, *, ^, ~, [, ], etc.) are NOISE, NOT arithmetic operators. ` +
    `The operation is ALWAYS expressed in natural language words only. ` +
    `Extract the numbers (written as words like "thirty five" = 35, or "one hundred forty" = 140), ` +
    `determine the operation from WORDS ONLY ` +
    `(addition: "total", "combined", "and", "plus", "gains", "sum", "together", "increased", "new velocity"; ` +
    `subtraction: "difference", "minus", "less", "loses", "decreased", "reduced"; ` +
    `multiplication: "times", "product", "multiplied", "doubled", "tripled", "squared"; ` +
    `division: "divided by", "ratio", "per", "halved"). ` +
    `If two or more operation words appear, apply them left-to-right in order. ` +
    `If no operation word is found, default to addition. ` +
    `Compute the result and output ONLY the number with exactly 2 decimal places (e.g. "58.00"). ` +
    `No reasoning, no other text — JUST the number.\n\n` +
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
      const extracted = extractPuzzleAnswerFromText(result);
      if (extracted) return extracted;
    } catch {
      // try next
    }
  }
  return null;
}

// ---------- Verification history (for offline analysis / retraining) ----------
//
// Every verify attempt — whether it succeeded, was rejected by the server,
// or couldn't be solved at all — gets a single JSONL line appended to
// `~/.viveworker/moltbook-verify-history.jsonl`. The file is the only way to
// reconstruct a failing `challenge_text` after the fact, because the puzzle
// is ephemeral on the Moltbook side (returned once in the POST /posts
// response and never exposed again).
//
// Having the corpus lets us:
//   1. Diagnose concrete failures with `scripts/test-puzzle-solver.mjs`.
//   2. Add new regression cases to the test harness when a new template
//      starts appearing.
//   3. Measure solver vs LLM hit rate over time.
export const DEFAULT_VERIFY_HISTORY_FILE = path.join(
  os.homedir(), ".viveworker", "moltbook-verify-history.jsonl"
);

export async function recordPuzzleAttempt(entry, file = DEFAULT_VERIFY_HISTORY_FILE) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const record = {
      ts: new Date().toISOString(),
      ...entry,
    };
    await fs.appendFile(file, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    // Best-effort logging — never fail a post just because the history file
    // is unwritable.
    try { console.error(`[moltbook-verify-history] Failed to record: ${err.message}`); } catch { /* ignore */ }
  }
}
