# viveworker — agent instructions

## Handling Moltbook notifications

viveworker registers itself on Moltbook (a social network for AI agents). Comments from other agents arrive as Web Push notifications on the paired phone. When the user says "someone commented on Moltbook, draft a reply", follow the flow below.

### Prerequisites

- Credentials live in `~/.viveworker/moltbook.env` (the CLI reads it automatically).
- Received comments are persisted to `~/.viveworker/moltbook-inbox/<commentId>.json`.
- Replies are sent via the `viveworker moltbook` subcommand (implemented in `node scripts/viveworker.mjs moltbook ...`).

### Standard flow

1. **List pending items**
   ```bash
   node scripts/viveworker.mjs moltbook list
   ```
   Run `node scripts/viveworker.mjs moltbook poll` first if you need a manual refresh.

2. **Pull context for the target comment**
   ```bash
   node scripts/viveworker.mjs moltbook show <commentId>
   node scripts/viveworker.mjs moltbook thread <commentId>
   ```
   `thread` returns the full comment tree for the post, so you can see the parent comment and other replies.

3. **Draft a reply in chat**
   - viveworker's voice: informal lowercase, technically substantive, 2–4 paragraphs, no signature.
   - Use existing replies (entries in `thread` where `author.name === "viveworker"`) as style references.
   - Always confirm with the user before sending.

4. **Send**
   ```bash
   node scripts/viveworker.mjs moltbook reply <commentId> --text "reply body"
   ```
   Use `\n` for line breaks. If shell escaping gets painful, use `--text=...` or a temp file.

5. **Solve the verification puzzle**
   After `reply`, Moltbook returns a verification puzzle (an obfuscated arithmetic problem). The CLI prints a `VERIFICATION REQUIRED:` block containing `verification_code` and `challenge_text`.
   - Example: `lOoB-stErR ClAw FoRcE iS tHiRtY fIvE NoOtOnS aNd iT s OtHeR ClAw Is tWeNtY tHrEe NooToNs, tOtAl/ FoRcE?` → 35 + 23 = 58
   - Answers must be formatted to **two decimal places** (`58.00`).
   ```bash
   node scripts/viveworker.mjs moltbook verify <verificationCode> 58.00
   ```
   A `{"success":true,...}` response means the reply is live.

6. **To skip**
   ```bash
   node scripts/viveworker.mjs moltbook mark-skip <commentId>
   ```

### Notes

- Moltbook rate-limits comment posts (**1 comment / 20 seconds**, 50/day). Insert `sleep 22` between batched replies.
- Always get explicit user approval before sending a reply. Never send on your own.
- Verification puzzles expire in ~5 minutes, so run `verify` promptly after `reply`.
- Use `list --all` to inspect already-handled items.

## Outbound Moltbook scouting

In addition to the receive flow above, viveworker can scout the Moltbook feed and propose comments on other agents' posts. The drafting LLM is whatever agent you're already running (Codex Desktop, Claude Desktop, Claude Code, or a manual run); the CLI is provider-neutral.

### One pass, by hand

```bash
node scripts/viveworker.mjs moltbook scout              # pick a candidate, print JSON
# … draft a 2–3 paragraph reply in viveworker voice …
node scripts/viveworker.mjs moltbook propose <postId> --text "your draft" --timeout 900
```

`scout` is read-only and never posts. It writes seen-post bookkeeping to `~/.viveworker/moltbook-scout-state.json` to enforce a daily quota (`--max-daily`, default 5) and to avoid re-proposing the same post.

`propose` submits the draft to the bridge as a `moltbook_draft` approval item, web-pushes the paired phone, and long-polls for a decision (`--timeout` seconds, default 900). On approve it posts the (possibly edited) text, solves the verification puzzle inline, and bumps the daily counter. On deny or timeout it exits non-zero and the post is left in `seenPostIds`.

### Useful flags

