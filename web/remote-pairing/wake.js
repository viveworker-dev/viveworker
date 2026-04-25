/**
 * web/remote-pairing/wake.js — Browser wake-up bindings for the transport.
 *
 * The browser tab is the only thing in this stack that decides "the user
 * just looked at the app, reconnect now". The transport class itself only
 * exposes `kick()` — a no-op when the connection is healthy and a backoff-
 * resetting reconnect when it isn't. This module wires that up to the
 * platform events that signal "user is back / network is back / something
 * pushed the SW":
 *
 *   - document.visibilitychange → "visible"   (tab/PWA foregrounded)
 *   - window.online                            (cellular handoff finished, etc.)
 *   - window.focus                             (desktop browsers that don't
 *                                                fire visibilitychange on tab switch)
 *   - window.pageshow w/ persisted=true        (iOS BFCache restore)
 *   - navigator.serviceWorker.message of type   (Web Push arrived in the
 *     "remote-pairing-wake"                      background; SW broadcasts to
 *                                                any open client)
 *
 * Call `bindWakeEvents(transport)` AFTER `transport.connect()` — the kick()
 * has a `_started` guard so calling it before the application opted into
 * the transport is a no-op, but explicitly binding after connect() also
 * makes the lifetime crystal clear.
 *
 * `kick()` is idempotent and handles all the in-flight states (OPENING,
 * HANDSHAKING, RESUMING, CONNECTED) by doing nothing — only DISCONNECTED
 * with a queued reconnect actually fires off a new attempt. So multiple
 * wake events arriving in quick succession (visibilitychange + focus on
 * tab switch, online + pageshow on iOS resume) are safe.
 */

/**
 * @typedef {Object} BindWakeOptions
 * @property {Document} [doc]          override globalThis.document (for tests)
 * @property {Window} [win]            override globalThis.window (for tests)
 * @property {ServiceWorkerContainer} [sw]
 *                                     override globalThis.navigator?.serviceWorker
 * @property {Iterable<string>} [swMessageTypes]
 *                                     SW message `type` values that count as
 *                                     wake hints. Defaults to
 *                                     ["remote-pairing-wake"]
 * @property {(reason: string, info?: object) => void} [onWake]
 *                                     called before each kick() — for logs /
 *                                     telemetry. Errors are swallowed.
 */

/**
 * Bind platform wake events to `transport.kick()`.
 *
 * @param {{ kick(): void }} transport
 * @param {BindWakeOptions} [opts]
 * @returns {() => void} unbind function — idempotent; safe to call multiple times
 */
export function bindWakeEvents(transport, opts = {}) {
  if (!transport || typeof transport.kick !== "function") {
    throw new TypeError("transport with .kick() required");
  }

  const doc = opts.doc ?? globalThis.document ?? null;
  const win = opts.win ?? globalThis.window ?? null;
  const sw = opts.sw ?? globalThis.navigator?.serviceWorker ?? null;
  const onWake = typeof opts.onWake === "function" ? opts.onWake : null;
  const swMessageTypes = new Set(
    opts.swMessageTypes ? Array.from(opts.swMessageTypes) : ["remote-pairing-wake"],
  );

  /** @type {Array<() => void>} */
  const teardown = [];

  const fireKick = (reason, info) => {
    if (onWake) {
      try { onWake(reason, info); } catch { /* swallow — never block kick on a logger */ }
    }
    try { transport.kick(); } catch { /* kick should never throw, but be defensive */ }
  };

  // --------------------------------------------------------------------------
  // visibilitychange (mobile + desktop) — fires on tab switch, foreground/
  // background, OS multitasking. We only kick on the visible side.
  // --------------------------------------------------------------------------
  if (doc?.addEventListener) {
    const onVis = () => {
      if (doc.visibilityState === "visible") fireKick("visibilitychange");
    };
    doc.addEventListener("visibilitychange", onVis);
    teardown.push(() => doc.removeEventListener("visibilitychange", onVis));
  }

  if (win?.addEventListener) {
    // ------------------------------------------------------------------------
    // online — fires when navigator.onLine flips false→true. Common during
    // cellular handoffs, Wi-Fi reconnects, and tunnel reconnects.
    // ------------------------------------------------------------------------
    const onOnline = () => fireKick("online");
    win.addEventListener("online", onOnline);
    teardown.push(() => win.removeEventListener("online", onOnline));

    // ------------------------------------------------------------------------
    // focus — desktop browsers don't always fire visibilitychange on tab
    // switch (Safari at minimum). Belt+suspenders.
    // ------------------------------------------------------------------------
    const onFocus = () => fireKick("focus");
    win.addEventListener("focus", onFocus);
    teardown.push(() => win.removeEventListener("focus", onFocus));

    // ------------------------------------------------------------------------
    // pageshow with persisted=true — fires on BFCache restore (iOS Safari is
    // the common case: open PWA, swipe-back from another app, the page is
    // restored without a fresh navigation, so `online` may not fire even
    // though the WS was killed by the OS during background).
    // ------------------------------------------------------------------------
    const onPageshow = (ev) => {
      if (ev?.persisted) fireKick("pageshow-bfcache");
    };
    win.addEventListener("pageshow", onPageshow);
    teardown.push(() => win.removeEventListener("pageshow", onPageshow));
  }

  // --------------------------------------------------------------------------
  // SW broadcast — when sw.js receives a Web Push tagged for remote-pairing
  // (or whatever caller-defined types), it postMessages to all open clients.
  // We listen here so a background Web Push (PWA in another window or just
  // out-of-focus) wakes the transport without the user touching the screen.
  // --------------------------------------------------------------------------
  if (sw?.addEventListener) {
    const onSWMessage = (ev) => {
      const data = ev?.data;
      const type = data?.type;
      if (typeof type === "string" && swMessageTypes.has(type)) {
        fireKick("sw-message", { type, data });
      }
    };
    sw.addEventListener("message", onSWMessage);
    teardown.push(() => sw.removeEventListener("message", onSWMessage));
  }

  // --------------------------------------------------------------------------
  // Return unbind. Idempotent — calling twice is safe.
  // --------------------------------------------------------------------------
  let unbound = false;
  return () => {
    if (unbound) return;
    unbound = true;
    for (const fn of teardown) {
      try { fn(); } catch { /* unbinding errors are harmless */ }
    }
    teardown.length = 0;
  };
}
