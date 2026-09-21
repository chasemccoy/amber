/** Orchestrate render/fetch -> capture -> plan -> clean -> package. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CheerioAPI } from "cheerio";
import { Capturer } from "./capture.js";
import { renderPage, thumbnailFromFile } from "./render.js";
import { heuristicPlan, llmPlan, parsePlan } from "./planner.js";
import { mediaTargets, removeJunk, stripStatic, swapMedia, type CleanReport } from "./clean.js";
import {
  applyKeepJs,
  stripTrackers,
  finalizeKeepJsDelivery,
  injectRuntimeAssets,
  keepJsAvailable,
  keepJsContentHash,
  type KeepJsReport,
} from "./keepjs.js";
import { commitSnapshot, hashSnapshotContent } from "./snapshot.js";
import { libraryTags, updateLibraryIndex } from "./library.js";
import {
  WAYBACK_REQUEST_DELAY_MS,
  WAYBACK_RETRY,
  WAYBACK_USER_AGENT,
  fetchWaybackPage,
  formatTimestamp,
  normalizeTimestamp,
  nowTimestamp,
  parseWaybackUrl,
  waybackFulfiller,
  waybackResolver,
  waybackViewUrl,
  type WaybackRef,
} from "./wayback.js";
import { AmberError } from "./errors.js";
import type { CleanupPlan, CaptureOptions } from "./types.js";

// Empty-when-JS-hasn't-run mount points for the common SPA frameworks.
const SPA_ROOTS = ["#root", "#app", "#__next", "#__nuxt", "[data-reactroot]"];

/**
 * Default archive root, shared by the CLI and the extension's native host so
 * both write to the same place. `AMBER_ARCHIVE_DIR` overrides it; the CLI's `-o`
 * overrides further.
 */
export function defaultArchiveDir(): string {
  return process.env.AMBER_ARCHIVE_DIR || path.join(os.homedir(), "Documents", "Archives");
}

/**
 * Decide whether a *static* fetch under-rendered the page and a browser render
 * would do better. Cheap, content-based: a client-rendered app ships an almost
 * empty body (often just an empty mount node) until its JS runs.
 */
export function assessRendering($: CheerioAPI): { escalate: boolean; reason: string } {
  const body = $("body").clone();
  body.find("script, style, noscript, template").remove();
  const textLen = body.text().replace(/\s+/g, " ").trim().length;

  for (const sel of SPA_ROOTS) {
    const el = $(sel).first();
    if (el.length && el.text().replace(/\s+/g, " ").trim().length < 50) {
      return { escalate: true, reason: `empty SPA mount ${sel} — page is client-rendered` };
    }
  }
  if (textLen < 200) {
    return { escalate: true, reason: `only ${textLen} chars of visible text — likely client-rendered` };
  }
  return { escalate: false, reason: `${textLen} chars of visible text — static capture is enough` };
}

// Directory suffixes macOS treats as opaque bundles — a folder named
// "linear.app" can't be opened in Finder, it "launches". De-fang by turning
// the offending dot into a dash (linear.app -> linear-app).
const MAC_BUNDLE_EXT = /\.(app|appex|framework|bundle|plugin|kext|prefpane|qlgenerator|xpc|wdgt)$/i;

export function slugifyUrl(url: string): string {
  let base: string;
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, "");
    base = `${host}${u.pathname}`.replace(/\/+$/, "") || host;
  } catch {
    base = url;
  }
  let slug = (base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "archive").slice(0, 80);
  // "." and ".." are hosts to the URL parser and traversal to the filesystem.
  if (!/[A-Za-z0-9]/.test(slug)) slug = "archive";
  if (MAC_BUNDLE_EXT.test(slug)) slug = slug.replace(/\.(?=[^.]+$)/, "-");
  return slug;
}