- `scout --submolts builds,tooling,agents,infrastructure` — restrict feed picks
- `scout --max-daily 3` — tighten quota
- `scout --dry-run` — print candidate without marking it seen
- `propose --parent-id <commentId>` — reply under an existing comment instead of top-level
- `propose --timeout 60` — short timeout for testing
- `propose --title "..." --post-author <handle> --post-body "..."` — pass original post context so the phone approval UI can show it
- `propose --intent "..."` — short rationale for the draft; displayed above the textarea on the phone

### Scheduling (optional, per harness)

The CLI is the integration surface — run it however you like:

- **Claude Code**: register a scheduled task with `mcp__scheduled-tasks__create_scheduled_task` whose prompt runs `scripts/moltbook-scout-run.sh` and then drafts + calls `propose`.
- **Codex Desktop**: copy `scripts/com.viveworker.moltbook-scout.plist.sample` to `~/Library/LaunchAgents/com.viveworker.moltbook-scout.plist`, edit the inline command to use your `codex exec` invocation, and `launchctl load` it.
- **Manual / no scheduler**: just run the two commands above whenever you feel like it.

The bridge half (`POST /api/providers/moltbook/draft`, the long-poll, and the phone approval UI) is identical across all of these.

### Troubleshooting

- `MOLTBOOK_API_KEY missing` → check that `~/.viveworker/moltbook.env` exists and is readable.
- `moltbook 4xx` → suspect an expired API key or an endpoint change.
- Watcher isn't picking up notifications → `tail -f /tmp/viveworker-moltbook-watcher.{out,err}.log` and `launchctl list | grep moltbook`.

## viveworker a2a

viveworker supports Google's A2A protocol, allowing external agents worldwide to send tasks. Tasks arrive via a Cloudflare Worker relay at `a2a.viveworker.com`, get pushed to the user's phone for approval, and execute via Codex.

### Setup (first time)

Run the setup command — the agent handles everything, the user just clicks "Authorize" on GitHub:

```bash
node scripts/viveworker.mjs a2a setup --user-id <desired-id>
```

This will:
1. Open a browser for GitHub OAuth authorization
2. Auto-write credentials to `~/.viveworker/a2a.env`
3. The running bridge detects the new config within 30 seconds and auto-connects

Optional flags:
- `--relay-url <url>` — custom relay (default: `https://a2a.viveworker.com`)
- `--timeout <seconds>` — how long to wait for GitHub auth (default: 300)

### How it works

```
External agent
    │  POST https://a2a.viveworker.com/u/<userId>
    ▼
Cloudflare Worker (relay)
    │  bridge polls every 20s
    ▼
viveworker bridge (user's Mac)
    │  Web Push → phone → user approval → Codex execution
    ▼
Cloudflare Worker
    │  external agent polls tasks/get
    ▼
External agent ← gets result
```

### Credentials

All stored in `~/.viveworker/a2a.env`:

| Key | Purpose |
|-----|---------|
| `A2A_API_KEY` | External agents use this to authenticate (via `X-A2A-Key` header) |
| `A2A_RELAY_URL` | Relay endpoint (e.g. `https://a2a.viveworker.com`) |
| `A2A_RELAY_USER_ID` | Your user ID on the relay |
| `A2A_RELAY_SECRET` | Auto-generated on first bridge connect; authenticates bridge↔relay |
| `A2A_RELAY_REGISTER_SECRET` | One-time secret from GitHub signup; consumed on first connect |

### External agent usage

Other agents interact with your viveworker via standard A2A JSON-RPC:

```bash
# 1. Discover
curl https://a2a.viveworker.com/u/<userId>/.well-known/agent.json

# 2. Send a task
curl -X POST https://a2a.viveworker.com/u/<userId> \
  -H 'Content-Type: application/json' \
  -H 'X-A2A-Key: <api-key>' \
  -d '{
    "jsonrpc": "2.0", "id": 1,
    "method": "message/send",
    "params": { "message": { "role": "user", "parts": [{"type":"text","text":"Review my README"}] } }
  }'

# 3. Poll for result
curl -X POST https://a2a.viveworker.com/u/<userId> \
  -H 'Content-Type: application/json' \
  -H 'X-A2A-Key: <api-key>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tasks/get","params":{"taskId":"<id-from-step-2>"}}'
```

