import { describe, it, expect } from "vitest";
import { buildAudioFilter } from "./render-timeline.js";

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

describe("buildAudioFilter", () => {
  const slot = { slug: "vid-a", volume: 100, fadeIn: 0, fadeOut: 0, assetDir: "/tmp" };

  it("uses the real a:0 stream when the slot has audio", () => {
    const filter = buildAudioFilter(1, slot, 4.5, true);
    expect(filter.startsWith("[1:a:0]")).toBe(true);
    expect(filter).toContain("[a1]");
    expect(filter).not.toContain("anullsrc");
  });

  it("synthesizes silence for silent slots instead of requiring a:0", () => {
    const filter = buildAudioFilter(2, { ...slot, volume: 50, fadeIn: 200 }, 3, false);
    expect(filter).toContain("anullsrc=");
    expect(filter).toContain("atrim=0:3");
    expect(filter).toContain("volume=0.5");
    expect(filter).not.toMatch(/\[2:a:0\]/);
    expect(filter.endsWith("[a2]")).toBe(true);
  });
});
