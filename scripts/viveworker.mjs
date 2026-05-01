#!/usr/bin/env node

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface as createReadlineInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_LOCALE, normalizeLocale, t } from "../web/i18n.js";
import { generatePairingCredentials, shouldRotatePairing, upsertEnvText } from "./lib/pairing.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const bridgeScript = path.join(packageRoot, "scripts", "viveworker-bridge.mjs");
const defaultConfigDir = path.join(os.homedir(), ".viveworker");
const defaultEnvFile = path.join(defaultConfigDir, "config.env");
const defaultStateFile = path.join(defaultConfigDir, "state.json");
const defaultLogDir = path.join(defaultConfigDir, "logs");
const defaultLogFile = path.join(defaultLogDir, "viveworker.log");
const defaultPidFile = path.join(defaultConfigDir, "viveworker.pid");
const defaultLaunchAgentPath = path.join(os.homedir(), "Library", "LaunchAgents", "io.viveworker.app.plist");
const defaultLabel = "io.viveworker.app";
const defaultTlsDir = path.join(defaultConfigDir, "tls");
const defaultServerPort = 8810;

const rawArgs = process.argv.slice(2);

// `viveworker moltbook <cmd> ...` bypasses the strict parseArgs so that
// free-form flags like `--text "hello"` reach the Moltbook CLI untouched.
if (rawArgs[0] === "moltbook") {
  const { runMoltbookCli } = await import("./moltbook-cli.mjs");
  try {
    await runMoltbookCli(rawArgs.slice(1));
    process.exit(0);
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}

if (rawArgs[0] === "a2a") {
  const { runA2ACli } = await import("./a2a-cli.mjs");
  try {
    await runA2ACli(rawArgs.slice(1));
    process.exit(0);
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}

if (rawArgs[0] === "share") {
  const { runShareCli } = await import("./share-cli.mjs");
  try {
    await runShareCli(rawArgs.slice(1));
    process.exit(0);
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}

if (rawArgs[0] === "stats") {
  const { runStatsCli } = await import("./stats-cli.mjs");
  try {
    await runStatsCli(rawArgs.slice(1));
    process.exit(0);
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}

if (rawArgs[0] === "mcp") {
  const { runMcpCli } = await import("./mcp-server.mjs");
  try {
    await runMcpCli(rawArgs.slice(1));
    process.exit(0);
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}

const cli = parseArgs(rawArgs);

try {
  await main(cli);
} catch (error) {
  if (process.stdout.isTTY) {
    process.stdout.write("\n");
  }
  console.error(error.message || String(error));
  process.exit(1);
}

async function main(cliOptions) {
  switch (cliOptions.command) {
    case "setup":
      await runSetup(cliOptions);
      return;
    case "pair":
      await runPair(cliOptions);
      return;
    case "enable":
      await runEnable(cliOptions);
      return;
    case "start":
      await runStart(cliOptions);
      return;
    case "stop":
      await runStop(cliOptions);
      return;
    case "status":
      await runStatus(cliOptions);
      return;
    case "doctor":
      await runDoctor(cliOptions);
      return;
    case "update":
      await runUpdate(cliOptions);
      return;
    case "help":
    default:
      printHelp();
  }
}

async function runSetup(cliOptions) {
  const configDir = resolvePath(cliOptions.configDir || defaultConfigDir);
  const envFile = resolvePath(cliOptions.envFile || path.join(configDir, "config.env"));
  const stateFile = resolvePath(cliOptions.stateFile || path.join(configDir, "state.json"));
  const logFile = resolvePath(cliOptions.logFile || path.join(configDir, "logs", "viveworker.log"));
  const pidFile = resolvePath(cliOptions.pidFile || path.join(configDir, "viveworker.pid"));
  const launchAgentPath = resolvePath(cliOptions.launchAgentPath || defaultLaunchAgentPath);
  const existing = await maybeReadEnvFile(envFile);
  const locale = await resolveSetupLocale(cliOptions, existing);
  const progress = createCliProgressReporter(locale);
  progress.update("cli.setup.progress.prepare");
  const port = cliOptions.port || Number(existing.NATIVE_APPROVAL_SERVER_PORT) || defaultServerPort;
  const hostname = cliOptions.hostname || existing.VIVEWORKER_HOSTNAME || os.hostname();
  const localHostname = hostname.endsWith(".local") ? hostname : `${hostname}.local`;
  const ips = await findLocalIpv4Addresses();
  const chosenIp = ips[0] || "127.0.0.1";
  const webPushEnabled = resolveSetupWebPushEnabled(cliOptions);
  const allowInsecureHttpLan = Boolean(cliOptions.allowInsecureHttpLan && !webPushEnabled);
  const tlsCertFile = resolvePath(
    cliOptions.tlsCertFile || existing.TLS_CERT_FILE || path.join(configDir, "tls", "cert.pem")
  );
  const tlsKeyFile = resolvePath(
    cliOptions.tlsKeyFile || existing.TLS_KEY_FILE || path.join(configDir, "tls", "key.pem")
  );
  const scheme = webPushEnabled ? "https" : "http";
  const publicBaseUrl = webPushEnabled || allowInsecureHttpLan
    ? `${scheme}://${localHostname}:${port}`
    : `http://127.0.0.1:${port}`;
  const fallbackBaseUrl = webPushEnabled || allowInsecureHttpLan
    ? `${scheme}://${chosenIp}:${port}`
    : publicBaseUrl;
  const listenHost = webPushEnabled || allowInsecureHttpLan ? "0.0.0.0" : "127.0.0.1";
  const shouldRotatePairingValue = shouldRotatePairing(
    {
      force: cliOptions.pair,
      pairingCode: existing.PAIRING_CODE,
      pairingToken: existing.PAIRING_TOKEN,
      pairingExpiresAtMs: existing.PAIRING_EXPIRES_AT_MS,
    }
  );
  const nextPairing = shouldRotatePairingValue ? generatePairingCredentials() : null;
  const pairCode =
    cliOptions.pairCode ||
    (shouldRotatePairingValue ? nextPairing.pairingCode : existing.PAIRING_CODE) ||
    generatePairingCredentials().pairingCode;
  const pairToken =
    cliOptions.pairToken ||
    (shouldRotatePairingValue ? nextPairing.pairingToken : existing.PAIRING_TOKEN) ||
    generatePairingCredentials().pairingToken;
  const sessionSecret =
    cliOptions.sessionSecret ||
    existing.SESSION_SECRET ||
    crypto.randomBytes(32).toString("hex");
  const deviceTrustTtlMs = Number(existing.DEVICE_TRUST_TTL_MS) || 30 * 24 * 60 * 60 * 1000;
  const pairingExpiresAtMs = shouldRotatePairingValue
    ? nextPairing.pairingExpiresAtMs
    : Number(existing.PAIRING_EXPIRES_AT_MS) || Date.now() + 15 * 60 * 1000;
  const enableNtfy = Boolean(cliOptions.enableNtfy);
  const webPushSubject =
    cliOptions.webPushSubject ||
    existing.WEB_PUSH_SUBJECT ||
    "mailto:viveworker@example.com";
  const tlsAssets = webPushEnabled
    ? await ensureWebPushAssets({
        cliOptions,
        existing,
        hostname,
        localHostname,
        locale,
        progress,
        chosenIp,
        tlsCertFile,
        tlsKeyFile,
      })
    : null;

  progress.update("cli.setup.progress.writeConfig");
  await fs.mkdir(path.dirname(envFile), { recursive: true });
  await fs.mkdir(path.dirname(logFile), { recursive: true });

  const envLines = [
    `WEB_UI_ENABLED=1`,
    `AUTH_REQUIRED=1`,
    `VIVEWORKER_HOSTNAME=${hostname}`,
    `CODEX_HOME=${existing.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex")}`,
    `STATE_FILE=${stateFile}`,
    `NATIVE_APPROVAL_SERVER_HOST=${listenHost}`,
    `NATIVE_APPROVAL_SERVER_PORT=${port}`,
    `NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL=${publicBaseUrl}`,
    `SESSION_SECRET=${sessionSecret}`,
    `DEVICE_TRUST_TTL_MS=${deviceTrustTtlMs}`,
    `DEFAULT_LOCALE=${locale}`,
    `WEB_PUSH_ENABLED=${webPushEnabled ? 1 : 0}`,
    `ALLOW_INSECURE_LAN_HTTP=${allowInsecureHttpLan ? 1 : 0}`,
    webPushEnabled ? `TLS_CERT_FILE=${tlsAssets.certFile}` : null,
    webPushEnabled ? `TLS_KEY_FILE=${tlsAssets.keyFile}` : null,
    webPushEnabled ? `WEB_PUSH_VAPID_PUBLIC_KEY=${tlsAssets.vapidPublicKey}` : null,
    webPushEnabled ? `WEB_PUSH_VAPID_PRIVATE_KEY=${tlsAssets.vapidPrivateKey}` : null,
    webPushEnabled ? `WEB_PUSH_SUBJECT=${webPushSubject}` : null,
    `PAIRING_CODE=${pairCode}`,
    `PAIRING_TOKEN=${pairToken}`,
    `PAIRING_EXPIRES_AT_MS=${pairingExpiresAtMs}`,
    `CHOICE_PAGE_SIZE=5`,
    `MAX_HISTORY_ITEMS=100`,
    `NATIVE_APPROVALS=1`,
    `NOTIFY_APPROVALS=${enableNtfy ? 1 : 0}`,
    `NOTIFY_PLANS=${enableNtfy ? 1 : 0}`,
    `NOTIFY_COMPLETIONS=${enableNtfy ? 1 : 0}`,
    `ENABLE_NTFY=${enableNtfy ? 1 : 0}`,
    enableNtfy && existing.NTFY_BASE_URL ? `NTFY_BASE_URL=${existing.NTFY_BASE_URL}` : null,
    enableNtfy && existing.NTFY_PUBLISH_BASE_URL ? `NTFY_PUBLISH_BASE_URL=${existing.NTFY_PUBLISH_BASE_URL}` : null,
    enableNtfy && existing.NTFY_TOPIC ? `NTFY_TOPIC=${existing.NTFY_TOPIC}` : null,
    enableNtfy && existing.NTFY_ACCESS_TOKEN ? `NTFY_ACCESS_TOKEN=${existing.NTFY_ACCESS_TOKEN}` : null,
  ].filter(Boolean);

  await fs.writeFile(envFile, `${envLines.join("\n")}\n`, "utf8");

  progress.update("cli.setup.progress.providers");
  const providerSetup = await autoConfigureProvidersDuringSetup({
    cliOptions,
    envFile,
    sessionSecret,
    codexHome: existing.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  });

  if (!cliOptions.noLaunchd) {
    progress.update("cli.setup.progress.launchd");
    const plist = buildLaunchAgentPlist({
      label: defaultLabel,
      nodePath: process.execPath,
      bridgeScript,
      envFile,
      logFile,
    });
    await fs.mkdir(path.dirname(launchAgentPath), { recursive: true });
    await fs.writeFile(launchAgentPath, plist, "utf8");
    await execCommand(["launchctl", "bootout", `gui/${process.getuid()}`, launchAgentPath], { ignoreError: true });
    await execCommand(["launchctl", "bootstrap", `gui/${process.getuid()}`, launchAgentPath]);
    await execCommand(["launchctl", "kickstart", "-k", `gui/${process.getuid()}/${defaultLabel}`]);
  } else {
    progress.update("cli.setup.progress.startBridge");
    await startDetachedBridge({ envFile, logFile, pidFile });
  }

  progress.update("cli.setup.progress.health");
  const healthy = await waitForHealth(buildLoopbackHealthUrl(publicBaseUrl));
  const pairingReady = healthy
    ? await waitForExpectedPairing(publicBaseUrl, pairToken)
    : false;
  progress.done(healthy && pairingReady ? "cli.setup.complete" : "cli.setup.completePending");
  if (healthy && !pairingReady) {
    console.log("");
    console.log(t(locale, "cli.setup.warning.stalePairingServer", { port }));
  }

  const pairPath = `/app?pairToken=${encodeURIComponent(pairToken)}`;
  const mkcertRootCaFile = resolvePath(
    existing.MKCERT_ROOT_CA_FILE || process.env.MKCERT_ROOT_CA_FILE || "~/Library/Application Support/mkcert/rootCA.pem"
  );
  const canShowCaDownload = webPushEnabled && await fileExists(mkcertRootCaFile);
  const caPath = "/ca/rootCA.pem";
  let caDownloadLocalUrl = `${publicBaseUrl}${caPath}`;
  let caDownloadIpUrl = `${fallbackBaseUrl}${caPath}`;
  let temporaryCaServer = null;
  const shouldPromptCaTrust = Boolean(webPushEnabled && canShowCaDownload && !cliOptions.pair && tlsAssets?.ranMkcertInstall);

  if (shouldPromptCaTrust) {
    temporaryCaServer = await startTemporaryCaDownloadServer({
      rootCaFile: mkcertRootCaFile,
      preferredPort: port + 1,
      localHostname,
      fallbackIp: chosenIp,
      pathName: caPath,
    });
    caDownloadLocalUrl = temporaryCaServer.localUrl;
    caDownloadIpUrl = temporaryCaServer.ipUrl;
    console.log("");
    console.log(t(locale, webPushEnabled ? "cli.setup.webPushEnabled" : "cli.setup.webPushDisabled"));
    console.log(t(locale, "cli.setup.caFlow.title"));
    console.log(t(locale, "cli.setup.caDownloadLocal", { url: caDownloadLocalUrl }));
    console.log(t(locale, "cli.setup.caDownloadIp", { url: caDownloadIpUrl }));
    console.log("");
    console.log(t(locale, "cli.setup.caFlow.step1"));
    console.log(t(locale, "cli.setup.caFlow.step2"));
    console.log(t(locale, "cli.setup.caFlow.step3"));
    console.log("");
    console.log(t(locale, "cli.setup.qrCaDownload"));
    await printQrCode(caDownloadIpUrl);
    try {
      await waitForEnter(locale, "cli.setup.prompt.continueToApp");
    } finally {
      await temporaryCaServer.close();
      temporaryCaServer = null;
    }
  }

  printCliSection(locale, "cli.section.ready", [
    t(locale, "cli.setup.primaryUrl", { url: publicBaseUrl }),
    t(locale, "cli.setup.fallbackUrl", { url: fallbackBaseUrl }),
    t(locale, "cli.setup.pairingCode", { code: pairCode }),
    t(locale, webPushEnabled ? "cli.setup.webPushEnabled" : "cli.setup.webPushDisabled"),
    ...getSetupProviderSummaryLines(locale, providerSetup),
  ]);
  printCliSection(locale, "cli.section.needsAttention", [
    allowInsecureHttpLan ? t(locale, "cli.setup.warning.insecureHttpLan") : "",
    healthy && !pairingReady ? t(locale, "cli.setup.warning.stalePairingServer", { port }) : "",
  ]);
  printCliSection(locale, "cli.section.next", [
    cliOptions.pair ? t(locale, "cli.setup.pairRefresh.copy") : "",
    cliOptions.pair ? t(locale, "cli.setup.pairRefresh.reminder") : "",
    webPushEnabled
      ? t(locale, shouldPromptCaTrust ? "cli.setup.instructions.afterCa" : "cli.setup.instructions.https")
      : allowInsecureHttpLan
        ? t(locale, "cli.setup.instructions.insecureHttpLan")
        : t(locale, "cli.setup.instructions.localOnlyHttp"),
  ]);
  printCliSection(locale, "cli.section.pairingLinks", [
    t(locale, "cli.setup.pairingUrlLocal", { url: `${publicBaseUrl}${pairPath}` }),
    t(locale, "cli.setup.pairingUrlIp", { url: `${fallbackBaseUrl}${pairPath}` }),
  ]);
  if (canShowCaDownload && !shouldPromptCaTrust && !cliOptions.pair) {
    printCliSection(locale, "cli.section.caDownload", [
      t(locale, "cli.setup.caDownloadLocal", { url: caDownloadLocalUrl }),
      t(locale, "cli.setup.caDownloadIp", { url: caDownloadIpUrl }),
    ]);
  }
  console.log("");
  console.log(t(locale, "cli.section.qrPairing"));
  await printQrCode(`${publicBaseUrl}${pairPath}`);
  if (canShowCaDownload && !shouldPromptCaTrust && !cliOptions.pair) {
    console.log("");
    console.log(t(locale, "cli.section.qrCaDownload"));
    await printQrCode(caDownloadIpUrl);
  }

  await maybeRunLegacySetupFeatureAliases(cliOptions, { envFile, locale, sessionSecret, port });
}

async function runPair(cliOptions) {
  const setup = await loadExistingSetup(cliOptions);
  const progress = createCliProgressReporter(setup.locale);
  progress.update("cli.start.progress.refreshPairing");
  await refreshPairingCredentials(setup.envFile, setup.config, { force: true });
  progress.clear();
  await runStart(cliOptions);
  const nextConfig = await ensureDefaultLocalePersisted(setup.envFile, cliOptions);
  printCliTitle(setup.locale, "cli.pair.done");
  printCliSection(setup.locale, "cli.section.ready", [
    t(setup.locale, "cli.setup.primaryUrl", { url: String(nextConfig.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "").trim() || "(not configured)" }),
    t(setup.locale, "cli.setup.pairingCode", { code: String(nextConfig.PAIRING_CODE || "").trim() || "(missing)" }),
  ]);
  printCliSection(setup.locale, "cli.section.next", [
    t(setup.locale, "cli.setup.pairRefresh.copy"),
    t(setup.locale, "cli.setup.pairRefresh.reminder"),
  ]);
  await printPairingInfo(setup.locale, nextConfig, { sectioned: true });
  const pairToken = String(nextConfig.PAIRING_TOKEN || "").trim();
  if (pairToken && nextConfig.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL) {
    console.log("");
    console.log(t(setup.locale, "cli.section.qrPairing"));
    await printQrCode(
      `${String(nextConfig.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "").trim()}/app?pairToken=${encodeURIComponent(pairToken)}`
    );
  }
}

async function runEnable(cliOptions) {
  const target = String(cliOptions.enableTarget || "").trim().toLowerCase();
  if (!target) {
    throw new Error("Usage: viveworker enable <claude|a2a|moltbook|scout|mcp> [...]");
  }

  switch (target) {
    case "claude":
      await runEnableClaude(cliOptions);
      return;
    case "a2a": {
      const { runA2ACli } = await import("./a2a-cli.mjs");
      await runA2ACli(["setup", ...(cliOptions.enableArgs || [])]);
      return;
    }
    case "moltbook":
      await runEnableMoltbook(cliOptions);
      return;
    case "scout":
      await runEnableScout(cliOptions);
      return;
    case "mcp":
      await runEnableMcp(cliOptions);
      return;
    default:
      throw new Error(`Unknown feature: ${target}`);
  }
}

async function runEnableMcp(cliOptions) {
  const target = normalizeMcpInstallTarget(cliOptions.mcpTarget || "all");
  const allTargets = target === "all" ? ["claude", "cursor", "codex"] : [target];
  const entries = [];
  const config = mcpServerConfigSnippet();

  for (const item of allTargets) {
    const entry = await prepareMcpConfigChange(item, config, { explicit: target !== "all" });
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) {
    console.log("");
    console.log("No supported MCP client config was found.");
    console.log("Run `npx viveworker mcp config` to print a manual config snippet.");
    return;
  }

  console.log("");
  console.log("viveworker MCP setup");
  console.log("");
  console.log("The following MCP client config changes will be applied:");
  for (const entry of entries) {
    console.log(`- ${entry.label}: ${entry.status} ${entry.path}`);
  }
  console.log("");
  console.log("MCP server entry:");
  console.log(JSON.stringify({ mcpServers: { viveworker: config } }, null, 2));

  if (cliOptions.mcpDryRun) {
    console.log("");
    console.log("Dry run only. No files were changed.");
    return;
  }

  const changedEntries = entries.filter((entry) => entry.changed);
  if (changedEntries.length === 0) {
    console.log("");
    console.log("MCP config is already up to date.");
    return;
  }

  if (!cliOptions.yes) {
    const confirmed = await confirmCli("Write these MCP config changes? [y/N] ");
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  for (const entry of changedEntries) {
    await fs.mkdir(path.dirname(entry.path), { recursive: true });
    await fs.writeFile(entry.path, entry.nextText, entry.mode || "utf8");
  }

  console.log("");
  console.log("MCP config updated.");
  console.log("Restart the target app so it reloads the MCP server list.");
}

function normalizeMcpInstallTarget(value) {
  const target = String(value || "all").trim().toLowerCase();
  if (["claude", "cursor", "codex", "all"].includes(target)) {
    return target;
  }
  throw new Error("Use --target claude, --target cursor, --target codex, or --target all.");
}

function mcpServerConfigSnippet() {
  return {
    command: "npx",
    args: ["viveworker", "mcp"],
  };
}

async function prepareMcpConfigChange(target, serverConfig, { explicit = false } = {}) {
  const descriptor = mcpConfigDescriptor(target);
  if (!descriptor) {
    return null;
  }
  if (!explicit && !(await fileExists(descriptor.parentDir))) {
    return null;
  }
  const currentText = await readOptionalText(descriptor.path);
  const result = descriptor.kind === "toml"
    ? upsertCodexMcpConfig(currentText, serverConfig)
    : upsertJsonMcpConfig(currentText, serverConfig);
  return {
    target,
    label: descriptor.label,
    path: descriptor.path,
    status: result.changed
      ? (currentText.trim() ? "update" : "create")
      : "unchanged",
    changed: result.changed,
    nextText: result.text,
  };
}

function mcpConfigDescriptor(target) {
  if (target === "claude") {
    const override = process.env.VIVEWORKER_MCP_CLAUDE_CONFIG_FILE || "";
    const defaultPath = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    const configPath = resolvePath(override || defaultPath);
    return {
      kind: "json",
      label: "Claude Desktop",
      path: configPath,
      parentDir: path.dirname(configPath),
    };
  }
  if (target === "cursor") {
    const override = process.env.VIVEWORKER_MCP_CURSOR_CONFIG_FILE || "";
    const defaultPath = path.join(os.homedir(), ".cursor", "mcp.json");
    const configPath = resolvePath(override || defaultPath);
    return {
      kind: "json",
      label: "Cursor",
      path: configPath,
      parentDir: path.dirname(configPath),
    };
  }
  if (target === "codex") {
    const override = process.env.VIVEWORKER_MCP_CODEX_CONFIG_FILE || "";
    const defaultPath = path.join(os.homedir(), ".codex", "config.toml");
    const configPath = resolvePath(override || defaultPath);
    return {
      kind: "toml",
      label: "Codex",
      path: configPath,
      parentDir: path.dirname(configPath),
    };
  }
  return null;
}

function upsertJsonMcpConfig(currentText, serverConfig) {
  let data = {};
  if (currentText.trim()) {
    try {
      data = JSON.parse(currentText);
    } catch (error) {
      throw new Error(`Unable to parse existing MCP JSON config: ${error.message}`);
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    data = {};
  }
  const previous = JSON.stringify(data);
  const mcpServers = data.mcpServers && typeof data.mcpServers === "object" && !Array.isArray(data.mcpServers)
    ? data.mcpServers
    : {};
  data.mcpServers = {
    ...mcpServers,
    viveworker: serverConfig,
  };
  const text = `${JSON.stringify(data, null, 2)}\n`;
  return {
    changed: JSON.stringify(data) !== previous,
    text,
  };
}

function upsertCodexMcpConfig(currentText, serverConfig) {
  const block = [
    "[mcp_servers.viveworker]",
    `command = ${tomlString(serverConfig.command)}`,
    `args = [${serverConfig.args.map((arg) => tomlString(arg)).join(", ")}]`,
    "",
  ].join("\n");
  const withoutExisting = removeTomlTable(currentText, "mcp_servers.viveworker").replace(/\s+$/u, "");
  const text = `${withoutExisting ? `${withoutExisting}\n\n` : ""}${block}`;
  return {
    changed: normalizeConfigText(text) !== normalizeConfigText(currentText),
    text,
  };
}

function removeTomlTable(text, tableName) {
  const lines = String(text || "").split(/\r?\n/u);
  const out = [];
  let skipping = false;
  const header = `[${tableName}]`;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === header) {
      skipping = true;
      continue;
    }
    if (skipping && /^\[[^\]]+\]\s*$/u.test(trimmed)) {
      skipping = false;
    }
    if (!skipping) {
      out.push(line);
    }
  }
  return out.join("\n");
}

function tomlString(value) {
  return JSON.stringify(String(value || ""));
}

function normalizeConfigText(value) {
  return String(value || "").replace(/\r\n/gu, "\n").trim();
}

async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function confirmCli(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Refusing to write MCP config without an interactive terminal. Re-run with --yes or --dry-run.");
  }
  const rl = createReadlineInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(prompt);
    return /^y(es)?$/iu.test(String(answer || "").trim());
  } finally {
    rl.close();
  }
}

async function runEnableClaude(cliOptions) {
  const setup = await loadExistingSetup(cliOptions);
  const settingsFile = resolvePath(
    cliOptions.claudeSettingsFile || path.join(os.homedir(), ".claude", "settings.json")
  );
  if (!cliOptions.claudeSettingsFile && !(await fileExists(path.dirname(settingsFile)))) {
    throw new Error("Claude Desktop settings were not found. Install Claude Desktop first or pass --settings-file.");
  }
  if (!setup.config.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is missing. Run `npx viveworker doctor --fix` or `npx viveworker setup` first.");
  }
  const settingsPath = await installClaudeHooks({
    envFile: setup.envFile,
    claudeSettingsFile: cliOptions.claudeSettingsFile,
    sessionSecret: setup.config.SESSION_SECRET,
    suppressOutput: true,
  });
  printCliTitle(setup.locale, "cli.enable.claude.title");
  printCliSection(setup.locale, "cli.section.changed", [
    t(setup.locale, "cli.enable.claude.changed", { path: settingsPath }),
  ]);
  printCliSection(setup.locale, "cli.section.next", [
    t(setup.locale, "cli.enable.claude.next"),
  ]);
}

async function runEnableMoltbook(cliOptions) {
  const setup = await loadExistingSetup(cliOptions);
  if (!setup.config.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is missing. Run `npx viveworker doctor --fix` or `npx viveworker setup` first.");
  }
  const watcherResult = await installMoltbookWatcher({
    cliOptions,
    sessionSecret: setup.config.SESSION_SECRET,
    port: Number(setup.config.NATIVE_APPROVAL_SERVER_PORT) || defaultServerPort,
    suppressOutput: true,
  });
  let scoutResult = null;
  if (!cliOptions.noScout) {
    scoutResult = await installMoltbookScout({ cliOptions, suppressOutput: true });
  }
  printCliTitle(setup.locale, "cli.enable.moltbook.title");
  printCliSection(setup.locale, "cli.section.changed", [
    t(setup.locale, "cli.enable.moltbook.watcher", { path: watcherResult.plistPath }),
    t(setup.locale, "cli.enable.moltbook.env", { path: watcherResult.moltbookEnvFile }),
    scoutResult ? t(setup.locale, "cli.enable.moltbook.scout", { interval: scoutResult.interval }) : t(setup.locale, "cli.enable.moltbook.watcherOnly"),
  ]);
  printCliSection(setup.locale, "cli.section.needsAttention", [
    watcherResult.warning || "",
    scoutResult?.warning || "",
    scoutResult?.manualNote || "",
    scoutResult && !scoutResult.hasPersona ? t(setup.locale, "cli.enable.moltbook.personaTip") : "",
  ]);
  printCliSection(setup.locale, "cli.section.next", [
    t(setup.locale, "cli.enable.moltbook.next"),
  ]);
}

async function runEnableScout(cliOptions) {
  const setup = await loadExistingSetup(cliOptions);
  if (cliOptions.autoScoutUninstall) {
    const uninstallResult = await uninstallMoltbookScout({ suppressOutput: true });
    printCliTitle(setup.locale, "cli.enable.scout.removed");
    printCliSection(setup.locale, "cli.section.changed", [uninstallResult.message]);
    return;
  }
  const scoutResult = await installMoltbookScout({ cliOptions, suppressOutput: true });
  printCliTitle(setup.locale, "cli.enable.scout.title");
  printCliSection(setup.locale, "cli.section.changed", [
    t(setup.locale, "cli.enable.scout.installed", { interval: scoutResult.interval }),
    scoutResult.harness.kind === "manual"
      ? t(setup.locale, "cli.enable.scout.manualHarness")
      : t(setup.locale, "cli.enable.scout.harness", { path: scoutResult.harness.bin }),
  ]);
  printCliSection(setup.locale, "cli.section.needsAttention", [
    scoutResult.warning || "",
    scoutResult.manualNote || "",
    !scoutResult.hasPersona ? t(setup.locale, "cli.enable.moltbook.personaTip") : "",
  ]);
  printCliSection(setup.locale, "cli.section.next", [
    t(setup.locale, "cli.enable.scout.next"),
  ]);
}

async function detectScoutHarness(preferred) {
  const { spawn } = await import("node:child_process");
  const which = (cmd) =>
    new Promise((resolve) => {
      const p = spawn("command", ["-v", cmd], { shell: "/bin/bash", stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d.toString()));
      p.on("exit", (code) => resolve(code === 0 ? out.trim() : ""));
      p.on("error", () => resolve(""));
    });
  if (preferred === "codex") return { kind: "codex", bin: (await which("codex")) || "codex" };
  if (preferred === "claude") return { kind: "claude", bin: (await which("claude")) || "claude" };
  if (preferred === "manual") return { kind: "manual", bin: "" };
  const codex = await which("codex");
  if (codex) return { kind: "codex", bin: codex };
  const claude = await which("claude");
  if (claude) return { kind: "claude", bin: claude };
  return { kind: "manual", bin: "" };
}

async function uninstallMoltbookScout({ suppressOutput = false } = {}) {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${"com.viveworker.moltbook-scout"}.plist`);
  const { spawn } = await import("node:child_process");
  await new Promise((resolve) => {
    const p = spawn("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { stdio: "ignore" });
    p.on("exit", () => resolve());
    p.on("error", () => resolve());
  });
  try {
    await fs.unlink(plistPath);
    const message = `Moltbook auto-scout removed: ${plistPath}`;
    if (!suppressOutput) {
      console.log("");
      console.log(message);
    }
    return { removed: true, plistPath, message };
  } catch {
    const message = `No auto-scout plist was installed at ${plistPath}.`;
    if (!suppressOutput) {
      console.log("");
      console.log(message);
    }
    return { removed: false, plistPath, message };
  }
}

async function installMoltbookScout({ cliOptions, suppressOutput = false }) {
  const moltbookEnvFile = path.join(os.homedir(), ".viveworker", "moltbook.env");
  try {
    await fs.access(moltbookEnvFile);
  } catch {
    throw new Error(
      `${moltbookEnvFile} not found. Run --moltbook --moltbook-api-key ... --moltbook-agent-id ... first.`
    );
  }
  const harness = await detectScoutHarness(cliOptions.autoScoutHarness || "auto");
  const interval = Number(cliOptions.autoScoutInterval) || 120;
  const scoutRunScript = path.join(packageRoot, "scripts", "moltbook-scout-run.sh");
  const viveworkerJs = path.join(packageRoot, "scripts", "viveworker.mjs");
  const submoltsFlag = cliOptions.autoScoutSubmolts
    ? ` --submolts ${cliOptions.autoScoutSubmolts}`
    : "";
  const maxDailyFlag = cliOptions.autoScoutMaxDaily
    ? ` --max-daily ${cliOptions.autoScoutMaxDaily}`
    : "";

  const personaPath = path.join(os.homedir(), ".viveworker", "moltbook-persona.md");
  let hasPersona = false;
  try {
    const personaText = await fs.readFile(personaPath, "utf8");
    hasPersona = Boolean(personaText.trim());
  } catch {
    // no persona file
  }

  // Ensure node (and harness CLI) is on PATH inside launchd's minimal env.
  const nodeBinDir = path.dirname(process.execPath);
  const pathPrefix = `export PATH="${nodeBinDir}:$PATH"`;
  const autoScript = path.join(packageRoot, "scripts", "moltbook-scout-auto.sh");

  let inner;
  if (harness.kind === "manual") {
    // Manual fallback: just run scout and log the candidate. No drafting.
    inner =
      `${pathPrefix}; set -a; . "${moltbookEnvFile}"; set +a; cd "${packageRoot}" && ` +
      `"${scoutRunScript}"${submoltsFlag}${maxDailyFlag} || true`;
  } else {
    // Use the auto script which runs scout (no LLM), then drafts via harness, then proposes.
    const envVars = [
      `SCOUT_HARNESS=${harness.kind}`,
      submoltsFlag ? `SCOUT_FLAGS="${submoltsFlag.trim()}${maxDailyFlag}"` : maxDailyFlag ? `SCOUT_FLAGS="${maxDailyFlag.trim()}"` : "",
    ].filter(Boolean).join(" ");
    inner =
      `${pathPrefix}; set -a; . "${moltbookEnvFile}"; set +a; ${envVars ? envVars + " " : ""}` +
      `"${autoScript}"`;
  }

  const userShell = process.env.SHELL || "/bin/zsh";
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${"com.viveworker.moltbook-scout"}.plist`);
  const plistBody = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${"com.viveworker.moltbook-scout"}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(userShell)}</string>
    <string>-lc</string>
    <string>${escapeXml(inner)}</string>
  </array>
  <key>StartInterval</key><integer>${interval}</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>/tmp/viveworker-moltbook-scout.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/viveworker-moltbook-scout.err.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
  await fs.mkdir(path.dirname(plistPath), { recursive: true });
  await fs.writeFile(plistPath, plistBody, "utf8");

  const { spawn } = await import("node:child_process");
  await new Promise((resolve) => {
    const p = spawn("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { stdio: "ignore" });
    p.on("exit", () => resolve());
    p.on("error", () => resolve());
  });
  let warning = "";
  try {
    await new Promise((resolve, reject) => {
      const p = spawn("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath], { stdio: "ignore" });
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`launchctl bootstrap exited ${code}`))));
      p.on("error", reject);
    });
  } catch (error) {
    warning = `Moltbook scout plist was written, but launchctl bootstrap failed: ${error.message}. Run manually: launchctl bootstrap gui/$(id -u) ${plistPath}`;
  }
  const manualNote = harness.kind === "manual"
    ? `Neither 'codex' nor 'claude' CLI was found. The scheduled task will only run scout and print candidates to the log. Install Codex CLI (npm i -g @openai/codex) or Claude Code CLI to enable automated drafting.`
    : "";
  const result = {
    plistPath,
    interval,
    harness,
    hasPersona,
    personaPath,
    warning,
    manualNote,
    logsPath: "/tmp/viveworker-moltbook-scout.{out,err}.log",
  };
  if (!suppressOutput) {
    console.log("");
    console.log(`Moltbook auto-scout installed (${harness.kind}).`);
    console.log(`  plist:    ${plistPath}`);
    console.log(`  interval: ${interval}s`);
    if (manualNote) {
      console.log(`  note:     ${manualNote}`);
    } else {
      console.log(`  harness:  ${harness.bin}`);
    }
    console.log(`  logs:     ${result.logsPath}`);
    if (!hasPersona) {
      console.log(`  tip:      No persona file found. Run 'npx viveworker moltbook persona init' to describe your agent — draft quality improves a lot.`);
    } else {
      console.log(`  persona:  ${personaPath}`);
    }
    if (warning) {
      console.log(`  warning:  ${warning}`);
    }
  }
  return result;
}

