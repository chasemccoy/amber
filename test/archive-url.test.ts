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
import { archiveUrl } from "../src/pipeline.js";

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
