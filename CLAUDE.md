# viveworker — agent instructions

## viveworker MCP control plane

When the MCP server is configured, treat viveworker as the mobile control plane for the current agent session.

- Use `viveworker_status` first if you need to confirm bridge, pairing, Remote connection, A2A, File Share, or Moltbook state.
- Use `viveworker_ask` when the user says "ask me on my phone", "スマホに聞いて", or when a short human choice blocks progress.
- Use `viveworker_request_approval` before risky, external, irreversible, payment-related, or user-visible actions.
- Use `viveworker_share_file` when the user asks for a report, prototype, screenshot, PDF, CSV, or standalone HTML to be shared as a link.
- Use `viveworker_thread_share` when the user says "share this with Codex/Claude", "Aの内容をBに共有して", or wants context handed to another session.
- Use `viveworker_send_a2a_task` only for registered A2A targets; do not inline API keys or secrets.
- Keep phone prompts short and concrete: action, risk, expected outcome, and choices.
- Never send secrets, private keys, `.env` content, credentials, or unnecessary file contents through MCP.
- If a request times out or is rejected, treat it as not approved.
- If MCP tools are unavailable in Claude Desktop, tell the user to run `npx viveworker enable mcp --target claude` and restart Claude Desktop.
- If MCP tools are unavailable in Claude Code, tell the user to run `claude mcp add --scope user viveworker -- npx viveworker mcp` and restart the Claude Code session.

### Known limitation: Claude Desktop plan-mode approval cannot be fully bypassed from phone

Claude Desktop's `ExitPlanMode` tool ignores the `permissionDecision` value
returned by the bridge's PreToolUse hook. We tested both directions and
both fail:

- `permissionDecision: "allow"` → Claude Desktop still pops its native plan
  dialog on the Mac asking for approval a second time, defeating the
  phone-only flow.
- `permissionDecision: "deny"` → the native dialog is suppressed, but plan
  mode never exits, so any subsequent `Edit` / `Write` is blocked.

Current behavior in `viveworker-bridge.mjs` is the second variant
(`deny` + a hint message). When the user approves a plan from the paired
phone, Claude reads the hint as "proceed without calling ExitPlanMode
again", but to actually unblock editing the user still needs **one final
tap on the native "Approve and allow editing" dialog on the Mac**.

If the user complains that plan approval doesn't take effect, explain this
constraint instead of pretending the phone tap is sufficient. A future
enhancement would drive the Mac dialog via AppleScript / Accessibility
API; until then, the Mac tap is unavoidable for Claude Desktop plans.

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

   **Mention notifications (post-level @mentions):** when someone tags
   `@viveworker` in their post body (not as a reply), the inbox item carries
   `kind: "mention"` and the CLI automatically posts a top-level comment on
   the post (no `parent_id`). For older inbox items missing the `kind`
   field — or any other ad-hoc top-level reply — pass `--top-level`:
   ```bash
   node scripts/viveworker.mjs moltbook reply <commentId> --text "..." --top-level
   ```
   Without that flag the API rejects the request with `Parent comment not
   found` because the synthetic mention `commentId` doesn't exist as a real
   comment.

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

Authentication reuses the A2A relay credentials — anyone who has run `viveworker a2a setup` can upload. By default anyone with the URL can view (no auth on read); attach `--password` or `--price` to gate access, and all shares are blocked from crawlers via `X-Robots-Tag` and `robots.txt`.

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

# Upload with a payment gate (x402 / USDC on Base). --price is USDC as a
# decimal (≤6 fractional digits); --pay-to is the seller's EVM address.
# Mutually exclusive with --password on a single share.
# ⚠ Replace the zero-address example below with YOUR OWN Base EOA / multisig
# before running — copy-pasting as-is will either fail verification or burn
# the USDC (no escrow, no refunds; viveworker never holds the funds).
node scripts/viveworker.mjs share upload report.pdf \
  --price 0.10 \
  --pay-to 0x0000000000000000000000000000000000000000

# List your uploads (append --metrics for 24h/7d payment-flow stats)
node scripts/viveworker.mjs share list
node scripts/viveworker.mjs share list --metrics

# Update password / price / expiry on an existing share (URL is preserved)
node scripts/viveworker.mjs share update <slug> --password "hunter2"
node scripts/viveworker.mjs share update <slug> --no-password
node scripts/viveworker.mjs share update <slug> --price 0.20
node scripts/viveworker.mjs share update <slug> --pay-to 0x742d...
node scripts/viveworker.mjs share update <slug> --no-price
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

