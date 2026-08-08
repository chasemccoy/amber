/**
 * Deterministic tests for keep-js mode: script classification,
 * module flattening (esbuild over the recorded-resources virtual filesystem —
 * local binary, no network), shim/data injection, and the runtime-asset map.
 * Everything is fed from an in-memory resources map, so no request is ever
 * made; a sequence group is kept below the fill threshold for the same reason.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cheerio from "cheerio";
import { applyKeepJs, finalizeKeepJsDelivery, injectRuntimeAssets, keepJsContentHash, type KeepJsReport } from "../src/keepjs.js";
import type { RenderedResource } from "../src/render.js";

const PAGE = "https://example.com/post/";

function res(body: string, contentType = "application/javascript", resourceType = "script"): RenderedResource {
  return { contentType, body: Buffer.from(body), resourceType };
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amber-keepjs-"));
}

function emptyReport(): KeepJsReport {
  return {
    trackersRemoved: 0, modulesBundled: 0, inlineModulesBundled: 0, classicKept: 0,
    chunksFetched: 0, replayEntries: 0, runtimeAssets: 0, sequenceFilled: 0,
    singleFile: false, inlinedBytes: 0, bundleBytes: 0, warnings: [],
  };
}

const HTML = `<html><head>
  <title>t</title>
  <script type="application/ld+json">{"@type":"Organization"}</script>
  <script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>
  <script>window.dataLayer = window.dataLayer || [];</script>
  <script type="module" src="/assets/app.js"></script>
  <script>window.classicKept = true;</script>
</head><body><p>hi</p></body></html>`;

test("applyKeepJs removes trackers, keeps classic, flattens modules, injects shim", async () => {
  const root = tmpdir();
  const $ = cheerio.load(HTML);
  const resources = new Map<string, RenderedResource>([
    ["https://example.com/assets/app.js", res(`import { x } from "./dep.js"; window.APP = x;`)],
    ["https://example.com/assets/dep.js", res(`export const x = 42;`)],
  ]);

  const report = await applyKeepJs($, { pageUrl: PAGE, resources, rootDir: root });

  assert.equal(report.trackersRemoved, 2); // gtm src + dataLayer inline
  assert.equal(report.modulesBundled, 1);
  assert.equal(report.classicKept, 1);
  assert.equal(report.warnings.length, 0);

  // Original module tag is gone; a local classic bundle took its place.
  assert.equal($('script[src="/assets/app.js"]').length, 0);
  const bundleTag = $('script[data-amber="bundle"]');
  assert.equal(bundleTag.length, 1);
  const rel = bundleTag.attr("src")!;
  assert.match(rel, /^assets\/static\/app-bundle-[0-9a-f]{8}\.js$/);
  const bundled = fs.readFileSync(path.join(root, rel), "utf8");
  assert.match(bundled, /42/); // dep resolved from the virtual fs
  assert.doesNotMatch(bundled, /\bimport\b\s*["']/); // flattened — no module syntax

  // Survivors: ld+json and the classic inline.
  assert.equal($('script[type="application/ld+json"]').length, 1);
  assert.match($.html(), /classicKept/);

  // Shim + replay data sit at the top of head.
  assert.equal($("#amber-replay-data").length, 1);
  assert.equal($('script[data-amber="shim"]').length, 1);
  assert.match($('script[data-amber="shim"]').html()!, /XMLHttpRequest/);

  fs.rmSync(root, { recursive: true, force: true });
});

test("applyKeepJs embeds xhr/fetch responses for replay, escaping </script>", async () => {
  const root = tmpdir();
  const $ = cheerio.load("<html><head></head><body></body></html>");
  const resources = new Map<string, RenderedResource>([
    ["https://example.com/api/data.json", res(`{"html":"</script><b>"}`, "application/json", "fetch")],
    ["https://example.com/img.png", res("png", "image/png", "image")],
  ]);

  const report = await applyKeepJs($, { pageUrl: PAGE, resources, rootDir: root });

  assert.equal(report.replayEntries, 1); // the fetch, not the image
  const data = $("#amber-replay-data").html()!;
  assert.doesNotMatch(data, /<\/script>/i); // must not terminate the element
  const parsed = JSON.parse(data.replace(/\\u003c/g, "<"));
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].url, "https://example.com/api/data.json");

  fs.rmSync(root, { recursive: true, force: true });
});

test("injectRuntimeAssets localises JS-loaded resources and embeds the url map", async () => {
  const $ = cheerio.load("<html><head></head><body></body></html>");
  const resources = new Map<string, RenderedResource>([
    ["https://example.com/films/a.mp4", res("vid", "video/mp4", "media")],
    ["https://example.com/chunk.js", res("js", "application/javascript", "script")], // skipped: bundled already
    ["https://example.com/hero.png", res("png", "image/png", "image")], // already captured below
  ]);
  const ensured: string[] = [];
  const cap = {
    assets: [{ url: "https://example.com/hero.png", localPath: "assets/images/hero-abc.png", ok: true }],
    async ensureAsset(url: string) {
      ensured.push(url);
      const a = { url, localPath: `assets/media/${path.basename(url)}`, ok: true };
      this.assets.push(a);
      return a;
    },
  };
  const report = emptyReport();

  await injectRuntimeAssets($, cap, resources, report);

  assert.deepEqual(ensured, ["https://example.com/films/a.mp4"]); // script + known skipped
  assert.equal(report.runtimeAssets, 1);
  assert.equal(report.sequenceFilled, 0); // below the ≥5 threshold — no probing
  const map = JSON.parse($("#amber-asset-map").html()!.replace(/\\u003c/g, "<"));
  assert.equal(map["https://example.com/films/a.mp4"], "assets/media/a.mp4");
  assert.equal(map["https://example.com/hero.png"], "assets/images/hero-abc.png");
});

function fakeArchive(): { root: string; $: import("cheerio").CheerioAPI } {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, "assets/images"), { recursive: true });
  fs.mkdirSync(path.join(root, "assets/static"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets/images/pic-abc.png"), Buffer.from("PNG!"));
  fs.writeFileSync(path.join(root, "assets/static/font-abc.woff2"), Buffer.from("WOFF"));
  fs.writeFileSync(path.join(root, "assets/static/site-abc.css"), "body{background:url(font-abc.woff2)}");
  fs.writeFileSync(path.join(root, "assets/static/app-bundle-abc.js"), `console.log("</script>")`);
  const $ = cheerio.load(`<html><head>
    <link rel="stylesheet" href="assets/static/site-abc.css">
    <script type="application/json" id="amber-asset-map">{"https://example.com/pic.png":"assets/images/pic-abc.png"}</script>
  </head><body>
    <img src="assets/images/pic-abc.png" srcset="assets/images/pic-abc.png 2x">
    <script data-amber="bundle" src="assets/static/app-bundle-abc.js"></script>
  </body></html>`);
  return { root, $ };
}

test("finalizeKeepJsDelivery inlines everything into a single file and removes assets/", () => {
  const { root, $ } = fakeArchive();
  const report = emptyReport();

  finalizeKeepJsDelivery($, root, report);

  assert.equal(report.singleFile, true);
  assert.ok(report.inlinedBytes > 0);
  assert.ok(!fs.existsSync(path.join(root, "assets")), "assets/ should be deleted");

  // The DOM holds tokens; the streamed index.html holds the expanded payloads.
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  assert.match(html, new RegExp(`src="data:image/png;base64,${b64("PNG!")}"`));
  assert.match(html, new RegExp(`srcset="data:image/png;base64,${b64("PNG!")} 2x"`));
  // stylesheet became <style>, its url() now a data: font
  assert.doesNotMatch(html, /rel="stylesheet"/);
  assert.match(html, new RegExp(`url\\(data:font/woff2;base64,${b64("WOFF")}\\)`));
  // bundle inlined with </script> escaped
  assert.doesNotMatch(html, /app-bundle-abc\.js/);
  assert.match(html, /console\.log\("<\\\/script>"\)/);
  // asset map values are data: URIs now
  assert.match(html, new RegExp(`"https://example\\.com/pic\\.png":"data:image/png;base64,${b64("PNG!")}"`));
  assert.doesNotMatch(html, /assets\/images\/pic-abc\.png/);
  assert.doesNotMatch(html, /@@AMBER\[/, "no unexpanded tokens");

  fs.rmSync(root, { recursive: true, force: true });
});

test("finalizeKeepJsDelivery falls back to a launcher when assets exceed the cap", () => {
  const { root, $ } = fakeArchive();
  const report = emptyReport();

  finalizeKeepJsDelivery($, root, report, { capBytes: 1 });

  assert.equal(report.singleFile, false);
  assert.ok(fs.existsSync(path.join(root, "assets/images/pic-abc.png")), "assets stay on disk");
  assert.equal($("img").attr("src"), "assets/images/pic-abc.png", "DOM untouched");
  const launcher = path.join(root, "View archive.command");
  assert.ok(fs.existsSync(launcher));
  assert.ok(fs.statSync(launcher).mode & 0o100, "launcher is executable");
  const launcherSrc = fs.readFileSync(launcher, "utf8");
  assert.match(launcherSrc, /^#!\/bin\/sh/);
  assert.match(launcherSrc, /node -e/);

  fs.rmSync(root, { recursive: true, force: true });
});

test("bundling pins import.meta.url to the ENTRY MODULE's URL, not the page's", async () => {
  const root = tmpdir();
  const $ = cheerio.load(`<html><head>
    <script type="module" src="/assets/app.js"></script>
  </head><body></body></html>`);
  const resources = new Map<string, RenderedResource>([
    // bruno-simon regression: co-located wasm resolved via import.meta.url —
    // against the page URL it loses the /assets/ prefix and 404s.
    ["https://example.com/assets/app.js", res(`window.WASM_URL = new URL("engine_bg.wasm", import.meta.url).href;`)],
  ]);

  const report = await applyKeepJs($, { pageUrl: PAGE, resources, rootDir: root });
  assert.equal(report.modulesBundled, 1);
  const rel = $('script[data-amber="bundle"]').attr("src")!;
  const bundled = fs.readFileSync(path.join(root, rel), "utf8");
  assert.match(bundled, /https:\/\/example\.com\/assets\/app\.js/);
  assert.doesNotMatch(bundled, /import\.meta/);

  fs.rmSync(root, { recursive: true, force: true });
});

test("keepJsContentHash ignores animation churn but tracks text, assets, and code", () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, "assets/images"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets/images/pic-abc.png"), Buffer.from("V1"));
  const page = (rotate: string, text: string) =>
    cheerio.load(`<html><head><style>.x{color:red}</style></head><body>
      <div style="transform: rotate(${rotate}deg)"><p>${text}</p></div>
      <script>var runtimeNoise = ${JSON.stringify(rotate)};</script>
    </body></html>`);
  const assets = ["assets/images/pic-abc.png"];

  const a = keepJsContentHash(page("28.4", "Hello"), root, assets);
  const b = keepJsContentHash(page("26.2", "Hello"), root, assets);
  assert.equal(a, b, "mid-animation attribute + script churn must not change the hash");

  const c = keepJsContentHash(page("28.4", "Hello, edited"), root, assets);
  assert.notEqual(a, c, "visible text changes must change the hash");

  fs.writeFileSync(path.join(root, "assets/images/pic-abc.png"), Buffer.from("V2"));
  const d = keepJsContentHash(page("28.4", "Hello"), root, assets);
  assert.notEqual(a, d, "changed asset bytes at the same path must change the hash");

  fs.rmSync(root, { recursive: true, force: true });
});

test("injectRuntimeAssets fills numeric-sequence gaps via fetch (scroll-scrub frames)", async () => {
  const $ = cheerio.load("<html><head></head><body></body></html>");
  // Frames 2,4,6,8,12 recorded — 10 is the gap the render's scroll skipped.
  const resources = new Map<string, RenderedResource>();
  for (const n of [2, 4, 6, 8, 12]) {
    resources.set(
      `https://example.com/films/hero/f_${String(n).padStart(3, "0")}.webp`,
      res("frame", "image/webp", "image"),
    );
  }
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    fetched.push(String(url));
    return new Response(Buffer.from("filled"), { status: 200, headers: { "content-type": "image/webp" } });
  }) as typeof fetch;

  try {
    const cap = {
      assets: [] as Array<{ url: string; localPath: string; ok: boolean }>,
      async ensureAsset(url: string) {
        const a = { url, localPath: `assets/images/${path.basename(new URL(url).pathname)}`, ok: true };
        this.assets.push(a);
        return a;
      },
    };
    const report = emptyReport();
    await injectRuntimeAssets($, cap, resources, report);

    assert.deepEqual(fetched, ["https://example.com/films/hero/f_010.webp"], "exactly the gap, nothing else");
    assert.equal(report.sequenceFilled, 1);
    assert.equal(report.runtimeAssets, 6); // 5 recorded + 1 filled
    const map = JSON.parse($("#amber-asset-map").html()!.replace(/\\u003c/g, "<"));
    assert.equal(map["https://example.com/films/hero/f_010.webp"], "assets/images/f_010.webp");
  } finally {
    globalThis.fetch = realFetch;
  }
});
