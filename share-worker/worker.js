import { Resvg } from "@cf-wasm/resvg/workerd";

/**
 * viveworker-share — Cloudflare Worker for sharing static artefacts.
 *
 * Features:
 *   - Upload .html / .htm / .pdf / .png / .jpg / .jpeg / .gif / .webp / .csv
 *     (auth: X-A2A-User + X-A2A-Key, reuses A2A relay users)
 *   - Per-upload random slug URL (https://share.viveworker.com/v/<slug>)
 *   - Optional PBKDF2 password protection
 *   - Robot / crawler blocking (X-Robots-Tag + robots.txt)
 *   - Owner-only update/delete via same A2A credentials
 *   - CSV is rendered server-side as an HTML table on view (`?raw=1` for bytes)
 *
 * Bindings (see wrangler.toml):
 *   USERS_KV      — A2A relay's KV (read-only), used to validate user credentials
 *   SHARE_KV      — this service's KV (metadata per upload, per-user indexes)
 *   SHARE_FILES   — R2 bucket, stores the uploaded bytes
 *   SHARE_SECRET  — env var, signing key for unlock cookies
 *
 * KV schema:
 *   share:<slug>                        → metadata JSON (incl. contentType / kind)
 *   share_stats:<userId>                → { bytes, count, files: [slug...], rateWindow: [ts...] }
 *
 * R2 schema:
 *   <slug>                              → raw bytes (HTML / PDF / image / CSV)
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

// Accepted file types. Keys are lowercase extensions with the leading dot.
// `kind` drives per-type handling in handleView (HTML pass-through vs. PDF
// inline vs. image inline vs. CSV render-as-table). `mime` is what gets stored
// on the R2 object and sent as Content-Type on view.
//
// SVG intentionally omitted — it can execute scripts (same surface as HTML)
// and doesn't pay its own way for image sharing. Revisit if we later add a
// forced-attachment disposition for it.
const SHARE_TYPES = {
  ".html": { mime: "text/html; charset=utf-8", kind: "html" },
  ".htm":  { mime: "text/html; charset=utf-8", kind: "html" },
  ".pdf":  { mime: "application/pdf",          kind: "pdf" },
  ".png":  { mime: "image/png",                 kind: "image" },
  ".jpg":  { mime: "image/jpeg",                kind: "image" },
  ".jpeg": { mime: "image/jpeg",                kind: "image" },
  ".gif":  { mime: "image/gif",                 kind: "image" },
  ".webp": { mime: "image/webp",                kind: "image" },
  ".csv":  { mime: "text/csv; charset=utf-8",   kind: "csv" },
};
const ALLOWED_EXTENSIONS = Object.keys(SHARE_TYPES);

const CSV_MAX_RENDER_ROWS = 5000;

// Legacy shares (uploaded before the multi-format split) have no `contentType`
// in their KV metadata. They were always HTML, so default to that on read.
const LEGACY_CONTENT_TYPE = "text/html; charset=utf-8";
const LEGACY_KIND = "html";

// ---------------------------------------------------------------------------
// x402 payment gate (pay-per-unlock via USDC on Base)
// ---------------------------------------------------------------------------
//
// A share can optionally require a USDC payment before the content is served.
// When `meta.price` is set, the first GET returns HTTP 402 with an x402-spec
// body; the client retries with `X-PAYMENT: <base64(payload)>` and we verify
// + settle via an external facilitator (Coinbase's public facilitator on
// testnet; CDP's authed facilitator on mainnet). Successful verification
// mints a short-lived `share_paid` cookie so subsequent reloads skip 402.
//
// Non-custodial: viveworker never holds funds. The seller sets `payTo`;
// USDC goes directly from buyer to seller via the facilitator-broadcast tx.
//
// v1: `--price` and `--password` are mutually exclusive on a share. The
// content-type-agnostic payment gate runs after the password gate but before
// the format branch in handleView.

const X402_VERSION = 1;
const DEFAULT_HAZBASE_API_ENDPOINT = "https://api.hazbase.com";
// Keyed by chainId. `usdc` is the canonical USDC contract address for that
// chain; `eip712Name` + `eip712Version` are the EIP-712 domain fields the
// facilitator uses to verify transferWithAuthorization signatures.
const X402_NETWORKS = {
  8453:  { name: "base",         usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", eip712Name: "USD Coin", eip712Version: "2" },
  84532: { name: "base-sepolia", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", eip712Name: "USDC",     eip712Version: "2" },
};
const MIN_PRICE_ATOMIC = 10_000n;         // $0.01 min (below this, gas dwarfs price)
const MAX_PRICE_ATOMIC = 1_000_000_000n;  // $1000 max per share (accident-cap)
const PAID_COOKIE_NAME = "share_paid";
const PAID_COOKIE_MAX_AGE_SEC = 15 * 60;  // 15 min — short because paid content
                                          // is sensitive and re-pay is cheap

// Closed-beta allowlist for the paid-shares gate. While x402 is pinned to
// testnet, we let a CSV of userIds through and hard-refuse everyone else at
// upload/patch time. Unset → block-all (default-deny during rollout). Flip to
// open GA by removing the check once mainnet + monitoring are stable.
function isPaidSharesAllowed(env, userId) {
  const raw = (env.X402_BETA_ALLOWLIST || "").trim();
  if (!raw) return false;
  // Also allow a literal "*" to mean "open to all" for when GA arrives before
  // we rewire this call site.
  if (raw === "*") return true;
  const allow = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return allow.includes(userId);
}

// Analytics Engine sink for payment-flow observability. The dataset is bound
// as `env.ANALYTICS` (see wrangler.toml). Fire-and-forget — never blocks a
// request and never throws on quota/binding errors. index1=slug so per-share
// drill-downs are cheap; blob1=event, blob2=userId (owner), blob3=network,
// blob4=reason (free-form; e.g. facilitator invalid-reason code).
function writeShareEvent(env, event, slug, extra = {}) {
  try {
    if (!env.ANALYTICS) return;  // binding not configured (local dev / first deploy)
    env.ANALYTICS.writeDataPoint({
      indexes: [slug || ""],
      blobs: [
        String(event || ""),
        String(extra.userId || ""),
        String(extra.network || ""),
        String(extra.reason || ""),
      ],
      doubles: [1],
    });
  } catch { /* best-effort; never block a request */ }
}

