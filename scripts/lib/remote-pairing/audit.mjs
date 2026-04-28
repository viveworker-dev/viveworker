/**
 * audit.mjs — small local audit log for remote-pairing operations.
 *
 * This intentionally stores only human-operational metadata. Relay tokens,
 * request bodies, channel bindings, and raw phone public keys are never
 * written here.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const REMOTE_PAIRING_AUDIT_FILE = path.join(
  os.homedir(),
  ".viveworker",
  "remote-pairing-audit.jsonl",
);

const MAX_AUDIT_EVENTS = 500;
const MAX_READ_EVENTS = 100;
const TYPE_RE = /^[a-z0-9_.:-]{1,64}$/u;
const OUTCOMES = new Set(["success", "failure", "info"]);

export async function appendRemotePairingAuditEvent(event, {
  filePath = REMOTE_PAIRING_AUDIT_FILE,
} = {}) {
  const record = normalizeAuditEvent(event);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await pruneAuditFile(filePath).catch(() => {});
  return record;
}

export async function readRemotePairingAuditEvents({
  limit = 20,
  filePath = REMOTE_PAIRING_AUDIT_FILE,
} = {}) {
  const safeLimit = Math.max(0, Math.min(Number(limit) || 20, MAX_READ_EVENTS));
  if (safeLimit === 0) return [];

  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const events = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      events.push(normalizeAuditEvent(JSON.parse(line)));
    } catch {
      // Ignore malformed historical lines. The audit log must never break
      // the settings page.
    }
  }
  return events
    .sort((a, b) => b.atMs - a.atMs)
    .slice(0, safeLimit);
}

function normalizeAuditEvent(event) {
  const atMs = Number.isFinite(event?.atMs) ? Number(event.atMs) : Date.now();
  const type = TYPE_RE.test(String(event?.type || ""))
    ? String(event.type)
    : "unknown";
  const outcome = OUTCOMES.has(String(event?.outcome || ""))
    ? String(event.outcome)
    : "info";

  const out = {
    id: cleanText(event?.id, 80) || `${atMs}-${randomBytes(4).toString("hex")}`,
    atMs,
    type,
    outcome,
  };

  copyText(out, event, "label", 120);
  copyText(out, event, "phoneFingerprint", 32);
  copyText(out, event, "deviceId", 120);
  copyText(out, event, "pairingId", 24);
  copyText(out, event, "state", 32);
  copyText(out, event, "previousState", 32);
  copyText(out, event, "route", 32);
  copyText(out, event, "reason", 160);
  copyText(out, event, "relayHost", 120);

  return out;
}

function copyText(out, event, key, maxLen) {
  const value = cleanText(event?.[key], maxLen);
  if (value) out[key] = value;
}

function cleanText(value, maxLen) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim()
    .slice(0, maxLen);
}

async function pruneAuditFile(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }
  const lines = text.split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length <= MAX_AUDIT_EVENTS) return;
  const kept = lines.slice(-MAX_AUDIT_EVENTS).join("\n") + "\n";
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  await fs.writeFile(tmpPath, kept, { mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}
