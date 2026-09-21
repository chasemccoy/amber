/** Deterministic tests for snapshot hashing + commit/versioning.
 *  Run: pnpm test   (node --import tsx --test test/*.test.ts) */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { hashSnapshotContent, commitSnapshot } from "../src/snapshot.js";

/** Build a snapshot dir like the pipeline does: content + a manifest carrying the hash. */
function writeSnapshot(
  dir: string,
  opts: { html: string; asset?: string; capturedAt: string; snapshotAt?: string },
): void {
  fs.mkdirSync(path.join(dir, "assets", "images"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), opts.html);
  if (opts.asset) fs.writeFileSync(path.join(dir, "assets", "images", "a.png"), opts.asset);
  const contentHash = hashSnapshotContent(dir);
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ capturedAt: opts.capturedAt, contentHash, ...(opts.snapshotAt ? { snapshotAt: opts.snapshotAt } : {}) }),
  );
  // plan.json is intentionally nondeterministic to prove it doesn't affect the hash.
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ notes: Math.random() }));
}

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "amber-snap-"));

test("hashSnapshotContent ignores metadata files and tracks content + assets", () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "index.html"), "<p>hi</p>");
  fs.writeFileSync(path.join(dir, "assets", "x.css"), "body{}");
  const base = hashSnapshotContent(dir);

  // manifest.json / plan.json don't change the hash
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ capturedAt: "whenever" }));
  fs.writeFileSync(path.join(dir, "plan.json"), "{}");
  assert.equal(hashSnapshotContent(dir), base);

  // an asset byte change does
  fs.writeFileSync(path.join(dir, "assets", "x.css"), "body{color:red}");
  assert.notEqual(hashSnapshotContent(dir), base);
});

test("hashSnapshotContent is path-sensitive and build-location-independent", () => {
  const make = (assetPath: string) => {
    const d = tmpdir();
    fs.writeFileSync(path.join(d, "index.html"), "<p>hi</p>");
    fs.mkdirSync(path.dirname(path.join(d, assetPath)), { recursive: true });
    fs.writeFileSync(path.join(d, assetPath), "PIXELS");
    return d;
  };
  // Same layout + same bytes in two different dirs → equal (where it was built doesn't matter).
  assert.equal(hashSnapshotContent(make("assets/images/a.png")), hashSnapshotContent(make("assets/images/a.png")));
  // Identical bytes at a different path → different (the relative path is part of the hash).
  assert.notEqual(hashSnapshotContent(make("assets/images/a.png")), hashSnapshotContent(make("assets/images/b.png")));
});

test("commitSnapshot promotes the first snapshot to the root (no history yet)", () => {
  const root = tmpdir();
  const outDir = path.join(root, "site");
  const staging = path.join(root, "staging");
  writeSnapshot(staging, { html: "<p>v1</p>", asset: "A", capturedAt: "2026-01-01T00:00:00.000Z" });

  const res = commitSnapshot(staging, outDir);
  assert.equal(res.changed, true);
  assert.equal(res.archivedTo, null);
  assert.ok(fs.existsSync(path.join(outDir, "index.html")));
  assert.ok(!fs.existsSync(staging)); // staging consumed
  assert.ok(!fs.existsSync(path.join(outDir, "versions"))); // nothing to version yet
});

test("commitSnapshot rotates the previous latest into versions/ on change", () => {
  const root = tmpdir();
  const outDir = path.join(root, "site");

  const s1 = path.join(root, "s1");
  writeSnapshot(s1, { html: "<p>v1</p>", capturedAt: "2026-01-01T00:00:00.000Z" });
  commitSnapshot(s1, outDir);

  const s2 = path.join(root, "s2");
  writeSnapshot(s2, { html: "<p>v2</p>", capturedAt: "2026-02-02T09:30:00.000Z" });
  const res = commitSnapshot(s2, outDir);

  assert.equal(res.changed, true);
  assert.ok(res.archivedTo!.endsWith(path.join("versions", "20260101T000000Z")));
  assert.match(fs.readFileSync(path.join(outDir, "index.html"), "utf8"), /v2/); // latest = v2
  assert.deepEqual(fs.readdirSync(path.join(outDir, "versions")), ["20260101T000000Z"]);
  assert.match(
    fs.readFileSync(path.join(outDir, "versions", "20260101T000000Z", "index.html"), "utf8"),
    /v1/, // v1 preserved
  );
});

