import { describe, expect, it } from "vitest";
import {
  FADE_SECONDS,
  osgAnchorPlacement,
  osgFadeEnvelope,
  osgMaxSize,
  osgPadding,
  resolveOsgWindow,
  scoreWatermarkCorners,
  scoreWatermarkCornersForCanvas,
  WATERMARK_CORNERS,
  WATERMARK_MIN_DIM_FRACTION,
  watermarkOsgScale,
  watermarkRectForCorner,
} from "./osg-spec.js";
import type { KeywordOccupiedRegion } from "./keyword-placement.js";
import { orientationDimensions } from "./keyword-placement.js";
import type { Orientation, OsgPosition } from "./subtitles/types.js";

const FPS = 30;
const DURATION = 300; // 10s at 30fps

function fullWindow() {
  return resolveOsgWindow({
    startSeconds: null,
    endSeconds: null,
    tailSeconds: null,
    durationInFrames: DURATION,
    fps: FPS,
  });
}

describe("resolveOsgWindow", () => {
  it("covers the full clip when no window is set", () => {
    expect(fullWindow()).toEqual({ startFrame: 0, endFrame: DURATION, hasExplicitEnd: false });
  });

  it("honors an absolute window over the legacy tail", () => {
    const window = resolveOsgWindow({
      startSeconds: 2,
      endSeconds: 6,
      tailSeconds: 3,
      durationInFrames: DURATION,
      fps: FPS,
    });
    expect(window).toEqual({ startFrame: 60, endFrame: 180, hasExplicitEnd: true });
  });

  it("maps a tail onto the last N seconds", () => {
    const window = resolveOsgWindow({
      startSeconds: null,
      endSeconds: null,
      tailSeconds: 2,
      durationInFrames: DURATION,
      fps: FPS,
    });
    expect(window).toEqual({ startFrame: 240, endFrame: DURATION, hasExplicitEnd: false });
  });

  it("clamps windows that exceed the clip", () => {
    const window = resolveOsgWindow({
      startSeconds: 8,
      endSeconds: 99,
      tailSeconds: null,
      durationInFrames: DURATION,
      fps: FPS,
    });
    expect(window).toEqual({ startFrame: 240, endFrame: DURATION, hasExplicitEnd: false });
    const inverted = resolveOsgWindow({
      startSeconds: 6,
      endSeconds: 2,
      tailSeconds: null,
      durationInFrames: DURATION,
      fps: FPS,
    });
    expect(inverted.endFrame).toBe(inverted.startFrame);
  });
});

