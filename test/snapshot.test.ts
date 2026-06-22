/** Deterministic tests for snapshot hashing + commit/versioning.
 *  Run: pnpm test   (node --import tsx --test test/*.test.ts) */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { hashSnapshotContent, commitSnapshot } from "../src/snapshot.js";

/** Build a snapshot dir like the pipeline does: content + a manifest carrying the hash. */
function writeSnapshot(dir: string, opts: { html: string; asset?: string; capturedAt: string }): void {
  fs.mkdirSync(path.join(dir, "assets", "images"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), opts.html);
  if (opts.asset) fs.writeFileSync(path.join(dir, "assets", "images", "a.png"), opts.asset);
  const contentHash = hashSnapshotContent(dir);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ capturedAt: opts.capturedAt, contentHash }));
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
