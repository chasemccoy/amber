/**
 * archiveUrl() end-to-end over a localhost HTTP server — the fetch-backend
 * orchestration that archiveFromDom tests can't reach (probe, capture, plan,
 * package, unchanged-skip), with zero external network and no browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { archiveUrl, slugifyUrl } from "../src/pipeline.js";

const PAGE = `<html><head>
  <title>Server-rendered post</title>
  <link rel="stylesheet" href="/style.css">
</head><body>
  <article>
    <h1>A server-rendered post</h1>
    <p>${"Plenty of visible body text so the static probe is satisfied. ".repeat(8)}</p>
    <img src="/photo.png" alt="a photo">
  </article>
  <script src="/tracker.js"></script>
</body></html>`;

function serve(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      res.end(PAGE);
    } else if (req.url === "/style.css") {
      res.setHeader("content-type", "text/css");
      res.end("body { color: #222; }");
    } else if (req.url === "/photo.png") {
      res.setHeader("content-type", "image/png");
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    } else if (req.url === "/tracker.js") {
      res.setHeader("content-type", "text/javascript");
      res.end("void 0;");
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    }),
  );
}

const OPTS = {
  useLLM: false,
  model: "unused",
  verbose: false,
  insecureTLS: false,
  timeoutMs: 5000,
} as const;

test("archiveUrl (auto backend) captures a server-rendered page without escalating", async () => {
  const { server, base } = await serve();
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amber-e2e-"));
  try {
    const res = await archiveUrl(`${base}/`, { ...OPTS, outRoot, backend: "auto" });

    const html = fs.readFileSync(path.join(res.outDir, "index.html"), "utf8");
    assert.match(html, /A server-rendered post/);
    assert.ok(!html.includes(base), "no reference should point back at the origin");
    assert.match(html, /assets\/static\/style-[0-9a-f]{8}\.css/, "stylesheet should be localised");
    assert.match(html, /assets\/images\/photo-[0-9a-f]{8}\.png/, "image should be localised");
    assert.ok(!html.includes("<script"), "scripts should be stripped");

    const manifest = JSON.parse(fs.readFileSync(path.join(res.outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.backend, "fetch", "content-rich page should not escalate to a browser");
    assert.equal(manifest.planSource, "heuristic");
    assert.ok(fs.existsSync(path.join(res.outDir, "plan.json")));
    assert.equal(res.assetErrors, 0);
  } finally {
    server.close();
    fs.rmSync(outRoot, { recursive: true, force: true });
  }
});

test("archiveUrl never downloads assets referenced only by junk (junk removed before capture)", async () => {
  const requested: string[] = [];
  const junkPage = `<html><head><title>Post</title></head><body>
    <article>
      <h1>A post</h1>
      <p>${"Plenty of visible body text so the static probe is satisfied. ".repeat(8)}</p>
      <img src="/photo.png" alt="a photo">
    </article>
    <div class="cookie-banner"><img src="/cookie-art.png" alt=""></div>
  </body></html>`;
  const server = createServer((req, res) => {
    requested.push(req.url ?? "");
    if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      res.end(junkPage);
    } else if (req.url === "/photo.png" || req.url === "/cookie-art.png") {
      res.setHeader("content-type", "image/png");
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  const base = await new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    }),
  );
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amber-e2e-"));
  try {
    const res = await archiveUrl(`${base}/`, { ...OPTS, outRoot, backend: "fetch" });

    assert.ok(requested.includes("/photo.png"), "the article image should be downloaded");
    assert.ok(!requested.includes("/cookie-art.png"), "the junk-only image should never be requested");

    const html = fs.readFileSync(path.join(res.outDir, "index.html"), "utf8");
    assert.ok(!html.includes("cookie-banner"), "junk element should be removed");
    const manifest = JSON.parse(fs.readFileSync(path.join(res.outDir, "manifest.json"), "utf8"));
    const assetUrls = manifest.assets.map((a: { url: string }) => a.url);
    assert.ok(!assetUrls.some((u: string) => u.includes("cookie-art")), "junk asset should not be in the manifest");
  } finally {
    server.close();
    fs.rmSync(outRoot, { recursive: true, force: true });
  }
});

test("archiveUrl skips an unchanged re-archive and versions a changed one", async () => {
  const { server, base } = await serve();
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amber-e2e-"));
  try {
    const first = await archiveUrl(`${base}/`, { ...OPTS, outRoot, backend: "fetch" });
    assert.equal(first.changed, true);

    const again = await archiveUrl(`${base}/`, { ...OPTS, outRoot, backend: "fetch" });
    assert.equal(again.changed, false, "identical content should be skipped");
    assert.ok(!fs.existsSync(path.join(first.outDir, "versions")), "no version should rotate for a skip");
  } finally {
    server.close();
    fs.rmSync(outRoot, { recursive: true, force: true });
  }
});

test("slugifyUrl never yields a traversal — '.' and '..' are valid hosts to the URL parser", () => {
  assert.equal(slugifyUrl("http://../"), "archive");
  assert.equal(slugifyUrl("http://./"), "archive");
  assert.equal(slugifyUrl("http://a.b/.."), "a.b"); // trailing dot-segments are already normalised by URL
});

test("slugifyUrl de-fangs macOS bundle extensions (.app folders can't open in Finder)", () => {
  assert.equal(slugifyUrl("https://linear.app/"), "linear-app");
  assert.equal(slugifyUrl("https://linear.app/customers"), "linear.app-customers");
  assert.equal(slugifyUrl("https://example.framework/"), "example-framework");
  assert.equal(slugifyUrl("https://pear.no/"), "pear.no"); // normal hosts unchanged
});

// --- Wayback Machine captures ---------------------------------------------

const OLD_PAGE = Buffer.from(
  `<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
  <title>Caf\xe9 du Web — 2009</title>
  <link rel="stylesheet" href="style.css"></head><body>
  <h1>Bienvenue au caf\xe9</h1>
  <p>${"Text from two thousand and nine, plenty of it for the probe. ".repeat(6)}</p>
  <img src="/img/logo.gif"><img src="http://cdn.example.test/gone.png">
  <a href="/about.html">About</a>
  </body></html>`.replace("—", "-"),
  "latin1",
);

/**
 * A fake Wayback Machine: /web/<ts>id_/<url> answers with the ORIGINAL bytes.
 * A request whose timestamp has no exact capture 302s to the nearest one
 * (keeping id_), the served response carries Memento-Datetime, and an asset
 * Wayback never captured is a 404.
 */
