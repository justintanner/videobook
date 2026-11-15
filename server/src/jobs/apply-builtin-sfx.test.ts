import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG, probeVideo, runFfmpeg } from "../ffmpeg.js";
import { mixBuiltinSfxIntoVideo } from "../sound-effects/mix.js";
import { testBudget } from "../test-budget.js";

const exec = promisify(execFile);
const keys = { ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };

async function samples(path: string): Promise<Buffer> {
  return (await exec(FFMPEG, ["-v", "error", "-i", path, "-map", "0:a", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], { encoding: "buffer", maxBuffer: 4_000_000, timeout: testBudget(30_000) })).stdout;
}

function rms(pcm: Buffer, start: number, end: number): number {
  let energy = 0;
  const from = Math.round(start * 48_000);
  const to = Math.min(Math.round(end * 48_000), pcm.length / 4);
  for (let index = from; index < to; index += 1) energy += pcm.readFloatLE(index * 4) ** 2;
  return Math.sqrt(energy / (to - from));
}

async function videoHash(path: string): Promise<string> {
  return (await exec(FFMPEG, ["-v", "error", "-i", path, "-map", "0:v", "-c", "copy", "-f", "md5", "pipe:1"], { timeout: testBudget(30_000) })).stdout.trim();
}

describe("built-in SFX media editing", () => {
  let dir: string;
  let source: string;
  let silent: string;

  beforeAll(async () => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.OPENAI_API_KEY;
    dir = await mkdtemp(join(tmpdir(), "builtin-sfx-media-"));
    source = join(dir, "source.mp4");
    silent = join(dir, "silent.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=black:size=160x90:rate=24:duration=3", "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.05:seed=1:duration=3:sample_rate=48000", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", source]);
    await runFfmpeg(["-y", "-i", source, "-map", "0:v", "-c", "copy", silent]);
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(keys)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("adds a timed zoom without changing video packets, duration or earlier audio, at adjustable volume", async () => {
    const loud = join(dir, "loud.mp4");
    const quiet = join(dir, "quiet.mp4");
    for (const [output, gain] of [[loud, 0.7], [quiet, 0.35]] as const) {
      await mixBuiltinSfxIntoVideo(source, output, dir, [{ sound: "zoom_in", startSeconds: 1, gain }]);
    }
    const original = await samples(source);
    const mixed = await samples(loud);
    const reduced = await samples(quiet);
    expect(20 * Math.log10(rms(mixed, 1, 1.5) / rms(original, 1, 1.5))).toBeGreaterThanOrEqual(6);
    expect(Math.abs(20 * Math.log10(rms(mixed, 0, 0.9) / rms(original, 0, 0.9)))).toBeLessThan(1);
    expect(rms(reduced, 1, 1.5)).toBeLessThan(rms(mixed, 1, 1.5));
    expect(await videoHash(loud)).toBe(await videoHash(source));
    expect(Math.abs((await probeVideo(loud)).duration - (await probeVideo(source)).duration)).toBeLessThanOrEqual(0.05);
  }, testBudget(60_000));

  it.each(["pop", "ding"] as const)("places pop and %s cues in a bounded silent clip", async (second) => {
    const output = join(dir, `two-${second}.mp4`);
    await mixBuiltinSfxIntoVideo(silent, output, dir, [{ sound: "pop", startSeconds: 0.5, gain: 0.7 }, { sound: second, startSeconds: 2, gain: 0.7 }]);
    const probe = await probeVideo(output);
    expect(probe.hasAudio).toBe(true);
    expect(probe.audioDuration!).toBeLessThanOrEqual(probe.videoDuration + 0.001);
    const pcm = await samples(output);
    expect(rms(pcm, 0, 0.4)).toBeLessThan(0.0001);
    expect(rms(pcm, 0.5, 0.64)).toBeGreaterThan(0.02);
    expect(rms(pcm, 1.5, 1.9)).toBeLessThan(0.0001);
    expect(rms(pcm, 2, 2.14)).toBeGreaterThan(0.02);
  }, testBudget(60_000));
});
