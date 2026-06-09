import { describe, expect, it } from "vitest";
import type { ElevenLabsTranscript } from "@apicity/elevenlabs";
import { registerArchiveClipJob, __archiveClipJobTest } from "./archive-clip.js";

function transcript(text: string, start: number, duration: number): ElevenLabsTranscript {
  return {
    language_code: "en",
    language_probability: 0.99,
    text,
    words: [{
      text,
      start,
      end: start + duration,
      type: "word",
      speaker_id: null,
      characters: [{ text: text[0] ?? "", start, end: start + 0.1 }],
    }],
    channel_index: 0,
    transcription_id: null,
    audio_duration_secs: start + duration,
  };
}

describe("archive clip job helpers", () => {
  it("exports registerArchiveClipJob function", () => {
    expect(typeof registerArchiveClipJob).toBe("function");
    expect(registerArchiveClipJob.length).toBe(1);
  });

  it("builds an asset snapshot with dotfiles and directory contents", () => {
    const snapshot = __archiveClipJobTest.buildAssetSnapshot({
      path: "/projects/demo/vid-demo",
      files: [
        { name: ".original.json", size_bytes: 1, extension: "json", mtimeMs: 1 },
        { name: "original.mp4", size_bytes: 2, extension: "mp4", mtimeMs: 2 },
      ],
      directories: {
        original_frames: ["000001.jpg", ".frames.json"],
      },
    }, "demo", "vid-demo");

    expect(snapshot.files.map((file) => file.relativePath)).toEqual([
      ".original.json",
      "original.mp4",
      "original_frames/000001.jpg",
      "original_frames/.frames.json",
    ]);
  });

  it("splits a three-hour clip into twenty-minute starts", () => {
    expect(__archiveClipJobTest.chunkStarts(3 * 60 * 60)).toEqual([
      0,
      1200,
      2400,
      3600,
      4800,
      6000,
      7200,
      8400,
      9600,
    ]);
  });

  it("merges chunk transcripts with absolute timestamps", () => {
    const merged = __archiveClipJobTest.mergeTranscripts([
      { transcript: transcript("hello", 1, 0.5), offset: 0 },
      { transcript: transcript("world", 0.25, 0.75), offset: 1200 },
    ], 1300);

    expect(merged.text).toBe("hello world");
    expect(merged.audio_duration_secs).toBe(1300);
    expect(merged.words[0]?.start).toBe(1);
    expect(merged.words[1]?.start).toBe(1200.25);
    expect(merged.words[1]?.characters?.[0]?.start).toBe(1200.25);
  });

  it("samples long transcripts from the head, middle, and tail", () => {
    const long = "a".repeat(10000) + "middle-marker" + "b".repeat(10000) + "tail-marker";
    const sample = __archiveClipJobTest.sampleTranscript(long);

    expect(sample.length).toBeLessThan(long.length);
    expect(sample).toContain("middle-marker");
    expect(sample).toContain("tail-marker");
  });
});
