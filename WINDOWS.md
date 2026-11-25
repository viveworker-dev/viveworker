# Windows support

Experimental native Windows support is being developed on
`windows/mcp-support`. The local bridge lifecycle, stdio MCP transport, named-pipe
IPC initialization and native SQLite reads have been exercised on Windows.
Phone approval and notification flows still need end-to-end device validation.

## Requirements

Install a supported [Node.js LTS runtime](https://nodejs.org/en/download) using
the Windows installer, then reopen the terminal. See the README for the minimum
patched Node.js versions. A Node.js binary bundled inside another application
may not include npm/npx.

From this checkout, install the locked dependencies:

```powershell
npm ci --ignore-scripts
```

Git is needed for code review/diff features. Windows' built-in curl is used for
health checks. Windows history reads use Node.js SQLite in a worker and do not
require a separate sqlite3 executable.

## Run the bridge locally

```powershell
node scripts/viveworker.mjs setup --disable-web-push
node scripts/viveworker.mjs status
node scripts/viveworker.mjs restart
node scripts/viveworker.mjs pair
node scripts/viveworker.mjs stop
```

This setup binds HTTP to `127.0.0.1` and does not enable phone notifications.
Use the printed local URL to inspect the UI. After stopping it, run:

```powershell
node scripts/viveworker.mjs start
```

Windows starts a detached background Node.js process with its console hidden.
It continues after the terminal closes. It is **not** a Windows Service and does
not yet start automatically at sign-in or after a reboot.

Default state lives under `%USERPROFILE%\.viveworker`:

- `config.env`: configuration.
- `logs\viveworker.log`: bridge output.
- `viveworker.pid`: JSON process identity and a private control token.

Use the same `--config-dir <directory>` on every lifecycle command when testing a
separate configuration. `setup` stops an existing managed instance before
replacing its configuration. Repeating `start` keeps the same healthy instance;
`restart` waits for it to exit before starting a new one.

Stop is authenticated over a per-launch local control pipe. It requests normal
shutdown, closes browser connections and flushes pending state. A numeric PID
file from an older version does not authorize killing a process. Stale records
from exited processes are recovered automatically; live unverified processes
are left alone. A shutdown timeout retains the process record for inspection
and a later retry. If a CLI command crashes while holding a
`viveworker.pid.lock`, confirm no lifecycle command is still running before
removing that lock.

## Codex IPC

Windows uses `\\.\pipe\codex-ipc` instead of a Unix-domain socket. Setup saves
the endpoint in `CODEX_IPC_SOCKET_PATH`; an existing or environment-supplied
override takes precedence. Named-pipe paths are preserved without filesystem
normalization.

On 2026-11-23, a read-only initialize handshake succeeded against the installed
Windows Codex app (package version 26.1111.2228.0). The integration test also
starts the real bridge against an isolated mock named pipe. This confirms the
transport and initialization, not a complete phone approval round trip. Codex's
private desktop IPC may change between app releases.

## HTTPS and phone testing

Windows does not use Homebrew to install mkcert. Install `mkcert.exe` using the
[upstream instructions](https://github.com/FiloSottile/mkcert#installation), add
its directory to PATH, then use:

```powershell
mkcert -install
node scripts/viveworker.mjs setup
```

Setup resolves the CA directory using `mkcert -CAROOT`, generates the TLS/VAPID
assets and prints an IP-based LAN URL. The phone must trust the local CA and
complete pairing; Windows Firewall must allow the selected port on the trusted
private network. Existing `--tls-cert-file` / `--tls-key-file` options also work
for manually supplied certificates. Actual phone pairing, Web Push and approval
delivery have not yet been validated on this Windows build.

## Register this checkout as an MCP server

```powershell
node scripts/viveworker.mjs mcp config --local
node scripts/viveworker.mjs enable mcp --target codex --local --dry-run
node scripts/viveworker.mjs enable mcp --target codex --local
```

The last command previews the change and asks before writing. Restart the MCP
client afterward. Use `--target claude` or `--target cursor` for those clients.

`--local` pins the current Node.js executable and this checkout's MCP entry point,
so launch does not need npx. Re-register after moving the checkout or
upgrading/removing the pinned Node.js installation. This registration does not
start the bridge or pair a phone.

Without `--local`, Windows entries use
`cmd.exe /d /c npx -y viveworker mcp`, which requires npm/npx and downloads the
published package rather than running this checkout's changes.

Configuration locations:

- Claude Desktop: `%APPDATA%\Claude\claude_desktop_config.json`, with a
  `%USERPROFILE%\AppData\Roaming` fallback.
- Cursor: `%USERPROFILE%\.cursor\mcp.json`.
- Codex: `%CODEX_HOME%\config.toml`, or `%USERPROFILE%\.codex\config.toml`.
- Existing `VIVEWORKER_MCP_*_CONFIG_FILE` overrides still take precedence.

For a custom bridge configuration directory, set `VIVEWORKER_CONFIG_ENV` in the
MCP server's environment to that directory's `config.env`.

## Validation

```powershell
node --test --test-timeout=90000 scripts/test/windows-lifecycle.test.mjs scripts/test/managed-bridge.test.mjs scripts/test/platform.test.mjs scripts/test/sqlite-query.test.mjs scripts/test/mcp-config.test.mjs scripts/test/mcp-launch.test.mjs scripts/test/mcp-enable.test.mjs scripts/test/mcp-server.test.mjs scripts/test/node-runtime.test.mjs scripts/test/node-runtime-gate.test.mjs scripts/test/length-prefixed-frame-decoder.test.mjs scripts/test/ipc-message-projector.test.mjs scripts/test/completed-inbox-codex.test.mjs
```

These tests use temporary profiles/configurations, loopback HTTP and mock Codex
IPC. They do not modify the user's MCP settings or send real phone approvals.
The launchd diagnostic fixture requires a POSIX shell and is skipped on Windows.

## Remaining work

- Validate HTTPS pairing, Web Push and a real phone approval round trip.
- Add optional sign-in startup and a supported update/uninstall flow.
- Port Claude hooks, session discovery and browser/focus behavior. Automatic
  Claude hook installation is skipped on Windows; explicit hook installation
  fails before modifying settings.
- Port Moltbook scheduling and A2A harness execution, and audit remaining
  Mac-specific file-copy/browser helpers. MCP transport availability does not
  imply that every downstream integration is Windows-compatible.
- Adapt the bundled plugin's static npx entry. Use CLI registration for now.

`enable claude`, `enable moltbook`, `enable scout` and automated `update`
currently report their Windows limitation instead of applying Mac-specific
configuration.
