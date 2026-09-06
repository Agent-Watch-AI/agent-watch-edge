#!/bin/bash
# Deploy AgentWatch Edge to a macOS fleet — Jamf script policy (also works as a
# Kandji custom script or a Mosyle custom command).
#
# Runs as root. Installs the package machine-wide, then enrolls as the *logged-in*
# user: the Edge writes into that person's own agent configuration and attributes
# turns to their identity, so an enrollment run as root would configure root's
# agents and nobody else's.
#
# Jamf script parameters:
#   $4  backend base URL       e.g. https://backend.example.com
#   $5  enrollment token
#
# Pass the token as a Jamf parameter rather than editing it in, and let setup read
# it from AGENTWATCH_TOKEN rather than from --token: argv is visible to `ps` for
# the life of the process, and this script runs on a machine its owner controls.
# The same reason rules out `env AGENTWATCH_TOKEN=... setup` — that puts the token
# right back in argv, of both sudo and env. It is exported and carried across the
# privilege drop with --preserve-env instead, where reading it needs the target
# user or root.
#
# Exit codes: 0 installed and verified · 1 install failed · 2 nobody logged in
# · 3 enrolled but doctor reported a problem.

set -euo pipefail

ENDPOINT="${4:-}"
TOKEN="${5:-}"
PACKAGE="@agent-watch-ai/edge"
BIN=/usr/local/bin/agentwatch

if [ -z "$ENDPOINT" ] || [ -z "$TOKEN" ]; then
  echo "usage: $0 <mount> <computer> <user> <endpoint> <token>" >&2
  exit 1
fi

# Until the signed native package ships, install through npm. Only this block
# changes when it does; the managed policy file does not change at all.
if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found: install Node.js 20+ before this policy" >&2
  exit 1
fi

npm install -g --no-fund --no-audit "$PACKAGE"

# Not `[ -x "$BIN" ] || BIN=$(command -v ...)`: under `set -e` a failed lookup
# ends the script with no message at all.
if [ ! -x "$BIN" ]; then
  BIN=$(command -v agentwatch || true)

  if [ -z "$BIN" ]; then
    echo "agentwatch not on PATH after install; check the npm global prefix" >&2
    exit 1
  fi
fi

# The console user, not $USER: a root script has no logged-in identity of its own.
CONSOLE_USER=$(stat -f%Su /dev/console)

if [ -z "$CONSOLE_USER" ] || [ "$CONSOLE_USER" = "root" ]; then
  echo "no console user; re-run this policy at login" >&2
  exit 2
fi

# --yes suppresses every prompt, including the developer-email one. The identity
# falls back to that user's `git config user.email`; setup refuses rather than
# installing something it cannot attribute, which is what makes the exit code
# below meaningful.
export AGENTWATCH_TOKEN="$TOKEN"
sudo --preserve-env=AGENTWATCH_TOKEN -u "$CONSOLE_USER" "$BIN" setup --endpoint "$ENDPOINT" --yes
unset AGENTWATCH_TOKEN

# Verify rather than assume. `doctor` exits non-zero on a real problem — a hook
# command that does not resolve, an unreachable backend, a missing identity.
# shellcheck disable=SC2024  # the redirect is meant to run as root; sudo only
# drops privileges for the command that produces the report.
if ! sudo -u "$CONSOLE_USER" "$BIN" doctor --json > /var/log/agentwatch-doctor.json; then
  echo "enrolled, but doctor reported a problem; see /var/log/agentwatch-doctor.json" >&2
  exit 3
fi

echo "AgentWatch enrolled for $CONSOLE_USER"

# Codex, if present, still needs one manual step this script cannot perform: the
# developer runs `codex`, then `/hooks`, and trusts the AgentWatch entries. Say so
# in the rollout note, or Codex turns go unreported with everything looking fine.
