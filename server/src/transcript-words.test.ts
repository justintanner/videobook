import { describe, expect, it } from "vitest";
import { joinUnspacedLetters, splitUnspacedText, textWords } from "./transcript-words.js";

function letters(texts: readonly string[], start: number, step: number) {
  return texts.map((text, index) => ({ text, start: start + index * step, end: start + (index + 1) * step, type: "word" }));
}

describe("unspaced transcript words", () => {
  it("merges ElevenLabs Thai letters into words spanning their letters' timing", () => {
    const words = joinUnspacedLetters(letters(["ฉั", "น", "ช", "อ", "บ", "กิ", "น", "ข้", "า", "ว", "ม", "า", "ก"], 0, 0.25));
    expect(words.map((word) => word.text)).toEqual(["ฉัน", "ชอบ", "กิน", "ข้าว", "มาก"]);
    expect(words[1]).toEqual({ text: "ชอบ", start: 0.5, end: 1.25, type: "word" });
  });

  it("finds the same words whether a provider splits Thai by code point or by grapheme", () => {
    const text = "นี่คือสวนสนุกร้างที่ไม่มีใครมานานแล้ว";
    const words = ["นี่", "คือ", "สวน", "สนุก", "ร้าง", "ที่", "ไม่มี", "ใคร", "มา", "นาน", "แล้ว"];
    const graphemes = [...new Intl.Segmenter("th", { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
    expect(joinUnspacedLetters(letters([...text], 0, 0.05)).map((word) => word.text)).toEqual(words);
    expect(joinUnspacedLetters(letters(graphemes, 0, 0.05)).map((word) => word.text)).toEqual(words);
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

  it("keeps Thai syllables whole where the dictionary has no word for them", () => {
    const words = splitUnspacedText("ลงสไลเดอร์เลยเหรอเนี่ย");
    expect(words.join("")).toBe("ลงสไลเดอร์เลยเหรอเนี่ย");
    expect(words).toContain("เหรอ");
    expect(words.some((word) => /^(?:อร์|รอ)/u.test(word))).toBe(false);
    expect(joinUnspacedLetters(letters(["จ", "ริ", "ง", "เ", "ห", "ร", "อ"], 0, 0.25)).map((word) => word.text)).toEqual(["จริง", "เหรอ"]);
    expect(splitUnspacedText("จะเทอะไร")).toEqual(["จะ", "เท", "อะไร"]);
    expect(splitUnspacedText("ซื้อสบู่ใหม่")).toEqual(["ซื้อ", "สบู่", "ใหม่"]);
  });

  it("lists the words of mixed spaced and unspaced text", () => {
    expect(textWords(" ฉันชอบ iPhone ใหม่กัน  hello ")).toEqual(["ฉัน", "ชอบ", "iPhone", "ใหม่", "กัน", "hello"]);
    expect(textWords("   ")).toEqual([]);
  });

  it("splits unspaced translated text into words", () => {
    expect(splitUnspacedText("ฉันชอบกินข้าวมาก")).toEqual(["ฉัน", "ชอบ", "กิน", "ข้าว", "มาก"]);
    expect(splitUnspacedText("喝牛奶。")).toEqual(["喝", "牛奶。"]);
  });
});
