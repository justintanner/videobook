import path from "node:path";
import { defineConfig } from "vitest/config";
import { testBudget } from "../test-budget.js";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["fetch-guard.probe.ts"],
    setupFiles: [path.resolve(import.meta.dirname, "../../../vitest.setup.ts")],
    hookTimeout: testBudget(15_000),
  },
});