### Paid deliverables (x402 / USDC on Base) — CLOSED BETA (testnet only)

> **⚠ Closed beta.** Paid shares run on **Base Sepolia** (testnet) and are gated by a server-side allowlist (`X402_BETA_ALLOWLIST`). Your `--price` / `--pay-to` upload will fail with `paid-shares-closed-beta` (403) unless the worker operator has added your userId. While in beta, all payment amounts are test-USDC with no monetary value; buyer-side docs and the 402 HTML call this out prominently. Mainnet flip is a `wrangler.toml` change + a `wrangler secret put X402_FACILITATOR_AUTH` — no code changes needed.

Attach `--price <usd> --pay-to <0x…>` to an upload to gate the share behind a USDC payment on Base. This is the A2A "納品" pattern — Agent A uploads a report, Agent B pays Agent A to unlock it.

```bash
# Seller: upload a paid report. Substitute --pay-to with YOUR OWN Base EOA
# or multisig — the zero-address placeholder below won't actually receive
# funds (and nothing in viveworker can recover them if USDC reaches it).
node scripts/viveworker.mjs share upload report.pdf \
  --price 0.10 \
  --pay-to 0x0000000000000000000000000000000000000000
# → https://share.viveworker.com/v/<slug>

# Resolve a hazbase smart wallet address first when you want the payout
# recipient to be the seller's hazbase wallet rather than a raw EOA.
# Requires the local viveworker session secret (same value as SESSION_SECRET).
curl -sS http://127.0.0.1:8787/api/hazbase/payout-address?chainId=84532 \
  -H "x-viveworker-hook-secret: $SESSION_SECRET"
# -> { "payoutAddress": "0x...", "payoutMethod": "hazbase_wallet", ... }

# Then pass that resolved address to --pay-to. Keep payoutMethod metadata
# in mind if you build your own worker request body directly.
node scripts/viveworker.mjs share upload report.pdf \
  --price 0.10 \
  --pay-to 0x...

# Rotate the price (invalidates outstanding paid sessions)
node scripts/viveworker.mjs share update <slug> --price 0.20

# Change the recipient only (paid sessions keep working)
node scripts/viveworker.mjs share update <slug> --pay-to 0x…

# Remove the payment gate entirely (share becomes public)
node scripts/viveworker.mjs share update <slug> --no-price
```

**Wallet setup split (recommended):**
- **Human path:** use `Settings -> Integrations -> Wallet` inside viveworker for OTP, passkey registration/assertion, and Base / Base Sepolia wallet issuance.
- **Agent path:** treat hazbase wallet resolution as **read-only orchestration**. Agents should read local status / payout-address and then call `share upload` / `share update` with the resolved `--pay-to` value.
- **Do not let agents drive OTP / passkey by default.** If the wallet is missing or the seller is signed out, the agent should instruct the human to complete those steps in the Wallet UI, then continue automatically afterwards.

**Local agent runbook (hazbase wallet as seller payout):**
1. Check whether viveworker already has a signed-in hazbase session and an issued wallet on the target chain.
2. If status shows `signedIn=false`, `hazbase-auth-required`, or no wallet address for the target chain, stop and tell the human to finish the Wallet UI flow.
3. Resolve the payout address locally.
4. Pass that address to `share upload` / `share update` as `--pay-to`.
5. If you build raw worker requests instead of using the CLI, keep `payoutMethod=hazbase_wallet` metadata so the backend audit trail preserves the wallet origin.

```bash
# 1) Inspect local hazbase status (read-only; safe for agents).
curl -sS http://127.0.0.1:8787/api/hazbase/status \
  -H "x-viveworker-hook-secret: $SESSION_SECRET"

# 2) Resolve the seller payout address for Base Sepolia.
PAYTO="$(curl -sS 'http://127.0.0.1:8787/api/hazbase/payout-address?chainId=84532' \
  -H "x-viveworker-hook-secret: $SESSION_SECRET" | jq -r '.payoutAddress')"

# 3) Use the resolved address in the existing share CLI.
node scripts/viveworker.mjs share upload report.pdf \
  --price 0.10 \
  --pay-to "$PAYTO"

# 4) Buyer: inspect a paid share without signing.
node scripts/viveworker.mjs share pay https://share.viveworker.com/v/<slug> --dry-run

# 5) Buyer: pay with a Base Sepolia EOA that holds test-USDC and unlock.
VIVEWORKER_BUYER_PRIVATE_KEY=0x... \
  node scripts/viveworker.mjs share pay https://share.viveworker.com/v/<slug> \
  --output ./paid-report.pdf

# Or ask the paired device to reauth and pay from the configured hazBase Smart Wallet.
node scripts/viveworker.mjs share pay https://share.viveworker.com/v/<slug> \
  --wallet hazbase \
  --output ./paid-report.pdf
```