async function installMoltbookWatcher({ cliOptions, sessionSecret, port, suppressOutput = false }) {
  if (!cliOptions.moltbookApiKey || !cliOptions.moltbookAgentId) {
    throw new Error(
      "--moltbook requires --moltbook-api-key and --moltbook-agent-id"
    );
  }
  const moltbookDir = path.join(os.homedir(), ".viveworker");
  const moltbookEnvFile = path.join(moltbookDir, "moltbook.env");
  await fs.mkdir(moltbookDir, { recursive: true });
  const envLines = [
    `MOLTBOOK_API_KEY=${cliOptions.moltbookApiKey}`,
    `MOLTBOOK_AGENT_ID=${cliOptions.moltbookAgentId}`,
    cliOptions.moltbookAgentName ? `MOLTBOOK_AGENT_NAME=${cliOptions.moltbookAgentName}` : "",
    `VIVEWORKER_HOOK_SECRET=${sessionSecret}`,
    `VIVEWORKER_BASE_URL=https://127.0.0.1:${port}`,
    "",
  ].filter((line) => line !== null);
  await fs.writeFile(moltbookEnvFile, envLines.join("\n"), { mode: 0o600 });
  await fs.chmod(moltbookEnvFile, 0o600);

  const plistLabel = "com.viveworker.moltbook-watcher";
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${plistLabel}.plist`);
  const watcherScript = path.join(packageRoot, "scripts", "moltbook-watcher.mjs");
  const nodePath = process.execPath;
  const watcherShell = process.env.SHELL || "/bin/zsh";
  const watcherNodeDir = path.dirname(nodePath);
  const plistBody = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${plistLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(watcherShell)}</string>
    <string>-lc</string>
    <string>export PATH="${watcherNodeDir}:$PATH"; set -a; . "${moltbookEnvFile}"; set +a; exec "${nodePath}" "${watcherScript}"</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/><key>Crashed</key><true/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>/tmp/viveworker-moltbook-watcher.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/viveworker-moltbook-watcher.err.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
  await fs.mkdir(path.dirname(plistPath), { recursive: true });
  await fs.writeFile(plistPath, plistBody, "utf8");

  // Reload the agent if launchctl is available
  let warning = "";
  try {
    const { spawn } = await import("node:child_process");
    await new Promise((resolve) => {
      const unload = spawn("launchctl", ["unload", plistPath], { stdio: "ignore" });
      unload.on("exit", () => resolve());
      unload.on("error", () => resolve());
    });
    await new Promise((resolve, reject) => {
      const load = spawn("launchctl", ["load", plistPath], { stdio: "ignore" });
      load.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`launchctl load exited ${code}`))));
      load.on("error", reject);
    });
  } catch (error) {
    warning = `Moltbook watcher plist was written, but launchctl load failed: ${error.message}. Run manually: launchctl load ${plistPath}`;
  }
  const result = {
    moltbookEnvFile,
    plistPath,
    logsPath: "/tmp/viveworker-moltbook-watcher.{out,err}.log",
    warning,
  };
  if (!suppressOutput) {
    console.log("");
    console.log(`Moltbook watcher installed.`);
    console.log(`  env:  ${moltbookEnvFile}`);
    console.log(`  plist: ${plistPath}`);
    console.log(`  logs: ${result.logsPath}`);
    if (warning) {
      console.log(`  warning: ${warning}`);
    }
  }
  return result;
}

async function installClaudeHooks({ envFile, claudeSettingsFile, sessionSecret, suppressOutput = false }) {
  const hookScript = path.join(packageRoot, "scripts", "viveworker-claude-hook.mjs");
  const nodePath = process.execPath;
  const settingsFile = resolvePath(
    claudeSettingsFile || path.join(os.homedir(), ".claude", "settings.json")
  );

  const hookCommand = `'${nodePath}' '${hookScript}' --env-file '${envFile}'`;

  let settings = {};
  try {
    const raw = await fs.readFile(settingsFile, "utf8");
    settings = JSON.parse(raw);
  } catch {
    // File missing or invalid — start fresh
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  const hookEntry = (timeout) => ({
    hooks: [{ type: "command", command: hookCommand, timeout }],
  });

  const fileToolMatcher = "Write|Edit|MultiEdit";
  const approvalMatcher = "Bash|WebFetch|WebSearch|Write|Edit|MultiEdit";
  const interactiveMatcher = "ExitPlanMode|AskUserQuestion";

  settings.hooks.UserPromptSubmit = [hookEntry(15)];
  settings.hooks.Notification = [hookEntry(15)];
  settings.hooks.Stop = [hookEntry(15)];
  settings.hooks.PermissionRequest = [{ ...hookEntry(900), matcher: approvalMatcher }];
  settings.hooks.PreToolUse = [
    { ...hookEntry(30), matcher: fileToolMatcher },
    { ...hookEntry(900), matcher: interactiveMatcher },
  ];
  settings.hooks.PostToolUse = [
    { ...hookEntry(30), matcher: `Read|${approvalMatcher}|${interactiveMatcher}` },
  ];
  settings.hooks.PostToolUseFailure = [
    { ...hookEntry(15), matcher: `${approvalMatcher}|${interactiveMatcher}` },
  ];
  settings.hooks.SessionEnd = [hookEntry(15)];

  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8");

  if (!suppressOutput) {
    console.log("");
    console.log(`Claude hooks installed: ${settingsFile}`);
  }

  return settingsFile;
}

async function runStart(cliOptions) {
  const configDir = resolvePath(cliOptions.configDir || defaultConfigDir);
  const envFile = resolvePath(cliOptions.envFile || path.join(configDir, "config.env"));
  const initialLocale = await resolveCliLocale(cliOptions);
  const progress = createCliProgressReporter(initialLocale);
  progress.update("cli.start.progress.prepare");
  let config = await ensureDefaultLocalePersisted(envFile, cliOptions);
  const locale = await resolveCliLocale(cliOptions, config);
  progress.setLocale(locale);
  const rotatedPairing = await maybeRotateStartupPairing(envFile, config);
  if (rotatedPairing.rotated) {
    progress.update("cli.start.progress.refreshPairing");
    config = {
      ...config,
      PAIRING_CODE: rotatedPairing.pairingCode,
      PAIRING_TOKEN: rotatedPairing.pairingToken,
      PAIRING_EXPIRES_AT_MS: String(rotatedPairing.pairingExpiresAtMs),
    };
  }
  const pidFile = resolvePath(cliOptions.pidFile || path.join(configDir, "viveworker.pid"));
  const launchAgentPath = resolvePath(cliOptions.launchAgentPath || defaultLaunchAgentPath);
  const healthUrl = buildLoopbackHealthUrl(config.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "");
  if (await fileExists(launchAgentPath)) {
    progress.update("cli.start.progress.launchd");
    await execCommand(["launchctl", "bootstrap", `gui/${process.getuid()}`, launchAgentPath], { ignoreError: true });
    progress.update("cli.start.progress.kickstart");
    await execCommand(["launchctl", "kickstart", "-k", `gui/${process.getuid()}/${defaultLabel}`]);
    progress.update("cli.start.progress.health");
    const healthy = await waitForHealth(healthUrl);
    const pairingReady = healthy && rotatedPairing.rotated
      ? await waitForExpectedPairing(config.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "", rotatedPairing.pairingToken)
      : true;
    progress.done(healthy && pairingReady ? "cli.start.launchdStarted" : "cli.start.launchdStartedPending");
    printCliTitle(locale, "cli.start.title");
    printCliSection(locale, "cli.section.ready", [
      t(locale, "cli.status.baseUrl", { value: config.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "(not configured)" }),
      t(locale, "cli.start.readyLaunchd"),
      t(locale, "cli.status.health", { value: t(locale, healthy ? "cli.status.ok" : "cli.status.failed") }),
    ]);
    printCliSection(locale, "cli.section.needsAttention", [
      healthy && !pairingReady
        ? t(locale, "cli.setup.warning.stalePairingServer", { port: config.NATIVE_APPROVAL_SERVER_PORT || defaultServerPort })
        : "",
    ]);
    printCliSection(locale, "cli.section.next", [
      rotatedPairing.rotated ? t(locale, "cli.start.nextPairing") : "",
    ]);
    if (rotatedPairing.rotated) {
      await printPairingInfo(locale, config, { sectioned: true });
    }
    return;
  }

  progress.update("cli.start.progress.bridge");
  const alreadyHealthy = await waitForHealth(healthUrl, { attempts: 1, intervalMs: 0 });
  if (!alreadyHealthy) {
    await startDetachedBridge({
      envFile,
      logFile: resolvePath(cliOptions.logFile || defaultLogFile),
      pidFile,
    });
  }
  progress.update("cli.start.progress.health");
  const healthy = alreadyHealthy || await waitForHealth(healthUrl);
  const pairingReady = healthy && rotatedPairing.rotated
    ? await waitForExpectedPairing(config.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "", rotatedPairing.pairingToken)
    : true;
  progress.done(healthy && pairingReady ? "cli.start.bridgeStarted" : "cli.start.bridgeStartedPending");
  printCliTitle(locale, "cli.start.title");
  printCliSection(locale, "cli.section.ready", [
    t(locale, "cli.status.baseUrl", { value: config.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "(not configured)" }),
    t(locale, "cli.start.readyBridge"),
    t(locale, "cli.status.health", { value: t(locale, healthy ? "cli.status.ok" : "cli.status.failed") }),
  ]);
  printCliSection(locale, "cli.section.needsAttention", [
    healthy && !pairingReady
      ? t(locale, "cli.setup.warning.stalePairingServer", { port: config.NATIVE_APPROVAL_SERVER_PORT || defaultServerPort })
      : "",
  ]);
  printCliSection(locale, "cli.section.next", [
    rotatedPairing.rotated ? t(locale, "cli.start.nextPairing") : "",
  ]);
  if (rotatedPairing.rotated) {
    await printPairingInfo(locale, config, { sectioned: true });
  }
}

async function runStop(cliOptions) {
  const configDir = resolvePath(cliOptions.configDir || defaultConfigDir);
  const launchAgentPath = resolvePath(cliOptions.launchAgentPath || defaultLaunchAgentPath);
  const pidFile = resolvePath(cliOptions.pidFile || path.join(configDir, "viveworker.pid"));
  const locale = await resolveCliLocale(cliOptions);
  if (await fileExists(launchAgentPath)) {
    await execCommand(["launchctl", "bootout", `gui/${process.getuid()}`, launchAgentPath], { ignoreError: true });
    printCliTitle(locale, "cli.stop.title");
    printCliSection(locale, "cli.section.changed", [
      t(locale, "cli.stop.changedLaunchd"),
    ]);
    return;
  }

  const pid = await maybeReadPid(pidFile);
  if (!pid) {
    printCliTitle(locale, "cli.stop.alreadyStopped");
    printCliSection(locale, "cli.section.ready", [
      t(locale, "cli.stop.noProcess"),
    ]);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
  await fs.rm(pidFile, { force: true });
  printCliTitle(locale, "cli.stop.title");
  printCliSection(locale, "cli.section.changed", [
    t(locale, "cli.stop.changedPid", { pid }),
  ]);
}

async function runStatus(cliOptions) {
  const configDir = resolvePath(cliOptions.configDir || defaultConfigDir);
  const envFile = resolvePath(cliOptions.envFile || path.join(configDir, "config.env"));
  const config = await ensureDefaultLocalePersisted(envFile, cliOptions);
  const baseUrl = config.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "";
  const healthUrl = baseUrl ? `${baseUrl}/health` : "";
  const launchAgentPath = resolvePath(cliOptions.launchAgentPath || defaultLaunchAgentPath);
  const pidFile = resolvePath(cliOptions.pidFile || path.join(configDir, "viveworker.pid"));
  const webPushEnabled = truthyString(config.WEB_PUSH_ENABLED);
  const httpsEnabled = isHttpsUrl(baseUrl);
  const locale = await resolveCliLocale(cliOptions, config);

  const readyLines = [
    t(locale, "cli.status.envFile", { value: envFile }),
    t(locale, "cli.status.baseUrl", { value: baseUrl || "(not configured)" }),
    t(locale, "cli.status.webPush", { value: t(locale, webPushEnabled ? "cli.status.enabled" : "cli.status.disabled") }),
    t(locale, "cli.status.https", { value: t(locale, httpsEnabled ? "cli.status.enabled" : "cli.status.disabled") }),
  ];
  if (webPushEnabled) {
    readyLines.push(t(locale, "cli.status.tlsCert", { value: config.TLS_CERT_FILE || "(missing)" }));
    readyLines.push(t(locale, "cli.status.tlsKey", { value: config.TLS_KEY_FILE || "(missing)" }));
  }
  readyLines.push(
    t(locale, "cli.status.launchAgent", {
      value: (await fileExists(launchAgentPath)) ? launchAgentPath : "(not installed)",
    })
  );

  if (await fileExists(launchAgentPath)) {
    const printed = await execCommand(
      ["launchctl", "print", `gui/${process.getuid()}/${defaultLabel}`],
      { ignoreError: true }
    );
    readyLines.push(
      t(locale, "cli.status.launchd", {
        value: t(locale, printed.ok ? "cli.status.installed" : "cli.status.notRunning"),
      })
    );
  } else {
    const pid = await maybeReadPid(pidFile);
    readyLines.push(t(locale, "cli.status.pid", { value: pid || "(not running)" }));
  }

  let healthOutput = "";
  if (healthUrl) {
    const health = await execCommand(buildHealthCheckArgs(healthUrl), { ignoreError: true });
    readyLines.push(t(locale, "cli.status.health", { value: t(locale, health.ok ? "cli.status.ok" : "cli.status.failed") }));
    healthOutput = health.stdout.trim();
  }
  printCliTitle(locale, "cli.status.title");
  printCliSection(locale, "cli.section.ready", readyLines);
  printCliSection(locale, "cli.section.details", summarizeHealthOutput(healthOutput));
}

async function runDoctor(cliOptions) {
  const configDir = resolvePath(cliOptions.configDir || defaultConfigDir);
  const envFile = resolvePath(cliOptions.envFile || path.join(configDir, "config.env"));
  const config = await ensureDefaultLocalePersisted(envFile, cliOptions);
  const issues = [];
  const baseUrl = config.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "";
  const healthUrl = baseUrl ? `${baseUrl}/health` : "";
  const webPushEnabled = truthyString(config.WEB_PUSH_ENABLED);
  const allowInsecureHttpLan = truthyString(config.ALLOW_INSECURE_LAN_HTTP);
  const hostname = config.VIVEWORKER_HOSTNAME || os.hostname();
  const localHostname = hostname.endsWith(".local") ? hostname : `${hostname}.local`;
  const ips = await findLocalIpv4Addresses();
  const chosenIp = ips[0] || "127.0.0.1";
  const locale = await resolveCliLocale(cliOptions, config);

  if (!(await fileExists(envFile))) {
    issues.push(t(locale, "cli.doctor.issue.envMissing"));
  }
  if (!config.SESSION_SECRET) {
    issues.push(t(locale, "cli.doctor.issue.sessionSecretMissing"));
  }
  if (!config.PAIRING_CODE || !config.PAIRING_TOKEN) {
    issues.push(t(locale, "cli.doctor.issue.pairingMissing"));
  }
  if (!baseUrl) {
    issues.push(t(locale, "cli.doctor.issue.baseUrlMissing"));
  }
  if (baseUrl && !isHttpsUrl(baseUrl) && !isLoopbackBaseUrl(baseUrl) && !allowInsecureHttpLan) {
    issues.push(t(locale, "cli.doctor.issue.lanHttpRequiresOverride"));
  }
  if (webPushEnabled) {
    if (!isHttpsUrl(baseUrl)) {
      issues.push(t(locale, "cli.doctor.issue.webPushHttps"));
    }
    if (!config.TLS_CERT_FILE || !(await fileExists(resolvePath(config.TLS_CERT_FILE)))) {
      issues.push(t(locale, "cli.doctor.issue.tlsCertMissing"));
    }
    if (!config.TLS_KEY_FILE || !(await fileExists(resolvePath(config.TLS_KEY_FILE)))) {
      issues.push(t(locale, "cli.doctor.issue.tlsKeyMissing"));
    }
    if (!config.WEB_PUSH_VAPID_PUBLIC_KEY) {
      issues.push(t(locale, "cli.doctor.issue.vapidPublicMissing"));
    }
    if (!config.WEB_PUSH_VAPID_PRIVATE_KEY) {
      issues.push(t(locale, "cli.doctor.issue.vapidPrivateMissing"));
    }

    if (config.TLS_CERT_FILE && await fileExists(resolvePath(config.TLS_CERT_FILE))) {
      const certificateIssues = await checkCertificateHosts({
        certFile: resolvePath(config.TLS_CERT_FILE),
        expectedHosts: collectTlsHosts({
          hostname,
          localHostname,
          chosenIp,
        }),
      });
      issues.push(...certificateIssues);
    }
  }
  if (healthUrl) {
    const health = await execCommand(buildHealthCheckArgs(healthUrl), { ignoreError: true });
    if (!health.ok) {
      issues.push(t(locale, webPushEnabled ? "cli.doctor.issue.healthHttps" : "cli.doctor.issue.health"));
    }
  }

  if (issues.length === 0) {
    printCliTitle(locale, "cli.doctor.ok");
    printCliSection(locale, "cli.section.ready", [
      t(locale, "cli.status.baseUrl", { value: baseUrl || "(not configured)" }),
      healthUrl ? t(locale, "cli.status.health", { value: t(locale, "cli.status.ok") }) : "",
    ]);
    return;
  }

  printCliTitle(locale, "cli.doctor.titleIssues");
  printCliSection(locale, "cli.section.needsAttention", issues);

  if (!cliOptions.doctorFix) {
    printCliSection(locale, "cli.section.next", [
      t(locale, "cli.doctor.nextFix"),
    ]);
    return;
  }

  if (!(await fileExists(envFile))) {
    throw new Error("No viveworker config was found. Run `npx viveworker setup` first.");
  }

  console.log("");
  console.log(t(locale, "cli.doctor.fixing"));
  const appliedChanges = await repairDoctorIssues(cliOptions, { envFile, config, locale, hostname, localHostname, chosenIp, webPushEnabled, allowInsecureHttpLan });
  printCliTitle(locale, "cli.doctor.titleFix");
  printCliSection(locale, "cli.section.changed", appliedChanges);
  printCliSection(locale, "cli.section.next", [
    t(locale, "cli.doctor.nextRestarting"),
  ]);
  console.log(t(locale, "cli.doctor.fixed"));
  await runStart(cliOptions);
}

async function runUpdate(cliOptions) {
  const locale = await resolveCliLocale(cliOptions);
  const progress = createCliProgressReporter(locale);

  // 1. Check current vs latest version
  progress.update("cli.update.progress.checkVersion");
  const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  const currentVersion = pkg.version;
  const { stdout: latestRaw } = await execCommand(["npm", "view", "viveworker", "version"], { ignoreError: true });
  const latestVersion = (latestRaw || "").trim();

  if (!latestVersion) {
    progress.done("cli.update.checkFailed");
    return;
  }

  if (currentVersion === latestVersion) {
    progress.done("cli.update.alreadyLatest", { version: currentVersion });
    return;
  }

  console.log(t(locale, "cli.update.versionInfo", { current: currentVersion, latest: latestVersion }));

  // 2. Clear npx cache and re-fetch
  progress.update("cli.update.progress.install");
  const npxCacheResult = await execCommand(["npx", "--yes", "viveworker@latest", "--version"], { ignoreError: true });
  if (!npxCacheResult.ok) {
    // Fallback: try global install
    await execCommand(["npm", "install", "-g", "viveworker@latest"], { ignoreError: true });
  }

  // 3. Restart bridge
  const launchAgentPath = resolvePath(cliOptions.launchAgentPath || defaultLaunchAgentPath);
  let restartedBridge = false;
  if (await fileExists(launchAgentPath)) {
    progress.update("cli.update.progress.restartBridge");
    await execCommand(["launchctl", "bootout", `gui/${process.getuid()}`, launchAgentPath], { ignoreError: true });
    await execCommand(["launchctl", "bootstrap", `gui/${process.getuid()}`, launchAgentPath], { ignoreError: true });
    await execCommand(["launchctl", "kickstart", "-k", `gui/${process.getuid()}/${defaultLabel}`], { ignoreError: true });
    restartedBridge = true;
  }

  // 4. Restart moltbook-watcher if present
  const watcherLabel = "com.viveworker.moltbook-watcher";
  const watcherPlistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${watcherLabel}.plist`);
  let restartedWatcher = false;
  if (await fileExists(watcherPlistPath)) {
    progress.update("cli.update.progress.restartWatcher");
    await execCommand(["launchctl", "bootout", `gui/${process.getuid()}`, watcherPlistPath], { ignoreError: true });
    await execCommand(["launchctl", "bootstrap", `gui/${process.getuid()}`, watcherPlistPath], { ignoreError: true });
    restartedWatcher = true;
  }

  // 5. Restart moltbook-scout if present
  const scoutLabel = "com.viveworker.moltbook-scout";
  const scoutPlistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${scoutLabel}.plist`);
  let restartedScout = false;
  if (await fileExists(scoutPlistPath)) {
    progress.update("cli.update.progress.restartScout");
    await execCommand(["launchctl", "bootout", `gui/${process.getuid()}`, scoutPlistPath], { ignoreError: true });
    await execCommand(["launchctl", "bootstrap", `gui/${process.getuid()}`, scoutPlistPath], { ignoreError: true });
    restartedScout = true;
  }

  progress.done("cli.update.done", { version: latestVersion });
  printCliTitle(locale, "cli.update.title");
  printCliSection(locale, "cli.section.changed", [
    t(locale, "cli.update.changedVersion", { current: currentVersion, latest: latestVersion }),
    restartedBridge ? t(locale, "cli.update.changedBridge") : "",
    restartedWatcher ? t(locale, "cli.update.changedWatcher") : "",
    restartedScout ? t(locale, "cli.update.changedScout") : "",
  ]);
  printCliSection(locale, "cli.section.next", [
    t(locale, "cli.update.next"),
  ]);
}

async function loadExistingSetup(cliOptions) {
  const configDir = resolvePath(cliOptions.configDir || defaultConfigDir);
  const envFile = resolvePath(cliOptions.envFile || path.join(configDir, "config.env"));
  const logFile = resolvePath(cliOptions.logFile || path.join(configDir, "logs", "viveworker.log"));
  const pidFile = resolvePath(cliOptions.pidFile || path.join(configDir, "viveworker.pid"));
  const launchAgentPath = resolvePath(cliOptions.launchAgentPath || defaultLaunchAgentPath);
  const locale = await resolveCliLocale(cliOptions);
  if (!(await fileExists(envFile))) {
    throw new Error("No viveworker config was found. Run `npx viveworker setup` first.");
  }
  const config = await ensureDefaultLocalePersisted(envFile, cliOptions);
  return { configDir, envFile, logFile, pidFile, launchAgentPath, locale, config };
}

async function refreshPairingCredentials(envFile, config = {}, { force = false } = {}) {
  const now = Date.now();
  const rotated = shouldRotatePairing({
    force,
    pairingCode: config.PAIRING_CODE,
    pairingToken: config.PAIRING_TOKEN,
    pairingExpiresAtMs: config.PAIRING_EXPIRES_AT_MS,
  }, now);

  if (!rotated) {
    return { rotated: false };
  }

  const nextPairing = generatePairingCredentials(now);
  const currentText = (await fileExists(envFile)) ? await fs.readFile(envFile, "utf8") : "";
  const nextText = upsertEnvText(currentText, {
    PAIRING_CODE: nextPairing.pairingCode,
    PAIRING_TOKEN: nextPairing.pairingToken,
    PAIRING_EXPIRES_AT_MS: String(nextPairing.pairingExpiresAtMs),
  });
  await fs.mkdir(path.dirname(envFile), { recursive: true });
  await fs.writeFile(envFile, nextText, "utf8");

  return {
    rotated: true,
    ...nextPairing,
  };
}

async function maybeRunLegacySetupFeatureAliases(cliOptions, { envFile, locale, sessionSecret, port }) {
  const legacyActions = [];
  if (cliOptions.moltbook) {
    legacyActions.push("moltbook");
  }
  if (cliOptions.autoScout || cliOptions.autoScoutUninstall) {
    legacyActions.push("scout");
  }

  if (legacyActions.length === 0) {
    return;
  }

  console.log("");
  console.log(t(locale, "cli.setup.legacyFeatureFlags", {
    commands: legacyActions.map((action) => `viveworker enable ${action}`).join(", "),
  }));

  if (cliOptions.moltbook) {
    try {
      await installMoltbookWatcher({ cliOptions, sessionSecret, port });
    } catch (error) {
      console.log("");
      console.log(`Moltbook watcher install failed: ${error.message}`);
    }
  }

  if (cliOptions.autoScoutUninstall) {
    await uninstallMoltbookScout();
  } else if (cliOptions.autoScout) {
    try {
      await installMoltbookScout({ cliOptions });
    } catch (error) {
      console.log("");
      console.log(`Moltbook auto-scout install failed: ${error.message}`);
    }
  }
}

async function repairDoctorIssues(cliOptions, { envFile, config, locale, hostname, localHostname, chosenIp, webPushEnabled, allowInsecureHttpLan }) {
  const updates = {};
  const changed = [];

  if (!config.SESSION_SECRET) {
    updates.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
    changed.push(t(locale, "cli.doctor.fixed.sessionSecret"));
  }
  if (!config.PAIRING_CODE || !config.PAIRING_TOKEN) {
    const nextPairing = generatePairingCredentials();
    updates.PAIRING_CODE = nextPairing.pairingCode;
    updates.PAIRING_TOKEN = nextPairing.pairingToken;
    updates.PAIRING_EXPIRES_AT_MS = String(nextPairing.pairingExpiresAtMs);
    changed.push(t(locale, "cli.doctor.fixed.pairing"));
  }
  if (!config.DEFAULT_LOCALE) {
    updates.DEFAULT_LOCALE = locale;
    changed.push(t(locale, "cli.doctor.fixed.locale"));
  }
  if (!config.NATIVE_APPROVAL_SERVER_HOST) {
    updates.NATIVE_APPROVAL_SERVER_HOST = webPushEnabled || allowInsecureHttpLan ? "0.0.0.0" : "127.0.0.1";
    changed.push(t(locale, "cli.doctor.fixed.host"));
  }
  if (!config.NATIVE_APPROVAL_SERVER_PORT) {
    updates.NATIVE_APPROVAL_SERVER_PORT = String(defaultServerPort);
    changed.push(t(locale, "cli.doctor.fixed.port"));
  }
  if (!config.VIVEWORKER_HOSTNAME) {
    updates.VIVEWORKER_HOSTNAME = hostname;
    changed.push(t(locale, "cli.doctor.fixed.hostname"));
  }
  if (!config.DEVICE_TRUST_TTL_MS) {
    updates.DEVICE_TRUST_TTL_MS = String(30 * 24 * 60 * 60 * 1000);
    changed.push(t(locale, "cli.doctor.fixed.deviceTrust"));
  }
  if (!config.WEB_UI_ENABLED) {
    updates.WEB_UI_ENABLED = "1";
    changed.push(t(locale, "cli.doctor.fixed.webUi"));
  }
  if (!config.AUTH_REQUIRED) {
    updates.AUTH_REQUIRED = "1";
    changed.push(t(locale, "cli.doctor.fixed.auth"));
  }
  if (!config.CHOICE_PAGE_SIZE) {
    updates.CHOICE_PAGE_SIZE = "5";
    changed.push(t(locale, "cli.doctor.fixed.choicePageSize"));
  }
  if (!config.MAX_HISTORY_ITEMS) {
    updates.MAX_HISTORY_ITEMS = "100";
    changed.push(t(locale, "cli.doctor.fixed.maxHistory"));
  }
  if (!config.NATIVE_APPROVALS) {
    updates.NATIVE_APPROVALS = "1";
    changed.push(t(locale, "cli.doctor.fixed.nativeApprovals"));
  }

  const nextPort = Number(updates.NATIVE_APPROVAL_SERVER_PORT || config.NATIVE_APPROVAL_SERVER_PORT) || defaultServerPort;
  const nextHostname = updates.VIVEWORKER_HOSTNAME || config.VIVEWORKER_HOSTNAME || hostname;
  if (!config.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL) {
    const scheme = webPushEnabled ? "https" : "http";
    const publicHost = webPushEnabled || allowInsecureHttpLan
      ? (nextHostname.endsWith(".local") ? nextHostname : `${nextHostname}.local`)
      : "127.0.0.1";
    updates.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL = `${scheme}://${publicHost}:${nextPort}`;
    changed.push(t(locale, "cli.doctor.fixed.baseUrl"));
  }

  const nextConfig = { ...config, ...updates };
  if (webPushEnabled) {
    const tlsCertFile = resolvePath(
      nextConfig.TLS_CERT_FILE || path.join(path.dirname(envFile), "tls", "cert.pem")
    );
    const tlsKeyFile = resolvePath(
      nextConfig.TLS_KEY_FILE || path.join(path.dirname(envFile), "tls", "key.pem")
    );
    const progress = createCliProgressReporter(locale);
    const tlsAssets = await ensureWebPushAssets({
      cliOptions,
      existing: nextConfig,
      hostname: nextHostname,
      localHostname: nextHostname.endsWith(".local") ? nextHostname : `${nextHostname}.local`,
      locale,
      progress,
      chosenIp,
      tlsCertFile,
      tlsKeyFile,
    });
    progress.clear();
    updates.TLS_CERT_FILE = tlsAssets.certFile;
    updates.TLS_KEY_FILE = tlsAssets.keyFile;
    updates.WEB_PUSH_VAPID_PUBLIC_KEY = tlsAssets.vapidPublicKey;
    updates.WEB_PUSH_VAPID_PRIVATE_KEY = tlsAssets.vapidPrivateKey;
    changed.push(t(locale, "cli.doctor.fixed.webPushAssets"));
    if (!nextConfig.WEB_PUSH_SUBJECT) {
      updates.WEB_PUSH_SUBJECT = "mailto:viveworker@example.com";
      changed.push(t(locale, "cli.doctor.fixed.webPushSubject"));
    }
  }

  const currentText = (await fileExists(envFile)) ? await fs.readFile(envFile, "utf8") : "";
  const nextText = upsertEnvText(currentText, updates);
  await fs.writeFile(envFile, nextText, "utf8");
  return changed;
}

