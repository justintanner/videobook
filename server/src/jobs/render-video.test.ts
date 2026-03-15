import { describe, it, expect } from "vitest";

describe("render-video job handler", () => {
  it("exports registerRenderVideoJob function", async () => {
    const mod = await import("./render-video.js");
    expect(typeof mod.registerRenderVideoJob).toBe("function");
  });

  it("registerRenderVideoJob accepts a fs argument", async () => {
    const mod = await import("./render-video.js");
    expect(mod.registerRenderVideoJob.length).toBe(1);
  });
});
