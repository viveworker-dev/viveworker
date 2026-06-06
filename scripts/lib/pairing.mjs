import crypto from "node:crypto";

export const PAIRING_TTL_MS = 15 * 60 * 1000;

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function isPairingExpired(expiresAtMs, now = Date.now()) {
  const normalized = Number(expiresAtMs) || 0;
  return normalized > 0 && now >= normalized;
}

export function shouldRotatePairing({ force = false, pairingCode = "", pairingToken = "", pairingExpiresAtMs = 0 } = {}, now = Date.now()) {
  return Boolean(force || !pairingCode || !pairingToken || isPairingExpired(pairingExpiresAtMs, now));
}

export function generatePairingCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += PAIRING_ALPHABET[bytes[index] % PAIRING_ALPHABET.length];
  }
  return output;
}

export function generatePairingCredentials(now = Date.now()) {
  return {
    pairingCode: generatePairingCode(8),
    pairingToken: crypto.randomBytes(18).toString("hex"),
    pairingExpiresAtMs: now + PAIRING_TTL_MS,
  };
}

export function upsertEnvText(rawText, updates) {
  const text = String(rawText || "");
  const entries = Object.entries(updates || {}).filter(([key]) => key);
  if (entries.length === 0) {
    return text;
  }

  // Reject keys/values that would corrupt the line-based env file or inject
  // extra assignments. A value containing CR/LF (e.g. from a hostile/compromised
  // relay response during `a2a setup`) could otherwise smuggle additional
  // KEY=VALUE lines — including ones that override security-critical config such
  // as AUTH_REQUIRED or SESSION_SECRET when the file is later loaded into the
  // environment.
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(String(key))) {
      throw new Error(`upsertEnvText: invalid env key ${JSON.stringify(key)}`);
    }
    if (/[\r\n]/u.test(String(value ?? ""))) {
      throw new Error(`upsertEnvText: env value for ${key} contains a newline; refusing to write a possibly injected env file`);
    }
  }

  const updateMap = new Map(entries.map(([key, value]) => [String(key), String(value ?? "")]));
  const seen = new Set();
  const output = [];

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = String(rawLine);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      output.push(line);
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) {
      output.push(line);
      continue;
    }

    const key = line.slice(0, separator).trim();
    if (!updateMap.has(key)) {
      output.push(line);
      continue;
    }

    if (seen.has(key)) {
      continue;
    }

    output.push(`${key}=${updateMap.get(key)}`);
    seen.add(key);
  }

  for (const [key, value] of updateMap.entries()) {
    if (!seen.has(key)) {
      output.push(`${key}=${value}`);
    }
  }

  while (output.length > 0 && output[output.length - 1] === "") {
    output.pop();
  }

  return `${output.join("\n")}\n`;
}
