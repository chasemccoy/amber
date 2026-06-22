# Local agent workflow

`agent.ts` runs the archiver as a genuine **agentic loop**: after the page and
its assets are captured, `claude-sonnet-4-6` drives the cleanup tool by tool —
inspecting the DOM, removing junk, downloading embedded media, and finalising —
the way a careful human works by hand, but automated.

Designed to run **on a machine you own**. That matters:

- **Direct network egress** — yt-dlp can actually reach YouTube/Vimeo (datacenter
  IPs get anti-bot walls; corp/CI TLS proxies break cert checks).
- **Your browser cookies** — pass `--cookies-from-browser` to yt-dlp for
  age-gated / login-walled media (a small extension to `src/media.ts`).
- **Your filesystem** — archives land in folders you back up (Time Machine,
  Backblaze, etc.).

## Run it

```bash
pnpm install
pnpm exec playwright install chromium
export ANTHROPIC_API_KEY=...
pnpm agent https://example.com/some-post   # writes ./archives/<slug>/
pnpm agent --overwrite https://example.com/some-post   # replace latest, keep no history
```

Like the pipeline, re-archiving keeps history: the previous capture rotates into
`<slug>/versions/<timestamp>/` and an unchanged re-capture is skipped.

You'll see the loop narrate itself:

```
[capture] 109 assets, 0 errors
[tool]    get_dom_outline()
[claude]  This is a talk write-up. #sponsored-banner is an ad; the scripts are
          analytics; there's a YouTube embed of the talk to download.
[tool]    remove(["#sponsored-banner","script","#theme-toggle"])
[tool]    list_embeds()
[tool]    download_and_swap("iframe[src*=youtube]","https://youtube.com/watch?v=…","video")
[tool]    set_main_content("#primary","Making LLMs work for you")
[tool]    finalize()
[done]    archives/simonwillison.net-2023-Aug-27-wordcamp-llms/index.html
```

## The tools Claude is given

| Tool | What it does |
|---|---|
| `get_dom_outline` | Compact structural view of the page (tags, ids, classes, text previews) |
| `inspect(selector)` | Full HTML of matched elements, to judge junk vs. content |
| `list_embeds` | Iframes / `<video>` / `<audio>` and their sources |
| `remove(selectors)` | Delete junk elements |
| `download_and_swap(...)` | yt-dlp the real media, replace the embed with a local `<video>`/`<audio>` |
| `set_main_content(...)` | Record main selector + title |
| `finalize` | Write the self-contained `index.html` + `manifest.json` |

Only judgement tools are exposed — asset capture/rewrite already happened
deterministically (in headless Chromium) before the loop, so Claude can't waste
turns on the mechanical part.

## Driving it from Claude Code instead

You don't strictly need this script. On your own machine you can point **Claude
Code** at this repo and let it run the same building blocks directly — capture a
URL with `pnpm archive --no-llm` (or call `Capturer`/`renderPage`), then
ask it to inspect the result, edit `index.html` / write a `plan.json`, and run
yt-dlp. `agent.ts` just packages that loop into one reproducible command with a
fixed, auditable tool surface.
