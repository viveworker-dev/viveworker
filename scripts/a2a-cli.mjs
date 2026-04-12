/**
 * a2a-cli.mjs — CLI for viveworker A2A relay operations.
 *
 * Usage:
 *   viveworker a2a setup --user-id <id> [--relay-url <url>] [--timeout <seconds>]
 *
 * The `setup` command:
 *   1. Creates a setup session on the relay
 *   2. Opens the GitHub OAuth URL in the user's browser
 *   3. Polls for completion (user approves in browser)
 *   4. Writes credentials to ~/.viveworker/a2a.env
 *   5. Bridge can then be restarted to auto-connect
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { upsertEnvText } from "./lib/pairing.mjs";

const A2A_ENV_FILE = path.join(os.homedir(), ".viveworker", "a2a.env");
const DEFAULT_RELAY_URL = "https://a2a.viveworker.com";
const DEFAULT_TIMEOUT = 300; // 5 minutes
const POLL_INTERVAL = 3000;  // 3 seconds

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function runA2ACli(args) {
  const cmd = args[0];

  switch (cmd) {
    case "setup":
      return handleSetup(args.slice(1));
    default:
      console.log("Usage: viveworker a2a setup --user-id <id> [--relay-url <url>] [--timeout <seconds>]");
      if (cmd && cmd !== "help" && cmd !== "--help") {
        throw new Error(`Unknown command: ${cmd}`);
      }
  }
}

// ---------------------------------------------------------------------------
// setup command
// ---------------------------------------------------------------------------

async function handleSetup(args) {
  const flags = parseFlags(args);
  const userId = flags["user-id"] || flags["userId"];
  const relayUrl = (flags["relay-url"] || flags["relayUrl"] || DEFAULT_RELAY_URL).replace(/\/$/u, "");
  const timeout = Number(flags["timeout"]) || DEFAULT_TIMEOUT;

  if (!userId) {
    throw new Error("--user-id is required\nUsage: viveworker a2a setup --user-id <id>");
  }

  console.log(`\n🔗 viveworker A2A Relay Setup`);
  console.log(`   Relay:   ${relayUrl}`);
  console.log(`   User ID: ${userId}\n`);

  // Step 1: Create setup session
  console.log("⏳ Creating setup session...");
  const sessionRes = await fetchJson(`${relayUrl}/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });

  if (sessionRes.error) {
    throw new Error(`Setup session failed: ${sessionRes.error}`);
  }

  const { token, authUrl } = sessionRes;
  console.log(`✅ Session created\n`);

  // Step 2: Open browser
  console.log(`🌐 Opening browser for GitHub authorization...`);
  console.log(`   ${authUrl}\n`);
  openBrowser(authUrl);

  console.log(`⏳ Waiting for GitHub authorization (timeout: ${timeout}s)...`);

  // Step 3: Poll for completion
  const deadline = Date.now() + timeout * 1000;
  let result = null;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);

    const pollRes = await fetchJson(`${relayUrl}/auth/setup/${token}`);

    if (pollRes.status === "completed") {
      result = pollRes.credentials;
      break;
    }

    if (pollRes.status === "error") {
      throw new Error(`Registration failed: ${pollRes.error}`);
    }

    if (pollRes.error) {
      throw new Error(`Poll error: ${pollRes.error}`);
    }

    // Still pending — continue polling
  }

  if (!result) {
    throw new Error("Timeout waiting for GitHub authorization. Please try again.");
  }

  console.log(`\n✅ GitHub authorization complete (@${result.githubLogin})\n`);

  // Step 4: Write to a2a.env
  console.log(`📝 Writing credentials to ${A2A_ENV_FILE}...`);

  let currentEnv = "";
  try {
    currentEnv = await fs.readFile(A2A_ENV_FILE, "utf8");
  } catch {
    // File may not exist
  }

  const updated = upsertEnvText(currentEnv, {
    A2A_API_KEY: result.a2aApiKey,
    A2A_RELAY_URL: result.relayUrl,
    A2A_RELAY_USER_ID: result.userId,
    A2A_RELAY_REGISTER_SECRET: result.registerSecret,
  });

  await fs.mkdir(path.dirname(A2A_ENV_FILE), { recursive: true, mode: 0o700 });
  await fs.writeFile(A2A_ENV_FILE, updated, { mode: 0o600 });

  console.log(`✅ Credentials saved\n`);
  console.log(`🚀 Setup complete! Restart your viveworker bridge to connect.`);
  console.log(`   Your A2A endpoint: ${result.relayUrl}/${result.userId}\n`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[arg.slice(2)] = args[++i];
      } else {
        flags[arg.slice(2)] = true;
      }
    }
  }
  return flags;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function openBrowser(url) {
  try {
    if (process.platform === "darwin") {
      execSync(`open "${url}"`, { stdio: "ignore" });
    } else if (process.platform === "linux") {
      execSync(`xdg-open "${url}"`, { stdio: "ignore" });
    } else if (process.platform === "win32") {
      execSync(`start "" "${url}"`, { stdio: "ignore" });
    }
  } catch {
    // Browser open failed — URL is already printed for manual use
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
