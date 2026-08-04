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
const PROJECT = "audio-sync-media-e2e";

type TextContent = Array<{ type: string; text: string }>;

function parse(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as TextContent)[0].text);
}

function valueOf<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function generateSource(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "color=c=red:s=160x90:r=10:d=1",
    "-f", "lavfi", "-i", "color=c=green:s=160x90:r=10:d=1",
    "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10:d=1.8",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map", "[v]",
    "-map", "3:a:0",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
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

async function readFrameColors(filePath: string): Promise<Array<[number, number, number]>> {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-v", "error",
    "-i", filePath,
    "-map", "0:v:0",
    "-vf", "scale=1:1",
    "-pix_fmt", "rgb24",
    "-f", "rawvideo",
    "pipe:1",
  ], { encoding: "buffer", maxBuffer: 1024 * 1024 });
  const bytes = stdout as unknown as Buffer;
  const colors: Array<[number, number, number]> = [];
  for (let offset = 0; offset + 2 < bytes.length; offset += 3) {
    colors.push([bytes[offset], bytes[offset + 1], bytes[offset + 2]]);
  }
  return colors;
}

function firstDominantFrame(
  colors: ReadonlyArray<readonly [number, number, number]>,
  channel: 0 | 1 | 2,
): number {
  const index = colors.findIndex((color) => {
    const otherChannels = color.filter((_, colorIndex) => colorIndex !== channel);
    return color[channel] > 80 && color[channel] > Math.max(...otherChannels) + 40;
  });
  if (index < 0) throw new Error(`No frame dominated by RGB channel ${channel}`);
  return index;
}

async function waitForMetadata(
  fs: Engine,
  assetId: string,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, "original");
    if (result.ok && result.value.origin === "audio_sync") return result.value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for audio-sync metadata");
}

async function waitForAssetReady(
  fs: Engine,
  assetId: string,
  timeoutMs = 120_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = fs.jobs.artifactWork.read(assetId);
    if (result.ok && result.value?.status === "ready" && result.value.ownerId === null) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for audio-sync asset to become ready");
}

