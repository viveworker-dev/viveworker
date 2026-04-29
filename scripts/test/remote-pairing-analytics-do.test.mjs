/**
 * remote-pairing-analytics-do.test.mjs — unit tests for RemoteRelayAnalytics.
 *
 * Run:
 *   node --test scripts/test/remote-pairing-analytics-do.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { RemoteRelayAnalytics } from "../../worker-pairing/analytics-do.js";

class FakeStorage {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.get(key);
  }
  async put(key, value) {
    this.map.set(key, value);
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.map.delete(key);
  }
  async list(opts = {}) {
    const prefix = opts.prefix || "";
    const out = new Map();
    for (const [key, value] of this.map.entries()) {
      if (String(key).startsWith(prefix)) out.set(key, value);
    }
    return out;
  }
}

function makeDo() {
  return new RemoteRelayAnalytics({ storage: new FakeStorage() }, {});
}

async function postEvent(analytics, event) {
  const res = await analytics.fetch(new Request("https://analytics.local/v1/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  }));
  assert.equal(res.status, 200);
  return res.json();
}

async function getStats(analytics) {
  const res = await analytics.fetch(new Request("https://analytics.local/v1/stats?days=7"));
  assert.equal(res.status, 200);
  return res.json();
}

async function getPublicStats(analytics) {
  const res = await analytics.fetch(new Request("https://analytics.local/v1/stats/public?days=7"));
  assert.equal(res.status, 200);
  return res.json();
}

test("records aggregate counters without exposing pairing hashes", async () => {
  const analytics = makeDo();
  const atMs = Date.now();
  const expectedDate = new Date(atMs).toISOString().slice(0, 10);

  await postEvent(analytics, {
    type: "ws_upgrade",
    role: "phone",
    pairingId: "476b8996-27f2-4627-81f1-48635ddfe081",
    atMs,
  });
  await postEvent(analytics, {
    type: "ws_upgrade",
    role: "bridge",
    pairingId: "476b8996-27f2-4627-81f1-48635ddfe081",
    atMs,
  });
  await postEvent(analytics, { type: "relay_success", role: "bridge", atMs });
  await postEvent(analytics, { type: "close", role: "phone", code: 1006, atMs });

  const stats = await getStats(analytics);
  const day = stats.daily.find((entry) => entry.date === expectedDate);
  assert.ok(day, "expected daily row");
  assert.equal(day.uniquePairings, 1);
  assert.equal(day.counters.ws_upgrade, 2);
  assert.equal(day.counters.relay_success, 1);
  assert.equal(day.byRole.phone.ws_upgrade, 1);
  assert.equal(day.byRole.bridge.ws_upgrade, 1);
  assert.equal(day.closeCodes["1006"], 1);
  assert.equal("pairingHashes" in day, false);
  assert.deepEqual(stats.privacy.neverStored.includes("relayToken"), true);
});

test("rejects unknown events and never stores raw tokens or IP fields", async () => {
  const analytics = makeDo();
  const res = await analytics.fetch(new Request("https://analytics.local/v1/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "prompt_body",
      relayToken: "v1.secret",
      ip: "203.0.113.10",
    }),
  }));

  assert.equal(res.status, 400);
  const stats = await getStats(analytics);
  assert.equal(stats.last7d.counters.events, undefined);
});

test("public stats expose only delayed coarse adoption counters", async () => {
  const analytics = makeDo();
  const yesterday = Date.now() - 24 * 60 * 60 * 1000;

  for (let i = 0; i < 12; i++) {
    await postEvent(analytics, {
      type: "ws_upgrade",
      role: i % 2 === 0 ? "phone" : "bridge",
      pairingId: `pairing-${String(i % 6).padStart(2, "0")}`,
      atMs: yesterday,
    });
  }
  for (let i = 0; i < 8; i++) {
    await postEvent(analytics, { type: "relay_success", role: "bridge", atMs: yesterday });
  }
  await postEvent(analytics, { type: "invalid_token", role: "phone", atMs: yesterday });
  await postEvent(analytics, { type: "ws_upgrade_rate_limited", role: "phone", atMs: yesterday });
  await postEvent(analytics, { type: "close", role: "phone", code: 1006, atMs: yesterday });

  const stats = await getPublicStats(analytics);
  assert.equal(stats.public, true);
  assert.equal(stats.last7d.remoteConnections, "<10");
  assert.equal(stats.last7d.estimatedActivePairings, "5");
  assert.equal("counters" in stats.last7d, false);
  assert.equal("closeCodes" in stats.last7d, false);
  assert.ok(stats.privacy.notPublished.includes("invalidTokenCounters"));
  assert.ok(stats.privacy.neverStored.includes("ipAddress"));
});