test("commitSnapshot skips an unchanged re-archive (discards staging, no version)", () => {
  const root = tmpdir();
  const outDir = path.join(root, "site");

  const s1 = path.join(root, "s1");
  writeSnapshot(s1, { html: "<p>same</p>", capturedAt: "2026-01-01T00:00:00.000Z" });
  commitSnapshot(s1, outDir);

  const s2 = path.join(root, "s2"); // identical content, later timestamp + different plan.json
  writeSnapshot(s2, { html: "<p>same</p>", capturedAt: "2026-03-03T00:00:00.000Z" });
  const res = commitSnapshot(s2, outDir);

  assert.equal(res.changed, false);
  assert.equal(res.archivedTo, null);
  assert.ok(!fs.existsSync(s2)); // staging discarded
  assert.ok(!fs.existsSync(path.join(outDir, "versions"))); // no version created
});

test("commitSnapshot --overwrite replaces latest in place, leaving versions/ intact", () => {
  const root = tmpdir();
  const outDir = path.join(root, "site");

  const s1 = path.join(root, "s1");
  writeSnapshot(s1, { html: "<p>v1</p>", capturedAt: "2026-01-01T00:00:00.000Z" });
  commitSnapshot(s1, outDir);

  const s2 = path.join(root, "s2"); // normal change → rotates v1 into versions/
  writeSnapshot(s2, { html: "<p>v2</p>", capturedAt: "2026-02-02T00:00:00.000Z" });
  commitSnapshot(s2, outDir);

  const s3 = path.join(root, "s3"); // overwrite → replaces v2, no new version
  writeSnapshot(s3, { html: "<p>v3</p>", capturedAt: "2026-03-03T00:00:00.000Z" });
  const res = commitSnapshot(s3, outDir, { overwrite: true });

  assert.equal(res.changed, true);
  assert.equal(res.archivedTo, null);
  assert.match(fs.readFileSync(path.join(outDir, "index.html"), "utf8"), /v3/);
  assert.deepEqual(fs.readdirSync(path.join(outDir, "versions")), ["20260101T000000Z"]); // v1 still there, v2 gone
});

test("commitSnapshot disambiguates versions captured in the same second", () => {
  const root = tmpdir();
  const outDir = path.join(root, "site");

  const s1 = path.join(root, "s1");
  writeSnapshot(s1, { html: "<p>v1</p>", capturedAt: "2026-01-01T00:00:00.100Z" });
  commitSnapshot(s1, outDir);

  const s2 = path.join(root, "s2");
  writeSnapshot(s2, { html: "<p>v2</p>", capturedAt: "2026-01-01T00:00:00.900Z" }); // same second as v1
  commitSnapshot(s2, outDir);

  const s3 = path.join(root, "s3");
  writeSnapshot(s3, { html: "<p>v3</p>", capturedAt: "2026-05-05T00:00:00.000Z" });
  commitSnapshot(s3, outDir);

  // v1 and v2 both map to 20260101T000000Z → second gets a -2 suffix
  assert.deepEqual(fs.readdirSync(path.join(outDir, "versions")).sort(), [
    "20260101T000000Z",
    "20260101T000000Z-2",
  ]);
});

// --- effective-date versioning (Wayback backfill) ---------------------------

