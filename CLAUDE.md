# CLAUDE.md

Guidance for working in the **amber** codebase.

## What this is

amber turns a URL into a self-contained, de-junked offline folder: an
`index.html` + local `assets/` tree with every reference rewritten to a local
path, the junk (ads, cookie banners, trackers) removed, and embedded media
downloaded as a real file. The design splits the work in two: deterministic
Node does the mechanical capture/rewrite/package; `claude-sonnet-4-6` does the
judgement (what's junk, what's the main content, which embeds are real media).

## Commands

```bash
pnpm install
pnpm exec playwright install chromium   # one-time, for the render backend

pnpm archive <url>     # one-shot pipeline (src/cli.ts) — capture, plan, clean, package
pnpm agent <url>       # local agentic loop (agent/agent.ts) — Claude drives the tools

pnpm test              # deterministic unit tests — no key, no network, no browser
pnpm typecheck         # tsc --noEmit
pnpm evals             # vitest-evals judgement suite (LLM/agent suites need a key)
pnpm build             # tsup → dist/ (only needed for publishing; dev runs tsx directly)
```

Always run `pnpm typecheck` and `pnpm test` after changing `src/`. After
touching the planner/agent/judges, run `pnpm evals` (it makes real API calls and
needs `ANTHROPIC_API_KEY`).

## Architecture

Two entry points share the same capture/clean code:

- **Pipeline** (`pnpm archive`) — one structured-output call returns a plan that
  the pipeline applies. Stages in `src/pipeline.ts` `archiveUrl()`/`finishArchive()`:
  1. **Capture** — `src/render.ts` (Playwright) + `src/capture.ts`. Backend is
     `auto` by default: static `fetch` first, escalating to a headless-Chromium
     render only when the page looks client-rendered (`assessRendering`).
  2. **Plan** — `src/planner.ts`. `llmPlan()` judges the *raw pre-capture* HTML
     (`messages.parse` + a Zod schema); `heuristicPlan()` is the no-key fallback.
     The plan includes `preserveRuntime` — Claude's judgement of whether the
     page's presentation needs its JS at view time. Plan resolution happens in
     `archiveUrl()` (via `resolvePlan()`), *before* clean/localise, so a true
     verdict can re-capture the page in keep-js mode (`--keep-js` forces it,
     `--no-keep-js` forbids it; auto-escalation needs esbuild + Playwright and
     is skipped under `--static`). Only the LLM plan sets it; heuristics never
     escalate. Guarded by `evals/runtime.eval.ts` (fixtures in `shared.ts`
     `RUNTIME_FIXTURES` — the false cases are deliberately tempting).
  3. **Clean & localise** — junk is removed *before* assets are downloaded, so
     junk-only bytes are never fetched: `removeJunk()` (protecting the plan's
     media embeds via `mediaTargets()`) + `stripStatic()` (unconditional:
     `<script>`/`<noscript>`/preconnect & prefetch hints, `on*` handlers,
     `javascript:` hrefs, comments), then `captureAssets()` walks the surviving
     DOM, downloads every referenced asset (incl. `url()` in `<style>` blocks
     and `.css` files), and rewrites refs to **relative local paths**
     (`<a href>`/`<iframe src>` left alone; `<script src>` never downloaded),
     then `swapMedia()` downloads embeds via yt-dlp and swaps them in.
     `applyPlan()` in `src/clean.ts` still composes swap→junk→strip in one call
     for tests/evals that clean an already-captured DOM.
  4. **Package** — writes `index.html`, `plan.json`, `manifest.json`.

  **Keep-js mode** (`src/keepjs.ts`) — preserves a page's own runtime when the
  experience *is* the JS (WebGL, scroll choreography). During the Playwright
  render (with `deterministicRandom` — Math.random seeded identically in render
  and replay — plus a denser auto-scroll), every response is recorded; then:
  trackers removed by heuristic, module scripts flattened to one classic IIFE
  via esbuild (recorded responses as the virtual fs, network fallback for lazy
  chunks), a replay shim injected (patches fetch/XHR from an embedded response
  map, remaps runtime-constructed element src/poster/href through an asset map
  with nearest-variant fallback, stubs beacons/WebSocket), runtime-only assets
  localised with numeric-sequence gap-filling, and finally
  `finalizeKeepJsDelivery()` collapses everything into ONE self-contained
  `index.html` with assets as data: URIs — that's what lets canvas/WebGL run
  from a double-clicked file:// page (file:// taints local media otherwise).
  The inliner STREAMS the output (DOM holds `@@AMBER[rel]@@` tokens, expanded
  from disk in slices) — building the base64 in-memory OOMs Node on real
  sites; when it writes index.html itself, finishArchive must not clobber it.
  Past `INLINE_CAP_BYTES` (200MB raw; `AMBER_INLINE_CAP` overrides, mainly for
  testing) the folder layout is kept plus a double-clickable
  `View archive.command` (a `#!/bin/sh` wrapper around `node -e` — running the
  file through node directly breaks under any ancestor `"type": "module"`).
  `amber serve` (`src/serve.ts`) serves any archive on 127.0.0.1. esbuild is an
  optional peer dep like Playwright (in devDependencies for repo work);
  `amber doctor` reports it. Keep-js contract: the recorded session replays
  offline; behaviour beyond it is best-effort. Extension path and agent mode
  don't support keep-js.
