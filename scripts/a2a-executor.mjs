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

  console.log(`[a2a-exec] Starting task ${task.id} via ${executor}: ${instruction.slice(0, 80)}`);

  try {
    const result = executor === "claude"
      ? await runClaudeExec(instruction)
      : await runCodexExec(instruction, config);
    completeA2ATask(task, result);
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
      });
    } catch (error) {
      console.error(`[a2a-exec-push] ${error.message}`);
    }
  }
}

/**
 * Spawn `codex exec` and capture stdout+stderr.
 */
function runCodexExec(instruction, config) {
  return new Promise((resolve, reject) => {
    const codexBin = resolveCodexBin(config);
    const args = ["exec", "--full-auto", "--skip-git-repo-check", instruction];
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
function runClaudeExec(instruction) {
  return new Promise((resolve, reject) => {
    const claudeBin = resolveClaudeBin();
    const args = ["-p", instruction, "--output-format", "text"];

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
