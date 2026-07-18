import { describe, expect, it } from "vitest";
import {
  parseKeywordTranscript,
  selectKeywordGraphics,
  selectRequestedKeywordGraphics,
} from "./keyword-graphics.js";
import type { Segment } from "./subtitles/types.js";

function segment(words: Array<{ word: string; start: number; end: number }>): Segment {
  return {
    start: words[0]?.start ?? 0,
    end: words.at(-1)?.end ?? 0,
    text: words.map((word) => word.word).join(" "),
    words,
  };
}

describe("selectKeywordGraphics", () => {
  it("selects unique meaningful words with non-overlapping linger windows", () => {
    const graphics = selectKeywordGraphics([
      segment([
        { word: "The", start: 0, end: 0.2 },
        { word: "revolution", start: 0.5, end: 0.9 },
        { word: "begins", start: 1.1, end: 1.4 },
        { word: "cinema", start: 4, end: 4.4 },
        { word: "revolution", start: 7.5, end: 8 },
        { word: "vengeance", start: 11, end: 11.5 },
        { word: "impossible", start: 14.5, end: 15 },
      ]),
    ], { maxCount: 4, lingerSeconds: 2.4 });

    expect(graphics).toHaveLength(4);
    expect(new Set(graphics.map((graphic) => graphic.text.toLowerCase())).size).toBe(4);
    expect(graphics.map((graphic) => graphic.side)).toEqual(["right", "left", "right", "left"]);
    for (let index = 0; index < graphics.length - 1; index++) {
      expect(graphics[index].end).toBeLessThan(graphics[index + 1].start);
    }
    expect(graphics.at(-1)?.end).toBeCloseTo(17.4);
  });

  it("returns no graphics when the transcript contains no usable content words", () => {
    const graphics = selectKeywordGraphics([
      segment([
        { word: "the", start: 0, end: 0.2 },
        { word: "and", start: 1, end: 1.2 },
        { word: "to", start: 2, end: 2.2 },
      ]),
    ]);

    expect(graphics).toEqual([]);
  });

  it("honors the keyword count and timing bounds", () => {
    const graphics = selectKeywordGraphics([
      segment([
        { word: "alpha", start: 0, end: 0.3 },
        { word: "bravo", start: 6, end: 6.3 },
        { word: "delta", start: 12, end: 12.3 },
      ]),
    ], { maxCount: 2, lingerSeconds: 10 });

    expect(graphics).toHaveLength(2);
    expect(graphics[0].start).toBe(0);
    expect(graphics.at(-1)!.end - 6.3).toBeCloseTo(5);
  });

  it("keeps short uppercase acronyms", () => {
    const graphics = selectKeywordGraphics([
      segment([{ word: "AI", start: 2, end: 2.3 }]),
    ]);

    expect(graphics[0].text).toBe("AI");
  });
});

describe("selectRequestedKeywordGraphics", () => {
  it("matches exact words case-insensitively and orders cues by transcript time", () => {
    const result = selectRequestedKeywordGraphics([
      segment([
        { word: "Revolution", start: 1.059, end: 1.839 },
        { word: "multicultural", start: 3.079, end: 3.959 },
        { word: "revolution", start: 4.059, end: 4.659 },
        { word: "success", start: 6.679, end: 7.239 },
      ]),
    ], ["Multicultural", "Revolution", "Success"], { lingerSeconds: 2.4 });

    expect(result.missing).toEqual([]);
    expect(result.graphics.map((graphic) => graphic.text)).toEqual([
      "Revolution",
      "Multicultural",
      "Success",
    ]);
    expect(result.graphics.map((graphic) => graphic.start)).toEqual([
      expect.closeTo(0.939),
      expect.closeTo(2.959),
      expect.closeTo(6.559),
    ]);
    for (let index = 0; index < result.graphics.length - 1; index++) {
      expect(result.graphics[index].end).toBeLessThan(result.graphics[index + 1].start);
    }
  });

  it("reports requested words missing from the timed transcript", () => {
    const result = selectRequestedKeywordGraphics([
      segment([{ word: "cinema", start: 1, end: 1.4 }]),
    ], ["Cinema", "Vengeance"]);

    expect(result.graphics.map((graphic) => graphic.text)).toEqual(["Cinema"]);
    expect(result.missing).toEqual(["Vengeance"]);
  });
});

describe("parseKeywordTranscript", () => {
  it("reads the first transcript from a multichannel response", () => {
    const segments = parseKeywordTranscript({
      transcripts: [{
        words: [
          { text: "cinema", start: 1, end: 1.4, type: "word" },
          { text: " ", start: 1.4, end: 1.5, type: "spacing" },
        ],
      }],
    });

    expect(segments).toHaveLength(1);
    expect(segments[0].words).toEqual([{ word: "cinema", start: 1, end: 1.4 }]);
  });
});
