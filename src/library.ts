/**
 * The library index: a browsable index.html at the archive root, regenerated
 * after every archive. There is no database — the slug folders and their
 * manifests ARE the data; this module just scans them and writes one static,
 * self-contained page (inline CSS, one tiny inline filter script, no network).
 * Losing or hand-editing the file costs nothing: the next archive rewrites it.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface LibraryEntry {
  slug: string;
  title: string;
  sourceUrl: string;
  host: string;
  capturedAt: string; // ISO, or "" when unknown
  tags: string[];
  /** "keep-js" | "static" — how the page's runtime was treated. */
  mode: "keep-js" | "static";
  /** Older snapshots under versions/. */
  versions: number;
  /** Bytes of the latest snapshot (versions/ excluded). */
  bytes: number;
  /** True when the snapshot has a thumbnail.jpg alongside its index.html. */
  thumbnail: boolean;
}

interface Manifestish {
  title?: string;
  sourceUrl?: string;
  capturedAt?: string;
  tags?: string[];
  keepJs?: unknown;
}

/** Read one slug directory into an entry, or null if it isn't an archive. */
function readEntry(outRoot: string, slug: string): LibraryEntry | null {
  const dir = path.join(outRoot, slug);
  let manifest: Manifestish;
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
    if (!fs.existsSync(path.join(dir, "index.html"))) return null;
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifestish;
  } catch {
    return null; // not an archive (or a half-built one) — skip quietly
  }

  let host = "";
  try {
    host = new URL(manifest.sourceUrl ?? "").host.replace(/^www\./, "");
  } catch {
    /* unparseable source url */
  }

  let versions = 0;
  try {
    versions = fs
      .readdirSync(path.join(dir, "versions"), { withFileTypes: true })
      .filter((e) => e.isDirectory()).length;
  } catch {
    /* no versions/ */
  }

  return {
    slug,
    title: (manifest.title || "").trim() || slug,
    sourceUrl: manifest.sourceUrl ?? "",
    host,
    capturedAt: manifest.capturedAt ?? "",
    tags: Array.isArray(manifest.tags) ? manifest.tags.filter((t) => typeof t === "string") : [],
    mode: manifest.keepJs ? "keep-js" : "static",
    versions,
    bytes: dirBytes(dir, /* skipVersions */ true),
    thumbnail: fs.existsSync(path.join(dir, "thumbnail.jpg")),
  };
}

function dirBytes(dir: string, skipVersions = false): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (skipVersions && e.isDirectory() && e.name === "versions") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(p);
    else {
      try {
        total += fs.statSync(p).size;
      } catch {
        /* raced deletion */
      }
    }
  }
  return total;
}

/** Scan every slug folder under outRoot, newest capture first. */
export function scanLibrary(outRoot: string): LibraryEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(outRoot);
  } catch {
    return [];
  }
  const entries: LibraryEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue; // .amber-tmp-* staging, dotfiles
    const entry = readEntry(outRoot, name);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => (a.capturedAt > b.capturedAt ? -1 : 1));
  return entries;
}

/**
 * The library's tag vocabulary, most-used first. Fed back into the planner so
 * tagging converges on one folksonomy instead of coining synonyms per page.
 */
