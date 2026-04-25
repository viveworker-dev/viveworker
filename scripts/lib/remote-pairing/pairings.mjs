/**
 * pairings.mjs — On-disk allowlist of phones the bridge will accept over the
 * remote-pairing relay.
 *
 * The bridge's static keypair (`keys.mjs`) defines its OWN identity. This
 * module tracks the OTHER side: which phone pubkeys the LAN-pairing flow
 * has approved + what relay slot (`pairingId`) each one connects through.
 *
 * Why a separate file from `remote-pairing.env`:
 *   - The env is single-record (the bridge's keypair) and rarely changes.
 *   - Pairings are multi-record, mutable (add when LAN pairs, remove when
 *     the user revokes a device), and we want structured fields (label,
 *     timestamps, fingerprint) without inventing an ad-hoc env grammar.
 *   - JSON keeps the data introspectable (`cat ~/.viveworker/remote-pairings.json`)
 *     while still being mode 0o600 so other users can't read it.
 *
 * File format (`~/.viveworker/remote-pairings.json`):
 *
 *   {
 *     "version": 1,
 *     "pairings": [
 *       {
 *         "pairingId":            "<relay slot, opaque string>",
 *         "phonePub":              "<lowercase hex 32 bytes — phone's X25519 static pub>",
 *         "phoneFingerprint":      "ABCD-EF12-3456",
 *         "label":                 "iPhone (LAN-paired 2026-04-25)",
 *         "addedAtMs":             1714000000000,
 *         "lastSeenAtMs":          null,
 *         "lastSeenChannelBinding": null
 *       }
 *     ]
 *   }
 *
 * Trust model:
 *   The presence of a phone pubkey in this list means "the user explicitly
 *   approved this device on the LAN side". The bridge MUST verify post-
 *   handshake that `transport.session.remoteStatic` equals one of the
 *   `phonePub` entries before serving any RPC. The Noise IK handshake itself
 *   only proves "the peer holds this private key" — it does not gate WHICH
 *   peers we want to talk to. That's this file's job.
 *
 * Concurrency:
 *   Atomic-rename writes via fs.writeFile + fs.rename so a crash mid-write
 *   doesn't leave the file truncated. The bridge is single-process today
 *   so we don't need cross-process locking.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { fingerprintIdentity, hexToBytes, bytesToHex, IDENTITY_KEY_BYTES } from "./keys-core.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REMOTE_PAIRINGS_FILE = path.join(
  os.homedir(),
  ".viveworker",
  "remote-pairings.json",
);

const FORMAT_VERSION = 1;

// Defensive cap on how many pairings we'll track. The bridge's per-pairing WS
// is cheap (one outbound connection apiece) but the user only physically
// owns a handful of devices. 200 matches MAX_PAIRED_DEVICES on the LAN side
// so the limits agree.
export const MAX_PAIRINGS = 200;

// ---------------------------------------------------------------------------
// Pairing typedef
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Pairing
 * @property {string} pairingId        relay slot identifier; opaque to us
 * @property {string} phonePub         lowercase hex of the phone's X25519 pub
 * @property {string} phoneFingerprint human-readable "ABCD-EF12-3456" of phonePub
 * @property {string} label            user-visible label (e.g. "iPhone (LAN 2026-04-25)")
 * @property {number} addedAtMs        epoch ms at LAN pair time
 * @property {number | null} lastSeenAtMs            epoch ms of most recent successful relay handshake
 * @property {string | null} lastSeenChannelBinding  hex of last channel binding (debug only)
 */

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Load the pairings list from disk. Returns [] if the file is missing or
 * empty. Throws on malformed JSON or wrong version (caller can decide
 * whether to back the file up + start fresh).
 *
 * @param {string} [filePath]
 * @returns {Promise<Pairing[]>}
 */
