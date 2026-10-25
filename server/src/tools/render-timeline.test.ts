import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";
import { testBudget } from "../test-budget.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

type TextContent = Array<{ type: string; text: string }>;

async function generateTestVideo(outputPath: string, width = 1920, height = 1080): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", `testsrc=duration=1:size=${width}x${height}:rate=10`,
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
    "-c:a", "aac", "-shortest",
    outputPath,
  ]);
}

async function uploadVideo(
  client: Client,
  bookId: string,
  videoPath: string,
): Promise<{ artifactId: string; assetId: string; path: string }> {
  const data = (await readFile(videoPath)).toString("base64");
  const result = await client.callTool({
    name: "upload_file",
    arguments: { book_id: bookId, filename: "original.mp4", data },
  });
  return JSON.parse((result.content as TextContent)[0].text);
}

async function setTimeline(
  client: Client,
  bookId: string,
  artifactId: string,
  render: "landscape" | "portrait" | "square",
): Promise<void> {
  const result = await client.callTool({
    name: "set_timeline",
    arguments: {
      book_id: bookId,
      render,
      slots: [{ artifact_id: artifactId }],
    },
  });
  expect(result.isError, (result.content as TextContent)[0]?.text).toBeFalsy();
}

describe("render_timeline tool", () => {
  let client: Client;
  let tempDir: string;
  let videoPath: string;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  }, testBudget(30_000));

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-render-timeline-test-"));
    videoPath = join(tempDir, "test-source.mp4");
    await generateTestVideo(videoPath);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "timeline-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error when timeline has no assets", async () => {
    const result = await client.callTool({
      name: "render_timeline",
      arguments: {
        book_id: "timeline-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("no assigned artifacts");
  });

  it("returns error when the typed timeline has no slots", async () => {
    const result = await client.callTool({
      name: "render_timeline",
      arguments: {
        book_id: "timeline-proj",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("no assigned artifacts");
  });

  it("rejects a typed timeline that references a nonexistent artifact", async () => {
    const result = await client.callTool({
      name: "set_timeline",
      arguments: {
        book_id: "timeline-proj",
        render: "landscape",
        slots: [{ artifact_id: "00000000-0000-0000-0000-000000000000" }],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Artifact not found");
  });

  it("returns missing_renders when slot asset is missing rendered file", async () => {
    // Upload a video to create a real asset (it won't have the rendered mp4)
    const uploaded = await uploadVideo(client, "timeline-proj", videoPath);
    await setTimeline(client, "timeline-proj", uploaded.artifactId, "landscape");

    const result = await client.callTool({
      name: "render_timeline",
      arguments: {
        book_id: "timeline-proj",
      },
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("missing_renders");
    expect(parsed.orientation).toBe("landscape");
    expect(parsed.missing_artifact_ids).toEqual([uploaded.artifactId]);
    expect(parsed.message).toContain(uploaded.artifactId);
  });

  it("uses explicit orientation arg over timeline fields", async () => {
    const uploaded = await uploadVideo(client, "timeline-proj", videoPath);
    const fs = createEngineForTest(tempDir);
    expect((await fs.files.writeFromPath(uploaded.artifactId, "portrait.mp4", videoPath
    )).ok).toBe(true);
    await setTimeline(client, "timeline-proj", uploaded.artifactId, "landscape");

    const result = await client.callTool({
      name: "render_timeline",
      arguments: { book_id: "timeline-proj", orientation: "portrait" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.orientation).toBe("portrait");
  });

  it("uses the stored typed timeline orientation when no override is given", async () => {
    const uploaded = await uploadVideo(client, "timeline-proj", videoPath);
    const fs = createEngineForTest(tempDir);
    expect((await fs.files.writeFromPath(uploaded.artifactId, "portrait.mp4", videoPath
    )).ok).toBe(true);
    await setTimeline(client, "timeline-proj", uploaded.artifactId, "portrait");

    const result = await client.callTool({
      name: "render_timeline",
      arguments: { book_id: "timeline-proj" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.orientation).toBe("portrait");
  });

  it("uses the stored square orientation", async () => {
    const uploaded = await uploadVideo(client, "timeline-proj", videoPath);
    const fs = createEngineForTest(tempDir);
    expect((await fs.files.writeFromPath(uploaded.artifactId, "square.mp4", videoPath
    )).ok).toBe(true);
    await setTimeline(client, "timeline-proj", uploaded.artifactId, "square");

    const result = await client.callTool({
      name: "render_timeline",
      arguments: { book_id: "timeline-proj" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.orientation).toBe("square");
  });

  it("enqueues job when rendered files exist", async () => {
    // Upload a video to create a real asset
    const uploaded = await uploadVideo(client, "timeline-proj", videoPath);

    const fs = createEngineForTest(tempDir);
    expect((await fs.files.writeFromPath(uploaded.artifactId, "landscape.mp4", videoPath
    )).ok).toBe(true);
    await setTimeline(client, "timeline-proj", uploaded.artifactId, "landscape");

    const result = await client.callTool({
      name: "render_timeline",
      arguments: {
        book_id: "timeline-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.job_id).toMatch(/^render-timeline-/);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.slot_count).toBe(1);
    expect(parsed.orientation).toBe("landscape");
  });
});
