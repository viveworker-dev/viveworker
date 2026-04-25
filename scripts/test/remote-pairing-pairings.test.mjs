/**
 * remote-pairing-pairings.test.mjs — Phase 3b tests for pairings.mjs.
 *
 * Drives the on-disk paired-phones allowlist against a temp directory.
 * Verifies normalization, atomic writes, lookups, and the round-trip
 * across persistPairing/loadPairings.
 *
 * Run:
 *   node --test scripts/test/remote-pairing-pairings.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadPairings,
  savePairings,
  addPairing,
  removePairingByPub,
  findByPub,
  findByPairingId,
  markSeen,
  buildPairing,
  addPairingPersisted,
  removePairingPersisted,
  MAX_PAIRINGS,
} from "../lib/remote-pairing/pairings.mjs";
import { generateIdentityKeypair, bytesToHex } from "../lib/remote-pairing/keys-core.mjs";

// ---------------------------------------------------------------------------
// Test harness — temp file per test
// ---------------------------------------------------------------------------

async function tmpFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "viveworker-pairings-"));
  return path.join(dir, "remote-pairings.json");
}

function fakePairing(overrides = {}) {
  const kp = generateIdentityKeypair();
  return buildPairing({
    pairingId: overrides.pairingId ?? `slot-${Math.random().toString(36).slice(2, 10)}`,
    phonePub: kp.pub,
    label: overrides.label ?? "Test phone",
  });
}

// ---------------------------------------------------------------------------
// Load / save roundtrip
// ---------------------------------------------------------------------------

test("loadPairings on missing file returns []", async () => {
  const filePath = path.join(os.tmpdir(), `viveworker-missing-${Date.now()}.json`);
  const got = await loadPairings(filePath);
  assert.deepEqual(got, []);
});

test("save then load roundtrips all fields", async () => {
  const filePath = await tmpFile();
  const p = fakePairing({ label: "iPhone test" });
  await savePairings([p], filePath);
  const loaded = await loadPairings(filePath);
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0], p);
});

test("file mode is 0o600 after save", async () => {
  const filePath = await tmpFile();
  await savePairings([fakePairing()], filePath);
  const stat = await fs.stat(filePath);
  // Linux/macOS: lower 9 bits are perms. Mask to 0o777 for portability.
  assert.equal(stat.mode & 0o777, 0o600);
});

test("savePairings overwrites with atomic rename (intermediate file is gone)", async () => {
  const filePath = await tmpFile();
  await savePairings([fakePairing(), fakePairing()], filePath);

  const dir = path.dirname(filePath);
  const files = await fs.readdir(dir);
  // Only the target file should remain — no leftover .tmp-*.
  const leftovers = files.filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "no .tmp-* file should remain");
});

// ---------------------------------------------------------------------------
// Normalization on load
// ---------------------------------------------------------------------------

test("loadPairings rejects malformed JSON", async () => {
  const filePath = await tmpFile();
  await fs.writeFile(filePath, "{not-json", "utf8");
  await assert.rejects(() => loadPairings(filePath), /malformed JSON/);
});

test("loadPairings rejects unsupported version", async () => {
  const filePath = await tmpFile();
  await fs.writeFile(filePath, JSON.stringify({ version: 99, pairings: [] }), "utf8");
  await assert.rejects(() => loadPairings(filePath), /unsupported version/);
});

test("loadPairings rejects pairings that aren't an array", async () => {
  const filePath = await tmpFile();
  await fs.writeFile(filePath, JSON.stringify({ version: 1, pairings: "nope" }), "utf8");
  await assert.rejects(() => loadPairings(filePath), /must be an array/);
});

test("loadPairings rejects entries with bad phonePub hex", async () => {
  const filePath = await tmpFile();
  await fs.writeFile(filePath, JSON.stringify({
    version: 1,
    pairings: [{
      pairingId: "x",
      phonePub: "not-hex",
      phoneFingerprint: "AAAA-BBBB-CCCC",
      label: "",
      addedAtMs: 1,
      lastSeenAtMs: null,
      lastSeenChannelBinding: null,
    }],
  }), "utf8");
  await assert.rejects(() => loadPairings(filePath), /phonePub/);
});

test("loadPairings rejects entries with wrong-sized phonePub", async () => {
  const filePath = await tmpFile();
  await fs.writeFile(filePath, JSON.stringify({
    version: 1,
    pairings: [{
      pairingId: "x",
      phonePub: "ab".repeat(16), // 16 bytes, should be 32
      phoneFingerprint: "AAAA-BBBB-CCCC",
      label: "",
      addedAtMs: 1,
      lastSeenAtMs: null,
      lastSeenChannelBinding: null,
    }],
  }), "utf8");
  await assert.rejects(() => loadPairings(filePath), /must be 32 bytes/);
});

test("loadPairings re-derives fingerprint from phonePub", async () => {
  // Even if a pre-existing file has a wrong-looking fingerprint, we trust
  // the pubkey and recompute. This protects against drift between save
  // formats over time.
  const filePath = await tmpFile();
  const kp = generateIdentityKeypair();
  await fs.writeFile(filePath, JSON.stringify({
    version: 1,
    pairings: [{
      pairingId: "x",
      phonePub: bytesToHex(kp.pub),
      phoneFingerprint: "ZZZZ-ZZZZ-ZZZZ", // intentionally wrong
      label: "",
      addedAtMs: 1,
      lastSeenAtMs: null,
      lastSeenChannelBinding: null,
    }],
  }), "utf8");
  const loaded = await loadPairings(filePath);
  // Derived fingerprint replaces the bad one.
  assert.notEqual(loaded[0].phoneFingerprint, "ZZZZ-ZZZZ-ZZZZ");
  assert.match(loaded[0].phoneFingerprint, /^[A-Z0-9]+(-[A-Z0-9]+)*$/);
});

// ---------------------------------------------------------------------------
// addPairing / removePairingByPub / lookups (pure functions)
// ---------------------------------------------------------------------------

test("addPairing inserts a new entry", () => {
  const p = fakePairing();
  const next = addPairing([], p);
  assert.equal(next.length, 1);
  assert.deepEqual(next[0], p);
});

test("addPairing is idempotent on phonePub (preserves addedAtMs)", () => {
  const p = fakePairing({ label: "Original" });
  const updated = { ...p, label: "Re-paired", addedAtMs: p.addedAtMs + 999 };
  const next = addPairing([p], updated);
  assert.equal(next.length, 1);
  assert.equal(next[0].label, "Re-paired");
  assert.equal(next[0].addedAtMs, p.addedAtMs, "addedAtMs preserved from the original");
});

test("addPairing throws past MAX_PAIRINGS", () => {
  const list = [];
  for (let i = 0; i < MAX_PAIRINGS; i++) list.push(fakePairing());
  assert.throws(() => addPairing(list, fakePairing()), /MAX_PAIRINGS/);
});

test("removePairingByPub drops the matching entry", () => {
  const a = fakePairing();
  const b = fakePairing();
  const next = removePairingByPub([a, b], a.phonePub);
  assert.equal(next.length, 1);
  assert.equal(next[0].phonePub, b.phonePub);
});

test("removePairingByPub is a no-op on unknown pubkey", () => {
  const a = fakePairing();
  const next = removePairingByPub([a], "ff".repeat(32));
  assert.equal(next.length, 1);
});

test("findByPub returns the pairing or null (case-insensitive)", () => {
  const p = fakePairing();
  assert.deepEqual(findByPub([p], p.phonePub), p);
  assert.deepEqual(findByPub([p], p.phonePub.toUpperCase()), p);
  assert.equal(findByPub([p], "00".repeat(32)), null);
});

test("findByPairingId returns the pairing or null", () => {
  const p = fakePairing();
  assert.deepEqual(findByPairingId([p], p.pairingId), p);
  assert.equal(findByPairingId([p], "no-such-slot"), null);
});

test("markSeen stamps lastSeenAtMs + channel binding (immutably)", () => {
  const p = fakePairing();
  const cb = new Uint8Array(32).fill(0xab);
  const next = markSeen([p], p.phonePub, { atMs: 1234567, channelBinding: cb });
  assert.equal(next.length, 1);
  assert.equal(next[0].lastSeenAtMs, 1234567);
  assert.equal(next[0].lastSeenChannelBinding, "ab".repeat(32));
  // Original list untouched.
  assert.equal(p.lastSeenAtMs, null);
});

test("markSeen on unknown pub is a no-op (returns equivalent list)", () => {
  const p = fakePairing();
  const next = markSeen([p], "00".repeat(32), { atMs: 1 });
  assert.deepEqual(next, [p]);
});

// ---------------------------------------------------------------------------
// Persisted helpers
// ---------------------------------------------------------------------------

test("addPairingPersisted writes and reads back", async () => {
  const filePath = await tmpFile();
  const a = fakePairing();
  const after = await addPairingPersisted(a, filePath);
  assert.equal(after.length, 1);
  const loaded = await loadPairings(filePath);
  assert.deepEqual(loaded, after);
});

test("removePairingPersisted is idempotent on missing pub (no extra writes)", async () => {
  const filePath = await tmpFile();
  const a = fakePairing();
  await savePairings([a], filePath);
  const beforeStat = await fs.stat(filePath);

  // Sleep 5ms to make any write detectable via mtime.
  await new Promise((r) => setTimeout(r, 5));
  await removePairingPersisted("00".repeat(32), filePath);

  const afterStat = await fs.stat(filePath);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, "no-op should not rewrite the file");
});

// ---------------------------------------------------------------------------
// buildPairing helper
// ---------------------------------------------------------------------------

test("buildPairing computes fingerprint + addedAtMs", () => {
  const kp = generateIdentityKeypair();
  const p = buildPairing({ pairingId: "slot-x", phonePub: kp.pub, label: "test" });
  assert.equal(p.pairingId, "slot-x");
  assert.equal(p.phonePub, bytesToHex(kp.pub));
  assert.match(p.phoneFingerprint, /^[A-Z0-9]+(-[A-Z0-9]+)*$/);
  assert.equal(p.label, "test");
  assert.ok(p.addedAtMs > 0);
  assert.equal(p.lastSeenAtMs, null);
  assert.equal(p.lastSeenChannelBinding, null);
});

test("buildPairing rejects wrong-sized phonePub", () => {
  assert.throws(
    () => buildPairing({ pairingId: "x", phonePub: new Uint8Array(16) }),
    /must be 32 bytes/,
  );
});
