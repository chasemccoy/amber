import { defineConfig } from "vitest/config";

// Evals are slower and model-graded; keep them in their own Vitest config,
// separate from the fast deterministic unit tests in `test/` (run with `pnpm test`).
export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ["vitest-evals/reporter"],
  },
});
