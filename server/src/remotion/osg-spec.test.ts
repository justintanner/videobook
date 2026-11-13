import { describe, expect, it } from "vitest";
import {
  osgPadding,
  resolveOsgWindow,
  scoreWatermarkCorners,
  scoreWatermarkCornersForCanvas,
  WATERMARK_CORNERS,
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
