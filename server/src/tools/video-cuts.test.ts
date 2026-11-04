import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Engine, NotebookCell } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG, probeVideo, type ProbeResult } from "../ffmpeg.js";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { registerAllJobHandlers } from "../jobs/index.js";
import { queue, setEngineRoot } from "../queue.js";
import { testBudget } from "../test-budget.js";
import { splitVideoDef } from "./split-video.js";
import type { ToolResult } from "./tool-def.js";
import { trimVideoDef } from "./trim-video.js";

const execFileAsync = promisify(execFile);
const SOURCE_SECONDS = 5;
const LONG_AUDIO_FRAMES = 550;
const AUDIO_END_TOLERANCE_SECONDS = 0.0005;
const MOVIE_HEADER_TICK_SECONDS = 0.001;

function resultValue(result: ToolResult): Record<string, unknown> {
  if (result.isError) throw new Error(result.content[0]?.text ?? "Tool failed");
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function errorText(result: ToolResult): string {
  expect(result.isError).toBe(true);
  return result.content[0]?.text ?? "";
}

async function waitForQueueJob(jobId: string): Promise<void> {
  await expect.poll(async () => {
    const status = await queue.getStatus(jobId);
    if (status?.state === "failed") throw new Error(status.error?.message ?? "Job failed");
    return status?.state;
  }, { timeout: testBudget(60_000), interval: 50 }).toBe("completed");
}

async function generateSource(path: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", `testsrc=duration=${SOURCE_SECONDS}:size=320x180:rate=24`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${SOURCE_SECONDS}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    path,
  ]);
}

async function generateLongAudioSource(path: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=18.333333:size=160x120:rate=30",
    "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.1:seed=1:sample_rate=48000:duration=18.401",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    path,
  ]);
}

function videoFrames(probe: ProbeResult): number {
  return Math.round(probe.videoDuration * probe.fps);
}

function expectAudioToStopWithVideo(probe: ProbeResult): void {
  expect(probe.audioDuration).not.toBeNull();
  expect(probe.audioDuration!).toBeLessThanOrEqual(probe.videoDuration + AUDIO_END_TOLERANCE_SECONDS);
  expect(probe.duration).toBeLessThanOrEqual(probe.videoDuration + MOVIE_HEADER_TICK_SECONDS);
}

