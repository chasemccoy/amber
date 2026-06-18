# amber browser extension

A personal Chrome/Chromium extension that archives the page you're looking at
with one click. It sends the **active tab's already-rendered DOM** to the local
amber tool over Chrome's native-messaging bridge — so your own browser is the
capture environment (JavaScript has run, your session/cookies apply) and there's
no headless browser involved.

```
extension/
├── manifest.json        # MV3 extension (ID pinned via a "key" field)
├── background.js        # service worker: grab DOM → native host → notify
├── icons/               # generated amber icons
└── host/
    ├── amber-host.ts    # native-messaging host: frames stdin/stdout, calls archiveFromDom()
    ├── amber-host.sh    # launcher Chrome executes (picks Node ≥ 20, loads host.env)
    ├── install.sh       # registers the host manifest with installed browsers
    ├── host.env.example # copy to host.env and add your ANTHROPIC_API_KEY
    └── key.pem          # the extension's private identity (git-ignored)
```

## How it works

1. You click the toolbar button (or right-click → "Archive this page with amber",
   or press the shortcut).
2. `background.js` runs a tiny content script that returns
   `{ url, html: document.documentElement.outerHTML }`.
3. It calls `chrome.runtime.sendNativeMessage` → Chrome launches `amber-host.sh`,
   which runs `amber-host.ts`. The host frames the message off stdin and calls
   amber's `archiveFromDom()` (the same plan → clean → package pipeline the CLI
   uses; assets the payload didn't include are fetched locally).
4. The host replies with the result; the extension shows a badge (✓/✗) and a
   notification with the output path.

Archives land in `~/Documents/Archives/<slug>/` by default (set
`AMBER_ARCHIVE_DIR` in `host.env` to change it).

## Setup (once)

Prerequisites: `pnpm install` in the repo, **Node ≥ 20** available (the launcher
finds Homebrew/nvm Node automatically; or set `AMBER_NODE` in `host.env`), and
`yt-dlp` on PATH for embedded media.

1. **Add your key:** `cp host/host.env.example host/host.env` and set
   `ANTHROPIC_API_KEY` (without it amber falls back to heuristics). Chrome
   launches the host with a minimal environment, so the key must live here, not
   in your shell profile.
2. **Load the extension:** open `chrome://extensions`, enable **Developer mode**,
   click **Load unpacked**, and select this `extension/` folder. The `key` in
   `manifest.json` pins the ID to `nogcgdhgbamkbilpcibcklkkmmkfgfdo`.
3. **Register the native host:** `bash host/install.sh`. It writes the host
   manifest (allowlisting that exact extension ID) into the
   `NativeMessagingHosts` dir of every Chromium browser it finds. Re-run if you
   move the repo.
4. Reload the extension once after step 3 so it picks up the host.

The keyboard shortcut defaults to `⌘⇧Y` (rebind at
`chrome://extensions/shortcuts`).

## Security

The host manifest allowlists **only** this extension's ID, and the ID is pinned
by the keypair in `key.pem` — no other extension (and no web page) can reach the
host. There's no open network port. Keep `key.pem` and `host.env` private; both
are git-ignored.

## Notes & next steps

- **MVP sends HTML only**, and amber fetches subresources locally (from your
  machine/IP). To also capture **cookie-gated/private** assets, the extension can
  fetch subresources with the page's credentials and include their bytes — the
  host already accepts a `resources` array that drops straight into amber's
  prefetched-bytes path; this needs `host_permissions` for the sites you archive.
- Embedded media (yt-dlp) still runs locally on the host side, which is correct.
