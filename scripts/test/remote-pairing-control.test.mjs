/**
 * remote-pairing-control.test.mjs — Phase 5d unit tests for control.mjs.
 *
 * Covers the three exported helpers without touching the real
 * `~/.viveworker` directory:
 *
 *   - restartRemotePairingRelay()  (close-then-start mechanics)
 *   - persistRemotePairingEnv()    (env-file upsert/preserve)
 *   - getRemotePairingStatus()     (dormant fallback + delegation)
 *
 * The hot-restart tests deliberately use `enabled: false` for the *new*
 * handle so `startRemotePairingRelay` takes its dormant branch (no I/O,
 * no WebSocket, no keypair file). That's enough to verify the close /
 * replace mechanics — full enabled-mode startup is exercised end-to-end
 * by remote-pairing-e2e.test.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  restartRemotePairingRelay,
  persistRemotePairingEnv,
  getRemotePairingStatus,
  __ENV_KEY_ENABLED,
  __ENV_KEY_RELAY_URL,
} from "../lib/remote-pairing/control.mjs";

// ---------------------------------------------------------------------------
// Tmp helpers
// ---------------------------------------------------------------------------

async function makeTmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vw-control-"));
  return {
    dir,
    envFile: path.join(dir, "remote-pairing.env"),
    cleanup: async () => {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * Spy-handle: a stand-in for an existing `runtime.remotePairingHandle` whose
 * `close()` we want to observe. `closeBehavior: "throw"` lets us verify the
 * helper swallows teardown errors.
 */
function makeSpyHandle({ closeBehavior = "ok" } = {}) {
  const calls = { close: 0 };
  return {
    calls,
    close() {
      calls.close += 1;
      if (closeBehavior === "throw") {
        throw new Error("spy: close failed");
      }
    },
    // getStatus / reloadNow / etc. are not exercised by the helper but the
    // bridge runtime can poke them — return safe defaults so a misuse fails
    // loudly rather than silently.
    getStatus() {
      throw new Error("spy.getStatus should not be called by control.restart");
    },
  };
}

// ---------------------------------------------------------------------------
// restartRemotePairingRelay
// ---------------------------------------------------------------------------

test("restartRemotePairingRelay: starts a dormant handle when no previous handle exists", async () => {
  const runtime = { remotePairingHandle: null };
  const handle = await restartRemotePairingRelay({
    runtime,
    config: { remotePairingEnabled: false, remotePairingRelayUrl: "" },
    requestListener: () => {},
  });

  // Mounted on runtime, returned to caller, dormant shape.
  assert.equal(runtime.remotePairingHandle, handle);
  assert.equal(typeof handle.close, "function");
  const status = handle.getStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.relayUrl, "");
  assert.deepEqual(status.sessions, []);

  handle.close();
});

test("restartRemotePairingRelay: closes the old handle, replaces with a new one", async () => {
  const oldHandle = makeSpyHandle();
  const runtime = { remotePairingHandle: oldHandle };

  const newHandle = await restartRemotePairingRelay({
    runtime,
    config: { remotePairingEnabled: false, remotePairingRelayUrl: "" },
    requestListener: () => {},
  });

  assert.equal(oldHandle.calls.close, 1, "old handle.close() called exactly once");
  assert.notEqual(runtime.remotePairingHandle, oldHandle, "runtime no longer points at old handle");
  assert.equal(runtime.remotePairingHandle, newHandle, "runtime points at new handle");

  newHandle.close();
});

test("restartRemotePairingRelay: swallows errors from the old handle's close()", async () => {
  const oldHandle = makeSpyHandle({ closeBehavior: "throw" });
  const runtime = { remotePairingHandle: oldHandle };

  const warnings = [];
  const logger = {
    warn: (msg) => warnings.push(String(msg)),
    info: () => {},
    debug: () => {},
    error: () => {},
  };

  // Even though the old handle's close() throws, the helper must keep going
  // and produce a fresh handle. The "buggy WebSocketImpl" comment in
  // control.mjs is the real-world motivator for this guarantee.
  const newHandle = await restartRemotePairingRelay({
    runtime,
    config: { remotePairingEnabled: false, remotePairingRelayUrl: "" },
    requestListener: () => {},
    logger,
  });

  assert.equal(oldHandle.calls.close, 1);
  assert.equal(typeof newHandle.close, "function");
  assert.equal(runtime.remotePairingHandle, newHandle);
  // The warn message format isn't part of the contract; check that *some*
  // warning was emitted so a regression to silent-failure is caught.
  assert.ok(
    warnings.some((m) => /close during restart failed/.test(m)),
    `expected a warn about close failure, got: ${JSON.stringify(warnings)}`,
  );

  newHandle.close();
});

