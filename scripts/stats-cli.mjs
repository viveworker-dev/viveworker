/**
 * stats-cli.mjs — viveworker usage / adoption dashboard.
 *
 * Aggregates signals from four places so the operator can see the big
 * picture without hunting through per-tool CLIs:
 *
 *   1. npm — public api.npmjs.org (download counts, latest version)
 *   2. A2A relay — /stats/global (public) + /stats/<userId> (auth)
 *   3. Share worker — /api/list (file count, quota usage)
 *   4. Local Moltbook data — ~/.viveworker/moltbook-{inbox,verify-history,scout-state}
 *
 * Each section fetches independently and renders even when its peers fail
 * (so a down share-worker doesn't hide the npm section, etc.).
 *
 * Usage:
 *   viveworker stats
 *   viveworker stats --json
 *   viveworker stats --pkg my-custom-name
 *
 * Credentials are read from ~/.viveworker/a2a.env (same creds as
 * `viveworker a2a` and `viveworker share`). A2A-credential-less runs still
 * show npm + moltbook-local + a2a-global; the per-user A2A and share
 * sections are skipped with a small note.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const A2A_ENV_FILE = path.join(os.homedir(), ".viveworker", "a2a.env");
const DEFAULT_A2A_RELAY_URL = "https://a2a.viveworker.com";
const DEFAULT_SHARE_URL = "https://share.viveworker.com";
const DEFAULT_NPM_PKG = "viveworker";
const MOLTBOOK_INBOX_DIR = path.join(os.homedir(), ".viveworker", "moltbook-inbox");
const MOLTBOOK_VERIFY_HISTORY = path.join(os.homedir(), ".viveworker", "moltbook-verify-history.jsonl");
const MOLTBOOK_SCOUT_STATE = path.join(os.homedir(), ".viveworker", "moltbook-scout-state.json");

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export async function runStatsCli(args) {
  const flags = parseFlags(args);
  if (flags.help || flags.h) {
    printHelp();
    return;
  }

  const pkgName = String(flags.pkg || DEFAULT_NPM_PKG);
  const creds = await loadCredentialsOrNull();

  // Fetch all sections in parallel; each section swallows its own errors so a
  // single failing endpoint doesn't blank out the rest of the dashboard.
  const [npm, a2a, share, moltbook] = await Promise.all([
    fetchNpm(pkgName).catch((err) => ({ error: err.message })),
    fetchA2A(creds).catch((err) => ({ error: err.message })),
    fetchShare(creds).catch((err) => ({ error: err.message })),
    fetchMoltbookLocal().catch((err) => ({ error: err.message })),
  ]);

  const snapshot = {
    timestamp: new Date().toISOString(),
    userId: creds?.userId || null,
    pkgName,
  };

  if (flags.json) {
    console.log(JSON.stringify({ snapshot, npm, a2a, share, moltbook }, null, 2));
    return;
  }

  printHeader(snapshot);
  printNpm(npm);
  printA2A(a2a);
  printShare(share);
  printMoltbook(moltbook);
}

function printHelp() {
  console.log("Usage:");
  console.log("  viveworker stats [--json] [--pkg <name>]");
  console.log("");
  console.log("Aggregates adoption / usage signals:");
  console.log("  - npm downloads (last 7d / prev 7d)");
  console.log("  - A2A relay stats (global + your user)");
  console.log("  - Share worker file count + quota");
  console.log("  - Moltbook inbox / verify history / scout activity (local)");
  console.log("");
  console.log("Credentials for the A2A and share sections come from ~/.viveworker/a2a.env.");
  console.log("Missing credentials just skip those sections — npm + moltbook-local still work.");
}

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

async function fetchNpm(pkgName) {
  // Range endpoint returns daily breakdown for last 30 days so we can compute
  // both week-over-week totals AND identify spike days (correlated with
  // publish events in the registry packument).
  const rangeUrl = `https://api.npmjs.org/downloads/range/last-month/${encodeURIComponent(pkgName)}`;
  const range = await fetchJsonWithTimeout(rangeUrl);

  const daily = Array.isArray(range?.downloads) ? range.downloads : [];
  if (daily.length === 0) {
    return { pkgName, error: "no download data returned" };
  }

  // Align "last 7 days" to the trailing 7 entries — npm data lags ~1 day so
  // this is the most recent COMPLETE week rather than the calendar one.
  const last7 = sumDownloads(daily.slice(-7));
  const prev7 = sumDownloads(daily.slice(-14, -7));
  const last30 = sumDownloads(daily);
  const deltaPct = prev7 > 0 ? ((last7 - prev7) / prev7) * 100 : null;

  // Publishes + latest tag from registry. Best-effort — if this fails we
  // still return the download numbers.
  let latestVersion = null;
  let publishCountLast7 = null;
  try {
    const reg = await fetchJsonWithTimeout(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`);
    latestVersion = reg?.["dist-tags"]?.latest || null;
    if (reg?.time && typeof reg.time === "object") {
      const cutoff = Date.now() - WEEK_MS;
      publishCountLast7 = Object.entries(reg.time)
        .filter(([k]) => k !== "created" && k !== "modified")
        .filter(([, ts]) => {
          const t = Date.parse(ts);
          return Number.isFinite(t) && t >= cutoff;
        }).length;
    }
  } catch { /* registry is best-effort */ }

  return {
    pkgName,
    rangeStart: range?.start || null,
    rangeEnd: range?.end || null,
    last7,
    prev7,
    last30,
    deltaPct,
    latestVersion,
    publishCountLast7,
    // Include the last 7 daily points so JSON output can render sparkline
    // externally. Human output shows the total only.
    last7Daily: daily.slice(-7),
  };
}