export interface ArchiveOptions extends CaptureOptions {
  outRoot: string;
  useLLM: boolean;
  planPath?: string;
  model: string;
  verbose: boolean;
  /** Replace the latest snapshot in place instead of keeping history. */
  overwrite?: boolean;
  /**
   * Force keep-js: preserve the page's own JS (trackers still removed),
   * flatten module scripts into a local classic bundle, and embed recorded
   * xhr/fetch data behind a replay shim. Forces the Playwright backend.
   * Left unset, Claude decides per page (see autoKeepJs).
   */
  keepJs?: boolean;
  /**
   * When keepJs is unset, allow the plan's `preserveRuntime` judgement to
   * escalate to keep-js automatically (requires esbuild + Playwright).
   * Default true; --no-keep-js sets it false.
   */
  autoKeepJs?: boolean;
  /**
   * Archive the page as it was at a moment in the past, via the Wayback
   * Machine: "2009", "2009-06-15", a 14-digit stamp, or "latest" (the most
   * recent capture — for dead sites). Giving a web.archive.org URL as the
   * target implies this. The archive is filed under the ORIGINAL url and
   * dated by the snapshot (manifest `snapshotAt`).
   */
  at?: string;
  /** Test seam: an alternate Wayback host, and no politeness delay. */
  wayback?: { base?: string; requestDelayMs?: number };
}

export interface ArchiveResult {
  outDir: string;
  plan: CleanupPlan;
  assetCount: number;
  assetErrors: number;
  cleanReport: CleanReport;
  /** False when the capture was identical to the existing latest (no new snapshot). */
  changed: boolean;
  /** Where the previous latest was archived, or null (first run / overwrite). */
  archivedTo: string | null;
  /**
   * Set when this capture was OLDER than the existing latest (a Wayback
   * backfill): it was filed here under versions/ and the root was untouched.
   */
  filedAs: string | null;
  /** Present when --keep-js ran: what the runtime-preservation pass did. */
  keepJs?: KeepJsReport;
  /** Present for Wayback captures: which historical capture was archived. */
  snapshot?: { snapshotAt: string; wayback: WaybackProvenance };
}

export interface WaybackProvenance {
  /** The capture Wayback actually served, 14 digits (nearest to the request). */
  timestamp: string;
  /** What was asked for — a partial stamp, "latest", or the URL's own stamp. */
  requested: string;
  /** Human-facing replay URL of the served capture. */
  url: string;
}

/**
 * The archive is written as UTF-8 whatever the page was served as, so its
 * charset declaration must say so — a surviving `<meta charset="EUC-JP">` (or
 * `http-equiv="Content-Type"` with a charset) makes the browser decode our
 * UTF-8 bytes as EUC-JP and mojibake the whole page. Replace any declaration
 * with a single `<meta charset="utf-8">` at the top of <head>, and add one
 * when the page declared nothing (browsers default undeclared file:// pages
 * to windows-1252).
 */
/** keep-js renders run exactly the code the archive will replay (see stripTrackers). */
function trackerStripper(log: (m: string) => void): (html: string) => string {
  return (html) => {
    const r = stripTrackers(html);
    if (r.removed) log(`      [keep-js] ${r.removed} tracker script(s) removed before the render`);
    return r.html;
  };
}

function declareUtf8($: CheerioAPI): void {
  $("meta[charset]").remove();
  $("meta[http-equiv]").each((_, el) => {
    if (/^content-type$/i.test($(el).attr("http-equiv") ?? "")) $(el).remove();
  });
  const head = $("head");
  if (head.length) head.prepend('<meta charset="utf-8">');
  else $.root().prepend('<meta charset="utf-8">');
}

/** Create a same-filesystem staging dir under `outRoot` to build a snapshot in. */
function makeStagingDir(outRoot: string): string {
  fs.mkdirSync(outRoot, { recursive: true });
  return fs.mkdtempSync(path.join(outRoot, ".amber-tmp-"));
}