describe("osgFadeEnvelope", () => {
  const fade = Math.round(FADE_SECONDS * FPS); // 12 frames

  it("fades in at the start and stays opaque mid-clip", () => {
    const window = fullWindow();
    expect(osgFadeEnvelope(0, window, FPS)).toBe(0);
    expect(osgFadeEnvelope(fade / 2, window, FPS)).toBeCloseTo(0.5, 5);
    expect(osgFadeEnvelope(fade, window, FPS)).toBe(1);
    expect(osgFadeEnvelope(DURATION / 2, window, FPS)).toBe(1);
  });

  it("fades out at the implicit end of the clip", () => {
    const window = fullWindow();
    expect(osgFadeEnvelope(DURATION - fade, window, FPS)).toBe(1);
    expect(osgFadeEnvelope(DURATION - fade / 2, window, FPS)).toBeCloseTo(0.5, 5);
    expect(osgFadeEnvelope(DURATION - 1, window, FPS)).toBeCloseTo(1 / fade, 5);
  });

  it("hard-gates frames outside the window", () => {
    const window = resolveOsgWindow({
      startSeconds: 2,
      endSeconds: 4,
      tailSeconds: null,
      durationInFrames: DURATION,
      fps: FPS,
    });
    expect(osgFadeEnvelope(59, window, FPS)).toBe(0);
    expect(osgFadeEnvelope(90, window, FPS)).toBe(1);
    // Explicit end fades out over the last FADE_SECONDS of the window…
    expect(osgFadeEnvelope(119, window, FPS)).toBeCloseTo(1 / fade, 5);
    // …and is hard-gated from the end frame on.
    expect(osgFadeEnvelope(120, window, FPS)).toBe(0);
    expect(osgFadeEnvelope(DURATION - 1, window, FPS)).toBe(0);
  });

  it("collapses gracefully on sub-second windows", () => {
    const window = resolveOsgWindow({
      startSeconds: 1,
      endSeconds: 1.1,
      tailSeconds: null,
      durationInFrames: DURATION,
      fps: FPS,
    });
    for (let frame = window.startFrame; frame < window.endFrame; frame++) {
      const value = osgFadeEnvelope(frame, window, FPS);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(osgFadeEnvelope(window.endFrame, window, FPS)).toBe(0);
  });
});

describe("osgAnchorPlacement", () => {
  const PAD = 38;

  it("maps every anchor to the expected edges", () => {
    expect(osgAnchorPlacement("top-left", PAD)).toEqual({ top: PAD, left: PAD, transforms: [] });
    expect(osgAnchorPlacement("top-right", PAD)).toEqual({ top: PAD, right: PAD, transforms: [] });
    expect(osgAnchorPlacement("bottom-left", PAD)).toEqual({ bottom: PAD, left: PAD, transforms: [] });
    expect(osgAnchorPlacement("bottom-right", PAD)).toEqual({ bottom: PAD, right: PAD, transforms: [] });
    expect(osgAnchorPlacement("top-center", PAD)).toEqual({ top: PAD, left: "50%", transforms: ["translateX(-50%)"] });
    expect(osgAnchorPlacement("bottom-center", PAD)).toEqual({ bottom: PAD, left: "50%", transforms: ["translateX(-50%)"] });
    expect(osgAnchorPlacement("middle-left", PAD)).toEqual({ top: "50%", left: PAD, transforms: ["translateY(-50%)"] });
    expect(osgAnchorPlacement("middle-right", PAD)).toEqual({ top: "50%", right: PAD, transforms: ["translateY(-50%)"] });
    expect(osgAnchorPlacement("middle-center", PAD)).toEqual({
      top: "50%",
      left: "50%",
      transforms: ["translateY(-50%)", "translateX(-50%)"],
    });
  });
});

describe("watermarkOsgScale", () => {
  it("produces the same physical badge size on every orientation", () => {
    for (const orientation of ["landscape", "portrait", "square"] as Orientation[]) {
      const { width, height } = orientationDimensions(orientation);
      const size = osgMaxSize(width, "medium", watermarkOsgScale(orientation));
      expect(size).toBeCloseTo(Math.min(width, height) * WATERMARK_MIN_DIM_FRACTION, 0);
    }
  });

  it("matches the derived per-orientation constants", () => {
    expect(watermarkOsgScale("landscape")).toBeCloseTo(0.6429, 3);
    expect(watermarkOsgScale("portrait")).toBeCloseTo(1.1429, 3);
    expect(watermarkOsgScale("square")).toBeCloseTo(1.1429, 3);
  });

  it("clamps the user scale into the schema range", () => {
    expect(watermarkOsgScale("portrait", 2)).toBe(2);
    // landscape base 0.6429 × 0.1 = 0.0643 → clamped up to the 0.1 floor.
    expect(watermarkOsgScale("landscape", 0.1)).toBe(0.1);
  });
});

const BADGE_ASPECT = 480 / 580;

describe("watermarkRectForCorner", () => {
  it("keeps the badge inside the canvas with edge padding", () => {
    for (const orientation of ["landscape", "portrait", "square"] as Orientation[]) {
      for (const corner of WATERMARK_CORNERS) {
        const rect = watermarkRectForCorner(orientation, corner, BADGE_ASPECT);
        expect(rect.x).toBeGreaterThan(0);
        expect(rect.y).toBeGreaterThan(0);
        expect(rect.x + rect.width).toBeLessThan(1);
        expect(rect.y + rect.height).toBeLessThan(1);
      }
    }
  });

  it("anchors bottom-right at the bottom-right", () => {
    const { width, height } = orientationDimensions("landscape");
    const rect = watermarkRectForCorner("landscape", "bottom-right", BADGE_ASPECT);
    const padding = osgPadding(width);
    expect((rect.x + rect.width) * width).toBeCloseTo(width - padding, 0);
    expect((rect.y + rect.height) * height).toBeCloseTo(height - padding, 0);
  });
});

function region(partial: Partial<KeywordOccupiedRegion> & { x: number; y: number; width: number; height: number }): KeywordOccupiedRegion {
  return { kind: "face", confidence: 1, ...partial };
}

describe("scoreWatermarkCorners", () => {
  it("prefers bottom-right when nothing is occupied", () => {
    const choice = scoreWatermarkCorners("landscape", [], { aspect: BADGE_ASPECT });
    expect(choice.position).toBe("bottom-right");
  });

  it("moves off a face parked in the bottom-right", () => {
    const occupied = [region({ x: 0.7, y: 0.6, width: 0.3, height: 0.4 })];
    const choice = scoreWatermarkCorners("landscape", occupied, { aspect: BADGE_ASPECT });
    expect(choice.position).toBe("bottom-left");
    expect(choice.scores["bottom-right"]!).toBeGreaterThan(0);
    expect(choice.scores["bottom-left"]).toBe(0);
  });

  it("weights faces above text above graphics when every corner is busy", () => {
    const occupied = [
      region({ kind: "face", x: 0.7, y: 0.6, width: 0.3, height: 0.4 }),
      region({ kind: "graphic", x: 0, y: 0.6, width: 0.3, height: 0.4 }),
      region({ kind: "text", x: 0, y: 0, width: 1, height: 0.4 }),
    ];
    const choice = scoreWatermarkCorners("landscape", occupied, { aspect: BADGE_ASPECT });
    // Face (×3) beats text (×2) beats graphic (×1) at equal coverage, so the
    // graphic'd bottom-left is the least-bad corner.
    expect(choice.scores["bottom-right"]!).toBeGreaterThan(choice.scores["top-right"]!);
    expect(choice.scores["top-right"]!).toBeGreaterThan(choice.scores["bottom-left"]!);
    expect(choice.position).toBe("bottom-left");
  });

  it("dodges the subtitle band off the bottom corners", () => {
    const band = { x: 0.02, y: 0.78, width: 0.96, height: 0.2 };
    const choice = scoreWatermarkCorners("portrait", [], { aspect: BADGE_ASPECT, subtitleBand: band });
    expect(choice.position).toBe("top-right");
    expect(choice.scores["bottom-right"]!).toBeGreaterThan(0);
    expect(choice.scores["bottom-left"]!).toBeGreaterThan(0);
  });

  it("scores arbitrary source-frame canvases for burned-in placement", () => {
    // 640x360 source with a face parked bottom-right: the burn corner moves.
    const occupied = [region({ x: 0.7, y: 0.6, width: 0.3, height: 0.4 })];
    const choice = scoreWatermarkCornersForCanvas(640, 360, occupied, { aspect: BADGE_ASPECT });
    expect(choice.position).toBe("bottom-left");
    const empty = scoreWatermarkCornersForCanvas(640, 360, [], { aspect: BADGE_ASPECT });
    expect(empty.position).toBe("bottom-right");
  });

  it("breaks full-coverage ties in preference order", () => {
    const everywhere = [region({ x: 0, y: 0, width: 1, height: 1 })];
    const choice = scoreWatermarkCorners("square", everywhere, { aspect: BADGE_ASPECT });
    const scores = WATERMARK_CORNERS.map((corner: OsgPosition) => choice.scores[corner]!);
    expect(new Set(scores.map((score) => score.toFixed(8))).size).toBe(1);
    expect(choice.position).toBe(WATERMARK_CORNERS[0]);
  });
});