### Admin operations

```bash
# Delete a user (requires REGISTER_SECRET)
curl -X DELETE https://a2a.viveworker.com/internal/admin/user/<userId> \
  -H 'Authorization: Bearer <register-secret>'
```

### Architecture

| Component | Location |
|-----------|----------|
| Cloudflare Worker (relay) | `worker/worker.js` |
| Worker config | `worker/wrangler.toml` |
| Bridge relay client | `scripts/a2a-relay-client.mjs` |
| Local A2A handler | `scripts/a2a-handler.mjs` |
| Task executor | `scripts/a2a-executor.mjs` |
| Setup CLI | `scripts/a2a-cli.mjs` |
| Bridge integration | `scripts/viveworker-bridge.mjs` (relay startup, decision handler, hot-reload) |

### Notes

- Free tier: 25 tasks/day, 5 concurrent pending tasks
- Tasks expire after 24 hours in the relay
- Bridge polls every 20 seconds; unclaimed tasks re-release after 2 minutes
- GitHub OAuth enforces 1 account per GitHub user, 3 registrations per IP per day
- Local A2A (direct `POST /a2a` to bridge) still works alongside the relay

## viveworker share

Host static artefacts on a private URL at `share.viveworker.com/v/<slug>`. Useful when an agent generates a report, a chart, an interactive prototype, a screenshot, a PDF, or a CSV and wants to hand the human a link instead of a file blob.

**Accepted file types:** `.html` / `.htm` / `.pdf` / `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` / `.csv`. SVG is intentionally excluded (it can execute scripts — same surface as HTML). Anything else is rejected with `unsupported-extension` at both the CLI and worker layers.

**Per-type rendering on view:**
- HTML → served as-is with `Content-Type: text/html`.
- PDF / image → served with `Content-Disposition: inline` so browsers preview rather than download.
- CSV → parsed server-side and rendered as an HTML table (sticky header, monospace cells, cells HTML-escaped so `<script>` in a cell stays inert). Appending `?raw=1` returns the original bytes as `text/csv`; `?raw=1&download=1` forces an attachment download. Tables are capped at 5000 rows on render; oversized CSVs get a truncation banner with a "Download raw CSV" escape hatch.

Authentication reuses the A2A relay credentials — anyone who has run `viveworker a2a setup` can upload. Anyone with the URL can view (no auth on read); crawlers are blocked via `X-Robots-Tag` and `robots.txt`.

**Quotas (per user, enforced by the worker):**
- 5 MB total live storage, 10 live files, 5 MB per file
- 10 uploads per rolling hour
- 10 `update` (PATCH) calls per rolling hour (separate bucket from upload). CLI surfaces this as `Update failed (429): rate limit — 10/60m, retry in …s` — wait out the window rather than retrying in a tight loop.
- Uploads default to a **30-day TTL** when `--expires-days` is omitted, and that's also the hard cap — `--expires-days` values > 30 are rejected by both the CLI and the worker
- `list` responses include a `quota` block for showing the user their remaining capacity
- R2 objects are physically deleted **90 days after their last write** (bucket lifecycle rule). PATCH with `--expires-days` re-writes the object so the 90-day counter resets — without touching the share at all, an abandoned upload disappears from R2 within 90 days of its creation. Don't rely on a single share for long-term storage even if you keep extending it; make a new upload if you need a fresh lifetime.
- **Reviving an expired share:** a share past its `expiresAtMs` (so `/v/<slug>` returns 410) can still be resurrected via `viveworker share update <slug> --expires-days N` as long as the R2 body survives. KV metadata hangs around for 60 days past `expiresAtMs` specifically to make this possible; between 60 and 90 days past expiry, KV is gone but the R2 body may still exist unused (no way to revive at that point — just re-upload). Past 90 days the body is gone too.
- Update on an expired share **must** include `--expires-days`; password-only updates return `Update failed (410): expired-requires-expiresDays` because a password change on something that still 410s to viewers is never what the caller wants.

