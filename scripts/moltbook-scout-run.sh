#!/usr/bin/env bash
# Provider-neutral entry point for one Moltbook scouting pass.
#
# Outputs a JSON candidate (or status) on stdout. The calling agent
# (Codex Desktop, Claude Desktop, Claude Code, or a human) is expected
# to read the candidate, draft a reply, and then run:
#
#   node scripts/viveworker.mjs moltbook propose <postId> --text "<draft>"
#
# Pass any extra flags through, e.g. --max-daily 3 --submolts builds,tooling
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
exec node scripts/viveworker.mjs moltbook scout "$@"