function sumDownloads(entries) {
  let s = 0;
  for (const e of entries) s += Number(e?.downloads) || 0;
  return s;
}

function printNpm(npm) {
  console.log("\n\x1b[1m📦 npm\x1b[0m");
  if (npm.error) {
    console.log(`  error: ${npm.error}`);
    return;
  }
  const deltaStr = formatDelta(npm.deltaPct);
  console.log(`  package           ${npm.pkgName}${npm.latestVersion ? ` @ ${npm.latestVersion}` : ""}`);
  console.log(`  last 7 days       ${String(npm.last7).padStart(6)} downloads  (${npm.rangeEnd ? dateOnly(npm.rangeEnd) : "?"} back)`);
  console.log(`  prev 7 days       ${String(npm.prev7).padStart(6)} downloads  (${deltaStr})`);
  console.log(`  last 30 days      ${String(npm.last30).padStart(6)} downloads`);
  if (npm.publishCountLast7 != null) {
    console.log(`  publishes last 7d ${String(npm.publishCountLast7).padStart(6)}  (each publish inflates mirror fetches)`);
  }
  console.log(`  caveat            npm totals are heavily mirror-driven; each new`);
  console.log(`                    version triggers ~100 mirror re-fetches.`);
}

// ---------------------------------------------------------------------------
// A2A relay
// ---------------------------------------------------------------------------

async function fetchA2A(creds) {
  const relayUrl = creds?.relayUrl || DEFAULT_A2A_RELAY_URL;

  // Global stats are public; always fetch.
  const globalRes = await fetchJsonWithTimeout(`${relayUrl}/stats/global`);

  // Per-user stats need an API key; skip silently when credentials are absent.
  let user = null;
  if (creds?.userId && creds?.apiKey) {
    try {
      user = await fetchJsonWithTimeout(`${relayUrl}/stats/${encodeURIComponent(creds.userId)}`, {
        headers: { "x-a2a-key": creds.apiKey },
      });
    } catch (err) {
      user = { error: err.message };
    }
  }

  return { relayUrl, global: globalRes, user };
}