### Commands

```bash
# Upload a file (max 5 MB). Accepts .html/.htm/.pdf/.png/.jpg/.jpeg/.gif/.webp/.csv
node scripts/viveworker.mjs share upload report.pdf
node scripts/viveworker.mjs share upload chart.png
node scripts/viveworker.mjs share upload data.csv    # rendered as HTML table on view

# Upload with optional password + expiry
node scripts/viveworker.mjs share upload report.html \
  --password "hunter2" \
  --expires-days 7

# List your uploads
node scripts/viveworker.mjs share list

# Update password / expiry on an existing share (URL is preserved)
node scripts/viveworker.mjs share update <slug> --password "hunter2"
node scripts/viveworker.mjs share update <slug> --no-password
node scripts/viveworker.mjs share update <slug> --expires-days 7

# Mint a short-lived pre-unlocked URL for handing off a password-protected share
node scripts/viveworker.mjs share link <slug> --password "hunter2"
node scripts/viveworker.mjs share link <slug> --password "hunter2" --ttl-hours 48

# Delete by slug
node scripts/viveworker.mjs share delete <slug>
```

All commands accept `--json` for machine-readable output. Changing the password via `update` invalidates any previously issued unlock cookies, so existing viewers have to re-enter the new password. `--expires-days` on `update` is always relative to *now* — use it to extend or shorten the TTL.

### When to use

- The user asks "share this as a link" / "host this" / "put this somewhere I can view on my phone".
- You've generated a self-contained artefact — HTML report/dashboard/visualization, PDF export, rendered chart image, screenshot, tabular CSV — and want to avoid pasting megabytes of bytes (or 500 lines of markup) into chat.
- The human wants to forward a result to someone else without exposing your repo or files.

**Do not use for:**
- Secrets, credentials, or PII (URLs are unguessable but assume they can leak).
- Files that need server-side code — only static assets are supported.
- SVG (intentionally excluded — script-execution surface).
- Archives or arbitrary binaries (`.zip`, `.tar`, `.exe`, …): uploads are restricted to the allow-list above.

### Typical flow

1. Generate the file in a temp location (`/tmp/report.pdf`, `/tmp/chart.png`, `/tmp/data.csv`, `/tmp/page.html`, …).
2. Run `viveworker share upload /tmp/<file>`.
3. Report the returned URL back to the user. For CSVs, mention that the link renders as a table and `?raw=1` downloads the original bytes.
4. If the user wants to rescind later, run `viveworker share delete <slug>` — the R2 object and KV metadata are both wiped.

### Password gate

If `--password` is set, viewers hit an unlock form. A successful submit sets an HMAC-signed cookie (`share_unlock`, Path=/v/:slug, 7 days, HttpOnly, Secure, SameSite=Lax).

### Agent handoff (pre-unlocked `?t=` URLs)

When the user asks to forward a password-protected share to another AI agent — especially via A2A or by pasting into a different chat — **do not send the plaintext password**. Instead, mint a short-lived token-embedded URL:

```bash
# 24h default TTL (capped at 168h / 7d, and capped by the share's own expiresAtMs)
node scripts/viveworker.mjs share link <slug> --password "hunter2"
# → 🔗 https://share.viveworker.com/v/<slug>?t=<expMs>.<hmac>
```

The returned URL unlocks the share on any plain `GET` — no form POST, no cookie handling. Paste it into the A2A message / chat; the receiving agent uses its WebFetch-equivalent tool and reads the HTML directly.

Semantics:
- Tokens are stateless HMACs (`<expMs>.<base64url(hmac)>`), signed with the share's `passwordSalt`. Rotating the password via `share update --password <new>` rotates the salt and invalidates every outstanding token for the slug — both browser cookies and agent `?t=` links. Use this to revoke.
- TTL: default 24h, max 168h. Capped further by the share's `expiresAtMs` so a link can never outlive the underlying share.
- Owner-auth: only the share owner (the same `A2A_API_KEY` that uploaded it) can mint tokens. Wrong password returns `401 invalid-password`.
- The endpoint (`POST /v/<slug>/unlock.json`) does **not** Set-Cookie on `?t=` views — a URL pasted into a third-party log or chat must not become a durable session for whichever browser later opens it.

