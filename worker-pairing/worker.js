/**
 * worker.js — viveworker remote-pairing relay (Cloudflare Worker entry).
 *
 * Routes WS upgrades to the right PairingChannel Durable Object instance
 * (one DO per pairingId). The DO holds both peers' sockets and forwards
 * envelope frames between them; this Worker is just the dispatcher.
 *
 * Routes:
 *   GET  /v1/pairing/:pairingId/ws?role=phone|bridge&token=... → DO WS upgrade
 *   GET  /stats/remote                                 → private operator stats
 *   GET  /stats/remote/public                          → coarse public stats
 *   GET  /healthz                                      → 200 "ok"
 *   GET  /                                             → human-readable banner
 *
 * Auth layers:
 *   1. Relay capability token: cheap edge admission + DO namespace isolation.
 *   2. Noise IK: end-to-end mutual auth + encryption. The relay never sees
 *      plaintext and still cannot impersonate either peer.
 */

export { PairingChannel } from "./pairing-do.js";
export { RemoteRelayAnalytics } from "./analytics-do.js";

const PAIRING_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const RELAY_TOKEN_RE = /^v1\.[A-Za-z0-9_-]{32}\.[a-z0-9]{1,13}$/u;
const RELAY_TOKEN_POW_BITS = 16;
const RELAY_TOKEN_DOMAIN = "viveworker-remote-pairing-relay-token";
const RELAY_CHANNEL_DOMAIN = "viveworker-remote-pairing-relay-channel";
// The relay token travels in the Sec-WebSocket-Protocol handshake header, not
// the URL, so it stays out of request URLs and access logs. Clients offer
// [RELAY_SUBPROTOCOL, `${TOKEN_SUBPROTOCOL_PREFIX}<token>`]; the server only
// echoes RELAY_SUBPROTOCOL back — never the token.
const RELAY_SUBPROTOCOL = "viveworker.relay.v1";
const TOKEN_SUBPROTOCOL_PREFIX = "vwtok.";
const VALID_ROLES = new Set(["phone", "bridge"]);
const DEFAULT_RELAY_ANALYTICS_SAMPLE_RATE = 20;
const RELAY_ANALYTICS_FULL_FIDELITY_EVENTS = new Set(["token_rotation"]);
const LOCAL_WS_UPGRADE_WINDOW_MS = 60_000;
const LOCAL_WS_UPGRADE_COOLDOWN_MS = 60_000;
const LOCAL_WS_UPGRADE_PHONE_COOLDOWN_MS = 2 * 60_000;
const LOCAL_WS_UPGRADE_MAX_PER_WINDOW = 20;
const LOCAL_WS_UPGRADE_PHONE_MAX_PER_WINDOW = 8;
const LOCAL_WS_UPGRADE_BUCKETS = new Map();

