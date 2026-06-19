/** Deterministic tests — no network, no API key, no browser.
 *  Run: pnpm test   (node --import tsx --test test/*.test.ts) */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cheerio from "cheerio";

import { slugFor, subdirFor, CSS_URL_RE, Capturer } from "../src/capture.js";
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

test("subdirFor routes images, media, and static", () => {
  assert.equal(subdirFor("image/png", "http://a/x.png"), "images");
  assert.equal(subdirFor("", "http://a/photo.jpg"), "images");
  assert.equal(subdirFor("text/css", "http://a/s.css"), "static");
  assert.equal(subdirFor("font/woff2", "http://a/f.woff2"), "static");
  // self-hosted media → media/, by content-type or by extension
  assert.equal(subdirFor("video/mp4", "http://a/clip"), "media");
  assert.equal(subdirFor("", "http://a/clip.webm"), "media");
  assert.equal(subdirFor("audio/mpeg", "http://a/song.mp3"), "media");
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

test("heuristicPlan derives tags from meta keywords / article:tag, normalised", () => {
  const $ = cheerio.load(`<html><head><title>T</title>
    <meta name="keywords" content="Rust, Static Site, rust">
    <meta property="article:tag" content="Markdown"></head>
    <body><article>hi</article></body></html>`);
  const plan = heuristicPlan($);
  assert.deepEqual(plan.tags, ["rust", "static site", "markdown"]); // lowercased, deduped
  // No meta → no heuristic tags (the gap the LLM closes).
  assert.deepEqual(heuristicPlan(cheerio.load("<html><body><p>x</p></body></html>")).tags, []);
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
    tags: [],
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
    tags: [],
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
    tags: [],
    notes: "",
    source: "test",
  };
  const report = await applyPlan($, plan, "/tmp/_archiver_test_sel");
  assert.equal(report.removeErrors.length, 0); // no longer recorded as a failure
  assert.ok(!$.html().includes("junk drawer")); // and actually removed
  assert.ok($.html().includes("keep me"));
});

test("captureAssets localises a stylesheet and strips crossorigin/integrity so it loads offline", async () => {
  // Uses the prefetched-resources path, so no network. A `crossorigin` <link>
  // would be dropped by the browser when opened from file://; SRI would also
  // fail. Both must be removed once the href is local.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amber-cap-"));
  const url = "https://ex.test/page";
  const cssUrl = "https://ex.test/style.css";
  const cap = new Capturer(tmp, { timeoutMs: 1000, insecureTLS: false });
  cap.loadRender({
    html: `<html><head><link rel="stylesheet" href="${cssUrl}" crossorigin integrity="sha256-abc"></head><body>hi</body></html>`,
    finalUrl: url,
    baseUrl: url,
    resources: new Map([[cssUrl, { contentType: "text/css", body: Buffer.from("body{color:red}") }]]),
  });
  await cap.captureAssets();
  const out = cap.$.html();
  assert.match(out, /href="assets\/static\//); // stylesheet localised
  assert.ok(!/crossorigin/i.test(out)); // guard attr stripped
  assert.ok(!/integrity/i.test(out)); // SRI stripped
});

test("captureAssets rewrites url() inside <style> elements to local paths", async () => {
  // A <style> block (e.g. MathJax @font-face) isn't a style attribute or a .css
  // file, so its url()s used to be left pointing at the network. No network here
  // — the font is served from the prefetched map.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amber-cap-style-"));
  const url = "https://ex.test/page";
  const fontUrl = "https://ex.test/fonts/math.woff";
  const cap = new Capturer(tmp, { timeoutMs: 1000, insecureTLS: false });
  cap.loadRender({
    html: `<html><head><style>@font-face{font-family:M;src:url(${fontUrl})}</style></head><body>hi</body></html>`,
    finalUrl: url,
    baseUrl: url,
    resources: new Map([[fontUrl, { contentType: "font/woff", body: Buffer.from("FONT") }]]),
  });
  await cap.captureAssets();
  const out = cap.$.html();
  assert.ok(!out.includes(fontUrl)); // external font url() localised
  assert.match(out, /url\(assets\/static\//); // now points at the local copy
});

test("applyPlan always strips scripts, noscript, and JS/connection hints, even when not in the plan", async () => {
  const $ = cheerio.load(`<html><head>
    <link rel="preconnect" href="https://fonts.gstatic.com">
    <link rel="dns-prefetch" href="https://cdn.example.com">
    <link rel="modulepreload" href="https://cdn.example.com/app-abc.js">
    <link rel="prefetch" href="https://cdn.example.com/next-page.js">
    <link rel="preload" as="script" href="https://cdn.example.com/boot.js">
    <link rel="preload" as="font" href="assets/static/body.woff2">
    <link rel="stylesheet" href="assets/static/site.css"></head><body>
    <article id="main">keep me</article>
    <script src="assets/static/widgets.js"></script>
    <noscript>please enable javascript</noscript></body></html>`);
  const plan: CleanupPlan = {
    title: "t",
    mainContentSelector: "#main",
    removeSelectors: [], // deliberately empty — stripping must be unconditional
    media: [],
    tags: [],
    notes: "",
    source: "test",
  };
  const report = await applyPlan($, plan, "/tmp/_archiver_test_strip");
  const out = $.html();
  assert.ok(!/<script/i.test(out)); // scripts gone (they run and phone home)
  assert.ok(!/<noscript/i.test(out));
  assert.ok(!/preconnect|dns-prefetch/i.test(out)); // connection hints gone
  assert.ok(!/modulepreload|prefetch/i.test(out)); // JS-loading hints gone
  assert.ok(!out.includes("boot.js")); // preload as=script gone
  assert.ok(!out.includes(".js")); // no .js reference survives anywhere
  assert.match(out, /assets\/static\/body\.woff2/); // legit font preload kept
  assert.match(out, /assets\/static\/site\.css/); // real stylesheet kept
  assert.ok(out.includes("keep me")); // main content kept
  assert.ok(report.removed >= 6); // script + noscript + 2 conn hints + 2 JS hints
});

test("CSS_URL_RE matches url() and skips data: URIs", () => {
  const css = "a{background:url( 'f.woff' )}b{src:url(data:x)}c{background:url(/img.png)}";
  const urls = [...css.matchAll(CSS_URL_RE)].map((m) => m[2]);
  assert.ok(urls.includes("f.woff"));
  assert.ok(urls.includes("/img.png"));
});
