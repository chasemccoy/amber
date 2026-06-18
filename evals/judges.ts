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

/** 1 if the main content survives the plan's removals, 0 if it was nuked. */
export const MainContentPreservedJudge = createJudge("MainContentPreserved", ({ output, metadata }: Ctx) => {
  const cleanedText = applyRemovals(metadata.html, output.removeSelectors);
  const kept = cleanedText.includes(metadata.expected.mainKept);
  return {
    score: kept ? 1 : 0,
    metadata: { rationale: kept ? "main content preserved" : "main content was removed — overreach" },
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
