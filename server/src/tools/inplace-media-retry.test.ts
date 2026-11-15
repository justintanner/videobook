import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createEngineForTest } from "../engine.js";
import { FFPROBE } from "../ffmpeg.js";
import { queue, waitForBookQueuesIdleForTests, waitForJob } from "../queue.js";
import { testBudget } from "../test-budget.js";
import { createTestClient } from "../test-client.js";
import { COMMON_VIDEO_FIXTURES, copyVideoFixture } from "../test-media-fixtures.js";

const execFileAsync = promisify(execFile);
const BOOK = "inplace-retry";

type TextContent = Array<{ type: string; text: string }>;

function textOf(result: { content: unknown }): string {
  return (result.content as TextContent)[0]?.text ?? "";
}

async function probeDims(filePath: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "json",
    filePath,
  ]);
  const data = JSON.parse(stdout) as { streams: Array<{ width: number; height: number }> };
  return { width: data.streams[0].width, height: data.streams[0].height };
}

describe("crop and timewarp retry after a failed in-place run", () => {
  let client: Client;
  let engine: Engine;
  let tempDir: string;
  let videoPath: string;
  let bookId: string;

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videobook-inplace-retry-"));
    videoPath = join(tempDir, "source.mp4");
    await copyVideoFixture(COMMON_VIDEO_FIXTURES.extractAudio, videoPath);
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    bookId = engine.book.get().bookId;
    const project = await client.callTool({
      name: "create_project",
      arguments: { book_id: BOOK },
    });
    expect(project.isError).toBeFalsy();
  }, testBudget(60_000));

  afterAll(async () => {
    await client?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }, testBudget(30_000));

  async function upload(): Promise<{ assetId: string; path: string }> {
    const result = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: BOOK,
        filename: "original.mp4",
        data: (await readFile(videoPath)).toString("base64"),
      },
    });
    expect(result.isError).toBeFalsy();
    const uploaded = JSON.parse(textOf(result)) as { assetId: string; path: string };
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(60_000) });
    return uploaded;
  }

  async function expectFailedLease(assetId: string): Promise<void> {
    const view = engine.jobs.artifactWork.read(assetId);
    if (!view.ok) throw new Error(view.error.message);
    expect(view.value?.status).toBe("error");
    const failure = await engine.jobs.failures.read(assetId);
    if (!failure.ok) throw new Error(failure.error.message);
    expect(failure.value?.message).toMatch(/ffmpeg failed/u);
    expect(engine.jobs.artifactWork.begin(assetId, {
      kind: "crop",
      ownerKind: "job",
      durationMs: 60_000,
    })).toBeNull();
  }

  it("retries crop_video on an asset whose last crop failed", async () => {
    const uploaded = await upload();
    const inputPath = join(uploaded.path, "original.mp4");
    await expect(queue.enqueueAndWait(`crop-fail-${uploaded.assetId}`, {
      type: "crop_video",
      inputPath,
      outputPath: join(uploaded.path, "missing", "crop.mp4"),
      ratio: "1:1",
      rect: { x: 0.125, y: 0, w: 0.75, h: 1 },
      assetId: uploaded.assetId,
      assetDir: uploaded.path,
      bookId,
    } as unknown as Parameters<typeof queue.enqueueAndWait>[1])).rejects.toThrow(/ffmpeg failed/u);
    await expectFailedLease(uploaded.assetId);

    const result = await client.callTool({
      name: "crop_asset",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: BOOK,
        ratio: "1:1",
        x: 0.125,
        y: 0,
        w: 0.75,
        h: 1,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toContain("active owner");
    expect(JSON.parse(textOf(result))).toMatchObject({ status: "completed", ratio: "1:1" });
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(60_000) });
    const dims = await probeDims(inputPath);
    expect(dims).toEqual({ width: 1080, height: 1080 });
    const failure = await engine.jobs.failures.read(uploaded.assetId);
    if (!failure.ok) throw new Error(failure.error.message);
    expect(failure.value).toBeNull();
    const status = await engine.status.get(uploaded.assetId);
    if (!status.ok) throw new Error(status.error.message);
    expect(status.value).not.toBe("error");
  }, testBudget(180_000));

  it("retries timewarp_video on an asset whose last timewarp failed", async () => {
    const uploaded = await upload();
    const inputPath = join(uploaded.path, "original.mp4");
    await expect(queue.enqueueAndWait(`timewarp-fail-${uploaded.assetId}`, {
      type: "timewarp_video",
      inputPath,
      outputPath: join(uploaded.path, "missing", "timewarp.mp4"),
      startSeconds: 0,
      endSeconds: 0.5,
      stretchFactor: 1.5,
      assetId: uploaded.assetId,
      assetDir: uploaded.path,
      bookId,
    } as unknown as Parameters<typeof queue.enqueueAndWait>[1])).rejects.toThrow(/ffmpeg failed/u);
    await expectFailedLease(uploaded.assetId);

    const result = await client.callTool({
      name: "timewarp_video",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: BOOK,
        start_seconds: 0,
        end_seconds: 0.5,
        stretch_factor: 1.5,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toContain("active owner");
    const parsed = JSON.parse(textOf(result)) as { job_id: string; status: string };
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id, testBudget(90_000));
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(60_000) });
    const failure = await engine.jobs.failures.read(uploaded.assetId);
    if (!failure.ok) throw new Error(failure.error.message);
    expect(failure.value).toBeNull();
    const status = await engine.status.get(uploaded.assetId);
    if (!status.ok) throw new Error(status.error.message);
    expect(status.value).not.toBe("error");
    const dims = await probeDims(inputPath);
    expect(dims).toEqual({ width: 320, height: 240 });
  }, testBudget(180_000));
});
