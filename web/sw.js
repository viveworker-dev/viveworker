const CACHE_NAME = "viveworker-v120";
const APP_BUILD_ID = "20260428-client-update-copy";
const APP_SCRIPT_URL = `/app.js?v=${APP_BUILD_ID}`;
const API_ROUTER_URL = `/remote-pairing/api-router.js?v=${APP_BUILD_ID}`;
const NOTIFICATION_INTENT_CACHE = "viveworker-notification-intent-v1";
const NOTIFICATION_INTENT_PATH = "/__viveworker_notification_intent__";
// Cold off-LAN start requires the app shell plus remote-pairing modules in the
// precache. The first installed /app?pairToken=... navigation may happen before
// this service worker controls the page, so cache /app during install instead
// of relying on a later stale-while-revalidate pass.
//
// Bumping CACHE_NAME forces a re-cache so existing clients pick up the wider
// asset set on next launch.
const APP_ASSETS = [
  "/app",
  APP_SCRIPT_URL,
  "/app.css",
  "/app.js",
  "/i18n.js",
  "/icons/viveworker-v-pulse.svg",
  API_ROUTER_URL,
  "/remote-pairing/api-router.js",
  "/remote-pairing/keys.js",
  "/remote-pairing/pairing-state.js",
  "/remote-pairing/rpc-client.js",
  "/remote-pairing/transport.js",
  "/remote-pairing/wake.js",
  "/remote-pairing.bundle.js",
];
const APP_ROUTES = new Set(["/", "/app", "/app/"]);
const CACHED_PATHS = new Set(APP_ASSETS.map((asset) => new URL(asset, self.location.origin).pathname));
const VERSIONED_CACHE_PATHS = new Set([
  "/app.js",
  "/remote-pairing/api-router.js",
]);
const NETWORK_FIRST_PATHS = new Set([
  "/app.js",
  "/remote-pairing/api-router.js",
]);
const APP_NAVIGATION_NETWORK_TIMEOUT_MS = 1800;
const ASSET_NETWORK_TIMEOUT_MS = 900;
const APP_SHELL_FALLBACK_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#101418">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <link rel="manifest" href="/manifest.webmanifest">
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
    <link rel="icon" type="image/png" sizes="192x192" href="/icons/viveworker-icon-192.png">
    <link rel="stylesheet" href="/app.css">
    <style>
      html, body { min-height: 100%; margin: 0; background: #081015; color: #f5fbff; }
      .boot-splash { position: fixed; inset: 0; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; background: radial-gradient(circle at 50% 18%, rgba(47, 143, 103, 0.22), transparent 30%), linear-gradient(180deg, #081015 0%, #091015 100%); }
      .boot-splash__card { display: grid; justify-items: center; gap: 0.9rem; text-align: center; }
      .boot-splash__logo { width: 6rem; height: 6rem; border-radius: 28%; }
      .boot-splash__title { margin: 0; font-size: 2rem; letter-spacing: -0.04em; }
      .boot-splash__status { min-height: 1.25em; margin: 0; color: rgba(205, 220, 231, 0.72); }
      .boot-splash__hint { max-width: 15rem; margin: -0.35rem 0 0; color: rgba(178, 196, 210, 0.58); font-size: 0.78rem; line-height: 1.45; opacity: 0; transition: opacity 220ms ease; }
      .boot-splash__hint.is-visible { opacity: 1; }
      .viveworker-ready .boot-splash { opacity: 0; visibility: hidden; }
    </style>
    <title>viveworker</title>
  </head>
  <body>
    <div id="boot-splash" class="boot-splash" role="status" aria-live="polite" aria-label="viveworker is starting">
      <div class="boot-splash__card">
        <img class="boot-splash__logo" src="/icons/viveworker-v-pulse.svg" alt="" width="112" height="112" decoding="async">
        <h1 class="boot-splash__title">viveworker</h1>
        <p id="boot-splash-status" class="boot-splash__status">Checking your trusted Wi-Fi...</p>
        <p id="boot-splash-hint" class="boot-splash__hint" hidden>The first remote connection can take tens of seconds.</p>
      </div>
    </div>
    <div id="app"></div>
    <script>
      (() => {
        const isJa = (navigator.language || "").toLowerCase().startsWith("ja");
        const message = isJa ? "同じWi-Fi内のPCを確認中..." : "Checking your trusted Wi-Fi...";
        const status = document.getElementById("boot-splash-status");
        const splash = document.getElementById("boot-splash");
        if (status) status.textContent = message;
        if (splash) splash.setAttribute("aria-label", "viveworker " + message);
      })();
    </script>
    <script type="module" src="${APP_SCRIPT_URL}"></script>
  </body>
</html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_ASSETS);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.startsWith("/api/") || url.pathname === "/sw.js") {
    return;
  }

  if (APP_ROUTES.has(url.pathname)) {
    event.respondWith(networkFirstWithFallback(event, "/app", {
      timeoutMs: APP_NAVIGATION_NETWORK_TIMEOUT_MS,
      fallbackAppShell: true,
    }));
    return;
  }

  if (CACHED_PATHS.has(url.pathname)) {
    const cacheKey = cacheKeyForUrl(url);
    event.respondWith(
      NETWORK_FIRST_PATHS.has(url.pathname)
        ? networkFirstWithFallback(event, cacheKey, { timeoutMs: ASSET_NETWORK_TIMEOUT_MS })
        : staleWhileRevalidate(event, cacheKey)
    );
  }
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {
      title: "viveworker",
      body: event.data ? event.data.text() : "A new Codex item is available.",
      data: { url: "/app" },
    };
  }

  const title = payload.title || "viveworker";
  const options = {
    body: payload.body || "A new Codex item is available.",
    tag: payload.tag || "",
    data: payload.data || { url: "/app" },
  };

  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    // Phase 2d: if the push is tagged as a remote-pairing wake hint, also
    // broadcast a postMessage to open clients so any active transport
    // instance can kick its reconnect immediately. Background-only pushes
    // (no PWA window open) hit the notification path; the user's tap then
    // foregrounds the PWA which kicks the transport via visibilitychange.
    if (shouldBroadcastRemotePairingWake(payload)) {
      await notifyClients("remote-pairing-wake", { reason: "push" });
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.preventDefault?.();
  event.notification.close();
  const targetUrl = event.notification?.data?.url || "/app";
  event.waitUntil(openTargetWindow(targetUrl));
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(notifyClients("pushsubscriptionchange"));
});