function detectShareType(filename) {
  const name = String(filename || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = name.slice(dot);
  const entry = SHARE_TYPES[ext];
  if (!entry) return null;
  return { ext, mime: entry.mime, kind: entry.kind };
}

// ---------------------------------------------------------------------------
// Brand assets — share mark (Open Cell)
// ---------------------------------------------------------------------------
//
// A2A uses the bee. Share uses the opened honeycomb cell: a scoped piece of
// the hive, cut loose just enough to hand off. Same ecosystem, different role.
// The OG PNG is rendered from SVG at request time via @cf-wasm/resvg and
// cached for 24h at the edge — no pre-built PNG asset shipping in the bundle.

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    <mask id="cell-open" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
      <rect width="32" height="32" fill="#fff"/>
      <polygon points="20.6,3.8 27.8,8.1 27.8,16.3 22.9,13.5 22.9,9.5 18.7,7.1" fill="#000"/>
    </mask>
  </defs>
  <polygon points="16,4 24.5,8.9 24.5,18.6 16,23.5 7.5,18.6 7.5,8.9" fill="#00D4AA" mask="url(#cell-open)"/>
  <polygon points="16,8.4 20.4,10.9 20.4,16 16,18.5 11.6,16 11.6,10.9" fill="#0B1116" mask="url(#cell-open)"/>
  <circle cx="16" cy="13.4" r="1.8" fill="#00D4AA" opacity="0.84"/>
</svg>`;
const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`;

// OG preview card (1200×630). No <text> nodes — Resvg without bundled fonts
// won't paint them. The scraper overlay already supplies title/description
// from the meta tags, so logo-only is enough here.
const OG_DEFAULT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(600 315) rotate(90) scale(280)">
      <stop stop-color="#00D4AA" stop-opacity="0.24"/>
      <stop offset="1" stop-color="#00D4AA" stop-opacity="0"/>
    </radialGradient>
    <mask id="cell-open" maskUnits="userSpaceOnUse" x="0" y="0" width="1200" height="630">
      <rect width="1200" height="630" fill="#fff"/>
      <polygon points="680,144 805,216 805,356 719,307 719,240 646,197" fill="#000"/>
    </mask>
  </defs>
  <rect width="1200" height="630" fill="#0a0f0d"/>
  <circle cx="600" cy="315" r="260" fill="url(#glow)"/>
  <g fill="none" stroke="#00D4AA" stroke-width="16" opacity="0.14">
    <polygon points="372,178 471,235 471,349 372,406 273,349 273,235"/>
    <polygon points="828,178 927,235 927,349 828,406 729,349 729,235"/>
  </g>
  <polygon points="600,138 744,221 744,389 600,472 456,389 456,221" fill="#00D4AA" mask="url(#cell-open)"/>
  <polygon points="600,212 680,258 680,351 600,397 520,351 520,258" fill="#0D1511" mask="url(#cell-open)"/>
  <circle cx="600" cy="305" r="30" fill="#00D4AA" opacity="0.84"/>
</svg>`;

async function handleOgDefault() {
  const resvg = await Resvg.async(OG_DEFAULT_SVG, { fitTo: { mode: "original" } });
  const png = resvg.render().asPng();
  return new Response(png, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
  });
}

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

  // Favicon — SVG at /favicon.svg; /favicon.ico gets a 204 so browsers stop
  // walking up to the root for a legacy .ico file.
  if (pathname === "/favicon.svg" && method === "GET") {
    return new Response(FAVICON_SVG, {
      headers: {
        "content-type": "image/svg+xml",
        "cache-control": "public, max-age=604800",
      },
    });
  }
  if (pathname === "/favicon.ico" && method === "GET") {
    return new Response(null, { status: 204 });
  }

  // OG preview image — dynamic PNG from SVG via Resvg.
  if (pathname === "/og/default.png" && method === "GET") {
    return await handleOgDefault();
  }

  // Landing page
  if (pathname === "/" && method === "GET") {
    return htmlResponse(renderLanding(request), 200);
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

  // API — payment-flow metrics for the caller's paid shares.
  // Reads Analytics Engine via the Cloudflare REST API (needs CF_ACCOUNT_ID +
  // CF_API_TOKEN). Free tier is 10M datapoints/day; queries are cheap.
  if (pathname === "/api/metrics" && method === "GET") {
    return await handleShareMetrics(request, env);
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
    return await handleView(request, env, ctx, viewMatch[1], method === "HEAD");
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

  const parsedFile = await readShareFile(file);
  if (parsedFile.response) return parsedFile.response;
  const { bytes, originalName, typeInfo, size } = parsedFile;

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

  // Optional payment gate (x402 / USDC on Base). Both `price` and `payTo`
  // must be supplied together; supplying one without the other is rejected so
  // a misconfigured upload can't silently become a public share. Mutually
  // exclusive with `password` on v1 — single-gate shares keep the state
  // surface small.
  const priceRaw = form.get("price");
  const payToRaw = form.get("payTo");
  const payoutAddressRaw = form.get("payoutAddress");
  const paymentNetworkRaw = form.get("paymentNetwork");
  const payoutMethodRaw = form.get("payoutMethod");
  let priceAtomic = null;
  let payTo = null;
  let chainId = null;
  let paymentNetwork = null;
  let payoutMethod = null;
  let payoutAddress = null;
  let paymentSalt = null;
  const anyPricePresent = typeof priceRaw === "string" && priceRaw.length > 0;
  const requestedPayout = parseRequestedPayoutAddress(payToRaw, payoutAddressRaw);
  if (requestedPayout.error) {
    return jsonResponse({ error: requestedPayout.error }, 400);
  }
  if (anyPricePresent || requestedPayout.sawValue) {
    // Closed-beta gate: while x402 is pinned to testnet, only allowlisted
    // userIds can attach a price. Check first so a non-allowlisted user who
    // fat-fingered `--price` + `--pay-to` gets a clear "not in beta" error
    // rather than a downstream 400 about price format or cross-exclusivity.
    if (!isPaidSharesAllowed(env, user.userId)) {
      return jsonResponse(
        {
          error: "paid-shares-closed-beta",
          hint: "paid shares are in testnet-only closed beta. Ask the operator to add your userId to X402_BETA_ALLOWLIST.",
          network: resolveChainId(env) ? X402_NETWORKS[resolveChainId(env)].name : null,
        },
        403,
      );
    }
    if (!anyPricePresent || !requestedPayout.address) {
      return jsonResponse({ error: "price-payTo-both-required" }, 400);
    }
    if (passwordHash) {
      return jsonResponse({ error: "price-and-password-mutually-exclusive" }, 400);
    }
    const parsed = parseUsdcPrice(priceRaw);
    if (parsed === null) {
      return jsonResponse({ error: "invalid-price" }, 400);
    }
    if (parsed < MIN_PRICE_ATOMIC || parsed > MAX_PRICE_ATOMIC) {
      return jsonResponse(
        {
          error: "price-out-of-range",
          minAtomic: MIN_PRICE_ATOMIC.toString(),
          maxAtomic: MAX_PRICE_ATOMIC.toString(),
        },
        400,
      );
    }
    const requestedNetwork = typeof paymentNetworkRaw === "string" ? paymentNetworkRaw : "";
    const resolvedChainId = resolveChainId(env, requestedNetwork);
    if (!resolvedChainId) {
      return jsonResponse({ error: "payment-network-not-configured" }, 500);
    }
    priceAtomic = parsed.toString();
    payTo = requestedPayout.address;
    chainId = resolvedChainId;
    paymentNetwork = X402_NETWORKS[resolvedChainId]?.name || null;
    payoutMethod = normalizeRequestedPayoutMethod(payoutMethodRaw);
    payoutAddress = payTo;
    const saltBuf = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
    paymentSalt = bytesToBase64(saltBuf);
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
  if ((stats.bytes || 0) + size > MAX_TOTAL_BYTES) {
    return jsonResponse(
      {
        error: "quota-exceeded",
        maxTotalBytes: MAX_TOTAL_BYTES,
        currentBytes: stats.bytes || 0,
        fileBytes: size,
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
    size,
    createdAtMs,
    expiresAtMs,
    passwordHash,
    passwordSalt,
    // Future password-protected uploads expose a short-lived bearer URL in
    // owner-only lists, with the token lifetime capped to the share expiry.
    passwordListTokenEnabled: !!passwordHash,
    contentType: typeInfo.mime,
    kind: typeInfo.kind,
    // Payment fields (v1): all `null` for free shares, set together when a
    // payment gate is attached. `paymentSalt` participates in the HMAC input
    // for `share_paid` cookies so rotating the price invalidates every
    // outstanding paid session.
    price: priceAtomic,
    payTo,
    chainId,
    paymentNetwork,
    payoutMethod,
    payoutAddress,
    paymentSalt,
  };

  // Write R2 first, then KV (so we never leave metadata pointing to a missing object).
  await env.SHARE_FILES.put(slug, bytes, {
    httpMetadata: { contentType: typeInfo.mime },
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
  stats.bytes = (stats.bytes || 0) + size;
  rateWindow.push(now);
  stats.rateWindow = rateWindow;
  await saveUserStats(env, user.userId, stats);

  // Analytics: log paid-share creation so `share list --metrics` can tell
  // seller-side "how many paid shares did I spin up" vs buyer-side traffic.
  if (priceAtomic) {
    writeShareEvent(env, "upload_paid", slug, {
      userId: user.userId,
      network: chainId ? X402_NETWORKS[chainId]?.name || "" : "",
    });
  }

  const origin = new URL(request.url).origin;
  return jsonResponse({
    ok: true,
    slug,
    url: `${origin}/v/${slug}`,
    createdAtMs,
    expiresAtMs,
    hasPassword: !!passwordHash,
    price: priceAtomic,
    payTo,
    chainId,
    paymentNetwork: paymentNetwork || (chainId ? X402_NETWORKS[chainId]?.name || null : null),
    payoutMethod: payoutMethod || null,
    payoutAddress: payoutAddress || payTo,
    network: chainId ? X402_NETWORKS[chainId]?.name || null : null,
    size,
    originalName,
    quota: {
      bytes: stats.bytes,
      maxBytes: MAX_TOTAL_BYTES,
      count: stats.count,
      maxCount: MAX_FILES,
    },
  });
}

async function readShareFile(file) {
  // Enforce size.
  if (file.size > MAX_FILE_SIZE) {
    return { response: jsonResponse({ error: "file-too-large", maxBytes: MAX_FILE_SIZE }, 413) };
  }
  if (file.size <= 0) {
    return { response: jsonResponse({ error: "empty-file" }, 400) };
  }

  // Enforce extension.
  const originalName = sanitizeFilename(file.name || "upload.html");
  const typeInfo = detectShareType(originalName);
  if (!typeInfo) {
    return {
      response: jsonResponse(
        { error: "unsupported-extension", allowed: ALLOWED_EXTENSIONS },
        400,
      ),
    };
  }

  // Best-effort declared content-type check. We compare against the type
  // implied by the extension so a `.pdf` uploaded with `Content-Type: text/html`
  // gets rejected rather than silently stored with the wrong MIME. Browsers /
  // curl both set a sensible declared type for standard extensions; the check
  // is skipped when the caller didn't declare anything.
  const declaredType = (file.type || "").toLowerCase();
  if (declaredType && !isDeclaredTypeCompatible(declaredType, typeInfo.kind)) {
    return {
      response: jsonResponse(
        { error: "unsupported-content-type", declared: declaredType, expected: typeInfo.mime },
        400,
      ),
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Per-kind magic-byte sniff (defense-in-depth, not security-critical).
  // Protects against a user accidentally uploading a mis-extensioned file;
  // doesn't try to be a full format validator.
  if (!sniffKind(bytes, typeInfo.kind)) {
    return { response: jsonResponse({ error: "content-mismatch", kind: typeInfo.kind }, 400) };
  }

  return { bytes, originalName, typeInfo, size: file.size };
}

function patchBodyFromForm(form) {
  const body = {};
  const stringField = (name) => {
    const value = form.get(name);
    return typeof value === "string" ? value : undefined;
  };

  for (const name of ["password", "price", "payTo", "payoutAddress", "paymentNetwork", "payoutMethod", "expiresDays"]) {
    if (form.has(name)) {
      body[name] = stringField(name) ?? "";
    }
  }

  return body;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

async function buildListedShareUrl(origin, slug, env, meta) {
  const directUrl = `${origin}/v/${slug}`;
  if (!meta.passwordHash || !meta.passwordSalt || !meta.passwordListTokenEnabled || !meta.expiresAtMs) {
    return { url: directUrl, directUrl, tokenExpiresAtMs: null };
  }

  try {
    const token = await signUnlockToken(slug, env, meta.passwordSalt, meta.expiresAtMs);
    return {
      url: `${directUrl}?t=${encodeURIComponent(token)}`,
      directUrl,
      tokenExpiresAtMs: meta.expiresAtMs,
    };
  } catch {
    // Listing should stay usable even if an older deployment is missing the
    // signing secret. The direct password URL remains the safe fallback.
    return { url: directUrl, directUrl, tokenExpiresAtMs: null };
  }
}

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
    const listedUrl = await buildListedShareUrl(origin, slug, env, meta);
    items.push({
      slug,
      url: listedUrl.url,
      directUrl: listedUrl.directUrl,
      tokenExpiresAtMs: listedUrl.tokenExpiresAtMs,
      originalName: meta.originalName,
      size: meta.size,
      createdAtMs: meta.createdAtMs,
      expiresAtMs: meta.expiresAtMs || null,
      hasPassword: !!meta.passwordHash,
      price: meta.price || null,
      payTo: meta.payTo || null,
      chainId: meta.chainId || null,
      paymentNetwork: meta.paymentNetwork || (meta.chainId ? X402_NETWORKS[meta.chainId]?.name || null : null),
      payoutMethod: meta.payoutMethod || null,
      payoutAddress: meta.payoutAddress || meta.payTo || null,
      network: meta.chainId ? X402_NETWORKS[meta.chainId]?.name || null : null,
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
  let replacementFile = null;
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    let form;
    try {
      form = await request.formData();
    } catch {
      return jsonResponse({ error: "invalid-form-data" }, 400);
    }

    const file = form.get("file");
    if (file && typeof file === "string") {
      return jsonResponse({ error: "invalid-file-field" }, 400);
    }
    if (file) {
      const parsedFile = await readShareFile(file);
      if (parsedFile.response) return parsedFile.response;
      replacementFile = parsedFile;
    }

    body = patchBodyFromForm(form);
  } else {
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "invalid-json" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse({ error: "invalid-body" }, 400);
    }
  }

  let changed = false;
  let expiryChanged = false;
  let fileChanged = false;
  let paymentSessionsInvalidated = false;

  // Password: presence of the key is a signal to update, so use `in` rather
  // than truthiness. "" or null removes; non-empty string sets.
  if ("password" in body) {
    const pw = body.password;
    if (pw === null || pw === "") {
      if (meta.passwordHash || meta.passwordSalt) {
        meta.passwordHash = null;
        meta.passwordSalt = null;
        meta.passwordListTokenEnabled = false;
        changed = true;
      }
    } else if (typeof pw === "string") {
      if (pw.length > 256) {
        return jsonResponse({ error: "password-too-long" }, 400);
      }
      const removingPriceInSamePatch = "price" in body && (body.price === null || body.price === "");
      if (meta.price && !removingPriceInSamePatch) {
        return jsonResponse({ error: "price-and-password-mutually-exclusive" }, 400);
      }
      const saltBuf = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
      meta.passwordSalt = bytesToBase64(saltBuf);
      meta.passwordHash = await hashPassword(pw, saltBuf);
      meta.passwordListTokenEnabled = true;
      changed = true;
    } else {
      return jsonResponse({ error: "invalid-password" }, 400);
    }
  }

  // Payment: `price` + `payTo` together, or either alone to rotate/change.
  // Semantics mirror the CLI flags (`--price`, `--no-price`, `--pay-to`):
  //   - body.price === null / ""  → remove the entire payment gate.
  //   - body.price value + body.payTo value → fresh or rotated gate (rotates
  //     paymentSalt, which invalidates every outstanding `share_paid` cookie).
  //   - body.price value alone → change price, keep existing payTo. Still
  //     rotates paymentSalt (seller intent is "new price, old sessions out").
  //   - body.payTo value alone → change recipient only. Does NOT rotate salt;
  //     already-paid sessions stay alive (the buyer already got what they
  //     paid for; the seller simply redirects future payouts).
  if ("price" in body) {
    const pv = body.price;
    if (pv === null || pv === "") {
      // Removing the gate is always allowed — even for users who are no longer
      // on the beta allowlist — so they can always downgrade a paid share back
      // to public without having to wait for re-approval.
      if (meta.price || meta.payTo || meta.paymentSalt || meta.chainId) {
        meta.price = null;
        meta.payTo = null;
        meta.chainId = null;
        meta.paymentNetwork = null;
        meta.payoutMethod = null;
        meta.payoutAddress = null;
        meta.paymentSalt = null;
        changed = true;
      }
    } else if (typeof pv === "string" || typeof pv === "number") {
      // Setting / rotating a price requires the beta allowlist, same as upload.
      if (!isPaidSharesAllowed(env, user.userId)) {
        return jsonResponse(
          {
            error: "paid-shares-closed-beta",
            hint: "paid shares are in testnet-only closed beta. Ask the operator to add your userId to X402_BETA_ALLOWLIST.",
            network: resolveChainId(env) ? X402_NETWORKS[resolveChainId(env)].name : null,
          },
          403,
        );
      }
      if (meta.passwordHash) {
        return jsonResponse({ error: "price-and-password-mutually-exclusive" }, 400);
      }
      const parsed = parseUsdcPrice(String(pv));
      if (parsed === null) {
        return jsonResponse({ error: "invalid-price" }, 400);
      }
      if (parsed < MIN_PRICE_ATOMIC || parsed > MAX_PRICE_ATOMIC) {
        return jsonResponse(
          {
            error: "price-out-of-range",
            minAtomic: MIN_PRICE_ATOMIC.toString(),
            maxAtomic: MAX_PRICE_ATOMIC.toString(),
          },
          400,
        );
      }
      // Recipient: take from body if present, else keep existing. If neither,
      // reject — a price without a recipient is unusable.
      const requestedPayout = parseRequestedPayoutAddress(
        Object.prototype.hasOwnProperty.call(body, "payTo") ? body.payTo : undefined,
        Object.prototype.hasOwnProperty.call(body, "payoutAddress") ? body.payoutAddress : undefined,
      );
      if (requestedPayout.error) {
        return jsonResponse({ error: requestedPayout.error }, 400);
      }
      let effectivePayTo;
      if (requestedPayout.sawValue) {
        if (!requestedPayout.address) {
          return jsonResponse({ error: "price-payTo-both-required" }, 400);
        }
        effectivePayTo = requestedPayout.address;
      } else if (meta.payoutAddress || meta.payTo) {
        effectivePayTo = meta.payoutAddress || meta.payTo;
      } else {
        return jsonResponse({ error: "price-payTo-both-required" }, 400);
      }
      const requestedNetwork = typeof body.paymentNetwork === "string" ? body.paymentNetwork : (meta.paymentNetwork || "");
      const resolvedChainId = meta.chainId || resolveChainId(env, requestedNetwork);
      if (!resolvedChainId) {
        return jsonResponse({ error: "payment-network-not-configured" }, 500);
      }
      meta.price = parsed.toString();
      meta.payTo = effectivePayTo;
      meta.chainId = resolvedChainId;
      meta.paymentNetwork = X402_NETWORKS[resolvedChainId]?.name || null;
      meta.payoutMethod = normalizeRequestedPayoutMethod(body.payoutMethod || meta.payoutMethod);
      meta.payoutAddress = effectivePayTo;
      const saltBuf = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
      meta.paymentSalt = bytesToBase64(saltBuf);
      changed = true;
    } else {
      return jsonResponse({ error: "invalid-price" }, 400);
    }
  } else if ("payTo" in body || "payoutAddress" in body) {
    // Recipient-only branch: only legal when the share already has a price.
    const requestedPayout = parseRequestedPayoutAddress(
      Object.prototype.hasOwnProperty.call(body, "payTo") ? body.payTo : undefined,
      Object.prototype.hasOwnProperty.call(body, "payoutAddress") ? body.payoutAddress : undefined,
    );
    if (requestedPayout.error) {
      return jsonResponse({ error: requestedPayout.error }, 400);
    }
    if (requestedPayout.sawValue && !requestedPayout.address) {
      return jsonResponse(
        { error: "payTo-cannot-be-cleared-alone", hint: "pass price:null to remove the payment gate" },
        400,
      );
    }
    if (!meta.price) {
      return jsonResponse({ error: "payTo-without-price" }, 400);
    }
    // Rotating `payTo` on a live paid share is operationally equivalent to
    // running a paid share — still gated by the beta allowlist so a removed
    // user can't keep redirecting payouts. They can always `--no-price` to
    // wind the gate down.
    if (!isPaidSharesAllowed(env, user.userId)) {
      return jsonResponse(
        {
          error: "paid-shares-closed-beta",
          hint: "paid shares are in testnet-only closed beta. Ask the operator to add your userId to X402_BETA_ALLOWLIST.",
          network: resolveChainId(env) ? X402_NETWORKS[resolveChainId(env)].name : null,
        },
        403,
      );
    }
    const normalized = requestedPayout.address;
    if (normalized !== meta.payTo) {
      meta.payTo = normalized;
      meta.payoutAddress = normalized;
      changed = true;
    }
  }

  if ("payoutMethod" in body && meta.price) {
    const normalizedPayoutMethod = normalizeRequestedPayoutMethod(body.payoutMethod);
    if (normalizedPayoutMethod !== (meta.payoutMethod || "external_eoa")) {
      meta.payoutMethod = normalizedPayoutMethod;
      changed = true;
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

  if (replacementFile) {
    const files = Array.isArray(stats.files) ? stats.files.slice() : [];
    const oldSize = Number(meta.size) || 0;
    const oldSizeWasCounted = files.includes(slug);
    const baseBytes = Math.max(0, (Number(stats.bytes) || 0) - (oldSizeWasCounted ? oldSize : 0));
    const nextBytes = baseBytes + replacementFile.size;
    if (nextBytes > MAX_TOTAL_BYTES) {
      return jsonResponse(
        {
          error: "quota-exceeded",
          maxTotalBytes: MAX_TOTAL_BYTES,
          currentBytes: stats.bytes || 0,
          fileBytes: replacementFile.size,
        },
        413,
      );
    }

    if (!files.includes(slug)) files.push(slug);
    stats.files = files;
    stats.count = files.length;
    stats.bytes = nextBytes;

    meta.originalName = replacementFile.originalName;
    meta.size = replacementFile.size;
    meta.contentType = replacementFile.typeInfo.mime;
    meta.kind = replacementFile.typeInfo.kind;
    meta.updatedAtMs = Date.now();

    if (meta.price && meta.paymentSalt) {
      const saltBuf = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
      meta.paymentSalt = bytesToBase64(saltBuf);
      paymentSessionsInvalidated = true;
    }

    changed = true;
    fileChanged = true;
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

  // R2 re-put: replacing the file writes the new bytes under the existing
  // slug. Otherwise we only re-put when expiry changed, to refresh
  // `LastModified` for the bucket lifecycle rule.
  if (fileChanged) {
    await env.SHARE_FILES.put(slug, replacementFile.bytes, {
      httpMetadata: { contentType: replacementFile.typeInfo.mime },
    });
  } else if (expiryChanged) {
    const obj = await env.SHARE_FILES.get(slug);
    if (!obj) {
      // Body went missing (R2 lifecycle already reaped it, or partial
      // upload). Can't re-put without the bytes — surface a 410 instead of
      // silently letting KV claim the share is still valid.
      return jsonResponse({ error: "object-missing" }, 410);
    }
    const bytes = await obj.arrayBuffer();
    await env.SHARE_FILES.put(slug, bytes, {
      httpMetadata: { contentType: meta.contentType || LEGACY_CONTENT_TYPE },
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
    price: meta.price || null,
    payTo: meta.payTo || null,
    chainId: meta.chainId || null,
    paymentNetwork: meta.paymentNetwork || (meta.chainId ? X402_NETWORKS[meta.chainId]?.name || null : null),
    payoutMethod: meta.payoutMethod || null,
    payoutAddress: meta.payoutAddress || meta.payTo || null,
    network: meta.chainId ? X402_NETWORKS[meta.chainId]?.name || null : null,
    size: meta.size,
    originalName: meta.originalName,
    updatedAtMs: meta.updatedAtMs || null,
    fileReplaced: fileChanged,
    paymentSessionsInvalidated,
  });
}

// ---------------------------------------------------------------------------
// View / render
// ---------------------------------------------------------------------------

async function handleView(request, env, ctx, slug, headOnly = false) {
  const meta = await loadMetadata(env, slug);
  if (!meta) return textResponse("Not Found", 404, SECURITY_HEADERS);

  if (meta.expiresAtMs && Date.now() > meta.expiresAtMs) {
    return textResponse("Expired", 410, SECURITY_HEADERS);
  }

  // Password gate. Two entry paths:
  //   - `?t=<token>`: programmatic/agent view. We do NOT Set-Cookie here on
  //     success — a shared URL must not turn into a durable session for
  //     whichever browser later opens it from a log. If a human browser opens
  //     an expired/invalid token URL, fall back to the password form; machinery
  //     still gets JSON so clients can distinguish invalid-token from HTML.
  //   - No `?t=`: browser view. Falls back to the existing cookie + HTML
  //     unlock form flow, unchanged.
  if (meta.passwordHash) {
    const url = new URL(request.url);
    const queryToken = url.searchParams.get("t") || "";
    if (queryToken) {
      const ok = await verifyUnlockToken(queryToken, slug, env, meta.passwordSalt);
      if (!ok) {
        if (headOnly) {
          return new Response(null, { status: 401, headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS } });
        }
        return prefersHtml(request)
          ? htmlResponse(renderUnlockForm(slug, true, meta.userId), 401)
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

  // Payment gate (x402). Runs after the password gate — content-type-agnostic,
  // independent from password auth. On first visit (no cookie, no X-PAYMENT
  // header), returns 402 with the x402 requirements body. When X-PAYMENT is
  // present, verifies via the configured facilitator, mints a short-lived
  // `share_paid` cookie, and falls through to the format branch. Settlement
  // (broadcasting the transfer tx on-chain) is fired via ctx.waitUntil after
  // verify — the facilitator has already confirmed the signature + nonce, so
  // settle is essentially a formality.

const paymentExtraHeaders = {};
if (meta.price && meta.paymentSalt && meta.chainId && meta.payTo) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const paidToken = cookies[PAID_COOKIE_NAME] || "";
  const hasPaidSession = paidToken
    ? await verifyUnlockToken(paidToken, slug, env, meta.paymentSalt)
    : false;

  if (!hasPaidSession) {
    const requirementResult = await requestHazbasePaymentRequirements(env, meta, slug, request.url);
    if (!requirementResult.ok) {
      return jsonResponse(
        { x402Version: X402_VERSION, error: requirementResult.errorCode || "payment-service-unavailable" },
        503,
      );
    }
    const requirements = requirementResult.requirements;
    const x402Body = requirementResult.x402;
    const xPaymentHeader = request.headers.get("x-payment") || "";
    if (!xPaymentHeader) {
      writeShareEvent(env, headOnly ? "402_served_head" : "402_served", slug, {
        userId: meta.userId || "",
        network: requirements.network || "",
      });
      if (headOnly) {
        const hintHeaders = buildPaymentHintHeaders(requirements);
        return new Response(null, {
          status: 402,
          headers: {
            "content-type": prefersHtml(request)
              ? "text/html; charset=utf-8"
              : "application/json; charset=utf-8",
            "cache-control": "private, no-store",
            ...hintHeaders,
            ...SECURITY_HEADERS,
          },
        });
      }
      return build402Response(request, slug, x402Body);
    }

    const verifyResult = await verifyHazbasePayment(env, requirementResult.paymentRequestId, xPaymentHeader);
    if (!verifyResult || !verifyResult.verified) {
      const reason = (verifyResult && (verifyResult.invalidReason || verifyResult.errorCode)) || "payment-verification-failed";
      writeShareEvent(env, reason === "facilitator_unavailable" ? "facilitator_unavailable" : "verify_failed", slug, {
        userId: meta.userId || "",
        network: requirements.network || "",
        reason,
      });
      return jsonResponse(
        {
          x402Version: X402_VERSION,
          error: reason,
        },
        402,
      );
    }

    writeShareEvent(env, "paid_view", slug, {
      userId: meta.userId || "",
      network: requirements.network || "",
    });

    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(
        settleHazbasePayment(env, requirementResult.paymentRequestId, xPaymentHeader).catch((err) => {
          console.error("[share-worker] hazbase settle failed", err?.stack || err);
          writeShareEvent(env, "settle_failed", slug, {
            userId: meta.userId || "",
            network: requirements.network || "",
            reason: String(err?.message || err || "").slice(0, 200),
          });
        }),
      );
    }

    const expMs = Date.now() + PAID_COOKIE_MAX_AGE_SEC * 1000;
    const newPaidToken = await signUnlockToken(slug, env, meta.paymentSalt, expMs);
    paymentExtraHeaders["set-cookie"] = [
      `${PAID_COOKIE_NAME}=${newPaidToken}`,
      `Path=/v/${slug}`,
      `Max-Age=${PAID_COOKIE_MAX_AGE_SEC}`,
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
    ].join("; ");
    const previewHeader = verifyResult?.responsePreview?.headers?.["x-payment-response"];
    if (previewHeader) {
      paymentExtraHeaders["x-payment-response"] = previewHeader;
    }
  } else {
    writeShareEvent(env, "paid_cookie_hit", slug, {
      userId: meta.userId || "",
      network: meta.paymentNetwork || X402_NETWORKS[meta.chainId]?.name || "",
    });
  }
}

  const url = new URL(request.url);
  const kind = meta.kind || LEGACY_KIND;
  const storedContentType = meta.contentType || LEGACY_CONTENT_TYPE;
  const wantsRawCsv = kind === "csv" && url.searchParams.get("raw") === "1";
  const wantsCsvDownload = wantsRawCsv && url.searchParams.get("download") === "1";

  // Content-Type + Content-Disposition the response will use.
  // - HTML: pass the stored bytes through as-is.
  // - PDF / image: pass-through with `Content-Disposition: inline` so browsers
  //   render rather than auto-download. Mobile Safari may still choose to
  //   download PDFs — that's an OS-level decision, not ours.
  // - CSV without ?raw=1: render to HTML table (served as text/html).
  // - CSV with ?raw=1: original bytes, attachment when ?download=1 is set.
  let responseContentType = storedContentType;
  let contentDisposition = null;
  if (kind === "pdf" || kind === "image") {
    contentDisposition = `inline; filename="${meta.originalName || "file"}"`;
  } else if (kind === "csv" && !wantsRawCsv) {
    // rendered table page — served as HTML
    responseContentType = "text/html; charset=utf-8";
  } else if (wantsCsvDownload) {
    contentDisposition = `attachment; filename="${meta.originalName || "file.csv"}"`;
  } else if (wantsRawCsv) {
    contentDisposition = `inline; filename="${meta.originalName || "file.csv"}"`;
  }

  // For HEAD, skip R2 fetch — return headers only. Content-Length is omitted
  // for the CSV-as-table path (we don't know the rendered length without
  // rendering) and when we'd otherwise report the raw file size for something
  // we're going to re-render.
  if (headOnly) {
    const headers = {
      "content-type": responseContentType,
      "cache-control": "private, no-store",
      ...SECURITY_HEADERS,
      ...paymentExtraHeaders,
    };
    if (contentDisposition) headers["content-disposition"] = contentDisposition;
    if (kind !== "csv" || wantsRawCsv) {
      headers["content-length"] = String(meta.size || 0);
    }
    return new Response(null, { status: 200, headers });
  }

  const obj = await env.SHARE_FILES.get(slug);
  if (!obj) return textResponse("Gone", 410, SECURITY_HEADERS);

  // CSV rendered as table — parse the body (as text) and emit an HTML page.
  // Uses a tight CSP since the rendered page has no scripts, no fonts, no
  // external resources; this closes the cell-content-as-HTML risk (we also
  // HTML-escape every cell in renderCsvTable) in case a CSV cell contains
  // something like `<script>`.
  if (kind === "csv" && !wantsRawCsv) {
    const text = await obj.text();
    const { rows, truncated } = parseCsv(text, { maxRows: CSV_MAX_RENDER_ROWS });
    const html = renderCsvTable({
      rows,
      truncated,
      originalName: meta.originalName || "data.csv",
      slug,
    });
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        ...SECURITY_HEADERS,
        ...paymentExtraHeaders,
      },
    });
  }

  const body = await obj.arrayBuffer();
  const headers = {
    "content-type": responseContentType,
    "cache-control": "private, no-store",
    ...SECURITY_HEADERS,
    ...paymentExtraHeaders,
  };
  if (contentDisposition) headers["content-disposition"] = contentDisposition;
  return new Response(body, { status: 200, headers });
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

  // ttlHours: default 24, cap 720 (30d). Also capped below
  // by meta.expiresAtMs so a token can never outlive the share itself.
  const MAX_TTL_HOURS = 720;
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

// True when the client's declared `Content-Type` header is plausibly right for
// the extension we inferred. Browsers sometimes send generic types
// (`application/octet-stream`) or skip the header entirely (upload via FormData
// without a declared type); in those cases the field is empty and the caller
// short-circuits this check.
function isDeclaredTypeCompatible(declared, kind) {
  const lower = (declared || "").toLowerCase();
  // Octet-stream is the "I don't know" fallback — accept it rather than reject
  // well-formed uploads that happened to omit a specific type.
  if (lower.includes("octet-stream")) return true;
  switch (kind) {
    case "html": return lower.includes("html");
    case "pdf":  return lower.includes("pdf");
    case "image":
      return lower.startsWith("image/") || lower.includes("png") ||
             lower.includes("jpeg") || lower.includes("jpg") ||
             lower.includes("gif") || lower.includes("webp");
    case "csv":
      // curl often sends `application/vnd.ms-excel` or `text/csv`; also accept
      // text/plain since the CLI used to hardcode html and some clients may
      // mislabel.
      return lower.includes("csv") || lower.includes("text/plain") ||
             lower.includes("excel");
    default: return false;
  }
}

// Magic-byte sniff per kind. Best-effort — a correctly-crafted corrupt payload
// can always slip through, but this catches the common "renamed the file"
// mistake and is cheap.
function sniffKind(bytes, kind) {
  switch (kind) {
    case "html":
      return looksLikeHtml(bytes);
    case "pdf":
      // "%PDF"
      return bytes.length >= 4 &&
        bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
    case "image":
      return sniffImage(bytes);
    case "csv":
      // CSV has no magic. Trust the extension + declared type.
      return true;
    default:
      return false;
  }
}

function sniffImage(bytes) {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
    return true;
  }
  // JPEG: FF D8
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xD8) return true;
  // GIF87a / GIF89a
  if (bytes.length >= 6 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return true;
  }
  // WebP: RIFF....WEBP
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// x402 payment helpers
//
// `parseUsdcPrice` / `isValidEthAddress` / `normalizeEthAddress` /
// `resolveChainId` are pure validators for the upload + patch paths.
// `build402Response` generates the spec-compliant 402 body.
// `facilitatorVerify` / `facilitatorSettle` are the only code paths that
// touch the external facilitator; both fail closed (verify returns isValid
// false on network error rather than silently unlocking).
//
// Note: we intentionally do NOT implement EIP-55 checksum normalization —
// that would require a keccak256 routine, which the Workers Web Crypto API
// doesn't provide. Lowercase hex is still a valid Ethereum address; the
// facilitator accepts it in payment requirements and verifies the signature
// against the raw 20 bytes regardless of cased vs. lowercased input.
// ---------------------------------------------------------------------------

// "0.10" → 100000n ; "1" → 1000000n ; "0.000001" → 1n.
// Returns null on bad format or >6 fractional digits.
function parseUsdcPrice(raw) {
  if (typeof raw !== "string") return null;
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) return null;
  const [whole, frac = ""] = raw.split(".");
  // Pad fractional part to exactly 6 digits (USDC decimals).
  const padded = frac.padEnd(6, "0").slice(0, 6);
  // Strip leading zeros (but preserve a single zero for "0").
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  try {
    return BigInt(combined || "0");
  } catch {
    return null;
  }
}

function isValidEthAddress(addr) {
  return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function normalizeEthAddress(addr) {
  // Lowercase hex. See comment block above re: EIP-55.
  return String(addr || "").toLowerCase();
}

function normalizeRequestedPayoutMethod(raw) {
  return typeof raw === "string" && raw.trim() === "hazbase_wallet"
    ? "hazbase_wallet"
    : "external_eoa";
}

function parseRequestedPayoutAddress(...values) {
  let normalized = null;
  let sawValue = false;
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    sawValue = true;
    if (!trimmed) continue;
    if (!isValidEthAddress(trimmed)) {
      return { error: "invalid-payTo", sawValue };
    }
    const next = normalizeEthAddress(trimmed);
    if (normalized && normalized !== next) {
      return { error: "conflicting-payout-address", sawValue };
    }
    normalized = next;
  }
  return { address: normalized, sawValue };
}

function resolveChainId(env, explicitNetwork = "") {
  const net = String(explicitNetwork || env?.X402_NETWORK || "").toLowerCase().trim();
  if (net === "base") return 8453;
  if (net === "base-sepolia" || net === "basesepolia" || net === "sepolia") return 84532;
  return null;
}

function decodeX402Header(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const bytes = base64ToBytes(raw);
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Strip query string + fragment so the canonicalized `resource` we hand to
// the facilitator matches whatever the client computed when signing. Any
// per-request params (`?t=<token>`, `?raw=1`, etc.) would otherwise make the
// signature fail verification.
function canonicalizeResourceUrl(requestUrl) {
  try {
    const u = new URL(requestUrl);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return String(requestUrl).split("?")[0].split("#")[0];
  }
}


function hazbaseApiBase(env) {
  return String(env?.HAZBASE_API_ENDPOINT || DEFAULT_HAZBASE_API_ENDPOINT).replace(/\/$/u, "");
}

function effectivePaymentNetwork(meta) {
  return meta.paymentNetwork || (meta.chainId ? X402_NETWORKS[meta.chainId]?.name || null : null);
}

function buildHazbasePaymentPayload(meta, slug, requestUrl) {
  const network = effectivePaymentNetwork(meta);
  const payoutAddress = meta.payoutAddress || meta.payTo;
  if (!network || !payoutAddress) return null;
  return {
    resourceId: `share:${slug}`,
    resourceUrl: canonicalizeResourceUrl(requestUrl),
    description: `Unlock viveworker share ${slug}`,
    mimeType: meta.contentType || LEGACY_CONTENT_TYPE,
    network,
    asset: "usdc",
    priceAtomic: meta.price,
    payoutMethod: {
      kind: "external_eoa",
      address: payoutAddress,
    },
    metadata: {
      slug,
      ownerUserId: meta.userId || "",
      paymentSalt: meta.paymentSalt || "",
      payoutOriginKind: meta.payoutMethod || "external_eoa",
    },
  };
}

async function requestHazbasePaymentRequirements(env, meta, slug, requestUrl) {
  const payload = buildHazbasePaymentPayload(meta, slug, requestUrl);
  if (!payload) return { ok: false, errorCode: "payment-network-not-configured" };
  try {
    const res = await fetch(`${hazbaseApiBase(env)}/api/payments/x402/requirements`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": `share_req_${crypto.randomUUID()}`,
      },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => null);
    const data = json?.data || json;
    if (!res.ok || !data?.paymentRequestId || !data?.x402?.accepts?.[0]) {
      return { ok: false, errorCode: data?.errorCode || data?.error || "payment-service-unavailable" };
    }
    const x402 = {
      ...data.x402,
      // Non-standard but additive: viveworker's hazBase Smart Wallet buyer
      // can use this stable id to ask hazBase to execute the payment, while
      // normal x402 clients keep reading accepts[0] unchanged.
      paymentRequestId: data.paymentRequestId,
      hazbase: { paymentRequestId: data.paymentRequestId },
    };
    return {
      ok: true,
      paymentRequestId: data.paymentRequestId,
      x402,
      requirements: x402.accepts[0],
    };
  } catch (err) {
    console.error("[share-worker] hazbase requirements error", err?.stack || err);
    return { ok: false, errorCode: "payment-service-unavailable" };
  }
}

async function verifyHazbasePayment(env, paymentRequestId, xPaymentHeader) {
  const res = await fetch(`${hazbaseApiBase(env)}/api/payments/x402/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": `share_verify_${crypto.randomUUID()}`,
    },
    body: JSON.stringify({ paymentRequestId, xPayment: xPaymentHeader }),
  });
  const json = await res.json().catch(() => null);
  return json?.data || json;
}

