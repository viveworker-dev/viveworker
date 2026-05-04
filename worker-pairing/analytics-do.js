/**
 * analytics-do.js — aggregated, server-side usage counters for the remote relay.
 *
 * This Durable Object intentionally stores only coarse operational metadata:
 * event counters, roles, close codes, and a non-reversible hash of the random
 * pairingId for daily unique-pairing estimates. It never stores prompts,
 * command text, file paths, relay tokens, public keys, request bodies, or IPs.
 */

const DAY_MS = 86_400_000;
const RETENTION_DAYS = 45;
const MAX_DAILY_ROWS = 30;

const EVENT_TYPES = new Set([
  "ws_upgrade",
  "ws_upgrade_local_cooldown",
  "ws_upgrade_rate_limited",
  "invalid_token",
  "invalid_token_rate_limited",
  "do_accept",
  "same_role_replace",
  "relay_success",
  "resume_ok",
  "resume_fail",
  "close",
  "protocol_error",
  "token_rotation",
]);

const VALID_ROLES = new Set(["phone", "bridge"]);

export class RemoteRelayAnalytics {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/event") {
      return this._record(request);
    }
    if (request.method === "GET" && url.pathname === "/v1/stats") {
      return this._stats(url);
    }
    if (request.method === "GET" && url.pathname === "/v1/stats/public") {
      return this._publicStats(url);
    }
    return json({ error: "not found" }, 404);
  }

  async _record(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid json" }, 400);
    }

    const event = await normalizeEvent(body);
    if (!event) return json({ error: "invalid event" }, 400);

    const dayKey = `day:${dateKey(event.atMs)}`;
    const day = normalizeDay(await this.state.storage.get(dayKey), dayKey.slice(4));
    applyEvent(day, event);
    await this.state.storage.put(dayKey, day);
    await maybePruneOldDays(this.state.storage, event.atMs);

    return json({ ok: true });
  }

  async _stats(url) {
    const now = Date.now();
    const days = clampNumber(url.searchParams.get("days"), 30, 1, MAX_DAILY_ROWS);
    const dailyInternal = [];
    for (let offset = 0; offset < days; offset++) {
      const key = dateKey(now - offset * DAY_MS);
      const day = normalizeDay(await this.state.storage.get(`day:${key}`), key);
      dailyInternal.push(day);
    }
    dailyInternal.reverse();
    const daily = dailyInternal.map(publicDay);

    return json({
      ok: true,
      generatedAtMs: now,
      privacy: {
        mode: "server-side aggregate counters only",
        neverStored: [
          "promptBody",
          "replyBody",
          "fileContent",
          "filePath",
          "commandText",
          "relayToken",
          "publicKey",
          "ipAddress",
        ],
      },
      today: publicDay(rollup(dailyInternal.slice(-1))),
      last7d: publicDay(rollup(dailyInternal.slice(-7))),
      last30d: publicDay(rollup(dailyInternal.slice(-30))),
      daily,
    });
  }

  async _publicStats(url) {
    const now = Date.now();
    const days = clampNumber(url.searchParams.get("days"), 30, 7, MAX_DAILY_ROWS);
    const completedDays = [];
    // Public stats intentionally lag by one complete UTC day. This avoids
    // exposing near-real-time operational signals when the install base is
    // still small.
    for (let offset = days; offset >= 1; offset--) {
      const key = dateKey(now - offset * DAY_MS);
      completedDays.push(normalizeDay(await this.state.storage.get(`day:${key}`), key));
    }
    const last7d = rollup(completedDays.slice(-7));
    const last30d = rollup(completedDays.slice(-30));
    return json({
      ok: true,
      public: true,
      generatedAtMs: now,
      updatedThroughDate: completedDays.at(-1)?.date || null,
      privacy: {
        mode: "coarse public aggregate counters only",
        delayedBy: "at least one complete UTC day",
        neverStored: [
          "promptBody",
          "replyBody",
          "fileContent",
          "filePath",
          "commandText",
          "relayToken",
          "publicKey",
          "ipAddress",
        ],
        notPublished: [
          "invalidTokenCounters",
          "rateLimitCounters",
          "closeCodes",
          "protocolErrors",
          "dailyLowVolumeRows",
        ],
      },
      last7d: publicRollup(last7d),
      last30d: publicRollup(last30d),
    });
  }
}

async function normalizeEvent(raw) {
  const type = String(raw?.type || "");
  if (!EVENT_TYPES.has(type)) return null;

  const event = {
    type,
    atMs: Number.isFinite(Number(raw?.atMs)) ? Number(raw.atMs) : Date.now(),
    count: clampNumber(raw?.count, 1, 1, 10_000),
  };

  const role = String(raw?.role || "");
  if (VALID_ROLES.has(role)) event.role = role;

  const code = Number(raw?.code);
  if (Number.isInteger(code) && code >= 0 && code <= 9999) event.code = String(code);

  const outcome = String(raw?.outcome || "");
  if (outcome === "success" || outcome === "failure" || outcome === "rate_limited") {
    event.outcome = outcome;
  }

  if (typeof raw?.pairingId === "string" && raw.pairingId) {
    event.pairingHash = await hashPairingId(raw.pairingId);
  }

  return event;
}

