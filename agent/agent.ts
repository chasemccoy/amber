#!/usr/bin/env -S pnpm exec tsx
/**
 * Local agentic archiver — Claude drives the tools step by step.
 *
 * Meant to run on a machine *you* own: direct network egress, your browser
 * cookies available to yt-dlp, no TLS-intercepting proxy. Instead of one
 * structured-output call that returns a plan, Claude works the way a careful
 * human does by hand — it captures the page, inspects the DOM, decides what to
 * strip, handles embedded media, and finalises — calling real tools at each
 * step via the Anthropic SDK tool runner.
 *
 *   export ANTHROPIC_API_KEY=...
 *   pnpm agent https://example.com/some-post
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { CheerioAPI } from "cheerio";
import { Capturer } from "../src/capture.js";
import { renderPage } from "../src/render.js";
import { downloadMedia, mediaElementHtml } from "../src/media.js";
import { selectTolerant } from "../src/clean.js";
import { normalizeTags } from "../src/planner.js";
import { slugifyUrl } from "../src/pipeline.js";
import { commitSnapshot, hashSnapshotContent } from "../src/snapshot.js";

interface Ctx {
  url: string;
  outDir: string;
  $: CheerioAPI;
  removed: number;
  media: Array<{ sourceUrl: string; ok: boolean; localPath: string | null }>;
  mainSelector: string | null;
  title: string;
  tags: string[];
  finalized: boolean;
}

/** Compact structural view so we don't ship the whole HTML every turn. */
function domOutline($: CheerioAPI, limit = 120): string {
  const skip = new Set(["p", "span", "a", "li", "br", "b", "i", "em", "strong", "code"]);
  const lines: string[] = [];
  const all = $("*").toArray();
  for (const el of all) {
    if (el.type !== "tag" || skip.has(el.name)) continue;
    const id = el.attribs?.["id"] ? `#${el.attribs["id"]}` : "";
    const cls = el.attribs?.["class"] ? `.${el.attribs["class"].trim().split(/\s+/).join(".")}` : "";
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const preview = text.length > 50 ? text.slice(0, 50) + "…" : text;
    lines.push(`<${el.name}${id}${cls}>  ${JSON.stringify(preview)}`);
    if (lines.length >= limit) {
      lines.push(`... (${all.length} elements total, truncated)`);
      break;
    }
  }
  return lines.join("\n");
}