test("restartRemotePairingRelay: validates runtime + requestListener", async () => {
  // Missing runtime
  await assert.rejects(
    restartRemotePairingRelay({
      runtime: null,
      config: { remotePairingEnabled: false },
      requestListener: () => {},
    }),
    /runtime required/,
  );
  await assert.rejects(
    restartRemotePairingRelay({
      runtime: "not-an-object",
      config: { remotePairingEnabled: false },
      requestListener: () => {},
    }),
    /runtime required/,
  );

  // Missing requestListener
  await assert.rejects(
    restartRemotePairingRelay({
      runtime: { remotePairingHandle: null },
      config: { remotePairingEnabled: false },
      // requestListener intentionally omitted
    }),
    /requestListener required/,
  );
});

// ---------------------------------------------------------------------------
// persistRemotePairingEnv
// ---------------------------------------------------------------------------

test("persistRemotePairingEnv: writes a fresh env file when none exists", async () => {
  const tmp = await makeTmp();
  try {
    await persistRemotePairingEnv({
      enabled: true,
      relayUrl: "wss://test.example/relay",
      envFile: tmp.envFile,
    });

    const text = await fs.readFile(tmp.envFile, "utf8");
    assert.match(text, new RegExp(`^${__ENV_KEY_ENABLED}=true`, "m"));
    assert.match(text, new RegExp(`^${__ENV_KEY_RELAY_URL}=wss://test\\.example/relay`, "m"));

    // File mode should be 0o600 (owner-only) since this can hold secrets in
    // the same env file alongside the bridge identity key.
    const stat = await fs.stat(tmp.envFile);
    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    await tmp.cleanup();
  }
});

