import { describe, it, expect } from "vitest";
import { overlayXY, buildOverlayFilter, type WatermarkPosition } from "./watermark-video.js";

const MARGIN = 24;

describe("overlayXY — anchor → ffmpeg overlay coordinates", () => {
  const cases: Array<[WatermarkPosition, string, string]> = [
    ["top-left", "24", "24"],
    ["top-center", "(W-w)/2", "24"],
    ["top-right", "W-w-24", "24"],
    ["middle-left", "24", "(H-h)/2"],
    ["middle-center", "(W-w)/2", "(H-h)/2"],
    ["middle-right", "W-w-24", "(H-h)/2"],
    ["bottom-left", "24", "H-h-24"],
    ["bottom-center", "(W-w)/2", "H-h-24"],
    ["bottom-right", "W-w-24", "H-h-24"],
  ];

  it.each(cases)("%s → x=%s y=%s", (position, x, y) => {
    expect(overlayXY(position, MARGIN)).toEqual({ x, y });
  });
});

describe("buildOverlayFilter — scale handling", () => {
  const base = { alpha: 0.65, margin: MARGIN, enable: "between(t,1.000,3.000)" };

  it("omits the scale filter at scale=1 and anchors bottom-right", () => {
    const filter = buildOverlayFilter({ ...base, position: "bottom-right", scale: 1 });
    expect(filter).toBe(
      "[1:v]format=rgba,colorchannelmixer=aa=0.65[card];" +
      "[0:v][card]overlay=x=W-w-24:y=H-h-24:enable='between(t,1.000,3.000)'",
    );
    expect(filter).not.toContain("scale=");
  });

  it("includes a proportional scale filter at scale=0.5 and honors position", () => {
    const filter = buildOverlayFilter({ ...base, position: "bottom-left", scale: 0.5 });
    expect(filter).toBe(
      "[1:v]scale=iw*0.5:ih*0.5,format=rgba,colorchannelmixer=aa=0.65[card];" +
      "[0:v][card]overlay=x=24:y=H-h-24:enable='between(t,1.000,3.000)'",
    );
  });

  it("centers the card for middle-center", () => {
    const filter = buildOverlayFilter({ ...base, position: "middle-center", scale: 0.75 });
    expect(filter).toContain("scale=iw*0.75:ih*0.75,");
    expect(filter).toContain("overlay=x=(W-w)/2:y=(H-h)/2:");
  });
});
