import { describe, it, expect } from "vitest";

describe("render-timeline job handler", () => {
  it("exports registerRenderTimelineJob function", async () => {
    const mod = await import("./render-timeline.js");
    expect(typeof mod.registerRenderTimelineJob).toBe("function");
  });

  it("registerRenderTimelineJob accepts a fs argument", async () => {
    const mod = await import("./render-timeline.js");
    expect(mod.registerRenderTimelineJob.length).toBe(1);
  });
});

describe("render-timeline constants", () => {
  it("uses expected render filenames from remotion constants", async () => {
    const constants = await import("../remotion/constants.js");
    expect(constants.LANDSCAPE_WIDTH).toBe(1920);
    expect(constants.LANDSCAPE_HEIGHT).toBe(1080);
    expect(constants.PORTRAIT_WIDTH).toBe(1080);
    expect(constants.PORTRAIT_HEIGHT).toBe(1920);
    expect(constants.SQUARE_WIDTH).toBe(1080);
    expect(constants.SQUARE_HEIGHT).toBe(1080);
  });
});
