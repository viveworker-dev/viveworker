/**
 * remote-pairing-browser-keys.test.mjs — Unit tests for web/remote-pairing/keys.js.
 *
 * Runs the browser-side IndexedDB key store under Node by installing
 * `fake-indexeddb` as the global IDB factory. Validates load/save/ensure/
 * clear semantics + corrupt-record handling without needing a real browser.
 *
 * The browser-side smoke test (web/remote-pairing-test.html, loaded over
 * wrangler dev) exercises the same module against real Safari/Chrome IDB.
 *
 * Run:
 *   node --test scripts/test/remote-pairing-browser-keys.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

// Install fake-indexeddb as the IDB global before importing the module
// under test. The module reads `globalThis.indexedDB` lazily inside
// `openDB`, so this works even though we're loading it after import.
import "fake-indexeddb/auto";

import {
  loadIdentityKeypair,
  saveIdentityKeypair,
  ensureIdentityKeypair,
  clearIdentityKeypair,
  generateIdentityKeypair,
  publicFromPrivate,
  fingerprintIdentity,
  IDENTITY_KEY_BYTES,
} from "../../web/remote-pairing/keys.js";

// fake-indexeddb is per-DB; reset between tests by deleting the DB.
import { IDBFactory } from "fake-indexeddb";

test.beforeEach(() => {
  // Replace the entire factory instance — wipes all DBs from prior tests.
  globalThis.indexedDB = new IDBFactory();
});

// ---------------------------------------------------------------------------

test("loadIdentityKeypair returns null when nothing is stored", async () => {
  assert.equal(await loadIdentityKeypair(), null);
});

test("save → load round-trips identity bytes", async () => {
  const fresh = generateIdentityKeypair();
  await saveIdentityKeypair(fresh);

  const loaded = await loadIdentityKeypair();
  assert.ok(loaded);
  assert.deepEqual(loaded.priv, fresh.priv);
  assert.deepEqual(loaded.pub, fresh.pub);
  assert.equal(loaded.priv.length, IDENTITY_KEY_BYTES);
  assert.equal(loaded.pub.length, IDENTITY_KEY_BYTES);
  assert.ok(Number.isFinite(loaded.createdAtMs));
});

test("save defensive-copies bytes (caller mutating after save is safe)", async () => {
  const fresh = generateIdentityKeypair();
  const privSnapshot = new Uint8Array(fresh.priv);
  await saveIdentityKeypair(fresh);
  // Mutate the original after save
  fresh.priv.fill(0);

  const loaded = await loadIdentityKeypair();
  assert.deepEqual(loaded.priv, privSnapshot);
});

test("ensureIdentityKeypair generates + persists when none exists", async () => {
  const first = await ensureIdentityKeypair();
  assert.equal(first.priv.length, IDENTITY_KEY_BYTES);
  // Calling ensure again should return the SAME stored keypair.
  const second = await ensureIdentityKeypair();
  assert.deepEqual(second.priv, first.priv);
  assert.deepEqual(second.pub, first.pub);
});

test("clearIdentityKeypair wipes the record", async () => {
  await ensureIdentityKeypair();
  assert.ok(await loadIdentityKeypair());
  await clearIdentityKeypair();
  assert.equal(await loadIdentityKeypair(), null);
});

test("saveIdentityKeypair rejects mis-sized priv", async () => {
  const fresh = generateIdentityKeypair();
  fresh.priv = new Uint8Array(31);
  await assert.rejects(saveIdentityKeypair(fresh), /priv must be 32 bytes/);
});

test("saveIdentityKeypair rejects mis-sized pub", async () => {
  const fresh = generateIdentityKeypair();
  fresh.pub = new Uint8Array(33);
  await assert.rejects(saveIdentityKeypair(fresh), /pub must be 32 bytes/);
});

test("saveIdentityKeypair rejects nullish keypair", async () => {
  await assert.rejects(saveIdentityKeypair(null), /keypair/);
  await assert.rejects(saveIdentityKeypair({ priv: null, pub: null }), /keypair/);
});

test("loadIdentityKeypair recovers when stored pub disagrees with derived", async () => {
  // Plant a record where pub doesn't match priv. This shouldn't happen
  // in normal use (we always persist a derived pair) but defends against
  // storage corruption.
  const real = generateIdentityKeypair();
  const wrongPub = new Uint8Array(IDENTITY_KEY_BYTES); // all zeros — definitely not derived
  await saveIdentityKeypair({ priv: real.priv, pub: wrongPub });

  // Suppress the expected console.warn during load.
  const origWarn = console.warn;
  let warned = false;
  console.warn = (...args) => {
    if (String(args[0] ?? "").includes("disagrees with derived pub")) warned = true;
  };
  try {
    const loaded = await loadIdentityKeypair();
    assert.ok(warned, "expected divergence warning");
    // Should fall back to the derived pub from priv.
    assert.deepEqual(loaded.pub, publicFromPrivate(real.priv));
  } finally {
    console.warn = origWarn;
  }
});

test("loadIdentityKeypair returns null on corrupt-length priv", async () => {
  // Plant a malformed record: priv with wrong length. Coerced to a
  // Uint8Array via the structured-clone path; load() should detect and
  // refuse rather than throw.
  const dbReq = indexedDB.open("viveworker-remote-pairing", 1);
  await new Promise((res, rej) => {
    dbReq.onupgradeneeded = () => {
      dbReq.result.createObjectStore("keys");
    };
    dbReq.onsuccess = () => res();
    dbReq.onerror = () => rej(dbReq.error);
  });
  const db = dbReq.result;
  await new Promise((res, rej) => {
    const tx = db.transaction("keys", "readwrite");
    tx.objectStore("keys").put({
      priv: new Uint8Array(15), // wrong size
      pub: new Uint8Array(32),
      createdAtMs: Date.now(),
    }, "identity");
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  db.close();

  assert.equal(await loadIdentityKeypair(), null);
});

test("fingerprintIdentity is stable for a given pub", async () => {
  const { pub } = generateIdentityKeypair();
  const a = fingerprintIdentity(pub);
  const b = fingerprintIdentity(pub);
  assert.equal(a, b);
  assert.match(a, /^[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/);
});
