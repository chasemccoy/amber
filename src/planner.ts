/**
 * The judgement half: decide what is junk and what is real, embeddable media.
 *
 *  - heuristicPlan: no LLM. Strips obvious junk (scripts, iframes, and elements
 *    whose id/class match common ad/cookie/newsletter patterns). The floor.
 *  - llmPlan: asks claude-sonnet-4-6 to read the page and return a structured
 *    cleanup plan — main content, junk selectors, and embedded media to download.
 *    This is the judgement a human archivist would otherwise apply by hand.
 */

import type { CheerioAPI } from "cheerio";
import { z } from "zod";
import type { CleanupPlan, MediaEmbed } from "./types.js";

// id/class substrings that almost always mark junk. Conservative on purpose;
// the LLM plan is where nuance lives.
const JUNK_PATTERNS = [
  "cookie", "consent", "gdpr", "newsletter", "signup", "sign-up", "subscribe",
  "advert", "ad-", "-ad", "ads-", "-ads", "adslot", "sponsor", "promo", "popup", "modal",
  "paywall", "social-share", "share-bar", "related-posts", "recommend",
  "onetrust", "cmp", "banner-cookie", "notification-bar",
];

export function heuristicPlan($: CheerioAPI): CleanupPlan {
  const selectors = ["script", "noscript", "iframe", "link[rel=preconnect]", "link[rel=dns-prefetch]"];
  const seen = new Set(selectors);

  $("*").each((_, el) => {
    if (el.type !== "tag") return;
    const id = el.attribs?.["id"] ?? "";
    const cls = el.attribs?.["class"] ?? "";
    const ident = `${id} ${cls}`.toLowerCase();
    if (!ident.trim()) return;
    if (JUNK_PATTERNS.some((p) => ident.includes(p))) {
      const sel = id ? `#${id}` : cls ? `${el.name}.${cls.trim().split(/\s+/).join(".")}` : null;
      if (sel && !seen.has(sel)) {
        seen.add(sel);
        selectors.push(sel);
      }
    }
  });

  return {
    title: $("title").first().text().trim(),
    mainContentSelector: null,
    removeSelectors: selectors,
    media: [],
    tags: heuristicTags($),
    preserveRuntime: false, // needs judgement — only the LLM plan sets this
    notes:
      "Heuristic plan: stripped scripts/iframes and elements whose id/class match common ad/cookie/newsletter patterns.",
    source: "heuristic",
  };
}

/**
 * Without an LLM there is no reading-the-content, so the best we can do is reuse
 * what the page already declared: <meta keywords> and Open Graph article tags.
 * Often absent or spammy — which is exactly the gap the LLM tagging closes.
 */
function heuristicTags($: CheerioAPI): string[] {
  const raw: string[] = [];
  const keywords = $('meta[name="keywords"], meta[name="news_keywords"]').attr("content");
  if (keywords) raw.push(...keywords.split(","));
  $('meta[property="article:tag"]').each((_, el) => {
    const c = $(el).attr("content");
    if (c) raw.push(c);
  });
  return normalizeTags(raw).slice(0, 7);
}

const SYSTEM = `You are an expert web archivist. You are given the HTML of a single \
web page that someone wants to save for permanent, offline, personal archival. \
Your job is the judgement a human archivist would apply by hand.

1. MAIN CONTENT — identify the article/post/page body worth keeping (give a selector).

2. REMOVE only genuine junk — things that are advertising, tracking, or live-server \
cruft, not part of the page's real content:
   - ads and sponsored slots
   - cookie / consent / GDPR banners and their overlays and modals
   - newsletter / subscribe popups and signup forms
   - social-share bars and comment widgets (Disqus, etc.)
   - third-party content-recommendation / "around the web" / sponsored-content \
widgets (Taboola/Outbrain-style), and large grids of unrelated promoted links
   - login / signup modals and paywall gates
   - tracking / analytics scripts and time-sensitive notification bars
   - anything that only works against a live server

3. KEEP the page's own structure and first-party navigation — a faithful archive \
looks like the original. Do NOT remove the site header, primary navigation, or \
footer wholesale, and do NOT remove bylines, dates, figure captions, or \
copyright/attribution. Crucially, KEEP the site's own editorial navigation — \
next/previous-article teasers and "more from this author/section" links, including \
their thumbnail images; these are part of the page, not junk. If one of these \
regions contains a junk widget (e.g. a newsletter form inside the footer), remove \
that specific child, not the whole region.

4. EMBEDDED MEDIA — identify embeds whose real source should be downloaded instead \
of the embed (videos: YouTube/Vimeo; audio players). For each, give a CSS selector \
for the embed element and the canonical source URL a downloader (yt-dlp) can fetch \
(e.g. the https://www.youtube.com/watch?v=... URL).

5. TAGS — read the actual content and give 3-7 topical tags describing its subject \
matter, so the saved page can be browsed and searched later. Tags should be \
lowercase, specific to what the page is about (people, technologies, fields, \
events, concepts), and concise (one to three words). Use the real topics, not \
generic words like "article", "blog", "website", or the site's name.

6. RUNTIME (preserveRuntime) — decide whether the page's PRESENTATION needs its \
JavaScript running at view time. Most pages (articles, docs, blogs, news, \
server-rendered sites) read perfectly as static HTML: preserveRuntime=false. Set \
true only when the experience IS the JavaScript — the archive would be blank or \
skeletal without it: canvas/WebGL scenes and shader backgrounds, scroll-driven \
choreography (GSAP/Lenis/three.js-style), pages whose body is an empty SPA mount \
filled entirely by a JS bundle, or interactive/media work with no static \
fallback. Signals in raw HTML: <canvas> elements, a near-empty <body> with one \
large module bundle, animation-library scripts paired with little static text. \
When true the archiver keeps and bundles the page's own scripts (analytics and \
trackers are still removed) — so reserve it for pages that genuinely need it.

Return selectors that are valid CSS and as specific as needed to be unambiguous. \
Prefer ids; otherwise tag + class. Err strongly on the side of keeping: if there \
is any doubt whether something is junk or part of the site's own content or \
navigation, KEEP it — removing too much is worse than leaving a little clutter.`;

