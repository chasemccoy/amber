/** Deterministic tests — no network, no API key, no browser.
 *  Run: pnpm test   (node --import tsx --test test/*.test.ts) */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cheerio from "cheerio";

import { slugFor, subdirFor, CSS_URL_RE, Capturer } from "../src/capture.js";
import { heuristicPlan, parsePlan } from "../src/planner.js";
import { applyPlan } from "../src/clean.js";
import { mediaElementHtml } from "../src/media.js";
import { assessRendering, slugifyUrl, archiveFromDom } from "../src/pipeline.js";
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

test("slugifyUrl strips www, collapses trailing slashes, sanitises, and caps length", () => {
  assert.equal(slugifyUrl("https://www.example.com/blog/post/"), "example.com-blog-post");
  assert.equal(slugifyUrl("https://example.com"), "example.com"); // bare host
  assert.equal(slugifyUrl("not a url"), "not-a-url"); // unparseable → sanitised raw
  assert.ok(slugifyUrl("https://e.test/" + "x".repeat(200)).length <= 80); // capped
});

test("parsePlan fills defaults for a partial plan and rejects non-plans", () => {
  const p = parsePlan({ removeSelectors: ["#ad"], tags: ["Rust", "rust"] });
  assert.equal(p.title, "");
  assert.equal(p.mainContentSelector, null);
  assert.deepEqual(p.removeSelectors, ["#ad"]);
  assert.deepEqual(p.media, []);
  assert.deepEqual(p.tags, ["rust"]); // normalised + deduped
  assert.equal(p.source, "file"); // default source for a loaded plan
  // media kind defaults to "video"
  const m = parsePlan({ media: [{ embedSelector: "iframe", sourceUrl: "u" }] });
  assert.equal(m.media[0]!.kind, "video");
  // garbage is rejected rather than silently producing a broken plan
  assert.throws(() => parsePlan("nope"));
  assert.throws(() => parsePlan({ removeSelectors: "not-an-array" }));
});

test("mediaElementHtml builds video/audio markup with a text fallback", () => {
  const v = mediaElementHtml("video", "assets/media/x.mp4");
  assert.match(v, /^<video controls style=/); // sized for the page
  assert.ok(v.includes('<source src="assets/media/x.mp4"/>'));
  assert.ok(v.includes("[archived media: assets/media/x.mp4]")); // fallback present
  assert.match(mediaElementHtml("audio", "assets/media/y.mp3"), /^<audio controls>/); // no style on audio
});

test("applyPlan removes elements via a class selector with illegal CSS chars", async () => {
  // `.drawer:R1:` is illegal CSS, like the React useId id case but on a class.
  const $ = cheerio.load(`<body><div class="drawer:R1:">junk drawer</div><article>keep me</article></body>`);
  const plan: CleanupPlan = {
    title: "t",
    mainContentSelector: null,
    removeSelectors: [".drawer:R1:"],
    media: [],
    tags: [],
    notes: "",
    source: "test",
  };
  const report = await applyPlan($, plan, "/tmp/_amber_cls");
  assert.equal(report.removeErrors.length, 0); // fell back to an attribute selector
  assert.ok(!$.html().includes("junk drawer")); // and removed it
  assert.ok($.html().includes("keep me"));
});

test("captureAssets localises srcset entries, preserving descriptors", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amber-srcset-"));
  const url = "https://ex.test/page";
  const a = "https://ex.test/a.png";
  const b = "https://ex.test/b.png";
  const cap = new Capturer(tmp, { timeoutMs: 1000, insecureTLS: false });
  cap.loadRender({
    html: `<body><img srcset="${a} 1x, ${b} 2x"></body>`,
    finalUrl: url,
    baseUrl: url,
    resources: new Map([
      [a, { contentType: "image/png", body: Buffer.from("A") }],
      [b, { contentType: "image/png", body: Buffer.from("B") }],
    ]),
  });
  await cap.captureAssets();
  const out = cap.$.html();
  assert.ok(!out.includes(a) && !out.includes(b)); // both entries localised
  assert.match(out, /assets\/images\/\S+ 1x, assets\/images\/\S+ 2x/); // 1x/2x descriptors kept
});