export async function loadPairings(filePath = REMOTE_PAIRINGS_FILE) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  if (!text.trim()) return [];

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new Error(`pairings file ${filePath}: malformed JSON (${err.message})`);
  }
  if (!obj || typeof obj !== "object") {
    throw new Error(`pairings file ${filePath}: not a JSON object`);
  }
  if (obj.version !== FORMAT_VERSION) {
    throw new Error(`pairings file ${filePath}: unsupported version ${obj.version} (expected ${FORMAT_VERSION})`);
  }
  if (!Array.isArray(obj.pairings)) {
    throw new Error(`pairings file ${filePath}: "pairings" must be an array`);
  }
  return obj.pairings.map((entry, idx) => normalizePairing(entry, idx));
}

// ---------------------------------------------------------------------------
// Write — atomic
// ---------------------------------------------------------------------------

/**
 * Write the pairings list to disk atomically (write-temp + rename).
 *
 * @param {Pairing[]} pairings
 * @param {string} [filePath]
 */
export async function savePairings(pairings, filePath = REMOTE_PAIRINGS_FILE) {
  if (!Array.isArray(pairings)) throw new TypeError("pairings must be an array");
  if (pairings.length > MAX_PAIRINGS) {
    throw new RangeError(`too many pairings: ${pairings.length} > ${MAX_PAIRINGS}`);
  }
  const validated = pairings.map((p, i) => normalizePairing(p, i));

  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const body = JSON.stringify(
    { version: FORMAT_VERSION, pairings: validated },
    null,
    2,
  ) + "\n";

  // Atomic write: temp file + rename on the same volume.
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, body, { mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Add / remove / lookup
// ---------------------------------------------------------------------------

/**
 * Idempotently add (or update) a pairing. If a pairing with the same
 * `phonePub` already exists, fields are merged (incoming wins on
 * conflict, except addedAtMs which is preserved from the original).
 *
 * @param {Pairing[]} pairings
 * @param {Pairing} entry
 * @returns {Pairing[]} new array (caller should pass to savePairings)
 */
export function addPairing(pairings, entry) {
  const incoming = normalizePairing(entry, "incoming");
  const out = pairings.slice();
  const idx = out.findIndex((p) => p.phonePub === incoming.phonePub);
  if (idx >= 0) {
    const original = out[idx];
    out[idx] = { ...original, ...incoming, addedAtMs: original.addedAtMs };
  } else {
    if (out.length >= MAX_PAIRINGS) {
      throw new RangeError(`would exceed MAX_PAIRINGS=${MAX_PAIRINGS}`);
    }
    out.push(incoming);
  }
  return out;
}

/** @param {Pairing[]} pairings @param {string} phonePub */
export function removePairingByPub(pairings, phonePub) {
  const norm = String(phonePub || "").toLowerCase();
  return pairings.filter((p) => p.phonePub !== norm);
}

/** @param {Pairing[]} pairings @param {string} phonePub */
export function findByPub(pairings, phonePub) {
  const norm = String(phonePub || "").toLowerCase();
  return pairings.find((p) => p.phonePub === norm) ?? null;
}

/** @param {Pairing[]} pairings @param {string} pairingId */
export function findByPairingId(pairings, pairingId) {
  return pairings.find((p) => p.pairingId === pairingId) ?? null;
}

/**
 * Stamp last-seen metadata on a pairing in-place (pure function; returns
 * a new array). Useful for "show last connect time in the settings UI".
 *
 * @param {Pairing[]} pairings
 * @param {string} phonePub
 * @param {{ atMs: number, channelBinding?: Uint8Array | null }} info
 */
export function markSeen(pairings, phonePub, { atMs, channelBinding = null }) {
  const norm = String(phonePub || "").toLowerCase();
  return pairings.map((p) => {
    if (p.phonePub !== norm) return p;
    return {
      ...p,
      lastSeenAtMs: atMs,
      lastSeenChannelBinding: channelBinding
        ? bytesToHex(asU8(channelBinding))
        : p.lastSeenChannelBinding,
    };
  });
}

// ---------------------------------------------------------------------------
// Convenience: full read-modify-write helpers (for callers who don't
// want to manage the array themselves).
// ---------------------------------------------------------------------------

export async function addPairingPersisted(entry, filePath = REMOTE_PAIRINGS_FILE) {
  const current = await loadPairings(filePath);
  const next = addPairing(current, entry);
  await savePairings(next, filePath);
  return next;
}

export async function removePairingPersisted(phonePub, filePath = REMOTE_PAIRINGS_FILE) {
  const current = await loadPairings(filePath);
  const next = removePairingByPub(current, phonePub);
  if (next.length === current.length) return current; // no-op
  await savePairings(next, filePath);
  return next;
}

// ---------------------------------------------------------------------------
// Helper used by clients to build an entry from a phone pubkey
// ---------------------------------------------------------------------------

/**
 * Build a fresh Pairing record. Computes the fingerprint for you and
 * stamps `addedAtMs`. The caller is expected to invent the `pairingId`
 * (typically a UUID) and the `label`.
 *
 * @param {{ pairingId: string, phonePub: Uint8Array | string, label?: string }} input
 * @returns {Pairing}
 */
export function buildPairing({ pairingId, phonePub, label }) {
  const pubBytes = asU8(phonePub);
  if (pubBytes.length !== IDENTITY_KEY_BYTES) {
    throw new RangeError(`phonePub must be ${IDENTITY_KEY_BYTES} bytes, got ${pubBytes.length}`);
  }
  return {
    pairingId: String(pairingId),
    phonePub: bytesToHex(pubBytes),
    phoneFingerprint: fingerprintIdentity(pubBytes),
    label: label ? String(label) : "",
    addedAtMs: Date.now(),
    lastSeenAtMs: null,
    lastSeenChannelBinding: null,
  };
}

// ---------------------------------------------------------------------------
// Internal: normalization + parsing
// ---------------------------------------------------------------------------

function normalizePairing(raw, ctx) {
  if (!raw || typeof raw !== "object") {
    throw new TypeError(`pairing[${ctx}]: not an object`);
  }
  const pairingId = stringOrThrow(raw.pairingId, `pairing[${ctx}].pairingId`);
  const phonePubRaw = stringOrThrow(raw.phonePub, `pairing[${ctx}].phonePub`).toLowerCase();
  // Validate phonePub by parsing the hex — catches obvious garbage early.
  let phonePubBytes;
  try {
    phonePubBytes = hexToBytes(phonePubRaw);
  } catch (err) {
    throw new Error(`pairing[${ctx}].phonePub: ${err.message}`);
  }
  if (phonePubBytes.length !== IDENTITY_KEY_BYTES) {
    throw new RangeError(
      `pairing[${ctx}].phonePub must be ${IDENTITY_KEY_BYTES} bytes (got ${phonePubBytes.length})`,
    );
  }
  // Fingerprint is recoverable from phonePub; if missing, regenerate. If
  // present and disagrees with the derived value, prefer derivation (matches
  // keys.mjs's behaviour for the bridge's own keypair).
  let fingerprint;
  try {
    fingerprint = fingerprintIdentity(phonePubBytes);
  } catch (err) {
    throw new Error(`pairing[${ctx}].phoneFingerprint: ${err.message}`);
  }

  return {
    pairingId,
    phonePub: phonePubRaw,
    phoneFingerprint: fingerprint,
    label: raw.label != null ? String(raw.label) : "",
    addedAtMs: numOrNull(raw.addedAtMs) ?? Date.now(),
    lastSeenAtMs: numOrNull(raw.lastSeenAtMs),
    lastSeenChannelBinding: stringOrNull(raw.lastSeenChannelBinding),
  };
}

function stringOrThrow(v, name) {
  if (typeof v !== "string" || v.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return v;
}

function stringOrNull(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asU8(v) {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return hexToBytes(v);
  throw new TypeError("expected Uint8Array or hex string");
}
