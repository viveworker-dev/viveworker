const CACHE_NAME = "viveworker-v32";
const NOTIFICATION_INTENT_CACHE = "viveworker-notification-intent-v1";
const NOTIFICATION_INTENT_PATH = "/__viveworker_notification_intent__";
const APP_ASSETS = ["/app.css", "/app.js", "/i18n.js"];
const APP_ROUTES = new Set(["/", "/app", "/app/"]);
const CACHED_PATHS = new Set(APP_ASSETS);

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
    event.respondWith(staleWhileRevalidate(event, "/app"));
    return;
  }

  if (CACHED_PATHS.has(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, url.pathname));
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

  event.waitUntil(self.registration.showNotification(title, options));
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

async function notifyClients(type) {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of clients) {
    client.postMessage({ type });
  }
}

// Cache-first with background revalidation. Flips the previous networkFirst
// strategy: instead of blocking first paint on a fresh fetch of the ~450KB
// app shell (HTML + app.js + app.css + i18n.js) every launch, we serve the
// cached copy immediately and refresh it in the background for the next
// visit. Updates still land quickly because the SW itself is served fresh
// from the bridge (`/sw.js` is excluded from this handler above), and a new
// SW's `install` event pre-populates the cache with the latest assets
// before `activate`/`clients.claim()` triggers a reload in page script.
async function staleWhileRevalidate(event, cacheKey) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(cacheKey);

  const networkPromise = fetch(event.request, { cache: "no-store" })
    .then(async (response) => {
      if (response && response.ok) {
        await cache.put(cacheKey, response.clone());
      }
      return response;
    })
    .catch(() => null);

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
  return Response.error();
}
