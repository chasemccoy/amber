# Example: embedded-media swap, proven end-to-end

A small, fully self-contained archive you can open offline right now
(`open index.html`). It demonstrates the trick the article cares about most:
replacing an embedded video player with the **real downloaded video**.

Regenerate it with:

```bash
pnpm exec tsx examples/build-media-swap-demo.ts
```

The input is a synthetic page (see `build-media-swap-demo.ts`) carrying realistic
junk — a cookie-consent bar, a sponsored advert, a newsletter pop-up, a tracking
`<script>` — plus a video `<iframe>`. Applying the plan (`report.json`):

- removed all four junk elements (`"removed": 4`)
- downloaded the real media via yt-dlp (`assets/media/mov_bbb.mp4`, 771 KB)
- replaced the `<iframe>` with `<video controls><source src="assets/media/mov_bbb.mp4"></video>`

The video source here is a small directly-downloadable clip standing in for a
talk recording, so the folder stays under 1 MB and renders offline. On a real
page the same path runs against the actual YouTube/Vimeo URL.