function serveWayback(): Promise<{ server: Server; base: string; log: string[] }> {
  const log: string[] = [];
  const ACTUAL = "20090615083000";
  const server = createServer((req, res) => {
    log.push(req.url!);
    if (req.url === "/elsewhere") {
      // Off the archive: a live page that is NOT a capture (no Memento-Datetime).
      res.setHeader("content-type", "text/html");
      return res.end("<html><body>not a capture</body></html>");
    }
    const m = /^\/web\/(\d+)id_\/(.+)$/.exec(req.url!);
    if (!m) {
      res.statusCode = 400;
      return res.end("bad");
    }
    const [, ts, original] = m;
    if (original === "http://old.example.test/away") {
      res.statusCode = 302;
      res.setHeader("location", "/elsewhere");
      return res.end();
    }
    const KNOWN = ["http://old.example.test/", "http://old.example.test/style.css", "http://old.example.test/img/logo.gif"];
    if (!KNOWN.includes(original!)) {
      // Never captured: Wayback's own error page — a 404 with NO Memento-Datetime
      // and no nearest-capture redirect.
      res.statusCode = 404;
      return res.end("<html>Wayback Machine has not archived that URL.</html>");
    }
    if (ts !== ACTUAL) {
      // Snap to the nearest capture, preserving the modifier.
      res.statusCode = 302;
      res.setHeader("location", `/web/${ACTUAL}id_/${original}`);
      return res.end();
    }
    res.setHeader("memento-datetime", "Mon, 15 Jun 2009 08:30:00 GMT");
    if (original === "http://old.example.test/") {
      res.setHeader("content-type", "text/html; charset=iso-8859-1");
      return res.end(OLD_PAGE);
    }
    if (original === "http://old.example.test/style.css") {
      res.setHeader("content-type", "text/css");
      return res.end("body { font-family: Verdana; }");
    }
    if (original === "http://old.example.test/img/logo.gif") {
      res.setHeader("content-type", "image/gif");
      return res.end(Buffer.from("GIF89a"));
    }
    res.statusCode = 500; // unreachable: every KNOWN url is handled above
    res.end();
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}`, log });
    }),
  );
}

test("archiveUrl on a Wayback URL captures the ORIGINAL bytes, routes assets through the archive, and dates the snapshot", async () => {
  const { server, base, log } = await serveWayback();
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amber-wb-"));
  try {
    // Requested "2009" — the fake snaps to 20090615083000.
    const res = await archiveUrl(`${base}/web/2009/http://old.example.test/`, {
      ...OPTS,
      outRoot,
      backend: "auto",
      wayback: { base, requestDelayMs: 0 },
    });

    // Filed under the ORIGINAL url's slug, not web.archive.org's.
    assert.equal(path.basename(res.outDir), "old.example.test");
    assert.equal(res.snapshot?.wayback.timestamp, "20090615083000");
    assert.equal(res.snapshot?.wayback.requested, "2009");
    assert.equal(res.snapshot?.snapshotAt, "2009-06-15T08:30:00.000Z");

    const html = fs.readFileSync(path.join(res.outDir, "index.html"), "utf8");
    assert.match(html, /Bienvenue au café/, "latin-1 page decoded by its declared charset");
    // The archive is UTF-8 now, and must SAY so — the page's own iso-8859-1
    // declaration would make a browser mojibake our bytes.
    assert.match(html, /<meta charset="utf-8">/);
    assert.doesNotMatch(html, /iso-8859-1/i);
    assert.match(html, /assets\/static\/style-[0-9a-f]{8}\.css/, "stylesheet localised");
    assert.match(html, /assets\/images\/logo-[0-9a-f]{8}\.gif/, "image localised");
    assert.ok(!html.includes("web.archive.org") && !html.includes(base), "no Wayback URLs leak into the archive");
    assert.match(html, /href="\/about\.html"/, "links stay as the original site's URLs");

    // Every asset request went through the archive at the served timestamp.
    assert.ok(log.some((u) => u === "/web/20090615083000id_/http://old.example.test/style.css"), `asset fetched via id_: ${log.join(" ")}`);
    // The never-captured asset is an honest error, not a crash.
    assert.equal(res.assetErrors, 1);

    const manifest = JSON.parse(fs.readFileSync(path.join(res.outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.sourceUrl, "http://old.example.test/");
    assert.equal(manifest.snapshotAt, "2009-06-15T08:30:00.000Z");
    assert.equal(manifest.backend, "wayback");
    assert.match(manifest.wayback.url, /\/web\/20090615083000\/http:\/\/old\.example\.test\/$/);
    assert.ok(manifest.capturedAt > "2026", "capturedAt is still the real run time");
  } finally {
    server.close();
    fs.rmSync(outRoot, { recursive: true, force: true });
  }
});

