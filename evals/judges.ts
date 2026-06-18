/**
 * Custom judges that score a cleanup plan against a fixture's ground truth.
 *
 * These are *functional* judges: rather than string-matching the model's exact
 * selectors (brittle — many selectors are equally valid), they apply the plan's
 * removals to the fixture DOM and check the observable result: is the junk
 * actually gone? did the main content survive? was the real media found?
 */

import * as cheerio from "cheerio";
import { createJudge, type JudgeContext } from "vitest-evals";
import type { PlanOutput, EvalMeta } from "./shared.js";
import { mediaId } from "./shared.js";

type Ctx = JudgeContext<string, PlanOutput, EvalMeta>;

/** Apply a plan's removeSelectors to fixture HTML and return the cleaned text. */
function applyRemovals(html: string, selectors: string[]): string {
  const $ = cheerio.load(html);
  for (const sel of selectors) {
    try {
      $(sel).remove();
    } catch {
      /* invalid selector — ignore, like the real pipeline does */
    }
  }
  return $.root().text();
}

/** Fraction of expected junk markers that are gone after the plan's removals. */
export const JunkRemovalJudge = createJudge("JunkRemoval", ({ output, metadata }: Ctx) => {
  const { junkGone } = metadata.expected;
  if (junkGone.length === 0) return { score: 1, metadata: { rationale: "no junk expected" } };
  const cleanedText = applyRemovals(metadata.html, output.removeSelectors);
  const stillThere = junkGone.filter((marker) => cleanedText.includes(marker));
  const score = (junkGone.length - stillThere.length) / junkGone.length;
  return {
    score,
    metadata: {
      rationale: `${junkGone.length - stillThere.length}/${junkGone.length} junk markers removed`,
      ...(stillThere.length ? { missed: stillThere } : {}),
    },
  };
});

/**
 * Fraction of structural-chrome markers (site header, nav, footer, copyright,
 * and first-party next/previous-article navigation) that survive the plan's
 * removals. Guards against overreach — deleting the page's own furniture and
 * editorial navigation, not just the junk inside it.
 */
export const StructurePreservedJudge = createJudge("StructurePreserved", ({ output, metadata }: Ctx) => {
  const { chromeKept } = metadata.expected;
  if (!chromeKept || chromeKept.length === 0) return { score: 1, metadata: { rationale: "no chrome to check" } };
  const cleanedText = applyRemovals(metadata.html, output.removeSelectors);
  const removed = chromeKept.filter((marker) => !cleanedText.includes(marker));
  const score = (chromeKept.length - removed.length) / chromeKept.length;
  return {
    score,
    metadata: {
      rationale: `${chromeKept.length - removed.length}/${chromeKept.length} chrome markers preserved`,
      ...(removed.length ? { overreached: removed } : {}),
    },
  };
});

/** 1 if the main content survives the plan's removals, 0 if it was nuked. */
export const MainContentPreservedJudge = createJudge("MainContentPreserved", ({ output, metadata }: Ctx) => {
  const cleanedText = applyRemovals(metadata.html, output.removeSelectors);
  const kept = cleanedText.includes(metadata.expected.mainKept);
  return {
    score: kept ? 1 : 0,
    metadata: { rationale: kept ? "main content preserved" : "main content was removed — overreach" },
  };
});

/** Normalise a tag/synonym to alphanumeric words for fuzzy comparison. */
function normTag(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Fraction of expected topic concepts covered by the plan's tags. Each concept
 * is a synonym group; it's covered if any synonym fuzzy-matches any tag (one
 * normalised string contains the other), so "llm" satisfies a {large language
 * model, llm} concept and "static-site generator" satisfies {static site}.
 * Scores topical recall without demanding exact strings.
 */
export const TagRelevanceJudge = createJudge("TagRelevance", ({ output, metadata }: Ctx) => {
  const topics = metadata.expected.expectedTopics;
  if (!topics || topics.length === 0) return { score: 1, metadata: { rationale: "no topics expected" } };
  const tags = (output.tags ?? []).map(normTag).filter(Boolean);
  const covers = (syn: string) => {
    const s = normTag(syn);
    return tags.some((t) => t === s || t.includes(s) || s.includes(t));
  };
  const missed: string[] = [];
  let hit = 0;
  for (const concept of topics) {
    if (concept.some(covers)) hit++;
    else missed.push(concept[0] ?? "?");
  }
  return {
    score: hit / topics.length,
    metadata: {
      rationale: `${hit}/${topics.length} topics covered by tags [${(output.tags ?? []).join(", ")}]`,
      ...(missed.length ? { missedTopics: missed } : {}),
    },
  };
});

/** Fraction of expected media sources the plan surfaced for download. */
export const MediaFoundJudge = createJudge("MediaFound", ({ output, metadata }: Ctx) => {
  const want = metadata.expected.media;
  if (want.length === 0) {
    // Nothing to find — but penalise hallucinated media (a false positive that
    // would trigger a pointless/incorrect download).
    const hallucinated = output.media.length > 0;
    return {
      score: hallucinated ? 0 : 1,
      metadata: { rationale: hallucinated ? "no media expected but plan listed some" : "correctly found no media" },
    };
  }
  const found = new Set(output.media.map((m) => mediaId(m.sourceUrl)));
  const hit = want.filter((u) => found.has(mediaId(u)));
  return {
    score: hit.length / want.length,
    metadata: { rationale: `${hit.length}/${want.length} media sources found` },
  };
});
