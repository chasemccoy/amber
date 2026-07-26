/** Apply a CleanupPlan to captured HTML: swap media, delete junk, add provenance. */

import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { downloadMedia, mediaElementHtml, type MediaResult } from "./media.js";
import type { CleanupPlan } from "./types.js";

export interface CleanReport {
  removed: number;
  removeErrors: string[];
  media: Array<{ sourceUrl: string; ok: boolean; localPath: string | null; note: string }>;
}

export async function applyPlan(
  $: CheerioAPI,
  plan: CleanupPlan,
  rootDir: string,
): Promise<CleanReport> {
  const report: CleanReport = { removed: 0, removeErrors: [], media: [] };

  // 1. Swap embedded media FIRST, so a broad junk selector (e.g. "iframe") in
  //    step 2 can't delete a media embed before we capture it.
  report.media = await swapMedia($, plan, rootDir);

  // 2. Delete junk by selector.
  const junk = removeJunk($, plan);
  report.removed += junk.removed;
  report.removeErrors = junk.removeErrors;

  // 3. Unconditional strips.
  report.removed += stripStatic($);
  return report;
}

/**
 * The embed elements the plan wants swapped for local media. The pipeline
 * removes junk *before* downloading assets (so junk is never fetched), which
 * runs junk removal ahead of the media swap — these nodes are passed as
 * `protect` so a broad junk selector (e.g. "iframe") can't delete an embed
 * before it's swapped. Mirrors applyPlan's swap-first ordering guarantee.
 */
export function mediaTargets($: CheerioAPI, plan: CleanupPlan): Set<AnyNode> {
  const targets = new Set<AnyNode>();
  for (const media of plan.media) {
    try {
      const el = selectTolerant($, media.embedSelector).first().get(0);
      if (el) targets.add(el);
    } catch {
      // Unparseable selector — nothing to protect; the swap will no-op the same way.
    }
  }
  return targets;
}

/** Delete junk by the plan's selectors, skipping any `protect`ed nodes. */
export function removeJunk(
  $: CheerioAPI,
  plan: CleanupPlan,
  protect?: Set<AnyNode>,
): { removed: number; removeErrors: string[] } {
  const report = { removed: 0, removeErrors: [] as string[] };
  for (const sel of plan.removeSelectors) {
    try {
      let matches = selectTolerant($, sel);
      if (protect?.size) matches = matches.filter((_, el) => !protect.has(el));
      report.removed += matches.length;
      matches.remove();
    } catch (err) {
      report.removeErrors.push(`${sel}: ${err}`);
    }
  }
  return report;
}

/**
 * Always strip what a static offline snapshot must never keep, regardless of
 * the plan:
 *   - <script> — they execute and phone home (Twitter widgets, analytics)
 *   - <noscript> fallbacks
 *   - connection hints (<link rel="preconnect"/"dns-prefetch">) — open sockets
 *   - JS-loading hints that fetch modules/scripts over the network:
 *     rel="modulepreload" (SPA bundles, e.g. Shopify/Vite), rel="prefetch",
 *     rel="prerender", and rel="preload" as="script". Since scripts are
 *     stripped, these only ever pull dead bytes from the live host.
 * Also sanitises leftovers (inline on* handlers, javascript: hrefs) and drops
 * comments. Returns the number of elements removed.
 */
export function stripStatic($: CheerioAPI): number {
  const alwaysStrip = $(
    [
      "script",
      "noscript",
      "link[rel~='preconnect']",
      "link[rel~='dns-prefetch']",
      "link[rel~='modulepreload']",
      "link[rel~='prefetch']",
      "link[rel~='prerender']",
      "link[rel~='preload'][as='script']",
    ].join(", "),
  );
  const removed = alwaysStrip.length;
  alwaysStrip.remove();

  // Strip leftovers that survive selector removal: inline on* handlers and
  // dead javascript: hrefs (useless offline anyway).
  $("*").each((_, el) => {
    if (el.type !== "tag") return;
    for (const attr of Object.keys(el.attribs ?? {})) {
      if (attr.toLowerCase().startsWith("on")) $(el).removeAttr(attr);
    }
    const href = el.attribs?.["href"];
    if (href && href.trim().toLowerCase().startsWith("javascript:")) $(el).attr("href", "#");
  });

  // Drop comments. (Provenance is recorded in manifest.json, not injected
  // into the page — the saved HTML stays faithful to the original.)
  $("*")
    .contents()
    .filter((_, n) => n.type === "comment")
    .remove();
  return removed;
}

/** Download the plan's embedded media and swap each embed for a local element. */
export async function swapMedia(
  $: CheerioAPI,
  plan: CleanupPlan,
  rootDir: string,
): Promise<CleanReport["media"]> {
  const media: CleanReport["media"] = [];
  for (const item of plan.media) {
    const res = await downloadMedia(item.sourceUrl, rootDir, item.kind);
    media.push({ sourceUrl: item.sourceUrl, ok: res.ok, localPath: res.localPath, note: res.note });
    if (res.ok && res.localPath) replaceWithLocalMedia($, item.embedSelector, res, item.kind);
  }
  return media;
}

/**
 * Run a selector, but survive ones the CSS engine can't parse. React/Coral mint
 * ids like `drawer_:R196:` (from `useId`) whose colons are illegal in a CSS
 * `#id` without escaping — cheerio throws "Expected name, found ':'". When a
 * simple `#id` / `.class` selector fails to parse, retry as an attribute
 * selector (`[id="…"]` / `[class~="…"]`), which has no such restriction.
 */
export function selectTolerant($: CheerioAPI, sel: string): Cheerio<AnyNode> {
  try {
    return $(sel);
  } catch (err) {
    // We only get here because the CSS engine already rejected `sel`, so a bare
    // `#id` / `.class` whose token contains otherwise-illegal chars (`:` from
    // React useId, etc.) can be matched literally as an attribute. Combinators,
    // brackets and a second id/class marker rule out the simple-selector case.
    const id = /^#([^\s.#>~+\[\]]+)$/.exec(sel);
    if (id) return $(`[id="${cssAttrEscape(id[1]!)}"]`);
    const cls = /^\.([^\s.#>~+\[\]]+)$/.exec(sel);
    if (cls) return $(`[class~="${cssAttrEscape(cls[1]!)}"]`);
    throw err;
  }
}

/** Escape `"` and `\` for use inside a double-quoted CSS attribute value. */
function cssAttrEscape(s: string): string {
  return s.replace(/[\\"]/g, "\\$&");
}

function replaceWithLocalMedia($: CheerioAPI, selector: string, res: MediaResult, kind: "video" | "audio"): void {
  let target;
  try {
    target = selectTolerant($, selector).first();
  } catch {
    return;
  }
  if (!target || target.length === 0 || !res.localPath) return;
  target.replaceWith(mediaElementHtml(kind, res.localPath));
}
