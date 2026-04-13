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

  if (cliOptions.installMkcert && canShowCaDownload) {
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

  console.log("");
  if (cliOptions.pair) {
    console.log(t(locale, "cli.setup.pairRefresh.title"));
    console.log(t(locale, "cli.setup.pairRefresh.copy"));
    console.log(t(locale, "cli.setup.pairRefresh.reminder"));
    console.log("");
  }
  console.log(t(locale, "cli.setup.primaryUrl", { url: publicBaseUrl }));
  console.log(t(locale, "cli.setup.fallbackUrl", { url: fallbackBaseUrl }));
  console.log(t(locale, "cli.setup.pairingCode", { code: pairCode }));
  console.log(t(locale, "cli.setup.pairingUrlLocal", { url: `${publicBaseUrl}${pairPath}` }));
  console.log(t(locale, "cli.setup.pairingUrlIp", { url: `${fallbackBaseUrl}${pairPath}` }));
  console.log(t(locale, webPushEnabled ? "cli.setup.webPushEnabled" : "cli.setup.webPushDisabled"));
  if (allowInsecureHttpLan) {
    console.log(t(locale, "cli.setup.warning.insecureHttpLan"));
  }
  if (canShowCaDownload && !cliOptions.installMkcert && !cliOptions.pair) {
    console.log(t(locale, "cli.setup.caDownloadLocal", { url: caDownloadLocalUrl }));
    console.log(t(locale, "cli.setup.caDownloadIp", { url: caDownloadIpUrl }));
  }
  console.log("");
  if (webPushEnabled) {
    console.log(t(locale, cliOptions.installMkcert ? "cli.setup.instructions.afterCa" : "cli.setup.instructions.https"));
  } else if (allowInsecureHttpLan) {
    console.log(t(locale, "cli.setup.instructions.insecureHttpLan"));
  } else {
    console.log(t(locale, "cli.setup.instructions.localOnlyHttp"));
  }
  console.log("");
  console.log(t(locale, "cli.setup.qrPairing"));
  await printQrCode(`${publicBaseUrl}${pairPath}`);
  if (canShowCaDownload && !cliOptions.installMkcert && !cliOptions.pair) {
    console.log("");
    console.log(t(locale, "cli.setup.qrCaDownload"));
    await printQrCode(caDownloadIpUrl);
  }

  const claudeSettingsPath = resolvePath(
    cliOptions.claudeSettingsFile || path.join(os.homedir(), ".claude", "settings.json")
  );
  const claudeHomeExists = await fileExists(path.dirname(claudeSettingsPath));
  if (cliOptions.claudeSettingsFile || claudeHomeExists) {
    await installClaudeHooks({
      envFile,
      claudeSettingsFile: cliOptions.claudeSettingsFile,
      sessionSecret,
    });
  } else {
    console.log("");
    console.log(t(locale, "cli.setup.claudeHooksSkipped"));
  }

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

async function uninstallMoltbookScout() {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${"com.viveworker.moltbook-scout"}.plist`);
  const { spawn } = await import("node:child_process");
  await new Promise((resolve) => {
    const p = spawn("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { stdio: "ignore" });
    p.on("exit", () => resolve());
    p.on("error", () => resolve());
  });
  try {
    await fs.unlink(plistPath);
    console.log("");
    console.log(`Moltbook auto-scout uninstalled (removed ${plistPath}).`);
  } catch {
    console.log("");
    console.log(`No auto-scout plist found at ${plistPath}.`);
  }
}

async function installMoltbookScout({ cliOptions }) {
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
  try {
    await new Promise((resolve, reject) => {
      const p = spawn("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath], { stdio: "ignore" });
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`launchctl bootstrap exited ${code}`))));
      p.on("error", reject);
    });
  } catch (error) {
    console.log("");
    console.log(`Moltbook scout plist written but launchctl bootstrap failed: ${error.message}`);
    console.log(`Run manually: launchctl bootstrap gui/$(id -u) ${plistPath}`);
  }

  console.log("");
  console.log(`Moltbook auto-scout installed (${harness.kind}).`);
  console.log(`  plist:    ${plistPath}`);
  console.log(`  interval: ${interval}s`);
  if (harness.kind === "manual") {
    console.log(
      `  note:     Neither 'codex' nor 'claude' CLI was found. The scheduled task will only run scout and print candidates to the log. Install Codex CLI (npm i -g @openai/codex) or Claude Code CLI to enable automated drafting.`
    );
  } else {
    console.log(`  harness:  ${harness.bin}`);
  }
  console.log(`  logs:     /tmp/viveworker-moltbook-scout.{out,err}.log`);
  if (!hasPersona) {
    console.log(
      `  tip:      No persona file found. Run 'npx viveworker moltbook persona init' to describe your agent — draft quality improves a lot.`
    );
  } else {
    console.log(`  persona:  ${personaPath}`);
  }
}

async function installMoltbookWatcher({ cliOptions, sessionSecret, port }) {
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
    console.log("");
    console.log(`Moltbook watcher plist written but launchctl load failed: ${error.message}`);
    console.log(`Run manually: launchctl load ${plistPath}`);
    return;
  }

  console.log("");
  console.log(`Moltbook watcher installed.`);
  console.log(`  env:  ${moltbookEnvFile}`);
  console.log(`  plist: ${plistPath}`);
  console.log(`  logs: /tmp/viveworker-moltbook-watcher.{out,err}.log`);
}

async function installClaudeHooks({ envFile, claudeSettingsFile, sessionSecret }) {
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

  console.log("");
  console.log(`Claude hooks installed: ${settingsFile}`);
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
    if (healthy && !pairingReady) {
      console.log("");
      console.log(t(locale, "cli.setup.warning.stalePairingServer", { port: config.NATIVE_APPROVAL_SERVER_PORT || defaultServerPort }));
    }
    if (rotatedPairing.rotated) {
      await printPairingInfo(locale, config);
    }
    return;
  }

  progress.update("cli.start.progress.bridge");
  await startDetachedBridge({
    envFile,
    logFile: resolvePath(cliOptions.logFile || defaultLogFile),
    pidFile,
  });
  progress.update("cli.start.progress.health");
  const healthy = await waitForHealth(healthUrl);
  const pairingReady = healthy && rotatedPairing.rotated
    ? await waitForExpectedPairing(config.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "", rotatedPairing.pairingToken)
    : true;
  progress.done(healthy && pairingReady ? "cli.start.bridgeStarted" : "cli.start.bridgeStartedPending");
  if (healthy && !pairingReady) {
    console.log("");
    console.log(t(locale, "cli.setup.warning.stalePairingServer", { port: config.NATIVE_APPROVAL_SERVER_PORT || defaultServerPort }));
  }
  if (rotatedPairing.rotated) {
    await printPairingInfo(locale, config);
  }
}

async function runStop(cliOptions) {
  const configDir = resolvePath(cliOptions.configDir || defaultConfigDir);
  const launchAgentPath = resolvePath(cliOptions.launchAgentPath || defaultLaunchAgentPath);
  const pidFile = resolvePath(cliOptions.pidFile || path.join(configDir, "viveworker.pid"));
  if (await fileExists(launchAgentPath)) {
    await execCommand(["launchctl", "bootout", `gui/${process.getuid()}`, launchAgentPath], { ignoreError: true });
    console.log(t(await resolveCliLocale(cliOptions), "cli.stop.launchdStopped"));
    return;
  }

  const pid = await maybeReadPid(pidFile);
  if (!pid) {
    console.log(t(await resolveCliLocale(cliOptions), "cli.stop.noProcess"));
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
  console.log(t(await resolveCliLocale(cliOptions), "cli.stop.stopped", { pid }));
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

  console.log(t(locale, "cli.status.envFile", { value: envFile }));
  console.log(t(locale, "cli.status.baseUrl", { value: baseUrl || "(not configured)" }));
  console.log(t(locale, "cli.status.webPush", { value: t(locale, webPushEnabled ? "cli.status.enabled" : "cli.status.disabled") }));
  console.log(t(locale, "cli.status.https", { value: t(locale, httpsEnabled ? "cli.status.enabled" : "cli.status.disabled") }));
  if (webPushEnabled) {
    console.log(t(locale, "cli.status.tlsCert", { value: config.TLS_CERT_FILE || "(missing)" }));
    console.log(t(locale, "cli.status.tlsKey", { value: config.TLS_KEY_FILE || "(missing)" }));
  }
  console.log(
    t(locale, "cli.status.launchAgent", {
      value: (await fileExists(launchAgentPath)) ? launchAgentPath : "(not installed)",
    })
  );

  if (await fileExists(launchAgentPath)) {
    const printed = await execCommand(
      ["launchctl", "print", `gui/${process.getuid()}/${defaultLabel}`],
      { ignoreError: true }
    );
    console.log(
      t(locale, "cli.status.launchd", {
        value: t(locale, printed.ok ? "cli.status.installed" : "cli.status.notRunning"),
      })
    );
  } else {
    const pid = await maybeReadPid(pidFile);
    console.log(t(locale, "cli.status.pid", { value: pid || "(not running)" }));
  }

  if (healthUrl) {
    const health = await execCommand(buildHealthCheckArgs(healthUrl), { ignoreError: true });
    console.log(t(locale, "cli.status.health", { value: t(locale, health.ok ? "cli.status.ok" : "cli.status.failed") }));
    if (health.stdout) {
      console.log(health.stdout.trim());
    }
  }
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
    console.log(t(locale, "cli.doctor.ok"));
    return;
  }

  console.log(t(locale, "cli.doctor.foundIssues"));
  for (const issue of issues) {
    console.log(`- ${issue}`);
  }
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
  if (await fileExists(launchAgentPath)) {
    progress.update("cli.update.progress.restartBridge");
    await execCommand(["launchctl", "bootout", `gui/${process.getuid()}`, launchAgentPath], { ignoreError: true });
    await execCommand(["launchctl", "bootstrap", `gui/${process.getuid()}`, launchAgentPath], { ignoreError: true });
    await execCommand(["launchctl", "kickstart", "-k", `gui/${process.getuid()}/${defaultLabel}`], { ignoreError: true });
  }

  // 4. Restart moltbook-watcher if present
  const watcherLabel = "com.viveworker.moltbook-watcher";
  const watcherPlistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${watcherLabel}.plist`);
  if (await fileExists(watcherPlistPath)) {
    progress.update("cli.update.progress.restartWatcher");
    await execCommand(["launchctl", "bootout", `gui/${process.getuid()}`, watcherPlistPath], { ignoreError: true });
    await execCommand(["launchctl", "bootstrap", `gui/${process.getuid()}`, watcherPlistPath], { ignoreError: true });
  }

  // 5. Restart moltbook-scout if present
  const scoutLabel = "com.viveworker.moltbook-scout";
  const scoutPlistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${scoutLabel}.plist`);
  if (await fileExists(scoutPlistPath)) {
    progress.update("cli.update.progress.restartScout");
    await execCommand(["launchctl", "bootout", `gui/${process.getuid()}`, scoutPlistPath], { ignoreError: true });
    await execCommand(["launchctl", "bootstrap", `gui/${process.getuid()}`, scoutPlistPath], { ignoreError: true });
  }

  progress.done("cli.update.done", { version: latestVersion });
}

function parseArgs(argv) {
  const parsed = {
    command: "help",
    enableNtfy: false,
    enableWebPush: false,
    disableWebPush: false,
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
  };

  if (argv[0] && !argv[0].startsWith("-")) {
    parsed.command = argv[0];
    argv = argv.slice(1);
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
    } else if (arg === "--vapid-public-key") {
      parsed.vapidPublicKey = next;
      index += 1;
    } else if (arg === "--vapid-private-key") {
      parsed.vapidPrivateKey = next;
      index += 1;
    } else if (arg === "--pair") {
      parsed.pair = true;
    } else if (arg === "--claude-settings-file") {
      parsed.claudeSettingsFile = next;
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
  ${t(locale, "cli.help.start")}
  ${t(locale, "cli.help.stop")}
  ${t(locale, "cli.help.status")}
  ${t(locale, "cli.help.doctor")}
  ${t(locale, "cli.help.update")}

${t(locale, "cli.help.commonOptions")}
  --port <n>
  --hostname <name>
  --env-file <path>
  --config-dir <path>
  --disable-web-push
  --enable-web-push
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
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  const logHandle = await fs.open(logFile, "a");
  const child = spawn(process.execPath, [bridgeScript, "--env-file", envFile], {
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  });
  child.unref();
  await logHandle.close();
  await fs.writeFile(pidFile, `${child.pid}\n`, "utf8");
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

  if (!certExists) {
    if (manualCertOverride) {
      throw new Error("The provided TLS certificate or key file does not exist.");
    }

    let mkcertPath = await findExecutable("mkcert");
    if (!mkcertPath && cliOptions.installMkcert) {
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
    };
  }

  progress?.update("cli.setup.progress.generateVapid");
  const generated = await generateVapidKeys();
  return {
    certFile: tlsCertFile,
    keyFile: tlsKeyFile,
    vapidPublicKey: generated.publicKey,
    vapidPrivateKey: generated.privateKey,
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

async function printPairingInfo(locale, config) {
  const baseUrl = String(config.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "").trim();
  const pairCode = String(config.PAIRING_CODE || "").trim();
  const pairToken = String(config.PAIRING_TOKEN || "").trim();
  if (!baseUrl || !pairCode || !pairToken) {
    return;
  }

  const pairPath = `/app?pairToken=${encodeURIComponent(pairToken)}`;
  const ips = await findLocalIpv4Addresses();
  const fallbackBaseUrl = buildFallbackBaseUrl(baseUrl, ips[0] || "127.0.0.1");

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
