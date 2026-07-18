import { describe, expect, it } from "vitest";
import {
  hasTimedSpeechWords,
  resolveAudioCue,
  timedSpeechWords,
} from "./audio-cue.js";

describe("audio cue resolution", () => {
  const transcript = {
    words: [
      { text: "England,", start: 3.879, end: 4.2, type: "word" },
      { text: " ", start: 4.2, end: 4.3, type: "spacing" },
      { text: "is", start: 4.3, end: 4.5, type: "word" },
      { text: "[door]", start: 4.6, end: 4.9, type: "audio_event" },
      { text: "AMERICA!", start: 5.96, end: 6.4, type: "word" },
    ],
  };

  it("matches a contiguous phrase case- and punctuation-insensitively", () => {
    expect(resolveAudioCue(transcript, "england IS")).toBe(3.879);
    expect(resolveAudioCue(transcript, "America?")).toBe(5.96);
  });

  it("uses only timed speech words", () => {
    expect(timedSpeechWords(transcript)).toEqual([
      { text: "england", start: 3.879 },
      { text: "is", start: 4.3 },
      { text: "america", start: 5.96 },
    ]);
    expect(() => resolveAudioCue(transcript, "door")).toThrow("not found");
  });

  it("matches words containing apostrophes", () => {
    const words = { words: [{ text: "Don't", start: 1, type: "word" }] };
    expect(resolveAudioCue(words, "dont")).toBe(1);
  });

  it("reads the first ElevenLabs multichannel transcript", () => {
    const multichannel = {
      transcripts: [{ words: [{ text: "Britain", start: 2.75, type: "word" }] }],
    };
    expect(resolveAudioCue(multichannel, "britain")).toBe(2.75);
  });

  it("rejects ambiguous phrases with every matching timestamp", () => {
    const repeated = {
      words: [
        { text: "hello", start: 1, type: "word" },
        { text: "hello", start: 2.25, type: "word" },
      ],
    };
    expect(() => resolveAudioCue(repeated, "hello")).toThrow("1s, 2.25s");
  });

  it("instructs the caller to use a numeric target for a missing phrase", () => {
    expect(() => resolveAudioCue(transcript, "Scotland")).toThrow("audio_seconds");
  });

  it("rejects missing timed words and empty cues", () => {
    expect(() => resolveAudioCue({}, "hello")).toThrow("timed words");
    expect(() => resolveAudioCue(transcript, "---")).toThrow("word or number");
  });

  it("distinguishes usable timed transcripts from malformed or empty data", () => {
    expect(hasTimedSpeechWords(transcript)).toBe(true);
    expect(hasTimedSpeechWords({ words: [] })).toBe(false);
    expect(hasTimedSpeechWords({ words: [{ text: "hello" }] })).toBe(false);
    expect(hasTimedSpeechWords("not a transcript")).toBe(false);
  });
});
