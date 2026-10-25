import path from "node:path";
import { defineConfig } from "vitest/config";
import { testBudget } from "../test-budget.js";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["queue-cleanup.probe.ts"],
    setupFiles: [path.resolve(import.meta.dirname, "../../../vitest.setup.ts")],
    sequence: { hooks: "list" },
    testTimeout: testBudget(5_000),
    hookTimeout: testBudget(15_000),
  },
});
