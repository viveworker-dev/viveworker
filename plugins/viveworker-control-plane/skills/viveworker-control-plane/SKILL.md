---
name: viveworker-control-plane
description: Use viveworker MCP as the mobile control plane for Codex when work needs phone-based questions, approvals, File Share uploads, Thread Share handoffs, or A2A delegation. Use when the user asks to ask on mobile, approve before acting, share a deliverable, send context to another agent/session, or delegate work to an A2A target.
---

# viveworker Control Plane

Use viveworker when the user wants the agent workflow to leave the chat and enter the mobile control plane: ask, approve, notify, share, hand off, or delegate.

## First check

If anything looks stale or disconnected, call `viveworker_status` before troubleshooting. It summarizes bridge, pairing, Remote connection, A2A, File Share, and Moltbook state.

If viveworker MCP tools are unavailable, tell the user to run:

```bash
npx viveworker enable mcp --target codex
```

Then they should restart Codex.

## Tool policy

- Use `viveworker_ask` for a short user decision that blocks progress.
- Use `viveworker_request_approval` before risky, external, irreversible, payment-related, or user-visible actions.
- Use `viveworker_notify` for informational updates that should appear on the phone and timeline.
- Use `viveworker_share_file` when a local deliverable should become a limited File Share URL.
- Use `viveworker_thread_share` when context should move to another Codex / Claude / inbox thread.
- Use `viveworker_send_a2a_task` when the user asks to delegate to a registered A2A target.

## Safety rules

- Keep phone prompts concise: action, reason, expected result, and choices.
- Treat timeout, rejection, or missing response as not approved.
- Do not send secrets, private keys, `.env` content, credentials, relay tokens, public keys, or unnecessary file contents through MCP.
- Do not use MCP as a shell executor. It creates control-plane events; it should not run arbitrary commands.
- Do not upload files through File Share without phone approval.
- Use registered A2A target aliases only. Do not inline API keys.

## Natural language triggers

Use `viveworker_ask` for:

- "ask me on my phone"
- "スマホに聞いて"
- "確認してから進めて"

Use `viveworker_request_approval` for:

- "approve this on my phone"
- "承認してから実行して"
- "外部に送る前に確認して"

Use `viveworker_share_file` for:

- "share this report"
- "共有リンクにして"
- "File Share にアップして"

Use `viveworker_thread_share` for:

- "share this with Claude"
- "tell Codex what we decided"
- "Aの内容をBに共有して"

Use `viveworker_send_a2a_task` for:

- "delegate this to another agent"
- "A2Aで依頼して"
- "registered target に送って"
