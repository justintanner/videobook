import { describe, expect, it } from "vitest";
import type { CaptionDocument } from "./model.js";
import { captionDocumentSchema, DEFAULT_CAPTION_STYLE } from "./model.js";
import { applyCaptionEdits, CaptionEditError, captionDocumentProblems, captionDisplayText } from "./edits.js";
import { captionsToSubtitleFile } from "./export.js";
import { styleFromLegacyAliveSettings } from "./legacy.js";
import { captionCase, captionScripts, joinCaptionWords, textDirection } from "./script.js";
import type { CaptionSeedWord } from "./seed.js";
import { reseedCaptionDocument, seedCaptionDocument } from "./seed.js";
import { activeCaptionCue, activeCaptionWord, captionCues, effectiveWordTiming } from "./timing.js";

function word(text: string, start: number, end: number, onset = start, energy = 0.5): CaptionSeedWord {
  return { text, start, end, onset, energy, speaker: null };
}

function seed(words: CaptionSeedWord[], durationSeconds = 20): CaptionDocument {
  return seedCaptionDocument({
    source: { artifactId: "video-1", mediaHash: "hash-1", durationSeconds, width: 1920, height: 1080, fps: 30 },
    bindings: { transcriptKey: "t1", vocalKey: "v1", regionsKey: null, translationKey: null },
    language: "original",
    sourceLanguage: "en",
    wordTiming: "measured",
    words,
  });
}

const SPOKEN = [
  word("We", 0.5, 0.7),
  word("were", 0.7, 0.95),
  word("burning.", 1.05, 1.7, 1.0, 0.9),
  word("Then", 2.5, 2.7),
  word("the", 2.7, 2.8),
  word("night", 2.8, 3.1),
  word("came", 3.1, 3.4),
  word("down,", 3.4, 3.8),
  word("slow", 3.8, 4.1),
  word("and", 4.1, 4.2),
  word("bright", 4.2, 4.6),
];

describe("caption seeding and phrasing", () => {
  it("seeds a valid draft with display text, stable ids and karaoke-sized phrases", () => {
    const document = seed(SPOKEN);
    expect(captionDocumentSchema.parse(document)).toEqual(document);
    expect(captionDocumentProblems(document)).toEqual([]);
    expect(document.words.map((item) => item.id).slice(0, 3)).toEqual(["w1", "w2", "w3"]);
    expect(document.words[2]).toMatchObject({ text: "burning", analysed: { text: "burning.", onset: 1 } });
    expect(document.phrases.map((phrase) => phrase.wordIds.length)).toEqual([3, 5, 3]);
    expect(document.phrases[0].id).toBe(`p${SPOKEN.length + 1}`);
    expect(document.nextId).toBe(SPOKEN.length + document.phrases.length + 1);
    expect(document.style).toEqual(DEFAULT_CAPTION_STYLE);
  });

  it("breaks on long pauses and keeps every phrase within two short lines", () => {
    const words = Array.from({ length: 30 }, (_, index) => word(`word${index}`, index * 0.3, index * 0.3 + 0.25));
    words.push(word("later", 20, 20.4));
    const document = seed(words, 30);
    for (const phrase of document.phrases) {
      const texts = phrase.wordIds.map((id) => document.words.find((item) => item.id === id)!.text);
      expect(joinCaptionWords(texts).length).toBeLessThanOrEqual(28);
      expect(phrase.wordIds.length).toBeLessThanOrEqual(7);
    }
    expect(document.phrases.at(-1)!.wordIds).toEqual([document.words.at(-1)!.id]);
  });

  it("produces an empty but valid draft for silence", () => {
    const document = seed([]);
    expect(document.words).toEqual([]);
    expect(document.phrases).toEqual([]);
    expect(captionDocumentProblems(document)).toEqual([]);
    expect(captionCues(document)).toEqual([]);
    expect(captionsToSubtitleFile(document, "srt")).toBe("");
  });

  it("handles non-Latin scripts: unspaced joining, short CJK phrases, RTL and locale casing", () => {
    const japanese = seed(["今日", "は", "とても", "いい", "天気", "です", "ね", "本当", "に"].map((text, index) => word(text, index * 0.3, index * 0.3 + 0.28)));
    const firstPhrase = japanese.phrases[0].wordIds.map((id) => japanese.words.find((item) => item.id === id)!.text);
    expect(joinCaptionWords(firstPhrase)).not.toContain(" ");
    expect(joinCaptionWords(firstPhrase).length).toBeLessThanOrEqual(14);
    expect(japanese.phrases.length).toBeGreaterThan(1);
    expect(captionScripts("今日はいい天気", null)).toEqual(new Set(["japanese"]));
    expect(captionScripts("你好世界", "zh")).toEqual(new Set(["chinese"]));
    expect(textDirection("مرحبا بالعالم")).toBe("rtl");
    expect(textDirection("hello")).toBe("ltr");
    expect(captionCase("istanbul", true, "tr")).toBe("İSTANBUL");
    expect(captionCase("你好", true, "zh")).toBe("你好");
    expect(joinCaptionWords(["Hello", "世界", "again"])).toBe("Hello 世界 again");
  });

  it("strips trailing clause punctuation for display but keeps questions", () => {
    expect(captionDisplayText(" down, ")).toBe("down");
    expect(captionDisplayText("really?")).toBe("really?");
    expect(captionDisplayText("...")).toBe("...");
  });
});

