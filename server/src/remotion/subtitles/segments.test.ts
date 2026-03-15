import { describe, it, expect } from "vitest";
import { parseSegments } from "./segments.js";

describe("parseSegments", () => {
  it("returns empty array for empty input", () => {
    expect(parseSegments({})).toEqual([]);
  });

  it("returns empty array when segments and words are both empty arrays", () => {
    expect(parseSegments({ segments: [], words: [] })).toEqual([]);
  });

  it("maps segments array to Segment[]", () => {
    const data = {
      segments: [
        {
          text: "Hello world",
          start: 0,
          end: 1.5,
          words: [
            { text: "Hello", start: 0, end: 0.5, type: "word" },
            { text: "world", start: 0.6, end: 1.5, type: "word" },
          ],
        },
      ],
    };
    const result = parseSegments(data);

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Hello world");
    expect(result[0].start).toBe(0);
    expect(result[0].end).toBe(1.5);
    expect(result[0].words).toHaveLength(2);
    expect(result[0].words[0]).toEqual({ word: "Hello", start: 0, end: 0.5 });
    expect(result[0].words[1]).toEqual({ word: "world", start: 0.6, end: 1.5 });
  });

  it("creates single segment from words array when no segments present", () => {
    const data = {
      words: [
        { text: "Hello", start: 0, end: 0.5, type: "word" },
        { text: "world", start: 0.6, end: 1.0, type: "word" },
      ],
    };
    const result = parseSegments(data);

    expect(result).toHaveLength(1);
    expect(result[0].start).toBe(0);
    expect(result[0].end).toBe(1.0);
    expect(result[0].text).toBe("Hello world");
    expect(result[0].words).toHaveLength(2);
  });

  it("filters out non-word type entries from segments.words", () => {
    const data = {
      segments: [
        {
          text: "Hello world",
          start: 0,
          end: 1.5,
          words: [
            { text: "Hello", start: 0, end: 0.5, type: "word" },
            { text: " ", start: 0.5, end: 0.6, type: "spacing" },
            { text: "world", start: 0.6, end: 1.5, type: "word" },
          ],
        },
      ],
    };
    const result = parseSegments(data);

    expect(result[0].words).toHaveLength(2);
    expect(result[0].words[0].word).toBe("Hello");
    expect(result[0].words[1].word).toBe("world");
  });

  it("filters out non-word type entries from top-level words array", () => {
    const data = {
      words: [
        { text: "Hello", start: 0, end: 0.5, type: "word" },
        { text: ",", start: 0.5, end: 0.5, type: "punctuation" },
        { text: "world", start: 0.6, end: 1.0, type: "word" },
      ],
    };
    const result = parseSegments(data);

    expect(result).toHaveLength(1);
    expect(result[0].words).toHaveLength(2);
  });

  it("defaults missing text/start/end on segments", () => {
    const data = {
      segments: [
        {
          words: [
            { text: "Hi", start: 0.1, end: 0.5, type: "word" },
          ],
        },
      ],
    };
    const result = parseSegments(data);

    expect(result[0].text).toBe("");
    expect(result[0].start).toBe(0);
    expect(result[0].end).toBe(0);
    expect(result[0].words).toHaveLength(1);
  });

  it("defaults missing start/end on words to 0", () => {
    const data = {
      words: [
        { text: "Hello", type: "word" },
      ],
    };
    const result = parseSegments(data);

    expect(result[0].words[0]).toEqual({ word: "Hello", start: 0, end: 0 });
  });

  it("handles .word field on word objects (instead of .text)", () => {
    const data = {
      words: [
        { word: "Hello", start: 0, end: 0.5, type: "word" },
        { word: "world", start: 0.6, end: 1.0, type: "word" },
      ],
    };
    const result = parseSegments(data);

    expect(result).toHaveLength(1);
    expect(result[0].words[0].word).toBe("Hello");
    expect(result[0].words[1].word).toBe("world");
  });

  it("returns empty when words array has only non-word types", () => {
    const data = {
      words: [
        { text: " ", start: 0, end: 0.1, type: "spacing" },
        { text: ",", start: 0.1, end: 0.2, type: "punctuation" },
      ],
    };
    const result = parseSegments(data);
    expect(result).toEqual([]);
  });

  it("filters out words with empty text after trim", () => {
    const data = {
      words: [
        { text: "  ", start: 0, end: 0.1, type: "word" },
        { text: "hello", start: 0.2, end: 0.5, type: "word" },
      ],
    };
    const result = parseSegments(data);

    expect(result).toHaveLength(1);
    expect(result[0].words).toHaveLength(1);
    expect(result[0].words[0].word).toBe("hello");
  });

  it("filters out words with no text or word field", () => {
    const data = {
      words: [
        { start: 0, end: 0.1, type: "word" },
        { text: "hello", start: 0.2, end: 0.5, type: "word" },
      ],
    };
    const result = parseSegments(data);

    expect(result[0].words).toHaveLength(1);
    expect(result[0].words[0].word).toBe("hello");
  });

  it("prefers segments over words when both are present", () => {
    const data = {
      segments: [
        {
          text: "From segments",
          start: 0,
          end: 1.0,
          words: [{ text: "From", start: 0, end: 0.5, type: "word" }],
        },
      ],
      words: [
        { text: "From", start: 0, end: 0.5, type: "word" },
        { text: "words", start: 0.6, end: 1.0, type: "word" },
      ],
    };
    const result = parseSegments(data);

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("From segments");
  });

  it("treats missing type as 'word' (default)", () => {
    const data = {
      words: [
        { text: "hello", start: 0, end: 0.5 },
      ],
    };
    const result = parseSegments(data);

    expect(result).toHaveLength(1);
    expect(result[0].words).toHaveLength(1);
    expect(result[0].words[0].word).toBe("hello");
  });

  it("handles segment with no words array", () => {
    const data = {
      segments: [
        { text: "Standalone text", start: 0, end: 2.0 },
      ],
    };
    const result = parseSegments(data);

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Standalone text");
    expect(result[0].words).toEqual([]);
  });

  it("trims segment text", () => {
    const data = {
      segments: [
        { text: "  spaced  ", start: 0, end: 1.0, words: [] },
      ],
    };
    const result = parseSegments(data);
    expect(result[0].text).toBe("spaced");
  });

  it("handles multiple segments", () => {
    const data = {
      segments: [
        {
          text: "First",
          start: 0,
          end: 1.0,
          words: [{ text: "First", start: 0, end: 1.0, type: "word" }],
        },
        {
          text: "Second",
          start: 1.5,
          end: 2.5,
          words: [{ text: "Second", start: 1.5, end: 2.5, type: "word" }],
        },
      ],
    };
    const result = parseSegments(data);

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("First");
    expect(result[1].text).toBe("Second");
  });
});
