/**
 * worker.js — viveworker remote-pairing relay (Cloudflare Worker entry).
 *
 * Routes WS upgrades to the right PairingChannel Durable Object instance
 * (one DO per pairingId). The DO holds both peers' sockets and forwards
 * envelope frames between them; this Worker is just the dispatcher.
 *
 * Routes:
 *   GET  /v1/pairing/:pairingId/ws?role=phone|bridge   → DO WS upgrade
 *   GET  /healthz                                      → 200 "ok"
 *   GET  /                                             → human-readable banner
 *
 * Auth (Phase 1): open WebSocket. The Noise handshake that runs over the
 * WS is the real auth — a peer that doesn't hold the right identity key
 * can't complete the handshake and the DO will eventually drop them.
 * Production hardening (per-pairing bearer token, IP rate-limit, abuse
 * counters) happens once the protocol is shaken out.
 */

export { PairingChannel } from "./pairing-do.js";

const PAIRING_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
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
<pre>GET /v1/pairing/&lt;pairingId&gt;/ws?role=phone|bridge</pre>
<p>Both peers connect to the same <code>pairingId</code>; they're rendezvoused
inside a Durable Object that buffers frames for short reconnects.</p>
<p>Source: <a href="https://github.com/Studio-Indiesquare/viveworker">github.com/Studio-Indiesquare/viveworker</a></p>
</body>
</html>`;

export default {
  /**
   * @param {Request} request
   * @param {{ PAIRING_CHANNEL: DurableObjectNamespace }} env
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

      // Forward to the DO instance keyed by pairingId. Both peers use the
      // same name, so they're guaranteed to land on the same DO.
      const id = env.PAIRING_CHANNEL.idFromName(pairingId);
      const stub = env.PAIRING_CHANNEL.get(id);
      return stub.fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
};
