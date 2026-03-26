import { describe, it, expect } from "vitest";

describe("generate-grok-imagine-ref-video job handler", () => {
  it("exports registerGenerateGrokImagineRefVideoJob function", async () => {
    const mod = await import("./generate-grok-imagine-ref-video.js");
    expect(typeof mod.registerGenerateGrokImagineRefVideoJob).toBe("function");
  });

  it("registerGenerateGrokImagineRefVideoJob accepts a fs argument", async () => {
    const mod = await import("./generate-grok-imagine-ref-video.js");
    expect(mod.registerGenerateGrokImagineRefVideoJob.length).toBe(1);
  });
});