function printA2A(a2a) {
  console.log("\n\x1b[1m🛰  a2a relay\x1b[0m");
  if (a2a.error) {
    console.log(`  error: ${a2a.error}`);
    return;
  }
  console.log(`  endpoint          ${a2a.relayUrl}`);
  const g = a2a.global || {};
  console.log(`  global users      ${String(g.totalUsers ?? "?").padStart(6)}`);
  if (g.last30d) {
    console.log(`  global last 30d   received ${g.last30d.received}, completed ${g.last30d.completed}, failed ${g.last30d.failed}, rejected ${g.last30d.rejected}, canceled ${g.last30d.canceled}`);
  }

  if (!a2a.user) {
    console.log(`  your user         (credentials missing — run 'viveworker a2a setup')`);
    return;
  }
  if (a2a.user.error) {
    console.log(`  your user         error: ${a2a.user.error}`);
    return;
  }
  const u = a2a.user;
  if (u.last30d) {
    console.log(`  your last 30d     received ${u.last30d.received}, completed ${u.last30d.completed}, failed ${u.last30d.failed}, rejected ${u.last30d.rejected}, canceled ${u.last30d.canceled}`);
  }
  if (u.allTime) {
    console.log(`  your all time     received ${u.allTime.received}, completed ${u.allTime.completed}, failed ${u.allTime.failed}, rejected ${u.allTime.rejected}, canceled ${u.allTime.canceled}`);
  }
}

// ---------------------------------------------------------------------------
// Share worker
// ---------------------------------------------------------------------------

async function fetchShare(creds) {
  if (!creds?.userId || !creds?.apiKey) {
    return { skipped: "credentials missing" };
  }
  const shareUrl = creds.shareUrl || DEFAULT_SHARE_URL;
  const body = await fetchJsonWithTimeout(`${shareUrl}/api/list`, {
    headers: { "x-a2a-user": creds.userId, "x-a2a-key": creds.apiKey },
  });
  const items = Array.isArray(body?.items) ? body.items : [];
  return {
    shareUrl,
    count: items.length,
    quota: body?.quota || null,
    withPassword: items.filter((i) => i.hasPassword).length,
    withPrice:    items.filter((i) => i.price).length,
  };
}

function printShare(share) {
  console.log("\n\x1b[1m🔗 share worker\x1b[0m");
  if (share.error) {
    console.log(`  error: ${share.error}`);
    return;
  }
  if (share.skipped) {
    console.log(`  (${share.skipped})`);
    return;
  }
  console.log(`  endpoint          ${share.shareUrl}`);
  console.log(`  live files        ${String(share.count).padStart(6)}`);
  if (share.quota) {
    const usedKb = (share.quota.bytes / 1024).toFixed(1);
    const maxKb = (share.quota.maxBytes / 1024).toFixed(0);
    const pct = share.quota.maxBytes > 0 ? (share.quota.bytes / share.quota.maxBytes * 100).toFixed(1) : "0.0";
    console.log(`  quota (bytes)     ${usedKb.padStart(6)} / ${maxKb} KB  (${pct}%)`);
    console.log(`  quota (files)     ${String(share.quota.count).padStart(6)} / ${share.quota.maxCount}`);
  }
  if (share.withPassword || share.withPrice) {
    console.log(`  gated             ${share.withPassword} password, ${share.withPrice} paid`);
  }
}

// ---------------------------------------------------------------------------
// Moltbook local
// ---------------------------------------------------------------------------

async function fetchMoltbookLocal() {
  const [inbox, verify, scout] = await Promise.all([
    readInboxDirStats().catch((err) => ({ error: err.message })),
    readVerifyHistoryStats().catch((err) => ({ error: err.message })),
    readScoutStateStats().catch((err) => ({ error: err.message })),
  ]);
  return { inbox, verify, scout };
}