test("a Wayback capture older than an existing live capture is filed as a version under the same slug", async () => {
  const { server: live, base: liveBase } = await serve();
  const { server: wb, base: wbBase } = await serveWayback();
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amber-wb-"));
  try {
    // The fake Wayback serves the original as http://old.example.test/ — give
    // the live capture the same slug by archiving a page at that host name
    // through a manifest-level trick: archive the live server, then rename.
    const liveRes = await archiveUrl(`${liveBase}/`, { ...OPTS, outRoot, backend: "fetch" });
    const slugDir = path.join(outRoot, "old.example.test");
    fs.renameSync(liveRes.outDir, slugDir);

    // --at instead of a Wayback URL this time: same path, resolved by the archive itself.
    const res = await archiveUrl("http://old.example.test/", {
      ...OPTS,
      outRoot,
      backend: "auto",
      at: "2009-06",
      wayback: { base: wbBase, requestDelayMs: 0 },
    });

    assert.equal(res.outDir, slugDir);
    assert.equal(res.snapshot?.wayback.requested, "2009-06");
    assert.equal(res.filedAs, path.join(slugDir, "versions", "20090615T083000Z"), "filed by snapshot date");
    assert.equal(res.archivedTo, null);
    assert.match(fs.readFileSync(path.join(slugDir, "index.html"), "utf8"), /A server-rendered post/, "today's capture still at the root");
    assert.match(fs.readFileSync(path.join(res.filedAs!, "index.html"), "utf8"), /Bienvenue/);
  } finally {
    live.close();
    wb.close();
    fs.rmSync(outRoot, { recursive: true, force: true });
  }
});

