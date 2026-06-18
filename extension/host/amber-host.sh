#!/bin/bash
# Native-messaging launcher for amber. Chrome executes this file directly (the
# path in the host manifest points here), so it must be executable and must not
# write anything to stdout except by exec'ing the host, which speaks the
# native-messaging protocol there.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"

# Chrome launches the host with a minimal environment, so load secrets/config
# (ANTHROPIC_API_KEY, AMBER_ARCHIVE_DIR, AMBER_INSECURE_TLS, AMBER_MODEL, and
# optionally AMBER_NODE) from a local, git-ignored file if it exists.
if [ -f "$DIR/host.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$DIR/host.env"
  set +a
fi

# amber needs Node >= 20 (undici 7). The bare PATH Chrome hands us often resolves
# to an old default (e.g. an nvm shim), so pick a good Node explicitly.
is_node20() { "$1" -e 'process.exit(+process.versions.node.split(".")[0]>=20?0:1)' >/dev/null 2>&1; }
pick_node() {
  local c
  for c in \
    "${AMBER_NODE:-}" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$(command -v node 2>/dev/null || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && is_node20 "$c" && { echo "$c"; return 0; }
  done
  return 1
}

NODE_BIN="$(pick_node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "amber host: no Node >= 20 found. Set AMBER_NODE in host.env." >&2
  exit 1
fi

# Put the chosen Node first so tsx's `#!/usr/bin/env node` shebang resolves to it.
export PATH="$(dirname "$NODE_BIN"):$PATH"
exec "$REPO/node_modules/.bin/tsx" "$DIR/amber-host.ts"
