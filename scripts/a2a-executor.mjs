/**
 * a2a-executor.mjs — Execute approved A2A tasks via Codex or Claude CLI.
 *
 * After the user approves an A2A task in the PWA, this module spawns
 * `codex exec` or `claude -p` to perform the work, captures the output,
 * and updates the task status to completed/failed.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Blob, File } from "node:buffer";
import { completeA2ATask, failA2ATask } from "./a2a-handler.mjs";

const APP_BUNDLE_PATH = "/Applications/Codex.app/Contents/Resources/codex";

// ---------------------------------------------------------------------------
// PATH augmentation for launchd environments
// ---------------------------------------------------------------------------

/**
 * Build an augmented PATH that includes nvm, homebrew, and other common
 * directories so spawned processes (claude, codex) can find `node`, etc.
 *
 * Under launchd the inherited PATH is minimal (/usr/bin:/bin:/usr/sbin:/sbin).
 * We prepend well-known bin directories so child processes work correctly.
 *
 * @param {string} [binPath] - Resolved path to the binary being spawned;
 *                              its parent directory is prepended to PATH.
 */
function buildAugmentedPath(binPath) {
  const extra = [];

  // Include the directory of the resolved binary itself
  if (binPath && binPath !== "codex" && binPath !== "claude") {
    extra.push(path.dirname(binPath));
  }

  // nvm — find the active or latest node version's bin directory
  const nvmBase = path.join(os.homedir(), ".nvm", "versions", "node");
  if (existsSync(nvmBase)) {
    // Prefer NVM_BIN if set (interactive shell), otherwise scan versions
    if (process.env.NVM_BIN && existsSync(process.env.NVM_BIN)) {
      extra.push(process.env.NVM_BIN);
    } else {
      const ls = spawnSync("ls", [nvmBase], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      if (ls.status === 0 && ls.stdout) {
        const versions = ls.stdout.trim().split("\n").filter(Boolean).reverse();
        for (const v of versions) {
          const binDir = path.join(nvmBase, v, "bin");
          if (existsSync(path.join(binDir, "node"))) {
            extra.push(binDir);
            break; // use the latest version that has node
          }
        }
      }
    }
  }

  // Homebrew and common paths
  for (const p of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    if (existsSync(p)) extra.push(p);
  }

  const basePath = process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
  // Deduplicate while preserving order
  const seen = new Set();
  const parts = [];
  for (const dir of [...extra, ...basePath.split(":")]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      parts.push(dir);
    }
  }
  return parts.join(":");
}

/**
 * Try to find the claude binary by walking well-known locations.
 * Returns the absolute path if found, or null.
 */
