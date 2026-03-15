import { describe, it, expect } from "vitest";

describe("change-video-speed job handler", () => {
  it("exports registerChangeVideoSpeedJob function", async () => {
    const mod = await import("./change-video-speed.js");
    expect(typeof mod.registerChangeVideoSpeedJob).toBe("function");
  });

  it("registerChangeVideoSpeedJob accepts a fs argument", async () => {
    const mod = await import("./change-video-speed.js");
    expect(mod.registerChangeVideoSpeedJob.length).toBe(1);
  });
});
