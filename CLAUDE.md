# CLAUDE.md

Guidance for working in the **amber** codebase.

## What this is

amber turns a URL into a self-contained, de-junked offline folder: an
`index.html` + local `assets/` tree with every reference rewritten to a local
path, the junk (ads, cookie banners, trackers) removed, and embedded media
downloaded as a real file. The design splits the work in two: deterministic
Node does the mechanical capture/rewrite/package; `claude-opus-4-8` does the
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
```

Always run `pnpm typecheck` and `pnpm test` after changing `src/`. After
touching the planner/agent/judges, run `pnpm evals` (it makes real API calls and
needs `ANTHROPIC_API_KEY`).

## Architecture

Two entry points share the same capture/clean code:

- **Pipeline** (`pnpm archive`) — one structured-output call returns a plan that
  the pipeline applies. Stages in `src/pipeline.ts` `archiveUrl()`:
  1. **Capture** — `src/render.ts` (Playwright) + `src/capture.ts`. Backend is
     `auto` by default: static `fetch` first, escalating to a headless-Chromium
     render only when the page looks client-rendered (`assessRendering`).
     `captureAssets()` walks the DOM, downloads every referenced asset, and
     rewrites refs to **relative local paths**. `<a href>` links are left alone.
  2. **Plan** — `src/planner.ts`. `llmPlan()` uses `messages.parse` + a Zod
     schema; `heuristicPlan()` is the no-key fallback.
  3. **Clean** — `src/clean.ts` `applyPlan()`. Swaps media first, then removes
     junk by selector, strips `on*` handlers and `javascript:` hrefs.
  4. **Package** — writes `index.html`, `plan.json`, `manifest.json`.
- **Agent** (`pnpm agent`) — `agent/agent.ts` `runAgentLoop()`, a
  `beta.messages.toolRunner` loop with 7 tools (get_dom_outline, inspect,
  list_embeds, remove, download_and_swap, set_main_content, finalize). For
  awkward pages where the model benefits from looking closer. Runs on a machine
  you own (direct egress, browser cookies for yt-dlp). Writes a leaner manifest
  and no `plan.json`.

## Output layout

`archives/<slug>/` — slug is `host` (with leading `www.` stripped) + `pathname`,
sanitised, ≤80 chars (`slugifyUrl`). Re-archiving the same URL overwrites.

```
archives/<slug>/
├── index.html       # cleaned, faithful to the original (no injected provenance)
├── assets/{images,static,media}/
├── plan.json        # the applied judgement (pipeline only)
└── manifest.json    # source/final URL, backend, asset list, errors, cleanReport
```

Asset filenames are `<basename>-<8-char sha1 of full URL><ext>` (`slugFor`), so
distinct URLs never collide and the same URL is downloaded once (cached).

## Conventions & gotchas

- TypeScript ESM, `.js` extensions in imports (NodeNext). `tsx` runs the source
  directly — there's no build step.
- The SDK Zod helpers (`messages.parse`, `betaZodTool`) require
  `@anthropic-ai/sdk` ≥ 0.104 **and Zod 4** — Zod 3 produces a wall of type
  errors. cheerio's element type comes from `domhandler`, not `cheerio`.
- Model id is `claude-opus-4-8` (overridable with `--model`).
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
network, or browser) — keep them that way. `evals/*.eval.ts` gate the LLM and
agent suites behind `ANTHROPIC_API_KEY` and skip without it.