function findClaudeBin() {
  // 1. `which` works if PATH is set (interactive shell, etc.)
  const which = spawnSync("which", ["claude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (which.status === 0 && which.stdout) return which.stdout.trim();

  // 2. ~/.claude/local/claude (official standalone install)
  const standalone = path.join(os.homedir(), ".claude", "local", "claude");
  if (existsSync(standalone)) return standalone;

  // 3. nvm-managed global install — scan version dirs
  const nvmBase = path.join(os.homedir(), ".nvm", "versions", "node");
  if (existsSync(nvmBase)) {
    const ls = spawnSync("ls", [nvmBase], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (ls.status === 0 && ls.stdout) {
      const versions = ls.stdout.trim().split("\n").filter(Boolean).reverse();
      for (const v of versions) {
        const candidate = path.join(nvmBase, v, "bin", "claude");
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  // 4. Homebrew / common paths
  for (const p of ["/usr/local/bin/claude", "/opt/homebrew/bin/claude"]) {
    if (existsSync(p)) return p;
  }

  return null;
}

/**
 * Detect which executor CLIs are available on this machine.
 * Returns { codex: boolean, claude: boolean, claudeBin?: string, codexBin?: string }.
 */
export function detectAvailableExecutors() {
  const codexWhich = spawnSync("which", ["codex"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const codexBin = codexWhich.status === 0 && codexWhich.stdout
    ? codexWhich.stdout.trim()
    : existsSync(APP_BUNDLE_PATH) ? APP_BUNDLE_PATH : null;

  const claudeBin = findClaudeBin();

  return {
    codex: !!codexBin,
    claude: !!claudeBin,
    codexBin: codexBin || undefined,
    claudeBin: claudeBin || undefined,
  };
}

/**
 * Resolve the codex binary path.
 */
function resolveCodexBin(config) {
  if (config.codexBin) return config.codexBin;
  const which = spawnSync("which", ["codex"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (which.status === 0 && which.stdout) return which.stdout.trim();
  if (existsSync(APP_BUNDLE_PATH)) return APP_BUNDLE_PATH;
  return "codex";
}

/**
 * Resolve the claude binary path.
 */
function resolveClaudeBin() {
  return findClaudeBin() || "claude";
}

const EXEC_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Execute an A2A task by spawning the chosen executor.
 *
 * @param {object}   task                  - A2A task object
 * @param {object}   config                - Bridge config
 * @param {object}   runtime               - Bridge runtime
 * @param {object}   state                 - Persistent state
 * @param {object}   helpers
 * @param {Function} helpers.recordTimelineEntry
 * @param {Function} helpers.saveState
 * @param {Function} [helpers.recordHistoryItem]    - Optional history-item recorder (adds to completed inbox)
 * @param {Function} [helpers.deliverWebPushItem]   - Optional web push delivery helper
 * @param {string}   [executor]            - "codex" or "claude" (auto-detect if omitted)
 */
export async function executeA2ATask(task, config, runtime, state, { recordTimelineEntry, recordHistoryItem, saveState, deliverWebPushItem }, executor) {
  const instruction = task.instruction || "";
  if (!instruction) {
    failA2ATask(task, "No instruction provided");
    return;
  }

  // Resolve executor if not specified.
  if (!executor) {
    const available = detectAvailableExecutors();
    executor = available.codex ? "codex" : available.claude ? "claude" : "codex";
  }

  const executionOptions = resolveA2AExecutionOptions(task, config, executor);
  const executionInstruction = buildA2AExecutionInstruction(instruction, task);

  console.log(
    `[a2a-exec] Starting task ${task.id} via ${executor}${executionOptions.model ? ` model=${executionOptions.model}` : ""}: ${instruction.slice(0, 80)}`
  );

  try {
    const result = executor === "claude"
      ? await runClaudeExec(executionInstruction, executionOptions)
      : await runCodexExec(executionInstruction, config, executionOptions);

    if (shouldUploadPaidDeliverable(task)) {
      const paidShare = await uploadPaidA2ADeliverable({ config, task, resultText: result });
      const responseText = buildPaidUnlockResponse({ task, paidShare });
      completeA2ATask(task, responseText);
      task.paidDeliverable = paidShare;
      if (task.artifacts?.[0]) {
        task.artifacts[0].name = "x402 unlockable deliverable";
        task.artifacts[0].metadata = {
          viveworker: {
            mode: "x402-pro",
            url: paidShare.url,
            slug: paidShare.slug,
            price: paidShare.price,
            payTo: paidShare.payTo,
            network: paidShare.network,
          },
        };
      }
    } else {
      completeA2ATask(task, result);
    }
    console.log(`[a2a-exec] Task ${task.id} completed via ${executor} (${result.length} chars)`);
  } catch (error) {
    failA2ATask(task, error.message);
    console.error(`[a2a-exec] Task ${task.id} failed via ${executor}: ${error.message}`);
  }

  // Record completion in timeline AND history (history drives completed inbox list).
  const resultEntry = {
    stableId: `a2a_task_result:${task.id}`,
    token: task.token,
    kind: "a2a_task_result",
    threadId: "a2a",
    threadLabel: instruction.slice(0, 80),
    title: task.status === "completed"
      ? `A2A ✅: ${instruction.slice(0, 60)}`
      : `A2A ❌: ${instruction.slice(0, 60)}`,
    summary: task.status === "completed"
      ? (task.artifacts?.[0]?.parts?.[0]?.text || "").slice(0, 160)
      : task.statusMessage || "Failed",
    instruction,
    messageText: task.status === "completed"
      ? (task.artifacts?.[0]?.parts?.[0]?.text || "").slice(0, 500)
      : task.statusMessage || "Failed",
    viveworker: task.viveworker || {},
    paidDeliverable: task.paidDeliverable || null,
    taskStatus: task.status,
    createdAtMs: task.updatedAtMs || Date.now(),
    readOnly: true,
    provider: "a2a",
  };
  try {
    recordTimelineEntry({ config, runtime, state, entry: resultEntry });
    if (typeof recordHistoryItem === "function") {
      recordHistoryItem({ config, runtime, state, item: resultEntry });
    }
    await saveState(config.stateFile, state);
  } catch (error) {
    console.error(`[a2a-exec-timeline] ${error.message}`);
  }

  // Send web push notification for completion/failure.
  if (typeof deliverWebPushItem === "function") {
    try {
      const isCompleted = task.status === "completed";
      const icon = isCompleted ? "✅" : "❌";
      const resultBody = isCompleted
        ? (task.artifacts?.[0]?.parts?.[0]?.text || "").slice(0, 160)
        : (task.statusMessage || "Failed").slice(0, 160);
      await deliverWebPushItem({
        config,
        state,
        kind: "a2a_task_result",
        token: task.token,
        stableId: `a2a_task_result:${task.id}`,
        title: `A2A ${icon}: ${instruction.slice(0, 60)}`,
        body: resultBody || instruction.slice(0, 160),
        buildLocalizedContent: ({ locale }) => {
          const lang = locale?.startsWith("ja") ? "ja" : "en";
          const instructionSnippet = instruction.slice(0, 60);
          return {
            title: isCompleted
              ? (lang === "ja" ? `A2A 完了: ${instructionSnippet}` : `A2A completed: ${instructionSnippet}`)
              : (lang === "ja" ? `A2A 失敗: ${instructionSnippet}` : `A2A failed: ${instructionSnippet}`),
            body: resultBody || instruction.slice(0, 160),
          };
        },
      });
    } catch (error) {
      console.error(`[a2a-exec-push] ${error.message}`);
    }
  }
}

export function resolveA2AExecutionOptions(task, config, executor) {
  const spec = task?.viveworker || {};
  const requestedModel = cleanText(spec.requestedModel || "");
  const tier = cleanText(spec.requestedTier || "");
  const proModel = cleanText(config?.a2aProModel || process.env.A2A_PRO_MODEL || "");
  return {
    model: requestedModel || (tier === "pro" ? proModel : ""),
    tier,
    executor,
  };
}

export function buildA2AExecutionInstruction(instruction, task) {
  const spec = task?.viveworker || {};
  const tier = cleanText(spec.requestedTier || "");
  if (tier !== "pro") {
    return instruction;
  }
  const deliverableType = cleanText(spec.deliverableType || "research brief");
  return [
    "You are completing a paid A2A Pro deliverable.",
    `Deliverable type: ${deliverableType}.`,
    "Prioritize accuracy, clear structure, and actionable conclusions. Do not mention internal account tiers or subscription access.",
    "",
    instruction,
  ].join("\n");
}

export function shouldUploadPaidDeliverable(task) {
  return task?.viveworker?.paidDeliverable === true || cleanText(task?.viveworker?.mode || "") === "x402-pro";
}

function resolvePaidShareSpec(config, task) {
  const spec = task?.viveworker || {};
  const payment = spec.payment || {};
  const price = cleanText(payment.price || config?.a2aProPrice || process.env.A2A_PRO_PRICE || "");
  const payTo = cleanText(payment.payTo || config?.a2aProPayTo || process.env.A2A_PRO_PAY_TO || "");
  const expiresDaysRaw = cleanText(spec.expiresDays || config?.a2aProExpiresDays || process.env.A2A_PRO_EXPIRES_DAYS || "7");
  const expiresDays = Number(expiresDaysRaw);
  if (!price || !payTo) {
    throw new Error("x402-pro task requires price and payTo metadata, or A2A_PRO_PRICE and A2A_PRO_PAY_TO");
  }
  if (payment.invalid === true) {
    throw new Error(`invalid x402 payment metadata: ${payment.reason || "invalid-payment"}`);
  }
  if (!/^\d+(\.\d{1,6})?$/u.test(price)) {
    throw new Error("x402-pro price must be a decimal with up to 6 fractional digits");
  }
  if (!/^0x[0-9a-fA-F]{40}$/u.test(payTo)) {
    throw new Error("x402-pro payTo must be a 0x-prefixed EVM address");
  }
  return {
    price,
    payTo,
    expiresDays: Number.isFinite(expiresDays) && expiresDays > 0 && expiresDays <= 30 ? String(expiresDays) : "7",
  };
}

export async function uploadPaidA2ADeliverable({ config, task, resultText }) {
  const userId = cleanText(config?.a2aRelayUserId || "");
  const apiKey = cleanText(config?.a2aApiKey || "");
  const shareUrl = cleanText(config?.a2aShareUrl || process.env.VIVEWORKER_SHARE_URL || "https://share.viveworker.com").replace(/\/+$/u, "");
  if (!userId || !apiKey) {
    throw new Error("A2A credentials are required to upload paid deliverables");
  }
  const paidSpec = resolvePaidShareSpec(config, task);
  const html = buildPaidDeliverableHtml({ task, resultText, paidSpec });
  const form = new FormData();
  const safeTaskId = cleanText(task?.id || "task").replace(/[^a-z0-9_-]+/giu, "-").slice(0, 64) || "task";
  const file = new File(
    [new Blob([html], { type: "text/html; charset=utf-8" })],
    `a2a-${safeTaskId}-deliverable.html`,
    { type: "text/html; charset=utf-8" }
  );
  form.set("file", file);
  form.set("price", paidSpec.price);
  form.set("payTo", paidSpec.payTo);
  form.set("expiresDays", paidSpec.expiresDays);

  const response = await fetchWithTimeout(`${shareUrl}/api/upload`, {
    method: "POST",
    headers: {
      "x-a2a-user": userId,
      "x-a2a-key": apiKey,
    },
    body: form,
  }, 60_000);
  const body = await readJson(response);
  if (!response.ok || body?.error) {
    throw new Error(`paid deliverable upload failed: ${formatApiError(response.status, body)}`);
  }
  return {
    url: body.url,
    slug: body.slug,
    price: body.price ? formatUsdcAtomic(body.price) : paidSpec.price,
    priceAtomic: body.price || "",
    payTo: body.payTo || paidSpec.payTo,
    network: body.network || "",
    expiresAtMs: body.expiresAtMs || 0,
  };
}

export function buildPaidUnlockResponse({ task, paidShare }) {
  const deliverableType = cleanText(task?.viveworker?.deliverableType || "deliverable");
  return [
    `A2A Pro ${deliverableType} is ready.`,
    "",
    `Unlock URL: ${paidShare.url}`,
    `Price: ${paidShare.price} USDC${paidShare.network ? ` on ${paidShare.network}` : ""}`,
    `Pay to: ${paidShare.payTo}`,
    "",
    "Open the URL with an x402-compatible client or browser flow to pay and receive the result.",
  ].join("\n");
}

function buildPaidDeliverableHtml({ task, resultText, paidSpec }) {
  const title = `A2A Pro Deliverable`;
  const instruction = cleanText(task?.instruction || "");
  const created = new Date().toISOString();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; --bg: #081015; --card: #121d24; --text: #eef7fb; --muted: #9fb3bf; --line: rgba(255,255,255,.12); --accent: #7dd3fc; }
    body { margin: 0; background: radial-gradient(circle at 20% 0%, rgba(55, 211, 153, .16), transparent 34%), var(--bg); color: var(--text); font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 860px; margin: 0 auto; padding: 56px 22px 72px; }
    .badge { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; padding: 6px 12px; color: var(--accent); font-weight: 700; letter-spacing: .02em; }
    h1 { font-size: clamp(34px, 7vw, 64px); line-height: .96; letter-spacing: -.055em; margin: 24px 0 16px; }
    .meta, .prompt, .result { background: rgba(18, 29, 36, .86); border: 1px solid var(--line); border-radius: 24px; padding: 22px; margin-top: 18px; box-shadow: 0 24px 80px rgba(0,0,0,.28); }
    .meta { color: var(--muted); }
    .meta strong { color: var(--text); }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; font: inherit; }
    h2 { margin: 0 0 10px; font-size: 18px; color: var(--accent); }
  </style>
</head>
<body>
  <main>
    <span class="badge">viveworker A2A Pro</span>
    <h1>Paid agent deliverable</h1>
    <section class="meta">
      <div><strong>Task:</strong> ${escapeHtml(task?.id || "")}</div>
      <div><strong>Created:</strong> ${escapeHtml(created)}</div>
      <div><strong>Price:</strong> ${escapeHtml(paidSpec.price)} USDC</div>
      <div><strong>Pay to:</strong> ${escapeHtml(paidSpec.payTo)}</div>
    </section>
    <section class="prompt">
      <h2>Request</h2>
      <pre>${escapeHtml(instruction)}</pre>
    </section>
    <section class="result">
      <h2>Result</h2>
      <pre>${escapeHtml(resultText)}</pre>
    </section>
  </main>
</body>
</html>`;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function formatApiError(status, body) {
  const error = cleanText(body?.error || body?.message || "");
  const hint = cleanText(body?.hint || "");
  return [`HTTP ${status}`, error, hint].filter(Boolean).join(" — ");
}

function formatUsdcAtomic(value) {
  const raw = cleanText(value || "");
  if (!/^\d+$/u.test(raw)) {
    return raw;
  }
  const padded = raw.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/u, "") || "0";
  const frac = padded.slice(-6).replace(/0+$/u, "");
  return frac ? `${whole}.${frac}` : whole;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Spawn `codex exec` and capture stdout+stderr.
 */
function runCodexExec(instruction, config, options = {}) {
  return new Promise((resolve, reject) => {
    const codexBin = resolveCodexBin(config);
    const args = ["exec", "--full-auto", "--skip-git-repo-check"];
    if (options.model) {
      args.push("--model", options.model);
    }
    args.push(instruction);
    const cwd = config.workspaceRoot || os.tmpdir();

    const child = spawn(codexBin, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: buildAugmentedPath(codexBin),
        CODEX_HOME: config.codexHome || path.join(os.homedir(), ".codex"),
      },
      timeout: EXEC_TIMEOUT_MS,
    });

    child.stdin.end();

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 100_000) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 50_000) stderr = stderr.slice(-50_000);
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to spawn codex: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim() || "(completed with no output)");
      } else {
        const errorDetail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        reject(new Error(`codex exec failed: ${errorDetail.slice(0, 500)}`));
      }
    });

    setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      reject(new Error("codex exec timed out (10 minutes)"));
    }, EXEC_TIMEOUT_MS).unref?.();
  });
}

/**
 * Spawn `claude -p` and capture stdout+stderr.
 */
function runClaudeExec(instruction, options = {}) {
  return new Promise((resolve, reject) => {
    const claudeBin = resolveClaudeBin();
    const args = ["-p", instruction, "--output-format", "text"];
    if (options.model) {
      args.push("--model", options.model);
    }

    const child = spawn(claudeBin, args, {
      cwd: os.tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: buildAugmentedPath(claudeBin) },
      timeout: EXEC_TIMEOUT_MS,
    });

    child.stdin.end();

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 100_000) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 50_000) stderr = stderr.slice(-50_000);
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to spawn claude: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim() || "(completed with no output)");
      } else {
        const errorDetail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        reject(new Error(`claude exec failed: ${errorDetail.slice(0, 500)}`));
      }
    });

    setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      reject(new Error("claude exec timed out (10 minutes)"));
    }, EXEC_TIMEOUT_MS).unref?.();
  });
}