async function readInboxDirStats() {
  let entries;
  try {
    entries = await fs.readdir(MOLTBOOK_INBOX_DIR);
  } catch {
    return { total: 0, configured: false };
  }

  const items = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(MOLTBOOK_INBOX_DIR, name), "utf8");
      items.push(JSON.parse(raw));
    } catch { /* corrupt file; skip */ }
  }

  const now = Date.now();
  const last7d = items.filter((i) => withinMs(now, i.createdAt, WEEK_MS)).length;
  const last30d = items.filter((i) => withinMs(now, i.createdAt, MONTH_MS)).length;

  const byStatus = {};
  for (const item of items) {
    const k = item.status || "unknown";
    byStatus[k] = (byStatus[k] || 0) + 1;
  }

  return {
    configured: true,
    total: items.length,
    last7d,
    last30d,
    byStatus,
  };
}

async function readVerifyHistoryStats() {
  let content;
  try {
    content = await fs.readFile(MOLTBOOK_VERIFY_HISTORY, "utf8");
  } catch {
    return { total: 0, configured: false };
  }

  const lines = content.split(/\r?\n/).filter(Boolean);
  const entries = [];
  for (const l of lines) {
    try { entries.push(JSON.parse(l)); } catch { /* skip */ }
  }

  const now = Date.now();
  const last7d = entries.filter((e) => withinMs(now, e.ts, WEEK_MS)).length;

  const outcomes = {};
  for (const e of entries) {
    const k = e.outcome || "unknown";
    outcomes[k] = (outcomes[k] || 0) + 1;
  }

  // Solver success == solver returned an answer AND that answer verified.
  // That's "solver-verified". Everything else either fell back to LLM or
  // failed outright. Rate is computed against the universe of attempts.
  const solverVerified = outcomes["solver-verified"] || 0;
  const llmVerified = outcomes["llm-verified"] || 0;
  const total = entries.length;
  const solverSuccessRate = total > 0 ? (solverVerified / total) * 100 : null;
  const combinedSuccessRate = total > 0 ? ((solverVerified + llmVerified) / total) * 100 : null;

  return {
    configured: true,
    total,
    last7d,
    outcomes,
    solverSuccessRate,
    combinedSuccessRate,
  };
}

async function readScoutStateStats() {
  let content;
  try {
    content = await fs.readFile(MOLTBOOK_SCOUT_STATE, "utf8");
  } catch {
    return { configured: false };
  }
  let state;
  try {
    state = JSON.parse(content);
  } catch {
    return { configured: false, error: "scout-state.json is corrupt" };
  }

  const seen = state.seenPostIds || {};
  const seenCount = Object.keys(seen).length;

  const outcomes = {};
  const now = Date.now();
  const last7dCounts = { proposed: 0, avoid_skipped: 0, already_replied: 0, other: 0 };
  for (const v of Object.values(seen)) {
    const o = v?.outcome || "unknown";
    outcomes[o] = (outcomes[o] || 0) + 1;
    if (withinMs(now, v?.ts, WEEK_MS)) {
      if (o === "proposed") last7dCounts.proposed += 1;
      else if (o === "avoid-skipped") last7dCounts.avoid_skipped += 1;
      else if (o === "already-replied") last7dCounts.already_replied += 1;
      else last7dCounts.other += 1;
    }
  }

  return {
    configured: true,
    sentToday: Number(state.sentToday) || 0,
    day: state.day || null,
    totalSeen: seenCount,
    outcomes,
    last7d: last7dCounts,
  };
}

