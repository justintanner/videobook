import { describe, expect, it } from "vitest";
import {
  KEYWORD_FRAME_CACHE_FILENAME,
  KEYWORD_PLACEMENT_VERSION,
  keywordLayout,
  mapSourceRectToTarget,
  resolveKeywordPlacements,
} from "./keyword-placement.js";
import type { KeywordPlacementAnalysis } from "./keyword-placement.js";
import type { KeywordGraphic } from "./subtitles/types.js";

function graphic(text = "Revolution"): KeywordGraphic {
  return {
    text,
    start: 0.88,
    end: 3.4,
    frameTime: 1.2,
    side: "right",
  };
}

function analysis(regions: KeywordPlacementAnalysis["cues"][number]["regions"]): KeywordPlacementAnalysis {
  return {
    version: KEYWORD_PLACEMENT_VERSION,
    fingerprint: "fixture",
    sourceWidth: 1920,
    sourceHeight: 1080,
    frameCacheFilename: KEYWORD_FRAME_CACHE_FILENAME,
    analyzedAt: "2026-07-18T00:00:00.000Z",
    cues: [{
      cueId: "revolution@1.200",
      text: "Revolution",
      frameTime: 1.2,
      regions,
    }],
  };
}

const BASE_SETTINGS = {
  subtitlesEnabled: true,
  subtitlePosition: "bottom" as const,
  subtitleStyle: "impact" as const,
  subtitleFontSize: "medium" as const,
};

describe("keyword placement", () => {
  it("maps source regions through the foreground contain transform", () => {
    const mapped = mapSourceRectToTarget(
      { x: 0.25, y: 0.2, width: 0.5, height: 0.4 },
      1920,
      1080,
      1080,
      1920,
    );

    expect(mapped.x).toBeCloseTo(0.25);
    expect(mapped.width).toBeCloseTo(0.5);
    expect(mapped.y).toBeCloseTo(0.405078125);
    expect(mapped.height).toBeCloseTo(0.1265625);
  });

  it("places typography on the side away from a detected face", () => {
    const result = resolveKeywordPlacements(
      [graphic()],
      analysis([{
        kind: "face",
        confidence: 0.99,
        x: 0.52,
        y: 0.08,
        width: 0.42,
        height: 0.55,
      }]),
      "landscape",
      BASE_SETTINGS,
    );

    expect(result.skipped).toEqual([]);
    expect(result.graphics[0].anchor).toMatch(/left$/);
    expect(result.graphics[0].side).toBe("left");
  });

  it("reserves the active subtitle band", () => {
    const result = resolveKeywordPlacements(
      [graphic()],
      analysis([]),
      "landscape",
      { ...BASE_SETTINGS, subtitlePosition: "middle" },
    );

    expect(result.graphics[0].anchor).toMatch(/^upper-/);
  });

  it("skips a keyword when every shoulder zone is occupied", () => {
    const result = resolveKeywordPlacements(
      [graphic()],
      analysis([{
        kind: "face",
        confidence: 1,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      }]),
      "landscape",
      { ...BASE_SETTINGS, subtitlesEnabled: false },
    );

    expect(result.graphics).toEqual([]);
    expect(result.skipped).toEqual(["Revolution"]);
  });

  it("shrinks layout geometry without changing its anchor", () => {
    const full = keywordLayout("Multicultural", "upper-left", 1920, 1080, 1);
    const small = keywordLayout("Multicultural", "upper-left", 1920, 1080, 0.7);

    expect(small.rect.width).toBeLessThan(full.rect.width);
    expect(small.rect.height).toBeLessThan(full.rect.height);
    expect(small.rect.x).toBe(full.rect.x);
    expect(small.rect.y).toBe(full.rect.y);
  });
});