const PlanSchema = z.object({
  title: z.string(),
  mainContentSelector: z.string().nullable().describe("CSS selector wrapping the main content, or null"),
  removeSelectors: z.array(z.string()).describe("CSS selectors for junk to delete"),
  media: z
    .array(
      z.object({
        embedSelector: z.string().describe("CSS selector for the embed element in the page"),
        sourceUrl: z.string().describe("Canonical media URL a downloader can fetch"),
        kind: z.enum(["video", "audio"]).default("video"),
        description: z.string().default(""),
      }),
    )
    .describe("Embedded media to download"),
  tags: z
    .array(z.string())
    .describe("3-7 lowercase topical tags describing the page's subject matter (not generic words)"),
  preserveRuntime: z
    .boolean()
    .describe("True ONLY if the page's presentation needs its JS at view time (canvas/WebGL, scroll choreography, JS-only rendering)"),
  notes: z.string().describe("Brief rationale for the human reviewer"),
});

export async function llmPlan(
  html: string,
  url: string,
  model = "claude-sonnet-4-6",
  maxHtmlChars = 400_000,
): Promise<CleanupPlan> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");

  const truncated = html.slice(0, maxHtmlChars);
  const note = html.length <= maxHtmlChars ? "" : `\n\n[HTML truncated to ${maxHtmlChars} chars]`;

  const client = new Anthropic();
  const res = await client.messages.parse({
    model,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    messages: [{ role: "user", content: `Page URL: ${url}\n\nHTML:\n${truncated}${note}` }],
    output_config: { format: zodOutputFormat(PlanSchema) },
  });

  const p = res.parsed_output;
  if (!p) throw new Error("model returned no parseable plan");
  const media: MediaEmbed[] = p.media.map((m) => ({
    embedSelector: m.embedSelector,
    sourceUrl: m.sourceUrl,
    kind: m.kind,
    description: m.description,
  }));
  return {
    title: p.title,
    mainContentSelector: p.mainContentSelector,
    removeSelectors: p.removeSelectors,
    media,
    tags: normalizeTags(p.tags),
    preserveRuntime: p.preserveRuntime,
    notes: p.notes,
    source: "llm",
  };
}

/** Lowercase, trim, drop empties/dupes — shared by the LLM and heuristic plans. */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const tag = t.trim().toLowerCase();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

/**
 * Lenient schema for a plan loaded from disk (`--plan plan.json`). Plans are a
 * first-class, hand-editable artifact, so every field has a sensible default —
 * a partial or slightly malformed file is coerced into a usable plan rather than
 * crashing deep in `applyPlan`.
 */
const StoredPlanSchema = z.object({
  title: z.string().default(""),
  mainContentSelector: z.string().nullable().default(null),
  removeSelectors: z.array(z.string()).default([]),
  media: z
    .array(
      z.object({
        embedSelector: z.string(),
        sourceUrl: z.string(),
        kind: z.enum(["video", "audio"]).default("video"),
        description: z.string().default(""),
      }),
    )
    .default([]),
  tags: z.array(z.string()).default([]),
  preserveRuntime: z.boolean().default(false),
  notes: z.string().default(""),
  source: z.string().default("file"),
});

/** Validate and normalise a plan parsed from JSON (throws ZodError if unusable). */
export function parsePlan(raw: unknown): CleanupPlan {
  const p = StoredPlanSchema.parse(raw);
  return {
    title: p.title,
    mainContentSelector: p.mainContentSelector,
    removeSelectors: p.removeSelectors,
    media: p.media.map((m) => ({
      embedSelector: m.embedSelector,
      sourceUrl: m.sourceUrl,
      kind: m.kind,
      description: m.description,
    })),
    tags: normalizeTags(p.tags),
    preserveRuntime: p.preserveRuntime,
    notes: p.notes,
    source: p.source,
  };
}
