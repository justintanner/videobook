import { describe, it, expect } from "vitest";
import {
  LANDSCAPE_WIDTH,
  LANDSCAPE_HEIGHT,
  PORTRAIT_WIDTH,
  PORTRAIT_HEIGHT,
  SQUARE_WIDTH,
  SQUARE_HEIGHT,
  getImpactFontSize,
  getHighlightFontSize,
  getYPosition,
  DEFAULT_TEXT_COLOR,
  DEFAULT_HIGHLIGHT_COLOR,
  POP_DURATION_FRAMES,
  POP_SCALE_START,
  POP_SCALE_END,
} from "./constants.js";
import type { FontSizePreset, Orientation, SubtitlePosition } from "./subtitles/types.js";

describe("dimension constants", () => {
  it("has correct landscape dimensions", () => {
    expect(LANDSCAPE_WIDTH).toBe(1920);
    expect(LANDSCAPE_HEIGHT).toBe(1080);
  });

  it("has correct portrait dimensions", () => {
    expect(PORTRAIT_WIDTH).toBe(1080);
    expect(PORTRAIT_HEIGHT).toBe(1920);
  });

  it("has correct square dimensions", () => {
    expect(SQUARE_WIDTH).toBe(1080);
    expect(SQUARE_HEIGHT).toBe(1080);
  });
});

describe("default style constants", () => {
  it("has correct default text color", () => {
    expect(DEFAULT_TEXT_COLOR).toBe("#F8FAFC");
  });

  it("has correct default highlight color", () => {
    expect(DEFAULT_HIGHLIGHT_COLOR).toBe("#991B1B");
  });

  it("has correct pop animation constants", () => {
    expect(POP_DURATION_FRAMES).toBe(4);
    expect(POP_SCALE_START).toBe(1.15);
    expect(POP_SCALE_END).toBe(1.0);
  });
});

describe("getImpactFontSize", () => {
  const expected: Record<string, number> = {
    "small:portrait": 96,
    "small:landscape": 56,
    "small:square": 56,
    "medium:portrait": 120,
    "medium:landscape": 72,
    "medium:square": 72,
    "large:portrait": 144,
    "large:landscape": 88,
    "large:square": 88,
  };

  const presets: FontSizePreset[] = ["small", "medium", "large"];
  const orientations: Orientation[] = ["portrait", "landscape", "square"];

  for (const preset of presets) {
    for (const orientation of orientations) {
      it(`returns ${expected[`${preset}:${orientation}`]} for ${preset}:${orientation}`, () => {
        expect(getImpactFontSize(preset, orientation)).toBe(
          expected[`${preset}:${orientation}`],
        );
      });
    }
  }
});

describe("getHighlightFontSize", () => {
  const expected: Record<string, number> = {
    "small:portrait": 56,
    "small:landscape": 40,
    "small:square": 40,
    "medium:portrait": 72,
    "medium:landscape": 52,
    "medium:square": 52,
    "large:portrait": 88,
    "large:landscape": 64,
    "large:square": 64,
  };

  const presets: FontSizePreset[] = ["small", "medium", "large"];
  const orientations: Orientation[] = ["portrait", "landscape", "square"];

  for (const preset of presets) {
    for (const orientation of orientations) {
      it(`returns ${expected[`${preset}:${orientation}`]} for ${preset}:${orientation}`, () => {
        expect(getHighlightFontSize(preset, orientation)).toBe(
          expected[`${preset}:${orientation}`],
        );
      });
    }
  }
});

describe("getYPosition", () => {
  const expected: Record<string, number> = {
    "top:portrait": 0.15,
    "top:landscape": 0.15,
    "top:square": 0.15,
    "middle:portrait": 0.45,
    "middle:landscape": 0.45,
    "middle:square": 0.45,
    "bottom:portrait": 0.72,
    "bottom:landscape": 0.80,
    "bottom:square": 0.80,
  };

  const positions: SubtitlePosition[] = ["top", "middle", "bottom"];
  const orientations: Orientation[] = ["portrait", "landscape", "square"];

  for (const position of positions) {
    for (const orientation of orientations) {
      it(`returns ${expected[`${position}:${orientation}`]} for ${position}:${orientation}`, () => {
        expect(getYPosition(position, orientation)).toBe(
          expected[`${position}:${orientation}`],
        );
      });
    }
  }
});
