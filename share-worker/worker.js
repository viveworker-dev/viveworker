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
const RATE_LIMIT_PATCH_PER_HOUR = 10;      // 10 patches / rolling hour (per-user, separate bucket)
const RATE_WINDOW_MS = 60 * 60 * 1000;     // rolling 1 hour window
const DEFAULT_EXPIRES_DAYS = 30;           // auto-expire after 30 days when client omits
const MAX_EXPIRES_DAYS = 30;               // hard cap on expiresDays (upload + PATCH).
                                           // Must stay ≤ R2 bucket lifecycle (currently 90d);
                                           // with re-put on PATCH extension + 60d buffer this
                                           // keeps KV validity aligned with R2 presence in all
                                           // scenarios, including chained PATCH extensions.
const GRACE_PERIOD_MS = 60 * 86400 * 1000; // 60 days. Shares remain in KV past
                                           // `expiresAtMs` for this long, so the owner
                                           // can still un-expire an already-expired
                                           // share via PATCH as long as the R2 body
                                           // hasn't been reaped. View still returns
                                           // 410 past `expiresAtMs`; only PATCH can
                                           // resurrect. The grace window is chosen to
                                           // equal (R2 lifecycle − MAX_EXPIRES_DAYS) so
                                           // the KV entry and the R2 body disappear
                                           // at roughly the same time on an abandoned
                                           // share.
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
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
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

  // API — patch / delete by slug
  const shareMatch = pathname.match(/^\/api\/share\/([A-Za-z0-9]+)$/);
  if (shareMatch && method === "DELETE") {
    return await handleDelete(request, env, shareMatch[1]);
  }
  if (shareMatch && method === "PATCH") {
    return await handlePatch(request, env, shareMatch[1]);
  }

  // Unlock form submit
  const unlockMatch = pathname.match(/^\/v\/([A-Za-z0-9]+)\/unlock$/);
  if (unlockMatch && method === "POST") {
    return await handleUnlock(request, env, unlockMatch[1]);
  }

  // Unlock (JSON, programmatic — mints a `?t=<token>` URL for agent handoff).
  // Owner-auth required: only the share owner can mint tokens to forward.
  const unlockJsonMatch = pathname.match(/^\/v\/([A-Za-z0-9]+)\/unlock\.json$/);
  if (unlockJsonMatch && method === "POST") {
    return await handleUnlockJson(request, env, unlockJsonMatch[1]);
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
    if (!Number.isFinite(days) || days <= 0 || days > MAX_EXPIRES_DAYS) {
      return jsonResponse({ error: "invalid-expiresDays", maxDays: MAX_EXPIRES_DAYS }, 400);
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

  // KV keeps the metadata alive for expiresAtMs + GRACE_PERIOD_MS so an
  // owner can still revive an expired share via PATCH (re-put on R2 + new
  // expiresAtMs). handleView remains strict and returns 410 past
  // expiresAtMs; the grace window only unlocks PATCH-based resurrection.
  const kvOpts = expiresAtMs
    ? { expiration: Math.floor((expiresAtMs + GRACE_PERIOD_MS) / 1000) }
    : undefined;
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
// Patch — owner-only metadata update (password + expiry)
//
// Body (JSON):
//   {
//     "password":     string | null,   // omit to leave unchanged; "" or null removes; "xyz" sets
//     "expiresDays":  number | null,   // omit to leave unchanged; number resets TTL to N days from now
//   }
//
// Notes:
//   - Changing password rotates `passwordSalt`, which is folded into the HMAC
//     input for unlock cookies. That invalidates any previously issued
//     `share_unlock` cookies, forcing viewers to re-enter the new password.
//   - Re-applies KV TTL using the new `expiresAtMs + GRACE_PERIOD_MS` so an
//     owner still has a window to revive an already-expired share as long as
//     the R2 body is present.
//   - When `expiresDays` is updated, the R2 object is re-put with the same
//     bytes. That refreshes R2's `LastModified` so the bucket's 90-day
//     lifecycle rule (see share-worker/README) lines up with the new KV
//     expiry — otherwise a chain of PATCH extensions could leave KV claiming
//     the share is valid while R2 has already reaped the body.
//   - Revival: a share past `expiresAtMs` (but still inside the KV grace
//     window) can be PATCHed back to a live state by supplying `expiresDays`.
//     View remains 410 until such a PATCH lands. PATCH without `expiresDays`
//     on an expired share returns 410 — a password-only change on something
//     that still 410s to viewers is never what the caller wants.
//   - Rate-limited via `share_stats.patchWindow` (rolling hour, separate from
//     upload rate limit) to cap KV-write and R2-Class-A amplification.
// ---------------------------------------------------------------------------

async function handlePatch(request, env, slug) {
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
  // Note: we deliberately do NOT early-return 410 for expired shares. Within
  // the KV grace window an expired share can still be revived via PATCH
  // (provided the R2 body survives). The check that gates revival lives
  // below, after we know whether the body supplied a new `expiresDays`.
  const wasExpired = !!(meta.expiresAtMs && Date.now() > meta.expiresAtMs);

  // Rate limit check: reject early if the rolling window is full, so a burst
  // of payloads (even malformed ones) can't push past R2 re-put / KV write
  // amplification. Slot consumption itself happens after the update succeeds
  // (see saveUserStats below) so that typos / client-side bugs don't lock a
  // well-behaved user out of PATCH for an hour.
  const stats = await loadUserStats(env, user.userId);
  const now = Date.now();
  const patchWindow = (stats.patchWindow || []).filter((ts) => now - ts < RATE_WINDOW_MS);
  if (patchWindow.length >= RATE_LIMIT_PATCH_PER_HOUR) {
    const retryAfterSec = Math.max(1, Math.ceil((patchWindow[0] + RATE_WINDOW_MS - now) / 1000));
    return jsonResponse(
      { error: "rate-limited", scope: "patch", limit: RATE_LIMIT_PATCH_PER_HOUR, windowSec: RATE_WINDOW_MS / 1000, retryAfterSec },
      429,
      { "retry-after": String(retryAfterSec) },
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid-json" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "invalid-body" }, 400);
  }

  let changed = false;
  let expiryChanged = false;

  // Password: presence of the key is a signal to update, so use `in` rather
  // than truthiness. "" or null removes; non-empty string sets.
  if ("password" in body) {
    const pw = body.password;
    if (pw === null || pw === "") {
      if (meta.passwordHash || meta.passwordSalt) {
        meta.passwordHash = null;
        meta.passwordSalt = null;
        changed = true;
      }
    } else if (typeof pw === "string") {
      if (pw.length > 256) {
        return jsonResponse({ error: "password-too-long" }, 400);
      }
      const saltBuf = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
      meta.passwordSalt = bytesToBase64(saltBuf);
      meta.passwordHash = await hashPassword(pw, saltBuf);
      changed = true;
    } else {
      return jsonResponse({ error: "invalid-password" }, 400);
    }
  }

  // Expiry: expiresDays is always relative to "now" (so PATCH extends or
  // shortens the TTL). null → reset to default. number/numeric-string → set.
  if ("expiresDays" in body) {
    const val = body.expiresDays;
    if (val === null) {
      meta.expiresAtMs = Date.now() + DEFAULT_EXPIRES_DAYS * 86400 * 1000;
      changed = true;
      expiryChanged = true;
    } else if (typeof val === "number" || typeof val === "string") {
      const days = Number(val);
      if (!Number.isFinite(days) || days <= 0 || days > MAX_EXPIRES_DAYS) {
        return jsonResponse({ error: "invalid-expiresDays", maxDays: MAX_EXPIRES_DAYS }, 400);
      }
      meta.expiresAtMs = Date.now() + Math.floor(days * 86400 * 1000);
      changed = true;
      expiryChanged = true;
    } else {
      return jsonResponse({ error: "invalid-expiresDays" }, 400);
    }
  }

  if (!changed) {
    return jsonResponse({ error: "no-changes" }, 400);
  }

  // Reviving an expired share requires `expiresDays`. A password-only PATCH on
  // an expired share would leave it 410-Expired to viewers, so we reject it
  // outright rather than silently swallowing the change.
  if (wasExpired && !expiryChanged) {
    return jsonResponse(
      { error: "expired-requires-expiresDays", maxDays: MAX_EXPIRES_DAYS },
      410,
    );
  }

  // R2 re-put: only when expiry was actually touched. Password-only PATCHes
  // don't need to refresh `LastModified` because the bucket lifecycle rule is
  // aligned with the original upload (which is still correctly bounded).
  if (expiryChanged) {
    const obj = await env.SHARE_FILES.get(slug);
    if (!obj) {
      // Body went missing (R2 lifecycle already reaped it, or partial
      // upload). Can't re-put without the bytes — surface a 410 instead of
      // silently letting KV claim the share is still valid.
      return jsonResponse({ error: "object-missing" }, 410);
    }
    const bytes = await obj.arrayBuffer();
    await env.SHARE_FILES.put(slug, bytes, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
  }

  // KV TTL = expiresAtMs + grace period. View enforces the strict 410 cutoff
  // at expiresAtMs; the grace tail keeps the metadata resurrectable until the
  // R2 lifecycle rule reaps the body anyway.
  const kvOpts = meta.expiresAtMs
    ? { expiration: Math.floor((meta.expiresAtMs + GRACE_PERIOD_MS) / 1000) }
    : undefined;
  await env.SHARE_KV.put(`share:${slug}`, JSON.stringify(meta), kvOpts);

  // Record this attempt in the patch rate window, regardless of whether a
  // body field actually changed anything — we already short-circuited the
  // `no-changes` case above so this only runs for accepted PATCHes.
  patchWindow.push(now);
  stats.patchWindow = patchWindow;
  await saveUserStats(env, user.userId, stats);

  const origin = new URL(request.url).origin;
  return jsonResponse({
    ok: true,
    slug,
    url: `${origin}/v/${slug}`,
    createdAtMs: meta.createdAtMs,
    expiresAtMs: meta.expiresAtMs,
    hasPassword: !!meta.passwordHash,
    size: meta.size,
    originalName: meta.originalName,
  });
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

  // Password gate. Two entry paths:
  //   - `?t=<token>`: programmatic/agent view. Token-only, no cookie fallback;
  //     failed verification returns JSON (the caller is machinery). We do NOT
  //     Set-Cookie here on success — a shared URL must not turn into a
  //     durable session for whichever browser later opens it from a log.
  //   - No `?t=`: browser view. Falls back to the existing cookie + HTML
  //     unlock form flow, unchanged.
  if (meta.passwordHash) {
    const url = new URL(request.url);
    const queryToken = url.searchParams.get("t") || "";
    if (queryToken) {
      const ok = await verifyUnlockToken(queryToken, slug, env, meta.passwordSalt);
      if (!ok) {
        return headOnly
          ? new Response(null, { status: 401, headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS } })
          : jsonResponse({ error: "invalid-token" }, 401);
      }
    } else {
      const cookies = parseCookies(request.headers.get("cookie") || "");
      const token = cookies[UNLOCK_COOKIE_NAME] || "";
      const ok = await verifyUnlockToken(token, slug, env, meta.passwordSalt);
      if (!ok) {
        return headOnly
          ? new Response(null, { status: 401, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } })
          : htmlResponse(renderUnlockForm(slug, false, meta.userId), 401);
      }
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
    return htmlResponse(renderUnlockForm(slug, true, meta.userId), 400);
  }

  const saltBuf = base64ToBytes(meta.passwordSalt);
  const candidate = await hashPassword(submitted, saltBuf);
  const ok = timingSafeEqual(candidate, meta.passwordHash);
  if (!ok) {
    return htmlResponse(renderUnlockForm(slug, true, meta.userId), 401);
  }

  const expMs = Date.now() + UNLOCK_COOKIE_MAX_AGE_SEC * 1000;
  const token = await signUnlockToken(slug, env, meta.passwordSalt, expMs);
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
// Unlock (JSON) — owner mints a short-lived `?t=<token>` URL for handoff.
//
// Why owner-auth? An unauth'd JSON unlock would be a free password-brute-force
// oracle (PBKDF2 is a cost gate per attempt but not a replacement for access
// control). Restricting to the share owner also matches the intended flow:
// the owner forwards their own share to another agent; nobody else has
// legitimate reason to mint unlock tokens for someone else's share. Wrong
// password still takes PBKDF2 time to fail, so owners who forget the password
// can't use this to rate-mine their own shares either.
//
// Successful response:
//   { ok: true, token, url, expiresAtMs }
// Wrong password: 401 { ok: false, error: "invalid-password" }
//
// Tokens are stateless HMACs (see signUnlockToken). The caller pastes the
// returned `url` into chat / A2A text; the receiving agent just GETs it.
// Rotating the password via PATCH rotates `passwordSalt`, which invalidates
// every outstanding token for the slug — cookies and `?t=` alike.
// ---------------------------------------------------------------------------

async function handleUnlockJson(request, env, slug) {
  const user = await authenticate(request, env);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  const meta = await loadMetadata(env, slug);
  if (!meta) return jsonResponse({ error: "not-found" }, 404);
  if (meta.userId !== user.userId) return jsonResponse({ error: "forbidden" }, 403);
  if (meta.expiresAtMs && Date.now() > meta.expiresAtMs) {
    return jsonResponse({ error: "expired" }, 410);
  }
  if (!meta.passwordHash) {
    return jsonResponse({ error: "not-password-protected" }, 400);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid-json" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "invalid-body" }, 400);
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (!password) return jsonResponse({ error: "missing-password" }, 400);
  if (password.length > 256) {
    return jsonResponse({ error: "password-too-long" }, 400);
  }

  // ttlHours: default 24, cap 168 (7d, matches cookie path). Also capped below
  // by meta.expiresAtMs so a token can never outlive the share itself.
  const MAX_TTL_HOURS = 168;
  const DEFAULT_TTL_HOURS = 24;
  let ttlHours = DEFAULT_TTL_HOURS;
  if (body.ttlHours !== undefined && body.ttlHours !== null) {
    const n = Number(body.ttlHours);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_TTL_HOURS) {
      return jsonResponse({ error: "invalid-ttlHours", maxHours: MAX_TTL_HOURS }, 400);
    }
    ttlHours = n;
  }

  const saltBuf = base64ToBytes(meta.passwordSalt);
  const candidate = await hashPassword(password, saltBuf);
  const ok = timingSafeEqual(candidate, meta.passwordHash);
  if (!ok) {
    return jsonResponse({ ok: false, error: "invalid-password" }, 401);
  }

  const now = Date.now();
  let expMs = now + Math.floor(ttlHours * 3600 * 1000);
  if (meta.expiresAtMs && expMs > meta.expiresAtMs) {
    expMs = meta.expiresAtMs;
  }

  const token = await signUnlockToken(slug, env, meta.passwordSalt, expMs);
  const origin = new URL(request.url).origin;
  return jsonResponse({
    ok: true,
    token,
    url: `${origin}/v/${slug}?t=${encodeURIComponent(token)}`,
    expiresAtMs: expMs,
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
        patchWindow: Array.isArray(parsed.patchWindow) ? parsed.patchWindow.slice() : [],
      };
    } catch {
      // Corrupt — fall through to a fresh blob.
    }
  }
  return { bytes: 0, count: 0, files: [], rateWindow: [], patchWindow: [] };
}

async function saveUserStats(env, userId, stats) {
  // Prune both rolling windows before persisting so they can't grow unbounded.
  const cutoff = Date.now() - RATE_WINDOW_MS;
  const trimmed = {
    bytes: Math.max(0, Number(stats.bytes) || 0),
    count: Math.max(0, Number(stats.count) || 0),
    files: Array.isArray(stats.files) ? stats.files : [],
    rateWindow: Array.isArray(stats.rateWindow) ? stats.rateWindow.filter((ts) => ts > cutoff) : [],
    patchWindow: Array.isArray(stats.patchWindow) ? stats.patchWindow.filter((ts) => ts > cutoff) : [],
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
// Unlock token — `<expMs>.<base64url(HMAC-SHA256(slug + "\n" + passwordSalt +
// "\n" + expMs, SHARE_SECRET))>`.
//
// Binding the password salt into the signed payload means rotating the
// password (which rotates the salt) also invalidates every previously issued
// unlock token. Embedding `expMs` lets the same token format be carried
// outside of a cookie — e.g. `/v/<slug>?t=<token>` for agent-to-agent
// handoff — without relying on cookie `Max-Age` to bound lifetime.
//
// Legacy tokens (produced before the embedded-expiry upgrade) have no dot
// separator and sign `slug + "\n" + passwordSalt` only; they still verify via
// the `if (dot === -1)` branch so in-flight cookies keep working through the
// deploy. New callers should always pass an `expMs`.
// ---------------------------------------------------------------------------

async function signUnlockToken(slug, env, passwordSalt, expMs) {
  const secret = env.SHARE_SECRET || "";
  if (!secret) throw new Error("SHARE_SECRET not configured");
  if (!Number.isFinite(expMs) || expMs <= 0) {
    throw new Error("signUnlockToken: expMs is required");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const safeSalt = passwordSalt || "";
  const payload = `${slug}\n${safeSalt}\n${expMs}`;
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${expMs}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

async function verifyUnlockToken(token, slug, env, passwordSalt = "") {
  if (!token) return false;
  try {
    const safeSalt = passwordSalt || "";
    const dot = token.indexOf(".");
    if (dot === -1) {
      // Legacy format — payload `slug + "\n" + passwordSalt`, lifetime bounded
      // only by cookie `Max-Age`. Kept for in-flight cookies minted before the
      // upgrade; new code never produces this shape.
      const secret = env.SHARE_SECRET || "";
      if (!secret) return false;
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const legacyPayload = `${slug}\n${safeSalt}`;
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(legacyPayload));
      const expected = bytesToBase64Url(new Uint8Array(sig));
      return timingSafeEqual(token, expected);
    }
    const expMsStr = token.slice(0, dot);
    if (!/^\d+$/.test(expMsStr)) return false;
    const expMs = Number(expMsStr);
    if (!Number.isFinite(expMs) || expMs <= Date.now()) return false;
    const expected = await signUnlockToken(slug, env, safeSalt, expMs);
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

function renderUnlockForm(slug, showError, ownerUserId = "") {
  // userIds are validated at upload/auth (`/^[a-zA-Z0-9_-]{1,64}$/`), so if
  // the stored value doesn't match that shape we drop the "hosted by" line
  // rather than risk injecting anything into the HTML.
  const safeOwner = /^[a-zA-Z0-9_-]{1,64}$/.test(ownerUserId) ? ownerUserId : "";
  const hostedByHtml = safeOwner
    ? `<div class="footer-links">hosted by <a href="https://a2a.viveworker.com/u/${safeOwner}" target="_blank" rel="noopener">${safeOwner}</a></div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Password required — viveworker share</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    :root{color-scheme:dark}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0f0d;color:#e6e6e6;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1.5rem}
    .card{max-width:420px;width:100%;background:#111916;border:1px solid #1e2e28;border-radius:16px;padding:2rem;text-align:center}
    .lock{width:56px;height:56px;background:#0d2b20;border:2px solid #00d4aa;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 1rem;color:#00d4aa}
    .lock svg{width:22px;height:22px}
    .badge{display:inline-block;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;color:#00d4aa;background:#0d2b20;padding:0.2rem 0.6rem;border-radius:99px;margin-bottom:1rem}
    .description{color:#a0a0a0;font-size:0.95rem;line-height:1.5;margin-bottom:1.5rem}
    form{display:flex;flex-direction:column;gap:0.7rem}
    input[type="password"]{width:100%;padding:0.7rem 0.9rem;border-radius:8px;border:1px solid #1e2e28;background:#0d1a14;color:#e6e6e6;font:inherit;outline:none;transition:border-color 0.2s}
    input[type="password"]:focus{border-color:#00d4aa}
    input[type="password"]::placeholder{color:#55665f}
    button{padding:0.7rem 0.9rem;border-radius:8px;border:0;cursor:pointer;background:#00d4aa;color:#0a0f0d;font:inherit;font-weight:700;transition:background 0.2s}
    button:hover{background:#1ae3b9}
    .error{color:#ff7a7a;font-size:0.85rem;margin-top:0.1rem}
    footer{margin-top:2rem;text-align:center}
    .footer-brand{font-size:0.75rem;text-transform:uppercase;letter-spacing:0.1em;color:#00d4aa;text-decoration:none}
    .footer-brand:hover{text-decoration:underline}
    .footer-links{font-size:0.75rem;color:#555;margin-top:0.3rem}
    .footer-links a{color:#666;text-decoration:none}
    .footer-links a:hover{color:#00d4aa}
  </style>
</head>
<body>
  <div class="card">
    <div class="lock" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
    </div>
    <div class="badge">Password required</div>
    <p class="description">This shared page is protected.<br>Enter the password to view.</p>
    <form method="POST" action="/v/${encodeURIComponent(slug)}/unlock" autocomplete="off">
      <input type="password" name="password" placeholder="Password" autofocus required />
      <button type="submit">Unlock</button>
      ${showError ? '<div class="error">Incorrect password.</div>' : ""}
    </form>
  </div>
  <footer>
    <a href="https://a2a.viveworker.com" target="_blank" rel="noopener" class="footer-brand">viveworker a2a</a>
    ${hostedByHtml}
  </footer>
</body>
</html>`;
}
