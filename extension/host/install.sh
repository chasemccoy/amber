#!/bin/bash
# Register amber's native-messaging host with installed Chromium browsers (macOS).
# Run once after loading the unpacked extension. Safe to re-run.
set -euo pipefail

HOST_NAME="org.chsmc.amber"
EXTENSION_ID="nogcgdhgbamkbilpcibcklkkmmkfgfdo"

DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="$DIR/amber-host.sh"
chmod +x "$LAUNCHER"

read -r -d '' MANIFEST <<JSON || true
{
  "name": "$HOST_NAME",
  "description": "amber archiver native messaging host",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
JSON

SUPPORT="$HOME/Library/Application Support"
# Browser profile roots whose NativeMessagingHosts dir we register into.
BASES=(
  "$SUPPORT/Google/Chrome"
  "$SUPPORT/Google/Chrome Canary"
  "$SUPPORT/Chromium"
  "$SUPPORT/BraveSoftware/Brave-Browser"
  "$SUPPORT/Microsoft Edge"
  "$SUPPORT/Arc/User Data"
)

installed=0
for base in "${BASES[@]}"; do
  [ -d "$base" ] || continue
  target="$base/NativeMessagingHosts"
  mkdir -p "$target"
  printf '%s\n' "$MANIFEST" > "$target/$HOST_NAME.json"
  echo "registered → $target/$HOST_NAME.json"
  installed=$((installed + 1))
done

if [ "$installed" -eq 0 ]; then
  echo "No supported browser profile dirs found under: $SUPPORT" >&2
  exit 1
fi

echo
echo "Done. Extension ID: $EXTENSION_ID"
echo "Launcher: $LAUNCHER"
echo "If you haven't yet: copy host.env.example → host.env and add your ANTHROPIC_API_KEY."
