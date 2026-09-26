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
 *
 * "When" a snapshot is from is its EFFECTIVE date: `snapshotAt` when the
 * capture came from the Wayback Machine (the historical timestamp), else
 * `capturedAt` (the run time). The root always holds the newest effective
 * date — so a Wayback capture older than the current latest is filed straight
 * into `versions/` and the root is left alone. That's what lets a live
 * capture from today and Wayback captures from years ago form one ordered
 * timeline under a single slug.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

/** Top-level names under a slug dir that are not part of a single snapshot. */
const RESERVED = new Set(["versions"]);
/** Metadata files excluded from the content hash (timestamps / nondeterministic). */
const UNHASHED = new Set(["manifest.json", "plan.json", "thumbnail.jpg"]);

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
  /**
   * Set when the staged snapshot was OLDER than the current latest (a Wayback
   * capture backfilling history): it was filed here under `versions/` and the
   * root was not touched.
   */
  filedAs: string | null;
  contentHash: string;
}

interface SnapshotManifest {
  capturedAt?: string;
  /** Historical timestamp for Wayback captures — takes precedence as "when". */
  snapshotAt?: string;
  contentHash?: string;
}

/** The date a snapshot is *from*: the Wayback timestamp if any, else the run time. */
function effectiveDate(m: SnapshotManifest | null): string | undefined {
  return m?.snapshotAt || m?.capturedAt;
}

function toTime(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function readManifest(dir: string): SnapshotManifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as SnapshotManifest;
  } catch {
    return null;
  }
}

/** A file's mtime — the date of a pre-`capturedAt` snapshot; null if unreadable. */
function mtime(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** Second-precision, filesystem-safe id from an ISO timestamp: 20260102T090000Z. */
function versionId(capturedAt: string | undefined, manifestPath: string): string {
  let d = capturedAt ? new Date(capturedAt) : null;
  if (!d || Number.isNaN(d.getTime())) {
    // Pre-`capturedAt` (or otherwise missing) — fall back to the file's mtime.
    d = new Date(mtime(manifestPath) ?? Date.now());
  }
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Every version filed for the second `id` names: `id`, `id-2`, `id-3`, … */
function siblingVersions(outDir: string, id: string): string[] {
  const dir = path.join(outDir, "versions");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n === id || n.startsWith(`${id}-`)).map((n) => path.join(dir, n));
}

/**
 * Disambiguate two snapshots that share a second (`-2`, `-3`, …). `manifestPath`
 * is only consulted when the date is missing (mtime fallback) — it defaults to
 * the root manifest because the usual caller is rotating the current latest.
 */
function uniqueVersionDir(
  outDir: string,
  effectiveAt: string | undefined,
  manifestPath = path.join(outDir, "manifest.json"),
): string {
  const base = versionId(effectiveAt, manifestPath);
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

/** Delete a snapshot's files, keeping the directory itself (and its versions/). */
function clearSnapshot(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    if (RESERVED.has(name)) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

/** Move everything in `stagingDir` into `dest` (created if missing), then drop the emptied staging dir. */
function moveSnapshotContents(stagingDir: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(stagingDir)) {
    fs.renameSync(path.join(stagingDir, name), path.join(dest, name));
  }
  fs.rmSync(stagingDir, { recursive: true, force: true });
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

  // Backfill: the staged snapshot is from BEFORE the current latest (a Wayback
  // capture of an older version). File it into versions/ under its own
  // effective date and leave the root — the newest version — untouched. This
  // comes before the unchanged-root check on purpose: a 2009 capture that is
  // byte-identical to today's root is still new information (the page was
  // already like this in 2009) and belongs on the timeline.
  // `--overwrite` here means "replace the version of THAT moment", never the
  // root: re-running a historical capture (say, with --keep-js) swaps in the
  // new one instead of clobbering the newest version or adding a `-2` twin.
  if (hasLatest) {
    const stagedAt = toTime(effectiveDate(staged));
    // A pre-`capturedAt` root is dated by its manifest's mtime (as versionId
    // does) — it must not be displaced by a capture from years before it.
    const latestAt = toTime(effectiveDate(prev)) ?? mtime(path.join(outDir, "manifest.json"));
    if (stagedAt !== null && latestAt !== null && stagedAt < latestAt) {
      const stagedManifest = path.join(stagingDir, "manifest.json");
      const id = versionId(effectiveDate(staged), stagedManifest);
      const exact = path.join(outDir, "versions", id);
      if (opts.overwrite) {
        // Replace the CONTENTS and keep the directory node — the same way the
        // root is overwritten. Deleting a folder that iCloud Drive (Desktop &
        // Documents sync) hasn't reconciled yet gets it resurrected as an
        // empty "<id> 2" twin, whether it was deleted outright or renamed
        // aside first. Files replaced in place don't trip it.
        if (fs.existsSync(exact)) clearSnapshot(exact);
        moveSnapshotContents(stagingDir, exact);
        return { outDir, changed: true, archivedTo: null, filedAs: exact, contentHash };
      }
      // The same historical moment captured twice with identical content is
      // not a new version — dedupe against everything filed for that second.
      if (siblingVersions(outDir, id).some((dir) => readManifest(dir)?.contentHash === contentHash)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        return { outDir, changed: false, archivedTo: null, filedAs: null, contentHash };
      }
      const dest = uniqueVersionDir(outDir, effectiveDate(staged), stagedManifest);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(stagingDir, dest);
      return { outDir, changed: true, archivedTo: null, filedAs: dest, contentHash };
    }
  }

  // Unchanged re-archive: keep the existing latest, throw the staged build away.
  if (hasLatest && !opts.overwrite && prev!.contentHash === contentHash) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return { outDir, changed: false, archivedTo: null, filedAs: null, contentHash };
  }

  fs.mkdirSync(outDir, { recursive: true });
  let archivedTo: string | null = null;

  if (hasLatest && !opts.overwrite) {
    archivedTo = uniqueVersionDir(outDir, effectiveDate(prev));
    moveSnapshotInto(outDir, archivedTo); // rotate current latest into versions/
  } else if (hasLatest) {
    clearSnapshot(outDir); // --overwrite: discard the current latest, leave versions/ untouched.
  } else {
    // No valid snapshot at the root, but the folder may not be empty: an
    // interrupted copy or a hand-pruned archive leaves an assets/ tree with
    // no index.html/manifest. Nothing there is a snapshot worth keeping, and
    // the per-entry rename below cannot merge into it.
    clearSnapshot(outDir);
  }

  // Promote the staged build into the (now-cleared) root.
  moveSnapshotContents(stagingDir, outDir);
  return { outDir, changed: true, archivedTo, filedAs: null, contentHash };
}
