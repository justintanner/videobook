import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import { createTestClient } from "../test-client.js";
import { queue, waitForJob } from "../queue.js";
import { FFMPEG } from "../ffmpeg.js";
import { spliceCutForOverlap } from "../splice-match.js";
import { testBudget } from "../test-budget.js";

const execFileAsync = promisify(execFile);
const BOOK = "preview-splice-proj";

type TextContent = Array<{ type: string; text: string }>;

type PreviewResponse = {
  fps: number;
  first_duration: number;
  second_duration: number;
  window: number;
  window_start_frame: number;
  scores: number[];
};

async function colorVideo(outputPath: string, colors: string[]): Promise<void> {
  const inputs = colors.flatMap((color) => [
    "-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=10:d=1`,
  ]);
  const streams = colors.map((_, index) => `[${index}:v]`).join("");
  await execFileAsync(FFMPEG, [
    "-y",
    ...inputs,
    "-filter_complex", `${streams}concat=n=${colors.length}:v=1:a=0[v]`,
    "-map", "[v]",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    outputPath,
  ]);
}

async function upload(client: Client, path: string): Promise<string> {
  const data = (await readFile(path)).toString("base64");
  const result = await client.callTool({
    name: "upload_file",
    arguments: { book_id: BOOK, filename: "original.mp4", data },
  });
  return (JSON.parse((result.content as TextContent)[0].text) as { assetId: string }).assetId;
}

function responseJson<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  return JSON.parse((result.content as TextContent)[0].text) as T;
}

function matchFrom(preview: PreviewResponse) {
  return {
    fps: preview.fps,
    firstDuration: preview.first_duration,
    windowStartFrame: preview.window_start_frame,
    scores: preview.scores,
  };
}

describe("preview_splice tool", () => {
  let client: Client;
  let tempDir: string;
  let fixtureDir: string;
  let firstPath: string;
  let secondPath: string;

  beforeAll(async () => {
    await queue.start();
    fixtureDir = await mkdtemp(join(tmpdir(), "videobook-preview-splice-fixture-"));
    firstPath = join(fixtureDir, "first.mp4");
    secondPath = join(fixtureDir, "second.mp4");
    await colorVideo(firstPath, ["blue", "red", "blue"]);
    await colorVideo(secondPath, ["blue"]);
  }, testBudget(60_000));

  afterAll(async () => {
    await queue.stop();
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 3 });
  }, testBudget(30_000));

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-preview-splice-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({ name: "create_project", arguments: { book_id: BOOK } });
  }, testBudget(120_000));

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }, testBudget(120_000));

  it("scores the tail of the first clip and predicts the cut splice_video makes", async () => {
    const first = await upload(client, firstPath);
    const second = await upload(client, secondPath);

    const previewResult = await client.callTool({
      name: "preview_splice",
      arguments: { book_id: BOOK, first_asset_id: first, second_asset_id: second, window: 2 },
    });
    expect(previewResult.isError).toBeFalsy();
    const preview = responseJson<PreviewResponse>(previewResult);
    expect(preview.window).toBe(2);
    expect(preview.window_start_frame).toBe(10);
    expect(preview.scores.length).toBeGreaterThanOrEqual(19);
    const redScore = preview.scores[5]!;
    const blueScore = preview.scores[15]!;
    expect(redScore).toBeGreaterThan(blueScore + 20);

    const wide = spliceCutForOverlap(matchFrom(preview), 2);
    expect(wide?.timestamp).toBeCloseTo(2, 5);
    const narrow = spliceCutForOverlap(matchFrom(preview), 0.5);
    expect(narrow?.timestamp).toBeCloseTo(2.5, 5);
    expect(spliceCutForOverlap(matchFrom(preview), 0)).toEqual({
      frameIndex: null,
      timestamp: preview.first_duration,
      score: null,
    });

    const spliceResult = await client.callTool({
      name: "splice_video",
      arguments: { book_id: BOOK, first_asset_id: first, second_asset_id: second, overlap: 0.5 },
    });
    const splice = responseJson<{ asset_id: string; job_id: string }>(spliceResult);
    await waitForJob(splice.job_id, testBudget(60_000));
    const metadata = await client.callTool({
      name: "read_asset_metadata",
      arguments: { book_id: BOOK, asset_id: splice.asset_id, name: "original" },
    });
    expect((metadata.content as TextContent)[0].text).toContain(`"splice_timestamp":${narrow?.timestamp}`);
  }, testBudget(120_000));

  it("rejects the same clip on both sides", async () => {
    const first = await upload(client, firstPath);
    const result = await client.callTool({
      name: "preview_splice",
      arguments: { book_id: BOOK, first_asset_id: first, second_asset_id: first },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("unique");
  });
});
