/** Deterministic tests — no network, no API key, no browser.
 *  Run: pnpm test   (node --import tsx --test test/*.test.ts) */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";

import { slugFor, subdirFor, CSS_URL_RE } from "../src/capture.js";
import { heuristicPlan } from "../src/planner.js";
import { applyPlan } from "../src/clean.js";
import { assessRendering } from "../src/pipeline.js";
import type { CleanupPlan } from "../src/types.js";

test("assessRendering escalates client-rendered pages, keeps server-rendered ones", () => {
  // A real article's worth of text — static capture is enough.
  const article = cheerio.load(
    `<body><article><h1>A real post</h1><p>${"word ".repeat(80)}</p></article></body>`,
  );
  assert.equal(assessRendering(article).escalate, false);

  // An empty SPA mount node — needs a browser render.
  const spa = cheerio.load(`<body><div id="root"></div><script src="/app.js"></script></body>`);
  assert.equal(assessRendering(spa).escalate, true);

  // Near-empty body (no recognised root, just not enough text) — escalate.
  const thin = cheerio.load(`<body><div>loading…</div></body>`);
  assert.equal(assessRendering(thin).escalate, true);
});

test("slugFor is stable, safe, and collision-resistant", () => {
  const a = slugFor("https://x.test/path/Foo Bar.CSS?v=1", "text/css");
  const b = slugFor("https://x.test/path/Foo Bar.CSS?v=1", "text/css");
  assert.equal(a, b); // stable
  assert.ok(!a.includes(" "));
  assert.ok(a.endsWith(".CSS"));
  // different URLs sharing a basename don't collide
  assert.notEqual(a, slugFor("https://y.test/path/Foo Bar.CSS?v=1", "text/css"));
});

test("subdirFor routes images vs static", () => {
  assert.equal(subdirFor("image/png", "http://a/x.png"), "images");
  assert.equal(subdirFor("", "http://a/photo.jpg"), "images");
  assert.equal(subdirFor("text/css", "http://a/s.css"), "static");
  assert.equal(subdirFor("font/woff2", "http://a/f.woff2"), "static");
});

test("heuristicPlan finds junk but keeps main content", () => {
  const $ = cheerio.load(`<html><head><title>T</title></head><body>
    <div id="cookie-banner">cookies</div>
    <aside class="newsletter-signup">sub</aside>
    <div class="advert-top">ad</div>
    <article id="content">real text</article>
    <script>track()</script></body></html>`);
  const plan = heuristicPlan($);
  assert.equal(plan.title, "T");
  assert.ok(plan.removeSelectors.includes("script"));
  assert.ok(plan.removeSelectors.includes("#cookie-banner"));
  assert.ok(plan.removeSelectors.some((s) => s.includes("newsletter-signup")));
  assert.ok(plan.removeSelectors.some((s) => s.includes("advert-top")));
  assert.ok(!plan.removeSelectors.includes("#content")); // never the main content
});

test("applyPlan removes junk and sanitises, leaving the original markup faithful", async () => {
  const $ = cheerio.load(`<html><body>
    <div id="ad">junk</div>
    <article id="main">keep me</article>
    <a href="javascript:evil()">x</a>
    <button onclick="boom()">b</button></body></html>`);
  const plan: CleanupPlan = {
    title: "t",
    mainContentSelector: "#main",
    removeSelectors: ["#ad"],
    media: [],
    notes: "",
    source: "test",
  };
  await applyPlan($, plan, "/tmp/_archiver_test");
  const out = $.html();
  assert.ok(!out.includes("junk")); // junk removed
  assert.ok(out.includes("keep me")); // main content kept
  assert.ok(!out.includes("javascript:")); // dead js href neutralised
  assert.ok(!/onclick/i.test(out)); // inline handler stripped
  assert.ok(!out.includes("data-archiver")); // no banner injected — page stays faithful
});

test("applyPlan leaves the embed in place when media download fails", async () => {
  // Pointing at an unresolvable host makes yt-dlp fail; the iframe must survive.
  const $ = cheerio.load(
    `<body><div class="embed"><iframe src="https://youtube.com/embed/ID"></iframe></div></body>`,
  );
  const plan: CleanupPlan = {
    title: "t",
    mainContentSelector: null,
    removeSelectors: [],
    media: [
      {
        embedSelector: 'iframe[src*="youtube"]',
        sourceUrl: "https://invalid.invalid/nope",
        kind: "video",
      },
    ],
    notes: "",
    source: "test",
  };
  const report = await applyPlan($, plan, "/tmp/_archiver_test_media");
  assert.equal(report.media[0]!.ok, false);
  assert.ok($("iframe").length === 1); // not swapped — embed preserved
  assert.ok(!$.html().includes("<video")); // and no broken local <video>
});

test("applyPlan removes elements whose id is an unescaped React useId selector", async () => {
  // `#drawer_:R196:` is illegal CSS (colons), so the engine throws; we fall
  // back to an attribute selector and the drawer still gets removed.
  const $ = cheerio.load(
    `<body><div id="drawer_:R196:">junk drawer</div><article>keep me</article></body>`,
  );
  const plan: CleanupPlan = {
    title: "t",
    mainContentSelector: null,
    removeSelectors: ["#drawer_:R196:"],
    media: [],
    notes: "",
    source: "test",
  };
  const report = await applyPlan($, plan, "/tmp/_archiver_test_sel");
  assert.equal(report.removeErrors.length, 0); // no longer recorded as a failure
  assert.ok(!$.html().includes("junk drawer")); // and actually removed
  assert.ok($.html().includes("keep me"));
});

test("CSS_URL_RE matches url() and skips data: URIs", () => {
  const css = "a{background:url( 'f.woff' )}b{src:url(data:x)}c{background:url(/img.png)}";
  const urls = [...css.matchAll(CSS_URL_RE)].map((m) => m[2]);
  assert.ok(urls.includes("f.woff"));
  assert.ok(urls.includes("/img.png"));
});
