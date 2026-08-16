import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Engine, Job } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { closeEngineForTest, createEngineForTest } from "../fs.js";
import { queue, setEngineRoot } from "../queue.js";
import { registerProcessVideoJob } from "./process-video.js";
import { registerReverseVideoJob } from "./reverse-video.js";

const execFileAsync = promisify(execFile);

function valueOf<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function generateMarkedVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "color=c=red:s=160x90:r=10:d=0.8",
    "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10:d=0.8",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1.6",
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

describe("reverse-video job handler", () => {
  let tempDir: string;
  let engineRoot: string;
  let sourcePath: string;
  let fs: Engine;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-reverse-job-"));
    engineRoot = join(tempDir, "engine");
    sourcePath = join(tempDir, "source.mp4");
    await generateMarkedVideo(sourcePath);
    fs = createEngineForTest(engineRoot);
    await setEngineRoot(engineRoot, fs);
    registerReverseVideoJob(fs);
    registerProcessVideoJob(fs);
  }, 60_000);

  afterAll(async () => {
    await queue.stop();
    closeEngineForTest(engineRoot, fs);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("reverses canonical media in place and persists linked media metadata", async () => {
    const asset = valueOf(await fs.artifacts.create("vid", "reverse source"));
    valueOf(await fs.files.write(asset.artifactId, "original.mp4", await readFile(sourcePath)));
    const beforeManifest = valueOf(await fs.files.manifest(asset.artifactId));
    const beforeHash = beforeManifest.files.find((file) => file.name === "original.mp4")?.objectHash;
    const historyCount = fs.history.artifact(asset.artifactId).length;
    const outputPath = join(asset.path, ".reverse-output.mp4");
    const bookId = fs.book.get().bookId;

    const result = await queue.enqueueAndWait<{ success: boolean }>(
      `reverse-behavior-${asset.artifactId}`,
      {
        type: "reverse_video",
        inputPath: join(asset.path, "original.mp4"),
        outputPath,
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
      label: "reverse source",
    });
    expect(fs.history.artifact(asset.artifactId).length).toBeGreaterThan(historyCount);
    await expect(stat(outputPath)).rejects.toThrow();

    const metadata = valueOf(await fs.metadata.artifacts.read<Record<string, unknown>>(
      asset.artifactId,
      "original",
    ));
    expect(metadata).toMatchObject({
      origin: "reverse",
      source_asset_id: asset.artifactId,
      width: 160,
      height: 90,
      hasAudio: true,
    });
    expect(metadata.duration).toBeCloseTo(1.6, 1);
    expect(Date.parse(String(metadata.reversed_at))).not.toBeNaN();

    const streams = valueOf(fs.streams.list(asset.artifactId));
    expect(streams.map((stream) => stream.kind).sort()).toEqual(["audio", "video"]);
    expect(streams.every((stream) => (
      stream.artifactId === asset.artifactId
      && stream.sourcePath === "original.mp4"
      && stream.objectHash === canonical?.objectHash
    ))).toBe(true);

    const output = join(asset.path, "original.mp4");
    const outputProbe = await probeVideo(output);
    expect(outputProbe.duration).toBeCloseTo(1.6, 1);
    const firstFrame = await rgbAt(output, 0.1);
    const lastFrame = await rgbAt(output, 1.3);
    expect(firstFrame[2]).toBeGreaterThan(firstFrame[0]);
    expect(lastFrame[0]).toBeGreaterThan(lastFrame[2]);
  }, 120_000);
});
