/**
 * Keep-js mode: instead of stripping scripts, preserve the page's own runtime
 * so JS-choreographed sites (canvas heroes, scroll animation, WebGL) still
 * work offline. Claude's plan decides per page (`preserveRuntime`);
 * --keep-js/--no-keep-js override. Three moves:
 *
 *   1. Classify — tracker/analytics scripts are removed by heuristic; the
 *      page's app code is kept.
 *   2. Flatten — module scripts can't load from file:// (CORS blocks module
 *      imports for opaque origins), so every <script type="module"> is bundled
 *      with esbuild into ONE classic IIFE script, using the bytes the
 *      Playwright render already downloaded as a virtual filesystem (with a
 *      network fallback for lazy chunks the render never triggered).
 *   3. Replay — xhr/fetch responses recorded during the render are embedded in
 *      the page, and a shim (REPLAY_SHIM, regression-tested in
 *      test/shim.test.ts) patches the network APIs to answer from that map,
 *      so code that renders from runtime data still works offline. Anything
 *      not captured fails closed — a synthetic 504, never a network call.
 *
 * The contract is "the recorded session works offline"; dynamic behaviour
 * beyond what the render exercised is best-effort.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { CheerioAPI } from "cheerio";
import { USER_AGENT, SEEDED_RANDOM_SNIPPET, type RenderedResource } from "./render.js";
import { MIME } from "./serve.js";
import { AmberError } from "./errors.js";

/**
 * esbuild is an optional peer dependency (same pattern as Playwright): plain
 * `npm i -g in-amber` installs skip its ~10MB of platform binaries, and only
 * keep-js needs it. Missing module → an error that says how to opt in.
 */
async function loadEsbuild(): Promise<typeof import("esbuild")> {
  try {
    return await import("esbuild");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") throw err;
    throw new AmberError(
      "keep-js needs esbuild to flatten the page's module scripts.\n" +
        "  Install it:  npm install -g esbuild",
    );
  }
}

/** Whether keep-js can run (esbuild importable) — used by auto-escalation. */
export async function keepJsAvailable(): Promise<boolean> {
  try {
    await import("esbuild");
    return true;
  } catch {
    return false;
  }
}

export interface KeepJsReport {
  trackersRemoved: number;
  modulesBundled: number;
  inlineModulesBundled: number;
  classicKept: number;
  /** Lazy chunks not fetched during the render, pulled at bundle time. */
  chunksFetched: number;
  /** xhr/fetch responses embedded for the replay shim. */
  replayEntries: number;
  /** Runtime-loaded resources (JS-constructed URLs) localised for the src shim. */
  runtimeAssets: number;
  /**
   * True when the archive was collapsed into a single self-contained
   * index.html (assets inlined as data: URIs). Single-file is what makes
   * WebGL/canvas work from a double-clicked file:// page — data: resources
   * are same-origin, so nothing taints. False -> the folder layout was kept
   * (assets exceeded the inline cap) and a "View archive.command" launcher
   * was written instead.
   */
  singleFile: boolean;
  /** Raw asset bytes inlined (0 when singleFile is false). */
  inlinedBytes: number;
  /**
   * Assets fetched to complete numeric sequences (scroll-scrubbed frame sets —
   * the render only triggers the frames its scroll positions hit, but the
   * URL pattern gives away the rest).
   */
  sequenceFilled: number;
  bundleBytes: number;
  warnings: string[];
}

export interface KeepJsOptions {
  /** Final page URL — base for resolving script srcs and import specifiers. */
  pageUrl: string;
  /** Bytes the render already downloaded, keyed by fragmentless URL. */
  resources: Map<string, RenderedResource>;
  /** Archive staging root (assets/ is created under it). */
  rootDir: string;
  /** URL of the first external module script — the base import.meta.url gets. */
  entryUrl?: string;
  log?: (m: string) => void;
}

// Third-party analytics/consent/ads — removed even in keep-js mode. The point
// of the flag is the page's own runtime, not its surveillance.
const TRACKER_SRC =
  /googletagmanager|google-analytics|gtag\/js|doubleclick|adsbygoogle|facebook\.net|fbevents|hotjar|clarity\.ms|segment\.(?:com|io)|cdn\.segment|plausible\.io|usefathom|matomo|mixpanel|amplitude|fullstory|intercom(?:cdn)?\.|sentry(?:-cdn)?\.|newrelic|cookiebot|cookielaw|onetrust|consentmanager|quantserve|scorecardresearch|chartbeat|parsely|criteo|taboola|outbrain/i;
