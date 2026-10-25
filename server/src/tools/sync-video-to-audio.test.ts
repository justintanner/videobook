import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FFMPEG } from "../ffmpeg.js";
import { createEngineForTest } from "../engine.js";
import { queue, waitForJob } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";

const execFileAsync = promisify(execFile);
const PROJECT = "audio-sync-tool";
const MISSING_ARTIFACT_ID = "019fcc6b-46ed-71ce-8f32-2b79cc4dfbbf";

type TextContent = Array<{ type: string; text: string }>;

function valueOf<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("sync_video_to_audio tool", () => {
  let client: Client;
  let fs: Engine;
  let tempDir: string;
  let silentAssetId: string;
  let audioAssetId: string;

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videocity-audio-sync-tool-"));
    const silentPath = join(tempDir, "silent.mp4");
    const audioPath = join(tempDir, "audio.mp4");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=2:size=160x90:rate=12",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-an",
      silentPath,
    ]);
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=2:size=160x90:rate=12",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      audioPath,
    ]);

    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: PROJECT },
    });
    const created = valueOf(await fs.artifacts.create("vid", "silent sync source"));
    silentAssetId = created.artifactId;
    valueOf(await fs.files.write(silentAssetId, "original.mp4", await readFile(silentPath)));
    const audioCreated = valueOf(await fs.artifacts.create("vid", "audio sync source"));
    audioAssetId = audioCreated.artifactId;
    valueOf(await fs.files.write(audioAssetId, "original.mp4", await readFile(audioPath)));
  });

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    fs?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("is registered with the MCP server", async () => {
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "sync_video_to_audio")).toBe(true);
  });

  it("returns a structured error for a missing asset", async () => {
    const result = await client.callTool({
      name: "sync_video_to_audio",
      arguments: {
        asset_id: MISSING_ARTIFACT_ID,
        book_id: PROJECT,
        anchors: [{ video_seconds: 1, audio_seconds: 1.2 }],
      },
    });
    expect(result.isError).toBe(true);
  });

  it("requires the source video to contain audio", async () => {
    const result = await client.callTool({
      name: "sync_video_to_audio",
      arguments: {
        asset_id: silentAssetId,
        book_id: PROJECT,
        anchors: [{ video_seconds: 1, audio_seconds: 1.2 }],
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("requires an audio stream");
  });

  it.each([
    {
      name: "reversed video anchors",
      anchors: [
        { video_seconds: 0.75, audio_seconds: 0.8 },
        { video_seconds: 0.5, audio_seconds: 0.9 },
      ],
      message: "strictly increasing",
    },
    {
      name: "duplicate video anchors",
      anchors: [
        { video_seconds: 0.5, audio_seconds: 0.6 },
        { video_seconds: 0.5, audio_seconds: 0.7 },
      ],
      message: "strictly increasing",
    },
    {
      name: "reversed audio anchors",
      anchors: [
        { video_seconds: 0.5, audio_seconds: 0.8 },
        { video_seconds: 1, audio_seconds: 0.7 },
      ],
      message: "strictly increasing",
    },
    {
      name: "video anchor beyond the source",
      anchors: [{ video_seconds: 2.5, audio_seconds: 1 }],
      message: "video duration",
    },
    {
      name: "audio anchor beyond the source",
      anchors: [{ video_seconds: 1, audio_seconds: 2.5 }],
      message: "audio duration",
    },
    {
      name: "identity map",
      anchors: [{ video_seconds: 0.5, audio_seconds: 0.5 }],
      message: "no-op",
    },
    {
      name: "rate beyond the supported range",
      anchors: [{ video_seconds: 0.1, audio_seconds: 0.8 }],
      message: "between",
    },
  ])("rejects numeric $name without enqueueing", async ({ anchors, message }) => {
    const jobCountBefore = await fs.jobs.queue.count();
    const result = await client.callTool({
      name: "sync_video_to_audio",
      arguments: {
        asset_id: audioAssetId,
        book_id: PROJECT,
        anchors,
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain(message);
    expect(fs.jobs.queue.count()).toBe(jobCountBefore);
  });

  it.each([
    {
      name: "reversed cue anchors",
      anchors: [
        { video_seconds: 1, audio_cue: "first" },
        { video_seconds: 0.5, audio_cue: "second" },
      ],
      message: "strictly increasing",
    },
    {
      name: "cue anchor beyond the source",
      anchors: [{ video_seconds: 2.5, audio_cue: "outside" }],
      message: "video duration",
    },
    {
      name: "cue too close to the implicit start",
      anchors: [{ video_seconds: 0.01, audio_cue: "start" }],
      message: "one source frame",
    },
    {
      name: "mixed anchors too close together",
      anchors: [
        { video_seconds: 0.5, audio_cue: "first" },
        { video_seconds: 0.51, audio_seconds: 0.75 },
      ],
      message: "one source frame",
    },
    {
      name: "cue too close to the implicit end",
      anchors: [{ video_seconds: 1.99, audio_cue: "end" }],
      message: "one source frame",
    },
  ])("rejects $name without enqueueing", async ({ anchors, message }) => {
    const jobCountBefore = await fs.jobs.queue.count();
    const result = await client.callTool({
      name: "sync_video_to_audio",
      arguments: {
        asset_id: audioAssetId,
        book_id: PROJECT,
        anchors,
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain(message);
    expect(fs.jobs.queue.count()).toBe(jobCountBefore);
  });

  it("enqueues a valid numeric anchor request", async () => {
    const result = await client.callTool({
      name: "sync_video_to_audio",
      arguments: {
        asset_id: audioAssetId,
        book_id: PROJECT,
        anchors: [{ video_seconds: 0.5, audio_seconds: 0.6 }],
      },
    });
    expect(result.isError).toBeFalsy();
    const response = JSON.parse((result.content as TextContent)[0].text) as Record<string, unknown>;
    expect(response.asset_id).toBe(audioAssetId);
    expect(response.job_id).toMatch(/^sync-audio-/);
    expect(response.status).toBe("enqueued");
    await expect(waitForJob(String(response.job_id), testBudget(120_000))).resolves.toBeUndefined();
  }, testBudget(120_000));

  it("enforces exactly one audio target per anchor", async () => {
    const result = await client.callTool({
      name: "sync_video_to_audio",
      arguments: {
        asset_id: silentAssetId,
        book_id: PROJECT,
        anchors: [{ video_seconds: 1, audio_seconds: 1.2, audio_cue: "hello" }],
      },
    });
    expect(result.isError).toBe(true);
  });
});
