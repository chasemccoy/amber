#!/usr/bin/env bash
# Regenerate the full, self-contained example archives locally (assets and all).
# Run from the project root. Needs `pnpm install` first; the wordcamp run needs a
# Playwright browser (`pnpm exec playwright install chromium`) and the media download
# needs yt-dlp + a normal (non-datacenter) network.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> media-swap-demo (synthetic page, real downloaded clip)"
pnpm exec tsx examples/build-media-swap-demo.ts

echo
echo "==> wordcamp-llms (Playwright render + the committed cleanup plan)"
pnpm archive --plan examples/wordcamp-llms/plan.json -o /tmp/rebuild \
  https://simonwillison.net/2023/Aug/27/wordcamp-llms/

echo
echo "Full self-contained folder: /tmp/rebuild/simonwillison.net-2023-Aug-27-wordcamp-llms/"
echo "Open its index.html in a browser."
