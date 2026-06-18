/** Orchestrate render/fetch -> capture -> plan -> clean -> package. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CheerioAPI } from "cheerio";
import { Capturer } from "./capture.js";
import { renderPage } from "./render.js";
import { heuristicPlan, llmPlan } from "./planner.js";
import { applyPlan, type CleanReport } from "./clean.js";
import type { CleanupPlan, CaptureOptions } from "./types.js";

// Empty-when-JS-hasn't-run mount points for the common SPA frameworks.
const SPA_ROOTS = ["#root", "#app", "#__next", "#__nuxt", "[data-reactroot]"];

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
}

export interface ArchiveResult {
  outDir: string;
  plan: CleanupPlan;
  assetCount: number;
  assetErrors: number;
  cleanReport: CleanReport;
}

export async function archiveUrl(url: string, opts: ArchiveOptions): Promise<ArchiveResult> {
  const log = (m: string) => opts.verbose && console.log(m);
  const outDir = path.join(opts.outRoot, slugifyUrl(url));
  fs.mkdirSync(outDir, { recursive: true });

  // 1. Capture page + assets. The default "auto" backend fetches statically
  // first and only boots Chromium when the page looks client-rendered, so a
  // plain server-rendered page never pays the browser cost.
  const cap = new Capturer(outDir, { timeoutMs: opts.timeoutMs, insecureTLS: opts.insecureTLS });
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
    await cap.fetchPage(url);
    const verdict = assessRendering(cap.$);
    if (verdict.escalate) {
      log(`      ${verdict.reason} -> re-capturing in headless Chromium`);
      try {
        await render();
        usedBackend = "playwright";
      } catch (err) {
        log(`      browser render unavailable (${err}); keeping the static capture`);
      }
    } else {
      log(`      ${verdict.reason}`);
    }
  }

  return finishArchive(cap, url, outDir, { backend: usedBackend, backendMode: opts.backend }, opts);
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
  fs.mkdirSync(outDir, { recursive: true });

  const resources = new Map<string, { contentType: string; body: Buffer }>();
  for (const r of capture.resources ?? []) {
    resources.set(r.url.split("#")[0]!, { contentType: r.contentType, body: Buffer.from(r.bodyBase64, "base64") });
  }

  const cap = new Capturer(outDir, { timeoutMs: 45000, insecureTLS: opts.insecureTLS });
  cap.loadRender({ html, finalUrl: url, baseUrl: url, resources });

  return finishArchive(cap, url, outDir, { backend: "extension", backendMode: "dom" }, opts);
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
  opts: { useLLM: boolean; planPath?: string; model: string; verbose: boolean },
): Promise<ArchiveResult> {
  const log = (m: string) => opts.verbose && console.log(m);

  const rawHtml = cap.$.html();
  log("[2/4] Downloading assets and rewriting references");
  await cap.captureAssets();
  log(`      ${cap.assets.length} assets, ${cap.errors.length} errors`);

  // Decide the cleanup plan.
  let plan: CleanupPlan;
  if (opts.planPath) {
    log(`[3/4] Loading cleanup plan from ${opts.planPath}`);
    const loaded = JSON.parse(fs.readFileSync(opts.planPath, "utf8")) as CleanupPlan;
    plan = { ...loaded, tags: loaded.tags ?? [], source: loaded.source ?? "file" };
  } else if (opts.useLLM && !process.env.ANTHROPIC_API_KEY) {
    log("[3/4] No ANTHROPIC_API_KEY set — using the heuristic plan");
    plan = heuristicPlan(cap.$);
  } else if (opts.useLLM) {
    log("[3/4] Asking Claude for a cleanup plan");
    try {
      plan = await llmPlan(rawHtml, url, opts.model);
    } catch (err) {
      log(`      LLM plan failed (${err}); falling back to heuristics`);
      plan = heuristicPlan(cap.$);
    }
  } else {
    log("[3/4] Building heuristic cleanup plan (no LLM)");
    plan = heuristicPlan(cap.$);
  }
  fs.writeFileSync(path.join(outDir, "plan.json"), JSON.stringify(plan, null, 2));

  // Apply it.
  log("[4/4] Applying plan (removing junk, downloading embedded media)");
  const cleanReport = await applyPlan(cap.$, plan, outDir);
  log(`      removed ${cleanReport.removed} elements; ${cleanReport.media.length} media item(s)`);

  // Write final HTML + manifest.
  fs.writeFileSync(path.join(outDir, "index.html"), cap.$.html());
  const manifest = {
    sourceUrl: url,
    finalUrl: cap.finalUrl,
    backend: provenance.backend,
    backendMode: provenance.backendMode,
    title: plan.title,
    tags: plan.tags,
    planSource: plan.source,
    assets: cap.assets.map((a) => ({ url: a.url, localPath: a.localPath, ok: a.ok, note: a.note })),
    assetErrors: cap.errors,
    cleanReport,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  log(`Done -> ${path.join(outDir, "index.html")}`);
  return {
    outDir,
    plan,
    assetCount: cap.assets.length,
    assetErrors: cap.errors.length,
    cleanReport,
  };
}
