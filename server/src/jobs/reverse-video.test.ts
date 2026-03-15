import { describe, it, expect } from "vitest";

describe("reverse-video job handler", () => {
  it("exports registerReverseVideoJob function", async () => {
    const mod = await import("./reverse-video.js");
    expect(typeof mod.registerReverseVideoJob).toBe("function");
  });

  it("registerReverseVideoJob accepts a fs argument", async () => {
    const mod = await import("./reverse-video.js");
    expect(mod.registerReverseVideoJob.length).toBe(1);
  });
});