test("commitSnapshot files a snapshot OLDER than the latest into versions/ and leaves the root alone", () => {
  const root = tmpdir();
  const outDir = path.join(root, "site");
  // Today's live capture is the latest.
  const live = path.join(root, "staging-live");
  writeSnapshot(live, { html: "<p>2026</p>", capturedAt: "2026-09-20T12:00:00.000Z" });
  commitSnapshot(live, outDir);

  // A Wayback capture of the 2009 version: run today, but FROM 2009.
  const old = path.join(root, "staging-old");
  writeSnapshot(old, { html: "<p>2009</p>", capturedAt: "2026-09-20T12:05:00.000Z", snapshotAt: "2009-06-15T08:30:00.000Z" });
  const res = commitSnapshot(old, outDir);

  assert.equal(res.changed, true);
  assert.equal(res.archivedTo, null, "the root was not rotated");
  assert.equal(res.filedAs, path.join(outDir, "versions", "20090615T083000Z"), "named by the snapshot date, not the run time");
  assert.match(fs.readFileSync(path.join(outDir, "index.html"), "utf8"), /2026/, "root still holds the newest version");
  assert.match(fs.readFileSync(path.join(res.filedAs!, "index.html"), "utf8"), /2009/);
  assert.ok(!fs.existsSync(old), "staging consumed");
});

test("commitSnapshot promotes a Wayback snapshot NEWER than the latest (rotating by effective dates)", () => {
  const root = tmpdir();
  const outDir = path.join(root, "site");
  const s2009 = path.join(root, "s2009");
  writeSnapshot(s2009, { html: "<p>2009</p>", capturedAt: "2026-09-20T12:00:00.000Z", snapshotAt: "2009-06-15T00:00:00.000Z" });
  commitSnapshot(s2009, outDir);

  const s2013 = path.join(root, "s2013");
  writeSnapshot(s2013, { html: "<p>2013</p>", capturedAt: "2026-09-20T12:01:00.000Z", snapshotAt: "2013-03-01T00:00:00.000Z" });
  const res = commitSnapshot(s2013, outDir);

  assert.equal(res.changed, true);
  assert.equal(res.filedAs, null);
  assert.equal(res.archivedTo, path.join(outDir, "versions", "20090615T000000Z"), "the older latest rotates under ITS snapshot date");
  assert.match(fs.readFileSync(path.join(outDir, "index.html"), "utf8"), /2013/);
});

test("commitSnapshot dedupes the same historical moment captured twice with identical content", () => {
  const root = tmpdir();
  const outDir = path.join(root, "site");
  const live = path.join(root, "live");
  writeSnapshot(live, { html: "<p>2026</p>", capturedAt: "2026-09-20T12:00:00.000Z" });
  commitSnapshot(live, outDir);

  for (const name of ["a", "b"]) {
    const s = path.join(root, name);
    writeSnapshot(s, { html: "<p>2009</p>", capturedAt: `2026-09-20T12:0${name === "a" ? 1 : 2}:00.000Z`, snapshotAt: "2009-06-15T00:00:00.000Z" });
    const res = commitSnapshot(s, outDir);
    if (name === "a") assert.equal(res.changed, true);
    else {
      assert.equal(res.changed, false, "identical re-capture of the same version is skipped");
      assert.ok(!fs.existsSync(s), "staging discarded");
    }
  }
  assert.deepEqual(fs.readdirSync(path.join(outDir, "versions")), ["20090615T000000Z"], "no -2 duplicate");
});

test("commitSnapshot still versions two different-content captures of the same second", () => {
  const root = tmpdir();
  const outDir = path.join(root, "site");
  const live = path.join(root, "live");
  writeSnapshot(live, { html: "<p>2026</p>", capturedAt: "2026-09-20T12:00:00.000Z" });
  commitSnapshot(live, outDir);
  for (const [name, html] of [["a", "<p>one</p>"], ["b", "<p>two</p>"]] as const) {
    const s = path.join(root, name);
    writeSnapshot(s, { html, capturedAt: "2026-09-20T12:01:00.000Z", snapshotAt: "2009-06-15T00:00:00.000Z" });
    assert.equal(commitSnapshot(s, outDir).changed, true);
  }
  assert.deepEqual(fs.readdirSync(path.join(outDir, "versions")).sort(), ["20090615T000000Z", "20090615T000000Z-2"]);
});

