# Changelog

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