- **Agent** (`pnpm agent`, or `amber agent` from the npm install — src/cli.ts
  lazy-imports `agent/agent.js` so plain archives never load the SDK tool
  runner) — `agent/agent.ts` `runAgentLoop()`, a `beta.messages.toolRunner`
  loop with 7 tools (get_dom_outline, inspect, list_embeds, remove,
  download_and_swap, set_main_content, finalize). For awkward pages where the
  model benefits from looking closer. Requires a key (no heuristic fallback)
  and always renders with Playwright. Runs on a machine you own (direct
  egress, browser cookies for yt-dlp). Writes a leaner manifest and no
  `plan.json`.

## Output layout

`<outRoot>/<slug>/` — slug is `host` (with leading `www.` stripped) + `pathname`,
sanitised, ≤80 chars (`slugifyUrl`). Default `outRoot` is `~/Documents/Archives`
(CLI `-o` / `AMBER_ARCHIVE_DIR` override it); the CLI and the extension's native
host share this default.

```
<outRoot>/<slug>/
├── index.html       # cleaned, faithful to the original (no injected provenance)
├── assets/{images,static,media}/
├── plan.json        # the applied judgement (pipeline only)
├── manifest.json    # source/final URL, capturedAt, contentHash, backend, tags, asset list, errors, cleanReport
└── versions/        # older snapshots, each a full self-contained archive
    └── <YYYYMMDDTHHMMSSZ>/   # named from that snapshot's capturedAt (second precision)
```

Asset filenames are `<basename>-<8-char sha1 of full URL><ext>` (`slugFor`), so
distinct URLs never collide and the same URL is downloaded once (cached).

**Versioning** (`src/snapshot.ts`). Every archive is built in a `.amber-tmp-*`
staging dir under `outRoot`, then `commitSnapshot()` promotes it: the newest
snapshot lives at the slug root (so `<slug>/index.html` is always latest and the
extension/library see no layout change), and the previous latest rotates into
`versions/<capturedAt>/`. The set of folders *is* the history — there is no index
file; derive the timeline by reading each snapshot's `manifest.json`. Re-archiving
identical content is skipped (compared via `manifest.contentHash`, a sha256 of
`index.html` + asset bytes that ignores `manifest.json`/`plan.json`). `--overwrite`
replaces the latest in place without rotating it into `versions/`. Both entry
points share this: the pipeline via `finishArchive()`, the agent via `runAgent()`.

## Packaging (npm)

Published as **`in-amber`**; the installed command is **`amber`**
(`bin/amber.js`, a `#!/usr/bin/env node` wrapper that imports `dist/cli.js`).
`pnpm build` (tsup) bundles `src/cli.ts` + `src/index.ts` into `dist/` with a
rolled-up `dist/index.d.ts`; `prepublishOnly` runs typecheck + test + build.
Only `bin/` and `dist/` ship. **Playwright is an optional peer dependency** —
kept in devDependencies for repo work, but a plain `npm i -g in-amber` skips it;
`render.ts` `loadChromium()` throws a friendly `AmberError` (src/errors.ts) when
it's missing, `auto` mode degrades to the static capture, and `amber doctor`
(src/doctor.ts) reports key/Playwright/yt-dlp/ffmpeg/output-dir status. The CLI
prints `AmberError`s message-only; other errors keep their stack.

**Releases** are tag pushes: bump `version`, commit, `git tag vX.Y.Z`,
`git push --follow-tags`. `.github/workflows/publish.yml` publishes via npm
trusted publishing (OIDC — no token secret) with provenance; local
`npm/pnpm publish` intentionally fails (`publishConfig.provenance` needs CI),
and provenance requires the GitHub repo to stay public. Requires Node ≥ 24.

## Conventions & gotchas

- TypeScript ESM, `.js` extensions in imports (NodeNext). `tsx` runs the source
  directly — there's no build step.
- The SDK Zod helpers (`messages.parse`, `betaZodTool`) require
  `@anthropic-ai/sdk` ≥ 0.104 **and Zod 4** — Zod 3 produces a wall of type
  errors. cheerio's element type comes from `domhandler`, not `cheerio`.
- Model id is `claude-sonnet-4-6` (overridable with `--model` or `AMBER_MODEL`).
- The plan is a first-class artifact: `--plan plan.json` replays a saved plan;
  `--no-llm` forces heuristics; `--static` / `--playwright` force a backend.
- Env: `ANTHROPIC_API_KEY` (plan/agent), `AMBER_INSECURE_TLS=1` (trusted MITM
  proxy → `ignoreHTTPSErrors` + yt-dlp `--no-check-certificates`),
  `AMBER_MEDIA_FORMAT` (yt-dlp format when there's no ffmpeg to mux).
- External deps: `yt-dlp` on PATH for media; Playwright Chromium for the render
  backend; ffmpeg optional (for muxing separate video+audio streams).
- Evals score the *judgement* with functional judges (apply the plan to a
  fixture, check the observable result), not selector string-matching. The
  helper to read tool calls off a run is `toolCalls(run.session)` — there is no
  top-level `run.toolCalls`.

## Tests

`test/*.test.ts` run via `node --test` and are fully deterministic (no key,
network, or browser) — keep them that way. The keep-js replay shim is tested
for real in `test/shim.test.ts`: applyKeepJs builds the page, and the injected
shim script executes in a `node:vm` sandbox with a stub DOM — every shim
behavior exists because a real site broke without it, so pin new ones there. `evals/*.eval.ts` gate the LLM and
agent suites behind `ANTHROPIC_API_KEY` and skip without it.