describe("sync_video_to_audio end to end", () => {
  let client: Client;
  let fs: Engine;
  let tempDir: string;
  let sourcePath: string;
  let assetId: string;
  let assetDir: string;
  let bookId: string;
  let sourceMp3: Buffer;
  let transcript: Buffer;

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videocity-audio-sync-e2e-"));
    sourcePath = join(tempDir, "source.mp4");
    const mp3Path = join(tempDir, "source.mp3");
    await generateSource(sourcePath);
    await extractMp3(sourcePath, mp3Path);
    sourceMp3 = await readFile(mp3Path);
    transcript = Buffer.from(JSON.stringify({
      words: [
        { text: "England,", start: 1.2, end: 1.6, type: "word" },
        { text: "America!", start: 2.2, end: 2.7, type: "word" },
      ],
    }));

    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
    bookId = fs.book.get().bookId;
    const project = await client.callTool({
      name: "create_project",
      arguments: { book_id: PROJECT },
    });
    expect(project.isError).toBeFalsy();
    const created = valueOf(await fs.artifacts.create("vid", "audio sync source"));
    assetId = created.artifactId;
    assetDir = created.path;
    valueOf(await fs.files.write(assetId, "original.mp4", await readFile(sourcePath)));
    valueOf(await fs.files.write(assetId, "original.mp3", sourceMp3));
    valueOf(await fs.files.write(assetId, "elevenlabs.json", transcript));
    valueOf(await fs.files.write(assetId, ".original.analysis.json", "{}"));
    valueOf(await fs.files.write(assetId, ".detect-scenes.json", "{}"));
    valueOf(await fs.files.write(assetId, "landscape.mp4", Buffer.from("stale")));
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    fs?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("retimes in place through transcript cues while preserving audio and sidecars", async () => {
    const initialCount = fs.artifacts.list().length;
    const result = await client.callTool({
      name: "sync_video_to_audio",
      arguments: {
        asset_id: assetId,
        book_id: PROJECT,
        anchors: [
          { video_seconds: 1, audio_cue: "england" },
          { video_seconds: 2, audio_cue: "AMERICA?" },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const response = parse(result);
    expect(response.asset_id).toBe(assetId);
    expect(response.job_id).toMatch(/^sync-audio-/);
    expect(response.status).toBe("enqueued");

    await waitForJob(String(response.job_id), 120_000);
    const metadata = await waitForMetadata(fs, assetId);
    await waitForAssetReady(fs, assetId);
    const manifest = valueOf(await fs.files.manifest(assetId));
    const videoFile = findVideoFile(manifest.files);
    expect(videoFile).not.toBeNull();
    const outputPath = join(assetDir, videoFile!.name);
    const [sourceProbe, outputProbe, frameColors] = await Promise.all([
      probeVideo(sourcePath),
      probeVideo(outputPath),
      readFrameColors(outputPath),
    ]);
    expect(sourceProbe.videoDuration).toBeCloseTo(3.8, 6);
    expect(sourceProbe.audioDuration).toBeCloseTo(4, 6);
    expect(sourceProbe.audioDuration).not.toBe(sourceProbe.videoDuration);
    expect(outputProbe.fps).toBeCloseTo(sourceProbe.fps, 6);
    expect(Math.abs(outputProbe.videoDuration - outputProbe.audioDuration!))
      .toBeLessThanOrEqual((1 / outputProbe.fps) + 0.001);

    const greenTransitionSeconds = firstDominantFrame(frameColors, 1) / outputProbe.fps;
    const blueTransitionSeconds = firstDominantFrame(frameColors, 2) / outputProbe.fps;
    const outputFrameDuration = 1 / outputProbe.fps;
    expect(Math.abs(greenTransitionSeconds - 1.2)).toBeLessThanOrEqual(outputFrameDuration);
    expect(Math.abs(blueTransitionSeconds - 2.2)).toBeLessThanOrEqual(outputFrameDuration);

    expect(await audioStreamHash(outputPath)).toBe(await audioStreamHash(sourcePath));
    expect(valueOf(await fs.files.read(assetId, "original.mp3"))).toEqual(sourceMp3);
    expect(valueOf(await fs.files.read(assetId, "elevenlabs.json"))).toEqual(transcript);
    expect((await fs.files.read(assetId, ".original.analysis.json")).ok).toBe(false);
    expect((await fs.files.read(assetId, ".detect-scenes.json")).ok).toBe(false);
    expect((await fs.files.read(assetId, "landscape.mp4")).ok).toBe(false);
    expect(manifest.files.some((file) => file.name.startsWith(".sync-audio-"))).toBe(false);
    expect(fs.artifacts.list().length).toBe(initialCount);

    expect(metadata.requested_anchors).toEqual([
      { video_seconds: 1, audio_cue: "england" },
      { video_seconds: 2, audio_cue: "AMERICA?" },
    ]);
    expect(metadata.resolved_anchors).toEqual([
      { video_seconds: 0, audio_seconds: 0 },
      { video_seconds: 1, audio_seconds: 1.2 },
      { video_seconds: 2, audio_seconds: 2.2 },
      { video_seconds: sourceProbe.videoDuration, audio_seconds: sourceProbe.audioDuration },
    ]);
    expect(metadata.mapping_method).toBe("monotone_cubic_hermite");
    expect(metadata.audio_preserved).toBe(true);
    expect(metadata.audio_mode).toBe("copy");
  }, 120_000);

  it("restores media and derivatives when the render fails", async () => {
    const sourceBytes = await readFile(sourcePath);
    const created = valueOf(await fs.artifacts.create("vid", "failed audio sync"));
    valueOf(await fs.files.write(created.artifactId, "original.mp4", sourceBytes));
    valueOf(await fs.files.write(created.artifactId, "original.mp3", sourceMp3));
    valueOf(await fs.files.write(created.artifactId, "elevenlabs.json", transcript));
    valueOf(await fs.files.write(created.artifactId, ".original.analysis.json", "{}"));
    const historyBefore = fs.history.artifact(created.artifactId)
      .map((revision) => revision.hash);
    const outputPath = join(created.path, "missing", ".sync-audio-failed.mp4");

    await expect(queue.enqueueAndWait(`sync-audio-render-failure-${created.artifactId}`, {
      type: "sync_video_to_audio",
      inputPath: join(created.path, "original.mp4"),
      outputPath,
      anchors: [{ videoSeconds: 1, audioSeconds: 1.2 }],
      assetId: created.artifactId,
      assetDir: created.path,
      bookId,
    } as unknown as Parameters<typeof queue.enqueueAndWait>[1])).rejects.toThrow("ffmpeg failed");

    expect(valueOf(await fs.files.read(created.artifactId, "original.mp4"))).toEqual(sourceBytes);
    expect(valueOf(await fs.files.read(created.artifactId, "original.mp3"))).toEqual(sourceMp3);
    expect(valueOf(await fs.files.read(created.artifactId, "elevenlabs.json"))).toEqual(transcript);
    expect((await fs.files.read(created.artifactId, ".original.analysis.json")).ok).toBe(true);
    // The rollback rewinds the artifact to the revision it held before the
    // job started, so its history is byte-for-byte the pre-job history.
    // Artifact history records what the book *contains*; the record that an
    // attempt happened and failed lives in the runtime tables below.
    expect(fs.history.artifact(created.artifactId).map((revision) => revision.hash))
      .toEqual(historyBefore);
    await expect(stat(outputPath)).rejects.toThrow();
    const manifest = valueOf(await fs.files.manifest(created.artifactId));
    expect(manifest.files.some((file) => file.name.startsWith(".sync-audio-"))).toBe(false);

    // A clean rollback leaves the artifact healthy — no error badge, no
    // lingering failure record, since its content is intact.
    expect(valueOf(await fs.jobs.failures.read(created.artifactId))).toBeNull();
    expect(valueOf(await fs.status.get(created.artifactId))).not.toBe("error");
    // The attempt is still auditable in the append-only action log; without
    // it a failed-then-restored job would leave no record that it ran.
    const jobErrors = fs.logs.read("job-error", { limit: 25 }) as unknown as
      Array<{ assetId?: string; error?: string; rolledBack?: boolean }>;
    expect(jobErrors.some((entry) =>
      entry.assetId === created.artifactId
      && entry.rolledBack === true
      && (entry.error ?? "").includes("ffmpeg failed"))).toBe(true);
  }, 120_000);
});
