import { describe, it, expect } from "vitest";
import type { OpenAiResponseRequest, OpenAiResponseResponse } from "@apicity/openai";
import { parseSegments } from "../remotion/subtitles/segments.js";
import type { Word } from "../remotion/subtitles/types.js";
import {
  INTELLIGENCE_MODEL,
  type ResponsesFn,
} from "../openai-intelligence.js";
import {
  computeSourceTextHash,
  groupIntoSentences,
  iso1FromIso3,
  isLanguageSetting,
  sidecarMatchesSource,
  synthesizeWordTimings,
  translatedTranscriptFilename,
  translateTranscript,
} from "./_translate-transcript.js";

function word(text: string, start: number, end: number): Word {
  return { word: text, start, end };
}

// Hand-written fake of the injectable OpenAI responses function — the same
// injection seam production uses (buildIntelligenceResponses), no module mocking.
function fakeResponses(
  payload: unknown,
  capture?: (request: OpenAiResponseRequest) => void,
): ResponsesFn {
  return async (req: OpenAiResponseRequest): Promise<OpenAiResponseResponse> => {
    capture?.(req);
    return {
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(payload) }],
      }],
    } as unknown as OpenAiResponseResponse;
  };
}

describe("isLanguageSetting", () => {
  it("accepts 'original' and two-letter codes, rejects junk", () => {
    expect(isLanguageSetting("original")).toBe(true);
    expect(isLanguageSetting("en")).toBe(true);
    expect(isLanguageSetting("EN")).toBe(false);
    expect(isLanguageSetting("eng")).toBe(false);
    expect(isLanguageSetting(42)).toBe(false);
    expect(isLanguageSetting(null)).toBe(false);
  });
});

describe("iso1FromIso3", () => {
  it("maps ElevenLabs ISO 639-3 codes to ISO 639-1", () => {
    expect(iso1FromIso3("zho")).toBe("zh");
    expect(iso1FromIso3("cmn")).toBe("zh");
    expect(iso1FromIso3("eng")).toBe("en");
    expect(iso1FromIso3("ENG")).toBe("en");
    expect(iso1FromIso3("xx-unknown")).toBeNull();
    expect(iso1FromIso3(null)).toBeNull();
  });
});

describe("groupIntoSentences", () => {
  it("splits on sentence-final punctuation including CJK marks", () => {
    const sentences = groupIntoSentences([
      word("来,", 0.0, 0.3),
      word("宝宝,", 0.3, 0.7),
      word("喝牛奶。", 0.7, 1.2),
      word("妈妈,", 1.3, 1.6),
      word("牛奶好喝吗?", 1.6, 2.4),
    ]);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toMatchObject({ start: 0.0, end: 1.2 });
    expect(sentences[1]).toMatchObject({ start: 1.3, end: 2.4 });
  });

  it("joins CJK words without spaces and Latin words with spaces", () => {
    const cjk = groupIntoSentences([word("喝", 0, 0.2), word("牛奶", 0.2, 0.5)]);
    expect(cjk[0].text).toBe("喝牛奶");

    const latin = groupIntoSentences([word("drink", 0, 0.2), word("milk", 0.2, 0.5)]);
    expect(latin[0].text).toBe("drink milk");

    const thai = groupIntoSentences([word("ฉัน", 0, 0.2), word("ชอบ", 0.2, 0.5)]);
    expect(thai[0].text).toBe("ฉันชอบ");
  });

  it("splits on pauses longer than 0.8s", () => {
    const sentences = groupIntoSentences([
      word("hello", 0.0, 0.4),
      word("there", 1.5, 1.9),
    ]);
    expect(sentences).toHaveLength(2);
  });

  it("caps sentences at 30 words", () => {
    const words = Array.from({ length: 65 }, (_, i) => word(`w${i}`, i * 0.1, i * 0.1 + 0.08));
    const sentences = groupIntoSentences(words);
    expect(sentences).toHaveLength(3);
    expect(sentences[0].text.split(" ")).toHaveLength(30);
  });

  it("skips empty word texts", () => {
    const sentences = groupIntoSentences([word("  ", 0, 0.1), word("hi.", 0.1, 0.3)]);
    expect(sentences).toHaveLength(1);
    expect(sentences[0].text).toBe("hi.");
  });
});

