import { describe, expect, it } from "vitest";
import { burnFilter } from "./burn.js";
import type { ProbeResult } from "../ffmpeg.js";
import { graphicsAspectChanged, graphicsCanvas, graphicsFrameRegions, graphicsFrameSchema, graphicsVideoTransform, ORIGINAL_GRAPHICS_FRAME } from "./frame.js";

const source = { width: 1920, height: 1080 };

describe("graphics framing", () => {
  it.each(["9:16", "1:1", "4:5", "16:9"] as const)("constructs crop and blur canvases for %s", (aspect) => {
    const frame = { ...ORIGINAL_GRAPHICS_FRAME, aspect };
    const canvas = graphicsCanvas(source, frame);
    const crop = graphicsVideoTransform(source, canvas, "crop", { x: 1, y: 1 });
    expect(crop.width).toBeGreaterThanOrEqual(canvas.width);
    expect(crop.height).toBeGreaterThanOrEqual(canvas.height);
    expect(crop.left + crop.width).toBe(canvas.width);
    expect(crop.top + crop.height).toBe(canvas.height);
    const contain = graphicsVideoTransform(source, canvas, "blur");
    expect(contain.width).toBeLessThanOrEqual(canvas.width);
    expect(contain.height).toBeLessThanOrEqual(canvas.height);
    const probe = source as ProbeResult;
    expect(burnFilter([], probe, canvas, frame)).toContain(`crop=${canvas.width}:${canvas.height}`);
    const blur = burnFilter([], probe, canvas, { ...frame, fit: "blur" });
    expect(blur).toContain("gblur=sigma=20");
    expect(blur).toContain("[back][front]overlay=");
    expect(blur).toContain("[base]null[vout]");
  });

  it("preserves original dimensions and rejects invalid focus coordinates", () => {
    expect(graphicsCanvas(source, ORIGINAL_GRAPHICS_FRAME)).toEqual(source);
    expect(graphicsAspectChanged(source, { ...ORIGINAL_GRAPHICS_FRAME, aspect: "16:9" })).toBe(false);
    expect(graphicsAspectChanged(source, { ...ORIGINAL_GRAPHICS_FRAME, aspect: "9:16" })).toBe(true);
    expect(graphicsFrameSchema.safeParse({ ...ORIGINAL_GRAPHICS_FRAME, focus: { x: 2, y: 0.5 } }).success).toBe(false);
  });

  it("clips source regions through the crop and skips blurred-fill regions", () => {
    const frames = [{ time: 1, regions: [{ kind: "face" as const, confidence: 1, x: 0, y: 0.25, width: 0.1, height: 0.25 }] }];
    const frame = { ...ORIGINAL_GRAPHICS_FRAME, aspect: "9:16" as const };
    expect(graphicsFrameRegions(frames, source, frame)[0].regions).toEqual([]);
    const left = graphicsFrameRegions(frames, source, { ...frame, focus: { x: 0, y: 0.5 } });
    expect(left[0].regions[0]).toMatchObject({ x: 0, y: 0.25, height: 0.25 });
    expect(left[0].regions[0].width).toBeGreaterThan(0.1);
    expect(graphicsFrameRegions(frames, source, { ...frame, fit: "blur" })[0].regions).toEqual([]);
  });
});
