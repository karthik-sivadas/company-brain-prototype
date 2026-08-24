#!/usr/bin/env bash
# Runs the Slack bridge on Node.
#
# The bridge cannot run on Bun: @slack/socket-mode opens its websocket with undici's
# WebSocket and detects pongs via the `undici:websocket:pong` diagnostics channel.
# Bun resolves `undici` to a built-in shim with no WebSocket, and its native WebSocket
# never publishes to that channel, so the heartbeat would fail and reconnect forever.
#
# Node >= 22 is required for `--experimental-transform-types` (TypeScript is executed
# directly, no build step) and for `--env-file`. Many machines have an old `node` first
# on PATH, so this prefers the newest suitable nvm install over the PATH default.
set -euo pipefail

MIN_MAJOR=22

major() { "$1" --version 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

NODE_BIN=""
if command -v node >/dev/null 2>&1 && [ "$(major node)" -ge "$MIN_MAJOR" ] 2>/dev/null; then
  NODE_BIN="$(command -v node)"
else
  for candidate in $(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n -r); do
    bin="$HOME/.nvm/versions/node/v$candidate/bin/node"
    if [ -x "$bin" ] && [ "$(major "$bin")" -ge "$MIN_MAJOR" ]; then NODE_BIN="$bin"; break; fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo "  ✗ need Node >= $MIN_MAJOR to run the Slack bridge (found: $(node --version 2>/dev/null || echo 'no node'))" >&2
  echo "    install one, e.g.  nvm install $MIN_MAJOR" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
[ -f .env ] || { echo "  ✗ .env not found — see docs/slack-setup.md" >&2; exit 1; }

exec "$NODE_BIN" \
  --experimental-transform-types \
  --env-file=.env \
  --disable-warning=ExperimentalWarning \
  src/cli.ts slack "$@"
