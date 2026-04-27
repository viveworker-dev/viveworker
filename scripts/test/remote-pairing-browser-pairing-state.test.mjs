/**
 * remote-pairing-browser-pairing-state.test.mjs — Unit tests for
 * web/remote-pairing/pairing-state.js.
 *
 * Validates the localStorage-backed pairing record helper:
 *   - schema versioning (current version round-trips, foreign versions
 *     are treated as "no record")
 *   - shape validation (missing required fields → null on load,
 *     TypeError on save)
 *   - tolerance for storage absence / throwing storage backends
 *     (Safari private mode, headless test contexts)
 *   - case normalization on hex fields
 *
 * Run:
 *   node --test scripts/test/remote-pairing-browser-pairing-state.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  loadPairingState,
  savePairingState,
  clearPairingState,
  __STORAGE_KEY,
  __SCHEMA_VERSION,
} from "../../web/remote-pairing/pairing-state.js";

// ---------------------------------------------------------------------------
// In-memory Storage stub mimicking the localStorage Web Storage interface.
// We pass it explicitly via opts.storage rather than monkey-patching
// globalThis so each test gets a clean instance.

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    get length() {
      return map.size;
    },
  };
}

function makeRecord(overrides = {}) {
  return {
    pairingId: "00000000-0000-4000-8000-000000000000",
    relayToken: "v1.testtesttesttesttesttesttesttest.abc",
    phonePub: "AA".repeat(32).toLowerCase(),
    phoneFingerprint: "AAAA-AAAA-AAAA",
    bridgePubHex: "BB".repeat(32).toLowerCase(),
    bridgeFingerprint: "BBBB-BBBB-BBBB",
    relayUrl: "wss://pairing.viveworker.com",
    label: "iPhone test",
    addedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

test("loadPairingState returns null when storage is empty", () => {
  const storage = makeStorage();
  assert.equal(loadPairingState({ storage }), null);
});

test("save → load round-trips a full record", () => {
  const storage = makeStorage();
  const record = makeRecord();
  assert.equal(savePairingState(record, { storage }), true);

  const loaded = loadPairingState({ storage });
  assert.ok(loaded, "expected a record to be loaded");
  assert.equal(loaded.version, __SCHEMA_VERSION);
  assert.equal(loaded.pairingId, record.pairingId);
  assert.equal(loaded.relayToken, record.relayToken);
  assert.equal(loaded.phonePub, record.phonePub);
  assert.equal(loaded.phoneFingerprint, record.phoneFingerprint);
  assert.equal(loaded.bridgePubHex, record.bridgePubHex);
  assert.equal(loaded.bridgeFingerprint, record.bridgeFingerprint);
  assert.equal(loaded.relayUrl, record.relayUrl);
  assert.equal(loaded.label, record.label);
  assert.equal(loaded.addedAtMs, record.addedAtMs);
});

test("savePairingState writes under the documented storage key", () => {
  const storage = makeStorage();
  savePairingState(makeRecord(), { storage });
  const raw = storage.getItem(__STORAGE_KEY);
  assert.ok(raw, "expected the record under the documented storage key");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, __SCHEMA_VERSION);
  assert.equal(parsed.pairingId, makeRecord().pairingId);
});

test("savePairingState lower-cases hex fields on the way in", () => {
  const storage = makeStorage();
  savePairingState(
    makeRecord({
      phonePub: "AA".repeat(32),       // upper
      bridgePubHex: "BB".repeat(32),   // upper
    }),
    { storage },
  );
  const loaded = loadPairingState({ storage });
  assert.equal(loaded.phonePub, "aa".repeat(32));
  assert.equal(loaded.bridgePubHex, "bb".repeat(32));
});

test("loadPairingState lower-cases hex fields on the way out", () => {
  // Plant an upper-case record directly (older write paths). load() should
  // normalize so callers can === compare against canonical lowercase.
  const storage = makeStorage();
  storage.setItem(
    __STORAGE_KEY,
    JSON.stringify({
      version: __SCHEMA_VERSION,
      ...makeRecord({
        phonePub: "AA".repeat(32),
        bridgePubHex: "BB".repeat(32),
      }),
    }),
  );
  const loaded = loadPairingState({ storage });
  assert.equal(loaded.phonePub, "aa".repeat(32));
  assert.equal(loaded.bridgePubHex, "bb".repeat(32));
});

test("loadPairingState returns null when the schema version mismatches", () => {
  const storage = makeStorage();
  storage.setItem(
    __STORAGE_KEY,
    JSON.stringify({ ...makeRecord(), version: __SCHEMA_VERSION + 1 }),
  );
  assert.equal(loadPairingState({ storage }), null);
});

test("loadPairingState returns null on missing required fields", () => {
  const storage = makeStorage();
  for (const drop of [
    "pairingId",
    "relayToken",
    "phonePub",
    "phoneFingerprint",
    "bridgePubHex",
    "bridgeFingerprint",
    "relayUrl",
  ]) {
    const record = { version: __SCHEMA_VERSION, ...makeRecord() };
    delete record[drop];
    storage.setItem(__STORAGE_KEY, JSON.stringify(record));
    assert.equal(
      loadPairingState({ storage }),
      null,
      `expected null when '${drop}' is missing`,
    );
    storage.removeItem(__STORAGE_KEY);
  }
});

test("loadPairingState returns null on empty-string required fields", () => {
  const storage = makeStorage();
  storage.setItem(
    __STORAGE_KEY,
    JSON.stringify({
      version: __SCHEMA_VERSION,
      ...makeRecord({ relayUrl: "" }),
    }),
  );
  assert.equal(loadPairingState({ storage }), null);
});

test("loadPairingState returns null on malformed JSON", () => {
  const storage = makeStorage();
  storage.setItem(__STORAGE_KEY, "{not json");
  assert.equal(loadPairingState({ storage }), null);
});

test("loadPairingState returns null when the value isn't an object", () => {
  const storage = makeStorage();
  storage.setItem(__STORAGE_KEY, JSON.stringify(["not", "an", "object"]));
  assert.equal(loadPairingState({ storage }), null);
});

test("loadPairingState defaults missing optional fields", () => {
  // Optional fields (label, addedAtMs) get safe defaults rather than
  // failing the load.
  const storage = makeStorage();
  storage.setItem(
    __STORAGE_KEY,
    JSON.stringify({
      version: __SCHEMA_VERSION,
      ...makeRecord({ label: undefined, addedAtMs: undefined }),
    }),
  );
  const loaded = loadPairingState({ storage });
  assert.ok(loaded);
  assert.equal(loaded.label, "");
  assert.equal(loaded.addedAtMs, 0);
});

test("loadPairingState ignores non-numeric addedAtMs", () => {
  const storage = makeStorage();
  storage.setItem(
    __STORAGE_KEY,
    JSON.stringify({
      version: __SCHEMA_VERSION,
      ...makeRecord({ addedAtMs: "yesterday" }),
    }),
  );
  const loaded = loadPairingState({ storage });
  assert.ok(loaded);
  assert.equal(loaded.addedAtMs, 0);
});

test("savePairingState rejects non-object input", () => {
  const storage = makeStorage();
  assert.throws(() => savePairingState(null, { storage }), TypeError);
  assert.throws(() => savePairingState("nope", { storage }), TypeError);
  assert.throws(() => savePairingState(undefined, { storage }), TypeError);
});

test("savePairingState rejects missing required fields", () => {
  const storage = makeStorage();
  for (const drop of [
    "pairingId",
    "relayToken",
    "phonePub",
    "phoneFingerprint",
    "bridgePubHex",
    "bridgeFingerprint",
    "relayUrl",
  ]) {
    const record = makeRecord();
    delete record[drop];
    assert.throws(
      () => savePairingState(record, { storage }),
      (err) =>
        err instanceof TypeError &&
        new RegExp(drop).test(err.message),
      `expected TypeError mentioning '${drop}'`,
    );
  }
});

test("savePairingState rejects empty-string required fields", () => {
  const storage = makeStorage();
  assert.throws(
    () => savePairingState(makeRecord({ pairingId: "" }), { storage }),
    /pairingId must be a non-empty string/,
  );
  assert.throws(
    () => savePairingState(makeRecord({ relayToken: "" }), { storage }),
    /relayToken must be a non-empty string/,
  );
});

test("savePairingState defaults addedAtMs to Date.now() when missing", () => {
  const storage = makeStorage();
  const before = Date.now();
  const record = makeRecord();
  delete record.addedAtMs;
  savePairingState(record, { storage });
  const after = Date.now();

  const loaded = loadPairingState({ storage });
  assert.ok(loaded.addedAtMs >= before && loaded.addedAtMs <= after);
});

test("savePairingState coerces non-string label to empty string", () => {
  const storage = makeStorage();
  savePairingState(makeRecord({ label: undefined }), { storage });
  const loaded = loadPairingState({ storage });
  assert.equal(loaded.label, "");
});

test("savePairingState overwrites an existing record (single-record assumption)", () => {
  const storage = makeStorage();
  savePairingState(makeRecord({ label: "first" }), { storage });
  savePairingState(makeRecord({ label: "second" }), { storage });
  const loaded = loadPairingState({ storage });
  assert.equal(loaded.label, "second");
});

test("clearPairingState removes the record", () => {
  const storage = makeStorage();
  savePairingState(makeRecord(), { storage });
  assert.ok(loadPairingState({ storage }));
  clearPairingState({ storage });
  assert.equal(loadPairingState({ storage }), null);
});

test("clearPairingState is a no-op when the record is absent", () => {
  const storage = makeStorage();
  // Should not throw or touch unrelated keys.
  storage.setItem("some.other.key", "keep me");
  clearPairingState({ storage });
  assert.equal(storage.getItem("some.other.key"), "keep me");
});

// ---------------------------------------------------------------------------
// Storage-unavailability tolerance — covers Safari private mode + headless
// test contexts where localStorage is missing entirely or throws on access.

test("loadPairingState returns null when storage throws on access", () => {
  const storage = {
    getItem() {
      throw new Error("private mode quota");
    },
    setItem() {},
    removeItem() {},
  };
  assert.equal(loadPairingState({ storage }), null);
});

test("savePairingState swallows quota errors and returns false", () => {
  const storage = {
    getItem: () => null,
    setItem() {
      throw new Error("QuotaExceeded");
    },
    removeItem() {},
  };
  assert.equal(savePairingState(makeRecord(), { storage }), false);
});

test("clearPairingState swallows removeItem errors silently", () => {
  const storage = {
    getItem: () => null,
    setItem() {},
    removeItem() {
      throw new Error("denied");
    },
  };
  // Should not throw.
  clearPairingState({ storage });
});

test("helpers fall back gracefully when no storage is provided and globalThis lacks localStorage", () => {
  // The default `getStorage` reads `globalThis.localStorage`. In the Node
  // test runner that's typically undefined — verify the helpers don't crash
  // and report missing-storage outcomes.
  const previous = globalThis.localStorage;
  try {
    delete globalThis.localStorage;
    assert.equal(loadPairingState(), null);
    assert.equal(savePairingState(makeRecord()), false);
    // clearPairingState returns void; just ensure it doesn't throw.
    clearPairingState();
  } finally {
    if (previous !== undefined) globalThis.localStorage = previous;
  }
});
