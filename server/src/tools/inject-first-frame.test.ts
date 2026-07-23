import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import sharp from "sharp";
import { createFs, type VideocityFs } from "videobook-engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");
const FFPROBE: string = require("ffprobe-static").path;

type TextContent = Array<{ type: string; text: string }>;

type UploadedAsset = {
  assetId: string;
  path: string;
};

type ProbeSummary = {
  duration: number;
  videoDuration: number;
  audioDuration: number | null;
  fps: string;
  audioCodec: string | null;
};

async function generateVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi",
    "-i", "color=c=blue:size=320x240:rate=10:duration=2",
    "-f", "lavfi",
    "-i", "sine=frequency=440:sample_rate=48000:duration=2",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-shortest",
    outputPath,
  ]);
}

async function generateImage(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi",
    "-i", "color=c=red:size=320x240",
    "-frames:v", "1",
    outputPath,
  ]);
}

async function upload(
  client: Client,
  projectSlug: string,
  filename: string,
  filePath: string,
): Promise<UploadedAsset> {
  const result = await client.callTool({
    name: "upload_file",
    arguments: {
      project_slug: projectSlug,
      filename,
      data: (await readFile(filePath)).toString("base64"),
    },
  });
  if (result.isError) throw new Error((result.content as TextContent)[0].text);
  return JSON.parse((result.content as TextContent)[0].text) as UploadedAsset;
}