describe("caption timing", () => {
  it("snaps uncorrected words to onsets, never corrected ones, and applies the global offset", () => {
    const document = seed(SPOKEN);
    const burning = document.words[2];
    expect(effectiveWordTiming(burning, document.style)).toEqual({ start: 1, end: 1.65 });
    expect(effectiveWordTiming(burning, { ...document.style, snapToOnsets: false })).toEqual({ start: 1.05, end: 1.7 });
    const corrected = applyCaptionEdits(document, [{ op: "set_word_timing", word_id: burning.id, start: 1.1, end: 1.6 }]);
    expect(effectiveWordTiming(corrected.words[2], corrected.style)).toEqual({ start: 1.1, end: 1.6 });
    const offset = applyCaptionEdits(document, [{ op: "set_style", style: { offsetMs: 250 } }]);
    expect(effectiveWordTiming(offset.words[0], offset.style).start).toBeCloseTo(0.75, 6);
  });

  it("builds cue windows that lead, hold and never overlap the next phrase", () => {
    const document = seed(SPOKEN);
    const cues = captionCues(document);
    expect(cues).toHaveLength(3);
    expect(cues[0].start).toBeCloseTo(0.44, 6);
    expect(cues[0].end).toBeCloseTo(1.65 + 0.6, 6);
    expect(cues[1].end).toBeCloseTo(cues[2].start, 6);
    expect(cues[0].end).toBeLessThanOrEqual(cues[1].start);
    expect(cues[2].end).toBeCloseTo(4.6 + 0.6, 6);
    expect(activeCaptionCue(cues, 1.2)?.phraseId).toBe(cues[0].phraseId);
    expect(activeCaptionCue(cues, 10)).toBeNull();
    expect(activeCaptionWord(cues[0], 0.75)?.text).toBe("were");
    expect(activeCaptionWord(cues[0], 0.3)).toBeNull();
  });
});

describe("caption edits", () => {
  it("corrects, resets, hides and inserts words while keeping phrases ordered", () => {
    const document = seed(SPOKEN);
    const edited = applyCaptionEdits(document, [
      { op: "set_word_text", word_id: "w2", text: "  are  " },
      { op: "hide_word", word_id: "w1", hidden: true },
      { op: "insert_word", after_word_id: "w3", text: "now", start: 1.75, end: 1.95 },
    ]);
    expect(edited.words[1]).toMatchObject({ text: "are", textCorrected: true });
    expect(edited.words[0].hidden).toBe(true);
    expect(edited.words[3]).toMatchObject({ id: `w${document.nextId}`, text: "now", analysed: null });
    expect(edited.phrases[0].wordIds).toEqual(["w1", "w2", "w3", `w${document.nextId}`]);
    expect(captionCues(edited)[0].words.map((item) => item.text)).toEqual(["are", "burning", "now"]);
    const reset = applyCaptionEdits(edited, [{ op: "reset_word", word_id: "w2" }, { op: "hide_word", word_id: "w1", hidden: false }]);
    expect(reset.words[1]).toMatchObject({ text: "were", textCorrected: false });
    expect(captionDocumentProblems(reset)).toEqual([]);
  });

  it("splits and merges phrases and stores positions per aspect", () => {
    const document = seed(SPOKEN);
    const split = applyCaptionEdits(document, [{ op: "split_phrase", word_id: "w2" }]);
    expect(split.phrases.map((phrase) => phrase.wordIds)).toEqual([["w1"], ["w2", "w3"], ...document.phrases.slice(1).map((phrase) => phrase.wordIds)]);
    const merged = applyCaptionEdits(split, [{ op: "merge_phrase", phrase_id: split.phrases[0].id }]);
    expect(merged.phrases[0].wordIds).toEqual(["w1", "w2", "w3"]);
    const positioned = applyCaptionEdits(merged, [
      { op: "set_position", y: 0.4 },
      { op: "set_phrase_position", phrase_id: merged.phrases[1].id, aspect: "1:1", y: 0.2 },
    ]);
    expect(positioned.positions).toEqual({ "9:16": 0.4 });
    expect(positioned.phrases[1].positions).toEqual({ "1:1": 0.2 });
    const cleared = applyCaptionEdits(positioned, [{ op: "set_position", y: null }]);
    expect(cleared.positions).toEqual({});
  });

  it("rejects invalid edits with readable errors", () => {
    const document = seed(SPOKEN);
    expect(() => applyCaptionEdits(document, [{ op: "set_word_text", word_id: "w1", text: "  " }])).toThrow(CaptionEditError);
    expect(() => applyCaptionEdits(document, [{ op: "set_word_timing", word_id: "w3", start: 0.1, end: 0.4 }])).toThrow(/starts before/u);
    expect(() => applyCaptionEdits(document, [{ op: "set_word_timing", word_id: "w3", start: 1, end: 1.01 }])).toThrow(/at least/u);
    expect(() => applyCaptionEdits(document, [{ op: "set_word_timing", word_id: "w11", start: 4.2, end: 40 }])).toThrow(/after the video/u);
    expect(() => applyCaptionEdits(document, [{ op: "set_style", style: { textColor: "red" } }])).toThrow(/Invalid subtitle style/u);
    expect(() => applyCaptionEdits(document, [{ op: "split_phrase", word_id: "w1" }])).toThrow(/already starts/u);
    expect(() => applyCaptionEdits(document, [{ op: "set_position", y: 2 }])).toThrow(/between 0 and 1/u);
  });
});

