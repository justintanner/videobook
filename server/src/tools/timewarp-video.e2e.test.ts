import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { createEngineForTest } from "../fs.js";
import { queue, waitForJob } from "../queue.js";
import { createTestClient } from "../test-client.js";

const execFileAsync = promisify(execFile);
const PROJECT = "timewarp-media-e2e";

type TextContent = Array<{ type: string; text: string }>;

function parse(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as TextContent)[0].text);
}

function valueOf<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function generateCanonicalSource(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "color=c=red:s=160x90:r=10:d=4.2",
    "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10:d=5.8",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
    "-map", "[v]",
    "-map", "2:a:0",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
    outputPath,
  ]);
}

async function extractMp3(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-i", inputPath,
    "-vn",
    "-acodec", "libmp3lame",
    "-q:a", "2",
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

async function waitForTimewarpMetadata(
  fs: Engine,
  assetId: string,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, "original");
    if (result.ok && result.value.origin === "timewarp") return result.value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for timewarp metadata");
}

async function waitForAssetReady(
  fs: Engine,
  assetId: string,
  timeoutMs = 120_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await fs.jobs.artifactWork.read(PROJECT);
    if (result.ok && result.value?.status === "ready" && result.value.ownerId === null) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for timewarp asset to become ready");
}

async function waitForAssetFile(
  fs: Engine,
  assetId: string,
  filename: string,
  timeoutMs = 120_000,
): Promise<Buffer> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await fs.files.read(assetId, filename);
    if (result.ok) return result.value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${filename}`);
}

describe("timewarp_video end to end", () => {
  let client: Client;
  let fs: Engine;
  let tempDir: string;
  let sourcePath: string;
  let sourceBytes: Buffer;
  let assetId: string;
  let assetDir: string;
  let originalMp3: Buffer;
  let transcript: Buffer;
  let timedTranscript: Buffer;
  let initialAssetCount: number;
  let initialHistoryCount: number;

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videocity-timewarp-e2e-"));
    sourcePath = join(tempDir, "canonical-source.mp4");
    const mp3Path = join(tempDir, "canonical-source.mp3");
    await generateCanonicalSource(sourcePath);
    await extractMp3(sourcePath, mp3Path);
    sourceBytes = await readFile(sourcePath);
    originalMp3 = await readFile(mp3Path);
    transcript = Buffer.from(JSON.stringify({ text: "unchanged transcript" }));
    timedTranscript = Buffer.from(JSON.stringify({ words: [{ text: "unchanged", start: 0, end: 1 }] }));

    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
    valueOf(await fs.projects.create(PROJECT));
    const created = valueOf(await fs.artifacts.create("vid", "canonical timewarp"));
    assetId = created.slug;
    assetDir = created.path;
    valueOf(await fs.files.write(assetId, "original.mp4", sourceBytes));
    valueOf(await fs.files.write(assetId, "original.mp3", originalMp3));
    valueOf(await fs.files.write(assetId, ".analysis.gpt4otrans.json", transcript));
    valueOf(await fs.files.write(assetId, "elevenlabs.json", timedTranscript));
    valueOf(await fs.files.write(assetId, ".original.analysis.json", "{}"));
    valueOf(await fs.files.write(assetId, ".detect-scenes.json", "{}"));
    valueOf(await fs.files.write(assetId, "landscape.mp4", Buffer.from("stale")));
    valueOf(await fs.metadata.waveforms.write(assetId, [0.1, 0.5, 0.1]));
    initialAssetCount = (await fs.artifacts.list()).length;
    initialHistoryCount = (await fs.history.artifact(assetId, PROJECT)).length;
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    fs?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("warps the canonical scene in place and preserves audio and transcripts", async () => {
    const result = await client.callTool({
      name: "timewarp_video",
      arguments: {
        asset_id: assetId,
        book_id: PROJECT,
        start_seconds: 0,
        end_seconds: 4.2,
        stretch_factor: 1.5,
      },
    });
    expect(result.isError).toBeFalsy();
    const response = parse(result);
    expect(response.asset_id).toBe(assetId);
    expect(response.source_duration).toBeCloseTo(10, 2);
    expect(response.selected_output_duration).toBeCloseTo(6.3, 2);
    expect(response.outside_stretch_factor).toBeCloseTo(3.7 / 5.8, 4);

    await waitForJob(String(response.job_id), 120_000);
    const metadata = await waitForTimewarpMetadata(fs, assetId);
    await waitForAssetReady(fs, assetId);
    const manifest = valueOf(await fs.files.manifest(assetId, PROJECT));
    const videoFile = findVideoFile(manifest.files);
    expect(videoFile).not.toBeNull();
    const outputPath = join(assetDir, videoFile!.name);
    const outputProbe = await probeVideo(outputPath);
    expect(outputProbe.duration).toBeCloseTo(10, 1);

    const beforeBoundary = await rgbAt(outputPath, 6.1);
    const afterBoundary = await rgbAt(outputPath, 6.5);
    expect(beforeBoundary[0]).toBeGreaterThan(beforeBoundary[2]);
    expect(afterBoundary[2]).toBeGreaterThan(afterBoundary[0]);
    expect(await audioStreamHash(outputPath)).toBe(await audioStreamHash(sourcePath));

    expect(valueOf(await fs.files.read(assetId, "original.mp3"))).toEqual(originalMp3);
    expect(valueOf(await fs.files.read(assetId, ".analysis.gpt4otrans.json"))).toEqual(transcript);
    expect(valueOf(await fs.files.read(assetId, "elevenlabs.json"))).toEqual(timedTranscript);
    expect((await fs.files.read(assetId, ".original.analysis.json")).ok).toBe(false);
    expect((await fs.files.read(assetId, ".detect-scenes.json")).ok).toBe(false);
    expect((await fs.files.read(assetId, "landscape.mp4")).ok).toBe(false);
    expect(manifest.files.some((file) => file.name.startsWith(".timewarp-"))).toBe(false);
    expect((await fs.artifacts.list()).length).toBe(initialAssetCount);
    expect((await fs.history.artifact(assetId, PROJECT)).length).toBeGreaterThan(initialHistoryCount);

    expect(metadata.start_seconds).toBe(0);
    expect(metadata.end_seconds).toBe(4.2);
    expect(metadata.stretch_factor).toBe(1.5);
    expect(metadata.outside_stretch_factor).toBeCloseTo(3.7 / 5.8, 4);
    expect(metadata.audio_preserved).toBe(true);
    expect(metadata.audio_mode).toBe("copy");
  }, 120_000);

  it("saves an original audio sidecar when the asset does not have one", async () => {
    const created = valueOf(await fs.artifacts.create("vid", "timewarp missing audio sidecar"));
    valueOf(await fs.files.write(created.slug, "original.mp4", sourceBytes));
    valueOf(await fs.files.write(created.slug, ".analysis.gpt4otrans.json", transcript));

    const result = await client.callTool({
      name: "timewarp_video",
      arguments: {
        asset_id: created.slug,
        book_id: PROJECT,
        start_seconds: 0,
        end_seconds: 4.2,
        stretch_factor: 1.5,
      },
    });
    expect(result.isError).toBeFalsy();
    const response = parse(result);
    await waitForJob(String(response.job_id), 120_000);
    await waitForTimewarpMetadata(fs, created.slug);
    await waitForAssetReady(fs, created.slug);

    const savedAudio = await waitForAssetFile(fs, created.slug, "original.mp3");
    expect(savedAudio.length).toBeGreaterThan(0);
    expect(valueOf(await fs.files.read(created.slug, ".analysis.gpt4otrans.json"))).toEqual(transcript);
    expect(await audioStreamHash(join(created.path, "original.mp4"))).toBe(await audioStreamHash(sourcePath));
  }, 120_000);

  it("leaves the canonical asset untouched when rendering fails", async () => {
    const created = valueOf(await fs.artifacts.create("vid", "failed timewarp"));
    valueOf(await fs.files.write(created.slug, "original.mp4", sourceBytes));
    valueOf(await fs.files.write(created.slug, ".analysis.gpt4otrans.json", transcript));
    const outputPath = join(created.path, "missing", ".timewarp-failed.mp4");

    await expect(queue.enqueueAndWait(`timewarp-render-failure-${created.slug}`, {
      type: "timewarp_video",
      inputPath: join(created.path, "original.mp4"),
      outputPath,
      startSeconds: 0,
      endSeconds: 4.2,
      stretchFactor: 1.5,
      assetId: created.slug,
      assetDir: created.path,
      bookId: PROJECT,
    } as unknown as Parameters<typeof queue.enqueueAndWait>[1])).rejects.toThrow("ffmpeg failed");

    expect(valueOf(await fs.files.read(created.slug, "original.mp4"))).toEqual(sourceBytes);
    expect(valueOf(await fs.files.read(created.slug, ".analysis.gpt4otrans.json"))).toEqual(transcript);
    await expect(stat(outputPath)).rejects.toThrow();
    const manifest = valueOf(await fs.files.manifest(created.slug, PROJECT));
    expect(manifest.files.some((file) => file.name.startsWith(".timewarp-"))).toBe(false);
  }, 120_000);

  it("returns a structured probe error without changing invalid media", async () => {
    const created = valueOf(await fs.artifacts.create("vid", "invalid media"));
    const invalid = Buffer.from("not an mp4");
    valueOf(await fs.files.write(created.slug, "original.mp4", invalid));

    const result = await client.callTool({
      name: "timewarp_video",
      arguments: {
        asset_id: created.slug,
        book_id: PROJECT,
        start_seconds: 0,
        end_seconds: 1,
        stretch_factor: 1.5,
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("ffprobe failed");
    expect(valueOf(await fs.files.read(created.slug, "original.mp4"))).toEqual(invalid);
    const manifest = valueOf(await fs.files.manifest(created.slug, PROJECT));
    expect(manifest.files.some((file) => file.name.startsWith(".timewarp-"))).toBe(false);
  });
});
