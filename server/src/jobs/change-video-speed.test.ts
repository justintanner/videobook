import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Engine, Job } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG, FFPROBE, probeVideo } from "../ffmpeg.js";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { queue, setEngineRoot } from "../queue.js";
import { registerChangeVideoSpeedJob } from "./change-video-speed.js";
import { registerProcessVideoJob } from "./process-video.js";

const execFileAsync = promisify(execFile);

function valueOf<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function generateVideo(
  outputPath: string,
  videoCodec = "libx264",
  pixelFormat = "yuv420p",
): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=2:size=160x90:rate=12",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", videoCodec,
    "-preset", "ultrafast",
    "-pix_fmt", pixelFormat,
    "-c:a", "aac",
    "-shortest",
    outputPath,
  ]);
}

// 6s fixture with unmistakable content markers: red/green/blue thirds and a
// 440 Hz tone that switches to an 880 Hz tail cue at 4.8s. Tail-preservation
// assertions key off the blue segment and the 880 Hz cue.
async function generateMarkerVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "color=red:size=320x180:rate=12:duration=2",
    "-f", "lavfi", "-i", "color=green:size=320x180:rate=12:duration=2",
    "-f", "lavfi", "-i", "color=blue:size=320x180:rate=12:duration=2",
    "-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,4.8)\\,sin(2*PI*440*t)\\,sin(2*PI*880*t)):s=44100:duration=6",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map", "[v]", "-map", "3:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    outputPath,
  ]);
}

// Silent variant of the marker fixture: same color thirds, no audio track.
async function generateSilentMarkerVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "color=red:size=320x180:rate=12:duration=2",
    "-f", "lavfi", "-i", "color=green:size=320x180:rate=12:duration=2",
    "-f", "lavfi", "-i", "color=blue:size=320x180:rate=12:duration=2",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map", "[v]",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-an",
    outputPath,
  ]);
}

interface StreamCounts {
  formatDuration: number;
  video: { start: number; duration: number; frames: number };
  audio: { duration: number } | null;
}

async function probeStreamCounts(videoPath: string): Promise<StreamCounts> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error", "-count_frames",
    "-show_entries", "stream=codec_type,start_time,duration,nb_read_frames",
    "-show_entries", "format=duration",
    "-of", "json", videoPath,
  ]);
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<Record<string, unknown>>;
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  if (!video) throw new Error(`no video stream in ${videoPath}`);
  return {
    formatDuration: Number(data.format?.duration ?? 0),
    video: {
      start: Number(video.start_time ?? 0),
      duration: Number(video.duration ?? 0),
      frames: Number(video.nb_read_frames ?? 0),
    },
    audio: audio ? { duration: Number(audio.duration ?? 0) } : null,
  };
}

// Seeks relative to the video stream end so a longer audio stream (container
// overhang) cannot push the seek past the final frame. The 0.15s margin
// absorbs a full retimed frame interval plus muxer rounding.
async function lastFrameColor(
  videoPath: string,
  videoDuration: number,
): Promise<{ r: number; g: number; b: number }> {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-v", "error",
    "-ss", String(Math.max(0, videoDuration - 0.15)),
    "-i", videoPath,
    "-an", "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 8 << 20 });
  const buf = stdout as unknown as Buffer;
  if (buf.length === 0) throw new Error(`no frame near the end of ${videoPath}`);
  let r = 0, g = 0, b = 0;
  const n = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

async function toneFrequency(
  videoPath: string,
  seekArgs: string[],
): Promise<number> {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-v", "error", ...seekArgs, "-i", videoPath,
    "-vn", "-ac", "1", "-ar", "8000", "-t", "0.4",
    "-f", "s16le", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 8 << 20 });
  const buf = stdout as unknown as Buffer;
  let crossings = 0;
  for (let i = 2; i + 1 < buf.length; i += 2) {
    const prev = buf.readInt16LE(i - 2);
    const cur = buf.readInt16LE(i);
    if ((prev < 0 && cur >= 0) || (prev >= 0 && cur < 0)) crossings++;
  }
  const seconds = (buf.length / 2) / 8000;
  return seconds > 0 ? Math.round(crossings / 2 / seconds) : 0;
}

function expectBlueTail(color: { r: number; g: number; b: number }): void {
  expect(color.b).toBeGreaterThan(150);
  expect(color.r).toBeLessThan(100);
  expect(color.g).toBeLessThan(100);
}

async function probeVideoFormat(
  videoPath: string,
): Promise<{ codec: string | null; pixelFormat: string | null }> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,pix_fmt",
    "-of", "json",
    videoPath,
  ]);
  const data = JSON.parse(stdout) as {
    streams?: Array<{ codec_name?: unknown; pix_fmt?: unknown }>;
  };
  const stream = data.streams?.[0];
  return {
    codec: typeof stream?.codec_name === "string" ? stream.codec_name : null,
    pixelFormat: typeof stream?.pix_fmt === "string" ? stream.pix_fmt : null,
  };
}