### Credentials

Uses `A2A_API_KEY` and `A2A_RELAY_USER_ID` from `~/.viveworker/a2a.env`. Override the worker URL with `VIVEWORKER_SHARE_URL` env var (for staging).

### Architecture

| Component | Location |
|-----------|----------|
| Cloudflare Worker | `share-worker/worker.js` |
| Worker config | `share-worker/wrangler.toml` |
| Deployment guide | `share-worker/README.md` |
| CLI | `scripts/share-cli.mjs` |
| Subcommand dispatch | `scripts/viveworker.mjs` |

## Thread sharing (cross-thread context transfer)

Share context between AI tool sessions (Codex ↔ Claude Code) with user approval on the paired phone.

### When to use

When the user asks to share context across threads, for example:
- "Share this conversation with the Codex thread"
- "Send this plan to Claude Code for review"
- "Hand off the work so far to Codex"
- "Share just the recent conversation"
- "Share the entire thread"

### Prerequisites

- The bridge must be running (`viveworker start`).
- `SESSION_SECRET` from `~/.viveworker/config.env` is used for API auth.
- For Codex targets: the target thread must be active (check with the list endpoint).

### Share types

| Type | Purpose | Default instruction |
|------|---------|---------------------|
| `message` | Simple memo / note | (none) |
| `plan_review` | Request plan review | Review the shared plan for feasibility and potential improvements. |
| `handoff` | Work handoff | Understand the work done so far and decide what to do next. |

### Standard flow

1. **List available Codex threads**
   ```bash
   SECRET=$(grep SESSION_SECRET ~/.viveworker/config.env | cut -d= -f2)
   curl -sk -H "x-viveworker-hook-secret: $SECRET" \
     "https://localhost:8810/api/threads/list"
   ```
   Returns `{ "threads": [{ "conversationId": "...", "label": "...", ... }] }`.

2. **Send a share request** — pick the appropriate type:

   **Message** (simple text):
   ```bash
   curl -sk -H "x-viveworker-hook-secret: $SECRET" \
     -H "Content-Type: application/json" \
     -X POST "https://localhost:8810/api/threads/share" \
     -d '{
       "shareType": "message",
       "content": "free-form text here",
       "sourceTool": "claude-code",
       "sourceLabel": "Claude Code (project name)",
       "targetConversationId": "<conversationId from step 1>",
       "targetTool": "codex"
     }'
   ```

   **Plan review**:
   ```bash
   curl -sk -H "x-viveworker-hook-secret: $SECRET" \
     -H "Content-Type: application/json" \
     -X POST "https://localhost:8810/api/threads/share" \
     -d '{
       "shareType": "plan_review",
       "plan": "1. Step one\n2. Step two\n3. Step three",
       "context": "Background and motivation for this plan",
       "files": ["src/api/schema.ts", "src/db/migrations/001.sql"],
       "instruction": "optional custom instruction",
       "sourceTool": "claude-code",
       "sourceLabel": "Claude Code (project name)",
       "targetConversationId": "<conversationId>",
       "targetTool": "codex"
     }'
   ```

   **Handoff**:
   ```bash
   curl -sk -H "x-viveworker-hook-secret: $SECRET" \
     -H "Content-Type: application/json" \
     -X POST "https://localhost:8810/api/threads/share" \
     -d '{
       "shareType": "handoff",
       "summary": "What was accomplished",
       "completed": ["task 1", "task 2"],
       "remaining": ["task 3", "task 4"],
       "decisions": ["key decision 1", "key decision 2"],
       "modifiedFiles": ["src/foo.ts", "src/bar.ts"],
       "instruction": "optional custom instruction",
       "sourceTool": "claude-code",
       "sourceLabel": "Claude Code (project name)",
       "targetConversationId": "<conversationId>",
       "targetTool": "codex"
     }'
   ```

   All requests return `{ "ok": true, "token": "...", "shareId": "..." }`.

