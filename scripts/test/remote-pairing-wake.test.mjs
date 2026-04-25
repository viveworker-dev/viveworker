/**
 * remote-pairing-wake.test.mjs — Unit tests for web/remote-pairing/wake.js.
 *
 * Stubs `document` / `window` / `navigator.serviceWorker` event targets so
 * we can drive the wake bindings deterministically and assert that
 * `transport.kick()` fires exactly when (and only when) it should.
 *
 * Run:
 *   node --test scripts/test/remote-pairing-wake.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { bindWakeEvents } from "../../web/remote-pairing/wake.js";

// ---------------------------------------------------------------------------
// Tiny EventTarget-style stub. Mimics enough of the DOM for the wake module
// to exercise the listeners we care about. We can't use `globalThis.EventTarget`
// directly because we need to drive `visibilityState` and we want to keep
// listener bookkeeping for the unbind tests.
// ---------------------------------------------------------------------------

function makeTarget(extra = {}) {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type, eventInit = {}) {
      // Mimic DOM: handlers receive a single `event` object. For visibility
      // tests, callers update visibilityState BEFORE dispatching.
      const event = { type, ...eventInit };
      const set = listeners.get(type);
      if (!set) return;
      for (const handler of [...set]) handler(event);
    },
    listenerCountFor(type) {
      return listeners.get(type)?.size ?? 0;
    },
    totalListeners() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
}

function makeFakeTransport() {
  let kickCount = 0;
  return {
    kick() {
      kickCount += 1;
    },
    get kickCount() {
      return kickCount;
    },
  };
}

// ---------------------------------------------------------------------------

test("visibilitychange to 'visible' kicks the transport", () => {
  const transport = makeFakeTransport();
  const doc = makeTarget({ visibilityState: "hidden" });
  bindWakeEvents(transport, { doc, win: null, sw: null });

  doc.visibilityState = "hidden";
  doc.dispatch("visibilitychange");
  assert.equal(transport.kickCount, 0, "hidden should not kick");

  doc.visibilityState = "visible";
  doc.dispatch("visibilitychange");
  assert.equal(transport.kickCount, 1, "visible should kick once");

  doc.visibilityState = "hidden";
  doc.dispatch("visibilitychange");
  assert.equal(transport.kickCount, 1, "going hidden should not re-kick");
});

test("online event kicks the transport", () => {
  const transport = makeFakeTransport();
  const win = makeTarget();
  bindWakeEvents(transport, { doc: null, win, sw: null });

  win.dispatch("online");
  assert.equal(transport.kickCount, 1);
});

test("focus event kicks the transport", () => {
  const transport = makeFakeTransport();
  const win = makeTarget();
  bindWakeEvents(transport, { doc: null, win, sw: null });

  win.dispatch("focus");
  assert.equal(transport.kickCount, 1);
});

test("pageshow kicks only when persisted=true (BFCache restore)", () => {
  const transport = makeFakeTransport();
  const win = makeTarget();
  bindWakeEvents(transport, { doc: null, win, sw: null });

  win.dispatch("pageshow", { persisted: false });
  assert.equal(transport.kickCount, 0, "fresh navigation should not kick");

  win.dispatch("pageshow", { persisted: true });
  assert.equal(transport.kickCount, 1, "BFCache restore should kick");
});

test("SW message with type 'remote-pairing-wake' kicks; others don't", () => {
  const transport = makeFakeTransport();
  const sw = makeTarget();
  bindWakeEvents(transport, { doc: null, win: null, sw });

  sw.dispatch("message", { data: { type: "pushsubscriptionchange" } });
  assert.equal(transport.kickCount, 0, "unrelated SW message should not kick");

  sw.dispatch("message", { data: { type: "remote-pairing-wake", reason: "push" } });
  assert.equal(transport.kickCount, 1);

  sw.dispatch("message", { data: null });
  assert.equal(transport.kickCount, 1, "null data should not throw or kick");
});

test("custom swMessageTypes filter overrides default", () => {
  const transport = makeFakeTransport();
  const sw = makeTarget();
  bindWakeEvents(transport, {
    doc: null,
    win: null,
    sw,
    swMessageTypes: ["custom-wake", "another-wake"],
  });

  sw.dispatch("message", { data: { type: "remote-pairing-wake" } });
  assert.equal(transport.kickCount, 0, "default type filtered out by override");

  sw.dispatch("message", { data: { type: "custom-wake" } });
  assert.equal(transport.kickCount, 1);

  sw.dispatch("message", { data: { type: "another-wake" } });
  assert.equal(transport.kickCount, 2);
});

test("onWake hook fires before kick with reason + info", () => {
  const transport = makeFakeTransport();
  const win = makeTarget();
  const doc = makeTarget({ visibilityState: "visible" });
  const sw = makeTarget();

  /** @type {Array<{ reason: string, info?: any, kickCountAtCall: number }>} */
  const calls = [];
  bindWakeEvents(transport, {
    doc, win, sw,
    onWake: (reason, info) => {
      calls.push({ reason, info, kickCountAtCall: transport.kickCount });
    },
  });

  doc.dispatch("visibilitychange");
  win.dispatch("online");
  win.dispatch("focus");
  win.dispatch("pageshow", { persisted: true });
  sw.dispatch("message", { data: { type: "remote-pairing-wake" } });

  assert.equal(transport.kickCount, 5);
  assert.deepEqual(
    calls.map((c) => c.reason),
    ["visibilitychange", "online", "focus", "pageshow-bfcache", "sw-message"],
  );
  // onWake should be called BEFORE kick — kickCountAtCall is the count
  // before this call's kick fires.
  for (let i = 0; i < calls.length; i++) {
    assert.equal(calls[i].kickCountAtCall, i);
  }
  // sw-message reason carries info with the parsed data.
  assert.equal(calls[4].info?.type, "remote-pairing-wake");
});