async function waitForProcessVideo(
  fs: Engine,
  assetId: string,
  timeoutMs = 120_000,
): Promise<Job> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = fs.jobs.queue.list({ type: "process_video", artifactId: assetId })[0];
    if (job?.state === "done") return job;
    if (job?.state === "failed" || job?.state === "aborted") {
      throw new Error(job.error?.message ?? `process_video ${job.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for process_video on ${assetId}`);
}

describe("change-video-speed job handler", () => {
  let tempDir: string;
  let engineRoot: string;
  let sourcePath: string;
  let tenBitSourcePath: string;
  let markerSourcePath: string;
  let fs: Engine;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-speed-job-"));
    engineRoot = join(tempDir, "engine");
    sourcePath = join(tempDir, "source.mp4");
    tenBitSourcePath = join(tempDir, "source-10-bit.mp4");
    markerSourcePath = join(tempDir, "source-markers.mp4");
    await generateVideo(sourcePath);
    await generateVideo(tenBitSourcePath, "libx265", "yuv420p10le");
    await generateMarkerVideo(markerSourcePath);
    fs = createEngineForTest(engineRoot);
    await setEngineRoot(engineRoot, fs);
    registerChangeVideoSpeedJob(fs);
    registerProcessVideoJob(fs);
  }, 60_000);

  afterAll(async () => {
    await queue.stop();
    closeEngineForTest(engineRoot, fs);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("changes canonical media duration in place and persists linked media metadata", async () => {
    const asset = valueOf(await fs.artifacts.create("vid", "speed source"));
    valueOf(await fs.files.write(asset.artifactId, "original.mp4", await readFile(sourcePath)));
    const beforeManifest = valueOf(await fs.files.manifest(asset.artifactId));
    const beforeHash = beforeManifest.files.find((file) => file.name === "original.mp4")?.objectHash;
    const historyCount = fs.history.artifact(asset.artifactId).length;
    const outputPath = join(asset.path, ".speed-output.mp4");
    const bookId = fs.book.get().bookId;

    const result = await queue.enqueueAndWait<{ success: boolean }>(
      `speed-behavior-${asset.artifactId}`,
      {
        type: "change_video_speed",
        inputPath: join(asset.path, "original.mp4"),
        outputPath,
        speed: 2,
        targetDuration: 1,
        hasAudio: true,
        assetId: asset.artifactId,
        assetDir: asset.path,
        bookId,
      },
      120_000,
    );

    expect(result).toEqual({ success: true });
    await waitForProcessVideo(fs, asset.artifactId);

    const manifest = valueOf(await fs.files.manifest(asset.artifactId));
    const canonical = manifest.files.find((file) => file.name === "original.mp4");
    expect(canonical?.objectHash).not.toBe(beforeHash);
    expect(fs.artifacts.list()).toHaveLength(1);
    expect(valueOf(fs.artifacts.get(asset.artifactId))).toMatchObject({
      artifactId: asset.artifactId,
      kind: "video",
      label: "speed source",
    });
    expect(fs.history.artifact(asset.artifactId).length).toBeGreaterThan(historyCount);
    await expect(stat(outputPath)).rejects.toThrow();

    const metadata = valueOf(await fs.metadata.artifacts.read<Record<string, unknown>>(
      asset.artifactId,
      "original",
    ));
    expect(metadata).toMatchObject({
      origin: "speed_change",
      source_asset_id: asset.artifactId,
      speed: 2,
      targetDuration: 1,
      width: 160,
      height: 90,
      hasAudio: true,
    });
    // Passthrough retiming keeps every frame; the muxer pads the final
    // frame's display duration, so exact output duration carries a documented
    // tolerance of one source frame interval (1/12s on this fixture).
    expect(Math.abs(Number(metadata.duration) - 1)).toBeLessThan(0.1);
    expect(Date.parse(String(metadata.speed_changed_at))).not.toBeNaN();
    const streams = valueOf(fs.streams.list(asset.artifactId));
    expect(streams.map((stream) => stream.kind).sort()).toEqual(["audio", "video"]);
    expect(streams.every((stream) => (
      stream.artifactId === asset.artifactId
      && stream.sourcePath === "original.mp4"
      && stream.objectHash === canonical?.objectHash
    ))).toBe(true);

    const outputProbe = await probeVideo(join(asset.path, "original.mp4"));
    expect(Math.abs(outputProbe.duration - 1)).toBeLessThan(0.1);
    expect(outputProbe.hasAudio).toBe(true);
  }, 120_000);

  it("normalizes 10-bit HEVC input to 8-bit H.264", async () => {
    expect(await probeVideoFormat(tenBitSourcePath)).toEqual({
      codec: "hevc",
      pixelFormat: "yuv420p10le",
    });
    const asset = valueOf(await fs.artifacts.create("vid", "10-bit speed source"));
    valueOf(await fs.files.write(
      asset.artifactId,
      "original.mp4",
      await readFile(tenBitSourcePath),
    ));
    const outputPath = join(asset.path, ".speed-output.mp4");

    const result = await queue.enqueueAndWait<{ success: boolean }>(
      `speed-10-bit-${asset.artifactId}`,
      {
        type: "change_video_speed",
        inputPath: join(asset.path, "original.mp4"),
        outputPath,
        speed: 2,
        targetDuration: 1,
        hasAudio: true,
        assetId: asset.artifactId,
        assetDir: asset.path,
        bookId: fs.book.get().bookId,
      },
      120_000,
    );

    expect(result).toEqual({ success: true });
    await waitForProcessVideo(fs, asset.artifactId);
    expect(await probeVideoFormat(join(asset.path, "original.mp4"))).toEqual({
      codec: "h264",
      pixelFormat: "yuv420p",
    });
  }, 120_000);

  it("preserves every source frame and the final audio cue at 1.3x", async () => {
    const asset = valueOf(await fs.artifacts.create("vid", "speed tail markers"));
    valueOf(await fs.files.write(asset.artifactId, "original.mp4", await readFile(markerSourcePath)));
    const source = await probeStreamCounts(join(asset.path, "original.mp4"));
    expect(source.video.frames).toBe(72);
    expect(source.video.duration).toBeCloseTo(6, 1);
    expect(source.audio?.duration).toBeCloseTo(6, 1);
    const outputPath = join(asset.path, ".speed-output.mp4");

    const result = await queue.enqueueAndWait<{ success: boolean }>(
      `speed-tail-${asset.artifactId}`,
      {
        type: "change_video_speed",
        inputPath: join(asset.path, "original.mp4"),
        outputPath,
        speed: 1.3,
        hasAudio: true,
        assetId: asset.artifactId,
        assetDir: asset.path,
        bookId: fs.book.get().bookId,
      },
      120_000,
    );

    expect(result).toEqual({ success: true });
    await waitForProcessVideo(fs, asset.artifactId);

    // Every source frame must survive: elapsed duration shrinks by the speed
    // factor, but the frame count stays at 72 and the blue tail segment and
    // 880 Hz cue remain, in order, at the end.
    const canonicalPath = join(asset.path, "original.mp4");
    const counts = await probeStreamCounts(canonicalPath);
    const expected = source.video.duration / 1.3;
    expect(counts.video.frames).toBe(source.video.frames);
    expect(Math.abs(counts.video.duration - expected)).toBeLessThan(0.1);
    expect(Math.abs((counts.audio?.duration ?? 0) - expected)).toBeLessThan(0.15);
    expectBlueTail(await lastFrameColor(canonicalPath, counts.video.duration));
    expect(await toneFrequency(canonicalPath, ["-ss", "0.2"])).toBeGreaterThanOrEqual(400);
    expect(await toneFrequency(canonicalPath, ["-ss", "0.2"])).toBeLessThanOrEqual(480);
    expect(await toneFrequency(canonicalPath, ["-sseof", "-0.45"])).toBeGreaterThanOrEqual(840);
    expect(await toneFrequency(canonicalPath, ["-sseof", "-0.45"])).toBeLessThanOrEqual(920);

    // The regenerated proxy must match the validated canonical output.
    const manifest = valueOf(await fs.files.manifest(asset.artifactId));
    expect(manifest.files.some((file) => file.name === "proxy.mp4")).toBe(true);
    const proxyCounts = await probeStreamCounts(join(asset.path, "proxy.mp4"));
    expect(proxyCounts.video.frames).toBe(source.video.frames);
    expect(Math.abs(proxyCounts.video.duration - counts.video.duration)).toBeLessThan(0.1);
    expectBlueTail(await lastFrameColor(join(asset.path, "proxy.mp4"), proxyCounts.video.duration));
  }, 120_000);

  it("keeps the complete tail in exact target-duration mode", async () => {
    const asset = valueOf(await fs.artifacts.create("vid", "speed exact-duration markers"));
    valueOf(await fs.files.write(asset.artifactId, "original.mp4", await readFile(markerSourcePath)));
    const source = await probeStreamCounts(join(asset.path, "original.mp4"));
    const targetDuration = 4.6;
    const speed = source.video.duration / targetDuration;
    const outputPath = join(asset.path, ".speed-output.mp4");

    const result = await queue.enqueueAndWait<{ success: boolean }>(
      `speed-exact-${asset.artifactId}`,
      {
        type: "change_video_speed",
        inputPath: join(asset.path, "original.mp4"),
        outputPath,
        speed,
        targetDuration,
        hasAudio: true,
        assetId: asset.artifactId,
        assetDir: asset.path,
        bookId: fs.book.get().bookId,
      },
      120_000,
    );

    expect(result).toEqual({ success: true });
    await waitForProcessVideo(fs, asset.artifactId);

    // One output frame of slack ((1/12s)/speed ≈ 0.064s) covers the muxer
    // rounding the final frame's display duration past the cap.
    const canonicalPath = join(asset.path, "original.mp4");
    const counts = await probeStreamCounts(canonicalPath);
    expect(counts.video.frames).toBe(source.video.frames);
    expect(Math.abs(counts.video.duration - targetDuration)).toBeLessThan(0.09);
    expect(Math.abs((counts.audio?.duration ?? 0) - targetDuration)).toBeLessThan(0.15);
    expectBlueTail(await lastFrameColor(canonicalPath, counts.video.duration));
    expect(await toneFrequency(canonicalPath, ["-sseof", "-0.45"])).toBeGreaterThanOrEqual(840);
    expect(await toneFrequency(canonicalPath, ["-sseof", "-0.45"])).toBeLessThanOrEqual(920);
  }, 120_000);

  it("preserves every frame for silent sources at 1.3x", async () => {
    const silentSourcePath = join(tempDir, "source-markers-silent.mp4");
    await generateSilentMarkerVideo(silentSourcePath);
    const asset = valueOf(await fs.artifacts.create("vid", "silent speed source"));
    valueOf(await fs.files.write(asset.artifactId, "original.mp4", await readFile(silentSourcePath)));
    const source = await probeStreamCounts(join(asset.path, "original.mp4"));
    expect(source.video.frames).toBe(72);
    expect(source.audio).toBeNull();
    const outputPath = join(asset.path, ".speed-output.mp4");

    const result = await queue.enqueueAndWait<{ success: boolean }>(
      `speed-silent-${asset.artifactId}`,
      {
        type: "change_video_speed",
        inputPath: join(asset.path, "original.mp4"),
        outputPath,
        speed: 1.3,
        hasAudio: false,
        assetId: asset.artifactId,
        assetDir: asset.path,
        bookId: fs.book.get().bookId,
      },
      120_000,
    );

    expect(result).toEqual({ success: true });
    await waitForProcessVideo(fs, asset.artifactId);

    const canonicalPath = join(asset.path, "original.mp4");
    const counts = await probeStreamCounts(canonicalPath);
    expect(counts.video.frames).toBe(source.video.frames);
    expect(Math.abs(counts.video.duration - source.video.duration / 1.3)).toBeLessThan(0.1);
    expect(counts.audio).toBeNull();
    expectBlueTail(await lastFrameColor(canonicalPath, counts.video.duration));
  }, 120_000);

  it("rejects invalid retime output without replacing canonical media", async () => {    const asset = valueOf(await fs.artifacts.create("vid", "speed invalid output"));
    valueOf(await fs.files.write(asset.artifactId, "original.mp4", await readFile(markerSourcePath)));
    const beforeManifest = valueOf(await fs.files.manifest(asset.artifactId));
    const beforeHash = beforeManifest.files.find((file) => file.name === "original.mp4")?.objectHash;
    const historyCount = fs.history.artifact(asset.artifactId).length;
    const outputPath = join(asset.path, ".speed-output.mp4");

    // hasAudio:false is a lie — the source carries audio. The retime therefore
    // produces a silent file that must fail output validation.
    await expect(queue.enqueueAndWait(
      `speed-invalid-${asset.artifactId}`,
      {
        type: "change_video_speed",
        inputPath: join(asset.path, "original.mp4"),
        outputPath,
        speed: 1.3,
        hasAudio: false,
        assetId: asset.artifactId,
        assetDir: asset.path,
        bookId: fs.book.get().bookId,
      },
      120_000,
    )).rejects.toThrow(/audio/i);

    const manifest = valueOf(await fs.files.manifest(asset.artifactId));
    expect(manifest.files.find((file) => file.name === "original.mp4")?.objectHash).toBe(beforeHash);
    expect(fs.history.artifact(asset.artifactId).length).toBe(historyCount);
    await expect(stat(outputPath)).rejects.toThrow();
    const counts = await probeStreamCounts(join(asset.path, "original.mp4"));
    expect(counts.video.frames).toBe(72);
    expect(counts.audio).not.toBeNull();
  }, 120_000);
});
