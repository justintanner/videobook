import { describe, it, expect } from "vitest";

describe("generate-gpt-image job handler", () => {
  it("exports registerGenerateGptImageJob function", async () => {
    const mod = await import("./generate-gpt-image.js");
    expect(typeof mod.registerGenerateGptImageJob).toBe("function");
  });

  it("registerGenerateGptImageJob accepts a fs argument", async () => {
    const mod = await import("./generate-gpt-image.js");
    expect(mod.registerGenerateGptImageJob.length).toBe(1);
  });
});