/** Build the tool set bound to one run's context (no shared global state). */
function buildTools(ctx: Ctx) {
  return [
  betaZodTool({
    name: "get_dom_outline",
    description:
      "Return a compact outline of the captured page (tags, ids, classes, text previews). Use this first.",
    inputSchema: z.object({}),
    run: async () => domOutline(ctx.$),
  }),
  betaZodTool({
    name: "inspect",
    description: "Show the full HTML of elements matching a CSS selector, to judge junk vs. main content.",
    inputSchema: z.object({ selector: z.string() }),
    run: async ({ selector }) => {
      const els = ctx.$(selector).toArray();
      if (els.length === 0) return "no matches";
      const out = els.slice(0, 5).map((el) => ctx.$.html(el).slice(0, 1500));
      return `${els.length} match(es). Showing up to 5:\n\n${out.join("\n---\n")}`;
    },
  }),
  betaZodTool({
    name: "list_embeds",
    description: "List embedded media (iframes, <video>, <audio>) with their sources.",
    inputSchema: z.object({}),
    run: async () => {
      const rows = ctx.$("iframe, video, audio, embed")
        .toArray()
        .map((el) => `<${el.name}> src=${JSON.stringify(el.attribs?.["src"] ?? "")}`);
      return rows.length ? rows.join("\n") : "no embeds found";
    },
  }),
  betaZodTool({
    name: "remove",
    description:
      "Delete junk elements (ads, cookie/consent banners, newsletter popups, tracking scripts, share bars). Never remove the main content.",
    inputSchema: z.object({ selectors: z.array(z.string()) }),
    run: async ({ selectors }) => {
      const report: string[] = [];
      for (const sel of selectors) {
        try {
          const m = ctx.$(sel);
          ctx.removed += m.length;
          m.remove();
          report.push(`${sel}: removed ${m.length}`);
        } catch (err) {
          report.push(`${sel}: invalid (${err})`);
        }
      }
      return report.join("\n");
    },
  }),
  betaZodTool({
    name: "download_and_swap",
    description:
      "Download the real media behind an embed (e.g. the YouTube video of a talk) and replace the embed with a local <video>/<audio>.",
    inputSchema: z.object({
      embedSelector: z.string(),
      sourceUrl: z.string(),
      kind: z.enum(["video", "audio"]).default("video"),
    }),
    run: async ({ embedSelector, sourceUrl, kind }) => {
      const res = await downloadMedia(sourceUrl, ctx.outDir, kind);
      ctx.media.push({ sourceUrl, ok: res.ok, localPath: res.localPath });
      if (!res.ok || !res.localPath) return `download failed: ${res.note}`;
      let matched = false;
      try {
        const target = selectTolerant(ctx.$, embedSelector).first();
        matched = target.length > 0;
        if (matched) target.replaceWith(mediaElementHtml(kind, res.localPath));
      } catch {
        /* unparseable selector — file is saved, just not swapped */
      }
      return `downloaded -> ${res.localPath}; ${matched ? `replaced ${embedSelector}` : "selector matched nothing (file saved)"}`;
    },
  }),
  betaZodTool({
    name: "set_main_content",
    description:
      "Record the main-content selector, page title, and 3-7 lowercase topical tags (the page's actual subject matter, not generic words) for the manifest.",
    inputSchema: z.object({
      selector: z.string(),
      title: z.string(),
      tags: z.array(z.string()).default([]),
    }),
    run: async ({ selector, title, tags }) => {
      ctx.mainSelector = selector;
      ctx.title = title;
      ctx.tags = normalizeTags(tags);
      return `noted main content ${selector}, title ${JSON.stringify(title)}, tags [${ctx.tags.join(", ")}]`;
    },
  }),
  betaZodTool({
    name: "finalize",
    description: "Write the finished self-contained archive (index.html + manifest.json). Call this last.",
    inputSchema: z.object({}),
    run: async () => {
      fs.writeFileSync(path.join(ctx.outDir, "index.html"), ctx.$.html());
      const contentHash = hashSnapshotContent(ctx.outDir);
      fs.writeFileSync(
        path.join(ctx.outDir, "manifest.json"),
        JSON.stringify(
          {
            sourceUrl: ctx.url,
            capturedAt: new Date().toISOString(),
            contentHash,
            title: ctx.title,
            tags: ctx.tags,
            mainContentSelector: ctx.mainSelector,
            elementsRemoved: ctx.removed,
            media: ctx.media,
          },
          null,
          2,
        ),
      );
      ctx.finalized = true;
      return `archive written to ${path.join(ctx.outDir, "index.html")}`;
    },
  }),
  ];
}

const SYSTEM = `You are a meticulous web archivist. You save a single web page as a \
permanent, self-contained offline copy, the way a careful human does it by hand.

The page has already been fetched and its assets (CSS, images, fonts) downloaded \
and rewritten to local paths — you do NOT handle assets. Your job is the judgement:

1. Call get_dom_outline to understand the page. inspect anything ambiguous.
2. Identify and remove() genuine junk: ads, cookie/consent banners, \
newsletter/subscribe popups, social-share bars, comment widgets, \
tracking/analytics <script> tags, third-party "around the web"/sponsored \
recommendation widgets, login/signup or paywall modals, time-sensitive \
notification bars, and JS-only widgets that are dead offline. KEEP the page's own \
structure and first-party navigation — do not remove the site header, primary \
nav, or footer wholesale, nor bylines, dates, captions, copyright, or the site's \
own next/previous-article teasers (with their thumbnails); if such a region holds \
a junk widget, remove just that child. Never remove the main content. Err on the \
side of keeping: when in doubt, keep it.
3. list_embeds, and for any real media (a YouTube/Vimeo video of a talk, an audio \
player), call download_and_swap with the canonical source URL.
4. set_main_content with the main selector, title, and 3-7 lowercase topical \
tags describing the page's actual subject matter (technologies, fields, people, \
events, concepts) — not generic words like "article" or the site name.
5. finalize.

Work in that order. Prefer specific selectors (ids, then tag.class).`;