/**
 * Decide the cleanup plan for a captured page: replay a saved file, ask
 * Claude, or fall back to heuristics. Judged on the raw pre-capture HTML, so
 * nothing depends on rewritten paths — and it happens BEFORE assets download,
 * so junk-only bytes are never fetched. Shared by both entry points; hoisted
 * out of finishArchive so archiveUrl can act on `plan.preserveRuntime` (the
 * keep-js escalation) before committing to a capture mode.
 */
async function resolvePlan(
  rawHtml: string,
  url: string,
  $: CheerioAPI,
  opts: { useLLM: boolean; planPath?: string; model: string; verbose: boolean; outRoot?: string },
): Promise<CleanupPlan> {
  const log = (m: string) => opts.verbose && console.log(m);
  if (opts.planPath) {
    log(`[2/4] Loading cleanup plan from ${opts.planPath}`);
    return parsePlan(JSON.parse(fs.readFileSync(opts.planPath, "utf8")));
  }
  if (opts.useLLM && !process.env.ANTHROPIC_API_KEY) {
    log("[2/4] No ANTHROPIC_API_KEY set — using the heuristic plan (set a key for Claude-judged cleaning)");
    return heuristicPlan($);
  }
  if (opts.useLLM) {
    log("[2/4] Asking Claude for a cleanup plan");
    try {
      // Tag convergence: hand the planner the library's current vocabulary and
      // any owner-written guidance, so new tags file into the existing system.
      let existingTags: string[] = [];
      try {
        existingTags = opts.outRoot ? libraryTags(opts.outRoot) : [];
      } catch {
        /* unreadable library — tag without vocabulary */
      }
      return await llmPlan(rawHtml, url, opts.model, undefined, { existingTags });
    } catch (err) {
      log(`      LLM plan failed (${err}); falling back to heuristics`);
      return heuristicPlan($);
    }
  }
  log("[2/4] Building heuristic cleanup plan (no LLM)");
  return heuristicPlan($);
}