async function settleHazbasePayment(env, paymentRequestId, xPaymentHeader) {
  const res = await fetch(`${hazbaseApiBase(env)}/api/payments/x402/settle`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": `share_settle_${crypto.randomUUID()}`,
    },
    body: JSON.stringify({ paymentRequestId, xPayment: xPaymentHeader }),
  });
  const json = await res.json().catch(() => null);
  return json?.data || json;
}

// Header-only advertisement of the payment gate. Used on both GET and HEAD so
// a client that (a) can't read non-2xx bodies (some agent fetch wrappers error
// on 402 and drop the body entirely) or (b) does a preflight HEAD before
// committing to a GET can still extract price/recipient/chain purely from
// response headers. Not a substitute for the x402 JSON body — this is a hint,
// not the protocol payload. Returns an empty object if `requirements` is null.
function buildPaymentHintHeaders(requirements) {
  if (!requirements) return {};
  const link = `<${requirements.resource}>; rel="payment"; type="application/json"`;
  // Compact, RFC-7230-safe parameter list. All token-form (no quoting needed)
  // because scheme/network/asset/payTo/amount are alphanumeric + 0x-prefixed
  // hex. Clients can split on `; ` and then on `=`.
  const hint = [
    `x402Version=${X402_VERSION}`,
    `scheme=${requirements.scheme}`,
    `network=${requirements.network}`,
    `amount=${requirements.maxAmountRequired}`,
    `asset=${requirements.asset}`,
    `payTo=${requirements.payTo}`,
    `maxTimeoutSeconds=${requirements.maxTimeoutSeconds}`,
  ].join("; ");
  return {
    link,
    "x-payment-required": hint,
  };
}

