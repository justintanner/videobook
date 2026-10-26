import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { srtTimestamp } from "./srt.js";
import { transcriptToSrt } from "./transcript-srt.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/elevenlabs-transcript.json",
);

const SRT_CUE = /^(\d+)\n(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\n([\s\S]+)$/;

function parseSrt(srt: string) {
  const blocks = srt.trimEnd().split("\n\n");
  return blocks.map((block) => {
    const match = block.match(SRT_CUE);
    if (!match) throw new Error(`Invalid SRT cue:\n${block}`);
    return {
      index: Number(match[1]),
      start: match[2]!,
      end: match[3]!,
      text: match[4]!.trim(),
      startMillis: timestampToMillis(match[2]!),
      endMillis: timestampToMillis(match[3]!),
    };
  });
}

function timestampToMillis(stamp: string): number {
  const match = stamp.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) throw new Error(`Invalid timestamp ${stamp}`);
  return Number(match[1]) * 3_600_000
    + Number(match[2]) * 60_000
    + Number(match[3]) * 1000
    + Number(match[4]);
}

describe("transcriptToSrt", () => {
  it("renders valid SRT from a fixture elevenlabs.json", () => {
    const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
    const srt = transcriptToSrt(raw);
    const cues = parseSrt(srt);

    expect(cues.length).toBeGreaterThan(1);
    expect(cues.map((cue) => cue.index)).toEqual(
      cues.map((_, index) => index + 1),
    );
    expect(srt).toContain("Hello");
    expect(srt).toContain("world");
    expect(srt).toContain("exporter.");
    for (const [index, cue] of cues.entries()) {
      expect(cue.endMillis).toBeGreaterThan(cue.startMillis);
      if (index > 0) {
        expect(cue.startMillis).toBeGreaterThanOrEqual(cues[index - 1]!.endMillis);
      }
    }
    expect(cues[0]?.start).toBe(srtTimestamp(0));
  });

  it("keeps Thai words whole and unspaced instead of spacing out ElevenLabs letters", () => {
    const letters = ["ฉั", "น", "ช", "อ", "บ", "กิ", "น", "ข้", "า", "ว", "ม", "า", "ก"];
    const srt = transcriptToSrt({
      words: letters.map((text, index) => ({ text, start: index * 0.25, end: (index + 1) * 0.25, type: "word" })),
    });
    const cues = parseSrt(srt);
    expect(cues.map((cue) => cue.text).join("")).toBe("ฉันชอบกินข้าวมาก");
    expect(cues.some((cue) => cue.text.includes(" "))).toBe(false);
    expect(cues[0].text).toBe("ฉันชอบ");
  });

  it("errors when the sidecar has no timed speech", () => {
    expect(() => transcriptToSrt({
      text: "[music]",
      words: [{ text: "[music]", start: 0, end: 1, type: "audio_event" }],
    })).toThrow(/word-timed cues/i);
  });
});