describe("synthesizeWordTimings", () => {
  it("produces monotonic timings spanning exactly the window", () => {
    const words = synthesizeWordTimings("Here, baby, drink the milk.", 2.0, 5.0);
    expect(words[0].start).toBe(2.0);
    expect(words[words.length - 1].end).toBeCloseTo(5.0, 10);
    for (let i = 0; i < words.length; i++) {
      expect(words[i].end).toBeGreaterThanOrEqual(words[i].start);
      if (i > 0) expect(words[i].start).toBeCloseTo(words[i - 1].end, 10);
    }
  });

  it("weights longer tokens with more time", () => {
    const words = synthesizeWordTimings("a extraordinarily", 0, 1);
    const short = words[0].end - words[0].start;
    const long = words[1].end - words[1].start;
    expect(long).toBeGreaterThan(short);
  });

  it("splits unspaced output into words so highlight follows real words", () => {
    const words = synthesizeWordTimings("来宝宝喝牛奶", 0, 3);
    expect(words.map((w) => w.text)).toEqual(["来", "宝宝", "喝", "牛奶"]);
  });

  it("keeps a space between Thai clauses as a spacing entry that parseSegments splits on", () => {
    const words = synthesizeWordTimings("ฉันชอบกินข้าวมาก แมวนอนอยู่บนโต๊ะ", 0, 3);
    expect(words.map((w) => w.text)).toEqual(["ฉัน", "ชอบ", "กิน", "ข้าว", "มาก", " ", "แมว", "นอน", "อยู่", "บน", "โต๊ะ"]);
    expect(words[5].type).toBe("spacing");
    expect(synthesizeWordTimings("drink the milk", 0, 1).map((w) => w.type)).toEqual(["word", "word", "word"]);
    const segments = parseSegments({ segments: [{ start: 0, end: 3, text: "", words }] });
    expect(segments.map((segment) => segment.text)).toEqual(["ฉันชอบกินข้าวมาก", "แมวนอนอยู่บนโต๊ะ"]);
  });

  it("returns empty for blank text", () => {
    expect(synthesizeWordTimings("   ", 0, 1)).toEqual([]);
  });
});

