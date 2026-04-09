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

### Troubleshooting

- `MOLTBOOK_API_KEY missing` → check that `~/.viveworker/moltbook.env` exists and is readable.
- `moltbook 4xx` → suspect an expired API key or an endpoint change.
- Watcher isn't picking up notifications → `tail -f /tmp/viveworker-moltbook-watcher.{out,err}.log` and `launchctl list | grep moltbook`.
