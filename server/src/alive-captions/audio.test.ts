import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG } from "../ffmpeg.js";
import {
  HOP_SECONDS,
  VOCAL_SAMPLE_RATE,
  decodeVocalPcm,
  detectOnsets,
  envelopeSeries,
  rmsFrames,
  snapToOnset,
  snapWordStarts,
  wordEnergies,
} from "./audio.js";

const execFileAsync = promisify(execFile);

/** Loud bursts at 0.5 s and 1.5 s, a quiet one at 2.5 s. */
const BURSTS = "sin(2*PI*440*t)*(0.8*between(t,0.5,0.8)+0.8*between(t,1.5,1.8)+0.2*between(t,2.5,2.8))";

describe("alive caption vocal analysis", () => {
  let dir: string;
  let videoPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "videobook-alive-audio-test-"));
    videoPath = join(dir, "bursts.mp4");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "color=c=black:s=160x90:r=24:d=3.2",
      "-f", "lavfi", "-i", `aevalsrc='${BURSTS}':s=44100:d=3.2`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest",
      videoPath,
    ]);
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("finds vocal onsets and relative word energy in a real audio track", async () => {
    const pcm = await decodeVocalPcm(videoPath);
    expect(pcm).not.toBeNull();
    const rms = rmsFrames(pcm!, VOCAL_SAMPLE_RATE, HOP_SECONDS);
    const onsets = detectOnsets(rms, HOP_SECONDS);

    for (const burst of [0.5, 1.5, 2.5]) {
      expect(onsets.some((onset) => Math.abs(onset - burst) <= 0.04)).toBe(true);
    }
    expect(onsets.every((onset) => [0.5, 1.5, 2.5].some((burst) => Math.abs(onset - burst) <= 0.06))).toBe(true);

    const words = [
      { start: 0.55, end: 0.8 },
      { start: 1.5, end: 1.8 },
      { start: 2.46, end: 2.8 },
    ];
    const snapped = snapWordStarts(words, onsets);
    expect(snapped[0]).toBeCloseTo(0.5, 1);
    expect(Math.abs(snapped[1] - 1.5)).toBeLessThanOrEqual(0.04);
    expect(Math.abs(snapped[2] - 2.5)).toBeLessThanOrEqual(0.04);

    const energies = wordEnergies(words, rms, HOP_SECONDS);
    expect(energies[0]).toBeGreaterThan(0.8);
    expect(energies[2]).toBeLessThan(energies[0] * 0.5);

    const envelope = envelopeSeries(rms, 20, HOP_SECONDS);
    expect(envelope.length).toBeGreaterThanOrEqual(63);
    expect(envelope[12]).toBeGreaterThan(0.8);
    expect(envelope[22]).toBeLessThan(0.1);
  });

  it("keeps a word on its transcript time when no onset is close", () => {
    expect(snapToOnset(1.0, [0.5, 1.6], 0)).toBe(1.0);
    expect(snapToOnset(1.0, [0.9, 1.05], 0)).toBe(1.05);
    expect(snapToOnset(1.0, [0.9, 1.05], 1.02)).toBe(1.05);
  });

  it("never lets snapped words overtake each other", () => {
    const snapped = snapWordStarts([{ start: 1.0, end: 1.1 }, { start: 1.02, end: 1.2 }], [1.0]);
    expect(snapped[0]).toBe(1.0);
    expect(snapped[1]).toBe(1.02);
  });
});