describe("computeSourceTextHash", () => {
  it("is stable for identical word text and changes when text changes", () => {
    const a = parseSegments({ words: [{ text: "hello", start: 0, end: 1, type: "word" }] });
    const b = parseSegments({ words: [{ text: "hello", start: 5, end: 6, type: "word" }] });
    const c = parseSegments({ words: [{ text: "goodbye", start: 0, end: 1, type: "word" }] });
    expect(computeSourceTextHash(a)).toBe(computeSourceTextHash(b));
    expect(computeSourceTextHash(a)).not.toBe(computeSourceTextHash(c));
    expect(computeSourceTextHash(a)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("translateTranscript", () => {
  const raw = {
    language_code: "zho",
    words: [
      { text: "来,", start: 0.0, end: 0.3, type: "word" },
      { text: "宝宝,", start: 0.3, end: 0.7, type: "word" },
      { text: "喝牛奶。", start: 0.7, end: 1.2, type: "word" },
      { text: "谢谢妈妈。", start: 1.4, end: 2.2, type: "word" },
    ],
  };

  it("produces a sidecar that round-trips through parseSegments with source time windows", async () => {
    const responses = fakeResponses({ translations: ["Here, baby, drink the milk.", "Thank you, mom."] });
    const sidecar = await translateTranscript(raw, "en", responses);

    expect(sidecar.sourceLanguageCode).toBe("zho");
    expect(sidecar.targetLanguage).toBe("en");
    expect(sidecar.sourceTextHash).toMatch(/^[0-9a-f]{12}$/);
    expect(sidecar.segments).toHaveLength(2);
    expect(sidecar.segments[0]).toMatchObject({ start: 0.0, end: 1.2, text: "Here, baby, drink the milk." });
    expect(sidecar.segments[1]).toMatchObject({ start: 1.4, end: 2.2, text: "Thank you, mom." });

    const parsed = parseSegments(sidecar as unknown as Parameters<typeof parseSegments>[0]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].words.length).toBeGreaterThan(0);
    expect(parsed[0].words[0].start).toBe(0.0);
    expect(parsed[0].words[parsed[0].words.length - 1].end).toBeCloseTo(1.2, 10);
  });

  it("sends a Thai transcript to the translator as whole clauses, one per line", async () => {
    const letters = (texts: string[], start: number) => texts.map((text, index) => ({ text, start: start + index * 0.1, end: start + (index + 1) * 0.1, type: "word" }));
    const thai = {
      language_code: "tha",
      words: [
        ...letters(["ฉั", "น", "ช", "อ", "บ", "กิ", "น", "ข้", "า", "ว", "ม", "า", "ก"], 0),
        { text: " ", start: 1.3, end: 1.3, type: "spacing" },
        ...letters(["แ", "ม", "ว", "น", "อ", "น", "อ", "ยู่", "บ", "น", "โ", "ต๊", "ะ"], 1.5),
      ],
    };
    const captured = { input: "" };
    const responses = fakeResponses({ translations: ["I really like eating rice.", "The cat sleeps on the table."] }, (request) => {
      captured.input = JSON.stringify(request.input);
    });
    const sidecar = await translateTranscript(thai, "en", responses);
    expect(captured.input).toContain("ฉันชอบกินข้าวมาก");
    expect(captured.input).toContain("แมวนอนอยู่บนโต๊ะ");
    expect(sidecar.segments.map((segment) => [segment.start, segment.text])).toEqual([[0, "I really like eating rice."], [1.5, "The cat sleeps on the table."]]);
  });

  it("uses the shared intelligence defaults and a strict response schema", async () => {
    const captured = { request: null as OpenAiResponseRequest | null };
    const responses = fakeResponses(
      { translations: ["Here, baby, drink the milk.", "Thank you, mom."] },
      (request) => {
        captured.request = request;
      },
    );

    await translateTranscript(raw, "en", responses);

    expect(captured.request).not.toBeNull();
    expect(captured.request?.model).toBe(INTELLIGENCE_MODEL);
    expect(captured.request?.reasoning).toEqual({ effort: "medium" });
    expect(captured.request?.store).toBe(false);
    expect(captured.request?.temperature).toBeUndefined();
    expect(captured.request?.text?.format).toMatchObject({
      type: "json_schema",
      name: "translated_transcript",
      strict: true,
    });
  });

  it("matches its own source via sidecarMatchesSource until the transcript changes", async () => {
    const responses = fakeResponses({ translations: ["Here, baby, drink the milk.", "Thank you, mom."] });
    const sidecar = await translateTranscript(raw, "en", responses);
    const sourceSegments = parseSegments(raw);
    expect(sidecarMatchesSource(sidecar, sourceSegments)).toBe(true);

    const changed = parseSegments({ words: [{ text: "different", start: 0, end: 1, type: "word" }] });
    expect(sidecarMatchesSource(sidecar, changed)).toBe(false);
    expect(sidecarMatchesSource(null, sourceSegments)).toBe(false);
    expect(sidecarMatchesSource({}, sourceSegments)).toBe(false);
  });

  it("throws on translation count mismatch", async () => {
    const responses = fakeResponses({ translations: ["only one line"] });
    await expect(translateTranscript(raw, "en", responses)).rejects.toThrow(/1 entries for 2 lines/);
  });

  it("throws when the model returns no translations array", async () => {
    const responses = fakeResponses({ nope: true });
    await expect(translateTranscript(raw, "en", responses)).rejects.toThrow(/no translations array/);
  });

  it("throws on an empty transcript", async () => {
    const responses = fakeResponses({ translations: [] });
    await expect(translateTranscript({ words: [] }, "en", responses)).rejects.toThrow(/no subtitle text/);
  });
});

describe("translatedTranscriptFilename", () => {
  it("derives the per-language sidecar name", () => {
    expect(translatedTranscriptFilename("en")).toBe("elevenlabs.en.json");
  });
});