async function openTargetWindow(targetUrl) {
  const target = new URL(targetUrl, self.location.origin);
  await persistNotificationIntent(target.toString());
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  broadcastTargetUrl(target.toString(), clients);

  const preferredClients = clients
    .slice()
    .sort((left, right) => scoreClient(right) - scoreClient(left));

  for (const client of preferredClients) {
    if (typeof client.focus === "function") {
      if (typeof client.navigate === "function") {
        await client.navigate(target.toString()).catch(() => {});
      }
      client.postMessage({
        type: "open-target-url",
        url: target.toString(),
      });
      await client.focus();
      return;
    }
  }

  if (self.clients.openWindow) {
    await self.clients.openWindow(target.toString());
  }
}

function scoreClient(client) {
  try {
    const url = new URL(client?.url || "");
    let score = 0;
    if (APP_ROUTES.has(url.pathname)) {
      score += 20;
    }
    if (url.pathname === "/app" || url.pathname === "/app/") {
      score += 5;
    }
    if (client?.focused) {
      score += 4;
    }
    if (client?.visibilityState === "visible") {
      score += 2;
    }
    return score;
  } catch {
    return 0;
  }
}

function broadcastTargetUrl(url, clients) {
  for (const client of clients) {
    client.postMessage({
      type: "open-target-url",
      url,
    });
  }
}

async function persistNotificationIntent(url) {
  try {
    const cache = await caches.open(NOTIFICATION_INTENT_CACHE);
    const request = new Request(NOTIFICATION_INTENT_PATH);
    const response = new Response(
      JSON.stringify({
        url,
        nonce: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAtMs: Date.now(),
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      }
    );
    await cache.put(request, response);
  } catch {
    // Best-effort fallback for iOS warm-start notification routing.
  }
}

async function notifyClients(type, extra) {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  // Spread `extra` after `type` so callers can't accidentally clobber the
  // discriminator the receiving client uses to dispatch.
  const message = extra ? { ...extra, type } : { type };
  for (const client of clients) {
    client.postMessage(message);
  }
}

// Decide whether a Web Push payload is a remote-pairing wake hint. Both an
// explicit `data.kind === "remote-pairing-wake"` and a generic
// `data.kind === "remote-pairing-event"` count — the latter lets the bridge
// piggy-back on existing pushes (approval requests, etc.) without sending a
// dedicated wake-only notification.
function shouldBroadcastRemotePairingWake(payload) {
  const kind = payload?.data?.kind;
  return kind === "remote-pairing-wake" || kind === "remote-pairing-event";
}

function cacheKeyForUrl(url) {
  if (VERSIONED_CACHE_PATHS.has(url.pathname) && url.search) {
    return `${url.pathname}${url.search}`;
  }
  return url.pathname;
}

function fetchAndCache(event, cache, cacheKey) {
  return fetch(event.request, { cache: "no-store" })
    .then(async (response) => {
      if (response && response.ok) {
        await cache.put(cacheKey, response.clone());
      }
      return response;
    })
    .catch(() => null);
}

async function networkFirstWithFallback(event, cacheKey, options = {}) {
  const cache = await caches.open(CACHE_NAME);
  const cachedPromise = cache.match(cacheKey);
  const networkPromise = fetchAndCache(event, cache, cacheKey);
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 0) || 0);

  let response = null;
  if (timeoutMs > 0) {
    response = await Promise.race([
      networkPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } else {
    response = await networkPromise;
  }

  if (response) {
    return response;
  }

  // If the network attempt is still pending after the timeout, keep the
  // Service Worker alive so LAN updates are cached for the next launch.
  event.waitUntil(networkPromise);

  const cached = await cachedPromise;
  if (cached) {
    return cached;
  }

  if (options.fallbackAppShell) {
    return new Response(APP_SHELL_FALLBACK_HTML, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  const lateResponse = await networkPromise;
  return lateResponse || Response.error();
}

// Cache-first with background revalidation for non-critical assets. App entry
// points stay network-first so LAN refreshes can replace stale PWA code before
// the device goes back to relay-only mode.
async function staleWhileRevalidate(event, cacheKey) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(cacheKey);
  const networkPromise = fetchAndCache(event, cache, cacheKey);

  if (cached) {
    // Keep the SW alive long enough to persist the background refresh even
    // if the page navigates away right after first paint.
    event.waitUntil(networkPromise);
    return cached;
  }

  const response = await networkPromise;
  if (response) {
    return response;
  }
  if (cacheKey === "/app") {
    return new Response(APP_SHELL_FALLBACK_HTML, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
  return Response.error();
}
