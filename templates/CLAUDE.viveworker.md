# viveworker MCP guide for Claude

Use viveworker as the mobile control plane for this Claude session when the user wants phone-based questions, approvals, file sharing, thread sharing, or A2A delegation.

## Setup

For Claude Desktop, the user should install the MCP entry once:

```bash
npx viveworker enable mcp --target claude
```

Then restart Claude Desktop.

For Claude Code, the MCP config is separate from Claude Desktop. Install it once with:

```bash
claude mcp add --scope user viveworker -- npx viveworker mcp
```

Then restart the Claude Code session. If the tools are not available, ask the user to run the setup command for the Claude surface they are using.

## Tools

- `viveworker_status` checks bridge, pairing, Remote connection, A2A, File Share, and Moltbook state.
- `viveworker_stats` reads package adoption and usage stats.
- `viveworker_share_list` lists File Share uploads and optional usage metrics.
- `viveworker_a2a_activity` reads local A2A activity.
- `viveworker_a2a_card` reads the current local A2A agent card.
- `viveworker_moltbook_list` lists Moltbook inbox comments.
- `viveworker_moltbook_show` reads one Moltbook comment.
- `viveworker_moltbook_thread` reads the thread for one Moltbook comment.
- `viveworker_notify` sends an informational phone notification and records a timeline entry.
- `viveworker_ask` asks the paired phone a question and waits for the answer.
- `viveworker_request_approval` asks the phone to approve or reject a proposed action.
- `viveworker_share_file` uploads a workspace file to File Share after phone approval. For password-protected handoff, pass `tokenize: true` to return a short-lived passwordless `?t=` URL.
- `viveworker_share_replace` replaces the file behind an existing File Share slug after phone approval.
- `viveworker_share_link` mints a short-lived passwordless `?t=` URL for an existing password-protected File Share slug after phone approval.
- `viveworker_thread_share` shares context into another Codex / Claude / inbox thread.
- `viveworker_send_a2a_task` sends a task to a registered A2A target after phone approval.

## When to use viveworker

- If the user says "ask me on my phone", "スマホに聞いて", or a short decision blocks progress, use `viveworker_ask`.
- If the user asks you to proceed with a risky, external, irreversible, payment-related, or user-visible action, use `viveworker_request_approval`.
- If the user asks for a report, prototype, screenshot, PDF, CSV, or standalone HTML to become a shareable link, use `viveworker_share_file`.
- If the user asks to replace or update the file at an existing File Share link, use `viveworker_share_replace`.
- If the user asks for a password-protected share but wants the recipient to open it without knowing the password, use `viveworker_share_file` with `password` and `tokenize: true`, or use `viveworker_share_link` for an existing slug.
- If the user says "share this with Codex/Claude", "Aの内容をBに共有して", or wants context handed to another session, use `viveworker_thread_share`.
- If the user wants another registered agent to do work, use `viveworker_send_a2a_task`.
- For troubleshooting or inspection, prefer the read-only MCP tools above before asking the user to run CLI commands.

## Prompting rules

- Keep phone prompts short and concrete.
- Include the action, why it matters, expected outcome, and clear choices.
- Do not send secrets, private keys, `.env` content, credentials, or unnecessary file contents.
- Treat timeout, rejection, or missing response as not approved.
- Do not spam the phone for routine local reads or low-risk edits unless the user asked for mobile confirmation.

## Thread sharing

Thread Share is useful for handoffs such as:

- "Tell Codex what we just decided."
- "Share this Claude result with the Codex thread."
- "Aの内容をBに共有して。"

Send a compact summary with the decision, relevant context, and the exact next action expected from the recipient.

Claude may not automatically notice newly shared messages from another session. If the user says something arrived or asks you to pull shared context, inspect the viveworker timeline/inbox surface available in the current environment, or ask the user to open the relevant shared item.

## Safety defaults

- MCP is a control-plane surface, not a shell executor.
- Do not run shell strings through MCP.
- Read-only inspection tools use fixed command allowlists and should not be used to mutate local state.
- File Share uploads/replacements and A2A task sending require phone approval.
- Use registered A2A aliases only; do not ask the user to paste API keys into prompts.
- Prefer `viveworker_status` before troubleshooting a missing notification, stale pairing, or remote connectivity issue.
