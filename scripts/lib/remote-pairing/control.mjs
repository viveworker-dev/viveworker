/**
 * control.mjs — Helpers for hot-toggling the remote-pairing relay from the
 * bridge's settings UI without restarting the bridge process.
 *
 * The orchestrator already exposes a clean `close()` and the
 * `startRemotePairingRelay()` factory is idempotent (each call builds a fresh
 * handle), so "hot restart" is just close-then-start with the current config.
 *
 * Persisting the new config to `~/.viveworker/remote-pairing.env` is a
 * separate concern — the bridge re-reads that file on start, so the toggle
 * has to write through to disk to survive the next launch. Keys are kept in
 * sync with the env-bootstrapping in `viveworker-bridge.mjs`:
 *
 *     REMOTE_PAIRING_ENABLED   = "true" | "false"
 *     REMOTE_PAIRING_RELAY_URL = "wss://..."   (optional; "" deletes)
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { upsertEnvText } from "../pairing.mjs";
import { REMOTE_PAIRING_ENV_FILE } from "./keys.mjs";
import { startRemotePairingRelay } from "./orchestrator.mjs";

const ENV_KEY_ENABLED = "REMOTE_PAIRING_ENABLED";
const ENV_KEY_RELAY_URL = "REMOTE_PAIRING_RELAY_URL";

/**
 * Close the current orchestrator handle (if any) and start a new one with
 * the values currently in `config`. Returns the new handle and stores it on
 * `runtime.remotePairingHandle`.
 *
 * Caller is expected to have updated `config.remotePairingEnabled` /
 * `config.remotePairingRelayUrl` before invoking this — the helper just
 * snapshots whatever is there now.
 *
 * Errors during teardown are swallowed (best-effort) but errors during
 * startup propagate so the API endpoint can return a useful 500.
 *
 * @param {{
 *   runtime: { remotePairingHandle: any },
 *   config: { remotePairingEnabled: boolean, remotePairingRelayUrl: string },
 *   requestListener: import("./http-dispatch.mjs").RequestListener,
 *   logger?: { debug?: Function, warn?: Function, info?: Function, error?: Function },
 * }} args
 * @returns {Promise<import("./orchestrator.mjs").RemotePairingHandle>}
 */
export async function restartRemotePairingRelay({
  runtime,
  config,
  requestListener,
  logger,
}) {
  if (!runtime || typeof runtime !== "object") {
    throw new TypeError("restartRemotePairingRelay: runtime required");
  }
  if (typeof requestListener !== "function") {
    throw new TypeError("restartRemotePairingRelay: requestListener required");
  }

  // Tear down the old handle. .close() is idempotent and safe to call on a
  // dormant handle, but wrap in try anyway since a buggy WebSocketImpl could
  // throw and we don't want that to block the rebuild.
  if (runtime.remotePairingHandle) {
    try {
      runtime.remotePairingHandle.close();
    } catch (err) {
      logger?.warn?.(`[remote-pairing] close during restart failed: ${err?.message}`);
    }
    runtime.remotePairingHandle = null;
  }

  const handle = await startRemotePairingRelay({
    enabled: Boolean(config.remotePairingEnabled),
    relayUrl: config.remotePairingRelayUrl || undefined,
    requestListener,
    logger,
  });
  runtime.remotePairingHandle = handle;
  return handle;
}

/**
 * Write the runtime config back to `~/.viveworker/remote-pairing.env` so the
 * next bridge startup sees the new values. Other keys in the file (e.g.
 * IDENTITY_KEY_PRIV) are preserved.
 *
 * `relayUrl: null` removes the env key (so the orchestrator falls back to
 * the DEFAULT_RELAY_URL); `relayUrl: ""` is treated the same. A defined
 * non-empty string overwrites.
 *
 * @param {{
 *   enabled?: boolean,
 *   relayUrl?: string | null,
 *   envFile?: string,
 * }} args
 */
export async function persistRemotePairingEnv({
  enabled,
  relayUrl,
  envFile = REMOTE_PAIRING_ENV_FILE,
} = {}) {
  const dir = path.dirname(envFile);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  let current = "";
  try {
    current = await fs.readFile(envFile, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  /** @type {Record<string, string>} */
  const updates = {};
  if (enabled !== undefined) {
    updates[ENV_KEY_ENABLED] = enabled ? "true" : "false";
  }
  if (relayUrl !== undefined) {
    // upsertEnvText with "" leaves the key as `KEY=` (empty value) which the
    // env loader interprets as unset — fine for our purposes.
    updates[ENV_KEY_RELAY_URL] = relayUrl == null ? "" : String(relayUrl);
  }
  if (Object.keys(updates).length === 0) return;

  const updated = upsertEnvText(current, updates);
  await fs.writeFile(envFile, updated, { mode: 0o600 });
}

/**
 * Convenience: return the handle's getStatus() output, or a dormant shape
 * if no handle is mounted yet (bridge starting up, or relay disabled at
 * boot and never enabled since).
 *
 * @param {{ remotePairingHandle: any }} runtime
 * @returns {import("./orchestrator.mjs").RemotePairingStatus}
 */
export function getRemotePairingStatus(runtime) {
  const handle = runtime?.remotePairingHandle;
  if (handle && typeof handle.getStatus === "function") {
    return handle.getStatus();
  }
  return {
    enabled: false,
    relayUrl: "",
    identityFingerprint: null,
    identityPubHex: null,
    sessions: [],
  };
}

// Exposed for tests so they can match keys against the env file directly.
export const __ENV_KEY_ENABLED = ENV_KEY_ENABLED;
export const __ENV_KEY_RELAY_URL = ENV_KEY_RELAY_URL;