export function libraryTags(outRoot: string): string[] {
  const counts = new Map<string, number>();
  for (const entry of scanLibrary(outRoot)) {
    for (const t of entry.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([t]) => t);
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function fmtDate(iso: string): string {
  return iso ? iso.slice(0, 10) : "";
}

function row(e: LibraryEntry): string {
  const tags = e.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(" ");
  const slugUri = esc(encodeURI(e.slug));
  const thumb = e.thumbnail
    ? `<a href="${slugUri}/index.html"><img src="${slugUri}/thumbnail.jpg" alt="" loading="lazy"></a>`
    : `<div class="noshot"></div>`;
  return `<tr>
  <td class="shot">${thumb}</td>
  <td class="title"><a href="${slugUri}/index.html">${esc(e.title)}</a></td>
  <td class="host"><a href="${esc(e.sourceUrl)}" rel="noreferrer">${esc(e.host || "—")}</a></td>
  <td class="date" title="${esc(e.capturedAt)}">${esc(fmtDate(e.capturedAt))}</td>
  <td class="tags">${tags}</td>
  <td class="mode"><span class="badge ${e.mode === "keep-js" ? "live" : ""}">${e.mode}</span></td>
  <td class="num">${e.versions || ""}</td>
  <td class="num">${fmtBytes(e.bytes)}</td>
</tr>`;
}

export function renderLibraryIndex(entries: LibraryEntry[]): string {
  const rows = entries.map(row).join("\n");
  const count = entries.length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Archive</title>
<style>
  :root {
    --bg: #faf9f7; --fg: #1c1b1a; --muted: #75716b; --line: #e4e1db;
    --accent: #a86814; --badge: #eee9df;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #171614; --fg: #e8e5e0; --muted: #8f8a82; --line: #2c2a26; --accent: #d29a4a; --badge: #26231e; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.5 ui-sans-serif, system-ui, sans-serif;
    padding: 3rem clamp(1rem, 5vw, 4rem);
  }
  header { display: flex; align-items: baseline; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
  h1 { font-size: 1.1rem; font-weight: 600; margin: 0; letter-spacing: 0.01em; }
  .count { color: var(--muted); font-variant-numeric: tabular-nums; }
  input[type="search"] {
    margin-left: auto; font: inherit; color: inherit;
    background: transparent; border: 1px solid var(--line); border-radius: 6px;
    padding: 0.35rem 0.7rem; min-width: 16rem;
  }
  input[type="search"]:focus { outline: none; border-color: var(--accent); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.55rem 1rem 0.55rem 0; vertical-align: middle; }
  th {
    font-size: 0.72rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--muted); border-bottom: 1px solid var(--line);
  }
  td { border-bottom: 1px solid var(--line); }
  td.title a { color: var(--fg); text-decoration: none; font-weight: 550; }
  td.title a:hover { color: var(--accent); }
  td.host a { color: var(--muted); text-decoration: none; }
  td.host a:hover { text-decoration: underline; }
  td.date { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  td.num { color: var(--muted); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  th.num { text-align: right; }
  td.shot { width: 156px; padding: 0.55rem 1rem 0.55rem 0; }
  td.shot img, td.shot .noshot {
    display: block; width: 140px; aspect-ratio: 16 / 10; object-fit: cover; object-position: top;
    border-radius: 6px; border: 1px solid var(--line); background: var(--badge);
  }
  .tag {
    display: inline-block; background: var(--badge); color: var(--muted);
    border-radius: 4px; padding: 0.05rem 0.45rem; font-size: 0.78rem; margin: 0.1rem 0.15rem 0.1rem 0;
    white-space: nowrap;
  }
  .badge {
    font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted);
  }
  .badge.live { color: var(--accent); }
  .empty { color: var(--muted); padding: 3rem 0; }
  footer { margin-top: 2rem; color: var(--muted); font-size: 0.8rem; }
</style>
</head>
<body>
<header>
  <h1>Archive</h1>
  <span class="count">${count} page${count === 1 ? "" : "s"}</span>
  <input type="search" id="q" placeholder="Filter by title, site, or tag…" autocomplete="off">
</header>
${
  count === 0
    ? `<p class="empty">Nothing archived yet. Save a page with <code>amber &lt;url&gt;</code>.</p>`
    : `<table>
<thead><tr><th></th><th>Title</th><th>Site</th><th>Saved</th><th>Tags</th><th>Mode</th><th class="num">Versions</th><th class="num">Size</th></tr></thead>
<tbody id="rows">
${rows}
</tbody>
</table>`
}
<footer>Maintained by <a href="https://github.com/chasemccoy/amber">amber</a> — regenerated on every archive; safe to delete.</footer>
<script>
  var q = document.getElementById('q');
  var rows = Array.prototype.slice.call(document.querySelectorAll('#rows tr'));
  if (q) q.addEventListener('input', function () {
    var needle = q.value.trim().toLowerCase();
    rows.forEach(function (r) {
      r.style.display = !needle || r.textContent.toLowerCase().indexOf(needle) !== -1 ? '' : 'none';
    });
  });
</script>
</body>
</html>
`;
}

/**
 * Rescan `outRoot` and rewrite its index.html. Called after every committed
 * archive; also safe to run standalone. Returns the number of entries listed.
 */
export function updateLibraryIndex(outRoot: string): number {
  const entries = scanLibrary(outRoot);
  const tmp = path.join(outRoot, ".index.html.tmp");
  fs.writeFileSync(tmp, renderLibraryIndex(entries));
  fs.renameSync(tmp, path.join(outRoot, "index.html"));
  return entries.length;
}
