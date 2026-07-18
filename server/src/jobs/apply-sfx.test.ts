import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { buildMixFilter, mixSfxIntoVideo } from "./apply-sfx.js";

const execFileAsync = promisify(execFile);

describe("apply SFX media mixing", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-apply-sfx-job-"));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("bounds the generated audio bed to a silent video's duration", async () => {
    const videoPath = join(tempDir, "silent.mp4");
    const sfxPath = join(tempDir, "cue.mp3");
    const outputPath = join(tempDir, "mixed.mp4");
    const pcmPath = join(tempDir, "cue.f32le");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=24",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-an",
      videoPath,
    ]);
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=880:duration=0.4",
      "-c:a", "libmp3lame",
      sfxPath,
    ]);

    const cues = [{
      timestamp: 1,
      type: "stamp",
      description: "screen stamped twice",
      duration_seconds: 0.4,
      prompt: null,
    }];
    await mixSfxIntoVideo(videoPath, [sfxPath], outputPath, cues);

    const output = await probeVideo(outputPath);
    expect(output.hasAudio).toBe(true);
    expect(output.duration).toBeCloseTo(2, 1);
    await execFileAsync(FFMPEG, [
      "-y",
      "-ss", "1.05",
      "-t", "0.2",
      "-i", outputPath,
      "-map", "0:a:0",
      "-ac", "1",
      "-ar", "48000",
      "-f", "f32le",
      pcmPath,
    ]);
    const pcm = await readFile(pcmPath);
    let sum = 0;
    for (let offset = 0; offset + 3 < pcm.length; offset += 4) {
      const value = pcm.readFloatLE(offset);
      sum += value * value;
    }
    expect(Math.sqrt(sum / Math.max(1, pcm.length / 4))).toBeGreaterThan(0.05);
  }, 30_000);

  it("rejects an unbounded silent mix", () => {
    expect(() => buildMixFilter([], false, 0)).toThrow("Invalid silent video duration");
  });
});
