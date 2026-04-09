#!/usr/bin/env node

/**
 * viveworker Claude Desktop / Claude Code hook handler.
 *
 * Invoked by the Claude Code harness for hook events configured in
 * ~/.claude/settings.json. Relays events to the viveworker bridge server
 * and waits for approval decisions on PermissionRequest hooks.
 *
 * Usage:
 *   node viveworker-claude-hook.mjs --env-file ~/.viveworker/config.env
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Bootstrap: parse args, load env file
// ---------------------------------------------------------------------------

let envFilePath = "";
for (let i = 2; i < process.argv.length - 1; i++) {
  if (process.argv[i] === "--env-file") {
    envFilePath = process.argv[i + 1];
    break;
  }
}

if (envFilePath) {
  try {
    const raw = await fs.readFile(resolvePath(envFilePath), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch {
    // Missing env file is non-fatal
  }
}

const BASE_URL = stripTrailingSlash(process.env.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "");
const HOOK_SECRET = process.env.SESSION_SECRET || "";
const STATE_DIR = resolvePath(
  process.env.CLAUDE_HOOK_STATE_DIR || path.join(os.homedir(), ".viveworker", "claude-hooks")
);

// Exit silently if not configured for Claude provider
if (!BASE_URL || !HOOK_SECRET) {
  process.exit(0);
}

// Timeouts
const APPROVAL_TIMEOUT_MS = 660_000; // 11 min — matches hook timeout (900s) minus buffer
const DEFAULT_EVENT_TIMEOUT_MS = 12_000;
// Throttle for auto-opening the PC browser from handlePreToolInteractive so
// back-to-back plan/question intercepts do not spam new browser invocations.
const BROWSER_OPEN_THROTTLE_MS = 10_000;

// ---------------------------------------------------------------------------
// Read hook event from stdin
// ---------------------------------------------------------------------------

const stdinText = await readStdin();
let event;
try {
  event = JSON.parse(stdinText);
} catch {
  process.exit(0);
}

const hookEventName = String(event.hook_event_name || "");
const sessionId = String(event.session_id || "");
const toolName = String(event.tool_name || "");
const toolInput = isPlainObject(event.tool_input) ? event.tool_input : {};
const cwd = String(event.cwd || process.cwd());

await fs.mkdir(STATE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Route hook event
// ---------------------------------------------------------------------------

switch (hookEventName) {
  case "PermissionRequest":
    await handlePermissionRequest();
    break;
  case "PreToolUse":
    await handlePreToolUse();
    break;
  case "PostToolUse":
  case "PostToolUseFailure":
    await handlePostToolUse();
    break;
  default:
    // Notification, Stop, UserPromptSubmit, SessionEnd
    await postEvent(hookEventName, { sessionId, toolName, cwd }, DEFAULT_EVENT_TIMEOUT_MS);
    break;
}

process.exit(0);

// ---------------------------------------------------------------------------
// Hook handlers
// ---------------------------------------------------------------------------

async function handlePermissionRequest() {
  const requestId = String(event.request_id || generateId());
  let approvalKind = "command";
  let messageText = `Tool approval needed: ${toolName}`;
  let fileRefs = [];
  let diffText = "";
  let diffAddedLines = 0;
  let diffRemovedLines = 0;

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    approvalKind = "file";
    const targetFile = String(toolInput.file_path || toolInput.path || "");
    fileRefs = targetFile ? [targetFile] : [];
    messageText = "File changes need approval.";

    try {
      const diff = await computeProspectiveDiff(toolName, toolInput, cwd);
      diffText = diff.diffText;
      diffAddedLines = diff.addedLines;
      diffRemovedLines = diff.removedLines;
    } catch {
      // Proceed without diff if computation fails
    }
  } else if (toolName === "Bash") {
    approvalKind = "command";
    const cmd = String(toolInput.command || "");
    messageText = `Command approval needed.\n\`\`\`\n${cmd.slice(0, 500)}\n\`\`\``;
  } else if (toolName === "ExitPlanMode") {
    approvalKind = "plan";
    messageText = "Plan approval needed.";
  } else if (toolName === "AskUserQuestion") {
    approvalKind = "question";
    messageText = "Question from Claude.";
  } else {
    messageText = `Tool approval needed: ${toolName}`;
  }

  const body = {
    eventType: "approval_request",
    threadId: sessionId,
    requestId,
    approvalKind,
    toolName,
    toolInput,
    cwd,
    createdAtMs: Date.now(),
    fileRefs,
    diffText,
    diffAvailable: Boolean(diffText),
    diffSource: "claude_permission_request",
    diffAddedLines,
    diffRemovedLines,
    messageText,
  };

  if (approvalKind === "plan") {
    body.planText = String(toolInput.plan || "");
  } else if (approvalKind === "question") {
    body.questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  }

  const result = await postEvent("PermissionRequest", body, APPROVAL_TIMEOUT_MS);
  const behavior = String(result?.permissionDecision || "deny") === "allow" ? "allow" : "deny";
  const reason = typeof result?.permissionDecisionReason === "string" ? result.permissionDecisionReason : "";

  const decision = { behavior };
  if (reason) decision.message = reason;

  const output = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision,
    },
  };
  process.stdout.write(JSON.stringify(output) + "\n");
}

async function handlePreToolUse() {
  // ExitPlanMode and AskUserQuestion are auto-allowed tools that do not
  // trigger PermissionRequest hooks. Intercept them here instead, and
  // forward to the bridge so the user can respond from their phone.
  if (toolName === "ExitPlanMode" || toolName === "AskUserQuestion") {
    await handlePreToolInteractive();
    return;
  }

  if (toolName !== "Write" && toolName !== "Edit" && toolName !== "MultiEdit") {
    return;
  }
  const filePath = String(toolInput.file_path || toolInput.path || "");
  if (!filePath) return;

  const resolvedFilePath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const snapshotDir = path.join(STATE_DIR, "snapshots", sanitizeForPath(sessionId));
  await fs.mkdir(snapshotDir, { recursive: true });

  try {
    const content = await fs.readFile(resolvedFilePath, "utf8");
    const snapshotFile = path.join(snapshotDir, encodeFilePathForSnapshot(resolvedFilePath));
    await fs.writeFile(snapshotFile, content, "utf8");
  } catch {
    // New file or unreadable — snapshot not needed
  }
}

async function handlePreToolInteractive() {
  // Away mode gate: when sentinel file is absent, do not intercept and let
  // Claude Code show its native PC UI as usual.
  const sentinelDir = envFilePath
    ? path.dirname(resolvePath(envFilePath))
    : path.join(os.homedir(), ".viveworker");
  const sentinelPath = path.join(sentinelDir, "claude-away-mode");
  let awayOn = false;
  try {
    const st = await fs.stat(sentinelPath);
    awayOn = st.isFile();
  } catch {
    awayOn = false;
  }
  const requestId = String(event.request_id || generateId());
  let approvalKind = "command";
  let messageText = `Tool approval needed: ${toolName}`;
  if (toolName === "ExitPlanMode") {
    approvalKind = "plan";
    messageText = "Plan approval needed.";
  } else if (toolName === "AskUserQuestion") {
    approvalKind = "question";
    messageText = "Question from Claude.";
  }

  const body = {
    eventType: "approval_request",
    threadId: sessionId,
    requestId,
    approvalKind,
    toolName,
    toolInput,
    cwd,
    createdAtMs: Date.now(),
    fileRefs: [],
    diffText: "",
    diffAvailable: false,
    diffSource: "claude_pre_tool_use",
    diffAddedLines: 0,
    diffRemovedLines: 0,
    messageText,
  };
  if (approvalKind === "plan") {
    body.planText = String(toolInput.plan || "");
  } else if (approvalKind === "question") {
    body.questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  }

  // Away mode OFF: send a notify-only event so the phone shows a read-only
  // alert, then return immediately so Claude Code's native PC UI runs.
  if (!awayOn) {
    body.notifyOnly = true;
    await postEvent("PreToolUse", body, DEFAULT_EVENT_TIMEOUT_MS);
    return;
  }

  // Away mode ON: Claude Desktop has no IPC path to inject plan/question
  // decisions (unlike approvals), so the hook long-poll below is the only way
  // to resolve the prompt, and the Claude Desktop native dialog is suppressed
  // for the duration of the intercept. Auto-open the PC default browser to
  // the viveworker Web UI so the user at their desk can answer alongside the
  // paired phone. The bridge's resolved/resolving guard ensures first-answer
  // wins when both respond.
  await openBrowserWithThrottle();

  const result = await postEvent("PreToolUse", body, APPROVAL_TIMEOUT_MS);
  const permissionDecision = String(result?.permissionDecision || "deny") === "allow" ? "allow" : "deny";
  const permissionDecisionReason = typeof result?.permissionDecisionReason === "string" ? result.permissionDecisionReason : "";

  const hookSpecificOutput = {
    hookEventName: "PreToolUse",
    permissionDecision,
  };
  if (permissionDecisionReason) {
    hookSpecificOutput.permissionDecisionReason = permissionDecisionReason;
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput }) + "\n");
}

async function handlePostToolUse() {
  // Emit file_event entries for Read / Write / Edit / MultiEdit so the
  // viveworker timeline mirrors Codex's file event feed. This runs before
  // snapshot cleanup so the PreToolUse snapshot is still available for diff.
  const filePath = String(toolInput.file_path || toolInput.path || "");
  if (filePath && (toolName === "Read" || toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit")) {
    const resolvedFilePath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    try {
      if (toolName === "Read") {
        await postEvent(
          "file_event",
          {
            eventType: "file_event",
            fileEventType: "read",
            filePath: resolvedFilePath,
            threadId: sessionId,
            sessionId,
            cwd,
            createdAtMs: Date.now(),
            diffText: "",
            diffAvailable: false,
            diffAddedLines: 0,
            diffRemovedLines: 0,
          },
          DEFAULT_EVENT_TIMEOUT_MS
        );
      } else {
        const snapshotDir = path.join(STATE_DIR, "snapshots", sanitizeForPath(sessionId));
        const snapshotFile = path.join(snapshotDir, encodeFilePathForSnapshot(resolvedFilePath));
        let oldContent = "";
        let hadSnapshot = false;
        try {
          oldContent = await fs.readFile(snapshotFile, "utf8");
          hadSnapshot = true;
        } catch {
          // No snapshot → treat as create
        }
        let newContent = "";
        try {
          newContent = await fs.readFile(resolvedFilePath, "utf8");
        } catch {
          // File may have been deleted; leave empty
        }
        const diff = await computeUnifiedDiff(oldContent, newContent, filePath);
        const fileEventType = hadSnapshot ? "write" : "create";
        await postEvent(
          "file_event",
          {
            eventType: "file_event",
            fileEventType,
            filePath: resolvedFilePath,
            threadId: sessionId,
            sessionId,
            cwd,
            createdAtMs: Date.now(),
            diffText: diff.diffText,
            diffAvailable: Boolean(diff.diffText),
            diffAddedLines: diff.addedLines,
            diffRemovedLines: diff.removedLines,
          },
          DEFAULT_EVENT_TIMEOUT_MS
        );
      }
    } catch {
      // file_event is best-effort
    }
  }

  // Snapshot cleanup (file edits only)
  if (filePath) {
    const resolvedFilePath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    const snapshotDir = path.join(STATE_DIR, "snapshots", sanitizeForPath(sessionId));
    const snapshotFile = path.join(snapshotDir, encodeFilePathForSnapshot(resolvedFilePath));
    try {
      await fs.unlink(snapshotFile);
    } catch {
      // Snapshot may not exist
    }
  }

  // Notify bridge so any approval that was accepted directly on PC
  // (bypassing the iPhone) gets cleared from the pending list and recorded
  // as completed.
  await postEvent(
    hookEventName,
    { threadId: sessionId, sessionId, toolName, toolInput, cwd },
    DEFAULT_EVENT_TIMEOUT_MS
  );
}

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------

async function computeProspectiveDiff(tName, tInput, workingDir) {
  const filePath = String(tInput.file_path || tInput.path || "");
  if (!filePath) return { diffText: "", addedLines: 0, removedLines: 0 };

  const resolvedFilePath = path.isAbsolute(filePath) ? filePath : path.join(workingDir, filePath);

  let oldContent = "";
  try {
    oldContent = await fs.readFile(resolvedFilePath, "utf8");
  } catch {
    // New file
  }

  let newContent = oldContent;
  if (tName === "Write") {
    newContent = String(tInput.content || "");
  } else if (tName === "Edit") {
    newContent = applyEdit(oldContent, tInput);
  } else if (tName === "MultiEdit") {
    newContent = applyMultiEdit(oldContent, Array.isArray(tInput.edits) ? tInput.edits : []);
  }

  if (oldContent === newContent) {
    return { diffText: "", addedLines: 0, removedLines: 0 };
  }

  const tmpDir = path.join(STATE_DIR, "tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const rand = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tmpOld = path.join(tmpDir, `old_${rand}`);
  const tmpNew = path.join(tmpDir, `new_${rand}`);

  try {
    await fs.writeFile(tmpOld, oldContent, "utf8");
    await fs.writeFile(tmpNew, newContent, "utf8");

    let diffText = "";
    try {
      const { stdout } = await execFileAsync("diff", ["-u", tmpOld, tmpNew]);
      diffText = stdout;
    } catch (err) {
      // diff exits with code 1 when there are differences — that's normal
      diffText = String(err.stdout || "");
    }
    // Replace temp file paths with the actual file path in the diff header
    if (diffText) {
      const tmpOldEscaped = tmpOld.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tmpNewEscaped = tmpNew.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      diffText = diffText
        .replace(new RegExp(tmpOldEscaped, "gu"), `a/${filePath}`)
        .replace(new RegExp(tmpNewEscaped, "gu"), `b/${filePath}`);
    }

    let addedLines = 0;
    let removedLines = 0;
    for (const line of diffText.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) addedLines++;
      else if (line.startsWith("-") && !line.startsWith("---")) removedLines++;
    }

    return { diffText, addedLines, removedLines };
  } finally {
    await fs.unlink(tmpOld).catch(() => {});
    await fs.unlink(tmpNew).catch(() => {});
  }
}

async function computeUnifiedDiff(oldContent, newContent, displayPath) {
  if (oldContent === newContent) {
    return { diffText: "", addedLines: 0, removedLines: 0 };
  }
  const tmpDir = path.join(STATE_DIR, "tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const rand = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tmpOld = path.join(tmpDir, `old_${rand}`);
  const tmpNew = path.join(tmpDir, `new_${rand}`);
  try {
    await fs.writeFile(tmpOld, oldContent, "utf8");
    await fs.writeFile(tmpNew, newContent, "utf8");
    let diffText = "";
    try {
      const { stdout } = await execFileAsync("diff", ["-u", tmpOld, tmpNew]);
      diffText = stdout;
    } catch (err) {
      diffText = String(err.stdout || "");
    }
    if (diffText && displayPath) {
      const tmpOldEscaped = tmpOld.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tmpNewEscaped = tmpNew.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      diffText = diffText
        .replace(new RegExp(tmpOldEscaped, "gu"), `a/${displayPath}`)
        .replace(new RegExp(tmpNewEscaped, "gu"), `b/${displayPath}`);
    }
    let addedLines = 0;
    let removedLines = 0;
    for (const line of diffText.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) addedLines++;
      else if (line.startsWith("-") && !line.startsWith("---")) removedLines++;
    }
    return { diffText, addedLines, removedLines };
  } finally {
    await fs.unlink(tmpOld).catch(() => {});
    await fs.unlink(tmpNew).catch(() => {});
  }
}

function applyEdit(content, edit) {
  const oldStr = String(edit.old_string || "");
  const newStr = String(edit.new_string || "");
  if (edit.replace_all === true) {
    return content.split(oldStr).join(newStr);
  }
  const idx = content.indexOf(oldStr);
  if (idx === -1) return content;
  return content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
}

function applyMultiEdit(content, edits) {
  let result = content;
  for (const edit of edits) {
    result = applyEdit(result, edit);
  }
  return result;
}

// ---------------------------------------------------------------------------
// HTTP helper — posts to viveworker bridge
// ---------------------------------------------------------------------------

async function postEvent(eventName, body, timeoutMs = DEFAULT_EVENT_TIMEOUT_MS) {
  const url = `${BASE_URL}/api/providers/claude/events`;
  const payload = JSON.stringify({ ...body, hookEventName: eventName });

  return new Promise((resolve) => {
    let resolved = false;
    const done = (value) => {
      if (!resolved) {
        resolved = true;
        resolve(value);
      }
    };

    const timer = setTimeout(() => done({}), timeoutMs);

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      clearTimeout(timer);
      done({});
      return;
    }

    const isHttps = parsedUrl.protocol === "https:";
    const port = parsedUrl.port
      ? Number(parsedUrl.port)
      : isHttps ? 443 : 80;

    const options = {
      hostname: parsedUrl.hostname,
      port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "x-viveworker-hook-secret": HOOK_SECRET,
      },
      // Allow self-signed certs for loopback/LAN connections
      rejectUnauthorized: false,
    };

    const protocol = isHttps ? https : http;
    const req = protocol.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        clearTimeout(timer);
        try {
          done(data ? JSON.parse(data) : {});
        } catch {
          done({});
        }
      });
    });

    req.on("error", () => {
      clearTimeout(timer);
      done({});
    });

    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    const rl = createInterface({ input: process.stdin });
    const lines = [];
    rl.on("line", (line) => lines.push(line));
    rl.on("close", () => resolve(lines.join("\n")));
  });
}

function resolvePath(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function stripTrailingSlash(s) {
  return s.replace(/\/+$/u, "");
}

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function sanitizeForPath(s) {
  return s.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64);
}

function encodeFilePathForSnapshot(filePath) {
  return filePath.replace(/[/\\]/gu, "_") + ".snap";
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Browser auto-open helper (away-mode intercept → viveworker Web UI)
// ---------------------------------------------------------------------------

async function openBrowserWithThrottle() {
  if (!BASE_URL) return;
  const throttleFile = path.join(STATE_DIR, "last-browser-open-ms");
  const now = Date.now();
  try {
    const raw = await fs.readFile(throttleFile, "utf8");
    const last = Number(raw.trim());
    if (Number.isFinite(last) && now - last < BROWSER_OPEN_THROTTLE_MS) {
      return;
    }
  } catch {
    // No throttle file yet, or unreadable — proceed.
  }
  try {
    await fs.writeFile(throttleFile, String(now), "utf8");
  } catch {
    // Failing to record the timestamp just means we might open twice; fine.
  }
  try {
    // Target URL carries a `focusPending=claude` hint plus a fresh timestamp
    // so the web app knows to auto-open the newest pending Claude plan /
    // question on boot. The timestamp also forces a reload when we navigate
    // an already-open tab, so the popup re-runs its focus logic.
    const prefix = `${BASE_URL}/app`;
    const targetUrl = `${prefix}?focusPending=claude&ts=${Date.now()}`;
    // Try to focus (and navigate) an existing viveworker tab in any running
    // browser first; only open a new popup window if none exists. Handled via
    // AppleScript so the user does not accumulate duplicate tabs/windows.
    //
    // New windows are launched as a Chromium `--app` popup (chromeless,
    // mobile-sized, top-right) if any Chromium-family browser is installed;
    // otherwise we fall back to a plain `open <url>` in the default browser.
    //
    // Fire-and-forget: the `osascript` child exits in well under a second,
    // and we unref() so node never waits on it. Any failure (no running
    // browser matching, permission denied, non-macOS) is swallowed.
    const chromium = await pickChromiumBrowser();
    const script = buildFocusOrOpenAppleScript(targetUrl, prefix, chromium);
    const child = execFile("osascript", ["-e", script], () => {});
    child.unref();
  } catch {
    // execFile throwing synchronously is rare; swallow.
  }
}

async function pickChromiumBrowser() {
  const candidates = [
    { path: "/Applications/Brave Browser.app", name: "Brave Browser" },
    { path: "/Applications/Arc.app", name: "Arc" },
    { path: "/Applications/Google Chrome.app", name: "Google Chrome" },
    { path: "/Applications/Microsoft Edge.app", name: "Microsoft Edge" },
    { path: "/Applications/Vivaldi.app", name: "Vivaldi" },
  ];
  // Build installed-set first.
  const installed = [];
  for (const c of candidates) {
    try {
      await fs.stat(c.path);
      installed.push(c);
    } catch {
      // Not installed.
    }
  }
  if (installed.length === 0) return null;
  // Prefer whichever Chromium browser is currently running — that is where
  // the user's existing viveworker pairing session lives, so the `--app`
  // popup inherits the same cookies instead of asking for a pairing code.
  for (const c of installed) {
    if (await isProcessRunningByName(c.name)) {
      return c;
    }
  }
  // None running: fall back to the first installed candidate.
  return installed[0];
}

function isProcessRunningByName(processName) {
  return new Promise((resolve) => {
    // `pgrep -xq` matches an exact process name. macOS reports the displayed
    // app name (e.g. "Brave Browser") as the process name for GUI apps.
    execFile("pgrep", ["-xq", processName], (err) => {
      resolve(!err);
    });
  });
}

function buildFocusOrOpenAppleScript(targetUrl, prefix, chromium) {
  // Escape for embedding inside an AppleScript string literal.
  const escUrl = targetUrl.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
  const escPrefix = prefix.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
  const escChromiumName = chromium
    ? chromium.name.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')
    : "";

  // Popup geometry: iPhone 14-ish footprint pinned to the primary display's
  // top-right corner (with a small margin + allowance for the menu bar).
  const POPUP_W = 390;
  const POPUP_H = 800;
  const POPUP_RIGHT_MARGIN = 20;
  const POPUP_TOP_MARGIN = 40;

  // Launch phase: if a Chromium-family browser is available, open the Web UI
  // as a chromeless `--app` popup window and then force the bounds explicitly
  // via AppleScript (Chromium sometimes ignores `--window-size`/`position`
  // when it restores state from its local profile).
  const launchPhase = chromium
    ? `
set screenWidth to 1920
try
  tell application "Finder"
    set desktopBounds to bounds of window of desktop
  end tell
  set screenWidth to (item 3 of desktopBounds) as integer
end try
set popupW to ${POPUP_W}
set popupH to ${POPUP_H}
set popupX to (screenWidth - popupW - ${POPUP_RIGHT_MARGIN})
set popupY to ${POPUP_TOP_MARGIN}
set cmd to "open -na " & quoted form of "${escChromiumName}" & " --args --app=" & quoted form of targetURL & " --window-size=" & popupW & "," & popupH & " --window-position=" & popupX & "," & popupY
do shell script cmd
delay 0.5
try
  using terms from application "Google Chrome"
    tell application "${escChromiumName}"
      repeat with w in windows
        try
          if (URL of active tab of w as string) starts with prefix then
            set bounds of w to {popupX, popupY, popupX + popupW, popupY + popupH}
            activate
            exit repeat
          end if
        end try
      end repeat
    end tell
  end using terms from
end try
return "launched"
`
    : `
do shell script "open " & quoted form of targetURL
return "opened"
`;

  return `
set targetURL to "${escUrl}"
set prefix to "${escPrefix}"

set chromiumBrowsers to {"Google Chrome", "Arc", "Brave Browser", "Microsoft Edge", "Vivaldi"}

repeat with appName in chromiumBrowsers
  try
    tell application "System Events"
      if not (exists (processes where name is (appName as string))) then error "not running"
    end tell
    using terms from application "Google Chrome"
      tell application (appName as string)
        repeat with w in windows
          set tIdx to 0
          repeat with t in tabs of w
            set tIdx to tIdx + 1
            if (URL of t as string) starts with prefix then
              -- Do NOT rewrite the tab URL here. The running web app will
              -- auto-navigate to the newest unresolved Claude pending via
              -- its polling loop, but only when the user is not currently
              -- mid-answer on another pending item.
              set active tab index of w to tIdx
              set index of w to 1
              activate
              return "focused"
            end if
          end repeat
        end repeat
      end tell
    end using terms from
  end try
end repeat

try
  tell application "System Events"
    if not (exists (processes where name is "Safari")) then error "not running"
  end tell
  tell application "Safari"
    repeat with w in windows
      repeat with t in tabs of w
        if (URL of t as string) starts with prefix then
          set current tab of w to t
          set index of w to 1
          activate
          return "focused"
        end if
      end repeat
    end repeat
  end tell
end try
${launchPhase}`;
}
