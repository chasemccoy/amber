# amber

Turn a URL into a **self-contained, de-junked offline folder** — a Claude-driven
automation of the hand-saving method Alex Chan describes in
[*A personal archive of the web*](https://alexwlchan.net/2025/personal-archive-of-the-web/).

TypeScript / Node, with **headless Chromium (Playwright)** capture so
JavaScript-rendered pages work. The output mirrors Chan's: one folder per page,
an `index.html` plus a local `assets/` tree, every external reference rewritten
to the local copy, the junk (ads, cookie banners, trackers) deleted, and
embedded media (e.g. the YouTube recording of a talk) downloaded as a **real
video file** rather than a dead embed.

## The idea: split the labour

Chan's method is excellent but slow — "hundreds of hours" for 2,000 bookmarks.
The work splits cleanly into two kinds, and that split is the whole design:

| Mechanical (code is good at this) | Judgement (an LLM is good at this) |
|---|---|
| Render the page; download every asset | Decide what's junk vs. main content |
| Rewrite references to local paths | Spot ads / cookie banners / tracker scripts |
| Run yt-dlp; package the folder | Recognise an embed worth downloading as real media |

The mechanical half is deterministic Node; the judgement half is
`claude-sonnet-4-6`. You stay in control: the judgement is written out as a
`plan.json` you can read, edit, and replay.

## Install

```bash
pnpm install
pnpm exec playwright install chromium   # one-time, for the render backend
export ANTHROPIC_API_KEY=...       # for the Claude-driven plan (optional)
```

yt-dlp must be on your PATH for media downloads (`pipx install yt-dlp` or
`brew install yt-dlp`).

## Two ways to run it

**1. One-shot pipeline (`pnpm archive`)** — capture the page, Claude returns a
structured cleanup plan, the pipeline applies it. Cheapest, enough for most pages.

The bare command is the **sensible default**: it captures statically and only
escalates to a headless-Chromium render if the page looks client-rendered, and
it uses Claude when `ANTHROPIC_API_KEY` is set, falling back to heuristics when
it isn't. So you rarely need a flag — the flags below only *force* a choice.

```bash
pnpm archive https://example.com/some-post           # auto capture + Claude if a key is set
pnpm archive --no-llm     https://example.com/post    # heuristics only, never call the model
pnpm archive --static     https://example.com/post    # force a plain HTTP fetch (never boot Chromium)
pnpm archive --playwright https://example.com/post    # force a headless-Chromium render
pnpm archive --plan plan.json https://example.com/post # replay/audit a saved plan
```

**2. Local agent workflow (`pnpm agent`)** — Claude works the page the way Chan
does by hand: it inspects the DOM, decides, removes junk, handles media, and
finalises — calling real tools at each step via the Anthropic SDK
[tool runner](https://docs.anthropic.com/en/api/agent-sdk). Designed to run **on
a machine you own**, where it has direct network egress and your browser's
cookies for yt-dlp, with no corporate/CI proxy in the way.

```bash
pnpm agent https://example.com/some-post
```

Use the one-shot pipeline for volume; reach for the agent loop on awkward pages
where the model benefits from looking closer before deleting, or retrying media
extraction a different way. See `agent/README.md`.

## What you get

```
archives/example.com-some-post/
├── index.html        # cleaned, faithful to the original (provenance lives in manifest.json)
├── assets/
│   ├── images/        # every image, favicon, srcset entry
│   ├── static/        # css, fonts (scripts are stripped, not saved)
│   └── media/         # videos/audio pulled with yt-dlp
├── plan.json          # the cleanup judgement that was applied (auditable)
└── manifest.json      # source URL, topical tags, asset list, errors, what was removed
```

## How it works (pipeline)

1. **Capture** (`src/render.ts` + `src/capture.ts`) — render the page in headless
   Chromium so JS, lazy-loaded images, and client-rendered content are present;
   snapshot the asset bytes the browser already downloaded (no second fetch), then
   walk the DOM and rewrite every reference (`<link>`, `<img src/srcset>`,
   `<source>`, `<video>/<audio>`, inline `style` `url()`, `url(...)` inside `<style>`
   blocks, and `url(...)` inside CSS files — recursively, so web-fonts and background
   images come too) to a local path. `<script src>` is *not* localised; scripts are
   stripped in the clean step. Honours
   `<base href>`. `<a href>` links are left alone — you localise what a page *loads*,
   not where it *links*. By default the backend is **auto**: a static HTTP fetch
   first, escalating to the Chromium render only when the fetched page looks
   client-rendered (empty SPA mount node, or very little visible text). `--static`
   forces the plain fetch; `--playwright` forces the render.
2. **Plan** (`src/planner.ts`) — `claude-sonnet-4-6` (`messages.parse` + a Zod schema)
   returns `{title, mainContentSelector, removeSelectors, media[], tags[], notes}` —
   including topical `tags` describing the page's subject matter, for later
   browsing/search. A heuristic fallback (strip scripts/iframes + id/class patterns
   for cookie/ad/newsletter; tags from `<meta keywords>` when present) runs with
   `--no-llm` or if the API call fails.
3. **Clean** (`src/clean.ts`) — download & swap embedded media first (so a broad
   `iframe` selector can't nuke a video), delete junk by selector, then
   *unconditionally* strip what a static offline copy must never keep regardless of
   the plan: `<script>` (it runs and phones home), `<noscript>`, and connection
   hints (`<link rel="preconnect"/"dns-prefetch">`). Finally strip inline `on*`
   handlers and dead `javascript:` links, and drop comments. The saved HTML stays
   faithful to the original — provenance is recorded in `manifest.json`, not injected.
4. **Package** (`src/pipeline.ts`) — write `index.html`, `plan.json`, `manifest.json`.

## Worked examples (in `examples/`)

- **`media-swap-demo/`** — fully self-contained, opens offline. Proves the core
  trick end-to-end: junk removed and a video `<iframe>` replaced with a **real
  downloaded** local `<video>` (771 KB clip). Rebuild: `pnpm exec tsx examples/build-media-swap-demo.ts`.
- **`wordcamp-llms/`** — the article's exact case, captured with the **Playwright**
  backend: a real talk write-up embedding its YouTube recording. 109 assets
  localised; sponsor banner + scripts + JS-only widgets removed. (Bulky assets are
  git-ignored — `examples/rebuild.sh` regenerates the full folder.)

Run the tests (no key, no network, no browser): `pnpm test`. Typecheck: `pnpm typecheck`.

## Evals

A [`vitest-evals`](https://vitest-evals.sentry.dev) suite (`pnpm evals`) scores the *judgement* — does the planner/agent strip the right junk, keep the main content, and find embedded media? Functional judges apply each plan to fixture pages with known ground truth. The heuristic baseline runs in CI; the Claude planner and the full agent loop are held to a high bar and skip without `ANTHROPIC_API_KEY`. See `evals/README.md`.

## Limitations & honest notes

- **Media downloads need a real network.** yt-dlp on a datacenter IP hits
  YouTube's anti-bot wall, and TLS-intercepting proxies (corp/CI) break cert
  verification (for both Chromium and yt-dlp). Both are absent on a machine you
  own — which is the point of the agent-workflow framing. For a trusted
  intercepting proxy, opt in with `--insecure-tls` / `AMBER_INSECURE_TLS=1`
  (passes `ignoreHTTPSErrors` to Chromium and `--no-check-certificates` to yt-dlp);
  the default keeps verification on.
- **No ffmpeg → no stream muxing.** yt-dlp needs ffmpeg to merge separate
  video+audio streams; without it, set `AMBER_MEDIA_FORMAT` to a progressive
  single-file format (e.g. `best[ext=mp4][acodec!=none][vcodec!=none]/18/worst`).
- **`<a>` links still point at the live web.** By design — archiving one page,
  not crawling.
- **The plan is advisory, not infallible.** That's why it's written to disk:
  read it, edit it, re-run with `--plan`. Same "stay in control" ethos as the
  hand method.
