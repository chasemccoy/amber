/**
 * Evals for the `preserveRuntime` judgement — the switch that escalates a page
 * from a static archive to keep-js mode (slow render, esbuild, big output).
 *
 * The bar: keep JS ONLY when the presentation genuinely needs it. Half the
 * fixtures are tempting false cases (hydration bundles, decorative canvas,
 * script-heavy docs) — over-triggering there is the failure mode being guarded
 * against. Exact boolean ground truth, two trials each: the judgement must be
 * both correct and stable.
 *
 * Run: pnpm evals evals/runtime.eval.ts   (needs ANTHROPIC_API_KEY)
 */

import { expect } from "vitest";
import { describeEval, createHarness } from "vitest-evals";
import { llmPlan } from "../src/planner.js";
import { toPlanOutput, RUNTIME_FIXTURES, type PlanOutput } from "./shared.js";
import { hasApiKey } from "./harness.js";

const runtimeHarness = createHarness<string, PlanOutput, { html: string; url: string }>({
  name: "llm-planner-runtime",
  run: async ({ metadata }) => ({ output: toPlanOutput(await llmPlan(metadata.html, metadata.url)) }),
});

const TRIALS = 2;

describeEval(
  "runtime judgement — keep JS only when absolutely necessary",
  { harness: runtimeHarness, judges: [], judgeThreshold: null },
  (it) => {
    for (const f of RUNTIME_FIXTURES) {
      for (let trial = 1; trial <= TRIALS; trial++) {
        it.skipIf(!hasApiKey)(`${f.name} (trial ${trial})`, async ({ run }) => {
          const result = await run(f.name, { metadata: { html: f.html, url: f.url } });
          expect(result.output.preserveRuntime, `${f.name}: ${f.why}`).toBe(f.preserveRuntime);
        });
      }
    }
  },
);
