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
  tags: string[];
  preserveRuntime: boolean;
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
    tags: plan.tags ?? [],
    preserveRuntime: plan.preserveRuntime,
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
  /**
   * Visible-text markers from the page's own structural chrome and first-party
   * navigation (site header, nav, footer, copyright/attribution, and editorial
   * next/previous-article teasers) that MUST survive — removing these is
   * overreach, even though they aren't the "main content".
   */
  chromeKept: string[];
  /** Canonical media URLs the plan should surface for download (may be empty). */
  media: string[];
  /**
   * Topic concepts the page is clearly about. Each inner array is one concept
   * with acceptable synonyms; a concept counts as covered if any synonym
   * fuzzy-matches any produced tag. (Tags are open-ended, so this scores topical
   * recall, not exact strings.)
   */
  expectedTopics: string[][];
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
<header class="site-header"><nav>UNIQUE_NAV: Home About Archive</nav></header>
<article id="post-body"><h1>How I built a static site generator in Rust</h1>
<p>UNIQUE_MAIN_CONTENT: I built a small static-site generator in Rust, and learned a lot about parsing Markdown and doing fast incremental rebuilds.</p></article>
<aside class="newsletter-signup">Subscribe to my newsletter for more!</aside>
<div class="related-posts">You might also like: ten other posts</div>
<footer class="site-footer"><p>UNIQUE_FOOTER: &copy; 2026 My Blog &middot; <a href="/about">About</a> &middot; <a href="/rss">RSS</a></p></footer>
<script>analytics.track('pageview')</script></body></html>`,
    expected: {
      junkGone: ["We use cookies", "SPONSORED", "Subscribe to my newsletter", "You might also like"],
      mainKept: "UNIQUE_MAIN_CONTENT",
      chromeKept: ["UNIQUE_NAV", "UNIQUE_FOOTER"],
      media: [],
      expectedTopics: [["rust"], ["static site", "static-site generator", "ssg"], ["markdown"]],
      expectedTools: ["remove", "finalize"],
    },
  },
  {
    name: "conference-talk-with-youtube-embed",
    url: "https://example.com/talks/my-talk",
    html: `<!doctype html><html><head><title>My conference talk</title></head><body>
<div id="sponsored-banner" class="sponsor">Brought to you by BigCorp</div>
<article id="primary"><h1>My talk at SomeConf: scaling LLM inference</h1>
<p>UNIQUE_TALK_NOTES: my talk covers how we scaled large language model inference and cut GPU latency in production.</p>
<div class="embed"><iframe src="https://www.youtube-nocookie.com/embed/aC7UQcZN6y8" width="640" height="360"></iframe></div>
</article>
<button id="theme-toggle">dark mode</button>
<footer class="site-footer"><p>UNIQUE_TALK_FOOTER: &copy; 2026 SomeConf &middot; Contact</p></footer>
<script src="https://cdn.example.com/track.js"></script></body></html>`,
    expected: {
      junkGone: ["Brought to you by BigCorp"],
      mainKept: "UNIQUE_TALK_NOTES",
      chromeKept: ["UNIQUE_TALK_FOOTER"],
      media: ["https://www.youtube.com/watch?v=aC7UQcZN6y8"],
      expectedTopics: [["llm", "large language model", "language model"], ["inference", "performance", "latency", "scaling"], ["gpu", "hardware"]],
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
<main id="story"><h1>City council approves transit budget</h1>
<p>UNIQUE_STORY_BODY: the city council approved a two billion dollar budget to expand the regional light-rail transit network.</p></main>
<div class="advert-inline">AD: limited time offer</div>
<div class="promo-popup">Sign up for breaking alerts</div>
<aside class="sponsored-recirc">Around the web: 10 shocking tricks doctors hate</aside>
<nav class="next-post"><a href="/next">UNIQUE_NEXTPOST: Read next — A new transit line opens downtown <img src="/next-thumb.jpg" alt=""></a></nav>
<footer class="site-footer"><div class="footer-newsletter">Join our newsletter for daily junk</div>
<p>UNIQUE_NEWS_FOOTER: &copy; 2026 The Daily Example &middot; <a href="/terms">Terms</a></p></footer>
<script>doubleclick.load()</script></body></html>`,
    expected: {
      junkGone: ["consent to use your data", "Manage cookie preferences", "Share on Facebook", "limited time offer", "Sign up for breaking alerts", "newsletter for daily junk", "10 shocking tricks"],
      mainKept: "UNIQUE_STORY_BODY",
      chromeKept: ["UNIQUE_NEWS_FOOTER", "UNIQUE_NEXTPOST"],
      media: [],
      expectedTopics: [["transit", "light rail", "public transit", "public transportation"], ["city council", "local government", "government"], ["budget", "funding", "infrastructure"]],
      expectedTools: ["remove", "finalize"],
    },
  },
];

export function fixtureMeta(f: Fixture): EvalMeta {
  return { html: f.html, url: f.url, expected: f.expected, expectedTools: f.expected.expectedTools };
}