function parseArgs(argv) {
  const parsed = {
    command: "help",
    enableTarget: "",
    enableArgs: [],
    enableNtfy: false,
    enableWebPush: false,
    disableWebPush: false,
    noAutoMkcert: false,
    noAutoClaude: false,
    noScout: false,
    allowInsecureHttpLan: false,
    installMkcert: false,
    noLaunchd: false,
    pair: false,
    port: null,
    hostname: "",
    envFile: "",
    configDir: "",
    stateFile: "",
    logFile: "",
    pidFile: "",
    launchAgentPath: "",
    pairCode: "",
    pairToken: "",
    sessionSecret: "",
    tlsCertFile: "",
    tlsKeyFile: "",
    webPushSubject: "",
    vapidPublicKey: "",
    vapidPrivateKey: "",
    locale: "",
    mkcertTrustStores: "",
    claudeSettingsFile: "",
    doctorFix: false,
    moltbook: false,
    moltbookApiKey: "",
    moltbookAgentId: "",
    moltbookAgentName: "",
    autoScout: false,
    autoScoutUninstall: false,
    autoScoutInterval: 120,
    autoScoutHarness: "auto",
    autoScoutSubmolts: "",
    autoScoutMaxDaily: 0,
    mcpTarget: "",
    mcpDryRun: false,
    yes: false,
  };

  if (argv[0] && !argv[0].startsWith("-")) {
    parsed.command = argv[0];
    argv = argv.slice(1);
  }

  if (parsed.command === "enable" && argv[0] && !argv[0].startsWith("-")) {
    parsed.enableTarget = argv[0];
    argv = argv.slice(1);
    if (parsed.enableTarget === "a2a") {
      parsed.enableArgs = argv.slice();
      return parsed;
    }
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1] ?? "";
    if (arg === "--enable-ntfy") {
      parsed.enableNtfy = true;
    } else if (arg === "--enable-web-push") {
      parsed.enableWebPush = true;
    } else if (arg === "--disable-web-push") {
      parsed.disableWebPush = true;
    } else if (arg === "--no-auto-mkcert") {
      parsed.noAutoMkcert = true;
    } else if (arg === "--no-auto-claude") {
      parsed.noAutoClaude = true;
    } else if (arg === "--no-scout") {
      parsed.noScout = true;
    } else if (arg === "--allow-insecure-http-lan") {
      parsed.allowInsecureHttpLan = true;
    } else if (arg === "--install-mkcert") {
      parsed.installMkcert = true;
    } else if (arg === "--mkcert-trust-stores") {
      parsed.mkcertTrustStores = next;
      index += 1;
    } else if (arg === "--no-launchd") {
      parsed.noLaunchd = true;
    } else if (arg === "--port") {
      parsed.port = Number(next) || null;
      index += 1;
    } else if (arg === "--hostname") {
      parsed.hostname = next;
      index += 1;
    } else if (arg === "--env-file") {
      parsed.envFile = next;
      index += 1;
    } else if (arg === "--config-dir") {
      parsed.configDir = next;
      index += 1;
    } else if (arg === "--state-file") {
      parsed.stateFile = next;
      index += 1;
    } else if (arg === "--log-file") {
      parsed.logFile = next;
      index += 1;
    } else if (arg === "--pid-file") {
      parsed.pidFile = next;
      index += 1;
    } else if (arg === "--launch-agent-path") {
      parsed.launchAgentPath = next;
      index += 1;
    } else if (arg === "--pair-code") {
      parsed.pairCode = next;
      index += 1;
    } else if (arg === "--pair-token") {
      parsed.pairToken = next;
      index += 1;
    } else if (arg === "--session-secret") {
      parsed.sessionSecret = next;
      index += 1;
    } else if (arg === "--tls-cert-file") {
      parsed.tlsCertFile = next;
      index += 1;
    } else if (arg === "--tls-key-file") {
      parsed.tlsKeyFile = next;
      index += 1;
    } else if (arg === "--web-push-subject") {
      parsed.webPushSubject = next;
      index += 1;
    } else if (arg === "--locale") {
      parsed.locale = next;
      index += 1;
    } else if (arg === "--fix") {
      parsed.doctorFix = true;
    } else if (arg === "--vapid-public-key") {
      parsed.vapidPublicKey = next;
      index += 1;
    } else if (arg === "--vapid-private-key") {
      parsed.vapidPrivateKey = next;
      index += 1;
    } else if (arg === "--pair") {
      parsed.pair = true;
    } else if (arg === "--settings-file") {
      parsed.claudeSettingsFile = next;
      index += 1;
    } else if (arg === "--claude-settings-file") {
      parsed.claudeSettingsFile = next;
      index += 1;
    } else if (arg === "--api-key") {
      parsed.moltbook = true;
      parsed.moltbookApiKey = next;
      index += 1;
    } else if (arg === "--agent-id") {
      parsed.moltbook = true;
      parsed.moltbookAgentId = next;
      index += 1;
    } else if (arg === "--agent-name") {
      parsed.moltbookAgentName = next;
      index += 1;
    } else if (arg === "--moltbook") {
      parsed.moltbook = true;
    } else if (arg === "--moltbook-api-key") {
      parsed.moltbook = true;
      parsed.moltbookApiKey = next;
      index += 1;
    } else if (arg === "--moltbook-agent-id") {
      parsed.moltbook = true;
      parsed.moltbookAgentId = next;
      index += 1;
    } else if (arg === "--moltbook-agent-name") {
      parsed.moltbookAgentName = next;
      index += 1;
    } else if (arg === "--auto-scout") {
      parsed.autoScout = true;
    } else if (arg === "--uninstall") {
      parsed.autoScoutUninstall = true;
    } else if (arg === "--interval") {
      parsed.autoScoutInterval = Number(next) || 120;
      index += 1;
    } else if (arg === "--harness") {
      parsed.autoScoutHarness = next;
      index += 1;
    } else if (arg === "--submolts") {
      parsed.autoScoutSubmolts = next;
      index += 1;
    } else if (arg === "--max-daily") {
      parsed.autoScoutMaxDaily = Number(next) || 0;
      index += 1;
    } else if (arg === "--auto-scout-uninstall") {
      parsed.autoScoutUninstall = true;
    } else if (arg === "--auto-scout-interval") {
      parsed.autoScoutInterval = Number(next) || 120;
      index += 1;
    } else if (arg === "--auto-scout-harness") {
      parsed.autoScoutHarness = next;
      index += 1;
    } else if (arg === "--auto-scout-submolts") {
      parsed.autoScoutSubmolts = next;
      index += 1;
    } else if (arg === "--auto-scout-max-daily") {
      parsed.autoScoutMaxDaily = Number(next) || 0;
      index += 1;
    } else if (arg === "--target") {
      parsed.mcpTarget = next;
      index += 1;
    } else if (arg === "--dry-run") {
      parsed.mcpDryRun = true;
    } else if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.command = "help";
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (parsed.enableWebPush && parsed.disableWebPush) {
    throw new Error("Use either --enable-web-push or --disable-web-push, not both.");
  }

  return parsed;
}

