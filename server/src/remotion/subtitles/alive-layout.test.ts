import { describe, expect, it } from "vitest";
import {
  ALIVE_GLYPH_EM,
  activeCue,
  buildPhraseLines,
  displayWord,
  fitStack,
  freeSpans,
  placeColumn,
  punchWord,
  regionToTarget,
  resolveAliveCues,
  splitLines,
  splitPhrases,
  stackHeight,
  wordLook,
  wordTiming,
} from "./alive-layout.js";
import type { PhraseWordInput } from "./alive-layout.js";
import type { AlivePhrase, AliveSettings, AliveWord, FrameGeometry } from "./alive-types.js";
import { DEFAULT_ALIVE_SETTINGS } from "./alive-types.js";

const LANDSCAPE: FrameGeometry = { sourceWidth: 1920, sourceHeight: 1080, targetWidth: 1920, targetHeight: 1080 };
const PORTRAIT_OF_LANDSCAPE: FrameGeometry = { sourceWidth: 1920, sourceHeight: 1080, targetWidth: 1080, targetHeight: 1920 };

function input(raw: string, start: number, end: number, energy = 0.5, onsetStart = start): PhraseWordInput {
  return { raw, start, end, onsetStart, energy };
}

function word(text: string, start: number, end: number, energy = 0.5, onsetStart = start): AliveWord {
  return { text, transcriptStart: start, transcriptEnd: end, onsetStart, energy };
}

function phrase(id: string, lines: AliveWord[][], regions: AlivePhrase["regions"] = []): AlivePhrase {
  return { id, frameTime: lines[0][0].transcriptStart, regions, lines };
}

const FACE_RIGHT = { kind: "face" as const, confidence: 0.94, x: 0.58, y: 0.16, width: 0.2, height: 0.42 };
const FACE_LEFT = { kind: "face" as const, confidence: 0.91, x: 0.2, y: 0.12, width: 0.2, height: 0.44 };
const SIGN_TOP_LEFT = { kind: "text" as const, confidence: 0.97, x: 0.06, y: 0.07, width: 0.3, height: 0.15 };

describe("alive caption phrasing", () => {
  it("strips edge punctuation but keeps apostrophes", () => {
    expect(displayWord("burning,")).toBe("burning");
    expect(displayWord("\"don't!\"")).toBe("don't");
    expect(displayWord("—")).toBe("");
  });

  it("breaks phrases on sentence ends, pauses, and length", () => {
    const phrases = splitPhrases([
      input("We", 0.4, 0.62), input("were", 0.62, 0.9), input("burning.", 0.95, 1.7),
      input("never", 3.0, 3.35), input("sleeping", 3.35, 4.1),
      input("till", 4.9, 5.0),
    ]);
    expect(phrases.map((group) => group.map((item) => item.raw))).toEqual([
      ["We", "were", "burning."],
      ["never", "sleeping"],
      ["till"],
    ]);
  });

  it("stacks short lines and gives loud long words their own line", () => {
    const lines = splitLines([
      word("we", 0, 0.2), word("were", 0.2, 0.4), word("burning", 0.4, 1, 0.95),
      word("like", 1, 1.1), word("the", 1.1, 1.2), word("city", 1.2, 1.5),
    ]);
    expect(lines.map((line) => line.map((item) => item.text))).toEqual([
      ["we", "were"], ["burning"], ["like", "the"], ["city"],
    ]);
  });

  it("splits phrases longer than four lines and drops empty words", () => {
    const words = ["one", "two", "three", "four", "five", "six", "seven", "eight"]
      .map((text, index) => input(text, index * 0.3, index * 0.3 + 0.25, 0.9));
    const phrases = buildPhraseLines([[...words, input("…", 2.5, 2.6)]]);
    expect(phrases).toHaveLength(2);
    expect(phrases[0]).toHaveLength(4);
    expect(phrases.flat(2).map((item) => item.text)).not.toContain("…");
  });
});

