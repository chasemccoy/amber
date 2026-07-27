<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/amber-lockup-dark.svg">
    <img src=".github/assets/amber-lockup-light.svg" alt="Amber" height="48">
  </picture>
</p>

<p align="center">Save any web page as a clean, self-contained offline copy —<br>one folder, no junk, no callbacks to the live web.</p>

<hr />

Amber turns a URL into a folder you own: a single `index.html` with every image, stylesheet, font, and video pulled local, and the clutter — ads, cookie banners,
trackers, newsletter popups, analytics scripts — stripped away. Open it in ten
years with the network unplugged and it still just works.

The mechanical half (render, download, rewrite, package) is deterministic
TypeScript. The judgement half — *what's junk? what's the real content? which
embed is a video worth keeping?* — is handled by Claude and written out as a
`plan.json` you can read, edit, and replay.

## Features

- 📦 **One self-contained folder per page** — `index.html` + a local `assets/` tree, every reference rewritten to a relative path.
- 🧹 **De-junked** — ads, cookie/consent banners, share bars, newsletter popups, and tracking scripts removed; the page's own structure (header, nav, footer, bylines) kept.
- 🔌 **Genuinely offline** — scripts and connection/preload hints (`preconnect`, `modulepreload`, `prefetch`, …) are stripped, so an opened archive makes no background requests.
- 🎥 **Real media, not dead embeds** — a YouTube/Vimeo embed becomes a downloaded local `<video>` (via yt-dlp); self-hosted clips are localised too.
- 🧠 **Claude does the judgement** — and writes it to an auditable `plan.json` you can edit and re-apply.
- 🏷️ **Auto-tagged** — Claude reads the page and adds topical tags to the manifest for later browsing and search.
- 🌐 **Handles JS-rendered pages** — headless Chromium (Playwright) capture, used only when a page actually needs it.
- 🕵️ **An escalation path for stubborn pages** — `amber agent` has Claude clean the page interactively, tool call by tool call, when the one-shot plan isn't enough.

## Quick start

```bash
npm install -g in-amber
export ANTHROPIC_API_KEY=...   # optional — falls back to heuristics without it

amber https://example.com/some-post
```

(Or without installing: `npx in-amber <url>`.)

A run narrates every decision it makes — nothing is interactive, everything is
overridable next time:

```
[1/4] Fetching https://example.com/some-post (static probe)
      2841 chars of visible text — static capture is enough
[2/4] Asking Claude for a cleanup plan
[3/4] Removing junk, then downloading assets and rewriting references
      removed 12 elements; 31 assets, 0 errors
[4/4] Downloading embedded media
      1 media item(s)

Archive written to: ~/Documents/Archives/example.com-some-post/
  open ~/Documents/Archives/example.com-some-post/index.html
```

Archives land in `~/Documents/Archives/<slug>/` by default (override with `-o`
or `AMBER_ARCHIVE_DIR`). Run `amber doctor` to see what your setup can do — every
optional piece degrades gracefully:

- **`ANTHROPIC_API_KEY`** — without it, cleanup uses heuristics instead of
  Claude's judgement. With it, you pay per archive on your own key: typically a
  few cents per page (one planning call; the HTML sent is capped at 400k
  characters, so even a huge page tops out around $0.30).
- **Playwright** — only needed for JS-rendered pages; without it, amber captures
  what a plain fetch can see. Opt in with
  `npm install -g playwright && playwright install chromium`.
- **`yt-dlp`** — needed to download embedded media
  (`brew install yt-dlp` or `pipx install yt-dlp`); `ffmpeg` is optional, for
  muxing separate video+audio streams.

## Usage

The bare command is the sensible default: it fetches statically, escalates to a
headless render only if the page looks client-rendered, and uses Claude when a
key is set. The flags below only *force* a choice.

```bash
amber <url>                     # auto capture + Claude if a key is set
amber --no-llm <url>            # heuristics only, never call the model
amber --static <url>            # force a plain HTTP fetch (never boot Chromium)
amber --playwright <url>        # force a headless-Chromium render
amber --plan plan.json <url>    # replay a saved plan
amber --overwrite <url>         # replace the latest snapshot, keep no history
amber -o ~/somewhere <url>      # choose the output directory
amber agent <url>               # Claude cleans interactively — for pages the pipeline gets wrong
amber doctor                    # check the environment: key, Playwright, yt-dlp, ffmpeg
```

## When an archive comes out wrong

