/**
 * The judgement half: decide what is junk and what is real, embeddable media.
 *
 *  - heuristicPlan: no LLM. Strips obvious junk (scripts, iframes, and elements
 *    whose id/class match common ad/cookie/newsletter patterns). The floor.
 *  - llmPlan: asks claude-opus-4-8 to read the page and return a structured
 *    cleanup plan — main content, junk selectors, and embedded media to download.
 *    This is the part the article does by hand.
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
    notes:
      "Heuristic plan: stripped scripts/iframes and elements whose id/class match common ad/cookie/newsletter patterns.",
    source: "heuristic",
  };
}

const SYSTEM = `You are an expert web archivist. You are given the HTML of a single \
web page that someone wants to save for permanent, offline, personal archival. \
Your job is the judgement a human archivist would apply by hand:

1. Identify the MAIN CONTENT — the article/post/page body worth keeping.
2. Identify JUNK to delete so the saved page is clean and durable: ads, cookie \
and consent banners, newsletter/subscribe popups, social-share bars, tracking \
and analytics scripts, "related/recommended" promo modules, time-sensitive \
notification bars, and anything that depends on a live server.
3. Identify EMBEDDED MEDIA whose real source should be downloaded instead of the \
embed — most importantly videos (YouTube/Vimeo) and audio players. For each, \
give a CSS selector for the embed element and the canonical source URL that a \
downloader (yt-dlp) can fetch (e.g. the https://www.youtube.com/watch?v=... URL).

Return selectors that are valid CSS and as specific as needed to be unambiguous. \
Prefer ids; otherwise tag + class. Be aggressive about junk but never remove the \
main content. If unsure whether something is the main content, keep it.`;

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
  notes: z.string().describe("Brief rationale for the human reviewer"),
});

export async function llmPlan(
  html: string,
  url: string,
  model = "claude-opus-4-8",
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
    notes: p.notes,
    source: "llm",
  };
}
