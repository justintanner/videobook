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
import { registerChangeVideoSpeedJob } from "./change-video-speed.js";
import { registerProcessVideoJob } from "./process-video.js";

const execFileAsync = promisify(execFile);

function valueOf<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function generateVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=2:size=160x90:rate=12",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
    outputPath,
  ]);
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
  let fs: Engine;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-speed-job-"));
    engineRoot = join(tempDir, "engine");
    sourcePath = join(tempDir, "source.mp4");
    await generateVideo(sourcePath);
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
    expect(metadata.duration).toBeCloseTo(1, 1);
    expect(Date.parse(String(metadata.speed_changed_at))).not.toBeNaN();

    const streams = valueOf(fs.streams.list(asset.artifactId));
    expect(streams.map((stream) => stream.kind).sort()).toEqual(["audio", "video"]);
    expect(streams.every((stream) => (
      stream.artifactId === asset.artifactId
      && stream.sourcePath === "original.mp4"
      && stream.objectHash === canonical?.objectHash
    ))).toBe(true);

    const outputProbe = await probeVideo(join(asset.path, "original.mp4"));
    expect(outputProbe.duration).toBeCloseTo(1, 1);
    expect(outputProbe.hasAudio).toBe(true);
  }, 120_000);
});
