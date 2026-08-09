# Changelog

## 0.7.0 — 2026-08-09

- **The library** — the archive root now maintains a browsable `index.html` of
  everything saved: thumbnail, title, site, date, tags, keep-js/static badge,
  version count, size, and a filter box. Derived entirely from the slug
  folders' manifests (no database); rebuilt after every archive and by the new
  **`amber index`** command after hand-pruning.
- **Thumbnails** — every archive gets a `thumbnail.jpg`: the live render's
  viewport when a browser ran, else a screenshot of the built archive itself.
  Excluded from the content hash, so identical re-captures still dedupe.
- **Tags file, not describe** — tagging now aims at a personal library's
  filing system: discipline-altitude, 3-5 per page, spaces over hyphens, no
  borrowed marketing vocabulary or incidental person names. Every planning
  call sees the library's existing vocabulary, so tags converge on one
  folksonomy instead of coining synonyms per page.
- `slugifyUrl` de-fangs macOS bundle extensions — archiving `linear.app` now
  produces a `linear-app` folder Finder can actually open.

## 0.6.0 — 2026-08-08

- **Keep-js mode: living archives.** Pages whose presentation *is* their
  JavaScript (WebGL scenes, scroll choreography, generative art) previously
  archived as broken skeletons. Claude's plan now carries a `preserveRuntime`
  judgement and the pipeline escalates automatically (`--keep-js` forces,
  `--no-keep-js` forbids): module scripts are flattened into one classic
  bundle (esbuild, a new optional peer dep), the recorded browsing session
  replays offline through an injected shim, and the archive collapses into a
  single self-contained `index.html` with assets inlined as `data:` URIs — so
  canvas and WebGL run from a double-clicked file. Verified against pear.no,
  bruno-simon.com (Draco workers + Rapier WASM), lusion.co, pudding.cool, and
  linear.app.
- Archives past ~200MB of assets keep the folder layout and get a
  double-clickable **`View archive.command`** launcher; the new
  **`amber serve`** subcommand serves any archive over localhost.
- Keep-js archives fail closed: unrecorded requests get a synthetic 504 or an
  inert `data:` URI, never the network.
- **`bin/amber.js` fails fast on Node < 24** with a plain message instead of
  an opaque dependency stack trace.
- `amber doctor` reports esbuild alongside Playwright/yt-dlp/ffmpeg.

## 0.5.0 — 2026-07-25

- **New `amber agent <url>`** — the escalation path for pages the one-shot
  pipeline gets wrong: Claude cleans the page interactively (outline, inspect,
  remove, swap media, finalize) instead of returning a single plan. Previously
  repo-checkout-only; now in the npm package. Needs `ANTHROPIC_API_KEY` and
  Playwright; costs more (many model calls). `amber agent --help` for details.
- **`amber --help` and `--version` now exist.** Both previously crashed with a
  stack trace; unknown flags now print the message plus usage instead.
- The CLI honors **`AMBER_MODEL`** as the default for `--model`.
- README: documented the wrong-archive escalation ladder (read `plan.json` →
  edit + `--plan` replay → `amber agent`) and added a sample run.

## 0.4.1 — 2026-07-25

- Publishes now carry an npm **provenance attestation** — the npm page shows
  "Built and signed on GitHub Actions" linking to the exact source commit.
  Declared in `publishConfig`, so it's attached on every future release.

## 0.4.0 — 2026-07-25

- **Requires Node ≥ 24** (the current LTS). Node 20 reached end-of-life in
  April 2026; nothing else changed, but installs on older Nodes now warn.

## 0.3.0 — 2026-07-25

First installable release.

- Published to npm as **`in-amber`**; installs an `amber` command
  (`npm install -g in-amber`, or one-off via `npx in-amber <url>`).
- Real build step (tsup → `dist/` + rolled-up type declarations); the package
  ships only `bin/` and `dist/`.
- **Playwright is now optional** — a bare install is ~28 MB and captures
  statically; JS-rendered pages prompt a one-time
  `npm install -g playwright && playwright install chromium`. Auto mode
  degrades to the static capture instead of failing when Playwright is absent.
- New **`amber doctor`** — reports API key, Playwright/Chromium, yt-dlp,
  ffmpeg, and archive-directory status, with what each missing piece costs.
- Expected failures (missing optional deps, bad flags) print a plain message
  instead of a stack trace.

## 0.2.0 and earlier

Personal-use era: capture/plan/clean/package pipeline, agent mode, browser
extension, snapshot versioning, evals. See git history.