async function waitForJob(jobId: string, timeoutMs = 120_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await queue.getStatus(jobId);
    if (status?.state === "completed") return;
    if (status?.state === "failed") {
      throw new Error(`job ${jobId} failed: ${status.error?.message ?? "unknown"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`job ${jobId} did not complete within ${timeoutMs}ms`);
}

function rational(text: string): number {
  const [numerator, denominator] = text.split("/").map(Number);
  return numerator / denominator;
}

async function probeSummary(filePath: string): Promise<ProbeSummary> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      duration?: string;
      r_frame_rate?: string;
    }>;
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  if (!video?.r_frame_rate) throw new Error("video stream missing");
  return {
    duration: Number(parsed.format?.duration),
    videoDuration: Number(video.duration ?? parsed.format?.duration),
    audioDuration: audio ? Number(audio.duration ?? parsed.format?.duration) : null,
    fps: video.r_frame_rate,
    audioCodec: audio?.codec_name ?? null,
  };
}

async function frameCount(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-count_frames",
    "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_frames",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  return Number(stdout.trim());
}

async function audioPacketHash(filePath: string): Promise<string> {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-v", "error",
    "-i", filePath,
    "-map", "0:a",
    "-c:a", "copy",
    "-f", "hash",
    "-hash", "sha256",
    "-",
  ]);
  return stdout.trim();
}

async function frameColor(
  filePath: string,
  frameNumber: number,
  outputDir: string,
  name: string,
): Promise<{ red: number; green: number; blue: number }> {
  const framePath = join(outputDir, `${name}.png`);
  await execFileAsync(FFMPEG, [
    "-y",
    "-i", filePath,
    "-vf", `select=eq(n\\,${frameNumber}),scale=1:1`,
    "-frames:v", "1",
    framePath,
  ]);
  const stats = await sharp(framePath).stats();
  return {
    red: stats.channels[0].mean,
    green: stats.channels[1].mean,
    blue: stats.channels[2].mean,
  };
}

async function assetHash(
  fs: VideocityFs,
  assetId: string,
  filename: string,
  projectSlug: string,
): Promise<string> {
  const result = await fs.readFile(assetId, filename, projectSlug);
  if (!result.ok) throw new Error(result.error.message);
  return createHash("sha256").update(result.value).digest("hex");
}

describe("inject_first_frame tool", () => {
  let client: Client;
  let fs: VideocityFs;
  let tempDir: string;
  let fixtureDir: string;
  let videoFixture: string;
  let imageFixture: string;
  const projectSlug = "inject-first-frame-proj";

  beforeAll(async () => {
    await queue.start();
    fixtureDir = await mkdtemp(join(tmpdir(), "videocity-inject-first-frame-fixture-"));
    videoFixture = join(fixtureDir, "blue.mp4");
    imageFixture = join(fixtureDir, "red.png");
    await Promise.all([
      generateVideo(videoFixture),
      generateImage(imageFixture),
    ]);
  }, 60_000);

  afterAll(async () => {
    await queue.stop();
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 3 });
  }, 30_000);

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-inject-first-frame-test-"));
    client = await createTestClient(tempDir);
    fs = createFs({ projectsDir: tempDir });
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: projectSlug },
    });
  }, 60_000);

  afterEach(async () => {
    await client?.close();
    fs?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }, 60_000);

  it("replaces only frame zero of a vid asset and preserves encoded audio and timing", async () => {
    const video = await upload(client, projectSlug, "blue.mp4", videoFixture);
    const image = await upload(client, projectSlug, "red.png", imageFixture);
    const videoPath = join(video.path, "original.mp4");
    const beforeProbe = await probeSummary(videoPath);
    const beforeFrameCount = await frameCount(videoPath);
    const beforeAudioHash = await audioPacketHash(videoPath);

    const result = await client.callTool({
      name: "inject_first_frame",
      arguments: {
        target_asset_id: `@${video.assetId}`,
        image_asset_id: `@${image.assetId}`,
        project_slug: projectSlug,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text) as Record<string, unknown>;
    expect(parsed.target_asset_id).toBe(video.assetId);
    expect(parsed.orientation).toBeNull();
    await waitForJob(String(parsed.job_id));

    const afterProbe = await probeSummary(videoPath);
    expect(await frameCount(videoPath)).toBe(beforeFrameCount);
    expect(await audioPacketHash(videoPath)).toBe(beforeAudioHash);
    expect(afterProbe.audioCodec).toBe(beforeProbe.audioCodec);
    expect(afterProbe.duration).toBeCloseTo(beforeProbe.duration, 2);
    expect(afterProbe.videoDuration).toBeCloseTo(beforeProbe.videoDuration, 2);
    expect(afterProbe.audioDuration).toBeCloseTo(beforeProbe.audioDuration!, 2);
    expect(rational(afterProbe.fps)).toBeCloseTo(rational(beforeProbe.fps), 4);

    const first = await frameColor(videoPath, 0, tempDir, "vid-first");
    const second = await frameColor(videoPath, 1, tempDir, "vid-second");
    expect(first.red).toBeGreaterThan(200);
    expect(first.blue).toBeLessThan(80);
    expect(second.blue).toBeGreaterThan(180);
    expect(second.red).toBeLessThan(80);
  }, 120_000);

  it("uses the active final orientation and leaves other final outputs untouched", async () => {
    const video = await upload(client, projectSlug, "blue.mp4", videoFixture);
    const image = await upload(client, projectSlug, "red.png", imageFixture);
    const original = await fs.readFile(video.assetId, "original.mp4", projectSlug);
    if (!original.ok) throw new Error(original.error.message);
    const writes = await Promise.all([
      fs.writeFile(video.assetId, "landscape.mp4", original.value, projectSlug),
      fs.writeFile(video.assetId, "portrait.mp4", original.value, projectSlug),
      fs.writeProjectMeta("timeline", {
        slots: [{ slug: video.assetId }],
        render: "portrait",
        currentOrientation: "portrait",
      }, projectSlug),
    ]);
    for (const write of writes) {
      if (!write.ok) throw new Error(write.error.message);
    }

    for (const orientation of ["landscape", "portrait"] as const) {
      const render = await client.callTool({
        name: "render_timeline",
        arguments: { project_slug: projectSlug, orientation },
      });
      if (render.isError) throw new Error((render.content as TextContent)[0].text);
      const renderResult = JSON.parse((render.content as TextContent)[0].text) as Record<string, unknown>;
      await waitForJob(String(renderResult.job_id));
    }

    const finalManifest = await fs.getManifest("final", projectSlug);
    if (!finalManifest.ok) throw new Error(finalManifest.error.message);
    const portraitPath = join(finalManifest.value.path, "timeline_portrait.mp4");
    const beforeProbe = await probeSummary(portraitPath);
    const beforeAudioHash = await audioPacketHash(portraitPath);
    const beforeFrameCount = await frameCount(portraitPath);
    const landscapeHash = await assetHash(fs, "final", "timeline_landscape.mp4", projectSlug);

    const result = await client.callTool({
      name: "inject_first_frame",
      arguments: {
        target_asset_id: "final",
        image_asset_id: image.assetId,
        project_slug: projectSlug,
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text) as Record<string, unknown>;
    expect(parsed.orientation).toBe("portrait");
    expect(parsed.target_filename).toBe("timeline_portrait.mp4");
    await waitForJob(String(parsed.job_id));

    const afterProbe = await probeSummary(portraitPath);
    expect(await frameCount(portraitPath)).toBe(beforeFrameCount);
    expect(await audioPacketHash(portraitPath)).toBe(beforeAudioHash);
    expect(afterProbe.duration).toBeCloseTo(beforeProbe.duration, 2);
    expect(afterProbe.videoDuration).toBeCloseTo(beforeProbe.videoDuration, 2);
    expect(afterProbe.audioDuration).toBeCloseTo(beforeProbe.audioDuration!, 2);
    expect(await assetHash(fs, "final", "timeline_landscape.mp4", projectSlug)).toBe(landscapeHash);

    const first = await frameColor(portraitPath, 0, tempDir, "final-first");
    const second = await frameColor(portraitPath, 1, tempDir, "final-second");
    expect(first.red).toBeGreaterThan(200);
    expect(first.blue).toBeLessThan(80);
    expect(second.blue).toBeGreaterThan(180);
    expect(second.red).toBeLessThan(80);
  }, 120_000);

  it("rejects invalid target, image, and orientation combinations", async () => {
    const video = await upload(client, projectSlug, "blue.mp4", videoFixture);
    const image = await upload(client, projectSlug, "red.png", imageFixture);

    const invalidTarget = await client.callTool({
      name: "inject_first_frame",
      arguments: {
        target_asset_id: image.assetId,
        image_asset_id: image.assetId,
        project_slug: projectSlug,
      },
    });
    expect(invalidTarget.isError).toBe(true);

    const invalidImage = await client.callTool({
      name: "inject_first_frame",
      arguments: {
        target_asset_id: video.assetId,
        image_asset_id: video.assetId,
        project_slug: projectSlug,
      },
    });
    expect(invalidImage.isError).toBe(true);

    const invalidOrientation = await client.callTool({
      name: "inject_first_frame",
      arguments: {
        target_asset_id: video.assetId,
        image_asset_id: image.assetId,
        project_slug: projectSlug,
        orientation: "portrait",
      },
    });
    expect(invalidOrientation.isError).toBe(true);
  }, 120_000);
});
