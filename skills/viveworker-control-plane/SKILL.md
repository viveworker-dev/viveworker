---
name: viveworker-control-plane
description: Route AI agent operations through the user's viveworker mobile control plane. Use when Codex has access to the viveworker MCP tools and needs to notify the phone, ask the user a question, request human approval, share a workspace deliverable through File Share, hand off context to another Codex/Claude/inbox thread, or delegate a bounded task to a registered A2A target. Especially use for externally visible, irreversible, sensitive, or cross-agent actions.
---

# viveworker Control Plane

Use viveworker as the mobile control surface around agent work. Keep normal local work moving, but route decisions, confirmations, handoffs, deliverables, and delegation through the paired phone when that improves safety or flow.

## First Check

- If tool availability is uncertain, call `viveworker_status` first.
- If viveworker MCP is unavailable, do not pretend the action happened. Tell the user to run `npx viveworker enable mcp --target codex` or add the config from `npx viveworker mcp config`.
- Do not use viveworker for every routine local read/edit. Use it when a human decision, mobile notification, external handoff, or durable record is useful.

## First-Run Onboarding

Use this flow when the user asks to set up viveworker, pair a phone, install the control plane, or "make viveworker work here".

1. Check whether MCP tools are available.
   - If available, call `viveworker_status` first and use the result to decide what is missing.
   - If unavailable, explain that the MCP entry is not loaded yet and guide the user through `npx viveworker enable mcp --target codex`, then ask them to restart Codex.
2. If the bridge is not running or no local setup exists, ask for confirmation before running or recommending `npx viveworker setup`.
   - Do not auto-run setup silently. It can install local certificates, write config, register launchd services, and change agent hooks.
   - If the user explicitly asks you to execute setup, use the normal shell tool with clear confirmation, not MCP.
3. If setup exists but no phone is trusted, guide the user to run `npx viveworker pair` and open the pairing URL on the phone.
4. Ask the user to allow notifications from the Home Screen app when prompted.
5. Re-check with `viveworker_status`.
6. Send a final smoke notification with `viveworker_notify`.
7. Summarize what is ready: bridge, pairing, notifications, Remote connection, File Share, A2A, and Moltbook where applicable.

Keep onboarding calm and step-by-step. Do not make the user debug config files unless the status output points there.

## Tool Selection

- Use `viveworker_notify` for informational milestones that should appear on the phone or timeline, such as "build finished", "review ready", or "agent is blocked".
- Use `viveworker_ask` when the next step depends on a human preference, missing requirement, or choice that should not be guessed.
- Use `viveworker_request_approval` before actions that are externally visible, hard to undo, risky, sensitive, delegated, paid, or likely to surprise the user.
- Use `viveworker_share_file` when the user wants a workspace deliverable shared as a limited File Share URL. Good fits include `.html`, `.htm`, `.pdf`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, and `.csv`.
- Use `viveworker_thread_share` when context should move to another Codex session, Claude session, or viveworker inbox while preserving a human-visible handoff.
- Use `viveworker_send_a2a_task` only for registered A2A target aliases and bounded tasks with clear acceptance criteria.

## Approval And Question Style

- Keep phone prompts short and concrete.
- Include the action, expected result, and specific risk.
- Include relevant file refs, but never include secrets, tokens, private keys, or unnecessary file contents.
- Treat timeout, rejection, or transport failure as "not approved". Do not continue as if approval was granted.
- After the tool returns, summarize the decision or returned artifact to the user.

## File Share Rules

- Share only files inside the workspace root.
- Do not share `.env`, credential files, private keys, `.ssh`, `.aws`, `.gnupg`, or secret-looking paths.
- Prefer sharing final deliverables, not internal source files, unless the user explicitly asks.
- For unsupported file types, explain the accepted types and suggest exporting to HTML, PDF, image, or CSV first.
- Do not use File Share to bypass a user's explicit request not to upload or publish content.

## Thread Share Rules

- Use `targetConversationId` when the user names a specific thread.
- Use `targetTool` when the user says "send this to Codex", "share with Claude", or "put this in the inbox" without a specific thread ID.
- Send a compact handoff: current goal, decisions made, blockers, and concrete next action.
- Attach `contextFiles` only when they help the receiver act.

## A2A Delegation Rules

- Use only aliases from `~/.viveworker/a2a-targets.json`; never inline API keys in tool arguments.
- Keep delegated tasks self-contained and limited in scope.
- Include success criteria, constraints, and any deadline or budget.
- Ask for approval before sending, even if the task looks harmless.
- Do not send secrets, private repo data, or local paths unless the user clearly approves that exposure.

## Examples

Ask before a risky action:

```json
{
  "title": "Approve release publish",
  "message": "Publish viveworker 0.8.0 to npm. Risk: this makes the package public and hard to fully undo.",
  "approvalKind": "release"
}
```

Share a deliverable:

```json
{
  "path": "/workspace/report.html",
  "workspaceRoot": "/workspace",
  "expiresDays": "3"
}
```

Delegate through A2A:

```json
{
  "target": "reviewer",
  "instruction": "Review the remote connection security notes and return only concrete risks with file references.",
  "metadata": { "scope": "security-review" }
}
```
