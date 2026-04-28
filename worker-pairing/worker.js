/**
 * worker.js — viveworker remote-pairing relay (Cloudflare Worker entry).
 *
 * Routes WS upgrades to the right PairingChannel Durable Object instance
 * (one DO per pairingId). The DO holds both peers' sockets and forwards
 * envelope frames between them; this Worker is just the dispatcher.
 *
 * Routes:
 *   GET  /v1/pairing/:pairingId/ws?role=phone|bridge&token=... → DO WS upgrade
 *   GET  /healthz                                      → 200 "ok"
 *   GET  /                                             → human-readable banner
 *
 * Auth layers:
 *   1. Relay capability token: cheap edge admission + DO namespace isolation.
 *   2. Noise IK: end-to-end mutual auth + encryption. The relay never sees
 *      plaintext and still cannot impersonate either peer.
 */

export { PairingChannel } from "./pairing-do.js";

const PAIRING_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const RELAY_TOKEN_RE = /^v1\.[A-Za-z0-9_-]{32}\.[a-z0-9]{1,13}$/u;
const RELAY_TOKEN_POW_BITS = 16;
const RELAY_TOKEN_DOMAIN = "viveworker-remote-pairing-relay-token";
const RELAY_CHANNEL_DOMAIN = "viveworker-remote-pairing-relay-channel";
const VALID_ROLES = new Set(["phone", "bridge"]);

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
      const relayToken = url.searchParams.get("token") || "";
      const cfIp = request.headers.get("cf-connecting-ip") || "unknown";
      if (!await verifyRelayToken(pairingId, relayToken)) {
        // CF-native rate limit aggregates across every isolate, so a
        // distributed scanner can't fan out to fresh isolates to refresh
        // its bucket the way the old in-memory Map allowed.
        const rl = await safeRateLimit(env.INVALID_TOKEN_RL, cfIp);
        if (rl && !rl.success) {
          return new Response("too many invalid relay tokens", {
            status: 429,
            headers: { "retry-after": "60" },
          });
        }
        return new Response("invalid relay token", { status: 401 });
      }

      // Token is valid — but a stolen-token attacker could still try to
      // keep the bridge in a forced-restart loop by hammering valid WS
      // upgrades. Cap per (pairingId, IP) so a single source can't burn
      // through DO instances.
      const upgradeRl = await safeRateLimit(env.WS_UPGRADE_RL, `${pairingId}:${cfIp}`);
      if (upgradeRl && !upgradeRl.success) {
        console.log(`[relay-ws-rate-limit] pairing=${shortPairing(pairingId)} role=${role}`);
        return new Response("too many ws upgrade attempts", {
          status: 429,
          headers: { "retry-after": "60" },
        });
      }

      // Forward to the DO instance keyed by pairingId + token. A leaked
      // pairingId alone cannot reach or replace the real sockets, and random
      // bot traffic must pay the token proof-of-work before allocating a DO.
      const id = env.PAIRING_CHANNEL.idFromName(await relayChannelName(pairingId, relayToken));
      const stub = env.PAIRING_CHANNEL.get(id);
      console.log(`[relay-ws-upgrade] pairing=${shortPairing(pairingId)} role=${role}`);
      return stub.fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
};

async function verifyRelayToken(pairingId, relayToken) {
  if (!PAIRING_ID_RE.test(pairingId)) return false;
  if (!RELAY_TOKEN_RE.test(relayToken)) return false;
  const digest = await sha256Bytes(`${RELAY_TOKEN_DOMAIN}:${pairingId}:${relayToken}`);
  return countLeadingZeroBits(digest) >= RELAY_TOKEN_POW_BITS;
}

function shortPairing(pairingId) {
  return String(pairingId || "").slice(0, 8);
}

/**
 * Wrapper around a Rate Limit binding that gracefully handles missing
 * bindings (e.g. older deploys, `wrangler dev --local` sessions) and any
 * runtime errors from the limit() call. We never want a rate-limit hiccup
 * to take the relay down — fail-open and let the next request retry.
 *
 * Returns:
 *   { success: true }  — binding missing OR limiter said "allowed"
 *   { success: false } — limiter exceeded
 *   null               — limiter threw; caller should treat as allowed
 */
async function safeRateLimit(binding, key) {
  if (!binding || typeof binding.limit !== "function") {
    return { success: true };
  }
  try {
    return await binding.limit({ key });
  } catch {
    // Limiter is best-effort; an outage here must not break the relay.
    return null;
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