function printHelp() {
  const locale = normalizeLocale(process.env.DEFAULT_LOCALE || process.env.LANG || "") || DEFAULT_LOCALE;
  console.log(`${t(locale, "cli.help.usage")}

${t(locale, "cli.help.commands")}
  ${t(locale, "cli.help.setup")}
  ${t(locale, "cli.help.pair")}
  ${t(locale, "cli.help.enable")}
  ${t(locale, "cli.help.start")}
  ${t(locale, "cli.help.stop")}
  ${t(locale, "cli.help.status")}
  ${t(locale, "cli.help.doctor")}
  ${t(locale, "cli.help.update")}
  mcp           Start the stdio MCP server
  mcp config    Print MCP client config snippets

${t(locale, "cli.help.commonOptions")}
  --port <n>
  --hostname <name>
  --env-file <path>
  --config-dir <path>
  --disable-web-push
  --enable-web-push
  --no-auto-mkcert
  --no-auto-claude
  --allow-insecure-http-lan
  --install-mkcert
  --mkcert-trust-stores <system[,java][,nss]>
  --tls-cert-file <path>
  --tls-key-file <path>
  --web-push-subject <mailto:...>
  --locale <en|ja>
  --vapid-public-key <key>
  --vapid-private-key <key>
  --enable-ntfy
  --no-launchd
  --pair

${t(locale, "cli.help.featureOptions")}
  ${t(locale, "cli.help.enableClaude")}
  ${t(locale, "cli.help.enableA2a")}
  ${t(locale, "cli.help.enableMoltbook")}
  ${t(locale, "cli.help.enableScout")}
  enable mcp --target <claude|cursor|codex|all> [--dry-run|--yes]
  ${t(locale, "cli.help.doctorFix")}
`);
}

