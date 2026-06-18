/**
 * Evals for the cleanup *planner* — the judgement both surfaces depend on.
 *
 * Two suites over the same fixtures and ground truth:
 *  - the heuristic baseline (no key) runs everywhere and records where rule-based
 *    detection wins (obvious junk) and where it's blind (embedded media);
 *  - the Claude planner (ANTHROPIC_API_KEY) is held to a high bar.
 *
 * Run: pnpm evals
 */

import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { FIXTURES, fixtureMeta } from "./shared.js";
import { heuristicPlannerHarness, llmPlannerHarness, hasApiKey } from "./harness.js";
import { JunkRemovalJudge, MainContentPreservedJudge, MediaFoundJudge } from "./judges.js";

const JUDGES = [JunkRemovalJudge, MainContentPreservedJudge, MediaFoundJudge];

// Baseline: record scores without failing — heuristics are expected to miss
// embedded media, and the point is to see the gap, not to gate CI on it.
describeEval(
  "cleanup planner — heuristic baseline (no LLM)",
  { harness: heuristicPlannerHarness, judges: JUDGES, judgeThreshold: null },
  (it) => {
    for (const f of FIXTURES) {
      it(f.name, async ({ run }) => {
        const result = await run(f.name, { metadata: fixtureMeta(f) });
        expect(result.output.removeSelectors.length).toBeGreaterThan(0);
      });
    }
  },
);

// The real judgement. Skipped without a key; held to a high average score.
describeEval(
  "cleanup planner — Claude (claude-opus-4-8)",
  { harness: llmPlannerHarness, judges: JUDGES, judgeThreshold: 0.85 },
  (it) => {
    for (const f of FIXTURES) {
      it.skipIf(!hasApiKey)(f.name, async ({ run }) => {
        const result = await run(f.name, { metadata: fixtureMeta(f) });
        expect(result.output.mainContentSelector).toBeTruthy();
      });
    }
  },
);
