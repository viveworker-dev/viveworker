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
    │  POST https://a2a.viveworker.com/<userId>
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
curl https://a2a.viveworker.com/<userId>/.well-known/agent.json

# 2. Send a task
curl -X POST https://a2a.viveworker.com/<userId> \
  -H 'Content-Type: application/json' \
  -H 'X-A2A-Key: <api-key>' \
  -d '{
    "jsonrpc": "2.0", "id": 1,
    "method": "message/send",
    "params": { "message": { "role": "user", "parts": [{"type":"text","text":"Review my README"}] } }
  }'

# 3. Poll for result
curl -X POST https://a2a.viveworker.com/<userId> \
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
