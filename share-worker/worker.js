/**
 * viveworker-share — Cloudflare Worker for sharing HTML files.
 *
 * Features:
 *   - Upload .html / .htm files (auth: X-A2A-User + X-A2A-Key, reuses A2A relay users)
 *   - Per-upload random slug URL (https://share.viveworker.com/v/<slug>)
 *   - Optional PBKDF2 password protection
 *   - Robot / crawler blocking (X-Robots-Tag + robots.txt)
 *   - Owner-only delete via same A2A credentials
 *
 * Bindings (see wrangler.toml):
 *   USERS_KV      — A2A relay's KV (read-only), used to validate user credentials
 *   SHARE_KV      — this service's KV (metadata per upload, per-user indexes)
 *   SHARE_FILES   — R2 bucket, stores the HTML bodies
 *   SHARE_SECRET  — env var, signing key for unlock cookies
 *
 * KV schema:
 *   share:<slug>                        → metadata JSON
 *   share_stats:<userId>                → { bytes, count, files: [slug...], rateWindow: [ts...] }
 *
 * R2 schema:
 *   <slug>                              → raw HTML bytes
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 5 * 1024 * 1024;     // 5 MB per file (also the per-user cap — see below)
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;   // 5 MB total per user
const MAX_FILES = 10;                      // 10 live uploads per user
const RATE_LIMIT_PER_HOUR = 10;            // 10 uploads / rolling hour
const RATE_WINDOW_MS = 60 * 60 * 1000;     // rolling 1 hour window
const DEFAULT_EXPIRES_DAYS = 30;           // auto-expire after 30 days when client omits
const SLUG_LENGTH = 16;
const PBKDF2_ITERATIONS = 10_000;
const PBKDF2_SALT_BYTES = 16;
const UNLOCK_COOKIE_NAME = "share_unlock";
const UNLOCK_COOKIE_MAX_AGE_SEC = 7 * 24 * 60 * 60; // 7 days

const SECURITY_HEADERS = {
  "x-robots-tag": "noindex, nofollow, noarchive, nosnippet",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      console.error("[share-worker] unhandled", err?.stack || err);
      return jsonResponse({ error: "internal-error" }, 500);
    }
  },
};

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method.toUpperCase();

  // CORS preflight for CLI usage
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type, x-a2a-user, x-a2a-key",
        "access-control-max-age": "86400",
        ...SECURITY_HEADERS,
      },
    });
  }

  // robots.txt — disallow everything
  if (pathname === "/robots.txt" && method === "GET") {
    return textResponse(
      "User-agent: *\nDisallow: /\n",
      200,
      { "content-type": "text/plain; charset=utf-8" }
    );
  }

  // Landing page
  if (pathname === "/" && method === "GET") {
    return htmlResponse(renderLanding(), 200);
  }

  // Health check
  if (pathname === "/healthz" && method === "GET") {
    return jsonResponse({ ok: true });
  }

  // API — upload
  if (pathname === "/api/upload" && method === "POST") {
    return await handleUpload(request, env);
  }

  // API — list user's uploads
  if (pathname === "/api/list" && method === "GET") {
    return await handleList(request, env);
  }

  // API — delete by slug
  const deleteMatch = pathname.match(/^\/api\/share\/([A-Za-z0-9]+)$/);
  if (deleteMatch && method === "DELETE") {
    return await handleDelete(request, env, deleteMatch[1]);
  }

  // Unlock form submit
  const unlockMatch = pathname.match(/^\/v\/([A-Za-z0-9]+)\/unlock$/);
  if (unlockMatch && method === "POST") {
    return await handleUnlock(request, env, unlockMatch[1]);
  }

  // Render
  const viewMatch = pathname.match(/^\/v\/([A-Za-z0-9]+)\/?$/);
  if (viewMatch && (method === "GET" || method === "HEAD")) {
    return await handleView(request, env, viewMatch[1], method === "HEAD");
  }

  return textResponse("Not Found", 404);
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

async function handleUpload(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return jsonResponse({ error: "expected-multipart-form-data" }, 400);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: "invalid-form-data" }, 400);
  }

  const file = form.get("file");
  if (!file || typeof file === "string") {
    return jsonResponse({ error: "missing-file-field" }, 400);
  }

  // Enforce size
  if (file.size > MAX_FILE_SIZE) {
    return jsonResponse({ error: "file-too-large", maxBytes: MAX_FILE_SIZE }, 413);
  }
  if (file.size <= 0) {
    return jsonResponse({ error: "empty-file" }, 400);
  }

  // Enforce extension
  const originalName = sanitizeFilename(file.name || "upload.html");
  const lower = originalName.toLowerCase();
  if (!lower.endsWith(".html") && !lower.endsWith(".htm")) {
    return jsonResponse({ error: "unsupported-extension", allowed: [".html", ".htm"] }, 400);
  }

  // Enforce declared content-type (best effort)
  const declaredType = (file.type || "").toLowerCase();
  if (declaredType && !declaredType.includes("html")) {
    return jsonResponse({ error: "unsupported-content-type", declared: declaredType }, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Sniff first non-whitespace bytes for "<" (HTML start)
  if (!looksLikeHtml(bytes)) {
    return jsonResponse({ error: "not-html-content" }, 400);
  }

  // Optional password
  const passwordRaw = form.get("password");
  let passwordHash = null;
  let passwordSalt = null;
  if (typeof passwordRaw === "string" && passwordRaw.length > 0) {
    if (passwordRaw.length > 256) {
      return jsonResponse({ error: "password-too-long" }, 400);
    }
    const saltBuf = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
    passwordSalt = bytesToBase64(saltBuf);
    passwordHash = await hashPassword(passwordRaw, saltBuf);
  }

  // Optional expiry (in days). Omitted → default to DEFAULT_EXPIRES_DAYS.
  let expiresAtMs;
  const expiresRaw = form.get("expiresDays");
  const now = Date.now();
  if (typeof expiresRaw === "string" && expiresRaw.length > 0) {
    const days = Number(expiresRaw);
    if (!Number.isFinite(days) || days <= 0 || days > 365) {
      return jsonResponse({ error: "invalid-expiresDays" }, 400);
    }
    expiresAtMs = now + Math.floor(days * 86400 * 1000);
  } else {
    expiresAtMs = now + DEFAULT_EXPIRES_DAYS * 86400 * 1000;
  }

  // Load user stats (quota + rate-limit state). A fresh blob is returned when
  // the key is missing — existing smoke-test slugs from the legacy
  // `share_user:<userId>:<slug>` index won't surface here, but they expire
  // naturally via their KV TTL, so no migration is needed.
  const stats = await loadUserStats(env, user.userId);

  // Rate limit (rolling 1-hour window).
  const rateWindow = (stats.rateWindow || []).filter((ts) => now - ts < RATE_WINDOW_MS);
  if (rateWindow.length >= RATE_LIMIT_PER_HOUR) {
    const retryAfterSec = Math.max(1, Math.ceil((rateWindow[0] + RATE_WINDOW_MS - now) / 1000));
    return jsonResponse(
      { error: "rate-limited", limit: RATE_LIMIT_PER_HOUR, windowSec: RATE_WINDOW_MS / 1000, retryAfterSec },
      429,
      { "retry-after": String(retryAfterSec) },
    );
  }

  // Per-user file count + total bytes.
  if ((stats.count || 0) >= MAX_FILES) {
    return jsonResponse(
      { error: "file-count-exceeded", max: MAX_FILES, current: stats.count },
      409,
    );
  }
  if ((stats.bytes || 0) + file.size > MAX_TOTAL_BYTES) {
    return jsonResponse(
      {
        error: "quota-exceeded",
        maxTotalBytes: MAX_TOTAL_BYTES,
        currentBytes: stats.bytes || 0,
        fileBytes: file.size,
      },
      413,
    );
  }

  const slug = await generateUniqueSlug(env.SHARE_KV);
  const createdAtMs = now;

  const metadata = {
    slug,
    userId: user.userId,
    originalName,
    size: file.size,
    createdAtMs,
    expiresAtMs,
    passwordHash,
    passwordSalt,
  };

  // Write R2 first, then KV (so we never leave metadata pointing to a missing object).
  await env.SHARE_FILES.put(slug, bytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });

  const kvOpts = expiresAtMs ? { expiration: Math.floor(expiresAtMs / 1000) } : undefined;
  await env.SHARE_KV.put(`share:${slug}`, JSON.stringify(metadata), kvOpts);

  // Update user stats (tracks live files, bytes, rate window). No TTL — this blob
  // survives user file expirations since we also reconcile on GC paths.
  stats.files = Array.isArray(stats.files) ? stats.files : [];
  if (!stats.files.includes(slug)) stats.files.push(slug);
  stats.count = stats.files.length;
  stats.bytes = (stats.bytes || 0) + file.size;
  rateWindow.push(now);
  stats.rateWindow = rateWindow;
  await saveUserStats(env, user.userId, stats);

  const origin = new URL(request.url).origin;
  return jsonResponse({
    ok: true,
    slug,
    url: `${origin}/v/${slug}`,
    createdAtMs,
    expiresAtMs,
    hasPassword: !!passwordHash,
    size: file.size,
    originalName,
    quota: {
      bytes: stats.bytes,
      maxBytes: MAX_TOTAL_BYTES,
      count: stats.count,
      maxCount: MAX_FILES,
    },
  });
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

async function handleList(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  const stats = await loadUserStats(env, user.userId);
  const origin = new URL(request.url).origin;

  const items = [];
  const liveSlugs = [];
  let liveBytes = 0;
  let changed = false;

  for (const slug of stats.files || []) {
    const raw = await env.SHARE_KV.get(`share:${slug}`);
    if (!raw) {
      // Slug expired (KV auto-TTL) — drop from stats.
      changed = true;
      continue;
    }
    let meta;
    try { meta = JSON.parse(raw); } catch {
      changed = true;
      continue;
    }
    liveSlugs.push(slug);
    liveBytes += meta.size || 0;
    items.push({
      slug,
      url: `${origin}/v/${slug}`,
      originalName: meta.originalName,
      size: meta.size,
      createdAtMs: meta.createdAtMs,
      expiresAtMs: meta.expiresAtMs || null,
      hasPassword: !!meta.passwordHash,
    });
  }

  // Reconcile stats blob if expired entries were cleaned up.
  if (changed || liveBytes !== stats.bytes || liveSlugs.length !== stats.count) {
    stats.files = liveSlugs;
    stats.count = liveSlugs.length;
    stats.bytes = liveBytes;
    await saveUserStats(env, user.userId, stats);
  }

  items.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  return jsonResponse({
    ok: true,
    items,
    quota: {
      bytes: stats.bytes,
      maxBytes: MAX_TOTAL_BYTES,
      count: stats.count,
      maxCount: MAX_FILES,
    },
  });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

async function handleDelete(request, env, slug) {
  const user = await authenticate(request, env);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  const raw = await env.SHARE_KV.get(`share:${slug}`);
  if (!raw) return jsonResponse({ error: "not-found" }, 404);
  let meta;
  try { meta = JSON.parse(raw); } catch {
    return jsonResponse({ error: "corrupt-metadata" }, 500);
  }
  if (meta.userId !== user.userId) {
    return jsonResponse({ error: "forbidden" }, 403);
  }

  // R2 first, then metadata key.
  await env.SHARE_FILES.delete(slug).catch(() => {});
  await env.SHARE_KV.delete(`share:${slug}`);

  // Update user stats.
  const stats = await loadUserStats(env, user.userId);
  const before = (stats.files || []).length;
  stats.files = (stats.files || []).filter((s) => s !== slug);
  if (stats.files.length !== before) {
    stats.bytes = Math.max(0, (stats.bytes || 0) - (meta.size || 0));
    stats.count = stats.files.length;
    await saveUserStats(env, user.userId, stats);
  }

  return jsonResponse({ ok: true, slug });
}

// ---------------------------------------------------------------------------
// View / render
// ---------------------------------------------------------------------------

async function handleView(request, env, slug, headOnly = false) {
  const meta = await loadMetadata(env, slug);
  if (!meta) return textResponse("Not Found", 404, SECURITY_HEADERS);

  if (meta.expiresAtMs && Date.now() > meta.expiresAtMs) {
    return textResponse("Expired", 410, SECURITY_HEADERS);
  }

  // Password gate
  if (meta.passwordHash) {
    const cookies = parseCookies(request.headers.get("cookie") || "");
    const token = cookies[UNLOCK_COOKIE_NAME] || "";
    const ok = await verifyUnlockToken(token, slug, env);
    if (!ok) {
      return headOnly
        ? new Response(null, { status: 401, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } })
        : htmlResponse(renderUnlockForm(slug, false), 401);
    }
  }

  // For HEAD, skip R2 fetch — return headers only.
  if (headOnly) {
    return new Response(null, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        "content-length": String(meta.size || 0),
        ...SECURITY_HEADERS,
      },
    });
  }

  const obj = await env.SHARE_FILES.get(slug);
  if (!obj) return textResponse("Gone", 410, SECURITY_HEADERS);

  const body = await obj.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      ...SECURITY_HEADERS,
    },
  });
}

async function handleUnlock(request, env, slug) {
  const meta = await loadMetadata(env, slug);
  if (!meta) return textResponse("Not Found", 404, SECURITY_HEADERS);
  if (!meta.passwordHash) {
    // Not password-protected — just redirect
    return Response.redirect(new URL(`/v/${slug}`, request.url).toString(), 303);
  }
  if (meta.expiresAtMs && Date.now() > meta.expiresAtMs) {
    return textResponse("Expired", 410, SECURITY_HEADERS);
  }

  const form = await request.formData().catch(() => null);
  const submitted = form?.get("password");
  if (typeof submitted !== "string" || submitted.length === 0) {
    return htmlResponse(renderUnlockForm(slug, true), 400);
  }

  const saltBuf = base64ToBytes(meta.passwordSalt);
  const candidate = await hashPassword(submitted, saltBuf);
  const ok = timingSafeEqual(candidate, meta.passwordHash);
  if (!ok) {
    return htmlResponse(renderUnlockForm(slug, true), 401);
  }

  const token = await signUnlockToken(slug, env);
  const setCookie = [
    `${UNLOCK_COOKIE_NAME}=${token}`,
    `Path=/v/${slug}`,
    `Max-Age=${UNLOCK_COOKIE_MAX_AGE_SEC}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");

  return new Response(null, {
    status: 303,
    headers: {
      location: `/v/${slug}`,
      "set-cookie": setCookie,
      ...SECURITY_HEADERS,
    },
  });
}

// ---------------------------------------------------------------------------
// Auth — validates request against A2A relay's user records (USERS_KV)
// ---------------------------------------------------------------------------

async function authenticate(request, env) {
  const userId = (request.headers.get("x-a2a-user") || "").trim();
  const apiKey = (request.headers.get("x-a2a-key") || "").trim();
  if (!userId || !apiKey) return null;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(userId)) return null;

  const raw = await env.USERS_KV.get(`user:${userId}`);
  if (!raw) return null;
  let record;
  try { record = JSON.parse(raw); } catch { return null; }

  // Constant-time comparison — `!==` short-circuits on the first mismatched
  // byte, leaking a (tiny) timing signal that an attacker could use to guess
  // the API key byte-by-byte.
  if (!record.a2aApiKey || !timingSafeEqual(record.a2aApiKey, apiKey)) return null;
  return { userId, record };
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

async function loadMetadata(env, slug) {
  if (!/^[A-Za-z0-9]{1,64}$/.test(slug)) return null;
  const raw = await env.SHARE_KV.get(`share:${slug}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Per-user stats blob — tracks quota usage + rolling rate-limit window.
//
// Shape:
//   { bytes: number, count: number, files: [slug...], rateWindow: [ts...] }
//
// Stored at KV key `share_stats:<userId>`. Written on upload / delete; read on
// every upload, list, and delete. Keeping everything in one blob means each
// upload still fits in 2 KV writes (share:<slug> + share_stats:<userId>), so
// the free-tier write budget is unchanged vs. the old per-slug index scheme.
// ---------------------------------------------------------------------------

async function loadUserStats(env, userId) {
  const raw = await env.SHARE_KV.get(`share_stats:${userId}`);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      return {
        bytes: Number(parsed.bytes) || 0,
        count: Number(parsed.count) || 0,
        files: Array.isArray(parsed.files) ? parsed.files.slice() : [],
        rateWindow: Array.isArray(parsed.rateWindow) ? parsed.rateWindow.slice() : [],
      };
    } catch {
      // Corrupt — fall through to a fresh blob.
    }
  }
  return { bytes: 0, count: 0, files: [], rateWindow: [] };
}

async function saveUserStats(env, userId, stats) {
  // Prune rate window before persisting so it can't grow unbounded.
  const cutoff = Date.now() - RATE_WINDOW_MS;
  const trimmed = {
    bytes: Math.max(0, Number(stats.bytes) || 0),
    count: Math.max(0, Number(stats.count) || 0),
    files: Array.isArray(stats.files) ? stats.files : [],
    rateWindow: Array.isArray(stats.rateWindow) ? stats.rateWindow.filter((ts) => ts > cutoff) : [],
  };
  await env.SHARE_KV.put(`share_stats:${userId}`, JSON.stringify(trimmed));
}

async function generateUniqueSlug(kv) {
  // 16 chars base62 -> plenty of entropy. Try a few times just in case.
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = randomBase62(SLUG_LENGTH);
    const existing = await kv.get(`share:${slug}`);
    if (!existing) return slug;
  }
  throw new Error("failed-to-allocate-slug");
}

function randomBase62(length) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function sanitizeFilename(name) {
  const basename = String(name).split(/[\\/]/u).pop() || "upload.html";
  return basename.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 128);
}

function looksLikeHtml(bytes) {
  // Scan first 1KB, skip whitespace/BOM, expect "<"
  const limit = Math.min(1024, bytes.length);
  let i = 0;
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    i = 3; // UTF-8 BOM
  }
  while (i < limit) {
    const b = bytes[i];
    if (b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D) { i++; continue; }
    return b === 0x3C; // '<'
  }
  return false;
}

// ---------------------------------------------------------------------------
// Password hashing (PBKDF2-SHA-256)
// ---------------------------------------------------------------------------

async function hashPassword(password, saltBuf) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBuf, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToBase64(new Uint8Array(bits));
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Unlock cookie — HMAC-SHA256(slug, SHARE_SECRET), base64url
// ---------------------------------------------------------------------------

async function signUnlockToken(slug, env) {
  const secret = env.SHARE_SECRET || "";
  if (!secret) throw new Error("SHARE_SECRET not configured");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(slug));
  return bytesToBase64Url(new Uint8Array(sig));
}

async function verifyUnlockToken(token, slug, env) {
  if (!token) return false;
  try {
    const expected = await signUnlockToken(slug, env);
    return timingSafeEqual(token, expected);
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

function textResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

function htmlResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function renderLanding() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>viveworker share</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0b0f14; color: #d7e2ea; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 2rem;
  }
  main { max-width: 540px; text-align: center; }
  h1 { margin: 0 0 0.5rem; font-size: 1.6rem; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0.4rem 0; color: #9cb5c5; }
  code {
    display: inline-block; margin-top: 0.8rem; padding: 0.4rem 0.7rem; font-size: 0.85rem;
    background: #141b24; border: 1px solid #25313d; border-radius: 8px; color: #cdd6df;
  }
</style>
</head>
<body>
<main>
  <h1>viveworker share</h1>
  <p>Private HTML hosting for viveworker users.</p>
  <p>Uploads are performed via the CLI:</p>
  <code>viveworker share upload file.html</code>
</main>
</body>
</html>`;
}

function renderUnlockForm(slug, showError) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Password required</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0b0f14; color: #d7e2ea; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 2rem;
  }
  form {
    width: 100%; max-width: 340px; padding: 1.4rem 1.5rem 1.6rem;
    background: #141b24; border: 1px solid #25313d; border-radius: 14px;
    display: flex; flex-direction: column; gap: 0.8rem;
  }
  h1 { margin: 0; font-size: 1.05rem; font-weight: 600; }
  p { margin: 0; color: #9cb5c5; font-size: 0.88rem; }
  input[type="password"] {
    width: 100%; padding: 0.65rem 0.8rem; border-radius: 8px; border: 1px solid #2d3a48;
    background: #0b0f14; color: #d7e2ea; font: inherit; outline: none;
  }
  input[type="password"]:focus { border-color: #55a7ff; }
  button {
    padding: 0.65rem 0.8rem; border-radius: 8px; border: 0; cursor: pointer;
    background: #2b7fd8; color: #fff; font: inherit; font-weight: 600;
  }
  button:hover { background: #3c8de0; }
  .error { color: #ff7a7a; font-size: 0.85rem; }
</style>
</head>
<body>
<form method="POST" action="/v/${encodeURIComponent(slug)}/unlock" autocomplete="off">
  <h1>Password required</h1>
  <p>This shared page is protected. Enter the password to view.</p>
  <input type="password" name="password" autofocus required />
  ${showError ? '<div class="error">Incorrect password.</div>' : ""}
  <button type="submit">Unlock</button>
</form>
</body>
</html>`;
}
