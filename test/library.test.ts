/**
 * The library index: a static, self-contained index.html at the archive root,
 * derived entirely from the slug folders' manifests (no separate state) and
 * rewritten after every archive.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanLibrary, updateLibraryIndex } from "../src/library.js";

function makeArchive(
  root: string,
  slug: string,
  manifest: Record<string, unknown>,
  opts?: { versions?: number; noIndex?: boolean },
): void {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  if (!opts?.noIndex) fs.writeFileSync(path.join(dir, "index.html"), "<html>archived</html>");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  for (let i = 0; i < (opts?.versions ?? 0); i++) {
    fs.mkdirSync(path.join(dir, "versions", `2026010${i + 1}T000000Z`), { recursive: true });
  }
}

function makeLibrary(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amber-library-"));
  makeArchive(root, "pear.no", {
    title: "Pear — not an agency <on> the clock",
    sourceUrl: "https://pear.no/",
    capturedAt: "2026-08-08T12:00:00.000Z",
    tags: ["seo", "revenue share"],
    keepJs: { singleFile: true },
  }, { versions: 2 });
  fs.writeFileSync(path.join(root, "pear.no", "thumbnail.jpg"), Buffer.from("JPEG"));
  // A Wayback capture: run recently, but FROM 2009 — the library files it by
  // its snapshot date and marks it.
  makeArchive(root, "geocities.example-old", {
    title: "Old page",
    sourceUrl: "http://geocities.example/old",
    capturedAt: "2026-09-20T10:00:00.000Z",
    snapshotAt: "2009-06-15T00:00:00.000Z",
    wayback: { timestamp: "20090615000000" },
    tags: ["web history"],
  });
  makeArchive(root, "example.com-post", {
    title: "A fine post",
    sourceUrl: "https://www.example.com/post",
    capturedAt: "2026-08-09T09:00:00.000Z",
    tags: ["rust"],
  });
  // Distractors the scan must skip: staging dirs, files, non-archive folders.
  fs.mkdirSync(path.join(root, ".amber-tmp-xyz"), { recursive: true });
  fs.writeFileSync(path.join(root, "stray.txt"), "not an archive");
  makeArchive(root, "half-built", { title: "no index yet" }, { noIndex: true });
  return root;
}

test("scanLibrary reads manifests, skips non-archives, sorts newest first", () => {
  const root = makeLibrary();
  const entries = scanLibrary(root);

  assert.deepEqual(entries.map((e) => e.slug), ["example.com-post", "pear.no", "geocities.example-old"], "sorted by EFFECTIVE date");
  const [post, pear, old] = entries;
  assert.equal(old!.capturedAt, "2009-06-15T00:00:00.000Z", "Wayback snapshot date is the effective date");
  assert.equal(old!.viaWayback, true);
  assert.equal(pear!.viaWayback, false);
  assert.equal(post!.mode, "static");
  assert.equal(post!.host, "example.com"); // www. stripped
  assert.equal(pear!.mode, "keep-js");
  assert.equal(pear!.versions, 2);
  assert.equal(pear!.thumbnail, true);
  assert.equal(post!.thumbnail, false);
  assert.deepEqual(pear!.tags, ["seo", "revenue share"]);
  assert.ok(pear!.bytes > 0);

  fs.rmSync(root, { recursive: true, force: true });
});

test("updateLibraryIndex writes a self-contained root index.html", () => {
  const root = makeLibrary();
  const n = updateLibraryIndex(root);
  assert.equal(n, 3);

  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(html, /<a href="pear\.no\/index\.html">Pear — not an agency &lt;on&gt; the clock<\/a>/);
  assert.match(html, /<a href="example\.com-post\/index\.html">A fine post<\/a>/);
  assert.match(html, /3 pages/);
  assert.match(html, /2009-06-15 <span class="via"[^>]*>wayback<\/span>/);
  assert.match(html, /keep-js/);
  assert.match(html, /<img src="pear\.no\/thumbnail\.jpg"/);
  assert.doesNotMatch(html, /<img src="example\.com-post/); // no thumb -> placeholder
  assert.doesNotMatch(html, /half-built|stray\.txt|amber-tmp/);
  // Self-contained: no external refs of any kind.
  assert.doesNotMatch(
    html,
    /src="http|href="http(?!s:\/\/pear\.no|s:\/\/www\.example\.com|:\/\/geocities\.example|s:\/\/github\.com)/,
  );

  // Regeneration is idempotent and picks up deletions.
  fs.rmSync(path.join(root, "example.com-post"), { recursive: true, force: true });
  assert.equal(updateLibraryIndex(root), 2);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "index.html"), "utf8"), /A fine post/);

  fs.rmSync(root, { recursive: true, force: true });
});