The cleanup step uses Claude's judgement by defult, and sometimes Claude gets things wrong. Amber has a few options for handling this, each trading more time and cost for more care:

1. **Read the judgement.** `plan.json` in the archive folder is the complete
   plan that was applied: what was removed, what was kept, which embeds were
   treated as real media.
2. **Edit it and replay.** Delete the selector that ate your sidebar — or add
   one for the popup that survived — then re-run with
   `amber --plan plan.json <url>`. Deterministic and free; no model involved.
3. **Escalate to the agent.** `amber agent <url>` swaps the single planning
   call for Claude working the page interactively: outline the DOM, inspect
   anything ambiguous, remove junk step by step, download media, finalize.
   Slower and costlier (many model calls instead of one), but it handles pages
   the one-shot plan mangles. Needs `ANTHROPIC_API_KEY` (no heuristic fallback)
   and Playwright; best on a machine you own, where it has direct network
   egress and your browser's cookies for yt-dlp. Details in
   [`agent/README.md`](agent/README.md).

## What you get

```
~/Documents/Archives/example.com-some-post/
├── index.html              # cleaned, faithful to the original — always the newest capture
├── assets/
│   ├── images/             # every image, favicon, srcset entry
│   ├── static/             # css, fonts
│   └── media/              # videos/audio — self-hosted files + yt-dlp downloads
├── plan.json               # the cleanup judgement that was applied (auditable, replayable)
├── manifest.json           # source URL, capture time, topical tags, asset list, errors, what was removed
└── versions/               # older snapshots (only after you re-archive), each a full archive
    └── 20260102T090000Z/   # … with its own index.html + assets + manifest
```

## History over time

Re-archiving a URL keeps the old copy. The newest capture stays at `<slug>/`, and
the previous one rotates into `<slug>/versions/<timestamp>/` — each version is a
complete, self-contained archive you can open on its own. The folders *are* the
history; there's no index to maintain.

An identical re-capture is detected (by a content hash that ignores timestamps)
and skipped, so a page that hasn't changed doesn't pile up duplicate snapshots.
Pass `--overwrite` to replace the latest in place and keep no history.

## How it works

1. **Capture** — render the page: static fetch, or headless Chromium when it's
   client-rendered.
2. **Plan** — `claude-sonnet-4-6` reads the raw page and returns a structured
   plan: main-content selector, junk selectors, embedded media to download, and
   topical tags. A heuristic fallback runs with `--no-llm` or if the API call
   fails.
3. **Clean & localise** — remove junk by selector and unconditionally strip
   anything a static copy must never keep (scripts, preload/prefetch/connection
   hints) *before* downloading, so bytes referenced only by junk are never
   fetched. Then walk the surviving DOM and rewrite every loaded reference —
   `<link>`, `<img src/srcset>`, `<source>`, `<video>/<audio>`, inline styles,
   and `url(...)` inside `<style>` blocks and CSS files (recursively, so
   web-fonts and background images come too) — to a local path, and finally
   swap embedded media for locally downloaded files.
4. **Package** — write `index.html`, `plan.json`, and `manifest.json`.

## Development

```bash
git clone https://github.com/chasemccoy/amber && cd amber
pnpm install
pnpm exec playwright install chromium   # one-time, for the headless-render backend

pnpm archive <url>   # run the CLI from source (tsx, no build step)
pnpm test            # deterministic unit tests — no key, no network, no browser
pnpm typecheck       # tsc --noEmit
pnpm evals           # judgement suite (see evals/README.md)
pnpm build           # tsup → dist/ (what npm installs; bin/amber.js wraps dist/cli.js)
```

## Limitations

- **Media downloads need a real network.** yt-dlp on a datacenter IP hits YouTube's anti-bot wall, and TLS-intercepting proxies break cert verification. Opt into a trusted proxy with `--insecure-tls` / `AMBER_INSECURE_TLS=1`.
- **No ffmpeg → no stream muxing.** Without it, set `AMBER_MEDIA_FORMAT` to a progressive single-file format.
- **Interactive `<iframe>` embeds can't be made offline** — CAD viewers, live web apps, and the like stay pointed at the original.
- **The plan is advisory, not infallible** — which is exactly why it's written to disk: read it, edit it, re-run with `--plan`.

## Credits

Inspired by Alex Chan's [*A personal archive of the web*](https://alexwlchan.net/2025/personal-archive-of-the-web/),
which describes doing this by hand. Amber automates the mechanical parts and
hands the judgement to Claude.
