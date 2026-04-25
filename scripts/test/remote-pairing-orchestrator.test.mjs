/**
 * remote-pairing-orchestrator.test.mjs — Phase 4b tests for orchestrator.mjs.
 *
 * Pure unit tests with a stub `WebSocketImpl` — they never connect to a real
 * relay. The orchestrator's job is to wire keys + pairings + dispatch + the
 * BridgeRelayClient + an fs.watch reload-trigger; tests verify each of those
 * seams independently:
 *
 *   - dormant handle when `enabled: false` (no I/O at all)
 *   - validation on missing requestListener
 *   - relayUrl resolution (env vs option vs default)
 *   - identity keypair is created on first run, reused on second
 *   - sessions match the on-disk pairings list
 *   - getStatus() shape
 *   - reloadNow() picks up file changes immediately (bypasses debounce)
 *   - fs.watch triggers a debounced reload after the file is rewritten
 *   - close() tears down watcher + client + is idempotent
 *
 * Run:
 *   node --test scripts/test/remote-pairing-orchestrator.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  startRemotePairingRelay,
  DEFAULT_RELAY_URL,
  __RELOAD_DEBOUNCE_MS,
} from "../lib/remote-pairing/orchestrator.mjs";
import { savePairings, buildPairing } from "../lib/remote-pairing/pairings.mjs";
import { generateIdentityKeypair } from "../lib/remote-pairing/keys-core.mjs";
import { STATE } from "../../web/remote-pairing/transport.js";

// ---------------------------------------------------------------------------
// Stub WebSocketImpl — never opens, never reconnects on its own.
// (Same shape as the unit-test stub in remote-pairing-bridge-relay-client.test.mjs.)
// ---------------------------------------------------------------------------

function makeStubWebSocketImpl() {
  const created = [];
  class StubWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0; // CONNECTING
      this._listeners = {};
      this.binaryType = "blob";
      created.push(this);
    }
    addEventListener(type, fn) {
      (this._listeners[type] ??= []).push(fn);
    }
    removeEventListener(type, fn) {
      const arr = this._listeners[type] ?? [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }
    send() {
      throw new Error("StubWebSocket.send: not open");
    }
    close(code = 1000, reason = "") {
      this.readyState = 3; // CLOSED
      for (const fn of this._listeners.close ?? []) fn({ code, reason });
    }
    terminate() {
      this.close(1006, "terminated");
    }
  }
  StubWebSocket.created = created;
  return StubWebSocket;
}

// ---------------------------------------------------------------------------
// Tmp dir helpers — every test gets its own directory so they can run in
// parallel without trampling each other's keypair / pairings file.
// ---------------------------------------------------------------------------

async function makeTmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vw-orchestrator-"));
  return {
    dir,
    keysFile: path.join(dir, "remote-pairing.env"),
    pairingsFile: path.join(dir, "remote-pairings.json"),
    cleanup: async () => {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

function makePairing(label = "phone") {
  const kp = generateIdentityKeypair();
  return buildPairing({
    pairingId: `pair-${Math.random().toString(36).slice(2, 10)}`,
    phonePub: kp.pub,
    label,
  });
}

// ---------------------------------------------------------------------------
// Validation & dormant-handle paths
// ---------------------------------------------------------------------------

test("enabled: false returns a dormant handle (no I/O)", async () => {
  const tmp = await makeTmp();
  try {
    const handle = await startRemotePairingRelay({
      enabled: false,
      // requestListener intentionally omitted — dormant path mustn't validate
      identityKeypairFile: tmp.keysFile,
      pairingsFile: tmp.pairingsFile,
      WebSocketImpl: makeStubWebSocketImpl(),
    });

    assert.equal(handle.client, null);
    assert.equal(handle.identityKeypair, null);
    assert.equal(typeof handle.close, "function");
    assert.equal(typeof handle.reloadNow, "function");
    assert.equal(typeof handle.kick, "function");
    assert.equal(typeof handle.broadcast, "function");
    assert.equal(typeof handle.getStatus, "function");
    assert.deepEqual(handle.getStatus(), {
      enabled: false,
      relayUrl: "",
      identityFingerprint: null,
      identityPubHex: null,
      sessions: [],
    });
    // close() / reloadNow() / kick() / broadcast() must all be safe no-ops.
    await handle.reloadNow();
    handle.kick();
    handle.broadcast("hello", { x: 1 });
    handle.close();

    // Critical: dormant must not have created the keypair file.
    await assert.rejects(fs.stat(tmp.keysFile), { code: "ENOENT" });
  } finally {
    await tmp.cleanup();
  }
});

test("missing requestListener throws (when enabled)", async () => {
  const tmp = await makeTmp();
  try {
    await assert.rejects(
      startRemotePairingRelay({
        identityKeypairFile: tmp.keysFile,
        pairingsFile: tmp.pairingsFile,
        WebSocketImpl: makeStubWebSocketImpl(),
        // requestListener omitted
      }),
      /requestListener required/,
    );
  } finally {
    await tmp.cleanup();
  }
});

test("empty relayUrl throws", async () => {
  const tmp = await makeTmp();
  try {
    await assert.rejects(
      startRemotePairingRelay({
        relayUrl: "   ", // becomes "" after trim
        requestListener: () => {},
        identityKeypairFile: tmp.keysFile,
        pairingsFile: tmp.pairingsFile,
        WebSocketImpl: makeStubWebSocketImpl(),
      }),
      /empty relayUrl/,
    );
  } finally {
    await tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// relayUrl resolution
// ---------------------------------------------------------------------------

test("relayUrl: option > env > default", async () => {
  // Default
  const tmp1 = await makeTmp();
  const prevEnv = process.env.REMOTE_PAIRING_RELAY_URL;
  try {
    delete process.env.REMOTE_PAIRING_RELAY_URL;
    const handle = await startRemotePairingRelay({
      requestListener: () => {},
      identityKeypairFile: tmp1.keysFile,
      pairingsFile: tmp1.pairingsFile,
      WebSocketImpl: makeStubWebSocketImpl(),
      watchPairingsFile: false,
    });
    assert.equal(handle.getStatus().relayUrl, DEFAULT_RELAY_URL);
    handle.close();
  } finally {
    if (prevEnv !== undefined) process.env.REMOTE_PAIRING_RELAY_URL = prevEnv;
    else delete process.env.REMOTE_PAIRING_RELAY_URL;
    await tmp1.cleanup();
  }

  // Env wins over default
  const tmp2 = await makeTmp();
  const saved = process.env.REMOTE_PAIRING_RELAY_URL;
  try {
    process.env.REMOTE_PAIRING_RELAY_URL = "wss://env.example/relay";
    const handle = await startRemotePairingRelay({
      requestListener: () => {},
      identityKeypairFile: tmp2.keysFile,
      pairingsFile: tmp2.pairingsFile,
      WebSocketImpl: makeStubWebSocketImpl(),
      watchPairingsFile: false,
    });
    assert.equal(handle.getStatus().relayUrl, "wss://env.example/relay");
    handle.close();
  } finally {
    if (saved !== undefined) process.env.REMOTE_PAIRING_RELAY_URL = saved;
    else delete process.env.REMOTE_PAIRING_RELAY_URL;
    await tmp2.cleanup();
  }

  // Option wins over env
  const tmp3 = await makeTmp();
  const saved2 = process.env.REMOTE_PAIRING_RELAY_URL;
  try {
    process.env.REMOTE_PAIRING_RELAY_URL = "wss://env.example/relay";
    const handle = await startRemotePairingRelay({
      relayUrl: "wss://opt.example/relay",
      requestListener: () => {},
      identityKeypairFile: tmp3.keysFile,
      pairingsFile: tmp3.pairingsFile,
      WebSocketImpl: makeStubWebSocketImpl(),
      watchPairingsFile: false,
    });
    assert.equal(handle.getStatus().relayUrl, "wss://opt.example/relay");
    handle.close();
  } finally {
    if (saved2 !== undefined) process.env.REMOTE_PAIRING_RELAY_URL = saved2;
    else delete process.env.REMOTE_PAIRING_RELAY_URL;
    await tmp3.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Identity keypair lifecycle
// ---------------------------------------------------------------------------

test("identity keypair: created on first run, reused on second", async () => {
  const tmp = await makeTmp();
  try {
    const Stub = makeStubWebSocketImpl();
    const handle1 = await startRemotePairingRelay({
      requestListener: () => {},
      identityKeypairFile: tmp.keysFile,
      pairingsFile: tmp.pairingsFile,
      WebSocketImpl: Stub,
      watchPairingsFile: false,
    });
    assert.ok(handle1.identityKeypair, "keypair should be populated");
    assert.equal(handle1.identityKeypair.pub.length, 32);
    assert.equal(handle1.identityKeypair.priv.length, 32);
    const pubHex1 = handle1.getStatus().identityPubHex;
    handle1.close();

    // File must now exist with mode 0o600.
    const stat = await fs.stat(tmp.keysFile);
    assert.equal(stat.mode & 0o777, 0o600);

    // Second start must reuse the same key.
    const handle2 = await startRemotePairingRelay({
      requestListener: () => {},
      identityKeypairFile: tmp.keysFile,
      pairingsFile: tmp.pairingsFile,
      WebSocketImpl: makeStubWebSocketImpl(),
      watchPairingsFile: false,
    });
    assert.equal(handle2.getStatus().identityPubHex, pubHex1);
    handle2.close();
  } finally {
    await tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Wiring: pairings → sessions
// ---------------------------------------------------------------------------

test("opens one session per pairing in the file", async () => {
  const tmp = await makeTmp();
  try {
    const pairings = [makePairing("A"), makePairing("B"), makePairing("C")];
    await savePairings(pairings, tmp.pairingsFile);

    const Stub = makeStubWebSocketImpl();
    const handle = await startRemotePairingRelay({
      requestListener: () => {},
      identityKeypairFile: tmp.keysFile,
      pairingsFile: tmp.pairingsFile,
      WebSocketImpl: Stub,
      watchPairingsFile: false,
    });

    assert.equal(Stub.created.length, 3);
    const ids = handle.client.getSessions().map((s) => s.pairingId).sort();
    assert.deepEqual(ids, pairings.map((p) => p.pairingId).sort());

    handle.close();
  } finally {
    await tmp.cleanup();
  }
});

test("missing pairings file → zero sessions, no throw", async () => {
  const tmp = await makeTmp();
  try {
    const Stub = makeStubWebSocketImpl();
    const handle = await startRemotePairingRelay({
      requestListener: () => {},
      identityKeypairFile: tmp.keysFile,
      pairingsFile: tmp.pairingsFile, // doesn't exist
      WebSocketImpl: Stub,
      watchPairingsFile: false,
    });
    assert.equal(handle.client.getSessions().length, 0);
    assert.equal(Stub.created.length, 0);
    handle.close();
  } finally {
    await tmp.cleanup();
  }
});

test("malformed pairings file → load failure caught, zero sessions", async () => {
  const tmp = await makeTmp();
  try {
    await fs.writeFile(tmp.pairingsFile, "{not json", "utf8");
    const warns = [];
    const Stub = makeStubWebSocketImpl();
    const handle = await startRemotePairingRelay({
      requestListener: () => {},
      identityKeypairFile: tmp.keysFile,
      pairingsFile: tmp.pairingsFile,
      WebSocketImpl: Stub,
      logger: { warn: (m) => warns.push(m) },
      watchPairingsFile: false,
    });

    assert.equal(handle.client.getSessions().length, 0);
    assert.ok(warns.some((m) => /failed to load/.test(m)));
    handle.close();
  } finally {
    await tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// getStatus()
// ---------------------------------------------------------------------------

test("getStatus() shape — populated when enabled", async () => {
  const tmp = await makeTmp();
  try {
    const pairing = makePairing("status-phone");
    await savePairings([pairing], tmp.pairingsFile);

    const handle = await startRemotePairingRelay({
      relayUrl: "wss://status.example",
      requestListener: () => {},
      identityKeypairFile: tmp.keysFile,
      pairingsFile: tmp.pairingsFile,
      WebSocketImpl: makeStubWebSocketImpl(),
      watchPairingsFile: false,
    });

    const st = handle.getStatus();
    assert.equal(st.enabled, true);
    assert.equal(st.relayUrl, "wss://status.example");
    assert.match(st.identityFingerprint, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.match(st.identityPubHex, /^[0-9a-f]{64}$/);
    assert.equal(st.sessions.length, 1);
    assert.equal(st.sessions[0].pairingId, pairing.pairingId);
    assert.equal(st.sessions[0].label, "status-phone");
    assert.equal(typeof st.sessions[0].state, "string");

    handle.close();
  } finally {
    await tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// reloadNow() — explicit reload bypasses debounce
// ---------------------------------------------------------------------------

test("reloadNow() picks up additions and removals", async () => {
  const tmp = await makeTmp();
  try {
    const a = makePairing("A");
    const b = makePairing("B");
    await savePairings([a, b], tmp.pairingsFile);

    const Stub = makeStubWebSocketImpl();
    const handle = await startRemotePairingRelay({
      requestListener: () => {},
      identityKeypairFile: tmp.keysFile,
      pairingsFile: tmp.pairingsFile,
      WebSocketImpl: Stub,
      watchPairingsFile: false, // exercise reloadNow specifically
    });
    assert.equal(handle.client.getSessions().length, 2);
    assert.equal(Stub.created.length, 2);

    // Drop B, add C
    const c = makePairing("C");
    await savePairings([a, c], tmp.pairingsFile);
    await handle.reloadNow();

    const ids = handle.client.getSessions().map((s) => s.pairingId).sort();
    assert.deepEqual(ids, [a.pairingId, c.pairingId].sort());
    assert.equal(Stub.created.length, 3, "one new WS for C");

    // Remove all
    await savePairings([], tmp.pairingsFile);
    await handle.reloadNow();
    assert.equal(handle.client.getSessions().length, 0);

    handle.close();
  } finally {
    await tmp.cleanup();
  }
});

test("reloadNow() cancels a pending debounced reload", async () => {
  const tmp = await makeTmp();
  try {
    const a = makePairing("A");
    await savePairings([a], tmp.pairingsFile);

    const Stub = makeStubWebSocketImpl();
    const handle = await startRemotePairingRelay({
      requestListener: () => {},
      identityKeypairFile: tmp.keysFile,
      pairingsFile: tmp.pairingsFile,
      WebSocketImpl: Stub,
      watchPairingsFile: true,
    });
    const startWsCount = Stub.created.length;

    // Trigger the watcher by writing a new file, then call reloadNow()
    // before the debounce window elapses. There must be exactly one reload,
    // not two.
    const b = makePairing("B");
    await savePairings([a, b], tmp.pairingsFile);
    await handle.reloadNow();

    // Wait past the debounce window — confirm no extra reload fires.
    await sleep(__RELOAD_DEBOUNCE_MS + 50);

    const ids = handle.client.getSessions().map((s) => s.pairingId).sort();
    assert.deepEqual(ids, [a.pairingId, b.pairingId].sort());
    // Two pairings, one new WS spawned by reloadNow(): 2 total.
    // (Watcher would have also tried to spawn 1 more if it weren't cancelled.)
    assert.equal(Stub.created.length, startWsCount + 1);

    handle.close();
  } finally {
    await tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// fs.watch — debounced reload triggered by file change
// ---------------------------------------------------------------------------

test("fs.watch triggers a debounced reload after file change", async (t) => {
  const tmp = await makeTmp();
  try {
    const a = makePairing("A");
    await savePairings([a], tmp.pairingsFile);

    const Stub = makeStubWebSocketImpl();
    const handle = await startRemotePairingRelay({
      requestListener: () => {},
      identityKeypairFile: tmp.keysFile,
      pairingsFile: tmp.pairingsFile,
      WebSocketImpl: Stub,
      watchPairingsFile: true,
    });
    assert.equal(handle.client.getSessions().length, 1);
    const startWsCount = Stub.created.length;

    // Modify the file and wait long enough for fs.watch + debounce to fire.
    const b = makePairing("B");
    await savePairings([a, b], tmp.pairingsFile);

    // Poll up to ~2s — fs.watch is platform-dependent; on Docker / NFS it
    // may simply never fire. Skip the test rather than hang the suite.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (handle.client.getSessions().length === 2) break;
      await sleep(50);
    }
    if (handle.client.getSessions().length !== 2) {
      handle.close();
      t.skip("fs.watch did not fire on this platform — debounced-reload path untested here, but reloadNow() covers the same code path");
      return;
    }

    const ids = handle.client.getSessions().map((s) => s.pairingId).sort();
    assert.deepEqual(ids, [a.pairingId, b.pairingId].sort());
    assert.equal(Stub.created.length, startWsCount + 1);

    handle.close();
  } finally {
    await tmp.cleanup();
  }
});

test("watchPairingsFile: false → no fs.watch, file changes ignored", async () => {
  const tmp = await makeTmp();
  try {
    const a = makePairing("A");
    await savePairings([a], tmp.pairingsFile);

    const Stub = makeStubWebSocketImpl();
    const handle = await startRemotePairingRelay({
      requestListener: () => {},
      identityKeypairFile: tmp.keysFile,
      pairingsFile: tmp.pairingsFile,
      WebSocketImpl: Stub,
      watchPairingsFile: false,
    });
    const startWsCount = Stub.created.length;

    // Modify the file, wait past the debounce — sessions must not change.
    const b = makePairing("B");
    await savePairings([a, b], tmp.pairingsFile);
    await sleep(__RELOAD_DEBOUNCE_MS + 100);

    assert.equal(handle.client.getSessions().length, 1);
    assert.equal(Stub.created.length, startWsCount);

    handle.close();
  } finally {
    await tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// kick / broadcast / close
// ---------------------------------------------------------------------------

test("kick() and broadcast() delegate to the underlying client", async () => {
  const tmp = await makeTmp();
  try {
    const a = makePairing("A");
    await savePairings([a], tmp.pairingsFile);

    const Stub = makeStubWebSocketImpl();
    const handle = await startRemotePairingRelay({
      requestListener: () => {},
      identityKeypairFile: tmp.keysFile,
      pairingsFile: tmp.pairingsFile,
      WebSocketImpl: Stub,
      watchPairingsFile: false,
    });

    let kicked = 0;
    let broadcasts = [];
    handle.client.kick = () => { kicked++; };
    handle.client.broadcast = (topic, data) => { broadcasts.push({ topic, data }); };

    handle.kick();
    handle.broadcast("hello", { n: 1 });
    handle.broadcast("ping");

    assert.equal(kicked, 1);
    assert.deepEqual(broadcasts, [
      { topic: "hello", data: { n: 1 } },
      { topic: "ping", data: undefined },
    ]);

    handle.close();
  } finally {
    await tmp.cleanup();
  }
});

test("close() tears down sessions + watcher; idempotent", async () => {
  const tmp = await makeTmp();
  try {
    const a = makePairing("A");
    const b = makePairing("B");
    await savePairings([a, b], tmp.pairingsFile);

    const Stub = makeStubWebSocketImpl();
    const handle = await startRemotePairingRelay({
      requestListener: () => {},
      identityKeypairFile: tmp.keysFile,
      pairingsFile: tmp.pairingsFile,
      WebSocketImpl: Stub,
      watchPairingsFile: true,
    });

    assert.equal(Stub.created.length, 2);
    handle.close();
    for (const ws of Stub.created) {
      assert.equal(ws.readyState, 3, "WS should be CLOSED after close()");
    }
    assert.equal(handle.client.getSessions().length, 0);

    // Idempotent.
    handle.close();
    handle.close();
  } finally {
    await tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Logger: integration smoke
// ---------------------------------------------------------------------------

test("logger.info is invoked with identity + pairings count summary", async () => {
  const tmp = await makeTmp();
  try {
    const pairing = makePairing();
    await savePairings([pairing], tmp.pairingsFile);

    const infos = [];
    const handle = await startRemotePairingRelay({
      requestListener: () => {},
      identityKeypairFile: tmp.keysFile,
      pairingsFile: tmp.pairingsFile,
      WebSocketImpl: makeStubWebSocketImpl(),
      watchPairingsFile: false,
      logger: { info: (m) => infos.push(m) },
    });

    assert.ok(infos.some((m) => /identity pub=/.test(m)),
      "expected an info log line announcing the identity");
    assert.ok(infos.some((m) => /loaded 1 paired phone/.test(m)),
      "expected an info log line announcing the pairings count");

    handle.close();
  } finally {
    await tmp.cleanup();
  }
});

// Touch STATE so the import isn't pruned by lint tools — orchestrator
// surface includes session.state strings the bridge UI compares against.
void STATE;
