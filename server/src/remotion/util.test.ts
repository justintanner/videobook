import { describe, it, expect } from "vitest";
import {
  isValidHex,
  getCurrentWordIndex,
  joinsPreviousWord,
} from "./util.js";
import type { Word } from "./subtitles/types.js";

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

describe("joinsPreviousWord", () => {
  it("joins Thai and CJK words without a gap and keeps gaps around spaced words", () => {
    const words: Word[] = ["ฉัน", "ชอบ", "Bangkok", "天気", "です"].map((word, index) => ({ word, start: index, end: index + 1 }));
    expect(words.map((_, index) => joinsPreviousWord(words, index))).toEqual([false, true, false, false, true]);
    expect(joinsPreviousWord(words, words.length)).toBe(false);
  });
});