export interface AgentLoopResult {
  toolCalls: Array<{ name: string; input: unknown }>;
  ctx: Ctx;
}

/**
 * Run the agent's tool-driven cleanup loop over an already-captured DOM. Shared
 * by the CLI (which renders first) and the eval harness (which feeds fixture
 * HTML, no browser). Returns the tool calls Claude made — the eval's
 * ToolCallJudge scores those.
 */
export async function runAgentLoop(
  $: CheerioAPI,
  url: string,
  opts: { outDir: string; model?: string; onLog?: (m: string) => void },
): Promise<AgentLoopResult> {
  const ctx: Ctx = { url, outDir: opts.outDir, $, removed: 0, media: [], mainSelector: null, title: "", tags: [], finalized: false };
  const client = new Anthropic();
  const runner = client.beta.messages.toolRunner({
    model: opts.model ?? "claude-sonnet-4-6",
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    tools: buildTools(ctx),
    messages: [{ role: "user", content: `Archive this page: ${url}` }],
  });

  const toolCalls: AgentLoopResult["toolCalls"] = [];
  for await (const message of runner) {
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) opts.onLog?.(`[claude] ${block.text.trim()}`);
      else if (block.type === "tool_use") {
        toolCalls.push({ name: block.name, input: block.input });
        opts.onLog?.(`[tool]   ${block.name}(${JSON.stringify(block.input).slice(0, 120)})`);
      }
    }
    if (ctx.finalized) break;
  }
  return { toolCalls, ctx };
}

export async function runAgent(
  url: string,
  outRoot = "archives",
  model = "claude-sonnet-4-6",
  opts: { overwrite?: boolean } = {},
): Promise<string> {
  const outDir = path.join(outRoot, slugifyUrl(url));
  // Build into staging, then commit (same versioning as the pipeline).
  fs.mkdirSync(outRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(outRoot, ".amber-tmp-"));

  try {
    console.log(`[capture] rendering + localising assets for ${url}`);
    const insecure = process.env.AMBER_INSECURE_TLS === "1";
    const cap = new Capturer(staging, { timeoutMs: 45000, insecureTLS: insecure });
    cap.loadRender(await renderPage(url, { timeoutMs: 45000, insecureTLS: insecure }));
    await cap.captureAssets();
    console.log(`[capture] ${cap.assets.length} assets, ${cap.errors.length} errors`);

    const { ctx } = await runAgentLoop(cap.$, url, { outDir: staging, model, onLog: (m) => console.log(m) });
    if (!ctx.finalized) throw new Error("agent finished without calling finalize — nothing to commit");

    const commit = commitSnapshot(staging, outDir, { overwrite: opts.overwrite });
    if (!commit.changed) console.log(`[done]   unchanged — kept existing snapshot at ${outDir}`);
    else if (commit.archivedTo) console.log(`[done]   ${outDir}/index.html (previous archived to ${commit.archivedTo})`);
    else console.log(`[done]   ${outDir}/index.html`);
    return outDir;
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

// Run as a CLI only when invoked directly (not when imported by the evals).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const overwrite = args.includes("--overwrite");
  const [url, outDir] = args.filter((a) => !a.startsWith("--"));
  if (!url) {
    console.error("usage: pnpm agent [--overwrite] <url> [outDir]");
    process.exit(2);
  }
  runAgent(url, outDir ?? "archives", "claude-sonnet-4-6", { overwrite }).catch((err) => {
    console.error(err?.stack ?? err);
    process.exit(1);
  });
}