test("a throwing onWake hook does not block kick", () => {
  const transport = makeFakeTransport();
  const win = makeTarget();
  bindWakeEvents(transport, {
    doc: null, win, sw: null,
    onWake: () => { throw new Error("boom"); },
  });

  win.dispatch("online");
  assert.equal(transport.kickCount, 1, "kick must fire even if onWake throws");
});

test("unbind removes all listeners and is idempotent", () => {
  const transport = makeFakeTransport();
  const doc = makeTarget({ visibilityState: "visible" });
  const win = makeTarget();
  const sw = makeTarget();
  const unbind = bindWakeEvents(transport, { doc, win, sw });

  // Sanity: listeners are attached.
  assert.ok(doc.totalListeners() >= 1);
  assert.ok(win.totalListeners() >= 1);
  assert.ok(sw.totalListeners() >= 1);

  unbind();
  assert.equal(doc.totalListeners(), 0);
  assert.equal(win.totalListeners(), 0);
  assert.equal(sw.totalListeners(), 0);

  // Calling unbind twice is safe.
  unbind();
  assert.equal(doc.totalListeners(), 0);

  // After unbind, events do nothing.
  doc.dispatch("visibilitychange");
  win.dispatch("online");
  sw.dispatch("message", { data: { type: "remote-pairing-wake" } });
  assert.equal(transport.kickCount, 0);
});

test("missing doc/win/sw is tolerated (e.g., SSR / Node)", () => {
  const transport = makeFakeTransport();
  // All three deliberately absent — bindWakeEvents should still return an
  // unbind() function and just bind nothing.
  const unbind = bindWakeEvents(transport, { doc: null, win: null, sw: null });
  assert.equal(typeof unbind, "function");
  unbind();
});

test("rejects targets without a kick() method", () => {
  assert.throws(() => bindWakeEvents(null), /transport with .kick/);
  assert.throws(() => bindWakeEvents({}), /transport with .kick/);
  assert.throws(() => bindWakeEvents({ kick: 7 }), /transport with .kick/);
});