async function resolveCliLocale(cliOptions, existingConfig = null) {
  const explicit = normalizeLocale(cliOptions?.locale || "");
  if (explicit) {
    return explicit;
  }
  const persisted = normalizeLocale(existingConfig?.DEFAULT_LOCALE || "");
  if (persisted) {
    return persisted;
  }
  const detected = await detectSystemLocale();
  return detected || DEFAULT_LOCALE;
}

async function resolveSetupLocale(cliOptions, existingConfig = null) {
  const explicit = normalizeLocale(cliOptions?.locale || "");
  if (explicit) {
    return explicit;
  }
  const persisted = normalizeLocale(existingConfig?.DEFAULT_LOCALE || "");
  if (persisted) {
    return persisted;
  }
  return (await detectSystemLocale()) || DEFAULT_LOCALE;
}

async function detectSystemLocale() {
  const detected = await detectMacSystemLocale();
  if (detected) {
    return detected;
  }
  return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG || "");
}

async function detectMacSystemLocale() {
  if (process.platform !== "darwin") {
    return "";
  }
  const result = await execCommand(["defaults", "read", "-g", "AppleLanguages"], { ignoreError: true });
  if (!result.ok) {
    return "";
  }
  const normalized = normalizeLocale(extractFirstLocale(result.stdout));
  return normalized || "";
}

