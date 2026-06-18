/**
 * Harnesses: adapters that run a "system under test" and return its output as a
 * normalized run for the judges to score.
 *
 *  - heuristicPlannerHarness — the no-LLM baseline. Runs offline; this is what
 *    actually executes in CI without an API key, and shows how far rule-based
 *    junk detection gets you (good on obvious junk, blind to embedded media).
 *  - llmPlannerHarness — the real judgement: claude-opus-4-8 reads the page and
 *    returns a plan. Needs ANTHROPIC_API_KEY.
 *  - agentHarness — the full tool-using agent loop. Records each tool call so the
 *    built-in ToolCallJudge can check it removed junk, swapped media, finalised.
 *    Needs ANTHROPIC_API_KEY (and a browser/network for a real page).
 */

import * as cheerio from "cheerio";
import { createHarness } from "vitest-evals";
import { heuristicPlan, llmPlan } from "../src/planner.js";
import { toPlanOutput, type PlanOutput, type EvalMeta } from "./shared.js";

export const heuristicPlannerHarness = createHarness<string, PlanOutput, EvalMeta>({
  name: "heuristic-planner",
  run: ({ metadata }) => {
    const $ = cheerio.load(metadata.html);
    return { output: toPlanOutput(heuristicPlan($)) };
  },
});

export const llmPlannerHarness = createHarness<string, PlanOutput, EvalMeta>({
  name: "llm-planner",
  run: async ({ metadata }) => {
    const plan = await llmPlan(metadata.html, metadata.url);
    return { output: toPlanOutput(plan) };
  },
});

export const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