`share pay` is human-in-the-loop by default. EOA mode fetches the 402 requirements,
pushes the amount, network, recipient, and resource URL to the paired phone,
and waits for approval before signing the EIP-3009 authorization. `--wallet
hazbase` sends the request to the paired phone, performs Passkey reauth there,
and pays via the configured hazBase Smart Wallet. Agents should not add
`--no-approval` unless the human explicitly asks for a trusted EOA smoke test /
CI run.

**Expected agent-side failures:**
- `hazbase-auth-required`: no local hazbase session is active. Ask the human to sign in via `Wallet`.
- `hazbase-wallet-account-missing`: the seller is signed in, but has not issued a wallet on that chain yet. Ask the human to issue it in `Wallet`.
- `unsupported-chain`: the requested chain is not wired for wallet payout resolution on this viveworker instance.

**A2A flow:**
1. Paste the `/v/<slug>` URL into the message body for the buying agent (via `viveworker a2a`, Moltbook comment, thread-share, or whatever transport applies).
2. The buyer's `WebFetch`-equivalent tool gets a `402 Payment Required` response with the x402 requirements body.
3. The buyer can run `viveworker share pay <url>` with `VIVEWORKER_BUYER_PRIVATE_KEY` / `BUYER_PK`, or use another x402-compatible client such as `x402-fetch`, Cursor's built-in browser, or Coinbase AgentKit. The CLI asks the paired phone to approve, then signs an EIP-3009 `transferWithAuthorization` and retries with an `X-PAYMENT` header.
4. The worker serves the content, sets a 15-minute `share_paid` cookie, and emits `X-PAYMENT-RESPONSE` with a settlement preview. Reloads within the 15 minutes skip the 402.

**Semantics:**
- **Closed-beta gate:** `--price` and `--pay-to` at upload time (and setting/rotating price via `update`) require the caller's userId to be on the worker's `X402_BETA_ALLOWLIST` secret. Non-beta users get `paid-shares-closed-beta` (403). Clearing price via `--no-price` is always allowed — removed users can still wind their shares down to public without re-approval.
- `--price` and `--password` are mutually exclusive on a single share (v1). Adding one to a share that has the other returns `price-and-password-mutually-exclusive`.
- Price range: `$0.01` min, `$1000` max per share. Below `$0.01` gas dwarfs the price; the `$1000` cap is an accident-cap, not a policy limit.
- Decimals: USDC has 6 decimals. `--price 0.10` → stored as atomic units `"100000"`; the CLI shows the USDC decimal back to the user.
- Network: driven by the worker's `X402_NETWORK` var (`base-sepolia` by default, flip to `base` for mainnet). The chainId is pinned per-share at upload time. **While in closed beta, only `base-sepolia` is in active use.**
- Trust: **pay-first, non-custodial.** viveworker never holds funds. Buyer sends USDC directly to `payTo` via the facilitator-broadcast transaction. No escrow, no dispute resolution — if the deliverable doesn't match the description, the buyer's recourse is to stop buying from that seller.
- Revocation: change the price (or call `--no-price`) to rotate `paymentSalt` and invalidate every outstanding paid session. Deleting the share (`share delete <slug>`) also works.

**Metrics (`share list --metrics`):** adds a "Paid-share metrics" block after the file list, summarising 24h / 7d counters for every payment-flow event (uploads, 402s served, verified paid views, paid-session reloads, verification rejections, facilitator unreachable, async settle failures). Drill-down shows the top 5 shares by activity. Data comes from Cloudflare Analytics Engine (worker writes events via `writeShareEvent`, CLI reads them via `/api/metrics`). Requires `CF_ACCOUNT_ID` and `CF_API_TOKEN` secrets on the worker — without them, the endpoint returns 501 `metrics-not-configured` and the CLI shows a warning.

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

