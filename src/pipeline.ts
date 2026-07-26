/** Orchestrate render/fetch -> capture -> plan -> clean -> package. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CheerioAPI } from "cheerio";
import { Capturer } from "./capture.js";
import { renderPage } from "./render.js";
import { heuristicPlan, llmPlan, parsePlan } from "./planner.js";
import { mediaTargets, removeJunk, stripStatic, swapMedia, type CleanReport } from "./clean.js";
import { commitSnapshot, hashSnapshotContent } from "./snapshot.js";
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

export function slugifyUrl(url: string): string {
  let base: string;
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, "");
    base = `${host}${u.pathname}`.replace(/\/+$/, "") || host;
  } catch {
    base = url;
  }
  return (base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "archive").slice(0, 80);
}

export interface ArchiveOptions extends CaptureOptions {
  outRoot: string;
  useLLM: boolean;
  planPath?: string;
  model: string;
  verbose: boolean;
  /** Replace the latest snapshot in place instead of keeping history. */
  overwrite?: boolean;
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
}

/** Create a same-filesystem staging dir under `outRoot` to build a snapshot in. */
function makeStagingDir(outRoot: string): string {
  fs.mkdirSync(outRoot, { recursive: true });
  return fs.mkdtempSync(path.join(outRoot, ".amber-tmp-"));
}

export async function archiveUrl(url: string, opts: ArchiveOptions): Promise<ArchiveResult> {
  const log = (m: string) => opts.verbose && console.log(m);
  const outDir = path.join(opts.outRoot, slugifyUrl(url));
  // Build into staging, then commit; the previous latest stays untouched until
  // the new snapshot is fully built.
  const staging = makeStagingDir(opts.outRoot);

  try {
    // 1. Capture page + assets. The default "auto" backend fetches statically
    // first and only boots Chromium when the page looks client-rendered, so a
    // plain server-rendered page never pays the browser cost.
    const cap = new Capturer(staging, { timeoutMs: opts.timeoutMs, insecureTLS: opts.insecureTLS });
    const render = async () => {
      const r = await renderPage(url, { timeoutMs: opts.timeoutMs, insecureTLS: opts.insecureTLS });
      cap.loadRender(r);
    };
    let usedBackend: "fetch" | "playwright" = "fetch";

    if (opts.backend === "playwright") {
      log(`[1/4] Rendering ${url} in headless Chromium`);
      await render();
      usedBackend = "playwright";
    } else if (opts.backend === "fetch") {
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

    return await finishArchive(cap, url, outDir, { backend: usedBackend, backendMode: opts.backend }, opts);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
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
  const outDir = path.join(opts.outRoot, slugifyUrl(url));
  const staging = makeStagingDir(opts.outRoot);

  try {
    const resources = new Map<string, { contentType: string; body: Buffer }>();
    for (const r of capture.resources ?? []) {
      resources.set(r.url.split("#")[0]!, { contentType: r.contentType, body: Buffer.from(r.bodyBase64, "base64") });
    }

    const cap = new Capturer(staging, { timeoutMs: 45000, insecureTLS: opts.insecureTLS });
    cap.loadRender({ html, finalUrl: url, baseUrl: url, resources });

    return await finishArchive(cap, url, outDir, { backend: "extension", backendMode: "dom" }, opts);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Shared tail of every backend: snapshot the original HTML, download & localise
 * assets, decide and apply the cleanup plan, then write the archive folder.
 * `cap` must already be loaded (fetched, rendered, or fed a DOM).
 */
async function finishArchive(
  cap: Capturer,
  url: string,
  outDir: string,
  provenance: { backend: string; backendMode: string },
  opts: { useLLM: boolean; planPath?: string; model: string; verbose: boolean; overwrite?: boolean },
): Promise<ArchiveResult> {
  const log = (m: string) => opts.verbose && console.log(m);
  const staging = cap.rootDir; // the snapshot is built here, then committed to outDir

  const rawHtml = cap.$.html();

  // Decide the cleanup plan first — junk is removed *before* assets are
  // downloaded, so bytes referenced only by junk are never fetched and never
  // land in assets/. The LLM judges the raw pre-capture HTML, so nothing here
  // depends on rewritten paths.
  let plan: CleanupPlan;
  if (opts.planPath) {
    log(`[2/4] Loading cleanup plan from ${opts.planPath}`);
    plan = parsePlan(JSON.parse(fs.readFileSync(opts.planPath, "utf8")));
  } else if (opts.useLLM && !process.env.ANTHROPIC_API_KEY) {
    log("[2/4] No ANTHROPIC_API_KEY set — using the heuristic plan (set a key for Claude-judged cleaning)");
    plan = heuristicPlan(cap.$);
  } else if (opts.useLLM) {
    log("[2/4] Asking Claude for a cleanup plan");
    try {
      plan = await llmPlan(rawHtml, url, opts.model);
    } catch (err) {
      log(`      LLM plan failed (${err}); falling back to heuristics`);
      plan = heuristicPlan(cap.$);
    }
  } else {
    log("[2/4] Building heuristic cleanup plan (no LLM)");
    plan = heuristicPlan(cap.$);
  }
  fs.writeFileSync(path.join(staging, "plan.json"), JSON.stringify(plan, null, 2));

  // Remove junk before downloading, protecting the plan's media embeds so a
  // broad junk selector can't delete them ahead of the swap (the same guarantee
  // applyPlan's swap-first ordering gives).
  log("[3/4] Removing junk, then downloading assets and rewriting references");
  const junk = removeJunk(cap.$, plan, mediaTargets(cap.$, plan));
  const stripped = stripStatic(cap.$);
  await cap.captureAssets();
  log(`      removed ${junk.removed + stripped} elements; ${cap.assets.length} assets, ${cap.errors.length} errors`);

  // Swap embedded media last — it downloads via yt-dlp straight into assets/,
  // and the local refs it writes must not pass through captureAssets.
  log("[4/4] Downloading embedded media");
  const media = await swapMedia(cap.$, plan, staging);
  log(`      ${media.length} media item(s)`);
  const cleanReport: CleanReport = {
    removed: junk.removed + stripped,
    removeErrors: junk.removeErrors,
    media,
  };

  // Write final HTML, then hash the content (HTML + assets) for change detection.
  fs.writeFileSync(path.join(staging, "index.html"), cap.$.html());
  const contentHash = hashSnapshotContent(staging);
  const manifest = {
    sourceUrl: url,
    finalUrl: cap.finalUrl,
    capturedAt: new Date().toISOString(),
    contentHash,
    backend: provenance.backend,
    backendMode: provenance.backendMode,
    title: plan.title,
    tags: plan.tags,
    planSource: plan.source,
    assets: cap.assets.map((a) => ({ url: a.url, localPath: a.localPath, ok: a.ok, note: a.note })),
    assetErrors: cap.errors,
    cleanReport,
  };
  fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Commit: rotate the previous latest into versions/, or skip if unchanged.
  const commit = commitSnapshot(staging, outDir, { overwrite: opts.overwrite });
  if (!commit.changed) log(`Unchanged — kept existing snapshot at ${outDir}`);
  else if (commit.archivedTo) log(`Done -> ${path.join(outDir, "index.html")} (previous archived to ${commit.archivedTo})`);
  else log(`Done -> ${path.join(outDir, "index.html")}`);

  return {
    outDir,
    plan,
    assetCount: cap.assets.length,
    assetErrors: cap.errors.length,
    cleanReport,
    changed: commit.changed,
    archivedTo: commit.archivedTo,
  };
}
