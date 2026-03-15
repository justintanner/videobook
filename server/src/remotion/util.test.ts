import { describe, it, expect } from "vitest";
import {
  easeOutCubic,
  hexToRgba,
  isValidHex,
  getCurrentWordIndex,
  stripPunctuation,
} from "./util.js";
import type { Word } from "./subtitles/types.js";

describe("easeOutCubic", () => {
  it("returns 0 for t=0", () => {
    expect(easeOutCubic(0)).toBe(0);
  });

  it("returns 1 for t=1", () => {
    expect(easeOutCubic(1)).toBe(1);
  });

  it("returns 0.875 for t=0.5", () => {
    expect(easeOutCubic(0.5)).toBe(0.875);
  });

  it("always returns values between 0 and 1 for inputs in [0,1]", () => {
    const steps = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    for (const t of steps) {
      const result = easeOutCubic(t);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    }
  });

  it("is monotonically increasing in [0,1]", () => {
    let prev = easeOutCubic(0);
    for (let t = 0.01; t <= 1.0; t += 0.01) {
      const curr = easeOutCubic(t);
      expect(curr).toBeGreaterThanOrEqual(prev);
      prev = curr;
    }
  });
});

describe("hexToRgba", () => {
  it("converts #FF0000 to red", () => {
    expect(hexToRgba("#FF0000")).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("converts #00FF00 to green", () => {
    expect(hexToRgba("#00FF00")).toEqual({ r: 0, g: 255, b: 0 });
  });

  it("converts #0000FF to blue", () => {
    expect(hexToRgba("#0000FF")).toEqual({ r: 0, g: 0, b: 255 });
  });

  it("converts #000000 to black", () => {
    expect(hexToRgba("#000000")).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("converts #FFFFFF to white", () => {
    expect(hexToRgba("#FFFFFF")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("handles lowercase hex", () => {
    expect(hexToRgba("#ff8800")).toEqual({ r: 255, g: 136, b: 0 });
  });

  it("returns white for invalid input (no #)", () => {
    expect(hexToRgba("invalid")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("returns white for short hex (#FFF is only 3 chars after stripping #)", () => {
    expect(hexToRgba("#FFF")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("returns white for empty string", () => {
    expect(hexToRgba("")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("returns white for too-long hex", () => {
    expect(hexToRgba("#FF00FF00")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("handles hex without # prefix (6 valid chars)", () => {
    // After stripping #, "FF0000" has length 6, so it parses
    expect(hexToRgba("FF0000")).toEqual({ r: 255, g: 0, b: 0 });
  });
});

describe("isValidHex", () => {
  it("returns true for valid uppercase hex", () => {
    expect(isValidHex("#FF0000")).toBe(true);
  });

  it("returns true for valid lowercase hex", () => {
    expect(isValidHex("#fff000")).toBe(true);
  });

  it("returns true for mixed case hex", () => {
    expect(isValidHex("#aAbBcC")).toBe(true);
  });

  it("returns false without # prefix", () => {
    expect(isValidHex("FF0000")).toBe(false);
  });

  it("returns false for short hex (#FFF)", () => {
    expect(isValidHex("#FFF")).toBe(false);
  });

  it("returns false for invalid hex chars (#GGGGGG)", () => {
    expect(isValidHex("#GGGGGG")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isValidHex("")).toBe(false);
  });

  it("returns false for # alone", () => {
    expect(isValidHex("#")).toBe(false);
  });

  it("returns false for too-long hex", () => {
    expect(isValidHex("#FF00FF00")).toBe(false);
  });
});

describe("getCurrentWordIndex", () => {
  const words: Word[] = [
    { word: "Hello", start: 0.0, end: 0.5 },
    { word: "world", start: 0.6, end: 1.0 },
    { word: "foo", start: 1.5, end: 2.0 },
  ];

  it("returns index when currentTime is within a word's range", () => {
    expect(getCurrentWordIndex(words, 0.3)).toBe(0);
    expect(getCurrentWordIndex(words, 0.8)).toBe(1);
    expect(getCurrentWordIndex(words, 1.7)).toBe(2);
  });

  it("returns index at word start boundary", () => {
    expect(getCurrentWordIndex(words, 0.0)).toBe(0);
    expect(getCurrentWordIndex(words, 0.6)).toBe(1);
  });

  it("returns index at word end boundary", () => {
    expect(getCurrentWordIndex(words, 0.5)).toBe(0);
    expect(getCurrentWordIndex(words, 1.0)).toBe(1);
  });

  it("returns -1 between words (gap)", () => {
    expect(getCurrentWordIndex(words, 0.55)).toBe(-1);
    expect(getCurrentWordIndex(words, 1.2)).toBe(-1);
  });

  it("returns -1 before all words", () => {
    expect(getCurrentWordIndex(words, -1)).toBe(-1);
  });

  it("returns -1 after all words", () => {
    expect(getCurrentWordIndex(words, 3.0)).toBe(-1);
  });

  it("returns -1 for empty words array", () => {
    expect(getCurrentWordIndex([], 0.5)).toBe(-1);
  });

  describe("with lingerDuration", () => {
    it("extends non-last word end up to next word start minus 0.01", () => {
      // word 0 end=0.5, linger=0.2 => extended to min(0.7, 0.6-0.01)=0.59
      expect(getCurrentWordIndex(words, 0.55, 0.2)).toBe(0);
      expect(getCurrentWordIndex(words, 0.59, 0.2)).toBe(0);
    });

    it("does not let linger overlap into next word", () => {
      // word 0 with linger=1.0 => capped at words[1].start - 0.01 = 0.59
      expect(getCurrentWordIndex(words, 0.595, 1.0)).toBe(-1);
    });

    it("extends last word end without cap", () => {
      // word 2 end=2.0, linger=0.5 => extended to 2.5
      expect(getCurrentWordIndex(words, 2.3, 0.5)).toBe(2);
      expect(getCurrentWordIndex(words, 2.5, 0.5)).toBe(2);
      expect(getCurrentWordIndex(words, 2.6, 0.5)).toBe(-1);
    });

    it("no extension with lingerDuration=0 (default)", () => {
      expect(getCurrentWordIndex(words, 0.55, 0)).toBe(-1);
    });
  });
});

describe("stripPunctuation", () => {
  it("removes commas and exclamation marks", () => {
    expect(stripPunctuation("Hello, world!")).toBe("Hello world");
  });

  it("returns unchanged text with no punctuation", () => {
    expect(stripPunctuation("test")).toBe("test");
  });

  it("removes periods", () => {
    expect(stripPunctuation("Hello.")).toBe("Hello");
  });

  it("removes question marks", () => {
    expect(stripPunctuation("Really?")).toBe("Really");
  });

  it("preserves spaces", () => {
    expect(stripPunctuation("a b c")).toBe("a b c");
  });

  it("handles empty string", () => {
    expect(stripPunctuation("")).toBe("");
  });

  it("removes multiple punctuation characters", () => {
    expect(stripPunctuation("wow!!! cool???")).toBe("wow cool");
  });

  it("preserves underscores (word characters)", () => {
    expect(stripPunctuation("hello_world")).toBe("hello_world");
  });

  it("removes hyphens", () => {
    expect(stripPunctuation("well-known")).toBe("wellknown");
  });

  it("removes apostrophes", () => {
    expect(stripPunctuation("it's")).toBe("its");
  });
});
