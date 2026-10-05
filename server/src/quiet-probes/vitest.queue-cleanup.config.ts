import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["queue-cleanup.probe.ts"],
    setupFiles: [path.resolve(import.meta.dirname, "../../../vitest.setup.ts")],
    sequence: { hooks: "list" },
    hookTimeout: 15_000,
  },
});
