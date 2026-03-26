import { describe, it, expect } from "vitest";

describe("generate-grok-imagine-ref-image job handler", () => {
  it("exports registerGenerateGrokImagineRefImageJob function", async () => {
    const mod = await import("./generate-grok-imagine-ref-image.js");
    expect(typeof mod.registerGenerateGrokImagineRefImageJob).toBe("function");
  });

  it("registerGenerateGrokImagineRefImageJob accepts a fs argument", async () => {
    const mod = await import("./generate-grok-imagine-ref-image.js");
    expect(mod.registerGenerateGrokImagineRefImageJob.length).toBe(1);
  });
});