function extractFirstLocale(rawValue) {
  const text = String(rawValue || "");
  const quoted = text.match(/"([A-Za-z_-]+)"/u);
  if (quoted?.[1]) {
    return quoted[1];
  }
  const bare = text.match(/\b([A-Za-z]{2}(?:[-_][A-Za-z]{2})?)\b/u);
  return bare?.[1] || "";
}

function buildLaunchAgentPlist({ label, nodePath, bridgeScript, envFile, logFile }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(nodePath)}</string>
      <string>${escapeXml(bridgeScript)}</string>
      <string>--env-file</string>
      <string>${escapeXml(envFile)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logFile)}</string>
  </dict>
</plist>
`;
}

async function startDetachedBridge({ envFile, logFile, pidFile }) {
  const existingPid = await maybeReadPid(pidFile);
  if (existingPid && isProcessRunning(existingPid)) {
    return { pid: existingPid, alreadyRunning: true };
  }

  await fs.mkdir(path.dirname(logFile), { recursive: true });
  const logHandle = await fs.open(logFile, "a");
  const child = spawn(process.execPath, [bridgeScript, "--env-file", envFile], {
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  });
  child.unref();
  await logHandle.close();
  await fs.writeFile(pidFile, `${child.pid}\n`, "utf8");
  return { pid: child.pid, alreadyRunning: false };
}

async function maybeReadPid(pidFile) {
  try {
    const raw = await fs.readFile(pidFile, "utf8");
    const pid = Number(raw.trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function maybeReadEnvFile(filePath) {
  const output = {};
  try {
    const raw = await fs.readFile(filePath, "utf8");
    for (const rawLine of raw.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const separator = line.indexOf("=");
      if (separator === -1) {
        continue;
      }
      output[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  } catch {
    return output;
  }
  return output;
}

async function ensureDefaultLocalePersisted(envFile, cliOptions = {}, existingConfig = null) {
  const config = existingConfig || (await maybeReadEnvFile(envFile));
  if (normalizeLocale(config.DEFAULT_LOCALE)) {
    return config;
  }
  if (!(await fileExists(envFile))) {
    return config;
  }
  const locale = await resolveCliLocale(cliOptions, config);
  await fs.appendFile(envFile, `DEFAULT_LOCALE=${locale}\n`, "utf8");
  return {
    ...config,
    DEFAULT_LOCALE: locale,
  };
}

async function maybeRotateStartupPairing(envFile, config = {}) {
  const now = Date.now();
  const rotated = shouldRotatePairing({
    pairingCode: config.PAIRING_CODE,
    pairingToken: config.PAIRING_TOKEN,
    pairingExpiresAtMs: config.PAIRING_EXPIRES_AT_MS,
  }, now);

  if (!rotated) {
    return { rotated: false };
  }

  const nextPairing = generatePairingCredentials(now);
  const currentText = (await fileExists(envFile)) ? await fs.readFile(envFile, "utf8") : "";
  const nextText = upsertEnvText(currentText, {
    PAIRING_CODE: nextPairing.pairingCode,
    PAIRING_TOKEN: nextPairing.pairingToken,
    PAIRING_EXPIRES_AT_MS: String(nextPairing.pairingExpiresAtMs),
  });
  await fs.mkdir(path.dirname(envFile), { recursive: true });
  await fs.writeFile(envFile, nextText, "utf8");

  return {
    rotated: true,
    ...nextPairing,
  };
}

async function autoConfigureProvidersDuringSetup({ cliOptions, envFile, sessionSecret, codexHome }) {
  const codex = await detectCodexAvailability(codexHome);
  const explicitClaudeSettingsFile = cliOptions.claudeSettingsFile
    ? resolvePath(cliOptions.claudeSettingsFile)
    : "";
  const defaultClaudeSettingsFile = resolvePath(path.join(os.homedir(), ".claude", "settings.json"));
  const claudeSettingsFile = explicitClaudeSettingsFile || defaultClaudeSettingsFile;

  if (!explicitClaudeSettingsFile && cliOptions.noAutoClaude) {
    return {
      codex,
      claude: {
        status: "skipped",
        settingsFile: "",
        message: "",
      },
    };
  }

  const claudeDetected = explicitClaudeSettingsFile
    ? true
    : await detectClaudeAvailability(defaultClaudeSettingsFile);

  if (!claudeDetected) {
    return {
      codex,
      claude: {
        status: "not_detected",
        settingsFile: "",
        message: "",
      },
    };
  }

  try {
    const installedPath = await installClaudeHooks({
      envFile,
      claudeSettingsFile,
      sessionSecret,
      suppressOutput: true,
    });
    return {
      codex,
      claude: {
        status: "enabled",
        settingsFile: installedPath,
        message: "",
      },
    };
  } catch (error) {
    return {
      codex,
      claude: {
        status: "failed",
        settingsFile: claudeSettingsFile,
        message: error?.message || String(error),
      },
    };
  }
}

async function detectCodexAvailability(codexHome) {
  const candidates = Array.from(new Set([
    resolvePath(codexHome || path.join(os.homedir(), ".codex")),
    "/Applications/Codex.app",
    path.join(os.homedir(), "Applications", "Codex.app"),
  ]));
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return {
        detected: true,
        path: candidate,
      };
    }
  }
  return {
    detected: false,
    path: "",
  };
}

async function detectClaudeAvailability(settingsFile) {
  return (await fileExists(settingsFile)) || (await fileExists(path.dirname(settingsFile)));
}

function getSetupProviderSummaryLines(locale, providerSetup) {
  const lines = [
    t(locale, providerSetup.codex.detected
      ? "cli.setup.providers.codexReady"
      : "cli.setup.providers.codexNotDetected"),
  ];
  switch (providerSetup.claude.status) {
    case "enabled":
      lines.push(t(locale, "cli.setup.providers.claudeEnabled", {
        path: providerSetup.claude.settingsFile,
      }));
      break;
    case "skipped":
      lines.push(t(locale, "cli.setup.providers.claudeSkipped"));
      break;
    case "failed":
      lines.push(t(locale, "cli.setup.providers.claudeFailed", {
        message: providerSetup.claude.message,
      }));
      break;
    case "not_detected":
    default:
      lines.push(t(locale, "cli.setup.providers.claudeNotDetected"));
      break;
  }
  return lines;
}

async function findLocalIpv4Addresses() {
  const interfaces = os.networkInterfaces();
  const result = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry?.family === "IPv4" && !entry.internal && entry.address) {
        result.push(entry.address);
      }
    }
  }
  return Array.from(new Set(result));
}

async function execCommand(args, { ignoreError = false, env = null, streamOutput = false, beforeStreamOutput = null } = {}) {
  return new Promise((resolve, reject) => {
    let beforeStreamOutputCalled = false;
    const maybeBeforeStreamOutput = () => {
      if (!streamOutput || beforeStreamOutputCalled) {
        return;
      }
      beforeStreamOutputCalled = true;
      beforeStreamOutput?.();
    };
    const child = spawn(args[0], args.slice(1), {
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (streamOutput) {
        maybeBeforeStreamOutput();
        process.stdout.write(chunk);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (streamOutput) {
        maybeBeforeStreamOutput();
        process.stderr.write(chunk);
      }
    });
    child.on("error", (error) => {
      if (ignoreError) {
        resolve({ ok: false, stdout, stderr: `${stderr}${error.message}` });
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0 || ignoreError) {
        resolve({ ok: code === 0, stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || `${args[0]} exited with code ${code}`));
    });
  });
}

function resolveMkcertTrustStores(cliOptions = {}) {
  return String(cliOptions.mkcertTrustStores || process.env.MKCERT_TRUST_STORES || "system").trim() || "system";
}

function resolveSetupWebPushEnabled(cliOptions = {}) {
  if (cliOptions.disableWebPush) {
    return false;
  }
  return true;
}

function logSetupProgress(locale, key, vars = {}) {
  console.log(`• ${t(locale, key, vars)}`);
}

function createCliProgressReporter(initialLocale) {
  let locale = initialLocale;
  let lastWidth = 0;
  let active = false;
  let currentText = "";
  let spinnerIndex = 0;
  let spinnerTimer = null;
  const interactive = Boolean(process.stdout.isTTY);
  const spinnerFrames = ["|", "/", "-", "\\"];

  const stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  };

  const render = (prefix, text, newline = false) => {
    const padded = `${prefix} ${text}`.padEnd(lastWidth);
    process.stdout.write(`\r${padded}${newline ? "\n" : ""}`);
    lastWidth = newline ? 0 : Math.max(lastWidth, `${prefix} ${text}`.length);
    active = !newline;
  };

  const ensureSpinner = () => {
    if (!interactive || spinnerTimer || !currentText) {
      return;
    }
    spinnerTimer = setInterval(() => {
      spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
      render(spinnerFrames[spinnerIndex], currentText, false);
    }, 120);
    spinnerTimer.unref?.();
  };

  const writeLine = (prefix, key, vars = {}, newline = false) => {
    const text = `${prefix} ${t(locale, key, vars)}`;
    if (!interactive) {
      console.log(text);
      return;
    }
    stopSpinner();
    currentText = t(locale, key, vars);
    render(prefix, currentText, newline);
    if (!newline && prefix !== "✓") {
      ensureSpinner();
    } else if (newline) {
      currentText = "";
      spinnerIndex = 0;
    }
  };

  return {
    setLocale(nextLocale) {
      locale = nextLocale || locale;
    },
    update(key, vars = {}) {
      writeLine("•", key, vars, false);
    },
    done(key, vars = {}) {
      writeLine("✓", key, vars, true);
    },
    clear() {
      stopSpinner();
      if (!interactive || !active || lastWidth === 0) {
        return;
      }
      process.stdout.write(`\r${" ".repeat(lastWidth)}\r`);
      lastWidth = 0;
      active = false;
      currentText = "";
      spinnerIndex = 0;
    },
  };
}

function buildHealthCheckArgs(url) {
  const args = ["curl", "-sS", "--fail-with-body", "--connect-timeout", "3", "--max-time", "5"];
  if (isHttpsUrl(url)) {
    args.push("-k");
  }
  args.push(url);
  return args;
}

function buildLoopbackHealthUrl(baseUrl) {
  if (!baseUrl) {
    return "";
  }
  try {
    const url = new URL(baseUrl);
    url.hostname = "127.0.0.1";
    url.pathname = "/health";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function buildLoopbackUrl(baseUrl, pathname, searchParams = null) {
  if (!baseUrl) {
    return "";
  }
  try {
    const url = new URL(baseUrl);
    url.hostname = "127.0.0.1";
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    if (searchParams && Object.keys(searchParams).length > 0) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(searchParams)) {
        if (value == null || value === "") {
          continue;
        }
        params.set(key, String(value));
      }
      const serialized = params.toString();
      url.search = serialized ? `?${serialized}` : "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function printQrCode(url) {
  try {
    const module = await import("qrcode-terminal");
    const qrcode = module.default || module;
    console.log("");
    qrcode.generate(url, { small: true });
  } catch {
    console.log("");
    console.log("QR generation requires the optional qrcode-terminal dependency.");
  }
}

async function waitForEnter(locale, key) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }
  const rl = createReadlineInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    await rl.question(`\n${t(locale, key)} `);
  } finally {
    rl.close();
  }
}

async function startTemporaryCaDownloadServer({
  rootCaFile,
  preferredPort,
  localHostname,
  fallbackIp,
  pathName = "/ca/rootCA.pem",
}) {
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === pathName || url.pathname === "/downloads/rootCA.pem") {
      try {
        const body = await fs.readFile(rootCaFile, "utf8");
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/x-pem-file");
        res.setHeader("Content-Disposition", 'attachment; filename="rootCA.pem"');
        res.end(body);
        return;
      } catch {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("rootCA.pem not found");
        return;
      }
    }
    if (url.pathname === "/health") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end('{"ok":true}');
      return;
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found");
  });

  const actualPort = await listenTemporaryServer(server, preferredPort, "0.0.0.0");
  const localUrl = `http://${localHostname}:${actualPort}${pathName}`;
  const ipUrl = `http://${fallbackIp}:${actualPort}${pathName}`;
  return {
    port: actualPort,
    localUrl,
    ipUrl,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function listenTemporaryServer(server, preferredPort, host) {
  try {
    return await listenServerOnce(server, preferredPort, host);
  } catch (error) {
    if (error?.code === "EADDRINUSE" && preferredPort !== 0) {
      return await listenServerOnce(server, 0, host);
    }
    throw error;
  }
}

async function listenServerOnce(server, port, host) {
  return await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(Number(address?.port) || port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function waitForHealth(url, { attempts = 8, intervalMs = 500 } = {}) {
  if (!url) {
    return false;
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await execCommand(buildHealthCheckArgs(url), { ignoreError: true });
    if (result.ok) {
      return true;
    }
    if (attempt < attempts - 1) {
      await sleep(intervalMs);
    }
  }
  return false;
}

async function waitForExpectedPairing(baseUrl, pairToken, { attempts = 8, intervalMs = 500 } = {}) {
  const token = String(pairToken || "").trim();
  const manifestUrl = buildLoopbackUrl(baseUrl, "/manifest.webmanifest", { pairToken: token });
  const expectedStartUrl = `/app?pairToken=${encodeURIComponent(token)}`;
  if (!token || !manifestUrl) {
    return false;
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await execCommand(buildHealthCheckArgs(manifestUrl), { ignoreError: true });
    if (result.ok) {
      try {
        const payload = JSON.parse(result.stdout);
        if (String(payload?.start_url || "").trim() === expectedStartUrl) {
          return true;
        }
      } catch {
        // Keep retrying while the new bridge instance comes up.
      }
    }
    if (attempt < attempts - 1) {
      await sleep(intervalMs);
    }
  }

  return false;
}

function truthyString(value) {
  return /^(1|true|yes|on)$/iu.test(String(value || "").trim());
}

function isHttpsUrl(value) {
  return String(value || "").trim().toLowerCase().startsWith("https://");
}

function isLoopbackBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const hostname = url.hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
    return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
  } catch {
    return false;
  }
}

function collectTlsHosts({ hostname, localHostname, chosenIp }) {
  return Array.from(
    new Set(
      ["localhost", "127.0.0.1", hostname, localHostname, chosenIp]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

async function ensureWebPushAssets({
  cliOptions,
  existing,
  hostname,
  localHostname,
  locale,
  progress,
  chosenIp,
  tlsCertFile,
  tlsKeyFile,
}) {
  const mkcertTrustStores = resolveMkcertTrustStores(cliOptions);
  const manualCertOverride = Boolean(cliOptions.tlsCertFile || cliOptions.tlsKeyFile);
  const certExists = await fileExists(tlsCertFile);
  const keyExists = await fileExists(tlsKeyFile);
  if (certExists !== keyExists) {
    throw new Error("TLS_CERT_FILE and TLS_KEY_FILE must both exist.");
  }

  let ranMkcertInstall = false;

  if (!certExists) {
    if (manualCertOverride) {
      throw new Error("The provided TLS certificate or key file does not exist.");
    }

    let mkcertPath = await findExecutable("mkcert");
    if (!mkcertPath && !cliOptions.noAutoMkcert) {
      mkcertPath = await installMkcertForMac(progress, locale);
    }
    if (!mkcertPath) {
      throw new Error(
        [
          "Web Push requires HTTPS, but mkcert is not installed.",
          "Install mkcert and trust its local CA, or provide --tls-cert-file and --tls-key-file.",
          "You can also run: npx viveworker setup --install-mkcert",
          "Example: brew install mkcert && mkcert -install",
        ].join("\n")
      );
    }

    progress?.update("cli.setup.progress.installCa", { stores: mkcertTrustStores });
    await execCommand([mkcertPath, "-install"], {
      env: {
        TRUST_STORES: mkcertTrustStores,
      },
      streamOutput: true,
      beforeStreamOutput: () => progress?.clear(),
    });
    ranMkcertInstall = true;
    progress?.update("cli.setup.progress.generateCert");
    await fs.mkdir(path.dirname(tlsCertFile), { recursive: true });
    await execCommand([
      mkcertPath,
      "-cert-file",
      tlsCertFile,
      "-key-file",
      tlsKeyFile,
      ...collectTlsHosts({ hostname, localHostname, chosenIp }),
    ], {
      streamOutput: true,
      beforeStreamOutput: () => progress?.clear(),
    });
  } else {
    const mkcertPath = await findExecutable("mkcert");
    if (mkcertPath && cliOptions.installMkcert) {
      progress?.update("cli.setup.progress.installCa", { stores: mkcertTrustStores });
      await execCommand([mkcertPath, "-install"], {
        env: {
          TRUST_STORES: mkcertTrustStores,
        },
        streamOutput: true,
        beforeStreamOutput: () => progress?.clear(),
      });
      ranMkcertInstall = true;
    }
  }

  const vapidPublicKey =
    cliOptions.vapidPublicKey ||
    existing.WEB_PUSH_VAPID_PUBLIC_KEY ||
    "";
  const vapidPrivateKey =
    cliOptions.vapidPrivateKey ||
    existing.WEB_PUSH_VAPID_PRIVATE_KEY ||
    "";
  if (vapidPublicKey && vapidPrivateKey) {
    return {
      certFile: tlsCertFile,
      keyFile: tlsKeyFile,
      vapidPublicKey,
      vapidPrivateKey,
      ranMkcertInstall,
    };
  }

  progress?.update("cli.setup.progress.generateVapid");
  const generated = await generateVapidKeys();
  return {
    certFile: tlsCertFile,
    keyFile: tlsKeyFile,
    vapidPublicKey: generated.publicKey,
    vapidPrivateKey: generated.privateKey,
    ranMkcertInstall,
  };
}

async function generateVapidKeys() {
  const module = await import("web-push");
  const webPush = module.default || module;
  return webPush.generateVAPIDKeys();
}

async function findExecutable(name) {
  const result = await execCommand(["which", name], { ignoreError: true });
  if (!result.ok) {
    return "";
  }
  return result.stdout.trim();
}

async function installMkcertForMac(progress, locale) {
  const brewPath = await findExecutable("brew");
  if (!brewPath) {
    throw new Error(
      [
        "mkcert is not installed and Homebrew was not found.",
        "Install Homebrew first, or install mkcert manually, then rerun setup.",
      ].join("\n")
    );
  }

  progress?.update("cli.setup.progress.installMkcert");
  try {
    await execCommand([brewPath, "install", "mkcert"], {
      streamOutput: true,
      beforeStreamOutput: () => progress?.clear(),
    });
  } catch (error) {
    const rawMessage = String(error?.message || error || "");
    const permissionIssue =
      /not writable/iu.test(rawMessage) &&
      (/homebrew/iu.test(rawMessage) || /\/opt\/homebrew/iu.test(rawMessage) || /\/usr\/local/iu.test(rawMessage));
    throw new Error(
      [
        t(locale, permissionIssue ? "cli.setup.error.mkcertInstallPermission" : "cli.setup.error.mkcertInstallFailed"),
        t(locale, "cli.setup.error.mkcertInstallNext"),
        t(locale, "cli.setup.error.mkcertInstallExample"),
      ].join("\n")
    );
  }
  const mkcertPath = await findExecutable("mkcert");
  if (!mkcertPath) {
    throw new Error("mkcert installation finished, but the mkcert executable is still not available.");
  }
  return mkcertPath;
}

async function checkCertificateHosts({ certFile, expectedHosts }) {
  try {
    const raw = await fs.readFile(certFile, "utf8");
    const certificate = new crypto.X509Certificate(raw);
    const subjectAltName = String(certificate.subjectAltName || "");
    const available = new Set(
      subjectAltName
        .split(",")
        .map((part) => part.trim())
        .map((part) => part.replace(/^DNS:/u, "").replace(/^IP Address:/u, "").trim())
        .filter(Boolean)
    );
    return expectedHosts
      .filter((host) => !available.has(host))
      .map((host) => `TLS certificate is missing SAN entry for ${host}`);
  } catch (error) {
    return [`Unable to inspect TLS certificate: ${error.message || String(error)}`];
  }
}

function resolvePath(targetPath) {
  if (!targetPath) {
    return targetPath;
  }
  if (targetPath === "~") {
    return os.homedir();
  }
  if (targetPath.startsWith("~/")) {
    return path.join(os.homedir(), targetPath.slice(2));
  }
  if (path.isAbsolute(targetPath)) {
    return targetPath;
  }
  return path.resolve(process.cwd(), targetPath);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

async function printPairingInfo(locale, config, { sectioned = false } = {}) {
  const baseUrl = String(config.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "").trim();
  const pairCode = String(config.PAIRING_CODE || "").trim();
  const pairToken = String(config.PAIRING_TOKEN || "").trim();
  if (!baseUrl || !pairCode || !pairToken) {
    return;
  }

  const pairPath = `/app?pairToken=${encodeURIComponent(pairToken)}`;
  const ips = await findLocalIpv4Addresses();
  const fallbackBaseUrl = buildFallbackBaseUrl(baseUrl, ips[0] || "127.0.0.1");

  if (sectioned) {
    printCliSection(locale, "cli.section.pairingLinks", [
      t(locale, "cli.setup.pairingUrlLocal", { url: `${baseUrl}${pairPath}` }),
      t(locale, "cli.setup.pairingUrlIp", { url: `${fallbackBaseUrl}${pairPath}` }),
    ]);
    return;
  }

  console.log("");
  console.log(t(locale, "cli.setup.pairingCode", { code: pairCode }));
  console.log(t(locale, "cli.setup.pairingUrlLocal", { url: `${baseUrl}${pairPath}` }));
  console.log(t(locale, "cli.setup.pairingUrlIp", { url: `${fallbackBaseUrl}${pairPath}` }));
}

function buildFallbackBaseUrl(baseUrl, ipAddress) {
  try {
    const url = new URL(baseUrl);
    url.hostname = ipAddress;
    return url.toString().replace(/\/$/u, "");
  } catch {
    return baseUrl;
  }
}

function summarizeHealthOutput(rawValue) {
  const text = String(rawValue || "").trim();
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [text];
    }
    return Object.entries(parsed)
      .filter(([key]) => key !== "ok")
      .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  } catch {
    return [text];
  }
}

function printCliTitle(locale, key, vars = {}) {
  console.log("");
  console.log(t(locale, key, vars));
}

function printCliSection(locale, key, lines = [], vars = {}) {
  const filtered = (lines || []).filter((line) => String(line || "").trim());
  if (filtered.length === 0) {
    return;
  }
  console.log("");
  console.log(t(locale, key, vars));
  for (const line of filtered) {
    console.log(`- ${line}`);
  }
}
