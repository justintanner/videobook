import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    silent: "passed-only",
    include: ["silent.probe.ts"],
  },
});