## viveworker stats

One-shot adoption / usage snapshot. Aggregates four signals into a single readout:

```bash
# Human-readable summary
node scripts/viveworker.mjs stats

# Structured (pipe to jq / save to file / feed a dashboard)
node scripts/viveworker.mjs stats --json

# Point at a non-default npm package name
node scripts/viveworker.mjs stats --pkg some-other-pkg
```

Sections (each renders independently; an outage in one doesn't break the rest):

| Section | Source | What it shows |
|---|---|---|
| 📦 npm | `api.npmjs.org/downloads/range/last-month/<pkg>` + `registry.npmjs.org/<pkg>` | last 7d / prev 7d / last 30d downloads, week-over-week Δ%, latest version, publish count last 7d, per-day histogram in `--json`. **Caveat**: npm download totals are heavily mirror-driven — each new version publish triggers ~100 mirror re-fetches. Correlate `publishCountLast7` with suspiciously big daily spikes before reading too much into absolute numbers. |
| 🛰 a2a relay | `GET /stats/global` (public) + `GET /stats/<userId>` (X-A2A-Key) on `a2a.viveworker.com` | global user count, global 30d task counters, your own 30d + all-time task counters (received / completed / failed / rejected / canceled). |
| 🔗 share worker | `GET /api/list` on `share.viveworker.com` | live file count, quota (bytes + files), how many shares are password-gated or paid-gated. |
| 💬 moltbook (local) | `~/.viveworker/moltbook-inbox/*.json`, `moltbook-verify-history.jsonl`, `moltbook-scout-state.json` | inbox totals by status (replied / pending / skipped) + 7d/30d volume; verification attempts with solver-only vs solver+LLM success rates; scout 7d outcome breakdown (proposed / avoid-skipped / already-replied). |

### Credentials

Reuses `~/.viveworker/a2a.env` (same file `viveworker a2a` and `viveworker share` use). Missing file or missing `A2A_RELAY_USER_ID` / `A2A_API_KEY` → the a2a and share sections fall back to public-only (for a2a) or skip (for share), but npm and moltbook-local still render. No separate setup.

### When to use

- User asks "how's adoption / traction looking?" or "download numbers?"
- You just published a new npm version and want to watch mirror fallout
- You want a single-command sanity check before a demo or status update
- You want to feed a weekly metric snapshot into a report (use `--json`)

### Architecture

| Component | Location |
|-----------|----------|
| CLI | `scripts/stats-cli.mjs` |
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

### Natural-language triggers

When the user says things like:
- 「それを Codex の〇〇 に伝えて / 渡して / 共有して」
- 「〇〇 スレッドに forward して」
- "send that to codex [label]"
- "share that with [thread]"

…treat it as a request to POST the agent's **most recent assistant message** to the named thread as a `shareType: "message"`, reusing the existing `/api/threads/share` endpoint documented below.

**Resolution rules:**

1. **"それ" / "that"** — default to the agent's most recent assistant message in the current session (the reply the user just read). If the user points elsewhere explicitly ("the plan I wrote 3 turns ago"), use that span instead.

2. **Thread name** — call `GET /api/threads/list`, then match against the `label` field:
   - Unique exact or case-insensitive substring match → send directly.
   - Multiple matches → list the top candidates with `conversationId`, `tool`, and `lastSeenAtMs`, ask the user to pick.
   - No match → tell the user and list a few candidates as a hint.
   - If the user said "Codex" but the matched thread's `tool` is `claude-code` (or vice versa), surface the mismatch before sending.

3. **`shareType`** — default `"message"`. Upgrade only if the trigger explicitly asks:
   - 「handoff として」/ "as a handoff" → `"handoff"`, fill in `summary`/`completed`/`remaining`/`decisions`/`modifiedFiles` from conversation context.
   - 「plan review として」/ "as a plan review" → `"plan_review"`, fill in `plan`/`context`/`files`.

4. **`sourceLabel`** — auto-fill as `"<Tool name> (<cwd basename>)"`, e.g. `"Claude Code (viveworker)"`.

5. **Codex disconnected** (`codexConnected: false`) — still send (will fall through to the file inbox), but warn the user that delivery happens only once Codex reconnects.

6. **Always report back** the `shareId` and remind the user they can edit/approve/deny on the phone before delivery.

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
