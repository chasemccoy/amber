/**
 * Eval for the full tool-using AGENT loop.
 *
 * Runs the real agent (`runAgentLoop`) over fixture HTML — no browser, so it's
 * the agent's *judgement and tool use* under test, not the capture plumbing.
 * Scored by:
 *   - the built-in ToolCallJudge — did it call the right tools (remove, and for
 *     the talk fixture download_and_swap, then finalize)?
 *   - the same functional judges as the planner, applied to the agent's plan.
 *
 * Needs ANTHROPIC_API_KEY (the loop calls Claude). Skipped without one.
 * Run: pnpm evals
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as cheerio from "cheerio";
import { expect } from "vitest";
import { describeEval, createHarness, ToolCallJudge, toolCalls } from "vitest-evals";
import { runAgentLoop } from "../agent/agent.js";
import { FIXTURES, fixtureMeta, toPlanOutput, type PlanOutput, type EvalMeta } from "./shared.js";
import { JunkRemovalJudge, MainContentPreservedJudge, MediaFoundJudge } from "./judges.js";
import { hasApiKey } from "./harness.js";

// Harness: run the agent loop over the fixture DOM and report the plan it built
// plus every tool call it made (for ToolCallJudge).
const agentHarness = createHarness<string, PlanOutput, EvalMeta>({
  name: "archiver-agent",
  run: async ({ input, metadata }) => {
    const $ = cheerio.load(metadata.html);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-eval-${input}-`));
    const { toolCalls, ctx } = await runAgentLoop($, metadata.url, { outDir });
    // Reconstruct a plan-shaped output from what the agent actually did.
    const plan = toPlanOutput({
      title: ctx.title,
      mainContentSelector: ctx.mainSelector,
      removeSelectors: toolCalls
        .filter((t) => t.name === "remove")
        .flatMap((t) => ((t.input as { selectors?: string[] }).selectors ?? [])),
      media: ctx.media
        .filter((m) => m.ok)
        .map((m) => ({ embedSelector: "", sourceUrl: m.sourceUrl, kind: "video", description: "" })),
      notes: "",
      source: "agent",
    });
    return { output: plan, toolCalls: toolCalls.map((t) => ({ name: t.name, arguments: t.input })) };
  },
});

describeEval(
  "archiver agent — tool use + judgement",
  {
    harness: agentHarness,
    judges: [ToolCallJudge(), JunkRemovalJudge, MainContentPreservedJudge, MediaFoundJudge],
    judgeThreshold: 0.85,
  },
  (it) => {
    for (const f of FIXTURES) {
      it.skipIf(!hasApiKey)(f.name, async ({ run }) => {
        const result = await run(f.name, {
          metadata: { ...fixtureMeta(f), expectedTools: f.expected.expectedTools },
        });
        // `run` returns a normalized harness run; the tool calls live in the
        // session (there is no top-level `result.toolCalls`). Read them with the
        // library's own helper.
        expect(toolCalls(result.session).map((t) => t.name)).toContain("finalize");
      });
    }
  },
);