describe("trim_video and split_video", () => {
  let engine: Engine;
  let root: string;
  let bookId: string;
  let sourcePath: string;
  let longAudioPath: string;
  let notebookId: string;

  async function videoArtifact(label: string, path = sourcePath): Promise<string> {
    const created = await engine.artifacts.create({ kind: "video", label });
    if (!created.ok) throw new Error(created.error.message);
    const written = await engine.files.writeFromPath(created.value.artifactId, "original.mp4", path);
    if (!written.ok) throw new Error(written.error.message);
    return created.value.artifactId;
  }

  async function artifactProbe(artifactId: string): Promise<ProbeResult> {
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    return await probeVideo(join(manifest.value.path, "original.mp4"));
  }

  async function artifactDuration(artifactId: string): Promise<number> {
    return (await artifactProbe(artifactId)).duration;
  }

  async function placeOnNotebook(column: number): Promise<string> {
    const artifactId = await videoArtifact(`source-${column}`);
    const inserted = await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({
      type: "video",
      label: `source ${column}`,
      slot: { row: 0, column },
      outputArtifactId: artifactId,
    }));
    if (!inserted.ok) throw new Error(inserted.error.message);
    return artifactId;
  }

  function notebookCell(cellId: string): NotebookCell {
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const cell = notebook.value.cells.find((candidate) => candidate.id === cellId);
    if (!cell) throw new Error(`Missing cell ${cellId}`);
    return cell;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-video-cuts-"));
    sourcePath = join(root, "source.mp4");
    longAudioPath = join(root, "long-audio.mp4");
    await Promise.all([generateSource(sourcePath), generateLongAudioSource(longAudioPath)]);
    engine = createEngineForTest(root);
    registerAllJobHandlers(engine);
    await setEngineRoot(root, engine);
    bookId = engine.book.get().bookId;
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
  }, testBudget(120_000));

  afterAll(async () => {
    await queue.stop();
    if (root && engine) closeEngineForTest(root, engine);
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }, testBudget(60_000));

  it("removes the last seconds into a new cell wired to the source, keeping the source", async () => {
    const sourceArtifactId = await placeOnNotebook(0);
    const trimmed = resultValue(await trimVideoDef(engine).handler({
      asset_id: "@a1",
      book_id: bookId,
      notebook_id: notebookId,
      tail_seconds: 2,
      output: "new",
    }));
    expect(trimmed).toMatchObject({
      source_asset_id: sourceArtifactId,
      source_address: "@a1",
      output: "new",
      address: "@b1",
      keep_ranges: [{ startSeconds: 0, endSeconds: SOURCE_SECONDS - 2 }],
      status: "queued",
    });
    await waitForQueueJob(String(trimmed.job_id));

    const cell = notebookCell(String(trimmed.cell_id));
    expect(cell).toMatchObject({ type: "video", inputs: { mediaRole: "cut-clip-output", state: "completed" } });
    expect(Number(cell.inputs?.durationSeconds)).toBeCloseTo(SOURCE_SECONDS - 2, 0);
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    expect(notebook.value.cells.some((candidate) => candidate.type === "split_video")).toBe(false);
    expect(notebook.value.edges).toContainEqual(expect.objectContaining({
      target: cell.id,
      targetInput: "segment",
    }));
    expect(await artifactDuration(sourceArtifactId)).toBeGreaterThan(SOURCE_SECONDS - 0.2);
  }, testBudget(120_000));

  it("splits a notebook video at cut points into one cell per piece", async () => {
    await placeOnNotebook(1);
    const split = resultValue(await splitVideoDef(engine).handler({
      asset_id: "@a2",
      book_id: bookId,
      notebook_id: notebookId,
      cut_points: ["2s"],
    }));
    expect(split).toMatchObject({
      source_address: "@a2",
      pieces: [{ startSeconds: 0, endSeconds: 2 }, { startSeconds: 2, endSeconds: SOURCE_SECONDS }],
      cells: [{ address: "@b2" }, { address: "@c2" }],
    });
    await waitForQueueJob(String(split.job_id));
    const durations = (split.cells as Array<{ cell_id: string }>)
      .map((entry) => Number(notebookCell(entry.cell_id).inputs?.durationSeconds));
    expect(durations[0]).toBeCloseTo(2, 0);
    expect(durations[1]).toBeCloseTo(SOURCE_SECONDS - 2, 0);
  }, testBudget(120_000));

  it("splits by chunk durations with the leftover as the last clip", async () => {
    const sourceArtifactId = await videoArtifact("loose source");
    const split = resultValue(await splitVideoDef(engine).handler({
      asset_id: sourceArtifactId,
      book_id: bookId,
      durations: [1, 1.5],
    }));
    expect(split.pieces).toEqual([
      { startSeconds: 0, endSeconds: 1 },
      { startSeconds: 1, endSeconds: 2.5 },
      { startSeconds: 2.5, endSeconds: SOURCE_SECONDS },
    ]);
    const outputs = split.output_asset_ids as string[];
    expect(outputs).toHaveLength(3);
    expect(await artifactDuration(outputs[2]!)).toBeCloseTo(SOURCE_SECONDS - 2.5, 0);
  }, testBudget(120_000));

  it("writes a trimmed copy as a new asset when the source is not on a notebook", async () => {
    const sourceArtifactId = await videoArtifact("loose trim");
    const trimmed = resultValue(await trimVideoDef(engine).handler({
      asset_id: sourceArtifactId,
      book_id: bookId,
      trim_start: "1s",
      trim_end: "0:03",
      output: "new",
    }));
    expect(trimmed.output_asset_id).not.toBe(sourceArtifactId);
    expect(await artifactDuration(String(trimmed.output_asset_id))).toBeCloseTo(2, 0);
    expect(await artifactDuration(sourceArtifactId)).toBeGreaterThan(SOURCE_SECONDS - 0.2);
  }, testBudget(120_000));

  it("removes several ranges in place", async () => {
    const sourceArtifactId = await videoArtifact("in place");
    const trimmed = resultValue(await trimVideoDef(engine).handler({
      asset_id: sourceArtifactId,
      book_id: bookId,
      cuts: [{ start: 0, end: 1 }, { start: "3s", end: "4s" }],
    }));
    expect(trimmed).toMatchObject({
      asset_id: sourceArtifactId,
      output: "in_place",
      keep_ranges: [{ startSeconds: 1, endSeconds: 3 }, { startSeconds: 4, endSeconds: SOURCE_SECONDS }],
      status: "completed",
    });
    expect(await artifactDuration(sourceArtifactId)).toBeCloseTo(SOURCE_SECONDS - 2, 0);
  }, testBudget(120_000));

  it("trims a 30fps source in place to exactly 0-15s when its audio runs past the video", async () => {
    const sourceArtifactId = await videoArtifact("long audio keep", longAudioPath);
    resultValue(await trimVideoDef(engine).handler({
      asset_id: sourceArtifactId,
      book_id: bookId,
      trim_start: 0,
      trim_end: "15s",
    }));
    const probe = await artifactProbe(sourceArtifactId);
    expect(probe.fps).toBe(30);
    expect(videoFrames(probe)).toBe(450);
    expect(probe.videoDuration).toBeCloseTo(15, 5);
    expect(probe.duration).toBeCloseTo(15, 5);
    expectAudioToStopWithVideo(probe);
  }, testBudget(120_000));

  it("keeps every frame through the end when the head is trimmed in place", async () => {
    const sourceArtifactId = await videoArtifact("long audio head", longAudioPath);
    resultValue(await trimVideoDef(engine).handler({
      asset_id: sourceArtifactId,
      book_id: bookId,
      head_seconds: 3,
    }));
    const probe = await artifactProbe(sourceArtifactId);
    expect(videoFrames(probe)).toBe(LONG_AUDIO_FRAMES - 90);
    expectAudioToStopWithVideo(probe);
  }, testBudget(120_000));

  it("keeps the source frame rate when several ranges are removed in place", async () => {
    const sourceArtifactId = await videoArtifact("long audio cuts", longAudioPath);
    resultValue(await trimVideoDef(engine).handler({
      asset_id: sourceArtifactId,
      book_id: bookId,
      cuts: [{ start: 0, end: 1 }, { start: "10s", end: "12.5s" }],
    }));
    const probe = await artifactProbe(sourceArtifactId);
    expect(probe.fps).toBe(30);
    expect(videoFrames(probe)).toBe(LONG_AUDIO_FRAMES - 30 - 75);
    expectAudioToStopWithVideo(probe);
  }, testBudget(120_000));

  it("finishes a keep trim queued without an end by an earlier release", async () => {
    const sourceArtifactId = await videoArtifact("queued keep");
    const manifest = await engine.files.manifest(sourceArtifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    await queue.enqueueAndWait(`trim-${sourceArtifactId}-queued`, {
      type: "trim_video",
      inputPath: join(manifest.value.path, "original.mp4"),
      outputPath: join(manifest.value.path, "original_trimmed.mp4"),
      mode: "keep",
      trimStart: 1,
      assetId: sourceArtifactId,
      assetDir: manifest.value.path,
      bookId,
      commitParams: { mode: "keep", trim_start: 1 },
    });
    const probe = await artifactProbe(sourceArtifactId);
    expect(videoFrames(probe)).toBe((SOURCE_SECONDS - 1) * 24);
  }, testBudget(120_000));

  it("rejects mixed trim modes and trims that remove everything", async () => {
    const sourceArtifactId = await videoArtifact("invalid");
    expect(errorText(await trimVideoDef(engine).handler({
      asset_id: sourceArtifactId,
      book_id: bookId,
      trim_start: 1,
      tail_seconds: 1,
    }))).toContain("one trim mode at a time");
    expect(errorText(await trimVideoDef(engine).handler({
      asset_id: sourceArtifactId,
      book_id: bookId,
      head_seconds: 3,
      tail_seconds: 3,
    }))).toContain("remove the whole video");
    expect(errorText(await splitVideoDef(engine).handler({
      asset_id: sourceArtifactId,
      book_id: bookId,
      cut_points: [1],
      durations: [1],
    }))).toContain("exactly one of");
  }, testBudget(60_000));
});
