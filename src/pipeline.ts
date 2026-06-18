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
    base = `${u.host}${u.pathname}`.replace(/\/+$/, "") || u.host;
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
  const rawHtml = cap.$.html();
  log("[2/4] Downloading assets and rewriting references");
  await cap.captureAssets();
  log(`      ${cap.assets.length} assets, ${cap.errors.length} errors`);

  // 2. Decide the cleanup plan.
  let plan: CleanupPlan;
  if (opts.planPath) {
    log(`[3/4] Loading cleanup plan from ${opts.planPath}`);
    const loaded = JSON.parse(fs.readFileSync(opts.planPath, "utf8")) as CleanupPlan;
    plan = { ...loaded, source: loaded.source ?? "file" };
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

  // 3. Apply it.
  log("[4/4] Applying plan (removing junk, downloading embedded media)");
  const cleanReport = await applyPlan(cap.$, plan, outDir);
  log(`      removed ${cleanReport.removed} elements; ${cleanReport.media.length} media item(s)`);

  // 4. Write final HTML + manifest.
  fs.writeFileSync(path.join(outDir, "index.html"), cap.$.html());
  const manifest = {
    sourceUrl: url,
    finalUrl: cap.finalUrl,
    backend: usedBackend,
    backendMode: opts.backend,
    title: plan.title,
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
