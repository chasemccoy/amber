#!/usr/bin/env -S pnpm exec tsx
/**
 * Reproducible builder for examples/media-swap-demo/.
 *
 * Demonstrates the article's core trick end-to-end on a synthetic page: real
 * junk (cookie bar, advert, newsletter pop-up, tracking script) plus a video
 * <iframe>. Applying the plan removes the junk and replaces the iframe with a
 * REAL downloaded local <video>. The video source is a small directly-
 * downloadable clip standing in for a talk recording, so the whole folder stays
 * under 1 MB and renders offline.
 *
 *   AMBER_INSECURE_TLS=1 pnpm exec tsx examples/build-media-swap-demo.ts   # sandbox
 *   pnpm exec tsx examples/build-media-swap-demo.ts                           # your machine
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as cheerio from "cheerio";
import { applyPlan } from "../src/clean.js";
import type { CleanupPlan } from "../src/types.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, "media-swap-demo");
fs.mkdirSync(root, { recursive: true });

const fixture = `<!doctype html><html><head><title>Conference talk write-up</title></head>
<body>
<div id="cookie-consent">We use cookies! [Accept] [Reject]</div>
<div class="advert-leaderboard">SPONSORED — buy our thing</div>
<header><nav>Site nav</nav></header>
<article id="post">
  <h1>My talk at SomeConf 2024</h1>
  <p>Here's the recording of my talk:</p>
  <div class="embed"><iframe src="https://www.youtube.com/embed/SOMEID" width="640" height="360"></iframe></div>
  <p>And here are my notes from the talk...</p>
</article>
<div class="newsletter-signup">Subscribe to my newsletter!</div>
<script>analytics.track('pageview')</script>
</body></html>`;

const plan: CleanupPlan = {
  title: "My talk at SomeConf 2024",
  mainContentSelector: "#post",
  removeSelectors: ["script", "#cookie-consent", ".advert-leaderboard", ".newsletter-signup"],
  media: [
    {
      embedSelector: 'iframe[src*="youtube"]',
      // direct-download stand-in for the talk video (real network fetch via yt-dlp)
      sourceUrl: "https://www.w3schools.com/html/mov_bbb.mp4",
      kind: "video",
      description: "Recording of the talk — downloaded as a real local video file.",
    },
  ],
  notes: "Synthetic page demonstrating the swap mechanism with a real downloaded clip.",
  source: "llm",
};

const $ = cheerio.load(fixture);
const report = await applyPlan($, plan, root);
fs.writeFileSync(path.join(root, "index.html"), $.html());
fs.writeFileSync(path.join(root, "plan.json"), JSON.stringify(plan, null, 2));
fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2));
console.log("removed:", report.removed, "| media:", JSON.stringify(report.media));