describe("alive caption timing", () => {
  it("shifts a word to its onset while keeping its duration", () => {
    const late = word("burning", 0.998, 1.748, 0.9, 0.95);
    expect(wordTiming(late, false)).toMatchObject({ start: 0.998, end: 1.748 });
    const snapped = wordTiming(late, true);
    expect(snapped.start).toBeCloseTo(0.95);
    expect(snapped.end).toBeCloseTo(1.7);
  });

  it("builds non-overlapping cue windows that hold after the last word", () => {
    const cues = resolveAliveCues([
      phrase("p1", [[word("we", 0.4, 0.6)], [word("burn", 0.6, 1.0)]]),
      phrase("p2", [[word("never", 1.2, 1.5)]]),
      phrase("p3", [[word("sleep", 3, 3.4)]]),
    ], DEFAULT_ALIVE_SETTINGS, LANDSCAPE);
    expect(cues[0].start).toBeCloseTo(0.34);
    expect(cues[0].end).toBeCloseTo(1.14);
    expect(cues[1].end).toBeCloseTo(2.0);
    expect(cues[2].end).toBeCloseTo(3.9);
    expect(activeCue(cues, 1.3)?.id).toBe("p2");
    expect(activeCue(cues, 2.5)).toBeNull();
  });

  it("reveals words on their start with the chosen entrance and hit color", () => {
    const settings: AliveSettings = { ...DEFAULT_ALIVE_SETTINGS, motion: "pop" };
    const loud = { text: "burning", start: 1, end: 1.7, energy: 0.95 };
    expect(wordLook(loud, 0.99, settings, 100, 1).opacity).toBe(0);
    const entering = wordLook(loud, 1.03, settings, 100, 1);
    expect(entering.opacity).toBeGreaterThan(0);
    expect(entering.opacity).toBeLessThan(1);
    expect(entering.scale).toBeGreaterThan(1);
    const landed = wordLook(loud, 1.5, settings, 100, 1);
    expect(landed).toMatchObject({ opacity: 1, scale: 1, translateY: 0, color: settings.hitColor });
    const quietAfter = wordLook({ ...loud, energy: 0.3 }, 1.8, settings, 100, 1);
    expect(quietAfter.color).toBe(settings.textColor);
  });

  it("shows unsung karaoke words dimmed rather than hidden", () => {
    const settings: AliveSettings = { ...DEFAULT_ALIVE_SETTINGS, style: "karaoke" };
    expect(wordLook({ text: "city", start: 2, end: 2.5, energy: 0.5 }, 1, settings, 80, 1).opacity).toBeCloseTo(0.3);
  });

  it("punches the most recently started word", () => {
    const [cue] = resolveAliveCues([phrase("p1", [[word("hold", 5.8, 6.1)], [word("on", 6.1, 6.4)]])], DEFAULT_ALIVE_SETTINGS, LANDSCAPE);
    expect(punchWord(cue, 5.7)).toBeNull();
    expect(punchWord(cue, 6.2)?.text).toBe("on");
  });
});

describe("alive caption placement", () => {
  it("stacks on the side away from the face", () => {
    expect(placeColumn([FACE_RIGHT], LANDSCAPE).side).toBe("left");
    expect(placeColumn([FACE_LEFT], LANDSCAPE).side).toBe("right");
  });

  it("drops the stack below on-screen text that shares its column", () => {
    const column = placeColumn([FACE_RIGHT, SIGN_TOP_LEFT], LANDSCAPE);
    expect(column.side).toBe("left");
    expect(column.y / LANDSCAPE.targetHeight).toBeGreaterThanOrEqual(SIGN_TOP_LEFT.y + SIGN_TOP_LEFT.height);
  });

  it("uses the blurred band under a letterboxed landscape source in portrait", () => {
    const face = regionToTarget({ x: 0.4, y: 0.2, width: 0.2, height: 0.5 }, PORTRAIT_OF_LANDSCAPE);
    const column = placeColumn([face], PORTRAIT_OF_LANDSCAPE);
    expect(column.side).toBe("center");
    const top = column.y / PORTRAIT_OF_LANDSCAPE.targetHeight;
    const bottom = top + column.height / PORTRAIT_OF_LANDSCAPE.targetHeight;
    expect(bottom <= face.y || top >= face.y + face.height).toBe(true);
  });

  it("ignores avoidance when the setting is off", () => {
    const settings: AliveSettings = { ...DEFAULT_ALIVE_SETTINGS, avoidFaces: false };
    const [cue] = resolveAliveCues([phrase("p2", [[word("never", 3, 3.3)]], [FACE_LEFT])], settings, LANDSCAPE);
    expect(cue.column.side).toBe("left");
  });

  it("computes free vertical spans around blockers", () => {
    expect(freeSpans({ y0: 0.1, y1: 0.9 }, [{ y0: 0.3, y1: 0.5 }, { y0: 0.45, y1: 0.6 }])).toEqual([
      { y0: 0.1, y1: 0.3 },
      { y0: 0.6, y1: 0.9 },
    ]);
  });
});

describe("alive stack fitting", () => {
  const column = { side: "left" as const, x: 115, y: 108, width: 787, height: 864 };
  const lines = [
    [{ text: "we", start: 0, end: 0.2, energy: 0.3 }, { text: "were", start: 0.2, end: 0.4, energy: 0.35 }],
    [{ text: "burning", start: 0.4, end: 1, energy: 0.95 }],
    [{ text: "like", start: 1, end: 1.1, energy: 0.3 }, { text: "the", start: 1.1, end: 1.2, energy: 0.2 }, { text: "city", start: 1.2, end: 1.5, energy: 0.8 }],
  ];

  it("keeps every line inside the column", () => {
    const fitted = fitStack(lines, column, true);
    for (const line of fitted) {
      const text = line.words.map((item) => item.text).join(" ");
      expect(text.length * ALIVE_GLYPH_EM * line.fontSize).toBeLessThanOrEqual(column.width + 1);
    }
    expect(stackHeight(fitted.map((line) => line.fontSize))).toBeLessThanOrEqual(column.height + 1);
  });

  it("makes the loud line biggest with energy sizing and uniform without it", () => {
    const sized = fitStack(lines, column, true).map((line) => line.fontSize);
    expect(sized[1]).toBeGreaterThan(sized[0]);
    const uniform = new Set(fitStack(lines, column, false).map((line) => line.fontSize));
    expect(uniform.size).toBe(1);
  });
});
