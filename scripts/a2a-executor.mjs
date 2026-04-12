/**
 * a2a-executor.mjs — Execute approved A2A tasks via Codex CLI.
 *
 * After the user approves an A2A task in the PWA, this module spawns
 * `codex exec` to perform the work, captures the output, and updates
 * the task status to completed/failed.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { completeA2ATask, failA2ATask } from "./a2a-handler.mjs";

const EXEC_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Execute an A2A task by spawning `codex exec`.
 *
 * @param {object}   task                  - A2A task object
 * @param {object}   config                - Bridge config
 * @param {object}   runtime               - Bridge runtime
 * @param {object}   state                 - Persistent state
 * @param {object}   helpers
 * @param {Function} helpers.recordTimelineEntry
 * @param {Function} helpers.saveState
 */
export async function executeA2ATask(task, config, runtime, state, { recordTimelineEntry, saveState }) {
  const instruction = task.instruction || "";
  if (!instruction) {
    failA2ATask(task, "No instruction provided");
    return;
  }

  console.log(`[a2a-exec] Starting task ${task.id}: ${instruction.slice(0, 80)}`);

  try {
    const result = await runCodexExec(instruction, config);
    completeA2ATask(task, result);
    console.log(`[a2a-exec] Task ${task.id} completed (${result.length} chars)`);
  } catch (error) {
    failA2ATask(task, error.message);
    console.error(`[a2a-exec] Task ${task.id} failed: ${error.message}`);
  }

  // Record completion in timeline
  try {
    recordTimelineEntry({
      config,
      runtime,
      state,
      entry: {
        stableId: `a2a_task_result:${task.id}`,
        token: task.token,
        kind: "a2a_task",
        threadId: "a2a",
        threadLabel: "A2A",
        title: task.status === "completed"
          ? `A2A ✅: ${instruction.slice(0, 60)}`
          : `A2A ❌: ${instruction.slice(0, 60)}`,
        summary: task.statusMessage || "",
        messageText: task.status === "completed"
          ? (task.artifacts?.[0]?.parts?.[0]?.text || "").slice(0, 500)
          : task.statusMessage || "Failed",
        taskStatus: task.status,
        createdAtMs: task.updatedAtMs || Date.now(),
        readOnly: true,
        provider: "a2a",
      },
    });
    await saveState(config.stateFile, state);
  } catch (error) {
    console.error(`[a2a-exec-timeline] ${error.message}`);
  }
}

/**
 * Spawn `codex exec` and capture stdout+stderr.
 */
function runCodexExec(instruction, config) {
  return new Promise((resolve, reject) => {
    const codexBin = config.codexBin || "codex";
    const args = ["exec", "--prompt", instruction, "--approval-mode", "full-auto"];
    const cwd = config.workspaceRoot || process.cwd();

    const child = spawn(codexBin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: config.codexHome || path.join(os.homedir(), ".codex") },
      timeout: EXEC_TIMEOUT_MS,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      // Cap output at 100KB
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

    // Timeout fallback
    setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      reject(new Error("codex exec timed out (10 minutes)"));
    }, EXEC_TIMEOUT_MS).unref?.();
  });
}