function printMoltbook(mb) {
  console.log("\n\x1b[1m💬 moltbook (local)\x1b[0m");
  if (mb.error) {
    console.log(`  error: ${mb.error}`);
    return;
  }

  const inbox = mb.inbox || {};
  if (!inbox.configured) {
    console.log("  inbox             (moltbook-inbox/ not present)");
  } else {
    console.log(`  inbox total       ${String(inbox.total).padStart(6)}  (last 7d ${inbox.last7d}, last 30d ${inbox.last30d})`);
    if (inbox.byStatus && Object.keys(inbox.byStatus).length > 0) {
      const parts = Object.entries(inbox.byStatus).map(([k, v]) => `${k} ${v}`);
      console.log(`  inbox by status   ${parts.join(", ")}`);
    }
  }

  const verify = mb.verify || {};
  if (!verify.configured) {
    console.log("  verify history    (moltbook-verify-history.jsonl not present)");
  } else {
    const solverPct = verify.solverSuccessRate != null ? `${verify.solverSuccessRate.toFixed(1)}%` : "n/a";
    const combinedPct = verify.combinedSuccessRate != null ? `${verify.combinedSuccessRate.toFixed(1)}%` : "n/a";
    console.log(`  verify attempts   ${String(verify.total).padStart(6)}  (last 7d ${verify.last7d})`);
    console.log(`  solver-verified   ${solverPct}  |  solver+LLM combined: ${combinedPct}`);
    if (verify.outcomes && Object.keys(verify.outcomes).length > 0) {
      const parts = Object.entries(verify.outcomes).map(([k, v]) => `${k} ${v}`);
      console.log(`  by outcome        ${parts.join(", ")}`);
    }
  }

  const scout = mb.scout || {};
  if (!scout.configured) {
    console.log("  scout             (moltbook-scout-state.json not present)");
  } else {
    console.log(`  scout sent today  ${String(scout.sentToday).padStart(6)}${scout.day ? `  (day=${scout.day})` : ""}`);
    console.log(`  scout seen total  ${String(scout.totalSeen).padStart(6)}`);
    console.log(`  scout last 7d     proposed ${scout.last7d.proposed}, avoid-skipped ${scout.last7d.avoid_skipped}, already-replied ${scout.last7d.already_replied}`);
  }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function printHeader(snap) {
  const ts = snap.timestamp.slice(0, 19).replace("T", " ");
  const userPart = snap.userId ? `  |  userId: ${snap.userId}` : "";
  console.log(`\x1b[1mviveworker stats\x1b[0m — snapshot ${ts}Z${userPart}`);
}

// ---------------------------------------------------------------------------
// Credentials (read from ~/.viveworker/a2a.env, reuse share-cli's shape)
// ---------------------------------------------------------------------------

async function loadCredentialsOrNull() {
  let text;
  try {
    text = await fs.readFile(A2A_ENV_FILE, "utf8");
  } catch {
    return null;
  }
  const apiKey = envValue(text, "A2A_API_KEY");
  const userId = envValue(text, "A2A_RELAY_USER_ID");
  if (!apiKey || !userId) return null;
  const relayUrl = (process.env.A2A_RELAY_URL || envValue(text, "A2A_RELAY_URL") || DEFAULT_A2A_RELAY_URL).replace(/\/$/u, "");
  const shareUrl = (process.env.VIVEWORKER_SHARE_URL || envValue(text, "VIVEWORKER_SHARE_URL") || DEFAULT_SHARE_URL).replace(/\/$/u, "");
  return { apiKey, userId, relayUrl, shareUrl };
}

function envValue(text, key) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === key) return trimmed.slice(eq + 1);
  }
  return "";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[arg.slice(2)] = args[++i];
      } else {
        flags[arg.slice(2)] = true;
      }
    } else if (arg.startsWith("-")) {
      flags[arg.slice(1)] = true;
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

async function fetchJsonWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${url} → ${res.status}${text ? ": " + truncate(text, 120) : ""}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${url} returned non-JSON (${truncate(text, 80)})`);
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`timeout after ${FETCH_TIMEOUT_MS}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function withinMs(nowMs, timestampIsoOrMs, windowMs) {
  if (timestampIsoOrMs == null) return false;
  const t = typeof timestampIsoOrMs === "number" ? timestampIsoOrMs : Date.parse(timestampIsoOrMs);
  if (!Number.isFinite(t)) return false;
  return (nowMs - t) <= windowMs;
}

function formatDelta(deltaPct) {
  if (deltaPct == null) return "delta n/a";
  const sign = deltaPct >= 0 ? "+" : "";
  return `${sign}${deltaPct.toFixed(1)}%`;
}

function dateOnly(iso) {
  // "2026-04-17" from "2026-04-17" or "2026-04-17T..." — defensive in case
  // npm changes the range endpoint format.
  const s = String(iso);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function truncate(s, max) {
  const str = String(s);
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}
