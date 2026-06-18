import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { queue, getProjectsDir } from "../queue.js";
import { createFsForTest } from "../fs.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

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

async function pollForFile(filePath: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fileExists(filePath)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${filePath} not found after ${timeoutMs}ms`);
}

// Regression for the watermark re-process failure: watermark_video stream-copies
// the audio then enqueues process_video with force=true. force deletes
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
      arguments: { project_slug: PROJECT },
    });
    expect(createResult.isError).toBeFalsy();

    const data = (await readFile(videoPath)).toString("base64");
    const uploaded = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: PROJECT, filename: "original.mp4", data },
    });
    const parsed = parse(uploaded) as unknown as { assetId: string };
    assetId = parsed.assetId;
    assetDir = join(tempDir, PROJECT, assetId);

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
      projectSlug: PROJECT,
      provenance: { origin: "test-reprocess" },
      force: true,
      skipDownstreamJobs: true,
    } as unknown as Parameters<typeof queue.enqueueAndWait>[1]);

    expect(result.success).toBe(true);

    // The mp3 the watermark path reproduces is byte-identical — the point of the
    // regression — and it must remain present after the no-op write is skipped.
    const after = await readFile(join(assetDir, "original.mp3"));
    expect(after.equals(before)).toBe(true);

    const fs = createFsForTest(getProjectsDir());
    const read = await fs.readFile(assetId, "original.mp3", PROJECT);
    expect(read.ok).toBe(true);
  });
});
