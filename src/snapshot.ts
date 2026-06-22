/**
 * Timestamped snapshots. Every archive is built in a staging directory, then
 * committed to the live location `<outRoot>/<slug>/`:
 *
 *   <slug>/
 *   ├── index.html, assets/, plan.json, manifest.json   ← always the newest
 *   └── versions/
 *       ├── 20260102T090000Z/   { a full, self-contained older snapshot }
 *       └── 20260518T143000Z/   { … }
 *
 * The newest snapshot lives at the root so `<slug>/index.html` is always the
 * latest (and the extension/library see no layout change). Older ones rotate
 * into `versions/<capturedAt>/`. Each snapshot folder is complete and openable
 * on its own; the set of folders *is* the history (no separate index file).
 *
 * Re-archiving identical content is skipped (the staged build is discarded),
 * compared by a content hash that ignores metadata files. `--overwrite` replaces
 * the latest in place without rotating it into `versions/`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

/** Top-level names under a slug dir that are not part of a single snapshot. */
const RESERVED = new Set(["versions"]);
/** Metadata files excluded from the content hash (timestamps / nondeterministic). */
const UNHASHED = new Set(["manifest.json", "plan.json"]);

/**
 * Hash a snapshot's *content* — `index.html` plus every asset byte — ignoring
 * `manifest.json`/`plan.json`. Two captures of an unchanged page hash equal even
 * though their manifests differ (capture time) and their plans may differ (LLM
 * nondeterminism). Asset bytes are included, so a changed image at the same URL
 * is detected even when the HTML is byte-identical.
 */
export function hashSnapshotContent(dir: string): string {
  const files: string[] = [];
  collectFiles(dir, dir, files);
  files.sort();
  const h = crypto.createHash("sha256");
  for (const rel of files) {
    if (UNHASHED.has(rel)) continue;
    h.update(rel);
    h.update("\0");
    h.update(fs.readFileSync(path.join(dir, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

function collectFiles(root: string, cur: string, out: string[]): void {
  for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
    const abs = path.join(cur, entry.name);
    if (entry.isDirectory()) {
      if (cur === root && RESERVED.has(entry.name)) continue; // never hash versions/
      collectFiles(root, abs, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  }
}

export interface CommitOptions {
  /** Replace the current latest in place instead of rotating it into versions/. */
  overwrite?: boolean;
}

export interface CommitResult {
  /** The live (latest) snapshot directory — always the slug root. */
  outDir: string;
  /** False when the staged build was identical to the latest and discarded. */
  changed: boolean;
  /** Where the previous latest was archived, or null (first run / overwrite). */
  archivedTo: string | null;
  contentHash: string;
}

interface SnapshotManifest {
  capturedAt?: string;
  contentHash?: string;
}

function readManifest(dir: string): SnapshotManifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as SnapshotManifest;
  } catch {
    return null;
  }
}

/** Second-precision, filesystem-safe id from an ISO timestamp: 20260102T090000Z. */
function versionId(capturedAt: string | undefined, manifestPath: string): string {
  let d = capturedAt ? new Date(capturedAt) : null;
  if (!d || Number.isNaN(d.getTime())) {
    // Pre-`capturedAt` (or otherwise missing) — fall back to the file's mtime.
    try {
      d = fs.statSync(manifestPath).mtime;
    } catch {
      d = new Date();
    }
  }
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Disambiguate two snapshots that share a second (`-2`, `-3`, …). */
function uniqueVersionDir(outDir: string, capturedAt: string | undefined): string {
  const base = versionId(capturedAt, path.join(outDir, "manifest.json"));
  let id = base;
  for (let n = 2; fs.existsSync(path.join(outDir, "versions", id)); n++) id = `${base}-${n}`;
  return path.join(outDir, "versions", id);
}

/** Move every top-level entry of `dir` (except `versions/`) into `dest`. */
function moveSnapshotInto(dir: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (RESERVED.has(name)) continue;
    fs.renameSync(path.join(dir, name), path.join(dest, name));
  }
}

/**
 * Promote a freshly-built snapshot in `stagingDir` to the live archive at
 * `outDir`, rotating the previous latest into `versions/`. Always consumes
 * `stagingDir` (moved into place or removed).
 */
export function commitSnapshot(stagingDir: string, outDir: string, opts: CommitOptions = {}): CommitResult {
  const staged = readManifest(stagingDir);
  const contentHash = staged?.contentHash ?? hashSnapshotContent(stagingDir);

  const prev = readManifest(outDir);
  const hasLatest = prev !== null && fs.existsSync(path.join(outDir, "index.html"));

  // Unchanged re-archive: keep the existing latest, throw the staged build away.
  if (hasLatest && !opts.overwrite && prev!.contentHash === contentHash) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return { outDir, changed: false, archivedTo: null, contentHash };
  }

  fs.mkdirSync(outDir, { recursive: true });
  let archivedTo: string | null = null;

  if (hasLatest && !opts.overwrite) {
    archivedTo = uniqueVersionDir(outDir, prev!.capturedAt);
    moveSnapshotInto(outDir, archivedTo); // rotate current latest into versions/
  } else if (hasLatest) {
    // --overwrite: discard the current latest, leave versions/ untouched.
    for (const name of fs.readdirSync(outDir)) {
      if (RESERVED.has(name)) continue;
      fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
    }
  }

  // Promote the staged build into the (now-cleared) root.
  for (const name of fs.readdirSync(stagingDir)) {
    fs.renameSync(path.join(stagingDir, name), path.join(outDir, name));
  }
  fs.rmSync(stagingDir, { recursive: true, force: true });
  return { outDir, changed: true, archivedTo, contentHash };
}
