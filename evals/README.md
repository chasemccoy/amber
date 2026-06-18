# Evals

A [`vitest-evals`](https://vitest-evals.sentry.dev) suite that measures the part
of this project that can regress quietly: the **judgement**. Unit tests (`pnpm
test`) prove the capture/rewrite plumbing is correct; these evals score whether
the planner and the agent make the *right calls* about what to strip, what to
keep, and which embeds are real media.

```bash
pnpm evals
```

## What's measured

Each fixture in `shared.ts` is a self-contained HTML page with a known ground
truth (`junkGone`, `mainKept`, `chromeKept`, `expectedTopics`, `media`,
`expectedTools`). Five custom **judges** score a plan *functionally* — they apply
its removals to the fixture DOM and check the observable result, rather than
string-matching selectors (many selectors are equally valid):

| Judge | Score |
|---|---|
| `JunkRemoval` | fraction of expected junk markers gone after the plan's removals |
| `MainContentPreserved` | 1 if the main content survives, 0 if it was nuked (overreach) |
| `StructurePreserved` | fraction of structural chrome (header/nav/footer/copyright) kept — catches over-aggressive removal of the page's own furniture |
| `TagRelevance` | fraction of the page's topic concepts covered by the plan's `tags` (fuzzy synonym match, so it scores topical recall, not exact strings) |
| `MediaFound` | fraction of expected media sources surfaced; penalises hallucinated media |

The agent suite (`agent.eval.ts`) adds the built-in `ToolCallJudge` to check the
agent actually called `remove` / `download_and_swap` / `finalize`.

## Three harnesses, increasing capability

| Suite | Harness | Needs a key? |
|---|---|---|
| heuristic baseline | rule-based `heuristicPlan` | no — runs in CI |
| Claude planner | `claude-sonnet-4-6` via `messages.parse` | yes (`ANTHROPIC_API_KEY`) |
| full agent | the real `runAgentLoop` over fixture HTML (no browser) | yes |

The baseline runs everywhere with `judgeThreshold: null` (record, don't fail);
the LLM and agent suites are held to `0.85` and skip without a key.

## What the baseline run shows (no key)

```
blog-post-with-cookie-banner-and-ad   JunkRemoval 1.00  MainContent 1.00  Structure 1.00  TagRelevance 0.00  MediaFound 1.00
conference-talk-with-youtube-embed    JunkRemoval 1.00  MainContent 1.00  Structure 1.00  TagRelevance 0.00  MediaFound 0.00
news-article-with-consent-and-social  JunkRemoval 1.00  MainContent 1.00  Structure 1.00  TagRelevance 0.00  MediaFound 0.00 (n/a)
```

This is the eval earning its keep:

- It immediately caught that the heuristic missed a **`#sponsored-banner`** ad —
  `"sponsor"` wasn't in its pattern list. One-line fix, score went 0 → 1.
- `TagRelevance` stays **0** for the heuristic: with no `<meta keywords>` to crib
  from it can't infer topics — exactly the gap the LLM's read-the-content tagging
  closes (both LLM and agent score `1.00`).
- `MediaFound` stays **0** on the talk fixture for the heuristic: rule-based
  detection removes the `<iframe>` but can't resolve the canonical YouTube URL to
  download. That gap is exactly what the Claude planner / agent close — and the
  eval will show the score jump to 1 once you run with a key.

## Extending

- Add a fixture: append to `FIXTURES` in `shared.ts` with its ground truth.
- Add a judge: `createJudge("Name", ({ output, metadata, toolCalls }) => ({ score, metadata }))`.
- Real pages: point a harness at a captured archive instead of fixture HTML to
  eval against live sites (slower, network-dependent).
