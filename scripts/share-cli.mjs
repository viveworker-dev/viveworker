/**
 * share-cli.mjs — CLI for viveworker's HTML share hosting service.
 *
 * Reads credentials from `~/.viveworker/a2a.env` (same creds as the A2A relay).
 *
 * Commands:
 *   viveworker share upload <file> [--password <pw>] [--expires-days <n>] [--json]
 *   viveworker share list [--json]
 *   viveworker share update <slug> [--password <pw>] [--no-password] [--expires-days <n>] [--json]
 *   viveworker share link <slug> --password <pw> [--ttl-hours <n>] [--json]
 *   viveworker share delete <slug>
 *
 * Environment overrides:
 *   VIVEWORKER_SHARE_URL — share worker base URL (default: https://share.viveworker.com)
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Blob, File } from "node:buffer";

const A2A_ENV_FILE = path.join(os.homedir(), ".viveworker", "a2a.env");
const DEFAULT_SHARE_URL = "https://share.viveworker.com";
const MAX_FILE_SIZE = 5 * 1024 * 1024; // mirror worker

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function runShareCli(args) {
  const cmd = args[0];

  switch (cmd) {
    case "upload":
      return handleUpload(args.slice(1));
    case "list":
      return handleList(args.slice(1));
    case "update":
      return handleUpdate(args.slice(1));
    case "link":
      return handleLink(args.slice(1));
    case "delete":
    case "rm":
      return handleDelete(args.slice(1));
    default:
      printHelp();
      if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") {
        throw new Error(`Unknown command: ${cmd}`);
      }
  }
}

function printHelp() {
  console.log("Commands:");
  console.log("  viveworker share upload <file> [--password <pw>] [--expires-days <n>] [--json]");
  console.log("  viveworker share list [--json]");
  console.log("  viveworker share update <slug> [--password <pw>] [--no-password] [--expires-days <n>] [--json]");
  console.log("  viveworker share link <slug> --password <pw> [--ttl-hours <n>] [--json]");
  console.log("  viveworker share delete <slug>");
  console.log("");
  console.log("Credentials are read from ~/.viveworker/a2a.env (same as `viveworker a2a`).");
}

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------

async function handleUpload(args) {
  const flags = parseFlags(args);
  const filePath = flags._[0];
  if (!filePath) {
    throw new Error("Usage: viveworker share upload <file> [--password <pw>] [--expires-days <n>]");
  }

  const absolute = path.resolve(filePath);
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }
  if (stat.size === 0) {
    throw new Error(`File is empty: ${filePath}`);
  }
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`File too large (${stat.size} bytes, max ${MAX_FILE_SIZE})`);
  }
  const lower = absolute.toLowerCase();
  if (!lower.endsWith(".html") && !lower.endsWith(".htm")) {
    throw new Error(`Only .html / .htm files are accepted. Got: ${path.extname(absolute) || "(no extension)"}`);
  }

  const password = flags["password"] || "";
  const expiresDays = flags["expires-days"] || flags["expiresDays"] || "";

  if (password && password.length > 256) {
    throw new Error("Password too long (max 256 chars)");
  }
  if (expiresDays) {
    const n = Number(expiresDays);
    if (!Number.isFinite(n) || n <= 0 || n > 30) {
      throw new Error("--expires-days must be a number between 1 and 30");
    }
  }

  const { apiKey, userId, shareUrl } = await resolveCredentials();

  const bytes = await fs.readFile(absolute);
  const form = new FormData();
  const blob = new Blob([bytes], { type: "text/html" });
  const file = new File([blob], path.basename(absolute), { type: "text/html" });
  form.set("file", file);
  if (password) form.set("password", password);
  if (expiresDays) form.set("expiresDays", String(expiresDays));

  const res = await fetchWithTimeout(`${shareUrl}/api/upload`, {
    method: "POST",
    headers: {
      "x-a2a-user": userId,
      "x-a2a-key": apiKey,
    },
    body: form,
  }, 60_000);

  const body = await readJson(res);
  if (!res.ok || body.error) {
    throw new Error(formatApiError("Upload", res.status, body));
  }

  if (flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log("");
  console.log(`✅ Uploaded ${body.originalName || path.basename(absolute)} (${formatSize(body.size)})`);
  console.log("");
  console.log(`   ${body.url}`);
  console.log("");
  if (body.hasPassword) console.log(`   🔒 Password-protected`);
  if (body.expiresAtMs) console.log(`   ⏱  Expires ${new Date(body.expiresAtMs).toISOString()}`);
  if (body.hasPassword || body.expiresAtMs) console.log("");
  console.log(`   Slug: ${body.slug}`);
  console.log(`   Delete: viveworker share delete ${body.slug}`);
  if (body.quota) {
    console.log(
      `   Quota: ${formatSize(body.quota.bytes)} / ${formatSize(body.quota.maxBytes)} · ${body.quota.count}/${body.quota.maxCount} files`
    );
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function handleList(args) {
  const flags = parseFlags(args);
  const { apiKey, userId, shareUrl } = await resolveCredentials();

  const res = await fetchWithTimeout(`${shareUrl}/api/list`, {
    method: "GET",
    headers: {
      "x-a2a-user": userId,
      "x-a2a-key": apiKey,
    },
  }, 30_000);

  const body = await readJson(res);
  if (!res.ok || body.error) {
    throw new Error(formatApiError("List", res.status, body));
  }

  const items = body.items || [];

  if (flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (items.length === 0) {
    if (body.quota) {
      console.log(
        `(no uploads yet) — quota: ${formatSize(body.quota.bytes)} / ${formatSize(body.quota.maxBytes)} · ${body.quota.count}/${body.quota.maxCount} files`
      );
    } else {
      console.log("(no uploads yet)");
    }
    return;
  }

  const now = Date.now();
  const quotaLine = body.quota
    ? ` — quota: ${formatSize(body.quota.bytes)} / ${formatSize(body.quota.maxBytes)} · ${body.quota.count}/${body.quota.maxCount} files`
    : "";
  console.log(`\nYour shared files (${items.length})${quotaLine}:\n`);
  for (const item of items) {
    const age = formatRelative(now - (item.createdAtMs || now));
    const size = formatSize(item.size || 0);
    const lockIcon = item.hasPassword ? "🔒" : "  ";
    const expiry = item.expiresAtMs ? ` · exp ${new Date(item.expiresAtMs).toISOString().slice(0, 10)}` : "";
    console.log(`  ${lockIcon} ${item.slug}  ${size.padStart(8)}  ${age.padStart(10)}${expiry}`);
    console.log(`     ${item.url}`);
    if (item.originalName) console.log(`     ${item.originalName}`);
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function handleUpdate(args) {
  const flags = parseFlags(args);
  const slug = flags._[0];
  if (!slug) {
    throw new Error(
      "Usage: viveworker share update <slug> [--password <pw>] [--no-password] [--expires-days <n>]"
    );
  }
  if (!/^[A-Za-z0-9]+$/.test(slug)) {
    throw new Error(`Invalid slug: ${slug}`);
  }

  const hasPassword = Object.prototype.hasOwnProperty.call(flags, "password");
  const hasNoPassword = Object.prototype.hasOwnProperty.call(flags, "no-password");
  const hasExpires = Object.prototype.hasOwnProperty.call(flags, "expires-days") ||
    Object.prototype.hasOwnProperty.call(flags, "expiresDays");

  if (hasPassword && hasNoPassword) {
    throw new Error("Pass either --password OR --no-password, not both");
  }
  if (!hasPassword && !hasNoPassword && !hasExpires) {
    throw new Error(
      "Nothing to update — specify at least one of --password <pw>, --no-password, --expires-days <n>"
    );
  }

  const body = {};

  if (hasPassword) {
    const pw = flags.password;
    if (typeof pw !== "string" || pw.length === 0) {
      throw new Error("--password requires a non-empty value (use --no-password to clear)");
    }
    if (pw.length > 256) {
      throw new Error("Password too long (max 256 chars)");
    }
    body.password = pw;
  } else if (hasNoPassword) {
    body.password = null;
  }

  if (hasExpires) {
    const raw = flags["expires-days"] || flags["expiresDays"];
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 30) {
      throw new Error("--expires-days must be a number between 1 and 30");
    }
    body.expiresDays = n;
  }

  const { apiKey, userId, shareUrl } = await resolveCredentials();

  const res = await fetchWithTimeout(`${shareUrl}/api/share/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-a2a-user": userId,
      "x-a2a-key": apiKey,
    },
    body: JSON.stringify(body),
  }, 30_000);

  const respBody = await readJson(res);
  if (!res.ok || respBody.error) {
    throw new Error(formatApiError("Update", res.status, respBody));
  }

  if (flags.json) {
    console.log(JSON.stringify(respBody, null, 2));
    return;
  }

  console.log("");
  console.log(`✅ Updated ${slug}`);
  console.log("");
  console.log(`   ${respBody.url}`);
  console.log("");
  if (respBody.hasPassword) {
    console.log(`   🔒 Password-protected${hasPassword ? " (existing unlock cookies invalidated)" : ""}`);
  } else if (hasNoPassword) {
    console.log(`   🔓 Password removed`);
  }
  if (respBody.expiresAtMs) {
    console.log(`   ⏱  Expires ${new Date(respBody.expiresAtMs).toISOString()}`);
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// link — mint a short-lived `?t=<token>` URL for handing off a
// password-protected share to another agent without disclosing the password.
//
// The owner keeps the password on their side; the receiver only needs to GET
// the returned URL. Tokens default to 24h, capped at 168h (7d) and capped by
// the share's own `expiresAtMs`. Rotating the password via `share update
// --password ...` invalidates every outstanding token for the slug.
// ---------------------------------------------------------------------------

async function handleLink(args) {
  const flags = parseFlags(args);
  const slug = flags._[0];
  if (!slug) {
    throw new Error("Usage: viveworker share link <slug> --password <pw> [--ttl-hours <n>] [--json]");
  }
  if (!/^[A-Za-z0-9]+$/.test(slug)) {
    throw new Error(`Invalid slug: ${slug}`);
  }

  const password = flags.password;
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("--password is required (the share's current password)");
  }
  if (password.length > 256) {
    throw new Error("Password too long (max 256 chars)");
  }

  const hasTtl = Object.prototype.hasOwnProperty.call(flags, "ttl-hours") ||
    Object.prototype.hasOwnProperty.call(flags, "ttlHours");
  let ttlHours;
  if (hasTtl) {
    const raw = flags["ttl-hours"] || flags["ttlHours"];
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 168) {
      throw new Error("--ttl-hours must be a number between 1 and 168");
    }
    ttlHours = n;
  }

  const { apiKey, userId, shareUrl } = await resolveCredentials();

  const payload = { password };
  if (ttlHours !== undefined) payload.ttlHours = ttlHours;

  const res = await fetchWithTimeout(`${shareUrl}/v/${encodeURIComponent(slug)}/unlock.json`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-a2a-user": userId,
      "x-a2a-key": apiKey,
    },
    body: JSON.stringify(payload),
  }, 30_000);

  const body = await readJson(res);
  if (!res.ok || body.error) {
    throw new Error(formatApiError("Link", res.status, body));
  }

  if (flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log("");
  console.log(`🔗 ${body.url}`);
  console.log("");
  if (body.expiresAtMs) {
    console.log(`   ⏱  Expires ${new Date(body.expiresAtMs).toISOString()}`);
  }
  console.log(`   Note: rotating the password via 'share update --password' invalidates this link.`);
  console.log("");
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

async function handleDelete(args) {
  const flags = parseFlags(args);
  const slug = flags._[0];
  if (!slug) {
    throw new Error("Usage: viveworker share delete <slug>");
  }
  if (!/^[A-Za-z0-9]+$/.test(slug)) {
    throw new Error(`Invalid slug: ${slug}`);
  }

  const { apiKey, userId, shareUrl } = await resolveCredentials();

  const res = await fetchWithTimeout(`${shareUrl}/api/share/${encodeURIComponent(slug)}`, {
    method: "DELETE",
    headers: {
      "x-a2a-user": userId,
      "x-a2a-key": apiKey,
    },
  }, 30_000);

  const body = await readJson(res);
  if (!res.ok || body.error) {
    throw new Error(formatApiError("Delete", res.status, body));
  }

  if (flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`✅ Deleted ${slug}`);
}

function formatApiError(op, status, body) {
  const code = body?.error || "";
  switch (code) {
    case "rate-limited":
      return `${op} failed (${status}): rate limit — ${body.limit}/${Math.round((body.windowSec || 3600) / 60)}m, retry in ${body.retryAfterSec}s`;
    case "quota-exceeded":
      return `${op} failed (${status}): quota exceeded — used ${formatSize(body.currentBytes)} of ${formatSize(body.maxTotalBytes)}, file is ${formatSize(body.fileBytes)}`;
    case "file-count-exceeded":
      return `${op} failed (${status}): file count exceeded — ${body.current}/${body.max}. Delete something first.`;
    case "file-too-large":
      return `${op} failed (${status}): file too large (max ${formatSize(body.maxBytes)})`;
    case "expired-requires-expiresDays":
      return `${op} failed (${status}): share is expired — pass --expires-days <1-${body.maxDays || 30}> to revive it`;
    case "object-missing":
      return `${op} failed (${status}): the R2 body is gone (90-day lifecycle reaped it). Re-upload instead.`;
    case "invalid-password":
      return `${op} failed (${status}): wrong password`;
    case "not-password-protected":
      return `${op} failed (${status}): share has no password — no link token needed, just share the URL directly`;
    case "invalid-ttlHours":
      return `${op} failed (${status}): --ttl-hours must be between 1 and ${body.maxHours || 168}`;
    default:
      return `${op} failed (${status}): ${code || body?.statusText || "unknown error"}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveCredentials() {
  let text;
  try {
    text = await fs.readFile(A2A_ENV_FILE, "utf8");
  } catch {
    throw new Error(
      `Missing ${A2A_ENV_FILE}.\n` +
      `Run 'viveworker a2a setup --user-id <id>' first to provision credentials.`
    );
  }

  const apiKey = envValue(text, "A2A_API_KEY");
  const userId = envValue(text, "A2A_RELAY_USER_ID");
  if (!apiKey || !userId) {
    throw new Error(
      `A2A_API_KEY and/or A2A_RELAY_USER_ID missing from ${A2A_ENV_FILE}.\n` +
      `Re-run 'viveworker a2a setup --user-id <id>'.`
    );
  }

  const shareUrl = (
    process.env.VIVEWORKER_SHARE_URL ||
    envValue(text, "VIVEWORKER_SHARE_URL") ||
    DEFAULT_SHARE_URL
  ).replace(/\/$/u, "");

  return { apiKey, userId, shareUrl };
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
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatRelative(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