test("commitSnapshot --overwrite on an older snapshot replaces THAT version, never the root", () => {
  const root = tmpdir();
  const outDir = path.join(root, "site");
  const live = path.join(root, "live");
  writeSnapshot(live, { html: "<p>2026</p>", capturedAt: "2026-09-20T12:00:00.000Z" });
  commitSnapshot(live, outDir);

  const first = path.join(root, "first");
  writeSnapshot(first, { html: "<p>2010 static</p>", capturedAt: "2026-09-20T12:01:00.000Z", snapshotAt: "2010-04-30T14:36:57.000Z" });
  commitSnapshot(first, outDir);

  // Re-run of the same moment (e.g. now with keep-js) with --overwrite.
  const redo = path.join(root, "redo");
  writeSnapshot(redo, { html: "<p>2010 keep-js</p>", capturedAt: "2026-09-20T12:02:00.000Z", snapshotAt: "2010-04-30T14:36:57.000Z" });
  const res = commitSnapshot(redo, outDir, { overwrite: true });

  assert.equal(res.changed, true);
  assert.equal(res.filedAs, path.join(outDir, "versions", "20100430T143657Z"));
  assert.match(fs.readFileSync(path.join(outDir, "index.html"), "utf8"), /2026/, "root untouched");
  assert.match(fs.readFileSync(path.join(res.filedAs!, "index.html"), "utf8"), /keep-js/, "the version was replaced");
  assert.deepEqual(fs.readdirSync(path.join(outDir, "versions")), ["20100430T143657Z"], "no -2 twin");
});

test("commitSnapshot files an older capture even when its content matches the root", () => {
  const root = tmpdir();
  const outDir = path.join(root, "site");
  const live = path.join(root, "live");
  writeSnapshot(live, { html: "<p>same</p>", capturedAt: "2026-09-20T12:00:00.000Z" });
  commitSnapshot(live, outDir);

  // The page being like this already in 2009 is new information for the
  // timeline — the unchanged-root shortcut is for re-archiving the same moment.
  const old = path.join(root, "old");
  writeSnapshot(old, { html: "<p>same</p>", capturedAt: "2026-09-20T12:01:00.000Z", snapshotAt: "2009-06-15T00:00:00.000Z" });
  const res = commitSnapshot(old, outDir);
  assert.equal(res.changed, true);
  assert.equal(res.filedAs, path.join(outDir, "versions", "20090615T000000Z"));
  assert.match(fs.readFileSync(path.join(outDir, "index.html"), "utf8"), /same/, "root untouched");
});

test("commitSnapshot dates a pre-capturedAt root by its mtime, so an older Wayback capture backfills instead of displacing it", () => {
  const root = tmpdir();
  const outDir = path.join(root, "site");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "index.html"), "<p>legacy</p>");
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ contentHash: hashSnapshotContent(outDir) }));

  const old = path.join(root, "old");
  writeSnapshot(old, { html: "<p>2009</p>", capturedAt: "2026-09-20T12:01:00.000Z", snapshotAt: "2009-06-15T00:00:00.000Z" });
  const res = commitSnapshot(old, outDir);
  assert.equal(res.archivedTo, null, "the legacy root was not rotated away");
  assert.equal(res.filedAs, path.join(outDir, "versions", "20090615T000000Z"));
  assert.match(fs.readFileSync(path.join(outDir, "index.html"), "utf8"), /legacy/);
});

test("commitSnapshot dedupes a historical re-capture against every version of that second, not just the first", () => {
  const root = tmpdir();
  const outDir = path.join(root, "site");
  const live = path.join(root, "live");
  writeSnapshot(live, { html: "<p>2026</p>", capturedAt: "2026-09-20T12:00:00.000Z" });
  commitSnapshot(live, outDir);
  const results: boolean[] = [];
  for (const [name, html] of [["a", "<p>one</p>"], ["b", "<p>two</p>"], ["c", "<p>two</p>"]] as const) {
    const s = path.join(root, name);
    writeSnapshot(s, { html, capturedAt: "2026-09-20T12:01:00.000Z", snapshotAt: "2009-06-15T00:00:00.000Z" });
    results.push(commitSnapshot(s, outDir).changed);
  }
  assert.deepEqual(results, [true, true, false], "c matches the -2 sibling");
  assert.deepEqual(fs.readdirSync(path.join(outDir, "versions")).sort(), ["20090615T000000Z", "20090615T000000Z-2"]);
});