// Accept-header content negotiation. Browsers (Accept contains text/html) get
// a styled 402 page; everything else — x402-fetch, curl default (*/*), Cursor,
// AgentKit, etc. — keeps seeing the spec-compliant JSON body. Crucially, the
// status stays 402 in both cases, so x402 clients that branch on status (not
// body) still recognise the payment gate correctly.
function prefersHtml(request) {
  const accept = String(request.headers.get("accept") || "").toLowerCase();
  if (!accept) return false;
  // A browser default Accept starts with `text/html,...`. Only treat the
  // request as HTML-preferring if text/html appears before (or without) any
  // machine types. This avoids misrouting x402 clients that might send
  // `Accept: application/json, text/html` or `*/*` alone.
  const htmlIdx = accept.indexOf("text/html");
  if (htmlIdx === -1) return false;
  const jsonIdx = accept.indexOf("application/json");
  const x402Idx = accept.indexOf("application/x-x402+json");
  if (jsonIdx !== -1 && jsonIdx < htmlIdx) return false;
  if (x402Idx !== -1 && x402Idx < htmlIdx) return false;
  return true;
}

function build402Response(request, slug, jsonBody) {
  const requirements = jsonBody?.accepts?.[0];
  if (!requirements) {
    return jsonResponse(
      { x402Version: X402_VERSION, error: "payment-network-not-configured" },
      500,
    );
  }
  // `Link: rel="payment"` (RFC 8288) + `X-Payment-Required` header-only hint.
  // HEAD shares the same helper so preflight responses are symmetric with GET.
  const hintHeaders = buildPaymentHintHeaders(requirements);
  if (prefersHtml(request)) {
    return new Response(build402HtmlBody(jsonBody, requirements, slug), {
      status: 402,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        ...hintHeaders,
        ...SECURITY_HEADERS,
      },
    });
  }
  return new Response(JSON.stringify(jsonBody), {
    status: 402,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      ...hintHeaders,
      ...SECURITY_HEADERS,
    },
  });
}

