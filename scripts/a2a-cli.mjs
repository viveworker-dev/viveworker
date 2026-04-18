/**
 * a2a-cli.mjs — CLI for viveworker A2A relay operations.
 *
 * Recommended usage:
 *   viveworker enable a2a --user-id <id> [--relay-url <url>] [--timeout <seconds>]
 *
 * Direct usage:
 *   viveworker a2a setup --user-id <id> [--relay-url <url>] [--timeout <seconds>]
 *
 * The `setup` command:
 *   1. Creates a setup session on the relay
 *   2. Opens the GitHub OAuth URL in the user's browser
 *   3. Polls for completion (user approves in browser)
 *   4. Writes credentials to ~/.viveworker/a2a.env
 *   5. The running bridge auto-detects the credentials within ~30 seconds
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
    case "activity":
      return handleActivity(args.slice(1));
    case "card":
      return handleCard(args.slice(1));
    default:
      console.log("Commands:");
      console.log("  viveworker enable a2a   --user-id <id> [--description <text>] [--skills <csv>]");
      console.log("  viveworker a2a setup    --user-id <id> [--description <text>] [--skills <csv>]");
      console.log("  viveworker a2a activity [--state-file <path>]");
      console.log("  viveworker a2a card     [--description <text>] [--skills <csv>] [--avatar <url-or-emoji>]");
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
  const description = flags["description"] || "";
  const skillsRaw = flags["skills"] || "";
  const avatar = flags["avatar"] || "";

  if (!userId) {
    throw new Error("--user-id is required\nUsage: viveworker enable a2a --user-id <id>");
  }

  console.log(`\n🔗 viveworker A2A Relay Setup`);
  console.log(`   Relay:   ${relayUrl}`);
  console.log(`   User ID: ${userId}`);
  if (description) console.log(`   Desc:    ${description}`);
  if (skillsRaw) console.log(`   Skills:  ${skillsRaw}`);
  if (avatar) console.log(`   Avatar:  ${avatar}`);
  console.log();

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

  const envVars = {
    A2A_API_KEY: result.a2aApiKey,
    A2A_RELAY_URL: result.relayUrl,
    A2A_RELAY_USER_ID: result.userId,
    A2A_RELAY_REGISTER_SECRET: result.registerSecret,
  };
  if (description) envVars.A2A_DESCRIPTION = description;
  if (skillsRaw) envVars.A2A_SKILLS = skillsRaw;
  if (avatar) envVars.A2A_AVATAR = avatar;

  const updated = upsertEnvText(currentEnv, envVars);

  await fs.mkdir(path.dirname(A2A_ENV_FILE), { recursive: true, mode: 0o700 });
  await fs.writeFile(A2A_ENV_FILE, updated, { mode: 0o600 });

  console.log(`✅ Credentials saved\n`);
  console.log(`🚀 Setup complete! If your bridge is already running, it will reconnect within about 30 seconds.`);
  console.log(`   If not, run: npx viveworker start`);
  console.log(`   Your A2A endpoint: ${result.relayUrl}/u/${result.userId}\n`);
}

// ---------------------------------------------------------------------------
// activity command
// ---------------------------------------------------------------------------

async function handleActivity(args) {
  const flags = parseFlags(args);

  // Find state file: explicit flag > STATE_FILE env > default locations
  const candidates = [
    flags["state-file"] || flags["stateFile"],
    process.env.STATE_FILE,
    path.join(os.homedir(), ".viveworker", "state.json"),
    path.join(process.cwd(), ".viveworker-state.json"),
  ].filter(Boolean);

  let stateData = null;
  let usedPath = "";
  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, "utf8");
      stateData = JSON.parse(raw);
      usedPath = candidate;
      break;
    } catch {
      // try next
    }
  }

  if (!stateData) {
    throw new Error(
      "Could not find viveworker state file.\n" +
      "Try: viveworker a2a activity --state-file /path/to/.viveworker-state.json\n" +
      "Or set STATE_FILE environment variable."
    );
  }

  const entries = stateData.recentTimelineEntries || [];
  if (entries.length === 0) {
    console.log(JSON.stringify({ totalEntries: 0, providers: {}, threads: [], recentTasks: [] }));
    return;
  }

  // Provider usage
  const providers = {};
  for (const e of entries) {
    if (e.provider) providers[e.provider] = (providers[e.provider] || 0) + 1;
  }

  // Thread topics with activity counts
  const threadMap = new Map();
  for (const e of entries) {
    const label = e.threadLabel || e.title;
    if (!label || label === "Moltbook") continue;
    if (!threadMap.has(label)) threadMap.set(label, { count: 0, providers: new Set() });
    const t = threadMap.get(label);
    t.count++;
    if (e.provider) t.providers.add(e.provider);
  }

  const threads = [...threadMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([label, v]) => ({
      label: label.slice(0, 120),
      count: v.count,
      providers: [...v.providers],
    }));

  // Recent task titles (from assistant_final and user_message kinds)
  const taskKinds = new Set(["assistant_final", "user_message", "completion"]);
  const recentTasks = [];
  const seenTitles = new Set();
  for (let i = entries.length - 1; i >= 0 && recentTasks.length < 15; i--) {
    const e = entries[i];
    if (!taskKinds.has(e.kind)) continue;
    const title = (e.title || e.threadLabel || "").trim();
    if (!title || seenTitles.has(title)) continue;
    seenTitles.add(title);
    recentTasks.push({
      title: title.slice(0, 120),
      provider: e.provider || "",
      kind: e.kind,
    });
  }

  const result = {
    stateFile: usedPath,
    totalEntries: entries.length,
    providers,
    threads,
    recentTasks,
  };

  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// card command
// ---------------------------------------------------------------------------

async function handleCard(args) {
  const flags = parseFlags(args);
  const description = flags["description"] || "";
  const skillsRaw = flags["skills"] || "";
  const avatar = flags["avatar"] || "";

  if (!description && !skillsRaw && !avatar) {
    // No flags — show current values
    let currentEnv = "";
    try {
      currentEnv = await fs.readFile(A2A_ENV_FILE, "utf8");
    } catch {
      throw new Error(`No a2a.env found at ${A2A_ENV_FILE}. Run 'viveworker enable a2a --user-id <id>' first.`);
    }

    const currentDesc = envValue(currentEnv, "A2A_DESCRIPTION");
    const currentSkills = envValue(currentEnv, "A2A_SKILLS");
    const currentAvatar = envValue(currentEnv, "A2A_AVATAR");

    console.log(`\n📇 Current Agent Card settings (${A2A_ENV_FILE})\n`);
    console.log(`   Description: ${currentDesc || "(not set)"}`);
    console.log(`   Skills:      ${currentSkills || "(not set)"}`);
    console.log(`   Avatar:      ${currentAvatar || "(not set — uses GitHub avatar or 🤖)"}\n`);
    console.log(`To update: viveworker a2a card --description "..." --skills "..." --avatar "..."`);
    return;
  }

  // Update a2a.env
  let currentEnv = "";
  try {
    currentEnv = await fs.readFile(A2A_ENV_FILE, "utf8");
  } catch {
    throw new Error(`No a2a.env found at ${A2A_ENV_FILE}. Run 'viveworker enable a2a --user-id <id>' first.`);
  }

  const updates = {};
  if (description) updates.A2A_DESCRIPTION = description;
  if (skillsRaw) updates.A2A_SKILLS = skillsRaw;
  if (avatar) updates.A2A_AVATAR = avatar;

  const updated = upsertEnvText(currentEnv, updates);
  await fs.writeFile(A2A_ENV_FILE, updated, { mode: 0o600 });

  console.log(`\n✅ Agent Card updated in ${A2A_ENV_FILE}\n`);
  if (description) console.log(`   Description: ${description}`);
  if (skillsRaw) console.log(`   Skills:      ${skillsRaw}`);
  if (avatar) console.log(`   Avatar:      ${avatar}`);
  console.log(`\n🔄 The bridge will pick up the change within 30 seconds and re-register with the relay.\n`);
}

function envValue(text, key) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === key) return trimmed.slice(eq + 1);
  }
  return "";
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