describe("caption reseeding", () => {
  it("keeps every correction, id, phrase and position when the analysis is reseeded", () => {
    const document = applyCaptionEdits(seed(SPOKEN), [
      { op: "set_word_text", word_id: "w2", text: "are" },
      { op: "set_word_timing", word_id: "w6", start: 2.85, end: 3.05 },
      { op: "split_phrase", word_id: "w8" },
      { op: "set_phrase_position", phrase_id: "p13", y: 0.3 },
    ]);
    const fresh = seed(SPOKEN.map((item) => ({ ...item, onset: item.start + 0.01 })));
    const result = reseedCaptionDocument(document, fresh, { realign: false });
    expect(result.kept).toBe(2);
    expect(result.unplaced).toBe(0);
    expect(result.document.words.map((item) => item.id)).toEqual(document.words.map((item) => item.id));
    expect(result.document.words[1]).toMatchObject({ text: "are", textCorrected: true });
    expect(result.document.words[5]).toMatchObject({ start: 2.85, end: 3.05, timingCorrected: true });
    expect(result.document.words[0].analysed?.onset).toBeCloseTo(0.51, 6);
    expect(result.document.phrases.map((phrase) => phrase.wordIds)).toEqual(document.phrases.map((phrase) => phrase.wordIds));
    expect(result.document.phrases.find((phrase) => phrase.id === "p13")?.positions).toEqual({ "9:16": 0.3 });
    expect(captionDocumentProblems(result.document)).toEqual([]);
  });

  it("keeps a corrected misheard word where the new transcript still disagrees", () => {
    const document = applyCaptionEdits(seed(SPOKEN), [{ op: "set_word_text", word_id: "w6", text: "light" }]);
    const changed = SPOKEN.map((item) => (item.text === "night" ? word("knight", 2.8, 3.1) : item));
    const result = reseedCaptionDocument(document, seed(changed), { realign: false });
    const texts = result.document.words.map((item) => item.text);
    expect(texts).toContain("light");
    expect(texts).not.toContain("knight");
    expect(result.document.words.find((item) => item.text === "light")?.id).toBe("w6");
  });

  it("realigns corrections after the source was trimmed", () => {
    const document = applyCaptionEdits(seed(SPOKEN), [
      { op: "set_word_text", word_id: "w10", text: "&" },
      { op: "set_word_timing", word_id: "w9", start: 3.85, end: 4.05 },
    ]);
    const trimmed = SPOKEN.slice(3).map((item) => word(item.text, item.start - 2, item.end - 2, item.onset - 2));
    const result = reseedCaptionDocument(document, seed(trimmed, 18), { realign: true });
    expect(result.shiftSeconds).toBeCloseTo(-2, 6);
    expect(result.document.words.find((item) => item.id === "w10")).toMatchObject({ text: "&" });
    expect(result.document.words.find((item) => item.id === "w9")).toMatchObject({ start: 1.85, end: 2.05 });
    expect(result.document.words.some((item) => item.text === "burning")).toBe(false);
    expect(captionDocumentProblems(result.document)).toEqual([]);
  });
});

describe("caption export and legacy settings", () => {
  it("writes SRT and WebVTT with corrected text and uppercase styling", () => {
    const document = applyCaptionEdits(seed(SPOKEN), [
      { op: "set_word_text", word_id: "w2", text: "are" },
      { op: "set_style", style: { uppercase: true, snapToOnsets: false } },
    ]);
    const srt = captionsToSubtitleFile(document, "srt");
    expect(srt.startsWith("1\n00:00:00,500 --> 00:00:01,700\nWE ARE BURNING\n")).toBe(true);
    expect(srt).toContain("3\n00:00:03,800 --> 00:00:04,600\nSLOW AND BRIGHT\n");
    const vtt = captionsToSubtitleFile(document, "vtt");
    expect(vtt.startsWith("WEBVTT\n\n00:00:00.500 --> 00:00:01.700\nWE ARE BURNING\n")).toBe(true);
  });

  it("maps saved Alive settings onto the caption style", () => {
    expect(styleFromLegacyAliveSettings({ style: "punch", motion: "slam", hitColor: "#72e7aa", avoidFaces: false })).toEqual({
      preset: "punch",
      motion: "slam",
      highlightColor: "#72E7AA",
      avoidFaces: false,
    });
    expect(styleFromLegacyAliveSettings("broken")).toEqual({});
  });
});