test("persistRemotePairingEnv: preserves unrelated keys (e.g. IDENTITY_KEY_PRIV)", async () => {
  const tmp = await makeTmp();
  try {
    // Pre-write a file with a key the helper is NOT supposed to touch.
    await fs.mkdir(path.dirname(tmp.envFile), { recursive: true });
    await fs.writeFile(
      tmp.envFile,
      [
        "# Auto-generated by viveworker",
        "IDENTITY_KEY_PRIV=deadbeefcafebabe",
        `${__ENV_KEY_ENABLED}=false`,
      ].join("\n") + "\n",
      { mode: 0o600 },
    );

    await persistRemotePairingEnv({
      enabled: true,
      relayUrl: "wss://test.example/relay",
      envFile: tmp.envFile,
    });

    const text = await fs.readFile(tmp.envFile, "utf8");
    assert.match(text, /IDENTITY_KEY_PRIV=deadbeefcafebabe/);
    assert.match(text, new RegExp(`^${__ENV_KEY_ENABLED}=true$`, "m"));
    assert.match(text, new RegExp(`^${__ENV_KEY_RELAY_URL}=wss://test\\.example/relay$`, "m"));
    // Comment line should still be there
    assert.match(text, /# Auto-generated by viveworker/);
  } finally {
    await tmp.cleanup();
  }
});

test("persistRemotePairingEnv: relayUrl: null writes the key with an empty value (\"unset\")", async () => {
  const tmp = await makeTmp();
  try {
    // Pre-seed a file with a non-empty relay URL so we can verify the
    // helper actually clears it.
    await fs.mkdir(path.dirname(tmp.envFile), { recursive: true });
    await fs.writeFile(
      tmp.envFile,
      `${__ENV_KEY_RELAY_URL}=wss://old.example/relay\n`,
      { mode: 0o600 },
    );

    await persistRemotePairingEnv({
      relayUrl: null,
      envFile: tmp.envFile,
    });

    const text = await fs.readFile(tmp.envFile, "utf8");
    // The key remains but with empty value — the env loader treats KEY= as
    // unset, so the orchestrator falls back to DEFAULT_RELAY_URL.
    assert.match(text, new RegExp(`^${__ENV_KEY_RELAY_URL}=$`, "m"));
    // No leftover non-empty value
    assert.doesNotMatch(text, /wss:\/\/old\.example/);
  } finally {
    await tmp.cleanup();
  }
});

test("persistRemotePairingEnv: relayUrl: \"\" is treated the same as null", async () => {
  const tmp = await makeTmp();
  try {
    await fs.mkdir(path.dirname(tmp.envFile), { recursive: true });
    await fs.writeFile(
      tmp.envFile,
      `${__ENV_KEY_RELAY_URL}=wss://old.example/relay\n`,
      { mode: 0o600 },
    );

    await persistRemotePairingEnv({ relayUrl: "", envFile: tmp.envFile });

    const text = await fs.readFile(tmp.envFile, "utf8");
    assert.match(text, new RegExp(`^${__ENV_KEY_RELAY_URL}=$`, "m"));
  } finally {
    await tmp.cleanup();
  }
});

test("persistRemotePairingEnv: enabled-only update doesn't touch the relay URL", async () => {
  const tmp = await makeTmp();
  try {
    await fs.mkdir(path.dirname(tmp.envFile), { recursive: true });
    await fs.writeFile(
      tmp.envFile,
      [
        `${__ENV_KEY_ENABLED}=false`,
        `${__ENV_KEY_RELAY_URL}=wss://test.example/relay`,
      ].join("\n") + "\n",
      { mode: 0o600 },
    );

    await persistRemotePairingEnv({ enabled: true, envFile: tmp.envFile });

    const text = await fs.readFile(tmp.envFile, "utf8");
    assert.match(text, new RegExp(`^${__ENV_KEY_ENABLED}=true$`, "m"));
    // Critically — relay URL is still the pre-existing value.
    assert.match(text, new RegExp(`^${__ENV_KEY_RELAY_URL}=wss://test\\.example/relay$`, "m"));
  } finally {
    await tmp.cleanup();
  }
});

test("persistRemotePairingEnv: relayUrl-only update doesn't touch the enabled flag", async () => {
  const tmp = await makeTmp();
  try {
    await fs.mkdir(path.dirname(tmp.envFile), { recursive: true });
    await fs.writeFile(
      tmp.envFile,
      [
        `${__ENV_KEY_ENABLED}=true`,
        `${__ENV_KEY_RELAY_URL}=wss://old.example/relay`,
      ].join("\n") + "\n",
      { mode: 0o600 },
    );

    await persistRemotePairingEnv({
      relayUrl: "wss://new.example/relay",
      envFile: tmp.envFile,
    });

    const text = await fs.readFile(tmp.envFile, "utf8");
    assert.match(text, new RegExp(`^${__ENV_KEY_ENABLED}=true$`, "m"));
    assert.match(text, new RegExp(`^${__ENV_KEY_RELAY_URL}=wss://new\\.example/relay$`, "m"));
  } finally {
    await tmp.cleanup();
  }
});

test("persistRemotePairingEnv: no-op when neither enabled nor relayUrl is provided", async () => {
  const tmp = await makeTmp();
  try {
    // Don't pre-create the file — if the helper tries to write anything
    // we'll see it on disk afterwards.
    await persistRemotePairingEnv({ envFile: tmp.envFile });

    await assert.rejects(
      fs.stat(tmp.envFile),
      { code: "ENOENT" },
      "no-op call must not create the env file",
    );
  } finally {
    await tmp.cleanup();
  }
});

test("persistRemotePairingEnv: creates the parent directory if missing", async () => {
  const tmp = await makeTmp();
  try {
    // Wipe the temp directory entirely so the helper has to mkdir.
    await fs.rm(tmp.dir, { recursive: true, force: true });

    await persistRemotePairingEnv({
      enabled: true,
      envFile: tmp.envFile,
    });

    // File and directory should both exist now.
    const stat = await fs.stat(tmp.envFile);
    assert.ok(stat.isFile());

    const dirStat = await fs.stat(path.dirname(tmp.envFile));
    assert.ok(dirStat.isDirectory());
    // Directory mode should be 0o700 — same justification as the file
    // mode (this dir holds the bridge's static keypair).
    assert.equal(dirStat.mode & 0o777, 0o700);
  } finally {
    await tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// getRemotePairingStatus
// ---------------------------------------------------------------------------

test("getRemotePairingStatus: returns dormant shape when runtime has no handle", () => {
  assert.deepEqual(getRemotePairingStatus({}), {
    enabled: false,
    relayUrl: "",
    identityFingerprint: null,
    identityPubHex: null,
    sessions: [],
  });
  assert.deepEqual(getRemotePairingStatus({ remotePairingHandle: null }), {
    enabled: false,
    relayUrl: "",
    identityFingerprint: null,
    identityPubHex: null,
    sessions: [],
  });
});

test("getRemotePairingStatus: returns dormant shape when handle has no getStatus()", () => {
  // Defensive — if a future refactor stores a half-built handle here, we'd
  // rather see "disabled" in the UI than crash the bridge.
  const status = getRemotePairingStatus({
    remotePairingHandle: { close() {} }, // no getStatus
  });
  assert.equal(status.enabled, false);
  assert.deepEqual(status.sessions, []);
});

test("getRemotePairingStatus: delegates to handle.getStatus() when present", () => {
  const handle = {
    getStatus: () => ({
      enabled: true,
      relayUrl: "wss://test.example/relay",
      identityFingerprint: "AB:CD:EF",
      identityPubHex: "deadbeef",
      sessions: [{ pairingId: "p1", state: "open" }],
    }),
  };
  const status = getRemotePairingStatus({ remotePairingHandle: handle });
  assert.equal(status.enabled, true);
  assert.equal(status.relayUrl, "wss://test.example/relay");
  assert.equal(status.identityFingerprint, "AB:CD:EF");
  assert.equal(status.identityPubHex, "deadbeef");
  assert.equal(status.sessions.length, 1);
  assert.equal(status.sessions[0].pairingId, "p1");
});
