import { describe, expect, it } from "vitest";
import { joinUnspacedLetters, splitUnspacedText } from "./transcript-words.js";

function letters(texts: readonly string[], start: number, step: number) {
  return texts.map((text, index) => ({ text, start: start + index * step, end: start + (index + 1) * step, type: "word" }));
}

describe("unspaced transcript words", () => {
  it("merges ElevenLabs Thai letters into words spanning their letters' timing", () => {
    const words = joinUnspacedLetters(letters(["ฉั", "น", "ช", "อ", "บ", "กิ", "น", "ข้", "า", "ว", "ม", "า", "ก"], 0, 0.25));
    expect(words.map((word) => word.text)).toEqual(["ฉัน", "ชอบ", "กิน", "ข้าว", "มาก"]);
    expect(words[1]).toEqual({ text: "ชอบ", start: 0.5, end: 1.25, type: "word" });
  });

  it("ends a run of letters at spacing and audio events and leaves spaced words alone", () => {
    const tokens = [
      ...letters(["แ", "ม", "ว"], 0, 0.25),
      { text: " ", start: 0.75, end: 0.75, type: "spacing" },
      ...letters(["น", "อ", "น"], 1, 0.25),
      { text: "[laughter]", start: 1.75, end: 2, type: "audio_event" },
      { text: "Hello", start: 2, end: 2.5, type: "word" },
      { text: "world", start: 2.5, end: 3, type: "word" },
    ];
    expect(joinUnspacedLetters(tokens).map((token) => [token.text, token.type])).toEqual([
      ["แมว", "word"],
      [" ", "spacing"],
      ["นอน", "word"],
      ["[laughter]", "audio_event"],
      ["Hello", "word"],
      ["world", "word"],
    ]);
  });

  it("keeps trailing punctuation with the word before it", () => {
    expect(joinUnspacedLetters(letters(["喝", "牛", "奶", "。"], 0, 0.25)).map((token) => token.text)).toEqual(["喝", "牛奶。"]);
  });

  it("splits unspaced translated text into words", () => {
    expect(splitUnspacedText("ฉันชอบกินข้าวมาก")).toEqual(["ฉัน", "ชอบ", "กิน", "ข้าว", "มาก"]);
    expect(splitUnspacedText("喝牛奶。")).toEqual(["喝", "牛奶。"]);
  });
});