// --- runtime-judgement fixtures --------------------------------------------

/**
 * Ground truth for `preserveRuntime` — keep-js must trigger ONLY when the
 * page's presentation genuinely needs its JS at view time. The false cases
 * are deliberately tempting (hydration bundles, decorative canvas, script-heavy
 * docs): over-triggering costs a slow render, esbuild, and a far bigger
 * archive, so the bar is "absolutely necessary", not "has JavaScript".
 */
export interface RuntimeFixture {
  name: string;
  url: string;
  html: string;
  preserveRuntime: boolean;
  why: string;
}

export const RUNTIME_FIXTURES: RuntimeFixture[] = [
  {
    name: "webgl-canvas-experience",
    url: "https://studio.example/reel",
    preserveRuntime: true,
    why: "the page IS a WebGL scene — a static snapshot is a black rectangle",
    html: `<!doctype html><html><head><title>REEL — studio.example</title>
<script type="module" crossorigin src="/assets/index-C9dK2f.js"></script>
<link rel="stylesheet" href="/assets/index-Bd91.css"></head>
<body><div id="app"><canvas id="scene"></canvas>
<div class="loader">LOADING 0%</div></div></body></html>`,
  },
  {
    name: "scroll-choreography-marketing",
    url: "https://agency.example/",
    preserveRuntime: true,
    why: "real text, but the presentation is scroll-driven canvas/film choreography",
    html: `<!doctype html><html><head><title>Agency — we make brands move</title>
<script type="module" crossorigin src="/assets/index-D3xPq.js"></script></head>
<body><main id="top"><section class="stage" data-scroll-container>
<canvas class="bg" width="1920" height="1080"></canvas>
<div class="pin" data-speed="0.4"><h1>We make brands move.</h1>
<p>Scroll to see the film. A story told frame by frame as you move.</p></div>
<section class="frames" data-frames="/films/hero/f_#.webp" data-frame-count="240"></section>
<video src="/films/loop.mp4" muted playsinline class="scrub"></video>
</section></main></body></html>`,
  },
  {
    name: "generative-art-piece",
    url: "https://artist.example/piece/42",
    preserveRuntime: true,
    why: "an empty mount the bundle draws into — nothing exists statically",
    html: `<!doctype html><html><head><title>Piece #42</title>
<script type="module" src="/sketch.js"></script></head>
<body><div id="root"></div><noscript>This piece requires JavaScript.</noscript></body></html>`,
  },
  {
    name: "hydrated-next-article",
    url: "https://magazine.example/essays/attention",
    preserveRuntime: false,
    why: "full article text is server-rendered; the bundle only hydrates chrome",
    html: `<!doctype html><html><head><title>The economics of attention</title>
<script src="/_next/static/chunks/webpack-a1.js" defer></script>
<script src="/_next/static/chunks/main-b2.js" defer></script>
<script src="/_next/static/chunks/pages/essay-c3.js" defer></script></head>
<body><div id="__next"><header><nav>Magazine</nav></header>
<article><h1>The economics of attention</h1>
<p>Attention is the scarcest resource in the modern economy. This essay examines how platforms compete for it, across four thousand words of plain readable text that renders perfectly without JavaScript.</p>
<p>More paragraphs of the essay follow with quotes, figures and footnotes.</p></article>
<footer>© 2026 The Magazine</footer></div>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script></body></html>`,
  },
  {
    name: "blog-post-with-decorative-canvas",
    url: "https://dev.example/blog/confetti",
    preserveRuntime: false,
    why: "a decorative confetti canvas doesn't make the post unreadable without JS",
    html: `<!doctype html><html><head><title>Shipping v2.0</title>
<script src="/js/confetti.min.js" defer></script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XY"></script></head>
<body><canvas id="confetti" style="position:fixed;inset:0;pointer-events:none"></canvas>
<article><h1>We shipped v2.0!</h1>
<p>Today we're releasing version 2.0 with a rewritten sync engine, offline mode, and a public API. Here's everything that changed and why it took a year.</p>
<h2>The new sync engine</h2><p>Long readable changelog text continues here.</p></article></body></html>`,
  },
  {
    name: "docs-page-with-widgets",
    url: "https://docs.example/guide/install",
    preserveRuntime: false,
    why: "script-heavy (search, highlighting, theme) but the docs read fine statically",
    html: `<!doctype html><html><head><title>Installation — docs.example</title>
<script type="module" src="/assets/docsearch-Bq2.js"></script>
<script type="module" src="/assets/theme-toggle-Cc1.js"></script>
<script type="module" src="/assets/prism-highlight-Dd4.js"></script></head>
<body><nav class="sidebar"><a href="/guide/">Guide</a><a href="/api/">API</a></nav>
<main><h1>Installation</h1><p>Install the package with your package manager of choice:</p>
<pre><code>npm install example</code></pre>
<p>Then import it and call init(). Full prose documentation continues with examples and tables.</p></main></body></html>`,
  },
];