const TRACKER_INLINE =
  /\b(?:gtag\(|dataLayer\s*[.=[]|fbq\(|_paq\b|ga\(['"]create|_hsq\b|heap\.load|mixpanel\.init|amplitude\.getInstance)/;

// Non-executing script types that must survive untouched (structured data).
const DATA_SCRIPT_TYPE = /json|template/i;

function isExecutable(type: string | undefined): boolean {
  if (!type) return true;
  const t = type.trim().toLowerCase();
  return t === "" || t === "text/javascript" || t === "application/javascript" || t === "module";
}

export async function applyKeepJs($: CheerioAPI, opts: KeepJsOptions): Promise<KeepJsReport> {
  const log = opts.log ?? (() => {});
  const report: KeepJsReport = {
    trackersRemoved: 0,
    modulesBundled: 0,
    inlineModulesBundled: 0,
    classicKept: 0,
    chunksFetched: 0,
    replayEntries: 0,
    runtimeAssets: 0,
    sequenceFilled: 0,
    singleFile: false,
    inlinedBytes: 0,
    bundleBytes: 0,
    warnings: [],
  };

  // -- 1. classify ---------------------------------------------------------
  const moduleParts: Array<{ kind: "url"; url: string } | { kind: "inline"; code: string }> = [];
  for (const el of $("script").toArray()) {
    const type = $(el).attr("type");
    if (type && DATA_SCRIPT_TYPE.test(type)) continue; // ld+json etc.
    if (!isExecutable(type)) continue;
    const src = $(el).attr("src");
    const inline = $(el).html() ?? "";

    if (src && TRACKER_SRC.test(src)) {
      $(el).remove();
      report.trackersRemoved++;
      continue;
    }
    if (!src && TRACKER_INLINE.test(inline)) {
      $(el).remove();
      report.trackersRemoved++;
      continue;
    }

    if ((type ?? "").trim().toLowerCase() === "module") {
      if (src) {
        const abs = resolveUrl(src, opts.pageUrl);
        if (abs) {
          moduleParts.push({ kind: "url", url: abs });
          report.modulesBundled++;
        } else {
          report.warnings.push(`unresolvable module src: ${src}`);
        }
      } else if (inline.trim()) {
        moduleParts.push({ kind: "inline", code: inline });
        report.inlineModulesBundled++;
      }
      $(el).remove(); // replaced by the flattened bundle below
    } else {
      // Classic scripts (external or inline) run fine from file:// — external
      // ones are localised by captureAssets like any other asset.
      report.classicKept++;
    }
  }

  // -- 2. flatten modules into one classic script --------------------------
  if (moduleParts.length > 0) {
    const entry = moduleParts
      .map((p) => (p.kind === "url" ? `import ${JSON.stringify(p.url)};` : p.code))
      .join("\n");
    const entryUrl = moduleParts.find((p): p is { kind: "url"; url: string } => p.kind === "url")?.url;
    const bundled = await bundleModules(entry, { ...opts, entryUrl }, report);
    if (bundled) {
      const name = `app-bundle-${crypto.createHash("sha1").update(bundled.js).digest("hex").slice(0, 8)}`;
      const rel = `assets/static/${name}.js`;
      const abs = path.join(opts.rootDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bundled.js);
      report.bundleBytes = Buffer.byteLength(bundled.js);
      if (bundled.css) {
        const cssRel = `assets/static/${name}.css`;
        fs.writeFileSync(path.join(opts.rootDir, cssRel), bundled.css);
        $("head").append(`<link rel="stylesheet" href="${cssRel}" data-amber="bundle">`);
      }
      // Modules are deferred; an end-of-body classic script is the closest
      // classic equivalent (DOM is parsed by the time it runs).
      $("body").append(`<script src="${rel}" data-amber="bundle"></script>`);
      log(`      [keep-js] flattened ${moduleParts.length} module script(s) -> ${rel} (${report.bundleBytes} bytes)`);
    }
  }

  // -- 3. replay shim for runtime-fetched data -----------------------------
  const replay: Array<{ url: string; ct: string; b: string }> = [];
  for (const [url, res] of opts.resources) {
    if (res.resourceType === "xhr" || res.resourceType === "fetch") {
      replay.push({ url, ct: res.contentType, b: res.body.toString("base64") });
    }
  }
  replay.sort((a, b) => (a.url < b.url ? -1 : 1)); // byte-stable across runs, for snapshot dedupe
  report.replayEntries = replay.length;
  // The shim is injected even with zero entries — it's also what keeps
  // uncaptured fetches from hitting the network (they get a synthetic 504).
  const dataJson = JSON.stringify({ base: opts.pageUrl, entries: replay })
    // A "</script>" inside a body would end the data element early.
    .replace(/</g, "\\u003c");
  $("head").prepend(
    `<script type="application/json" id="amber-replay-data">${dataJson}</script>` +
      `<script data-amber="shim">${REPLAY_SHIM}</script>`,
  );

  return report;
}

/**
 * Second keep-js pass, run AFTER captureAssets: localise every resource the
 * render recorded that nothing in the final DOM references (the app loads them
 * by constructing URLs at runtime — video.src = "/films/x.mp4"), then embed a
 * url -> local-path map the shim's src patches consult. Original module chunks
 * are skipped: the flattened bundle already contains them.
 */
export async function injectRuntimeAssets(
  $: CheerioAPI,
  cap: { ensureAsset(url: string): Promise<{ url: string; localPath: string; ok: boolean } | null>; assets: Array<{ url: string; localPath: string; ok: boolean }> },
  resources: Map<string, RenderedResource>,
  report: KeepJsReport,
): Promise<void> {
  const known = new Set(cap.assets.map((a) => a.url));
  const SKIP = new Set(["document", "script", "xhr", "fetch", "ping", "beacon", "websocket", "eventsource"]);
  await fillNumericSequences(resources, report);
  for (const [url, res] of resources) {
    if (SKIP.has(res.resourceType ?? "")) continue;
    if (known.has(url)) continue;
    const asset = await cap.ensureAsset(url);
    if (asset?.ok) report.runtimeAssets++;
  }
  const map: Record<string, string> = {};
  // Sorted so the embedded JSON is byte-stable across runs — resource arrival
  // order isn't, and snapshot dedupe compares bytes.
  for (const a of [...cap.assets].sort((x, y) => (x.url < y.url ? -1 : 1))) {
    if (a.ok && a.localPath) map[a.url] = a.localPath;
  }
  const json = JSON.stringify(map).replace(/</g, "\\u003c");
  // The shim reads this lazily, so it may be injected after the shim script.
  $("head").append(`<script type="application/json" id="amber-asset-map">${json}</script>`);
}

/**
 * Scroll-scrubbed sites map scroll position to frame N of an image sequence
 * (`/films/x/1536/f_310.webp`), so the render only records the frames its
 * scroll positions happened to hit. The URLs are a numeric sequence, though:
 * when ≥5 recorded URLs differ only in one number, fetch the gaps between the
 * observed min and max (network is still available at archive time). Misses
 * are skipped silently — probing, not scraping.
 */
async function fillNumericSequences(
  resources: Map<string, RenderedResource>,
  report: KeepJsReport,
  caps: { perGroup: number; total: number } = { perGroup: 600, total: 2000 },
): Promise<void> {
  // Last run of digits in the pathname is the frame counter.
  const NUM = /^(.*\/[^/?]*?)(\d+)([^/\d?]*)(\?.*)?$/;
  const groups = new Map<string, { width: number; values: number[]; prefix: string; suffix: string; query: string; type?: string }>();
  for (const [url, res] of resources) {
    if (res.resourceType && !["image", "media", "other", "font"].includes(res.resourceType)) continue;
    const m = NUM.exec(url);
    if (!m) continue;
    const [, prefix, num, suffix, query = ""] = m;
    const key = `${prefix}#${suffix}${query}`;
    const g = groups.get(key) ?? { width: num!.length, values: [], prefix: prefix!, suffix: suffix!, query, type: res.resourceType };
    g.values.push(parseInt(num!, 10));
    g.width = Math.max(g.width, num!.length);
    groups.set(key, g);
  }

  let total = 0;
  for (const g of groups.values()) {
    if (g.values.length < 5 || total >= caps.total) continue;
    const sorted = [...new Set(g.values)].sort((a, b) => a - b);
    let step = Infinity;
    for (let i = 1; i < sorted.length; i++) step = Math.min(step, sorted[i]! - sorted[i - 1]!);
    if (!Number.isFinite(step) || step < 1) continue;
    const have = new Set(sorted);
    let filled = 0;
    for (let n = sorted[0]!; n <= sorted[sorted.length - 1]! && filled < caps.perGroup && total < caps.total; n += step) {
      if (have.has(n)) continue;
      const url = `${g.prefix}${String(n).padStart(g.width, "0")}${g.suffix}${g.query}`;
      try {
        const got = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
        if (!got.ok) continue;
        resources.set(url, {
          contentType: got.headers.get("content-type") ?? "",
          body: Buffer.from(await got.arrayBuffer()),
          resourceType: g.type ?? "other",
        });
        filled++;
        total++;
      } catch {
        /* speculative — a miss is fine */
      }
    }
    report.sequenceFilled += filled;
  }
}

/**
 * Raw asset bytes above which single-file inlining is skipped. Base64 expands
 * 4/3x and the biggest chunk (the runtime asset map) must survive as ONE
 * JavaScript string — V8 caps strings around ~512MB — so 200MB raw (~270MB
 * encoded) leaves real headroom before the cliff.
 */
export const INLINE_CAP_BYTES = 200 * 1024 * 1024;

/** url(...) inside CSS — local copy of capture.ts's pattern to avoid a cycle. */
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

/**
 * Final keep-js delivery step, run after every asset is on disk and the DOM is
 * final. Default: collapse the archive into ONE self-contained index.html by
 * rewriting every assets/ reference (attributes, srcset, CSS url(), the
 * flattened bundle, the runtime asset map) to a data: URI, then deleting
 * assets/. data: resources are same-origin, so WebGL/canvas keep working from
 * a double-clicked file:// page — the folder layout can't offer that.
 * Over the cap: keep the folder and write a double-clickable
 * "View archive.command" that serves it on localhost instead.
 *
 * Memory: the base64 payload (~4/3x the asset bytes) must never exist in the
 * DOM or in one serialized string — that OOMs Node on real sites. Instead the
 * DOM gets small `@@AMBER[relpath]@@` tokens, and the final index.html is
 * STREAMED to disk, expanding each token from its file as it passes. Peak
 * memory is one asset's base64, not the archive's.
 *
 * In single-file mode this function writes index.html itself — the caller
 * must skip its own write when `report.singleFile` comes back true.
 */
export function finalizeKeepJsDelivery(
  $: CheerioAPI,
  rootDir: string,
  report: KeepJsReport,
  opts?: { capBytes?: number },
): void {
  // AMBER_INLINE_CAP (bytes) overrides the cap — mainly for testing the
  // launcher fallback without a >200MB site.
  const envCap = Number(process.env.AMBER_INLINE_CAP);
  const cap = opts?.capBytes ?? (Number.isFinite(envCap) && envCap > 0 ? envCap : INLINE_CAP_BYTES);
  const assetsDir = path.join(rootDir, "assets");
  const total = dirBytes(assetsDir);
  if (total > cap) {
    writeLauncher(rootDir);
    report.singleFile = false;
    return;
  }

  const isAssetRef = (v: string) => v.startsWith("assets/");
  const token = (rel: string) => `@@AMBER[${path.posix.normalize(rel)}]@@`;
  const tokenizeCssUrls = (css: string, cssDirRel: string): string =>
    css.replace(CSS_URL, (m, _q, ref) => {
      if (/^(data:|https?:|#|@@AMBER)/i.test(ref)) return m;
      // css url()s are relative to the stylesheet's own directory
      const rel = path.posix.normalize(path.posix.join(cssDirRel, ref));
      return isAssetRef(rel) ? `url(${token(rel)})` : m;
    });

  // 1. Stylesheet links -> <style> (their url() refs resolved + tokenized).
  for (const el of $("link[rel~='stylesheet'][href]").toArray()) {
    const href = $(el).attr("href")!;
    if (!isAssetRef(href)) continue;
    const abs = path.join(rootDir, href.split("/").join(path.sep));
    let css: string;
    try {
      css = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    $(el).replaceWith(`<style>${tokenizeCssUrls(css, path.posix.dirname(href))}</style>`);
  }

  // 2. Local scripts (the flattened bundle) -> inline. "</script" inside JS
  // only occurs within string/regex literals, where "\/" === "/".
  for (const el of $("script[src]").toArray()) {
    const src = $(el).attr("src")!;
    if (!isAssetRef(src)) continue;
    const abs = path.join(rootDir, src.split("/").join(path.sep));
    let js: string;
    try {
      js = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    $(el).removeAttr("src");
    $(el).text(js.replace(/<\/script/gi, "<\\/script"));
  }

  // 3. Every remaining assets/ reference in any attribute (src, href, poster,
  // srcset, …) and in inline/element CSS.
  $("*").each((_, el) => {
    if (el.type !== "tag") return;
    for (const [attr, val] of Object.entries(el.attribs ?? {})) {
      if (!val) continue;
      if (attr === "srcset" || attr === "imagesrcset") {
        const parts = val.split(",").map((part) => {
          const bits = part.trim().split(/\s+/);
          if (bits[0] && isAssetRef(bits[0])) bits[0] = token(bits[0]);
          return bits.join(" ");
        });
        $(el).attr(attr, parts.join(", "));
      } else if (attr === "style") {
        $(el).attr(attr, tokenizeCssUrls(val, "."));
      } else if (isAssetRef(val)) {
        $(el).attr(attr, token(val));
      }
    }
  });
  for (const el of $("style").toArray()) {
    const css = $(el).html();
    if (css) $(el).html(tokenizeCssUrls(css, "."));
  }

  // 4. The runtime asset map: values become tokens so the shim's src patches
  // hand the app same-origin data: resources after expansion.
  const mapEl = $("#amber-asset-map");
  if (mapEl.length) {
    const map = JSON.parse(mapEl.html()!.replace(/\\u003c/gi, "<")) as Record<string, string>;
    for (const [url, rel] of Object.entries(map)) {
      if (isAssetRef(rel)) map[url] = token(rel);
      else delete map[url];
    }
    // data: URIs are pure base64 + mime — valid inside JSON strings unescaped.
    mapEl.html(JSON.stringify(map).replace(/</g, "\\u003c"));
  }

  // 5. Serialize (small — tokens, not payloads) and stream-expand to disk.
  streamExpandTokens($.html(), rootDir, path.join(rootDir, "index.html"));

  fs.rmSync(assetsDir, { recursive: true, force: true });
  report.singleFile = true;
  report.inlinedBytes = total;
}

/**
 * Write `html` to `outFile`, replacing each `@@AMBER[rel]@@` token with the
 * data: URI of that file, base64-encoded in slices so no whole-archive string
 * ever exists. Missing files leave the original relative path in place.
 */
function streamExpandTokens(html: string, rootDir: string, outFile: string): void {
  const TOKEN = /@@AMBER\[([^\]]+)\]@@/g;
  const fd = fs.openSync(outFile + ".tmp", "w");
  try {
    let last = 0;
    for (const m of html.matchAll(TOKEN)) {
      fs.writeSync(fd, html.slice(last, m.index));
      last = m.index! + m[0].length;
      const rel = m[1]!;
      const abs = path.join(rootDir, rel.split("/").join(path.sep));
      let size: number;
      try {
        size = fs.statSync(abs).size;
      } catch {
        fs.writeSync(fd, rel); // dangling ref — restore the relative path
        continue;
      }
      const mime = (MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream").split(";")[0]!;
      fs.writeSync(fd, `data:${mime};base64,`);
      // 24MiB slices (divisible by 3, so each slice base64-encodes cleanly).
      const SLICE = 24 * 1024 * 1024;
      const src = fs.openSync(abs, "r");
      try {
        const buf = Buffer.alloc(Math.min(SLICE, size));
        let read: number;
        while ((read = fs.readSync(src, buf, 0, buf.length, null)) > 0) {
          fs.writeSync(fd, buf.subarray(0, read).toString("base64"));
        }
      } finally {
        fs.closeSync(src);
      }
    }
    fs.writeSync(fd, html.slice(last));
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(outFile + ".tmp", outFile);
}

/**
 * Content hash for keep-js snapshots. The byte-exact hash the static pipeline
 * uses can never match across keep-js runs: the serialized DOM carries
 * mid-flight animation state (a rotate() captured between frames) and the
 * recorded runtime asset set drifts by a few lazy frames per run — so every
 * re-archive would pile up a "new" version. Instead, hash what signals a real
 * change: the page's visible text (scripts/styles excluded), the bytes of
 * every DOM-referenced asset, and the flattened bundle (code changes).
 * Deliberately ignored: animation attribute churn, the runtime-recorded asset
 * set, and replay-map API responses (volatile server fields).
 */
export function keepJsContentHash($: CheerioAPI, rootDir: string, domAssetPaths: string[]): string {
  const h = crypto.createHash("sha256");
  const body = $.root().clone();
  body.find("script, style").remove();
  h.update(body.text().replace(/\s+/g, " ").trim());
  h.update("\0");
  const paths = [...new Set(domAssetPaths)].sort();
  const bundleSrc = $("script[data-amber='bundle']").attr("src");
  if (bundleSrc) paths.push(bundleSrc);
  for (const rel of paths) {
    h.update(rel);
    h.update("\0");
    try {
      h.update(fs.readFileSync(path.join(rootDir, rel.split("/").join(path.sep))));
    } catch {
      /* asset missing — the differing path list already changes the hash */
    }
    h.update("\0");
  }
  return h.digest("hex");
}

function dirBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

/**
 * The over-cap fallback: a double-clickable launcher that serves the archive
 * folder on a free localhost port and opens the browser. A shell wrapper
 * passing Node an inline program (-e) — running the file THROUGH node would
 * hit ERR_UNKNOWN_FILE_EXTENSION whenever an ancestor package.json declares
 * "type": "module" (the ESM loader refuses unknown extensions). The inline
 * JS must contain no single quotes: the shell wraps it in them.
 */
function writeLauncher(rootDir: string): void {
  const js = `
const http = require("http"), fs = require("fs"), path = require("path"), cp = require("child_process");
const root = process.argv[1];
const MIME = ${JSON.stringify(MIME)};
const server = http.createServer((req, res) => {
  const reqPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let rel = path.normalize(reqPath).replace(/^([/\\\\])+/, "") || "index.html";
  if (rel === ".") rel = "index.html";
  const abs = path.resolve(path.join(root, rel));
  if (abs !== root && !abs.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(abs, (err, body) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream" });
    res.end(body);
  });
});
server.listen(0, "127.0.0.1", () => {
  const url = "http://127.0.0.1:" + server.address().port + "/";
  console.log("Serving " + root);
  console.log("  " + url + "  (close this window to stop)");
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  cp.exec(opener + " " + url);
});
`.trim();
  if (js.includes("'")) throw new Error("launcher JS must not contain single quotes");
  const script = `#!/bin/sh
# Double-click to view this archive. It starts a tiny local server and opens
# your browser - needed because browsers block WebGL/canvas use of local
# media on file:// pages; over http://127.0.0.1 everything works.
command -v node >/dev/null 2>&1 || {
  echo "This launcher needs Node.js installed (https://nodejs.org)."
  echo "Alternatively run any static server in this folder, e.g.:"
  echo "  python3 -m http.server"
  read -r _
  exit 1
}
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node -e '${js}' "$DIR"
`;
  const file = path.join(rootDir, "View archive.command");
  fs.writeFileSync(file, script, { mode: 0o755 });
}

function resolveUrl(raw: string, base: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Bundle the synthetic entry with esbuild, resolving every import against the
 * render's recorded resources; chunks the render never triggered (lazy
 * `import()`s) are fetched from the network at bundle time. Output is a single
 * classic IIFE (plus optional CSS pulled in via JS imports).
 */
async function bundleModules(
  entry: string,
  opts: KeepJsOptions,
  report: KeepJsReport,
): Promise<{ js: string; css: string | null } | null> {
  // Outside the try below on purpose: a missing esbuild is a setup problem the
  // user must hear about, not a page quirk to degrade around.
  const esbuild = await loadEsbuild();

  const loaderFor = (contentType: string, url: string): "js" | "css" | "json" | "dataurl" | "text" => {
    const ct = contentType.split(";")[0]!.trim().toLowerCase();
    if (ct.includes("javascript") || /\.m?js(\?|$)/i.test(url)) return "js";
    if (ct.includes("css") || /\.css(\?|$)/i.test(url)) return "css";
    if (ct.includes("json") || /\.json(\?|$)/i.test(url)) return "json";
    if (ct.startsWith("image/") || ct.startsWith("font/") || ct.includes("octet-stream")) return "dataurl";
    return "text";
  };

  const amberHttp: import("esbuild").Plugin = {
    name: "amber-http",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const base = /^https?:/i.test(args.importer) ? args.importer : opts.pageUrl;
        const url = resolveUrl(args.path, base);
        if (!url) return { external: true }; // data:, bare specifier fallback — leave as-is
        return { path: url, namespace: "amber-http" };
      });
      build.onLoad({ filter: /.*/, namespace: "amber-http" }, async (args) => {
        let res = opts.resources.get(args.path);
        if (!res) {
          const got = await fetch(args.path, { headers: { "User-Agent": USER_AGENT } });
          if (!got.ok) throw new Error(`fetch ${args.path} -> HTTP ${got.status}`);
          res = { contentType: got.headers.get("content-type") ?? "", body: Buffer.from(await got.arrayBuffer()) };
          report.chunksFetched++;
        }
        return { contents: res.body, loader: loaderFor(res.contentType, args.path) };
      });
    },
  };

  // NOTE: pinning `location.*` reads via define was tried and reverted — apps
  // alias `window.location` (define can't reach `loc.pathname`), and a pinned
  // `origin` turns a router's failed-route redirect into a navigation to the
  // LIVE site. SPA routers that hard-navigate on unmatched paths are served
  // correctly by the localhost delivery (path "/"), not by single-file.
  //
  // import.meta.url can't exist in a classic script; define it as the ENTRY
  // MODULE's URL (not the page's) — bundler output resolves co-located assets
  // with `new URL("x.wasm", import.meta.url)`, and those live next to the
  // bundle (/assets/…), not next to the page.
  const define: Record<string, string> = {
    "import.meta.url": JSON.stringify(opts.entryUrl ?? opts.pageUrl),
  };

  try {
    const result = await esbuild.build({
      stdin: { contents: entry, loader: "js", sourcefile: "amber-entry.js" },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "es2020",
      outdir: "amber-out",
      logLevel: "silent",
      plugins: [amberHttp],
      define,
    });
    for (const w of result.warnings) {
      report.warnings.push(`esbuild: ${w.text}`);
    }
    let js: string | null = null;
    let css: string | null = null;
    for (const f of result.outputFiles) {
      if (f.path.endsWith(".js")) js = f.text;
      else if (f.path.endsWith(".css")) css = f.text;
    }
    if (!js) {
      report.warnings.push("esbuild produced no JS output — original module tags were dropped");
      return null;
    }
    return { js, css };
  } catch (err) {
    // Bundling failed (top-level await, unresolvable dynamic import, …). The
    // archive still works as a static page; record why the JS is missing.
    report.warnings.push(`module bundling failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Injected inline ahead of everything else. Patches the network APIs so the
 * kept app code replays the recorded session instead of reaching the network:
 * fetch/XHR answer from the embedded map (synthetic 504 on a miss), beacons are
 * swallowed, WebSockets fail cleanly.
 */
const REPLAY_SHIM = `${SEEDED_RANDOM_SNIPPET}
(() => {
  var dataEl = document.getElementById('amber-replay-data');
  var DATA = dataEl ? JSON.parse(dataEl.textContent) : { base: location.href, entries: [] };
  var index = new Map(), noQuery = new Map();
  var stripQ = function (u) { return u.split('?')[0]; };
  DATA.entries.forEach(function (e) {
    index.set(e.url, e);
    if (!noQuery.has(stripQ(e.url))) noQuery.set(stripQ(e.url), e);
  });
  // The directory this archive is being viewed from (file:///…/slug/ or
  // http://127.0.0.1:PORT/). Apps often pre-resolve relative asset paths
  // against the DOCUMENT's URL (three.js loaders, new URL(x, import.meta.url)
  // fallbacks) — those arrive here as file:///…/draco/decoder.wasm. Translate
  // anything under the viewing directory back into the ORIGINAL site's URL
  // space so it can hit the recorded maps.
  var DOCDIR = (function () {
    var h = location.href.split(/[?#]/)[0];
    return h.slice(0, h.lastIndexOf('/') + 1);
  })();
  var normalize = function (u) {
    try {
      var x = new URL(u, DATA.base);
      x.hash = '';
      var s = x.toString();
      if (s.indexOf(DOCDIR) === 0) s = new URL(s.slice(DOCDIR.length), DATA.base).toString();
      return s;
    } catch (_) { return String(u); }
  };
  var byPath = null;
  var lookup = function (u) {
    u = normalize(u);
    var hit = index.get(u) || noQuery.get(stripQ(u));
    if (hit) return hit;
    // Cross-host fallback: sites serve assets from a CDN domain picked by a
    // hostname check (lusion.co -> lusion.dev). Offline that check picks the
    // page origin, so match recorded entries by pathname regardless of host.
    if (!byPath) {
      byPath = new Map();
      DATA.entries.forEach(function (e) {
        try {
          var p = new URL(e.url).pathname;
          if (!byPath.has(p)) byPath.set(p, e);
        } catch (_) { /* unparseable key */ }
      });
    }
    try { return byPath.get(new URL(u).pathname) || null; } catch (_) { return null; }
  };
  var bytes = function (b64) {
    var bin = atob(b64), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  };

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    var hit = lookup(url);
    if (hit) return Promise.resolve(new Response(bytes(hit.b), { status: 200, headers: { 'content-type': hit.ct } }));
    // blob:/data: are page-local (apps fetch blobs they just created) — real
    // fetch handles them without touching the network.
    if (/^(blob:|data:)/i.test(String(url))) return realFetch(input, init);
    return Promise.resolve(new Response('', { status: 504, statusText: 'amber: not captured' }));
  };

  var Emitter = window.EventTarget || function () {};
  function AmberXHR() {
    this.readyState = 0; this.status = 0; this.responseType = '';
    this.responseText = ''; this.response = null;
  }
  AmberXHR.prototype = Object.create(Emitter.prototype || Object.prototype);
  AmberXHR.prototype.open = function (m, u) { this._url = u; this.readyState = 1; };
  AmberXHR.prototype.setRequestHeader = function () {};
  AmberXHR.prototype.getResponseHeader = function (h) {
    return this._hit && String(h).toLowerCase() === 'content-type' ? this._hit.ct : null;
  };
  AmberXHR.prototype.getAllResponseHeaders = function () {
    return this._hit ? 'content-type: ' + this._hit.ct + '\\r\\n' : '';
  };
  AmberXHR.prototype.abort = function () {};
  AmberXHR.prototype.addEventListener = function (t, fn) { (this._ls = this._ls || {})[t] = fn; };
  AmberXHR.prototype.removeEventListener = function () {};
  AmberXHR.prototype.send = function () {
    var self = this;
    this._hit = lookup(this._url);
    setTimeout(function () {
      self.readyState = 4;
      var fire = function (t) {
        if (self['on' + t]) try { self['on' + t](); } catch (_) {}
        if (self._ls && self._ls[t]) try { self._ls[t]({ type: t }); } catch (_) {}
      };
      if (self._hit) {
        self.status = 200;
        var arr = bytes(self._hit.b);
        self.responseText = new TextDecoder().decode(arr);
        self.response = self.responseType === 'arraybuffer' ? arr.buffer
          : self.responseType === 'json' ? JSON.parse(self.responseText)
          : self.responseText;
      } else {
        self.status = 0;
      }
      if (self.onreadystatechange) try { self.onreadystatechange(); } catch (_) {}
      fire(self._hit ? 'load' : 'error');
      fire('loadend');
    }, 0);
  };
  window.XMLHttpRequest = AmberXHR;

  // SPA routers call history.pushState/replaceState with resolved URLs, which
  // throws on a file:// (null-origin) page — and a thrown pushState can
  // cascade into the router hard-navigating away from the archive. Make it
  // succeed same-document instead: retry with the URL as a fragment (always
  // legal), then with no URL at all.
  ['pushState', 'replaceState'].forEach(function (fn) {
    var orig = history[fn].bind(history);
    history[fn] = function (state, title, url) {
      try { return orig(state, title, url); } catch (_) {
        try { return orig(state, title, '#' + String(url == null ? '' : url)); } catch (_) {
          try { return orig(state, title); } catch (_) { /* drop */ }
        }
      }
    };
  });

  if (navigator.sendBeacon) navigator.sendBeacon = function () { return true; };
  window.WebSocket = function () {
    var self = this;
    setTimeout(function () { if (self.onerror) self.onerror({ type: 'error' }); }, 0);
    this.send = function () {}; this.close = function () {};
    this.addEventListener = function () {}; this.removeEventListener = function () {};
  };

  // -- runtime-constructed asset URLs --------------------------------------
  // App code sets video.src = "/films/x.mp4" etc. against the ORIGINAL origin;
  // remap those to the localised copies via the amber-asset-map JSON (read
  // lazily — it's injected after this shim, in a later pipeline pass).
  var assetMap = null;
  var getAssetMap = function () {
    if (assetMap) return assetMap;
    var el = document.getElementById('amber-asset-map');
    assetMap = el ? JSON.parse(el.textContent) : {};
    return assetMap;
  };
  var byBasename = null;
  // Fail closed: an empty data: URI. A kept script that constructs a URL the
  // recording doesn't cover must load NOTHING — not reach out to the live web.
  var BLOCKED = 'data:,';
  var mapAsset = function (v) {
    if (typeof v !== 'string' || !v || /^(data:|blob:|file:|#|assets\\/)/.test(v)) return v;
    var m = getAssetMap();
    var abs = normalize(v);
    if (m[abs]) return m[abs];
    var q = stripQ(abs);
    for (var k in m) { if (stripQ(k) === q) return m[k]; }
    // Nearest-variant fallback: responsive variants pick a size bucket from the
    // viewport (/films/x/768/f_1.webp vs the recorded /1536/). Same filename,
    // most shared path segments wins.
    if (!byBasename) {
      byBasename = {};
      for (var k2 in m) {
        var b2 = stripQ(k2).split('/').pop();
        (byBasename[b2] = byBasename[b2] || []).push(k2);
      }
    }
    var want = q.split('/');
    var cands = byBasename[want[want.length - 1]] || [];
    var best = null, bestScore = -1;
    for (var i = 0; i < cands.length; i++) {
      var have = stripQ(cands[i]).split('/');
      var score = 0;
      for (var j = 0; j < want.length; j++) { if (have.indexOf(want[j]) !== -1) score++; }
      if (score > bestScore) { bestScore = score; best = cands[i]; }
    }
    if (best) return m[best];
    // No recorded equivalent. Block http(s) loads outright; leave everything
    // else (relative oddities) to fail against the local filesystem.
    return /^https?:/i.test(abs) ? BLOCKED : v;
  };
  var patchProp = function (proto, prop) {
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    Object.defineProperty(proto, prop, {
      get: d.get,
      set: function (v) { d.set.call(this, mapAsset(v)); },
      configurable: true,
    });
  };
  if (window.HTMLImageElement) patchProp(HTMLImageElement.prototype, 'src');
  if (window.HTMLMediaElement) patchProp(HTMLMediaElement.prototype, 'src');
  if (window.HTMLSourceElement) patchProp(HTMLSourceElement.prototype, 'src');
  if (window.HTMLVideoElement) patchProp(HTMLVideoElement.prototype, 'poster');
  if (window.HTMLLinkElement) patchProp(HTMLLinkElement.prototype, 'href');
  var origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var n = String(name).toLowerCase();
    var tag = (this.tagName || '').toUpperCase();
    // src/poster are always loads. href is only a LOAD on <link>/<use> —
    // remapping (and fail-closing) an <a href> would destroy normal links.
    var isLoad = n === 'src' || n === 'poster' ||
      ((n === 'href' || n === 'xlink:href') && (tag === 'LINK' || tag === 'USE'));
    if (isLoad && typeof value === 'string') value = mapAsset(value);
    return origSetAttr.call(this, name, value);
  };
})();`;