// Pretty 402 page for humans. Keeps the x402 protocol fully intact by:
// 1. Using status 402 on the Response (see build402Response caller).
// 2. Embedding the full x402 JSON body as <script type="application/x-x402+json">
//    so any browser-resident x402 agent can parse the same payload.
// 3. Emitting the same Link: rel="payment" header on the wrapping Response.
// No inline JS / external resources — CSP-safe and works on any static-CSP
// Worker. USDC atomic units are formatted to a decimal for display only;
// the embedded JSON keeps the atomic-units string authoritative.
function build402HtmlBody(jsonBody, requirements, slug) {
  const network = requirements.network;
  const isTestnet = network === "base-sepolia";
  const netLabel = isTestnet ? "Base Sepolia (testnet)" : "Base (mainnet)";
  const priceDecimal = formatUsdcAtomic(requirements.maxAmountRequired);
  const payToShort = shortenAddress(requirements.payTo);
  const resourceDisplay = escapeHtml(requirements.resource);
  const descriptionDisplay = escapeHtml(requirements.description || `Unlock viveworker share ${slug}`);
  const payToDisplay = escapeHtml(requirements.payTo);
  const payToShortDisplay = escapeHtml(payToShort);
  const assetDisplay = escapeHtml(requirements.asset);
  const jsonPretty = JSON.stringify(jsonBody, null, 2);
  const jsonForScript = jsonPretty.replace(/<\/script/giu, "<\\/script");
  // Origin derived from the resource URL (always absolute in the x402 body).
  // Fallback to production host on any parse failure.
  let origin = "https://share.viveworker.com";
  try { origin = new URL(requirements.resource).origin; } catch {}
  const ogDescription = `Payment required · ${priceDecimal} USDC on ${netLabel}. Gated via x402.`;
  const codeSnippet = [
    `// buyer side (Node.js, requires viem + x402-fetch + a Base Sepolia wallet)`,
    `import { wrapFetchWithPayment } from "x402-fetch";`,
    `import { createWalletClient, http } from "viem";`,
    `import { privateKeyToAccount } from "viem/accounts";`,
    `import { ${isTestnet ? "baseSepolia" : "base"} } from "viem/chains";`,
    ``,
    `const wallet = createWalletClient({`,
    `  account: privateKeyToAccount(process.env.BUYER_PK),`,
    `  chain: ${isTestnet ? "baseSepolia" : "base"},`,
    `  transport: http(),`,
    `});`,
    `const fetchPaid = wrapFetchWithPayment(fetch, wallet);`,
    `const res = await fetchPaid(${JSON.stringify(requirements.resource)});`,
    `console.log(await res.text());`,
  ].join("\n");
  const codeSnippetEscaped = escapeHtml(codeSnippet);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Payment required · viveworker share</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON_LINK}
