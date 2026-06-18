# Example: a conference-talk write-up (Simon Willison, WordCamp US 2023)

Source: <https://simonwillison.net/2023/Aug/27/wordcamp-llms/>

The article's exact motivating case — a blog post about a talk that **embeds the
YouTube recording of that talk**. Captured with the **Playwright (headless
Chromium)** backend; the cleanup `plan.json` here is the judgement step (on a
real run Claude generates it).

```bash
pnpm archive --plan examples/wordcamp-llms/plan.json \
    https://simonwillison.net/2023/Aug/27/wordcamp-llms/
```

What happened (see `manifest.json`):

| | |
|---|---|
| Backend | Playwright (rendered in headless Chromium) |
| Assets captured & localised | **109** (0 errors) |
| Junk removed | sponsor banner (`#sponsored-banner`), scripts, JS-only `#theme-toggle`, resource-hint `<link>`s — **10 elements** |
| Embedded media | YouTube talk identified → queued for `download_and_swap` |

**Note on the media result:** YouTube's anti-bot check blocks downloads from
datacenter IPs, so on such hosts the media download fails (`manifest.json`
records `ok: false`). On a normal machine — the intended deployment — yt-dlp
downloads it and the `<iframe>` becomes a local `<video>`. See
`examples/media-swap-demo/` for the swap proven end-to-end.

**Note on size reduction:** modest here, because this is an already-clean indie
blog. The 10–20× shrink the article reports happens on ad-and-tracker-heavy news
sites — which are exactly the JS-rendered pages the Playwright backend now
handles.

The bulky `assets/` tree is git-ignored; `examples/rebuild.sh` regenerates the
full, openable folder.