3. **User approves on the paired phone**
   - The share appears in the Pending inbox with an "Approve & Share" / "Deny" button.
   - The user can review and edit the content before approving.

4. **Delivery**
   - **Codex target**: injected as a user message into the thread via IPC.
   - **Claude Code target**: written to `~/.viveworker/thread-inbox/<shareId>.json`.

### Sending to Claude Code (no active thread)

When the target is Claude Code rather than a specific Codex thread, omit `targetConversationId` and set `targetTool` to `"claude-code"`. On approval the content is written to `~/.viveworker/thread-inbox/` for the next session to pick up.

### Handling unavailable targets

The thread list response includes `codexConnected: true/false` so you can check before sharing.

- **Codex not running**: If `codexConnected` is `false` or no threads are listed, tell the user that Codex is not connected. You can still send the share with `targetTool: "codex"` — the content will be saved to the file inbox as a fallback and the user will be notified on their phone that the target was unreachable.
- **Claude Code target**: Always works — content is written to `~/.viveworker/thread-inbox/` and auto-injected when the next Claude Code session starts (via the `UserPromptSubmit` hook).
- **No specific thread**: If the user doesn't specify which thread, omit `targetConversationId`. For Codex, this saves to the file inbox. For Claude Code, it saves to the thread inbox.

### Auto-read inbox (Claude Code)

Shared content targeting Claude Code is saved to `~/.viveworker/thread-inbox/`. The viveworker Claude Code hook automatically reads these files on your first prompt and injects them as additional context. You do not need to manually check the inbox — it happens transparently.

### Sharing conversation context (contextFiles)

When the user asks you to share conversation history or context with another thread — especially across different projects — use `contextFiles` to pass full context via temporary files. The recipient reads the files to understand the conversation.

**Workflow:**

1. **Determine scope** based on the user's request:
   - "just the recent conversation" → extract the recent relevant portion
   - "the update we just worked on" → extract the topic-specific portion
   - "share the entire thread" → extract the full conversation

2. **Extract and write context** to `~/.viveworker/thread-shares/`:
   ```bash
   mkdir -p ~/.viveworker/thread-shares
   ```
   Write a markdown file with the relevant conversation content. For Claude Code, your session transcript is at `~/.claude/projects/<project-path>/<session-id>.jsonl` — read it, extract relevant human/assistant messages, and format as readable markdown.

3. **Send share with contextFiles**:
   ```bash
   curl -sk -H "x-viveworker-hook-secret: $SECRET" \
     -H "Content-Type: application/json" \
     -X POST "https://localhost:8810/api/threads/share" \
     -d '{
       "shareType": "handoff",
       "summary": "Brief description of what is being shared",
       "contextFiles": [
         "~/.viveworker/thread-shares/session-context-20260413.md"
       ],
       "sourceTool": "claude-code",
       "sourceLabel": "Claude Code (project name)",
       "targetConversationId": "<conversationId>",
       "targetTool": "codex"
     }'
   ```

4. **Recipient** sees "Context files" in the share detail and the delivered message includes `Read the following files for full conversation context:` with the file paths.

**Tips:**
- Use absolute paths in `contextFiles` so the recipient can Read them directly.
- Keep context files in `~/.viveworker/thread-shares/` — they persist across sessions and are accessible to all tools.
- For large conversations, summarize irrelevant sections and keep detailed content for the relevant parts.
- The structured fields (`summary`, `completed`, `remaining`, etc.) serve as a quick overview; `contextFiles` provide the deep context.

### Notes

- Always get the thread list first — stale `conversationId` values will still deliver but won't reach an active thread.
- The bridge URL port may vary; check `NATIVE_APPROVAL_SERVER_PORT` in `~/.viveworker/config.env`.
- Share requests are held in memory only; they do not survive a bridge restart.
- The `instruction` field is optional for all types; sensible defaults are used when omitted.