const BANNER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>viveworker pairing relay</title>
<style>
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 720px; margin: 4em auto; padding: 0 1em; color: #0a0f0d; }
  h1 { color: #00a37e; }
  code { background: #f3f6f5; padding: 0.1em 0.3em; border-radius: 3px; }
  pre { background: #f3f6f5; padding: 1em; border-radius: 4px; overflow: auto; }
  a { color: #00a37e; }
</style>
</head>
<body>
<h1>viveworker pairing relay</h1>
<p>End-to-end encrypted Noise IK transport between a paired phone PWA and a PC bridge.
This Worker terminates only the WSS frame; payloads are encrypted client-side.</p>
<h2>WebSocket route</h2>
<pre>GET /v1/pairing/&lt;pairingId&gt;/ws?role=phone|bridge&amp;token=...</pre>
<p>Both peers connect to the same <code>pairingId</code>; they're rendezvoused
inside a Durable Object that buffers frames for short reconnects.</p>
<p>Source: <a href="https://github.com/Studio-Indiesquare/viveworker">github.com/Studio-Indiesquare/viveworker</a></p>
</body>
</html>`;

export default {
  /**
   * @param {Request} request
   * @param {{
   *   PAIRING_CHANNEL: DurableObjectNamespace,
   *   RELAY_ANALYTICS?: DurableObjectNamespace,
   *   STATS_ADMIN_TOKEN?: string,
   *   INVALID_TOKEN_RL?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> },
   *   WS_UPGRADE_RL?:    { limit: (opts: { key: string }) => Promise<{ success: boolean }> },
   * }} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/stats/remote/public" && request.method === "GET") {
      return fetchRelayStats(env, request, { public: true });
    }

    if (url.pathname === "/stats/remote" && request.method === "GET") {
      if (!isAuthorizedStatsRequest(env, request)) {
        return new Response("not found", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
      return fetchRelayStats(env, request);
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(BANNER_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // /v1/pairing/<pairingId>/ws
    const match = url.pathname.match(/^\/v1\/pairing\/([^/]+)\/ws$/);
    if (match) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected WebSocket upgrade", { status: 426 });
      }
      const pairingId = match[1];
      if (!PAIRING_ID_RE.test(pairingId)) {
        return new Response("invalid pairingId", { status: 400 });
      }
      const role = url.searchParams.get("role");
      if (!role || !VALID_ROLES.has(role)) {
        return new Response("invalid role (must be phone|bridge)", { status: 400 });
      }
      const relayToken = resolveRelayTokenFromRequest(request, url);
      const cfIp = request.headers.get("cf-connecting-ip") || "unknown";
      if (!await verifyRelayToken(pairingId, relayToken)) {
        // CF-native rate limit aggregates across every isolate, so a
        // distributed scanner can't fan out to fresh isolates to refresh
        // its bucket the way the old in-memory Map allowed.
        const rl = await safeRateLimit(env.INVALID_TOKEN_RL, cfIp);
        if (rl && !rl.success) {
          waitUntil(ctx, recordRelayMetric(env, {
            type: "invalid_token_rate_limited",
            role,
            pairingId,
            outcome: "rate_limited",
          }));
          return new Response("too many invalid relay tokens", {
            status: 429,
            headers: { "retry-after": "60" },
          });
        }
        waitUntil(ctx, recordRelayMetric(env, {
          type: "invalid_token",
          role,
          pairingId,
          outcome: "failure",
        }));
        return new Response("invalid relay token", { status: 401 });
      }

      // Token is valid — but a stolen-token attacker could still try to
      // keep the bridge in a forced-restart loop by hammering valid WS
      // upgrades. Cap per (pairingId, IP) so a single source can't burn
      // through DO instances.
      const upgradeRl = await safeRateLimit(env.WS_UPGRADE_RL, `${pairingId}:${cfIp}`);
      if (upgradeRl && !upgradeRl.success) {
        console.log(`[relay-ws-rate-limit] pairing=${shortPairing(pairingId)} role=${role}`);
        waitUntil(ctx, recordRelayMetric(env, {
          type: "ws_upgrade_rate_limited",
          role,
          pairingId,
          outcome: "rate_limited",
        }));
        return new Response("too many ws upgrade attempts", {
          status: 429,
          headers: { "retry-after": "60" },
        });
      }

      const localCooldownMs = checkLocalWsUpgradeBudget(pairingId, role, cfIp);
      if (localCooldownMs > 0) {
        const retryAfter = String(Math.max(1, Math.ceil(localCooldownMs / 1000)));
        console.log(`[relay-ws-local-cooldown] pairing=${shortPairing(pairingId)} role=${role} retryAfter=${retryAfter}s`);
        waitUntil(ctx, recordRelayMetric(env, {
          type: "ws_upgrade_local_cooldown",
          role,
          pairingId,
          outcome: "rate_limited",
        }));
        return new Response("relay reconnect cooled down", {
          status: 429,
          headers: { "retry-after": retryAfter },
        });
      }

      // Forward to the DO instance keyed by pairingId + token. A leaked
      // pairingId alone cannot reach or replace the real sockets, and random
      // bot traffic must pay the token proof-of-work before allocating a DO.
      const id = env.PAIRING_CHANNEL.idFromName(await relayChannelName(pairingId, relayToken));
      const stub = env.PAIRING_CHANNEL.get(id);
      console.log(`[relay-ws-upgrade] pairing=${shortPairing(pairingId)} role=${role}`);
      waitUntil(ctx, recordRelayMetric(env, {
        type: "ws_upgrade",
        role,
        pairingId,
        outcome: "success",
      }));
      return stub.fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
};

function fetchRelayStats(env, request, options = {}) {
  if (!env.RELAY_ANALYTICS) {
    return new Response(JSON.stringify({ error: "remote analytics not configured" }), {
      status: 501,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const url = new URL(request.url);
  const qs = url.search || "";
  const statsPath = options.public ? "/v1/stats/public" : "/v1/stats";
  const stub = env.RELAY_ANALYTICS.get(env.RELAY_ANALYTICS.idFromName("global-v1"));
  return stub.fetch(`https://relay-analytics.local${statsPath}${qs}`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
}

function isAuthorizedStatsRequest(env, request) {
  const expected = String(env?.STATS_ADMIN_TOKEN || "").trim();
  if (!expected) return false;
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const headerToken = request.headers.get("x-viveworker-stats-token") || "";
  return safeEqualString(bearer, expected) || safeEqualString(headerToken, expected);
}

function safeEqualString(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (!a || !b) return false;
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function recordRelayMetric(env, event) {
  try {
    if (!env?.RELAY_ANALYTICS) return;
    const sampleWeight = relayMetricSampleWeight(env, event);
    if (sampleWeight > 1 && Math.random() >= 1 / sampleWeight) return;
    const stub = env.RELAY_ANALYTICS.get(env.RELAY_ANALYTICS.idFromName("global-v1"));
    await stub.fetch("https://relay-analytics.local/v1/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ atMs: Date.now(), ...event, count: sampleWeight }),
    });
  } catch {
    // Observability must never break relay traffic.
  }
}

function relayMetricSampleWeight(env, event) {
  if (RELAY_ANALYTICS_FULL_FIDELITY_EVENTS.has(String(event?.type || ""))) {
    return 1;
  }
  const configured = Number(env?.RELAY_ANALYTICS_SAMPLE_RATE);
  if (Number.isFinite(configured) && configured >= 1) {
    return Math.max(1, Math.min(10_000, Math.floor(configured)));
  }
  return DEFAULT_RELAY_ANALYTICS_SAMPLE_RATE;
}

function checkLocalWsUpgradeBudget(pairingId, role, cfIp) {
  const now = Date.now();
  // Include the (Cloudflare-set, non-spoofable) caller IP so an attacker IP that
  // knows a leaked pairingId cannot exhaust the shared cooldown bucket and
  // 429-lock the legitimate phone/bridge. Mirrors the CF-native WS_UPGRADE_RL key.
  const ipKeyPart = String(cfIp || "unknown");
  const key = `${pairingId}:${role}:${ipKeyPart}`;
  pruneLocalWsUpgradeBuckets(now);
  const bucket = LOCAL_WS_UPGRADE_BUCKETS.get(key) || {
    windowStartMs: now,
    count: 0,
    cooldownUntilMs: 0,
  };
  if (bucket.cooldownUntilMs > now) {
    LOCAL_WS_UPGRADE_BUCKETS.set(key, bucket);
    return bucket.cooldownUntilMs - now;
  }
  if (now - bucket.windowStartMs >= LOCAL_WS_UPGRADE_WINDOW_MS) {
    bucket.windowStartMs = now;
    bucket.count = 0;
    bucket.cooldownUntilMs = 0;
  }
  bucket.count += 1;
  const maxPerWindow = role === "phone"
    ? LOCAL_WS_UPGRADE_PHONE_MAX_PER_WINDOW
    : LOCAL_WS_UPGRADE_MAX_PER_WINDOW;
  const cooldownMs = role === "phone"
    ? LOCAL_WS_UPGRADE_PHONE_COOLDOWN_MS
    : LOCAL_WS_UPGRADE_COOLDOWN_MS;
  if (bucket.count > maxPerWindow) {
    bucket.cooldownUntilMs = now + cooldownMs;
    LOCAL_WS_UPGRADE_BUCKETS.set(key, bucket);
    return cooldownMs;
  }
  LOCAL_WS_UPGRADE_BUCKETS.set(key, bucket);
  return 0;
}

function pruneLocalWsUpgradeBuckets(now) {
  if (LOCAL_WS_UPGRADE_BUCKETS.size < 512) return;
  for (const [key, bucket] of LOCAL_WS_UPGRADE_BUCKETS) {
    if (
      bucket.cooldownUntilMs <= now &&
      now - bucket.windowStartMs > LOCAL_WS_UPGRADE_WINDOW_MS * 2
    ) {
      LOCAL_WS_UPGRADE_BUCKETS.delete(key);
    }
  }
}

function waitUntil(ctx, promise) {
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(promise);
    return;
  }
  if (promise && typeof promise.catch === "function") promise.catch(() => {});
}

async function verifyRelayToken(pairingId, relayToken) {
  if (!PAIRING_ID_RE.test(pairingId)) return false;
  if (!RELAY_TOKEN_RE.test(relayToken)) return false;
  const digest = await sha256Bytes(`${RELAY_TOKEN_DOMAIN}:${pairingId}:${relayToken}`);
  return countLeadingZeroBits(digest) >= RELAY_TOKEN_POW_BITS;
}

// Read the relay token from the Sec-WebSocket-Protocol header, falling back to
// the legacy `?token=` query param for older clients.
function resolveRelayTokenFromRequest(request, url) {
  const offered = String(request.headers.get("Sec-WebSocket-Protocol") || "");
  for (const proto of offered.split(",")) {
    const candidate = proto.trim();
    if (candidate.startsWith(TOKEN_SUBPROTOCOL_PREFIX)) {
      return candidate.slice(TOKEN_SUBPROTOCOL_PREFIX.length);
    }
  }
  return url.searchParams.get("token") || "";
}

function shortPairing(pairingId) {
  return String(pairingId || "").slice(0, 8);
}

/**
 * Wrapper around a Rate Limit binding.
 *
 * A *missing* binding (wrangler dev --local, older deploy) stays fail-open, so
 * local dev isn't broken and the per-isolate cooldown still applies. A binding
 * that *exists and throws* fails CLOSED so a transient limiter outage can't be
 * used to spam WS upgrades / invalid tokens; the client retries with backoff.
 *
 * Returns:
 *   { success: true }  — binding missing OR limiter said "allowed"
 *   { success: false } — limiter exceeded OR limiter threw (fail closed)
 */
async function safeRateLimit(binding, key) {
  if (!binding || typeof binding.limit !== "function") {
    return { success: true };
  }
  try {
    return await binding.limit({ key });
  } catch {
    return { success: false };
  }
}

async function relayChannelName(pairingId, relayToken) {
  const digest = await sha256Bytes(`${RELAY_CHANNEL_DOMAIN}:${pairingId}:${relayToken}`);
  return `v1-${base64url(digest).slice(0, 43)}`;
}

async function sha256Bytes(value) {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function countLeadingZeroBits(bytes) {
  let bits = 0;
  for (const b of bytes) {
    if (b === 0) {
      bits += 8;
      continue;
    }
    for (let i = 7; i >= 0; i--) {
      if ((b & (1 << i)) !== 0) return bits;
      bits += 1;
    }
  }
  return bits;
}

function base64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}
