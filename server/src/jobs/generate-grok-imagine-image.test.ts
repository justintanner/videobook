import { describe, it, expect } from "vitest";

describe("generate-grok-imagine-image job handler", () => {
  it("exports registerGenerateGrokImagineImageJob function", async () => {
    const mod = await import("./generate-grok-imagine-image.js");
    expect(typeof mod.registerGenerateGrokImagineImageJob).toBe("function");
  });

  it("registerGenerateGrokImagineImageJob accepts a fs argument", async () => {
    const mod = await import("./generate-grok-imagine-image.js");
    expect(mod.registerGenerateGrokImagineImageJob.length).toBe(1);
  });
});
