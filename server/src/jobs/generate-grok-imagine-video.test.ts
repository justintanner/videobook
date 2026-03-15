import { describe, it, expect } from "vitest";

describe("generate-grok-imagine-video job handler", () => {
  it("exports registerGenerateGrokImagineVideoJob function", async () => {
    const mod = await import("./generate-grok-imagine-video.js");
    expect(typeof mod.registerGenerateGrokImagineVideoJob).toBe("function");
  });

  it("registerGenerateGrokImagineVideoJob accepts a fs argument", async () => {
    const mod = await import("./generate-grok-imagine-video.js");
    expect(mod.registerGenerateGrokImagineVideoJob.length).toBe(1);
  });
});