<meta name="description" content="${escapeHtml(ogDescription)}">
<meta property="og:type" content="website">
<meta property="og:title" content="Payment required · viveworker share">
<meta property="og:description" content="${escapeHtml(ogDescription)}">
<meta property="og:url" content="${escapeHtml(requirements.resource)}">
<meta property="og:image" content="${origin}/og/default.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Payment required · viveworker share">
<meta name="twitter:description" content="${escapeHtml(ogDescription)}">
<meta name="twitter:image" content="${origin}/og/default.png">
<meta name="robots" content="noindex, nofollow">
<style>
  :root {
    color-scheme: light dark;
    --bg: #0b0f17;
    --fg: #e8ecf1;
    --dim: #8a9099;
    --muted: #6b727c;
    --accent: #5ce0a8;
    --warn: #f4b942;
    --card: #141a24;
    --card-2: #1a2130;
    --border: #233040;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f7f9;
      --fg: #161a22;
      --dim: #4a525c;
      --muted: #6b727c;
      --accent: #0a9863;
      --warn: #a07216;
      --card: #ffffff;
      --card-2: #f0f2f6;
      --border: #dfe3ea;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif;
    background: var(--bg);
    color: var(--fg);
    min-height: 100vh;
    display: grid;
    /* Center the card vertically in the viewport when content fits; when it
       overflows (accordion open on small screens), grid stretches the row and
       centering becomes a no-op — the page scrolls normally. */
    place-items: center;
    padding: 40px 20px;
    line-height: 1.5;
  }
  .wrap { width: 100%; max-width: 640px; }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 32px;
    margin-bottom: 16px;
  }
  .card + .card { background: var(--card-2); }
  /* Bare intro — no card chrome; content flows flush with the page. */
  .intro {
    padding: 4px 4px 0;
    margin-bottom: 24px;
  }
  /* "How to pay" also bare — the <pre> block carries its own frame, and the
     tools <ul> uses border-tops for separation, so the section doesn't need
     another outer frame. */
  .how-to-pay {
    padding: 4px 4px 0;
    margin-top: 4px;
  }
  h1 {
    margin: 0 0 6px;
    font-size: 22px;
    letter-spacing: -0.01em;
  }
  .subtitle {
    margin: 0 0 24px;
    color: var(--dim);
    font-size: 14px;
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(244, 185, 66, 0.14);
    color: var(--warn);
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    margin-bottom: 16px;
    text-transform: uppercase;
  }
  .price {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 8px 0 20px;
  }
  .price .amount {
    font-size: 42px;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1;
  }
  .price .unit {
    font-size: 16px;
    color: var(--dim);
    font-weight: 500;
  }
  .testnet-note {
    background: rgba(244, 185, 66, 0.10);
    border: 1px solid rgba(244, 185, 66, 0.35);
    color: var(--warn);
    padding: 10px 12px;
    border-radius: 8px;
    font-size: 13px;
    margin-bottom: 20px;
  }
  /* Prominent beta banner — shown above the intro so buyers can't miss that
     paid shares are testnet-only closed beta. Distinct from .testnet-note
     (which only appears inside the expanded payment-details card). */
  .beta-banner {
    background: rgba(244, 185, 66, 0.18);
    border: 1px solid rgba(244, 185, 66, 0.55);
    color: var(--warn);
    padding: 12px 16px;
    border-radius: 10px;
    font-size: 13px;
    line-height: 1.45;
    margin-bottom: 24px;
    text-align: center;
  }
  .beta-banner strong { letter-spacing: 0.05em; }
  dl {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 10px 16px;
    margin: 0;
    font-size: 13px;
  }
  dt { color: var(--dim); }
  dd {
    margin: 0;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    word-break: break-all;
  }
  dd.mono-dim { color: var(--muted); font-size: 12px; }
  h2 {
    font-size: 14px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--dim);
    margin: 0 0 12px;
    font-weight: 600;
  }
  p.card-lead {
    margin: 0 0 16px;
    font-size: 14px;
    color: var(--fg);
  }
  pre {
    background: rgba(0, 0, 0, 0.35);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
    overflow-x: auto;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12px;
    line-height: 1.5;
    margin: 0 0 14px;
  }
  @media (prefers-color-scheme: light) {
    pre { background: #0f1624; color: #e8ecf1; }
  }
  /* Footer — spec matches worker/worker.js profile page (renderProfileHtml). */
  footer { margin-top: 2rem; text-align: center; }
  .footer-brand {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--accent);
    text-decoration: none;
  }
  .footer-brand:hover { text-decoration: underline; }
  .footer-links {
    font-size: 0.75rem;
    color: var(--muted);
    margin-top: 0.3rem;
  }
  .footer-links a { color: var(--muted); text-decoration: none; }
  .footer-links a:hover { color: var(--accent); }
  ul.tools {
    list-style: none;
    padding: 0;
    margin: 0;
    font-size: 13px;
  }
  ul.tools li {
    padding: 6px 0;
    border-top: 1px solid var(--border);
  }
  ul.tools li:first-child { border-top: 0; }
  ul.tools code {
    background: rgba(92, 224, 168, 0.10);
    color: var(--accent);
    padding: 1px 6px;
    border-radius: 4px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12px;
  }
  /* Accordion — pure HTML <details>/<summary>, no JS. CSP-safe. Frameless
     summary — reads as a link-ish toggle, not a button. */
  details.accordion { margin: 0 0 16px; }
  details.accordion > summary {
    cursor: pointer;
    padding: 4px 4px;
    font-weight: 500;
    font-size: 14px;
    color: var(--accent);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    list-style: none;
    user-select: none;
    width: fit-content;
  }
  details.accordion > summary:hover { text-decoration: underline; }
  details.accordion > summary::-webkit-details-marker { display: none; }
  details.accordion > summary::marker { content: ""; }
  details.accordion > summary .chev {
    font-size: 10px;
    color: var(--dim);
    transition: transform 0.2s ease;
  }
  details.accordion[open] > summary .chev { transform: rotate(180deg); }
  details.accordion[open] > summary { margin-bottom: 16px; }
</style>
</head>
<body>
<main class="wrap">
  ${isTestnet ? `<div class="beta-banner">
    <strong>⚠ CLOSED BETA</strong> · viveworker paid shares are gated on <strong>Base Sepolia</strong> (testnet).
    No real USDC is being moved. Pay with <a href="https://faucet.circle.com" target="_blank" rel="noopener" style="color: inherit; text-decoration: underline;">test USDC</a>; wallets, settlements, and this UI may change without notice.
  </div>` : ""}
  <section class="intro">
    <span class="status">402 · Payment Required</span>
    <h1>Unlock this share</h1>
    <p class="subtitle">This viveworker share is gated by an <a href="https://x402.org" style="color: inherit;">x402</a> payment. Pay the amount below in USDC on Base and the content unlocks instantly.</p>
  </section>

  <details class="accordion">
    <summary>
      <span>Show payment details</span>
      <span class="chev" aria-hidden="true">▼</span>
    </summary>

    <section class="card">
      ${isTestnet ? `<div class="testnet-note">⚠️ Testnet — this share is on <strong>Base Sepolia</strong>. Use <strong>test USDC</strong> from the Circle faucet; any "payment" here has no monetary value.</div>` : ""}
      <div class="price">
        <span class="amount">${escapeHtml(priceDecimal)}</span>
        <span class="unit">USDC · ${escapeHtml(netLabel)}</span>
      </div>
      <dl>
        <dt>Pay to</dt>
        <dd title="${payToDisplay}">${payToShortDisplay}</dd>
        <dt>Share</dt>
        <dd>${escapeHtml(slug)}</dd>
        <dt>Resource</dt>
        <dd class="mono-dim">${resourceDisplay}</dd>
        <dt>Asset</dt>
        <dd class="mono-dim">USDC @ ${assetDisplay}</dd>
        <dt>Network ID</dt>
        <dd>${escapeHtml(String(requirements.network))}</dd>
      </dl>
    </section>

    <section class="how-to-pay">
      <h2>How to pay</h2>
      <p class="card-lead">You need an x402-compatible client (viveworker does not ship a buyer wallet). Easiest path:</p>
      <pre>${codeSnippetEscaped}</pre>
      <ul class="tools">
        <li><strong>x402-fetch</strong> (npm) — spec-compliant <code>fetch</code> wrapper, works with any <a href="https://viem.sh" style="color: inherit;">viem</a> wallet client.</li>
        <li><strong>Coinbase AgentKit</strong> — <code>x402</code> action, drop-in for CDP-built agents.</li>
        <li><strong>Raw curl</strong> — possible if you can sign EIP-3009 <code>transferWithAuthorization</code> yourself and base64 it into <code>X-PAYMENT</code>. Spec: <a href="https://x402.org" style="color: inherit;">x402.org</a>.</li>
      </ul>
    </section>
  </details>

  <footer>
    <a href="https://viveworker.com" target="viveworker" class="footer-brand">viveworker</a>
    <div class="footer-links">
      <a href="/">Home</a>
      &nbsp;&middot;&nbsp;
      <a href="https://x402.org/" target="_blank" rel="noopener">x402 protocol</a>
    </div>
  </footer>
</main>
<script type="application/x-x402+json">${jsonForScript}</script>
</body>
</html>`;
}

// Format USDC atomic units (6 decimals) as a human-facing decimal string.
// Matches scripts/share-cli.mjs formatUsdc so the displayed value on the 402
// page matches what sellers see in their CLI. Falls back to "0.00" on bad
// input — the embedded JSON still carries the authoritative atomic value.
function formatUsdcAtomic(atomic) {
  let n;
  try {
    n = BigInt(String(atomic || "0"));
  } catch {
    return "0.00";
  }
  if (n < 0n) n = -n;
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  if (!frac) return `${whole}.00`;
  return `${whole}.${frac.padEnd(2, "0")}`;
}

function shortenAddress(addr) {
  const s = String(addr || "");
  if (s.length < 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}
// escapeHtml is defined further down (shared with renderCsvTable / the unlock
// form / renderLanding). The two callers use identical semantics so we share
// one implementation.

async function facilitatorVerify(env, meta, xPaymentHeader, requestUrl, slug) {
  const payload = decodeX402Header(xPaymentHeader);
  if (!payload) return { isValid: false, invalidReason: "malformed-x-payment" };
  const requirements = buildPaymentRequirements(meta, slug, requestUrl);
  if (!requirements) return { isValid: false, invalidReason: "payment-network-not-configured" };
  const facilitatorUrl = String(env.X402_FACILITATOR_URL || "").replace(/\/$/u, "");
  if (!facilitatorUrl) return { isValid: false, invalidReason: "facilitator-not-configured" };
  const body = {
    x402Version: X402_VERSION,
    paymentPayload: payload,
    paymentRequirements: requirements,
  };
  try {
    const res = await fetch(`${facilitatorUrl}/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.X402_FACILITATOR_AUTH
          ? { authorization: `Bearer ${env.X402_FACILITATOR_AUTH}` }
          : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { isValid: false, invalidReason: "facilitator-unavailable" };
    }
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object") {
      return { isValid: false, invalidReason: "facilitator-bad-response" };
    }
    return json;
  } catch (err) {
    console.error("[share-worker] facilitator verify error", err?.stack || err);
    return { isValid: false, invalidReason: "facilitator-unavailable" };
  }
}