test("Wayback guards: a redirect off the archive, a calendar URL, and an empty --at are errors, not archives", async () => {
  const { server, base, log } = await serveWayback();
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amber-wb-"));
  try {
    // Wayback bounced the request to a live page: that page is not a capture
    // and must not be filed under the requested stamp.
    await assert.rejects(
      archiveUrl(`${base}/web/2009/http://old.example.test/away`, { ...OPTS, outRoot, backend: "auto", wayback: { base, requestDelayMs: 0 } }),
      /off the archive/,
    );
    assert.ok(log.includes("/elsewhere"), "the redirect was followed, then rejected");

    // A calendar/wildcard view names no single capture — archiving it live
    // would save Wayback's own UI. No fetch happens.
    await assert.rejects(
      archiveUrl("https://web.archive.org/web/*/http://old.example.test/", { ...OPTS, outRoot, backend: "fetch" }),
      /doesn't name a single capture/,
    );
    await assert.rejects(
      archiveUrl("http://old.example.test/", { ...OPTS, outRoot, backend: "fetch", at: "" }),
      /--at needs a date/,
    );
    assert.deepEqual(fs.readdirSync(outRoot), [], "nothing written, no staging left behind");
  } finally {
    server.close();
    fs.rmSync(outRoot, { recursive: true, force: true });
  }
});

test("--at latest and a never-archived page: nearest-to-now capture, and an honest error", async () => {
  const { server, base } = await serveWayback();
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amber-wb-"));
  try {
    const res = await archiveUrl("http://old.example.test/", {
      ...OPTS,
      outRoot,
      backend: "auto",
      at: "latest",
      wayback: { base, requestDelayMs: 0 },
    });
    assert.equal(res.snapshot?.wayback.requested, "latest");
    assert.equal(res.snapshot?.wayback.timestamp, "20090615083000", "the fake's only capture is the nearest to now");

    await assert.rejects(
      archiveUrl("http://never.example.test/", { ...OPTS, outRoot, backend: "auto", at: "2009", wayback: { base, requestDelayMs: 0 } }),
      /has no capture of http:\/\/never\.example\.test\//,
    );
    assert.ok(!fs.readdirSync(outRoot).some((n) => n.startsWith(".amber-tmp")), "staging cleaned up after the failure");
  } finally {
    server.close();
    fs.rmSync(outRoot, { recursive: true, force: true });
  }
});

test("a live static capture of a non-UTF-8 page is decoded and re-declared as UTF-8", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/") {
      res.setHeader("content-type", "text/html; charset=windows-1252");
      res.end(Buffer.from(`<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><title>Caf\xe9</title></head><body><p>${"Enough visible text to keep the static probe happy. ".repeat(6)}\x93Smart quotes\x94 and caf\xe9.</p></body></html>`, "latin1"));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amber-cs-"));
  try {
    const res = await archiveUrl(`http://127.0.0.1:${port}/`, { ...OPTS, outRoot, backend: "fetch" });
    const html = fs.readFileSync(path.join(res.outDir, "index.html"), "utf8");
    assert.match(html, /“Smart quotes” and café/);
    assert.match(html, /<meta charset="utf-8">/);
    assert.doesNotMatch(html, /windows-1252/);
  } finally {
    server.close();
    fs.rmSync(outRoot, { recursive: true, force: true });
  }
});

test("waybackFulfiller answers a render's requests from the archive: seeded, cached, serialised, 404 on a miss", async () => {
  const { server, base, log } = await serveWayback();
  try {
    const { waybackFulfiller } = await import("../src/wayback.js");
    const seeded = { status: 200, contentType: "text/html", body: Buffer.from("SEEDED") };
    const fulfill = waybackFulfiller("20090615083000", {
      base,
      delayMs: 0,
      seed: new Map([["http://old.example.test/", seeded]]),
    });

    // The page itself was already fetched — served from the seed, no request.
    assert.equal((await fulfill("http://old.example.test/#frag", "document"))?.body.toString(), "SEEDED");
    assert.equal(log.length, 0);

    const css = await fulfill("http://old.example.test/style.css", "stylesheet");
    assert.equal(css?.status, 200);
    assert.equal(css?.contentType, "text/css");
    assert.match(css!.body.toString(), /Verdana/);
    assert.equal(log[0], "/web/20090615083000id_/http://old.example.test/style.css", "fetched via id_ at the served timestamp");

    // Cached: a second request for the same URL doesn't hit the archive again.
    await fulfill("http://old.example.test/style.css", "stylesheet");
    assert.equal(log.length, 1);

    // A miss is a 404 the browser sees (an honest broken image), not an abort.
    const miss = await fulfill("http://cdn.example.test/gone.png", "image");
    assert.equal(miss?.status, 404);

    // Non-http schemes are blocked outright.
    assert.equal(await fulfill("data:text/plain,x", "other"), null);
    assert.equal(await fulfill("blob:null/abc", "other"), null);
  } finally {
    server.close();
  }
});
