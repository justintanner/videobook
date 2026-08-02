import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { queue, getEngineRoot } from "../queue.js";
import { createEngineForTest } from "../fs.js";
import type { Client } from "@modelcontextprotocol/client";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

const PROJECT = "e2e-process-video-reprocess";

type TextContent = Array<{ type: string; text: string }>;

function parse(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as TextContent)[0].text);
}

async function fileExists(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isFile(), () => false);
}

async function generateTestVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    outputPath,
  ]);
}

async function generateAudioOnlyMp4(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:a", "aac",
    outputPath,
  ]);
}

async function pollForFile(filePath: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fileExists(filePath)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${filePath} not found after ${timeoutMs}ms`);
}

// Regression for a force re-process failure (originally surfaced by the watermark
// flow): a job stream-copies the audio then enqueues process_video with
// force=true. force deletes
// original.jpg + frames (dirtying the tree), and the deterministic mp3 extraction
// reproduces bytes identical to the already-committed original.mp3. The engine
// commits each write scoped to its path, but its "anything to commit?" pre-check
// is unscoped — so a scoped `git commit -- original.mp3` of an unchanged file in
// an otherwise-dirty tree exits non-zero with the message on stdout and empty
// stderr, which surfaced as a bare "Failed to commit file write:". A force
// re-process must instead treat the no-op write as a success.
describe("process_video force re-process tolerates byte-identical original.mp3", () => {
  let client: Client;
  let tempDir: string;
  let assetId: string;
  let assetDir: string;

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videocity-e2e-pv-reproc-"));
    const videoPath = join(tempDir, "test-source.mp4");
    await generateTestVideo(videoPath);
    client = await createTestClient(tempDir);

    const createResult = await client.callTool({
      name: "create_project",
      arguments: { book_id: PROJECT },
    });
    expect(createResult.isError).toBeFalsy();

    const data = (await readFile(videoPath)).toString("base64");
    const uploaded = await client.callTool({
      name: "upload_file",
      arguments: { book_id: PROJECT, filename: "original.mp4", data },
    });
    const parsed = parse(uploaded) as unknown as {
      assetId: string;
      path: string;
    };
    assetId = parsed.assetId;
    assetDir = parsed.path;

    // First process_video (via upload) writes + commits original.mp3.
    await pollForFile(join(assetDir, "original.mp3"), 60_000);
  });

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("succeeds when force re-extraction yields an unchanged original.mp3", async () => {
    const before = await readFile(join(assetDir, "original.mp3"));

    const jobId = `process-video-reprocess-${assetId}`;
    const result = await queue.enqueueAndWait<{ success: boolean }>(jobId, {
      type: "process_video",
      videoPath: join(assetDir, "original.mp4"),
      assetId,
      assetDir,
      bookId: PROJECT,
      provenance: { origin: "test-reprocess" },
      force: true,
      skipDownstreamJobs: true,
    } as unknown as Parameters<typeof queue.enqueueAndWait>[1]);

    expect(result.success).toBe(true);

    // The mp3 the watermark path reproduces is byte-identical — the point of the
    // regression — and it must remain present after the no-op write is skipped.
    const after = await readFile(join(assetDir, "original.mp3"));
    expect(after.equals(before)).toBe(true);

    const fs = createEngineForTest(getEngineRoot());
    const read = await fs.files.read(assetId, "original.mp3");
    expect(read.ok).toBe(true);
  });

  it("rejects an MP4 without a video stream", async () => {
    const audioOnlyPath = join(tempDir, "audio-only.mp4");
    await generateAudioOnlyMp4(audioOnlyPath);

    const fs = createEngineForTest(getEngineRoot());
    const created = await fs.artifacts.create("vid", "audio-only");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const written = await fs.files.write(created.value.slug, "original.mp4", await readFile(audioOnlyPath)
    );
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    await expect(queue.enqueueAndWait(
      `process-video-audio-only-${created.value.slug}`,
      {
        type: "process_video",
        videoPath: join(created.value.path, "original.mp4"),
        assetId: created.value.slug,
        assetDir: created.value.path,
        bookId: PROJECT,
        provenance: { origin: "test-audio-only" },
        skipDownstreamJobs: true,
      } as unknown as Parameters<typeof queue.enqueueAndWait>[1],
    )).rejects.toThrow(`process_video requires a video stream: ${created.value.slug}`);
  });
});
