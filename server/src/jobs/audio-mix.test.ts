import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Engine } from "videobook-engine";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { resolveAudioMixAsset } from "../tools/audio-mix.js";
import { buildAudioMixFilter, mixAudioMedia } from "./audio-mix.js";
import { testBudget } from "../test-budget.js";

const execFileAsync = promisify(execFile);

async function createAssetWithFile(
  fs: Engine,
  prefix: "vid" | "aud",
  name: string,
  filename: string,
): Promise<string> {
  const created = await fs.artifacts.create(prefix, name);
  if (!created.ok) throw new Error(created.error.message);
  const written = await fs.files.write(created.value.artifactId, filename, Buffer.from(`fixture-${name}`)
  );
  if (!written.ok) throw new Error(written.error.message);
  return created.value.artifactId;
}

function projectedAmplitude(samples: Buffer, frequency: number, sampleRate: number): number {
  const count = Math.floor(samples.length / 4);
  let sine = 0;
  let cosine = 0;
  for (let index = 0; index < count; index += 1) {
    const value = samples.readFloatLE(index * 4);
    const angle = 2 * Math.PI * frequency * index / sampleRate;
    sine += value * Math.sin(angle);
    cosine += value * Math.cos(angle);
  }
  return 2 * Math.hypot(sine, cosine) / count;
}

describe("audio mix", () => {
  let tempDir: string;
  let engineRoot: string;
  let fs: Engine;
  let videoTargetId: string;
  let videoLayerId: string;
  let audioTargetId: string;
  let audioLayerId: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-audio-mix-"));
    engineRoot = join(tempDir, "projects");
    fs = createEngineForTest(engineRoot);
    videoTargetId = await createAssetWithFile(fs, "vid", "video target", "original.mp4");
    videoLayerId = await createAssetWithFile(fs, "vid", "video layer", "original.mkv");
    audioTargetId = await createAssetWithFile(fs, "aud", "audio target", "original.wav");
    audioLayerId = await createAssetWithFile(fs, "aud", "audio layer", "original.mp3");
  });

  afterAll(async () => {
    closeEngineForTest(engineRoot, fs);
    await rm(tempDir, { recursive: true, force: true });
  });

  it.each([
    ["video", "audio"],
    ["video", "video"],
    ["audio", "audio"],
    ["audio", "video"],
  ] as const)("resolves a %s target with a %s layer", async (targetKind, layerKind) => {
    const targetId = targetKind === "video" ? videoTargetId : audioTargetId;
    const layerId = layerKind === "video" ? videoLayerId : audioLayerId;
    const [target, layer] = await Promise.all([
      resolveAudioMixAsset(fs, targetId),
      resolveAudioMixAsset(fs, layerId),
    ]);
    expect(target.kind).toBe(targetKind);
    expect(layer.kind).toBe(layerKind);
  });

  it("builds a bounded silent-target filter at percentage gain", () => {
    const filter = buildAudioMixFilter(false, 2, 30);
    expect(filter).toContain("anullsrc");
    expect(filter).toContain("volume=0.3");
    expect(filter).toContain("atrim=duration=2");
    expect(() => buildAudioMixFilter(true, 2, 101)).toThrow("between 0 and 100");
  });

  it("adds audio to a silent video without changing its video stream or duration", async () => {
    const targetPath = join(tempDir, "silent-target.mp4");
    const layerPath = join(tempDir, "short-layer.wav");
    const outputPath = join(tempDir, "mixed-video.mp4");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=2:size=160x90:rate=24",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-an",
      targetPath,
    ]);
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=660:duration=0.6:sample_rate=48000",
      "-c:a", "pcm_s16le",
      layerPath,
    ]);

    await mixAudioMedia(targetPath, layerPath, outputPath, "video", 30);

    const output = await probeVideo(outputPath);
    expect(output.videoCodec).toBe("h264");
    expect(output.hasAudio).toBe(true);
    expect(output.videoDuration).toBeCloseTo(2, 1);
    expect(output.audioDuration).toBeCloseTo(2, 1);
  }, testBudget(30_000));

  it("mixes a video layer into an audio target at the requested volume", async () => {
    const targetPath = join(tempDir, "tone-target.wav");
    const layerPath = join(tempDir, "tone-layer.mkv");
    const outputPath = join(tempDir, "mixed-audio.wav");
    const pcmPath = join(tempDir, "mixed-audio.f32le");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000",
      "-c:a", "pcm_s16le",
      targetPath,
    ]);
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "color=black:duration=1:size=160x90:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=880:duration=1:sample_rate=48000",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-c:a", "pcm_s16le",
      "-shortest",
      layerPath,
    ]);

    await mixAudioMedia(targetPath, layerPath, outputPath, "audio", 25);

    const output = await probeVideo(outputPath);
    expect(output.videoCodec).toBeNull();
    expect(output.audioDuration).toBeCloseTo(2, 1);
    await execFileAsync(FFMPEG, [
      "-y",
      "-t", "0.8",
      "-i", outputPath,
      "-map", "0:a:0",
      "-ac", "1",
      "-ar", "48000",
      "-f", "f32le",
      pcmPath,
    ]);
    const samples = await readFile(pcmPath);
    const baseAmplitude = projectedAmplitude(samples, 440, 48_000);
    const layerAmplitude = projectedAmplitude(samples, 880, 48_000);
    expect(layerAmplitude / baseAmplitude).toBeCloseTo(0.25, 1);
  }, testBudget(30_000));
});