function normalizeDay(value, date) {
  const day = value && typeof value === "object" ? value : {};
  return {
    date: typeof day.date === "string" ? day.date : date,
    updatedAtMs: Number.isFinite(Number(day.updatedAtMs)) ? Number(day.updatedAtMs) : 0,
    counters: isObject(day.counters) ? day.counters : {},
    byRole: {
      phone: isObject(day.byRole?.phone) ? day.byRole.phone : {},
      bridge: isObject(day.byRole?.bridge) ? day.byRole.bridge : {},
    },
    closeCodes: isObject(day.closeCodes) ? day.closeCodes : {},
    pairingHashes: isObject(day.pairingHashes) ? day.pairingHashes : {},
  };
}

function applyEvent(day, event) {
  day.updatedAtMs = Math.max(day.updatedAtMs || 0, event.atMs);
  const count = Math.max(1, Math.floor(Number(event.count) || 1));
  increment(day.counters, "events", count);
  increment(day.counters, event.type, count);

  if (event.role) {
    increment(day.byRole[event.role], "events", count);
    increment(day.byRole[event.role], event.type, count);
  }
  if (event.code) {
    increment(day.closeCodes, event.code, count);
  }
  if (event.pairingHash) {
    day.pairingHashes[event.pairingHash] = 1;
  }
}

function publicDay(day) {
  return {
    date: day.date || null,
    updatedAtMs: day.updatedAtMs || 0,
    uniquePairings: Object.keys(day.pairingHashes || {}).length,
    counters: { ...(day.counters || {}) },
    byRole: {
      phone: { ...(day.byRole?.phone || {}) },
      bridge: { ...(day.byRole?.bridge || {}) },
    },
    closeCodes: { ...(day.closeCodes || {}) },
  };
}

function publicRollup(day) {
  const counters = day.counters || {};
  const wsUpgrades = Number(counters.ws_upgrade) || 0;
  const relaySuccesses = Number(counters.relay_success) || 0;
  const uniquePairings = Object.keys(day.pairingHashes || {}).length;
  const successRatePct = wsUpgrades >= 20
    ? Math.round((relaySuccesses / Math.max(1, Math.floor(wsUpgrades / 2))) * 100)
    : null;
  return {
    date: day.date || null,
    estimatedActivePairings: bucketCount(uniquePairings, { smallThreshold: 5, roundTo: 5 }),
    remoteConnections: bucketCount(relaySuccesses, { smallThreshold: 10, roundTo: 10 }),
    connectionAttempts: bucketCount(Math.floor(wsUpgrades / 2), { smallThreshold: 10, roundTo: 10 }),
    successRatePct: successRatePct == null ? null : Math.max(0, Math.min(100, successRatePct)),
  };
}

function bucketCount(value, { smallThreshold, roundTo }) {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  if (n === 0) return "0";
  if (n < smallThreshold) return `<${smallThreshold}`;
  const rounded = Math.max(roundTo, Math.round(n / roundTo) * roundTo);
  return String(rounded);
}

function rollup(days) {
  const out = normalizeDay(null, days[0]?.date || null);
  out.date = days.length > 1 ? `${days[0]?.date || "?"}..${days.at(-1)?.date || "?"}` : (days[0]?.date || null);
  for (const day of days) {
    mergeCounts(out.counters, day.counters);
    mergeCounts(out.byRole.phone, day.byRole?.phone);
    mergeCounts(out.byRole.bridge, day.byRole?.bridge);
    mergeCounts(out.closeCodes, day.closeCodes);
    for (const hash of Object.keys(day.pairingHashes || {})) out.pairingHashes[hash] = 1;
    out.updatedAtMs = Math.max(out.updatedAtMs, Number(day.updatedAtMs) || 0);
  }
  return out;
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = (Number(target[key]) || 0) + (Number(value) || 0);
  }
}

function increment(obj, key, count = 1) {
  obj[key] = (Number(obj[key]) || 0) + count;
}

async function maybePruneOldDays(storage, nowMs) {
  const today = dateKey(nowMs);
  const lastPrune = await storage.get("meta:lastPruneDate");
  if (lastPrune === today) return;

  const cutoff = dateKey(nowMs - RETENTION_DAYS * DAY_MS);
  const rows = await storage.list({ prefix: "day:" });
  const deletes = [];
  for (const key of rows.keys()) {
    const day = String(key).slice(4);
    if (day < cutoff) deletes.push(key);
  }
  if (deletes.length > 0) await storage.delete(deletes);
  await storage.put("meta:lastPruneDate", today);
}

async function hashPairingId(pairingId) {
  const bytes = new TextEncoder().encode(`viveworker-remote-relay-analytics:v1:${pairingId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return base64url(digest).slice(0, 22);
}

function dateKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function base64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}
