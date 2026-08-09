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

// The amber mark (.github/assets/amber-mark.svg), baked in so the generated
// page needs no companion file — the library stays a single self-contained html.
const FAVICON = `data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNjYiIGhlaWdodD0iMjAwIiBmaWxsPSJub25lIiB2aWV3Qm94PSIyNDAgMTgwIDE2NiAyMDAiPjxkZWZzPjxyYWRpYWxHcmFkaWVudCBpZD0iYW1iZXItZ2xvdyIgY3g9IjI5MiIgY3k9IjIzOCIgcj0iMTc4IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjRjdDOTRGIi8+PHN0b3Agb2Zmc2V0PSIuNDIiIHN0b3AtY29sb3I9IiNGMkEwM0MiLz48c3RvcCBvZmZzZXQ9Ii43NSIgc3RvcC1jb2xvcj0iI0VDN0EzMCIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI0UyNjEyQSIvPjwvcmFkaWFsR3JhZGllbnQ+PGNsaXBQYXRoIGlkPSJhbWJlci1jbGlwIj48cGF0aCBkPSJNMzU1LjQzMiAxOTYuODkxTDMyMC4yMDcgMTg4LjI0NEMzMDkuMjUyIDE4NS41NTYgMjk3LjY3MSAxODguMTU3IDI4OC45MTggMTk1LjI3MkwyNTguMjU1IDIyMC4xOTZDMjQ4LjY0MSAyMjguMDExIDI0My43MjEgMjQwLjIyIDI0NS4yMyAyNTIuNTE3TDI1Mi44NTcgMzE0LjY2M0MyNTMuOTMzIDMyMy40MzEgMjU4LjE5NSAzMzEuNDk3IDI2NC44MzMgMzM3LjMyNkwyOTMuMzA3IDM2Mi4zMzVDMzAzLjU1NyAzNzEuMzM3IDMxOC4wMTQgMzczLjc3MiAzMzAuNjQ4IDM2OC42MjVMMzcwLjYxIDM1Mi4zNDFDMzgyLjIzMyAzNDcuNjA2IDM5MC41NSAzMzcuMTU5IDM5Mi41NjEgMzI0Ljc3MUwzOTkuNjEyIDI4MS4zMzZDNDAwLjY1IDI3NC45NDUgMzk5Ljk0NCAyNjguMzkzIDM5Ny41NzEgMjYyLjM2OUwzODAuMzQ0IDIxOC42NTRDMzc2LjA2MiAyMDcuNzg4IDM2Ni43NzUgMTk5LjY3NSAzNTUuNDMyIDE5Ni44OTFaIi8+PC9jbGlwUGF0aD48L2RlZnM+PHBhdGggZmlsbD0idXJsKCNhbWJlci1nbG93KSIgZD0iTTM1NS40MzIgMTk2Ljg5MUwzMjAuMjA3IDE4OC4yNDRDMzA5LjI1MiAxODUuNTU2IDI5Ny42NzEgMTg4LjE1NyAyODguOTE4IDE5NS4yNzJMMjU4LjI1NSAyMjAuMTk2QzI0OC42NDEgMjI4LjAxMSAyNDMuNzIxIDI0MC4yMiAyNDUuMjMgMjUyLjUxN0wyNTIuODU3IDMxNC42NjNDMjUzLjkzMyAzMjMuNDMxIDI1OC4xOTUgMzMxLjQ5NyAyNjQuODMzIDMzNy4zMjZMMjkzLjMwNyAzNjIuMzM1QzMwMy41NTcgMzcxLjMzNyAzMTguMDE0IDM3My43NzIgMzMwLjY0OCAzNjguNjI1TDM3MC42MSAzNTIuMzQxQzM4Mi4yMzMgMzQ3LjYwNiAzOTAuNTUgMzM3LjE1OSAzOTIuNTYxIDMyNC43NzFMMzk5LjYxMiAyODEuMzM2QzQwMC42NSAyNzQuOTQ1IDM5OS45NDQgMjY4LjM5MyAzOTcuNTcxIDI2Mi4zNjlMMzgwLjM0NCAyMTguNjU0QzM3Ni4wNjIgMjA3Ljc4OCAzNjYuNzc1IDE5OS42NzUgMzU1LjQzMiAxOTYuODkxWiIvPjxnIGNsaXAtcGF0aD0idXJsKCNhbWJlci1jbGlwKSI+PHBvbHlnb24gZmlsbD0icmdiYSgyNTUsMjUwLDIyNSwwLjE3OSkiIHBvaW50cz0iMzIxIDE4OCAyNTkgMjIwIDI5NyAyMzIiLz48cG9seWdvbiBmaWxsPSJyZ2JhKDI1NSwyNTAsMjI1LDAuMDkwKSIgcG9pbnRzPSIyNTkgMjIwIDI0NSAyNTIgMjc3IDI4MyAyOTcgMjMyIi8+PHBvbHlnb24gZmlsbD0icmdiYSgyNTUsMjUwLDIyNSwwLjA0NSkiIHBvaW50cz0iMjQ1IDI1MiAyNTMgMzE1IDI3NyAyODMiLz48cG9seWdvbiBmaWxsPSJyZ2JhKDE5MCw3NSwyMiwwLjA5MCkiIHBvaW50cz0iMjUzIDMxNSAyOTMgMzYyIDMyMiAzMTQgMjc3IDI4MyIvPjxwb2x5Z29uIGZpbGw9InJnYmEoMTkwLDc1LDIyLDAuMTU3KSIgcG9pbnRzPSIyOTMgMzYyIDMzMSAzNjkgMzIyIDMxNCIvPjxwb2x5Z29uIGZpbGw9InJnYmEoMTkwLDc1LDIyLDAuMjI0KSIgcG9pbnRzPSIzMzEgMzY5IDM3MSAzNTIgMzU3IDI4MSAzMjIgMzE0Ii8+PHBvbHlnb24gZmlsbD0icmdiYSgxOTAsNzUsMjIsMC4xNDYpIiBwb2ludHM9IjM3MSAzNTIgMzkzIDMyNSAzNTcgMjgxIi8+PHBvbHlnb24gZmlsbD0icmdiYSgxOTAsNzUsMjIsMC4wNzgpIiBwb2ludHM9IjM5MyAzMjUgNDAwIDI4MSAzNDQgMjM2IDM1NyAyODEiLz48cG9seWdvbiBmaWxsPSJyZ2JhKDI1NSwyNTAsMjI1LDAuMDY3KSIgcG9pbnRzPSI0MDAgMjgxIDM4MCAyMTkgMzQ0IDIzNiIvPjxwb2x5Z29uIGZpbGw9InJnYmEoMjU1LDI1MCwyMjUsMC4xMjMpIiBwb2ludHM9IjM4MCAyMTkgMzIxIDE4OCAyOTcgMjMyIDM0NCAyMzYiLz48cG9seWdvbiBmaWxsPSJyZ2JhKDI1NSwyNTAsMjI1LDAuMDU2KSIgcG9pbnRzPSIyOTcgMjMyIDM0NCAyMzYgMzU3IDI4MSAzMjIgMzE0IDI3NyAyODMiLz48ZyBmaWxsPSJub25lIiBzdHJva2U9InJnYmEoMjU1LDI0NiwyMjgsMC4zMikiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIHN0cm9rZS13aWR0aD0iMS4xIj48cG9seWdvbiBwb2ludHM9IjMyMSAxODggMjU5IDIyMCAyOTcgMjMyIi8+PHBvbHlnb24gcG9pbnRzPSIyNTkgMjIwIDI0NSAyNTIgMjc3IDI4MyAyOTcgMjMyIi8+PHBvbHlnb24gcG9pbnRzPSIyNDUgMjUyIDI1MyAzMTUgMjc3IDI4MyIvPjxwb2x5Z29uIHBvaW50cz0iMjUzIDMxNSAyOTMgMzYyIDMyMiAzMTQgMjc3IDI4MyIvPjxwb2x5Z29uIHBvaW50cz0iMjkzIDM2MiAzMzEgMzY5IDMyMiAzMTQiLz48cG9seWdvbiBwb2ludHM9IjMzMSAzNjkgMzcxIDM1MiAzNTcgMjgxIDMyMiAzMTQiLz48cG9seWdvbiBwb2ludHM9IjM3MSAzNTIgMzkzIDMyNSAzNTcgMjgxIi8+PHBvbHlnb24gcG9pbnRzPSIzOTMgMzI1IDQwMCAyODEgMzQ0IDIzNiAzNTcgMjgxIi8+PHBvbHlnb24gcG9pbnRzPSI0MDAgMjgxIDM4MCAyMTkgMzQ0IDIzNiIvPjxwb2x5Z29uIHBvaW50cz0iMzgwIDIxOSAzMjEgMTg4IDI5NyAyMzIgMzQ0IDIzNiIvPjxwb2x5Z29uIHBvaW50cz0iMjk3IDIzMiAzNDQgMjM2IDM1NyAyODEgMzIyIDMxNCAyNzcgMjgzIi8+PC9nPjwvZz48L3N2Zz4=`;

export function renderLibraryIndex(entries: LibraryEntry[]): string {
  const rows = entries.map(row).join("\n");
  const count = entries.length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Amber archive</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
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
