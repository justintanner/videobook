import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { probeVideo, FFMPEG } from "../ffmpeg.js";
import { createTimewarpPlan } from "../timewarp.js";
import {
  registerTimewarpVideoJob,
  renderTimewarpedVideo,
  validateTimewarpOutput,
} from "./timewarp-video.js";

const execFileAsync = promisify(execFile);

async function generateAacVideo(outputPath: string, hasAudio: boolean): Promise<void> {
  const args = [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=4:size=320x180:rate=24",
  ];
  if (hasAudio) {
    args.push("-f", "lavfi", "-i", "sine=frequency=440:duration=4");
  }
  args.push(
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    ...(hasAudio ? ["-c:a", "aac", "-shortest"] : ["-an"]),
    outputPath,
  );
  await execFileAsync(FFMPEG, args);
}

async function generatePcmMov(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=3:size=320x180:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-c:a", "pcm_s16le",
    "-shortest",
    outputPath,
  ]);
}

async function generateThreeColorVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "color=c=red:s=160x90:r=10:d=2",
    "-f", "lavfi", "-i", "color=c=green:s=160x90:r=10:d=2",
    "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10:d=4",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map", "[v]",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-an",
    outputPath,
  ]);
}

async function audioStreamHash(filePath: string): Promise<string> {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-v", "error",
    "-i", filePath,
    "-map", "0:a:0",
    "-c:a", "copy",
    "-f", "hash",
    "-hash", "sha256",
    "pipe:1",
  ]);
  return stdout.trim();
}

async function estimateAudioFrequency(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-v", "error",
    "-i", filePath,
    "-t", "1",
    "-vn",
    "-ac", "1",
    "-ar", "8000",
    "-f", "s16le",
    "pipe:1",
  ], { encoding: "buffer", maxBuffer: 1024 * 1024 });
  const pcm = stdout as unknown as Buffer;
  let crossings = 0;
  let previous = pcm.readInt16LE(0);
  for (let offset = 2; offset + 1 < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    if ((previous < 0 && sample >= 0) || (previous >= 0 && sample < 0)) crossings++;
    previous = sample;
  }
  const duration = pcm.length / 2 / 8000;
  return crossings / 2 / duration;
}

async function rgbAt(filePath: string, seconds: number): Promise<[number, number, number]> {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-v", "error",
    "-i", filePath,
    "-ss", String(seconds),
    "-frames:v", "1",
    "-vf", "scale=1:1",
    "-pix_fmt", "rgb24",
    "-f", "rawvideo",
    "pipe:1",
  ], { encoding: "buffer", maxBuffer: 1024 });
  const rgb = stdout as unknown as Buffer;
  return [rgb[0], rgb[1], rgb[2]];
}

describe("timewarp video media rendering", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "videocity-timewarp-job-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("exports a one-argument job registration function", () => {
    expect(typeof registerTimewarpVideoJob).toBe("function");
    expect(registerTimewarpVideoJob.length).toBe(1);
  });

  it("retimes video while bitstream-copying AAC audio", async () => {
    const inputPath = join(dir, "aac-source.mp4");
    const outputPath = join(dir, "aac-output.mp4");
    await generateAacVideo(inputPath, true);
    const source = await probeVideo(inputPath);
    const plan = createTimewarpPlan({
      sourceDuration: source.duration,
      sourceFps: source.fps,
      startSeconds: 0,
      endSeconds: 1.5,
      stretchFactor: 1.5,
    });

    const audioMode = await renderTimewarpedVideo(inputPath, outputPath, plan, true);
    await validateTimewarpOutput(inputPath, outputPath, plan);

    const output = await probeVideo(outputPath);
    expect(audioMode).toBe("copy");
    expect(output.duration).toBeCloseTo(source.duration, 1);
    expect(await audioStreamHash(outputPath)).toBe(await audioStreamHash(inputPath));
  });

  it("falls back to AAC without changing audio pitch", async () => {
    const inputPath = join(dir, "pcm-source.mov");
    const outputPath = join(dir, "pcm-output.mp4");
    await generatePcmMov(inputPath);
    const source = await probeVideo(inputPath);
    const plan = createTimewarpPlan({
      sourceDuration: source.duration,
      sourceFps: source.fps,
      startSeconds: 0.5,
      endSeconds: 1.5,
      stretchFactor: 0.5,
    });

    const audioMode = await renderTimewarpedVideo(inputPath, outputPath, plan, true);
    await validateTimewarpOutput(inputPath, outputPath, plan);

    const output = await probeVideo(outputPath);
    expect(audioMode).toBe("aac");
    expect(output.audioCodec).toBe("aac");
    expect(await estimateAudioFrequency(outputPath)).toBeCloseTo(
      await estimateAudioFrequency(inputPath),
      0,
    );
  });

  it("keeps silent input silent", async () => {
    const inputPath = join(dir, "silent-source.mp4");
    const outputPath = join(dir, "silent-output.mp4");
    await generateAacVideo(inputPath, false);
    const source = await probeVideo(inputPath);
    const plan = createTimewarpPlan({
      sourceDuration: source.duration,
      sourceFps: source.fps,
      startSeconds: 1,
      endSeconds: 2,
      stretchFactor: 1.5,
    });

    const audioMode = await renderTimewarpedVideo(inputPath, outputPath, plan, false);
    await validateTimewarpOutput(inputPath, outputPath, plan);

    expect(audioMode).toBe("none");
    expect((await probeVideo(outputPath)).hasAudio).toBe(false);
  });

  it("keeps prefix, selection, and suffix in order with one outside factor", async () => {
    const inputPath = join(dir, "middle-source.mp4");
    const outputPath = join(dir, "middle-output.mp4");
    await generateThreeColorVideo(inputPath);
    const source = await probeVideo(inputPath);
    const plan = createTimewarpPlan({
      sourceDuration: source.duration,
      sourceFps: source.fps,
      startSeconds: 2,
      endSeconds: 4,
      stretchFactor: 2,
    });

    await renderTimewarpedVideo(inputPath, outputPath, plan, false);
    await validateTimewarpOutput(inputPath, outputPath, plan);

    const red = await rgbAt(outputPath, 1);
    const greenStart = await rgbAt(outputPath, 1.6);
    const greenEnd = await rgbAt(outputPath, 5.1);
    const blue = await rgbAt(outputPath, 5.6);
    expect(red[0]).toBeGreaterThan(red[1]);
    expect(red[0]).toBeGreaterThan(red[2]);
    expect(greenStart[1]).toBeGreaterThan(greenStart[0]);
    expect(greenStart[1]).toBeGreaterThan(greenStart[2]);
    expect(greenEnd[1]).toBeGreaterThan(greenEnd[0]);
    expect(greenEnd[1]).toBeGreaterThan(greenEnd[2]);
    expect(blue[2]).toBeGreaterThan(blue[0]);
    expect(blue[2]).toBeGreaterThan(blue[1]);
    expect(plan.segments[0].stretchFactor).toBe(plan.segments[2].stretchFactor);
  });
});
