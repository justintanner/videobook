import { describe, it, expect } from "vitest";

describe("generate-nano-banana-image job handler", () => {
  it("exports registerGenerateNanoBananaImageJob function", async () => {
    const mod = await import("./generate-nano-banana-image.js");
    expect(typeof mod.registerGenerateNanoBananaImageJob).toBe("function");
  });

  it("registerGenerateNanoBananaImageJob accepts a fs argument", async () => {
    const mod = await import("./generate-nano-banana-image.js");
    expect(mod.registerGenerateNanoBananaImageJob.length).toBe(1);
  });
});
