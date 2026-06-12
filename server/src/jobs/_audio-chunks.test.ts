import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chunkStarts, chunkLength, extractAudioChunk } from "./_audio-chunks.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";

describe("chunkStarts", () => {
  it("returns a single chunk for zero or invalid durations", () => {
    expect(chunkStarts(0, 900)).toEqual([0]);
    expect(chunkStarts(-5, 900)).toEqual([0]);
    expect(chunkStarts(Number.NaN, 900)).toEqual([0]);
  });

  it("splits a 28-minute clip into two 15-minute starts", () => {
    expect(chunkStarts(28 * 60, 900)).toEqual([0, 900]);
  });

  it("does not emit an empty tail chunk on exact multiples", () => {
    expect(chunkStarts(1800, 900)).toEqual([0, 900]);
  });

  it("splits a three-hour clip into twenty-minute starts", () => {
    expect(chunkStarts(3 * 60 * 60, 1200)).toEqual([
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
});

describe("chunkLength", () => {
  it("clamps the tail chunk to the remaining duration", () => {
    expect(chunkLength(1680, 900, 900)).toBe(780);
  });

  it("returns the full chunk size for interior chunks", () => {
    expect(chunkLength(1680, 0, 900)).toBe(900);
  });

  it("floors near-zero tails at 0.1 seconds", () => {
    expect(chunkLength(900.01, 900, 900)).toBe(0.1);
  });

  it("returns 0 for zero duration", () => {
    expect(chunkLength(0, 0, 900)).toBe(0);
  });
});

describe("extractAudioChunk (real ffmpeg)", () => {
  let tempDir: string;
  let tonePath: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-audio-chunks-"));
    tonePath = join(tempDir, "tone.mp3");
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-acodec", "libmp3lame", "-q:a", "5",
      "-f", "mp3",
      tonePath,
    ]);
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("extracts a seekable segment as mono audio", async () => {
    const chunkPath = join(tempDir, "chunk-000.mp3");
    await extractAudioChunk(tonePath, 1, 2, chunkPath);

    const probe = await probeVideo(chunkPath);
    expect(probe.hasAudio).toBe(true);
    expect(probe.duration).toBeGreaterThan(1.8);
    expect(probe.duration).toBeLessThan(2.2);
  });
});