test("captureAssets rewrites url() inside a linked .css file (recursively)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amber-cssfile-"));
  const url = "https://ex.test/page";
  const cssUrl = "https://ex.test/site.css";
  const fontUrl = "https://ex.test/font.woff2";
  const cap = new Capturer(tmp, { timeoutMs: 1000, insecureTLS: false });
  cap.loadRender({
    html: `<head><link rel="stylesheet" href="${cssUrl}"></head><body>hi</body>`,
    finalUrl: url,
    baseUrl: url,
    resources: new Map([
      [cssUrl, { contentType: "text/css", body: Buffer.from(`@font-face{src:url(${fontUrl})}`) }],
      [fontUrl, { contentType: "font/woff2", body: Buffer.from("FONT") }],
    ]),
  });
  await cap.captureAssets();
  const cssAsset = cap.assets.find((x) => x.url === cssUrl)!;
  const css = fs.readFileSync(path.join(tmp, cssAsset.localPath), "utf8");
  assert.ok(!css.includes(fontUrl)); // network url() gone
  assert.match(css, /url\(font-[0-9a-f]{8}\.woff2\)/); // rewritten to the local sibling
});

test("archiveFromDom builds a self-contained folder from a pre-captured DOM (no network)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amber-dom-"));
  const url = "https://ex.test/post";
  const imgUrl = "https://ex.test/pic.png";
  const html = `<!doctype html><html><head><title>Post</title></head><body>
    <div id="cookie-banner">cookies</div>
    <article id="content"><img src="${imgUrl}"> real text</article>
    <script>track()</script></body></html>`;
  const res = await archiveFromDom(
    {
      url,
      html,
      resources: [{ url: imgUrl, contentType: "image/png", bodyBase64: Buffer.from("PNG").toString("base64") }],
    },
    { outRoot: tmp, useLLM: false, model: "x", verbose: false, insecureTLS: false }, // useLLM:false → offline heuristics
  );
  const out = fs.readFileSync(path.join(res.outDir, "index.html"), "utf8");
  assert.match(out, /assets\/images\//); // image localised from the payload, no network
  assert.ok(!/<script/i.test(out)); // scripts stripped
  assert.ok(!out.includes("cookies")); // heuristic junk removed
  assert.ok(out.includes("real text")); // main content kept
  assert.ok(fs.existsSync(path.join(res.outDir, "plan.json")));
  assert.equal(res.plan.source, "heuristic");
  assert.equal(res.changed, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(res.outDir, "manifest.json"), "utf8"));
  assert.equal(manifest.sourceUrl, url);
  assert.ok(!Number.isNaN(Date.parse(manifest.capturedAt))); // ISO capture timestamp recorded
  assert.ok(/^[0-9a-f]{64}$/.test(manifest.contentHash)); // content hash recorded
});

test("archiveFromDom versions snapshots and skips unchanged re-captures", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amber-ver-"));
  const url = "https://ex.test/post";
  const opts = { outRoot: tmp, useLLM: false, model: "x", verbose: false, insecureTLS: false };

  const v1 = await archiveFromDom({ url, html: `<article id="content">version one</article>` }, opts);
  assert.equal(v1.changed, true);
  assert.equal(v1.archivedTo, null);

  // Identical re-capture → skipped, no version created.
  const again = await archiveFromDom({ url, html: `<article id="content">version one</article>` }, opts);
  assert.equal(again.changed, false);
  assert.equal(again.outDir, v1.outDir);
  assert.ok(!fs.existsSync(path.join(v1.outDir, "versions")));

  // Changed content → previous latest rotates into versions/.
  const v2 = await archiveFromDom({ url, html: `<article id="content">version two</article>` }, opts);
  assert.equal(v2.changed, true);
  assert.ok(v2.archivedTo);
  const versions = fs.readdirSync(path.join(v1.outDir, "versions"));
  assert.equal(versions.length, 1);
  assert.match(fs.readFileSync(path.join(v1.outDir, "index.html"), "utf8"), /version two/); // latest
  assert.match(
    fs.readFileSync(path.join(v1.outDir, "versions", versions[0]!, "index.html"), "utf8"),
    /version one/, // older snapshot preserved
  );

  // No staging dirs left lying around under the archive root.
  assert.ok(!fs.readdirSync(tmp).some((n) => n.startsWith(".amber-tmp-")));
});
