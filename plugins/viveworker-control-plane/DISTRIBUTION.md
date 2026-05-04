# Codex Plugin Distribution Checklist

This checklist tracks the release readiness for the `viveworker-control-plane` Codex plugin.

## Plugin package

- Plugin name: `viveworker-control-plane`
- Display name: `viveworker`
- Version: `0.8.1`
- Category: `Productivity`
- Developer name: `viveworker team`
- Contact: `hello@viveworker.com`
- Website: `https://viveworker.com/`
- Repository: `https://github.com/viveworker-dev/viveworker`
- License: `MIT`
- Plugin manifest: `plugins/viveworker-control-plane/.codex-plugin/plugin.json`
- Marketplace entry: `.agents/plugins/marketplace.json`

## User-facing positioning

Short description:

> Control Codex, Claude, and agent tasks from your phone.

Long description:

> Pair your phone with viveworker to control Codex, Claude, File Share, Thread Share, A2A tasks, and social posting workflows like Moltbook. Approve actions, answer questions, receive updates, share deliverables, delegate work, and keep agent work moving without being tied to your computer.

## Included capabilities

- MCP stdio server config via `plugins/viveworker-control-plane/.mcp.json`
- Codex skill guidance via `plugins/viveworker-control-plane/skills/viveworker-control-plane/SKILL.md`
- Plugin logo and composer icon via `plugins/viveworker-control-plane/assets/viveworker-logo-v2.png`
- First-run guidance for setup, pairing, MCP status checks, and smoke notifications
- Tool policy for ask, approval, notify, File Share, Thread Share, and A2A delegation

## Security posture

- MCP is stdio-only.
- No HTTP MCP server is exposed by the plugin.
- The plugin does not execute arbitrary shell commands.
- File Share requires phone approval and is restricted by viveworker's path safety rules.
- A2A task sending uses registered target aliases and requires phone approval.
- Secrets, credentials, private keys, relay tokens, public keys, file contents, and command text must not be sent through plugin guidance or central analytics.

## Local validation

Run these before proposing a plugin release:

```bash
node -e "JSON.parse(require('fs').readFileSync('plugins/viveworker-control-plane/.codex-plugin/plugin.json','utf8')); JSON.parse(require('fs').readFileSync('.agents/plugins/marketplace.json','utf8')); JSON.parse(require('fs').readFileSync('plugins/viveworker-control-plane/.mcp.json','utf8')); console.log('ok')"
npm pack --dry-run
```

Manual smoke:

1. Add the local marketplace to Codex.
2. Enable `viveworker-control-plane@viveworker`.
3. Restart Codex.
4. Confirm the plugin is visible.
5. Call `viveworker_status`.
6. Send a `viveworker_notify` smoke message.
7. Confirm the phone receives the notification and the timeline records `provider: "mcp"`.

## Codex local marketplace config

```toml
[marketplaces.viveworker]
source_type = "local"
source = "/path/to/viveworker"

[plugins."viveworker-control-plane@viveworker"]
enabled = true
```

## Public distribution readiness

Ready:

- Plugin manifest exists and has production metadata.
- Marketplace entry exists for local testing.
- MCP config uses `npx viveworker mcp`.
- Skill guidance is bundled.
- Logo assets are bundled.
- npm package includes the plugin directory.

Open items before formal marketplace submission:

- Confirm the current Codex plugin marketplace submission channel and required review format.
- Confirm whether marketplace reviewers require screenshots, a privacy summary, or a demo video.
- Confirm whether plugin version should track npm version for every patch release.
- Confirm whether `policy.authentication` should remain `ON_INSTALL` or move to `ON_USE` if the marketplace review prefers deferred setup.

## Suggested submission blurb

viveworker is an AI agent lifecycle control plane that lets developers run Codex, Claude, File Share, Thread Share, A2A delegation, and Moltbook workflows from a paired phone. The Codex plugin bundles MCP configuration and agent guidance so Codex can ask questions, request approvals, send mobile notifications, share deliverables, hand off context, and delegate tasks through viveworker without requiring users to manually wire the workflow together.