export async function archiveUrl(url: string, opts: ArchiveOptions): Promise<ArchiveResult> {
  const log = (m: string) => opts.verbose && console.log(m);

  // A Wayback URL, or --at, means "this page as it was": the archive is filed
  // under the ORIGINAL url (one slug, one timeline) and dated by the snapshot.
  let wayback: WaybackRef | null = parseWaybackUrl(url, opts.wayback?.base);
  if (!wayback && /^https?:\/\/web\.archive\.org\//i.test(url)) {
    throw new AmberError(
      `${url} doesn't name a single capture (a calendar or wildcard view?) — open one capture and use its URL, or run --at <date> against the original URL`,
    );
  }
  if (opts.at !== undefined && !opts.at.trim()) {
    throw new AmberError("--at needs a date (2009, 2009-06, 20090615083000) or latest");
  }
  if (wayback && opts.at) {
    throw new AmberError("--at can't be combined with a Wayback URL — the URL already names a capture");
  }
  if (!wayback && opts.at) {
    // No discovery API: Wayback snaps any stamp to the nearest capture, so
    // "latest" is simply the capture nearest to right now.
    wayback = { timestamp: opts.at === "latest" ? nowTimestamp() : normalizeTimestamp(opts.at), originalUrl: url };
  }
  const target = wayback ? wayback.originalUrl : url;

  const outDir = path.join(opts.outRoot, slugifyUrl(target));
  // Build into staging, then commit; the previous latest stays untouched until
  // the new snapshot is fully built.
  const staging = makeStagingDir(opts.outRoot);

  try {
    if (wayback) return await archiveWayback(wayback, opts.at ?? wayback.timestamp, outDir, staging, opts);

    // 1. Capture page + assets. The default "auto" backend fetches statically
    // first and only boots Chromium when the page looks client-rendered, so a
    // plain server-rendered page never pays the browser cost.
    let keepJs = opts.keepJs ?? false;
    let thumbnail: Buffer | null = null;
    let cap = new Capturer(staging, {
      timeoutMs: opts.timeoutMs,
      insecureTLS: opts.insecureTLS,
      keepScripts: keepJs,
    });
    const render = async () => {
      const r = await renderPage(url, {
        timeoutMs: opts.timeoutMs,
        insecureTLS: opts.insecureTLS,
        deterministicRandom: keepJs,
        transformDocument: keepJs ? trackerStripper(log) : undefined,
      });
      thumbnail = r.thumbnail ?? null;
      cap.loadRender(r);
    };
    let usedBackend: "fetch" | "playwright" = "fetch";

    // keep-js needs the render's recorded responses (for bundling and the
    // replay map) — a static fetch has neither, so the browser is mandatory.
    const backend = keepJs ? "playwright" : opts.backend;
    if (backend !== opts.backend) log(`[keep-js] forcing the Playwright backend`);

    if (backend === "playwright") {
      log(`[1/4] Rendering ${url} in headless Chromium`);
      await render();
      usedBackend = "playwright";
    } else if (backend === "fetch") {
      log(`[1/4] Fetching ${url} (static)`);
      await cap.fetchPage(url);
    } else {
      log(`[1/4] Fetching ${url} (static probe)`);
      // Escalate to a browser render when the static capture either under-renders
      // (client-rendered page) or fails outright (e.g. a 403 to a bot-blocking
      // server that a real browser would pass).
      let escalateReason: string | null = null;
      try {
        await cap.fetchPage(url);
        const verdict = assessRendering(cap.$);
        if (verdict.escalate) escalateReason = verdict.reason;
        else log(`      ${verdict.reason}`);
      } catch (err) {
        escalateReason = `static fetch failed (${err})`;
      }
      if (escalateReason) {
        log(`      ${escalateReason} -> re-capturing in headless Chromium`);
        try {
          await render();
          usedBackend = "playwright";
        } catch (err) {
          // If the static fetch also failed we have nothing to package — surface
          // the render error rather than continuing with an empty capture.
          if (!cap.$) throw err;
          const why = (err instanceof Error ? err.message : String(err)).split("\n")[0];
          log(`      browser render unavailable (${why}); keeping the static capture`);
        }
      }
    }

    // 2. Judgement, up front so it can change the capture mode: when Claude
    // marks the page as needing its runtime (preserveRuntime) and keep-js
    // wasn't forced either way, re-capture in keep-js mode — the initial
    // render lacks the deterministic-random seed and dense scroll that make
    // the recorded session replayable.
    const plan = await resolvePlan(cap.$.html(), url, cap.$, opts);
    // (an explicit --static forbids the browser, so no escalation there)
    if (!keepJs && plan.preserveRuntime && opts.keepJs === undefined && (opts.autoKeepJs ?? true) && opts.backend !== "fetch") {
      if (!(await keepJsAvailable())) {
        log(`      plan says this page needs its runtime, but esbuild isn't installed — static archive (npm i -g esbuild)`);
      } else {
        log(`      [keep-js] plan says this page needs its runtime — re-capturing in keep-js mode`);
        const priorBackend = usedBackend;
        try {
          keepJs = true;
          cap = new Capturer(staging, { timeoutMs: opts.timeoutMs, insecureTLS: opts.insecureTLS, keepScripts: true });
          await render();
          usedBackend = "playwright";
        } catch (err) {
          // Playwright missing or the render died — redo the capture the way
          // that already worked and ship a normal static archive.
          const why = (err instanceof Error ? err.message : String(err)).split("\n")[0];
          log(`      keep-js render unavailable (${why}); keeping the static archive`);
          keepJs = false;
          cap = new Capturer(staging, { timeoutMs: opts.timeoutMs, insecureTLS: opts.insecureTLS });
          if (priorBackend === "fetch") await cap.fetchPage(url);
          else await render();
        }
      }
    }

    return await finishArchive(cap, url, outDir, { backend: usedBackend, backendMode: opts.backend }, { ...opts, keepJs, thumbnail }, plan);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/**
 * The Wayback capture path: fetch the historical page's ORIGINAL bytes (the
 * `id_` raw modifier — no toolbar, no rewriting), route every asset download
 * through Wayback at that timestamp, and run the ordinary plan → clean →
 * package stages. Static by default; with keep-js (forced, or the plan's
 * preserveRuntime verdict) the page is instead rendered in Chromium at its
 * ORIGINAL url with every request the browser makes answered from Wayback —
 * so the era's JavaScript runs against the era's assets and the recording
 * feeds the normal keep-js machinery in the original URL space.
 */
async function archiveWayback(
  ref: WaybackRef,
  requested: string,
  outDir: string,
  staging: string,
  opts: ArchiveOptions,
): Promise<ArchiveResult> {
  const log = (m: string) => opts.verbose && console.log(m);
  const base = opts.wayback?.base;

  const asked = requested === "latest" ? "most recent capture" : `as of ${formatTimestamp(ref.timestamp)}`;
  log(`[1/4] Fetching ${ref.originalUrl} from the Wayback Machine (${asked}, raw capture)`);
  const page = await fetchWaybackPage(ref, { base });
  // Wayback snaps to the nearest capture with no distance limit — say what it
  // actually served, since months (or years) of drift is normal for quiet URLs.
  if (page.timestamp !== ref.timestamp || requested === "latest") log(`      capture served: ${formatTimestamp(page.timestamp)}`);
  if (page.originalUrl !== ref.originalUrl) log(`      served as: ${page.originalUrl}`);

  const delayMs = opts.wayback?.requestDelayMs ?? WAYBACK_REQUEST_DELAY_MS;
  const capturerOpts = {
    timeoutMs: opts.timeoutMs,
    insecureTLS: opts.insecureTLS,
    // Every asset the page references is fetched through Wayback at the
    // page's timestamp; Wayback snaps each to its nearest capture. Names and
    // manifest entries stay keyed by the original URLs.
    resolveUrl: waybackResolver(page.timestamp, base),
    userAgent: WAYBACK_USER_AGENT,
    requestDelayMs: delayMs,
    retry: WAYBACK_RETRY,
  };
  let cap = new Capturer(staging, capturerOpts);
  cap.loadRender({ html: page.html, finalUrl: page.originalUrl, baseUrl: page.originalUrl, resources: new Map() });

  const plan = await resolvePlan(cap.$.html(), page.originalUrl, cap.$, opts);
  const snapshot = {
    snapshotAt: page.snapshotAt,
    wayback: { timestamp: page.timestamp, requested, url: waybackViewUrl(page.timestamp, page.originalUrl, base) },
  };

  // keep-js for a historical page: same decision rule as the live path.
  let keepJs = opts.keepJs === true || (opts.keepJs === undefined && (opts.autoKeepJs ?? true) && plan.preserveRuntime);
  let thumbnail: Buffer | null = null;
  if (keepJs && !(await keepJsAvailable())) {
    log("      plan says this page needs its runtime, but esbuild isn't installed — static archive (npm i -g esbuild)");
    keepJs = false;
  }
  if (keepJs) {
    log(`      [keep-js] rendering ${page.originalUrl} in headless Chromium with every request served from the Wayback Machine`);
    log("      (sequential, spaced fetches — this can take a few minutes for an asset-heavy page)");
    let served = 0;
    const fulfill = waybackFulfiller(page.timestamp, {
      base,
      delayMs,
      seed: new Map([[page.originalUrl, { status: 200, contentType: page.contentType, body: page.body }]]),
      onFetch: () => {
        served++;
        if (served % 25 === 0) log(`      ${served} requests served from the archive so far`);
      },
    });
    try {
      const r = await renderPage(page.originalUrl, {
        // Every request is a spaced archive fetch: give the render room.
        timeoutMs: Math.max(opts.timeoutMs, 10 * 60_000),
        insecureTLS: opts.insecureTLS,
        deterministicRandom: true,
        fulfill,
        transformDocument: trackerStripper(log),
      });
      thumbnail = r.thumbnail ?? null;
      cap = new Capturer(staging, { ...capturerOpts, keepScripts: true });
      cap.loadRender(r);
      log(`      ${served} request(s) served from the archive during the render`);
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).split("\n")[0];
      log(`      keep-js render unavailable (${why}); archiving statically`);
      keepJs = false;
    }
  }

  return await finishArchive(
    cap,
    page.originalUrl,
    outDir,
    { backend: keepJs ? "wayback-render" : "wayback", backendMode: opts.backend },
    { ...opts, keepJs, thumbnail, snapshot }, // null thumbnail -> finishArchive screenshots the reconstruction
    plan,
  );
}

/** A DOM already captured by something other than amber (e.g. a browser extension). */
export interface DomCapture {
  url: string;
  /** Rendered HTML (e.g. `document.documentElement.outerHTML`). */
  html: string;
  /** Optional asset bytes the capturer already downloaded, keyed by absolute URL. */
  resources?: Array<{ url: string; contentType: string; bodyBase64: string }>;
}

export interface DomArchiveOptions {
  outRoot: string;
  useLLM: boolean;
  planPath?: string;
  model: string;
  verbose: boolean;
  insecureTLS: boolean;
  /** Replace the latest snapshot in place instead of keeping history. */
  overwrite?: boolean;
}

/**
 * Archive a page whose DOM was captured elsewhere — the browser extension's
 * path. The extension's own tab is the render backend (JS already ran, the
 * user's session applied), so there is no Playwright step; amber just fetches
 * any assets the payload didn't include, then runs the same plan→clean→package
 * stages as the CLI.
 */
export async function archiveFromDom(capture: DomCapture, opts: DomArchiveOptions): Promise<ArchiveResult> {
  const { url, html } = capture;

  // The extension on a Wayback page: the DOM it sends is Wayback's rewritten
  // replay (toolbar, wombat.js, rerouted URLs) — the wrong thing to keep, and
  // nothing on a Wayback page needs the browser's session. Hand the URL to the
  // Wayback capture path instead; it refetches the original bytes.
  if (parseWaybackUrl(url)) {
    return archiveUrl(url, { ...opts, backend: "fetch", timeoutMs: 45000 });
  }

  const outDir = path.join(opts.outRoot, slugifyUrl(url));
  const staging = makeStagingDir(opts.outRoot);

  try {
    const resources = new Map<string, { contentType: string; body: Buffer }>();
    for (const r of capture.resources ?? []) {
      resources.set(r.url.split("#")[0]!, { contentType: r.contentType, body: Buffer.from(r.bodyBase64, "base64") });
    }

    const cap = new Capturer(staging, { timeoutMs: 45000, insecureTLS: opts.insecureTLS });
    cap.loadRender({ html, finalUrl: url, baseUrl: url, resources });

    const plan = await resolvePlan(cap.$.html(), url, cap.$, opts);
    if (plan.preserveRuntime) {
      // The extension path has no recorded network session to replay, so
      // keep-js isn't available here — note it and archive statically.
      if (opts.verbose) console.log("      plan says this page needs its runtime — keep-js needs the CLI (amber --keep-js <url>)");
    }
    return await finishArchive(cap, url, outDir, { backend: "extension", backendMode: "dom" }, opts, plan);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Shared tail of every backend: snapshot the original HTML, download & localise
 * assets, apply the (already decided) cleanup plan, then write the archive
 * folder. `cap` must already be loaded (fetched, rendered, or fed a DOM), and
 * `plan` already resolved (see resolvePlan — it runs first so its
 * preserveRuntime judgement can change the capture mode).
 */
async function finishArchive(
  cap: Capturer,
  url: string,
  outDir: string,
  provenance: { backend: string; backendMode: string },
  opts: {
    useLLM: boolean;
    planPath?: string;
    model: string;
    verbose: boolean;
    overwrite?: boolean;
    keepJs?: boolean;
    /** Viewport screenshot from the live render, when a browser was used. */
    thumbnail?: Buffer | null;
    /** Wayback captures: the historical moment this snapshot is FROM. */
    snapshot?: { snapshotAt: string; wayback: WaybackProvenance };
  },
  plan: CleanupPlan,
): Promise<ArchiveResult> {
  const log = (m: string) => opts.verbose && console.log(m);
  const staging = cap.rootDir; // the snapshot is built here, then committed to outDir

  fs.writeFileSync(path.join(staging, "plan.json"), JSON.stringify(plan, null, 2));

  // Remove junk before downloading, protecting the plan's media embeds so a
  // broad junk selector can't delete them ahead of the swap (the same guarantee
  // applyPlan's swap-first ordering gives).
  log("[3/4] Removing junk, then downloading assets and rewriting references");
  // keep-js: selector-based junk removal is skipped — the preserved app code
  // may bind to ANY node at init (a removed newsletter form crashed a real
  // site's boot), and a living archive aims for fidelity anyway. Tracker
  // scripts are still removed by applyKeepJs's classifier.
  const junk = opts.keepJs
    ? { removed: 0, removeErrors: [] as string[] }
    : removeJunk(cap.$, plan, mediaTargets(cap.$, plan));
  const stripped = stripStatic(cap.$, { keepJs: opts.keepJs });
  declareUtf8(cap.$);

  // keep-js: classify/flatten/replay before captureAssets, so the surviving
  // classic script tags (and nothing amber injected) get localised with the
  // rest of the DOM.
  let keepJsReport: KeepJsReport | null = null;
  if (opts.keepJs) {
    keepJsReport = await applyKeepJs(cap.$, {
      pageUrl: cap.finalUrl,
      resources: cap.prefetchedResources,
      rootDir: staging,
      log,
    });
    log(
      `      [keep-js] ${keepJsReport.modulesBundled + keepJsReport.inlineModulesBundled} module(s) bundled, ` +
        `${keepJsReport.classicKept} classic kept, ${keepJsReport.trackersRemoved} tracker(s) removed, ` +
        `${keepJsReport.replayEntries} replay entrie(s)`,
    );
    for (const w of keepJsReport.warnings) log(`      [keep-js] warning: ${w}`);
  }

  await cap.captureAssets();

  // The DOM-referenced asset set (pre-runtime-injection) — the stable half of
  // the keep-js content hash.
  const domAssetPaths = cap.assets.filter((a) => a.ok && a.localPath).map((a) => a.localPath);

  // keep-js second pass: localise resources only reachable through
  // JS-constructed URLs, and embed the url->local map for the shim.
  if (keepJsReport) {
    await injectRuntimeAssets(cap.$, cap, cap.prefetchedResources, keepJsReport);
    log(`      [keep-js] ${keepJsReport.runtimeAssets} runtime-loaded asset(s) localised`);
    // Back to the top of <head>, ahead of the injected blobs: the browser's
    // charset prescan only reads the first 1024 bytes.
    declareUtf8(cap.$);
  }
  log(`      removed ${junk.removed + stripped} elements; ${cap.assets.length} assets, ${cap.errors.length} errors`);

  // Swap embedded media last — it downloads via yt-dlp straight into assets/,
  // and the local refs it writes must not pass through captureAssets.
  log("[4/4] Downloading embedded media");
  const media = await swapMedia(cap.$, plan, staging);
  log(`      ${media.length} media item(s)`);

  // keep-js delivery: collapse to a single self-contained index.html (data:
  // URIs are same-origin, so WebGL/canvas survive a double-clicked file://
  // open), or — past the inline cap — keep the folder and add a launcher.
  // The stable content hash is taken FIRST: it reads asset bytes the
  // single-file inliner is about to delete.
  let stableHash: string | null = null;
  if (keepJsReport) {
    stableHash = keepJsContentHash(cap.$, staging, domAssetPaths);
    finalizeKeepJsDelivery(cap.$, staging, keepJsReport);
    log(
      keepJsReport.singleFile
        ? `      [keep-js] single-file archive — ${Math.round(keepJsReport.inlinedBytes / 1024 / 1024)}MB of assets inlined into index.html`
        : `      [keep-js] assets exceed the inline cap — kept folder layout and wrote "View archive.command"`,
    );
  }
  const cleanReport: CleanReport = {
    removed: junk.removed + stripped,
    removeErrors: junk.removeErrors,
    media,
  };

  // Write final HTML, then hash the content (HTML + assets) for change
  // detection. Single-file keep-js already streamed index.html to disk (the
  // in-memory DOM holds placeholder tokens, not the payloads) — don't clobber.
  if (!keepJsReport?.singleFile) {
    fs.writeFileSync(path.join(staging, "index.html"), cap.$.html());
  }

  // Library thumbnail: the live render's viewport when a browser was used,
  // else a screenshot of the just-built archive itself (skipped silently
  // without Playwright). Excluded from the content hash — screenshot bytes
  // vary per render and must not defeat dedupe.
  const thumb = opts.thumbnail ?? (await thumbnailFromFile(path.join(staging, "index.html")));
  if (thumb) fs.writeFileSync(path.join(staging, "thumbnail.jpg"), thumb);

  const contentHash = stableHash ?? hashSnapshotContent(staging);
  const manifest = {
    sourceUrl: url,
    finalUrl: cap.finalUrl,
    capturedAt: new Date().toISOString(),
    // Wayback: the snapshot's own moment is the archive's effective date (see
    // snapshot.ts); capturedAt above stays the honest run time.
    ...(opts.snapshot ? { snapshotAt: opts.snapshot.snapshotAt, wayback: opts.snapshot.wayback } : {}),
    contentHash,
    backend: provenance.backend,
    backendMode: provenance.backendMode,
    title: plan.title,
    tags: plan.tags,
    planSource: plan.source,
    assets: cap.assets.map((a) => ({ url: a.url, localPath: a.localPath, ok: a.ok, note: a.note })),
    assetErrors: cap.errors,
    cleanReport,
    ...(keepJsReport ? { keepJs: keepJsReport } : {}),
  };
  fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Commit: rotate the previous latest into versions/, or skip if unchanged.
  const commit = commitSnapshot(staging, outDir, { overwrite: opts.overwrite });
  if (!commit.changed) log(`Unchanged — kept existing snapshot at ${outDir}`);
  else if (commit.filedAs) log(`Done -> ${path.join(commit.filedAs, "index.html")} (older than the current latest — filed as a version)`);
  else if (commit.archivedTo) log(`Done -> ${path.join(outDir, "index.html")} (previous archived to ${commit.archivedTo})`);
  else log(`Done -> ${path.join(outDir, "index.html")}`);

  // Refresh the browsable library index at the archive root. Derived entirely
  // from the manifests on disk, so a failure here never costs an archive.
  try {
    const n = updateLibraryIndex(path.dirname(outDir));
    log(`      library index updated (${n} page${n === 1 ? "" : "s"})`);
  } catch (err) {
    log(`      library index update failed: ${err}`);
  }

  return {
    outDir,
    plan,
    assetCount: cap.assets.length,
    assetErrors: cap.errors.length,
    cleanReport,
    changed: commit.changed,
    archivedTo: commit.archivedTo,
    filedAs: commit.filedAs,
    ...(keepJsReport ? { keepJs: keepJsReport } : {}),
    ...(opts.snapshot ? { snapshot: opts.snapshot } : {}),
  };
}