async function facilitatorSettle(env, meta, xPaymentHeader, requestUrl, slug) {
  const payload = decodeX402Header(xPaymentHeader);
  if (!payload) return { success: false };
  const requirements = buildPaymentRequirements(meta, slug, requestUrl);
  if (!requirements) return { success: false };
  const facilitatorUrl = String(env.X402_FACILITATOR_URL || "").replace(/\/$/u, "");
  if (!facilitatorUrl) return { success: false };
  const body = {
    x402Version: X402_VERSION,
    paymentPayload: payload,
    paymentRequirements: requirements,
  };
  const res = await fetch(`${facilitatorUrl}/settle`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.X402_FACILITATOR_AUTH
        ? { authorization: `Bearer ${env.X402_FACILITATOR_AUTH}` }
        : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { success: false };
  return await res.json().catch(() => ({ success: false }));
}

// ---------------------------------------------------------------------------
// Analytics Engine readback (payment-flow metrics)
//
// Follows the a2a worker's `queryAnalytics` pattern: POST SQL to the CF REST
// endpoint with a scoped API token. The dataset is `viveworker_share_events`
// (see writeShareEvent). All queries here filter by blob2=userId (the owner
// of the share), so users only see metrics for their own paid shares.
// ---------------------------------------------------------------------------

const SHARE_ANALYTICS_DATASET = "viveworker_share_events";
const SHARE_ANALYTICS_SQL_URL = "https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql";

async function queryShareAnalytics(env, sql) {
  const accountId = env.CF_ACCOUNT_ID || "";
  const apiToken = env.CF_API_TOKEN || "";
  if (!accountId || !apiToken) return null;
  const url = SHARE_ANALYTICS_SQL_URL.replace("{account_id}", accountId);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiToken}` },
      body: sql,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("[share-worker] analytics query error", err?.stack || err);
    return null;
  }
}

// GET /api/metrics — payment-flow stats for the caller's paid shares.
// 24h and 7d breakdowns by event type + per-slug drill-down. Auth is the
// same `X-A2A-User` / `X-A2A-Key` pair used everywhere else in this worker.
async function handleShareMetrics(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    return jsonResponse(
      {
        error: "metrics-not-configured",
        hint: "worker operator must set CF_ACCOUNT_ID and CF_API_TOKEN secrets",
      },
      501,
    );
  }

  // userId comes from `authenticate`, so it's already validated against
  // /^[a-zA-Z0-9_-]{1,64}$/. Strip single quotes defensively (matches a2a's
  // pattern) before interpolating into SQL.
  const safeUserId = user.userId.replace(/'/g, "");

  // Count-by-event over two windows. `_sample_interval` is the sampling-
  // preserving aggregation (matches a2a's pattern). blob1 IN (...) filters
  // out spurious writes and trims the response.
  const EVENTS = [
    "upload_paid",
    "402_served",
    "402_served_head",
    "paid_view",
    "paid_cookie_hit",
    "verify_failed",
    "facilitator_unavailable",
    "settle_failed",
  ];
  const eventList = EVENTS.map((e) => `'${e}'`).join(",");

  const sql24h = `
    SELECT blob1 AS event, SUM(_sample_interval) AS count
    FROM ${SHARE_ANALYTICS_DATASET}
    WHERE blob2 = '${safeUserId}'
      AND blob1 IN (${eventList})
      AND timestamp > NOW() - INTERVAL '1' DAY
    GROUP BY blob1
  `;
  const sql7d = `
    SELECT blob1 AS event, SUM(_sample_interval) AS count
    FROM ${SHARE_ANALYTICS_DATASET}
    WHERE blob2 = '${safeUserId}'
      AND blob1 IN (${eventList})
      AND timestamp > NOW() - INTERVAL '7' DAY
    GROUP BY blob1
  `;
  // Per-slug breakdown over 7d — only keeps shares with any recorded event.
  // Separate "views" (paid_view + paid_cookie_hit) and "402s" for readability.
  const sqlPerSlug = `
    SELECT index1 AS slug, blob1 AS event, SUM(_sample_interval) AS count
    FROM ${SHARE_ANALYTICS_DATASET}
    WHERE blob2 = '${safeUserId}'
      AND blob1 IN (${eventList})
      AND timestamp > NOW() - INTERVAL '7' DAY
    GROUP BY index1, blob1
  `;

  const [r24h, r7d, rPerSlug] = await Promise.all([
    queryShareAnalytics(env, sql24h),
    queryShareAnalytics(env, sql7d),
    queryShareAnalytics(env, sqlPerSlug),
  ]);

  const emptyBucket = () => {
    const o = {};
    for (const e of EVENTS) o[e] = 0;
    return o;
  };
  const parseRows = (res) => {
    const out = emptyBucket();
    if (!res || !Array.isArray(res.data)) return out;
    for (const row of res.data) {
      const k = row.event;
      if (k && k in out) out[k] = Math.round(Number(row.count) || 0);
    }
    return out;
  };
  const parsePerSlug = (res) => {
    const perSlug = {};
    if (!res || !Array.isArray(res.data)) return [];
    for (const row of res.data) {
      const slug = row.slug;
      if (!slug) continue;
      if (!perSlug[slug]) perSlug[slug] = emptyBucket();
      const k = row.event;
      if (k && k in perSlug[slug]) {
        perSlug[slug][k] = Math.round(Number(row.count) || 0);
      }
    }
    // Rank by total activity so the CLI can truncate without surprising the
    // user — active shares surface first.
    return Object.entries(perSlug)
      .map(([slug, counts]) => {
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        return { slug, total, counts };
      })
      .sort((a, b) => b.total - a.total);
  };

  return jsonResponse({
    ok: true,
    userId: user.userId,
    network: resolveChainId(env) ? X402_NETWORKS[resolveChainId(env)].name : null,
    last24h: parseRows(r24h),
    last7d: parseRows(r7d),
    perSlug7d: parsePerSlug(rPerSlug),
  });
}

// ---------------------------------------------------------------------------
// CSV parsing + HTML table rendering
//
// Used by handleView for shares with kind === "csv". Stays pure / sync so a
// rendered response takes ~1ms even for the max-sized 5MB input (which is
// bounded further by `maxRows` — free-tier Workers have a ~10ms CPU budget so
// an unbounded parse of a pathological 5MB one-row CSV would be a DOS).
//
// RFC 4180-ish: handles quoted fields, escaped `""` inside quotes, and
// \r\n / \n / \r line endings. Does NOT try to handle multi-line fields
// embedded inside quotes — rare in practice and a rabbit hole we don't need
// for viewing purposes; a malformed CSV renders as best-effort.
// ---------------------------------------------------------------------------

function parseCsv(text, { maxRows } = {}) {
  const rows = [];
  let truncated = false;
  if (typeof text !== "string" || text.length === 0) return { rows, truncated };

  // Strip UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  let field = "";
  let row = [];
  let inQuotes = false;
  const rowLimit = Number.isFinite(maxRows) && maxRows > 0 ? maxRows : Infinity;

  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { pushField(); continue; }
    if (c === '\n' || c === '\r') {
      pushField();
      pushRow();
      if (rows.length >= rowLimit) { truncated = true; break; }
      // Consume a following \n after \r so \r\n counts once.
      if (c === '\r' && text[i + 1] === '\n') i++;
      continue;
    }
    field += c;
  }
  // Trailing row without terminator.
  if (!truncated && (field.length > 0 || row.length > 0)) {
    pushField();
    pushRow();
  }
  return { rows, truncated };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderCsvTable({ rows, truncated, originalName, slug }) {
  const header = rows[0] || [];
  const body = rows.slice(1);
  const title = escapeHtml(originalName);
  const safeSlug = encodeURIComponent(slug);

  const headerHtml = header.length
    ? `<thead><tr>${header.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>`
    : "";
  const bodyHtml = body.map(
    (r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`
  ).join("");

  const truncNotice = truncated
    ? `<div class="notice">Showing first ${CSV_MAX_RENDER_ROWS} rows. <a href="?raw=1&download=1">Download raw CSV</a> for the full file.</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${title} — viveworker share</title>
<style>
  :root { color-scheme: dark; }
  *{box-sizing:border-box}
  body{margin:0;background:#0a0f0d;color:#e6e6e6;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  header{padding:1rem 1.2rem;border-bottom:1px solid #1e2e28;display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}
  h1{margin:0;font-size:1rem;font-weight:600;color:#e6e6e6;word-break:break-all}
  .actions a{color:#00d4aa;text-decoration:none;font-size:0.85rem}
  .actions a:hover{text-decoration:underline}
  .notice{padding:0.6rem 1.2rem;background:#2a1a08;color:#f0c070;border-bottom:1px solid #3a2a18;font-size:0.85rem}
  .scroll{overflow:auto;max-height:calc(100vh - 56px)}
  table{border-collapse:collapse;min-width:100%;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  thead{position:sticky;top:0;background:#111916;z-index:1}
  th,td{padding:0.45rem 0.8rem;border-bottom:1px solid #1e2e28;text-align:left;vertical-align:top;white-space:pre-wrap;word-break:break-word}
  th{font-weight:600;color:#00d4aa;border-bottom-color:#2a3e38;background:#111916}
  tbody tr:nth-child(even){background:#0d1512}
  tbody tr:hover{background:#132420}
  footer{padding:0.8rem 1.2rem;border-top:1px solid #1e2e28;font-size:0.75rem;color:#556;text-align:center}
  footer a{color:#00d4aa;text-decoration:none}
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <div class="actions">
    <a href="?raw=1&amp;download=1">Download raw CSV</a>
  </div>
</header>
${truncNotice}
<div class="scroll">
<table>
  ${headerHtml}
  <tbody>${bodyHtml}</tbody>
</table>
</div>
<footer><a href="https://a2a.viveworker.com" rel="noopener">viveworker share</a> · /v/${safeSlug}</footer>
</body>
</html>`;
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

function renderLanding(request) {
  // Design language borrowed from worker/worker.js handleLandingPage (the A2A
  // landing): same dark palette (#0a0f0d + #00d4aa accent), same tagline /
  // logo-mark / "Who are you?" chooser pattern, same radio-toggle disclosure
  // panels, same footer shape. Pure-CSS — no JS beyond the onclick clipboard
  // helper on .copy-box (matches A2A behaviour). Share swaps the bee mark for
  // the Open Cell honeycomb, but the slot is identical.
  const acceptedTypes = ALLOWED_EXTENSIONS.join(" · ");
  // Absolute origin for OG tags — social scrapers (Twitter/Discord/Slack/LINE)
  // reject relative URLs. Fallback to the production host if `request` is ever
  // omitted (the API prefers requestless callers over crashing).
  const origin = request ? new URL(request.url).origin : "https://share.viveworker.com";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>viveworker share</title>
  ${FAVICON_LINK}
  <meta name="description" content="Private file hosting for agents. Upload HTML, PDFs, images, or CSVs and hand back an unguessable link. Paywall with USDC or gate with a password.">
  <meta property="og:type" content="website">
  <meta property="og:title" content="viveworker share">
  <meta property="og:description" content="Private file hosting for agents. Upload HTML, PDFs, images, or CSVs and hand back an unguessable link. Paywall with USDC or gate with a password.">
  <meta property="og:url" content="${origin}">
  <meta property="og:image" content="${origin}/og/default.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="viveworker share">
  <meta name="twitter:description" content="Private file hosting for agents. Upload HTML, PDFs, images, or CSVs and hand back an unguessable link. Paywall with USDC or gate with a password.">
  <meta name="twitter:image" content="${origin}/og/default.png">
  <meta name="robots" content="noindex, nofollow">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, system-ui, 'Segoe UI', sans-serif;
      background: #0a0f0d; color: #e0e6e3;
      min-height: 100vh; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 2rem 1rem;
    }
    header { text-align: center; margin-bottom: 2.5rem; }
    .logo-mark { width: 22px; height: 22px; margin-right: 0.4rem; vertical-align: -0.2em; }
    header h1 { font-size: 1.8rem; color: #fff; font-weight: 700; margin-bottom: 0.5rem; letter-spacing: -0.02em; }
    .tagline {
      font-size: 0.8rem; color: #00d4aa; text-transform: uppercase;
      letter-spacing: 0.12em; font-weight: 600; margin-bottom: 0.5rem;
    }
    header .sub { color: #7a8a82; font-size: 0.95rem; }
    .chooser { width: 100%; max-width: 560px; }
    .prompt { text-align: center; color: #7a8a82; font-size: 1.05rem; margin-bottom: 1.2rem; }
    .buttons { display: flex; gap: 1rem; justify-content: center; margin-bottom: 1.5rem; }
    input[type="radio"] { position: absolute; opacity: 0; pointer-events: none; }
    .btn {
      display: block; padding: 1rem 1.8rem; border-radius: 999px; cursor: pointer;
      font-size: 1rem; font-weight: 600; text-align: center;
      background: transparent; border: 1px solid #2a3a32; color: #e0e6e3;
      transition: border-color 0.2s, background 0.2s, box-shadow 0.2s;
      user-select: none; flex: 1; max-width: 240px;
    }
    .btn:hover { border-color: #00d4aa; background: rgba(0,212,170,0.06); }
    #choose-agent:checked ~ .buttons label[for="choose-agent"],
    #choose-human:checked ~ .buttons label[for="choose-human"] {
      border-color: #00d4aa; background: rgba(0,212,170,0.1);
      box-shadow: 0 0 0 1px #00d4aa;
      color: #fff;
    }
    .panel {
      max-height: 0; overflow: hidden; opacity: 0;
      transition: max-height 0.5s ease, opacity 0.3s ease, margin 0.3s ease;
      background: #0f1512; border: 1px solid #1e2e26; border-radius: 16px;
    }
    #choose-agent:checked ~ .panel-agent,
    #choose-human:checked ~ .panel-human {
      max-height: 1400px; opacity: 1; padding: 1.5rem; margin-bottom: 1rem;
    }
    .panel h2 { font-size: 1.15rem; color: #fff; font-weight: 700; margin-bottom: 1rem; }
    .panel h3.section-title {
      font-size: 0.75rem; color: #00d4aa; text-transform: uppercase;
      letter-spacing: 0.1em; font-weight: 600; margin-bottom: 0.8rem;
      padding-bottom: 0.4rem; border-bottom: 1px solid #1e2e26;
    }
    .section-block { margin-bottom: 1.5rem; }
    .section-block:last-child { margin-bottom: 0; }
    .human-note {
      color: #7a8a82; font-size: 0.85rem; line-height: 1.6;
      margin-bottom: 0.8rem;
    }
    .human-note strong { color: #e0e6e3; }
    .human-note code {
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 0.78rem; color: #5ce0b8; background: #0a0f0d;
      padding: 0.15rem 0.4rem; border-radius: 4px; border: 1px solid #1e2e26;
    }
    .copy-box {
      background: #0a0f0d; border: 1px solid #1e2e26; border-radius: 12px;
      padding: 0.9rem 1rem; margin: 1rem 0; text-align: center;
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 0.85rem; color: #5ce0b8; word-break: break-all;
      cursor: pointer; position: relative;
      transition: border-color 0.2s;
    }
    .copy-box:hover { border-color: #00d4aa; }
    .copy-box::after {
      content: "click to copy"; position: absolute; right: 10px; top: 10px;
      font-size: 0.65rem; color: #3d5a4c; font-family: -apple-system, system-ui, sans-serif;
    }
    .cmd {
      display: block; background: #0a0f0d; border: 1px solid #1e2e26; border-radius: 10px;
      padding: 0.7rem 0.9rem; margin: 0.5rem 0 0;
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 0.82rem; color: #5ce0b8; word-break: break-all;
      cursor: pointer; position: relative; transition: border-color 0.2s;
    }
    .cmd:hover { border-color: #00d4aa; }
    .types-line {
      color: #5a6a62; font-size: 0.78rem; font-family: ui-monospace, SFMono-Regular, monospace;
      margin-top: 0.4rem; word-break: break-word;
    }
    .divider { border: none; border-top: 1px solid #1e2e26; margin: 1.2rem 0; }
    footer {
      margin-top: 3rem; text-align: center; font-size: 0.75rem;
    }
    .footer-brand {
      font-size: 0.7rem; color: #00d4aa; text-transform: uppercase;
      letter-spacing: 0.12em; font-weight: 600; display: block; margin-bottom: 0.75rem;
      text-decoration: none;
    }
    .footer-brand:hover { color: #00d4aa; text-decoration: underline; }
    footer .footer-links { color: #3d5a4c; }
    footer a { color: #7a8a82; text-decoration: none; }
    footer a:hover { color: #00d4aa; }
    @media (max-width: 480px) {
      .buttons { flex-direction: column; align-items: center; }
      .btn { max-width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <p class="tagline">Private file hosting for agents</p>
    <h1>${FAVICON_SVG.replace('<svg ', '<svg class="logo-mark" aria-hidden="true" ')}viveworker share</h1>
    <p class="sub">Host files. Paywall or password-gate. Hand back a link.</p>
  </header>

  <main class="chooser">
    <p class="prompt">Who are you?</p>

    <input type="radio" id="choose-agent" name="role">
    <input type="radio" id="choose-human" name="role">

    <div class="buttons">
      <label for="choose-agent" class="btn">&#x1F916; I am an AI Agent</label>
      <label for="choose-human" class="btn">&#x1F464; I am a Human</label>
    </div>

    <section class="panel panel-agent">
      <h2>Upload static artefacts via the CLI</h2>

      <div class="section-block">
        <h3 class="section-title">Requirements</h3>
        <p class="human-note">
          Uploads authenticate as a <strong>viveworker a2a user</strong> via <code>X-A2A-User</code> + <code>X-A2A-Key</code> headers. If your human isn't set up yet, run <code>viveworker a2a setup</code> first.
        </p>
        <p class="types-line">Accepted: ${acceptedTypes}</p>
      </div>

      <hr class="divider">

      <div class="section-block">
        <h3 class="section-title">Free shares</h3>
        <p class="human-note">Upload a static artefact, get back a <code>share.viveworker.com/v/&lt;slug&gt;</code> URL. Password-gate with <code>--password</code> if needed.</p>
        <div class="cmd" onclick="navigator.clipboard.writeText('viveworker share upload report.pdf')">viveworker share upload report.pdf</div>
      </div>

      <hr class="divider">

      <div class="section-block">
        <h3 class="section-title">Paid shares (x402 / USDC on Base)</h3>
        <p class="human-note">Gate behind a USDC payment. Buyer fetches with any x402-compatible client (<code>x402-fetch</code> or Coinbase AgentKit) and the worker serves content on success.</p>
        <div class="cmd" onclick="navigator.clipboard.writeText('viveworker share upload report.pdf --price 0.10 --pay-to 0x…')">viveworker share upload report.pdf --price 0.10 --pay-to 0x…</div>
      </div>

      <hr class="divider">

      <div class="section-block">
        <h3 class="section-title">Integration guide</h3>
        <p class="human-note">The share CLI ships with the <code>viveworker</code> npm package (same one as a2a). Fetch the full skill doc:</p>
        <div class="copy-box" onclick="navigator.clipboard.writeText('https://a2a.viveworker.com/skill.md')">
          https://a2a.viveworker.com/skill.md
        </div>
      </div>
    </section>

    <section class="panel panel-human">
      <h2>Your agent can host files for you</h2>

      <div class="section-block">
        <h3 class="section-title">What it does</h3>
        <p class="human-note">
          When your AI agent generates a PDF / report / chart / CSV, it can host it here and hand you back a private link. You open it on your phone; share it via iMessage; forward to someone else. Optional password gate or <strong>pay-per-unlock</strong> via USDC.
        </p>
      </div>

      <hr class="divider">

      <div class="section-block">
        <h3 class="section-title">Prerequisite — viveworker a2a</h3>
        <p class="human-note">
          viveworker share rides on the same account as <strong>viveworker a2a</strong>. If you haven't set up a2a yet, start here first:
        </p>
        <div class="copy-box" onclick="navigator.clipboard.writeText('https://a2a.viveworker.com/setup.md')">
          https://a2a.viveworker.com/setup.md
        </div>
        <p class="human-note">
          Copy the URL above and paste it to your AI agent. Your agent handles the setup; you just click "Authorize" when prompted.
        </p>
      </div>

      <hr class="divider">

      <div class="section-block">
        <h3 class="section-title">Once set up</h3>
        <p class="human-note">
          Just ask your agent:<br>
          <strong>"Host this report as a link."</strong> / <strong>"Share this PDF with a password."</strong> / <strong>"Upload this with a $0.10 paywall to my wallet."</strong>
        </p>
      </div>
    </section>
  </main>

  <footer>
    <a href="https://viveworker.com" target="viveworker" class="footer-brand">viveworker</a>
    <div class="footer-links">
      <a href="https://a2a.viveworker.com" target="viveworker-a2a" rel="noopener">viveworker a2a</a>
      &nbsp;&middot;&nbsp;
      <a href="https://x402.org/" target="_blank" rel="noopener">x402 protocol</a>
    </div>
  </footer>
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
  // OG tags deliberately don't reveal the slug or any share content — only
  // "a password-protected viveworker share lives here". The actual URL is
  // still in `og:url` because it's what the user pasted; hiding it would be
  // confusing, not secure.
  const ogDescription = "Password required · a viveworker share";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Password required — viveworker share</title>
  ${FAVICON_LINK}
  <meta name="description" content="${ogDescription}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="Password required · viveworker share" />
  <meta property="og:description" content="${ogDescription}" />
  <meta property="og:image" content="https://share.viveworker.com/og/default.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Password required · viveworker share" />
  <meta name="twitter:description" content="${ogDescription}" />
  <meta name="twitter:image" content="https://share.viveworker.com/og/default.png" />
  <meta name="robots" content="noindex, nofollow" />
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
