/**
 * Shared fixtures, types, and helpers for the eval suite.
 *
 * The thing worth evaluating about this project is the *judgement*: given a
 * page, does the planner (heuristic or Claude) and the agent correctly decide
 * what is junk, what is the main content, and which embeds are real media? The
 * mechanical capture/rewrite is covered by the unit tests in `test/`.
 *
 * Fixtures are self-contained HTML strings with a known ground truth, so the
 * evals are deterministic and run offline against the heuristic baseline. The
 * LLM and agent harnesses reuse the same fixtures and ground truth.
 */

import type { CleanupPlan } from "../src/types.js";

/** A JSON-clean view of a plan (no `undefined`), usable as a harness output. */
export interface PlanOutput {
  title: string;
  mainContentSelector: string | null;
  removeSelectors: string[];
  media: Array<{ embedSelector: string; sourceUrl: string; kind: string; description: string }>;
  notes: string;
  source: string;
}

export function toPlanOutput(plan: CleanupPlan): PlanOutput {
  return {
    title: plan.title,
    mainContentSelector: plan.mainContentSelector,
    removeSelectors: plan.removeSelectors,
    media: plan.media.map((m) => ({
      embedSelector: m.embedSelector,
      sourceUrl: m.sourceUrl,
      kind: m.kind,
      description: m.description ?? "",
    })),
    notes: plan.notes,
    source: plan.source,
  };
}

/** Ground truth for one fixture page. */
export interface Expected {
  /** Visible-text markers that MUST be gone after applying the plan's removals. */
  junkGone: string[];
  /** A visible-text marker from the main content that MUST survive. */
  mainKept: string;
  /** Canonical media URLs the plan should surface for download (may be empty). */
  media: string[];
  /** Tools the agent is expected to call (for the agent eval). */
  expectedTools: string[];
}

export interface Fixture {
  name: string;
  url: string;
  html: string;
  expected: Expected;
}

/** Per-run metadata forwarded to harnesses and judges. */
export interface EvalMeta {
  html: string;
  url: string;
  expected: Expected;
  expectedTools: string[];
}

// --- helpers ---------------------------------------------------------------

/** Extract a YouTube/Vimeo id so embed URLs and canonical URLs compare equal. */
export function mediaId(url: string): string {
  const yt = url.match(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([A-Za-z0-9_-]+)/);
  if (yt) return `yt:${yt[1]}`;
  const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeo) return `vimeo:${vimeo[1]}`;
  return url.replace(/[#?].*$/, "");
}

// --- fixtures --------------------------------------------------------------

export const FIXTURES: Fixture[] = [
  {
    name: "blog-post-with-cookie-banner-and-ad",
    url: "https://example.com/blog/my-post",
    html: `<!doctype html><html><head><title>My blog post</title>
<link rel="preconnect" href="https://fonts.example.com"></head><body>
<div id="cookie-consent">We use cookies to improve your experience. [Accept]</div>
<div class="ad-leaderboard">SPONSORED: buy our amazing product now</div>
<header><nav>Home About</nav></header>
<article id="post-body"><h1>How I built a thing</h1>
<p>UNIQUE_MAIN_CONTENT: the actual article text that must survive.</p></article>
<aside class="newsletter-signup">Subscribe to my newsletter for more!</aside>
<div class="related-posts">You might also like: ten other posts</div>
<script>analytics.track('pageview')</script></body></html>`,
    expected: {
      junkGone: ["We use cookies", "SPONSORED", "Subscribe to my newsletter", "You might also like"],
      mainKept: "UNIQUE_MAIN_CONTENT",
      media: [],
      expectedTools: ["remove", "finalize"],
    },
  },
  {
    name: "conference-talk-with-youtube-embed",
    url: "https://example.com/talks/my-talk",
    html: `<!doctype html><html><head><title>My conference talk</title></head><body>
<div id="sponsored-banner" class="sponsor">Brought to you by BigCorp</div>
<article id="primary"><h1>My talk at SomeConf</h1>
<p>UNIQUE_TALK_NOTES: here are my notes and the recording.</p>
<div class="embed"><iframe src="https://www.youtube-nocookie.com/embed/aC7UQcZN6y8" width="640" height="360"></iframe></div>
</article>
<button id="theme-toggle">dark mode</button>
<script src="https://cdn.example.com/track.js"></script></body></html>`,
    expected: {
      junkGone: ["Brought to you by BigCorp"],
      mainKept: "UNIQUE_TALK_NOTES",
      media: ["https://www.youtube.com/watch?v=aC7UQcZN6y8"],
      expectedTools: ["remove", "download_and_swap", "finalize"],
    },
  },
  {
    name: "news-article-with-consent-and-social",
    url: "https://example.com/news/story",
    html: `<!doctype html><html><head><title>Breaking news</title></head><body>
<div class="gdpr-consent-modal">This site asks for your consent to use your data.</div>
<div id="onetrust-banner-sdk">Manage cookie preferences</div>
<div class="social-share-bar">Share on Facebook Twitter</div>
<main id="story"><h1>Something happened</h1>
<p>UNIQUE_STORY_BODY: the full reporting on what happened today.</p></main>
<div class="advert-inline">AD: limited time offer</div>
<div class="promo-popup">Sign up for breaking alerts</div>
<script>doubleclick.load()</script></body></html>`,
    expected: {
      junkGone: ["consent to use your data", "Manage cookie preferences", "Share on Facebook", "limited time offer", "Sign up for breaking alerts"],
      mainKept: "UNIQUE_STORY_BODY",
      media: [],
      expectedTools: ["remove", "finalize"],
    },
  },
];

export function fixtureMeta(f: Fixture): EvalMeta {
  return { html: f.html, url: f.url, expected: f.expected, expectedTools: f.expected.expectedTools };
}
