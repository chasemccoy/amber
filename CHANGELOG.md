# Changelog

## 0.8.6 — 2026-09-26

- `currentScript.src` is the resolved absolute URL again (Next's
  `getAssetPrefix` does `new URL(src)`); 0.8.5 returned the root-relative
  form there too and the app died one step after booting.

## 0.8.5 — 2026-09-26

- Follow-up to 0.8.4: Turbopack keys chunks by `currentScript.getAttribute('src')`
  *as written* (root-relative for same-origin chunks), not by the resolved
  URL — the shim now hands that form back, and recognises chunks the runtime
  injected itself (src already mapped to a local copy) by reverse lookup.

## 0.8.4 — 2026-09-26

- **Keep-js works for Turbopack/Next.js apps.** The single-file inliner
  strips `src` from scripts, but Turbopack's runtime identifies the chunk
  that just ran by `document.currentScript.src` — every chunk registration
  rejected and the app never booted (anthropic.com). Inlined scripts now
  carry their original URL as `data-amber-src` and the shim serves it back
  through `currentScript`, resolved against the archive's own location.
- Analytics iframes (Segment's `isolated-segment.html`) are removed in
  keep-js mode like tracker scripts.

## 0.8.3 — 2026-09-26

- Browser renders wait for `load` and then give network-idle a 15s settle
  window instead of requiring it: pages with analytics heartbeats or
  long-polling never go idle and were failing the whole capture with
  `page.goto: Timeout exceeded`.

## 0.8.2 — 2026-09-26

- A slug folder holding leftovers but no valid snapshot (an `assets/` tree
  with no `index.html`/`manifest.json`, as an interrupted copy leaves) no
  longer makes the archive fail with `ENOTEMPTY` — it is cleared and the new
  capture promoted over it; `versions/` is untouched.

## 0.8.1 — 2026-09-20

- `--overwrite` on a historical version now replaces the folder's *contents*
  and keeps the directory itself (the way the root has always been
  overwritten). 0.8.0's rename-aside-then-delete still left an empty
  `<id> 2` twin behind when `~/Documents` is synced by iCloud Drive: any
  deletion of a folder the sync hasn't reconciled yet gets it resurrected.

## 0.8.0 — 2026-09-20

- **Historical versions via the Wayback Machine.** `amber --at 2009-06 <url>`
  (or `--at latest`, or just a pasted `web.archive.org` URL — the extension's
  button on a Wayback page does the same) archives a page as it *was*. Built
  on Wayback's raw `id_` mode: the capture's original bytes, no toolbar or
  rewriting, with every asset fetched through the archive at the served
  timestamp. Filed under the original URL's slug and dated by the snapshot
  (`snapshotAt`), so live and historical captures of one page form a single
  timeline: a capture older than the current latest goes straight into
  `versions/` and the root keeps the newest. The library index dates such
  rows by the snapshot with a "wayback" mark. With `--keep-js` the historical
  page is rendered in Chromium with every request answered from the archive,
  so its era's JavaScript runs against its era's assets; `--overwrite` on a
  historical capture replaces that version in place.
- **Non-UTF-8 pages decode correctly now.** `Response.text()` decodes UTF-8
  unconditionally; amber now honours the declared charset (header, then
  `<meta>`, with browser-like fallbacks) — Latin-1, windows-1252 smart quotes,
  Shift_JIS, EUC-JP — and rewrites the archive's charset declaration to UTF-8
  so browsers read what amber wrote. Affects any non-UTF-8 page, not just
  historical ones.
- Fetches retry transient network errors and 429/5xx with backoff; Wayback
  requests are spaced out and identify amber in the User-Agent.
- **Keep-js replay covers 2010-era JavaScript.** The shim now remaps `url()`
  in runtime-set inline styles (jQuery carousels swapping root-relative
  backgrounds), runtime-created `<script src>`, and tags injected via
  `document.write` (CDN jQuery, analytics) through the asset map — unrecorded
  ones fail closed like every other load. The asset map is the first thing in
  `<head>` and a lookup before it exists is no longer cached as a permanent
  miss. Tracker scripts are stripped *before* the keep-js render too, so the
  recording runs exactly the code the archive replays (a tracker's
  `Math.random` draws were shifting every seeded choice after it). The
  classic Google Analytics snippets and TellApart are recognised as trackers.
- A render's non-2xx responses are no longer recorded as assets — a 404's
  error page (a full HTML document from the Wayback Machine) was being
  inlined into the `<script>` it stood in for.
- **Hardening from review.** `--overwrite` on a historical capture swaps the
  version in by rename (delete-then-recreate left an empty `<id> 2` twin
  behind under iCloud-synced Documents); a historical capture byte-identical
  to today's root is still filed (the page was already like this then); a
  pre-`capturedAt` root is dated by its mtime so an older capture can't
  displace it; same-second dedupe checks every `-N` sibling. A Wayback
  redirect off the archive is an error rather than an archive of wherever it
  landed; calendar/wildcard `web.archive.org` URLs and an empty `--at` are
  rejected up front; the extension's popup points at the filed version.
  Retries no longer replay deterministic failures (bad URL, redirect loop).
  `<meta>` charset sniffing ignores comments and `charset=` prose in
  unrelated meta tags; CSS files are decoded by their own charset (`@charset`,
  header) and written as UTF-8. A slug can no longer be `.` or `..`.

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
