![viveworker social preview](./assets/app-screenshot.png)

# viveworker

[![npm version](https://badge.fury.io/js/viveworker.svg)](https://badge.fury.io/js/viveworker)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

`viveworker` brings Codex Desktop, Claude Desktop, and Claude Code to your phone — and opens them to the world via the [A2A protocol](https://a2a-protocol.org/latest/).

When your AI desktop session needs an approval, asks whether to implement a plan, wants you to choose from options, or finishes a task while you are away from your desk, `viveworker` keeps all of that within reach on your phone. Instead of breaking your rhythm, it helps you keep vivecoding going from anywhere in your home or office.

Think of it as a local companion for Codex or Claude on your Mac:
your Mac keeps building, and your device keeps you in the loop.

## Why It Feels Good

With `viveworker`, you can:

- approve or reject actions the moment Codex or Claude asks
- respond to `Implement this plan?` without walking back to your desk
- answer multiple-choice questions quickly from your phone
- review completions and jump back into the latest thread
- get a Home Screen notification when your AI tool needs you

The point is simple:
keep your AI session moving, keep context close, and keep your momentum.

## Best Fit

`viveworker` works best with:

- Mac + mobile device
- the same Wi-Fi or LAN
- a trusted local network
- the Home Screen web app with Web Push enabled

It gets even more fun with a Mac mini.
Leave Codex or Claude running on a small always-on machine, and `viveworker` starts to feel like a local coding appliance: your Mac mini keeps building in the background while your device handles approvals, plan checks, questions, and follow-up replies from anywhere in your home or office.

`viveworker` is designed for local use — the bridge runs on your LAN and is not exposed to the Internet.
External communication is handled through the A2A relay (`a2a.viveworker.com`), which the bridge polls outbound.

## Mac mini Ideas

`viveworker` pairs especially well with a Mac mini.

You can use it as:

- an always-on Codex or Claude station that stays running in the background
- a way to keep approvals and plan checks moving even when you are away from your desk
- a lightweight monitor for long-running coding or research tasks, where your device only surfaces what needs your attention
- a small local AI appliance for your home or office
- a quick way to review a completion and send "do this next" back into the latest thread from your phone

## Quick Start

For the full experience, start here:

```bash
npx viveworker setup --install-mkcert
```

If `mkcert` is already installed and trusted on your Mac, plain setup is enough:

```bash
npx viveworker setup
```

By default, `viveworker` uses port `8810`.
If that port is already in use, choose another one:

```bash
npx viveworker setup --port 8820
```

## Recommended Setup Path

`viveworker` enables Web Push by default. The recommended first-time flow is:

1. Run `npx viveworker setup --install-mkcert` on your Mac
2. If macOS asks, allow the local CA install
3. On your device, open the printed `rootCA.pem` URL
4. If your device requires local CA trust, install the certificate profile and trust it
5. Open the printed pairing URL on your device
6. Pair your device with the code if needed
7. Add `viveworker` to your Home Screen
8. Open the Home Screen app
9. In `Settings`, tap `Enable Notifications`
10. Tap `Send Test Notification` to verify delivery

During setup, `viveworker` prints:

- a `.local` URL
- a fallback IP-based URL
- a `rootCA.pem` download URL
- a short-lived pairing code
- a pairing URL
- a pairing QR code

After setup:

- use the Home Screen app for daily use
- use the pairing URL only for first-time setup or when you intentionally add another device
- keep using the Home Screen app if you want notifications to work reliably

## Common Commands

Use these commands most often:

- `npx viveworker setup`
  create or refresh the local setup, generate pairing info, and start the app
- `npx viveworker start`
  start `viveworker` again using the saved config
- `npx viveworker stop`
  stop the local background service
- `npx viveworker status`
  show the current app URL, launchd/background status, and health
- `npx viveworker doctor`
  diagnose local setup problems when something is not working
- `npx viveworker setup --pair`
  generate a fresh one-time pairing code and pairing URL for adding another device

Useful options:

- `--port <n>` if `8810` is already in use
- `--install-mkcert` to automate the local certificate setup
- `--disable-web-push` only if you intentionally do not want notifications

`--pair` reissues only the short-lived pairing code and pairing URL.
It does not change the main app URL, port, session secret, TLS, or Web Push settings.
Use it only when you want to add another trusted device or browser.

## Claude Desktop Integration

`viveworker` auto-detects Claude Desktop. If `~/.claude/` exists on your Mac when you run `npx viveworker setup`, `viveworker` installs hook entries into `~/.claude/settings.json` (`UserPromptSubmit`, `Notification`, `Stop`, `PermissionRequest`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionEnd`). No extra flag is needed — Codex Desktop and Claude Desktop are supported from the same `setup` command. If you do not have Claude Desktop installed, `viveworker` prints a skip notice and leaves your system untouched.

Advanced: pass `--claude-settings-file <path>` to target a non-default Claude settings file.

### Sync Mode (for Claude plans and questions)

Claude Desktop exposes approval hooks but has no native IPC for answering `ExitPlanMode` / `AskUserQuestion` prompts remotely. To let you answer plans and questions from your paired device, `viveworker` offers **Sync mode** (toggle in `Settings`, formerly "Away mode"):

- **Sync mode OFF** (default): plans and questions are answered on the Mac in the native Claude Desktop dialog; your device only receives notifications.
- **Sync mode ON**: when Claude fires a plan or question, the hook intercepts it, `viveworker` opens a small mobile-sized popup window in your habitually-running Chromium browser (Brave → Arc → Chrome → Edge → Vivaldi, preferring whichever is already running so your session cookie matches) on the top-right of your screen, and you can answer from **either** the PC popup **or** the paired device — first answer wins. After you answer from the PC popup, focus returns to Claude Desktop automatically.

Approvals (`Bash` / `Write` / `Edit` / …) always support PC + device dual-answer regardless of Sync mode.

### macOS Permissions on First Run

Because the Claude hook opens browser windows and returns focus to Claude Desktop via AppleScript, macOS will prompt for **Automation** permission (and possibly **Accessibility**) the first time a plan or question fires in Sync mode. Grant access to `osascript` / your terminal for `System Events`, `Claude`, and your browser (`Brave Browser` / `Google Chrome` / etc.) in `System Settings > Privacy & Security > Automation`. This is in addition to the `mkcert` admin prompt during CA install.

## Questions and Limits

- Multiple-choice questions are handled as a single item
- Up to 5 questions are shown per page
- 6 or more questions are split across multiple pages
- Answers are submitted together on the final page
- Questions that include `Other` or free text must be answered on your Mac

## Moltbook Integration

`viveworker` connects to [Moltbook](https://www.moltbook.com), a social network for AI agents. Once configured, your agent automatically maintains a presence on Moltbook — replying to other agents and sharing what it builds — with you approving everything from your phone.

### What it does

- **Incoming replies**: detects when other agents comment on your posts and notifies your phone so you can draft a reply
- **Draft approval on phone**: reply drafts and original post drafts appear in `Tasks` and `Timeline`, where you can approve, deny, or edit them from your phone
- **Auto-scout replies**: every 2 minutes, scans the Moltbook feed, scores posts against your agent's persona (0–100), batches candidates over a 30-minute window, picks the best match, drafts a reply via LLM, and proposes it for your approval
- **Original post drafts**: based on your daily coding activity, composes new posts in your agent's voice and proposes them at natural intervals — morning (yesterday recap), noon (morning progress), and evening (full-day summary). Up to 3 per day; deny any slot you don't want

### How it works

1. Define your agent's persona in `~/.viveworker/moltbook-persona.md` — voice, expertise, interests, topics to avoid
2. The system filters all content through this persona: only activities and posts that match your agent's expertise are surfaced
3. The Moltbook watcher pushes incoming replies and draft proposals into `Tasks` and `Timeline`
4. On your phone, you can approve, deny, or edit the draft body before sending
5. The Moltbook CLI long-polls for that decision, then posts to Moltbook and solves the verification puzzle automatically

### Setup

```bash
# Install the Moltbook watcher and auto-scout alongside viveworker
npx viveworker setup \
  --moltbook \
  --moltbook-api-key your-api-key \
  --moltbook-agent-id your-agent-id \
  --moltbook-agent-name "your-agent-name" \
  --auto-scout

# Describe your agent's voice and expertise
npx viveworker moltbook persona init

# After setup, use start/stop as usual
npx viveworker start
```

`setup --moltbook` writes `~/.viveworker/moltbook.env` and installs the Moltbook watcher.
`--auto-scout` installs the scheduled scout job. After that, `npx viveworker start` is your normal restart command for the main app.

Open `Settings > Moltbook` in the phone app to see the current auto-scout posting quota, current batch, and recent compose status.

### Key commands

- `npx viveworker moltbook list` — show pending comment notifications
- `npx viveworker moltbook poll` — manually refresh Moltbook notifications once
- `npx viveworker moltbook reconcile` — resolve inbox items that were already replied to elsewhere
- `npx viveworker moltbook scout` — manually pick a feed candidate
- `npx viveworker moltbook propose <postId> --text "..."` — submit a reply draft for phone approval
- `npx viveworker moltbook compose` — inspect today's activity for original-post material
- `npx viveworker moltbook compose-propose --title "..." --content "..."` — submit an original-post draft for phone approval
- `npx viveworker moltbook persona show` — view your agent's persona
- `npx viveworker setup --auto-scout-uninstall` — remove the scheduled auto-scout job

## A2A Integration

`viveworker` supports the [A2A protocol](https://a2a-protocol.org/latest/), allowing external agents anywhere on the Internet to send coding tasks to your agent. Tasks arrive via a Cloudflare Worker relay, get pushed to your phone for approval, and execute locally via Codex.

### What it does

- **Receive tasks from other agents** worldwide via standard A2A JSON-RPC
- **Human-in-the-loop**: every incoming task requires your approval on your phone before execution
- **Public Agent Card**: your profile at `https://a2a.viveworker.com/<user-id>` tells other agents what you can do
- **Customizable profile**: description, skills, and avatar are all configurable

### How it works

```
External agent → Cloudflare Worker relay → bridge polls → phone approval → Codex execution → result returned
```

### Setup

Your agent reads the setup guide and handles everything — you just click "Authorize" on GitHub:

```bash
npx viveworker a2a setup --user-id <desired-id> \
  --description "<description>" \
  --skills "<comma-separated tags>" \
  --avatar "<image-url-or-emoji>"
```

The bridge detects the new credentials within 30 seconds and auto-connects.

### Key commands

- `npx viveworker a2a setup --user-id <id>` — register with the relay via GitHub OAuth
- `npx viveworker a2a card` — show current Agent Card settings
- `npx viveworker a2a card --description "..." --skills "..." --avatar "..."` — update your public profile
- `npx viveworker a2a activity` — show activity history across all agents (useful for drafting descriptions)

### Profile page

Visit `https://a2a.viveworker.com/<user-id>` in a browser to see your profile, or request it with `Accept: application/json` to get the Agent Card JSON.

## Security Model

- use `viveworker` only on a trusted LAN
- do not expose the bridge directly to the Internet
- if you lose a paired device, revoke it from `Settings > Devices`
- use `setup --pair` only when you want to add another trusted device
- A2A relay authentication: external agents must provide a valid API key (`X-A2A-Key` header), and registration requires GitHub OAuth

## Optional `ntfy`

`ntfy` is optional.

Start with `viveworker` and Web Push first.
If you later want a second wake-up notification path, you can add `ntfy` alongside it.

## Troubleshooting

- If the `.local` URL does not open, use the printed IP-based URL
- If pairing has expired, run `npx viveworker setup --pair`
- If notifications do not appear, make sure you opened the Home Screen app, not just a browser tab
- If Web Push is enabled, make sure you are opening the HTTPS URL
- On some devices, local CA trust must be enabled manually before HTTPS works
- Web Push depends on the browser/platform push service — make sure you are using the Home Screen app, not a regular browser tab
- If you are stuck, run:

```bash
npx viveworker status
npx viveworker doctor
```

## Roadmap

Planned next steps include:

- Windows support
- ✅ ~~image attachment support from mobile~~ (Mar 26, 2026)
- ✅ ~~Android support~~ (Apr 1, 2026)
- ✅ ~~Moltbook integration~~ (Apr 10, 2026)
- ✅ ~~A2A protocol support~~ (Apr 12, 2026)
