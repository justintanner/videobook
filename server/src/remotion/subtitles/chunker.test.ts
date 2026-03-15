import { describe, it, expect } from "vitest";
import { chunkSegments } from "./chunker.js";
import type { Segment, Word } from "./types.js";

function makeWord(word: string, start: number, end: number): Word {
  return { word, start, end };
}

function makeSegment(text: string, start: number, end: number, words: Word[]): Segment {
  return { text, start, end, words };
}

describe("chunkSegments", () => {
  it("returns empty array for empty segments", () => {
    expect(chunkSegments([])).toEqual([]);
  });

  it("creates chunk from segment with text but no words", () => {
    const segments: Segment[] = [
      makeSegment("Hello world", 0, 1, []),
    ];
    const result = chunkSegments(segments);
    expect(result).toEqual([
      { start: 0, end: 1, text: "Hello world", words: [] },
    ]);
  });

  it("skips segment with empty text and no words", () => {
    const segments: Segment[] = [
      makeSegment("   ", 0, 1, []),
    ];
    const result = chunkSegments(segments);
    expect(result).toEqual([]);
  });

  it("produces one chunk from a single word segment", () => {
    const words = [makeWord("Hello", 0, 0.5)];
    const segments = [makeSegment("Hello", 0, 0.5, words)];
    const result = chunkSegments(segments);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Hello");
    expect(result[0].words).toHaveLength(1);
    expect(result[0].start).toBe(0);
    expect(result[0].end).toBe(0.5);
  });

  describe("tikdance:portrait limits (maxWords=3, maxChars=16)", () => {
    it("splits by maxWords when exceeded", () => {
      const words = [
        makeWord("one", 0.0, 0.2),
        makeWord("two", 0.3, 0.5),
        makeWord("three", 0.6, 0.8),
        makeWord("four", 0.9, 1.1),
      ];
      const segments = [makeSegment("one two three four", 0, 1.1, words)];
      const result = chunkSegments(segments, "portrait", "tikdance");

      // maxWords=3 so 4th word triggers split after 3 words
      expect(result.length).toBeGreaterThanOrEqual(2);
      // First chunk should have at most 3 words
      expect(result[0].words.length).toBeLessThanOrEqual(3);
    });

    it("splits by maxChars when text exceeds 16 chars", () => {
      const words = [
        makeWord("longword1234", 0.0, 0.5),
        makeWord("extra", 0.6, 1.0),
      ];
      const segments = [makeSegment("longword1234 extra", 0, 1.0, words)];
      const result = chunkSegments(segments, "portrait", "tikdance");

      // "longword1234 extra" is 18 chars > 16, so second word triggers split
      expect(result.length).toBe(2);
      expect(result[0].text).toBe("longword1234");
      expect(result[1].text).toBe("extra");
    });
  });

  it("splits at sentence boundaries (period)", () => {
    const words = [
      makeWord("Hi.", 0.0, 0.3),
      makeWord("Bye.", 0.4, 0.7),
    ];
    const segments = [makeSegment("Hi. Bye.", 0, 0.7, words)];
    const result = chunkSegments(segments);

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("Hi.");
    expect(result[1].text).toBe("Bye.");
  });

  it("splits at sentence boundaries (exclamation mark)", () => {
    const words = [
      makeWord("Wow!", 0.0, 0.3),
      makeWord("Cool", 0.4, 0.7),
    ];
    const segments = [makeSegment("Wow! Cool", 0, 0.7, words)];
    const result = chunkSegments(segments);

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("Wow!");
    expect(result[1].text).toBe("Cool");
  });

  it("splits at sentence boundaries (question mark)", () => {
    const words = [
      makeWord("Really?", 0.0, 0.3),
      makeWord("Yes", 0.4, 0.7),
    ];
    const segments = [makeSegment("Really? Yes", 0, 0.7, words)];
    const result = chunkSegments(segments);

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("Really?");
    expect(result[1].text).toBe("Yes");
  });

  describe("different orientations", () => {
    it("landscape tikdance allows more words (maxWords=5)", () => {
      const words = [
        makeWord("a", 0.0, 0.1),
        makeWord("b", 0.2, 0.3),
        makeWord("c", 0.4, 0.5),
        makeWord("d", 0.6, 0.7),
        makeWord("e", 0.8, 0.9),
      ];
      const segments = [makeSegment("a b c d e", 0, 0.9, words)];
      const result = chunkSegments(segments, "landscape", "tikdance");

      // 5 words fits within landscape maxWords=5
      expect(result).toHaveLength(1);
      expect(result[0].words).toHaveLength(5);
    });

    it("portrait tikdance splits 5 words into multiple chunks (maxWords=3)", () => {
      const words = [
        makeWord("a", 0.0, 0.1),
        makeWord("b", 0.2, 0.3),
        makeWord("c", 0.4, 0.5),
        makeWord("d", 0.6, 0.7),
        makeWord("e", 0.8, 0.9),
      ];
      const segments = [makeSegment("a b c d e", 0, 0.9, words)];
      const result = chunkSegments(segments, "portrait", "tikdance");

      expect(result.length).toBeGreaterThan(1);
    });

    it("square orientation uses landscape values (maxWords=5 for tikdance)", () => {
      const words = [
        makeWord("a", 0.0, 0.1),
        makeWord("b", 0.2, 0.3),
        makeWord("c", 0.4, 0.5),
        makeWord("d", 0.6, 0.7),
        makeWord("e", 0.8, 0.9),
      ];
      const segments = [makeSegment("a b c d e", 0, 0.9, words)];
      const result = chunkSegments(segments, "square", "tikdance");

      // square tikdance = [30, 5], so 5 words fits
      expect(result).toHaveLength(1);
      expect(result[0].words).toHaveLength(5);
    });
  });

  describe("different styles", () => {
    it("highlight:portrait allows more words (maxWords=8) and chars (40)", () => {
      const words = [
        makeWord("one", 0.0, 0.1),
        makeWord("two", 0.2, 0.3),
        makeWord("three", 0.4, 0.5),
        makeWord("four", 0.6, 0.7),
        makeWord("five", 0.8, 0.9),
        makeWord("six", 1.0, 1.1),
        makeWord("seven", 1.2, 1.3),
        makeWord("eight", 1.4, 1.5),
      ];
      // "one two three four five six seven eight" = 39 chars, fits in 40
      const segments = [makeSegment("one two three four five six seven eight", 0, 1.5, words)];
      const result = chunkSegments(segments, "portrait", "highlight");

      expect(result).toHaveLength(1);
      expect(result[0].words).toHaveLength(8);
    });

    it("highlight:landscape allows maxWords=12 and maxChars=60", () => {
      const words: Word[] = [];
      for (let i = 0; i < 12; i++) {
        words.push(makeWord("hi", i * 0.1, i * 0.1 + 0.05));
      }
      const text = words.map((w) => w.word).join(" ");
      const segments = [makeSegment(text, 0, 1.2, words)];
      const result = chunkSegments(segments, "landscape", "highlight");

      expect(result).toHaveLength(1);
      expect(result[0].words).toHaveLength(12);
    });
  });

  it("splits long segments exceeding MAX_DURATION (6s)", () => {
    // Three words each 3 seconds apart = total 9 seconds
    const words = [
      makeWord("first", 0.0, 1.0),
      makeWord("second", 3.0, 4.0),
      makeWord("third", 7.0, 8.0),
    ];
    const segments = [makeSegment("first second third", 0, 8.0, words)];
    // Use highlight:landscape with generous word/char limits so only duration triggers
    const result = chunkSegments(segments, "landscape", "highlight");

    // "third" starts at 7.0, chunkStart=0.0 => duration=8.0 > 6.0, triggers split
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves word timing in chunks", () => {
    const words = [
      makeWord("Hello", 1.0, 1.5),
      makeWord("there.", 1.6, 2.0),
    ];
    const segments = [makeSegment("Hello there.", 1.0, 2.0, words)];
    const result = chunkSegments(segments);

    expect(result).toHaveLength(1);
    expect(result[0].start).toBe(1.0);
    expect(result[0].end).toBe(2.0);
    expect(result[0].words[0]).toEqual({ word: "Hello", start: 1.0, end: 1.5 });
    expect(result[0].words[1]).toEqual({ word: "there.", start: 1.6, end: 2.0 });
  });

  it("handles multiple segments", () => {
    const seg1 = makeSegment("Hi.", 0, 0.5, [makeWord("Hi.", 0, 0.5)]);
    const seg2 = makeSegment("Bye.", 1, 1.5, [makeWord("Bye.", 1, 1.5)]);
    const result = chunkSegments([seg1, seg2]);

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("Hi.");
    expect(result[1].text).toBe("Bye.");
  });

  it("defaults orientation to portrait and style to tikdance", () => {
    const words = [
      makeWord("a", 0.0, 0.1),
      makeWord("b", 0.2, 0.3),
      makeWord("c", 0.4, 0.5),
      makeWord("d", 0.6, 0.7),
    ];
    const segments = [makeSegment("a b c d", 0, 0.7, words)];

    // Default = tikdance:portrait = maxWords 3
    const result = chunkSegments(segments);
    expect(result.length).toBeGreaterThan(1);
  });
});
