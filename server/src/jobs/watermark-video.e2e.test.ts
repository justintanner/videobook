import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

const PROJECT = "e2e-watermark-video";

type TextContent = Array<{ type: string; text: string }>;
function parse(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as TextContent)[0].text);
}
async function fileExists(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isFile(), () => false);
}
async function countCommits(dir: string, pattern: RegExp): Promise<number> {
  const { stdout } = await execFileAsync("git", ["-C", dir, "log", "--format=%s", "-200"]);
  return stdout.split("\n").filter((line) => pattern.test(line)).length;
}
async function generateTestVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    outputPath,
  ]);
}
async function pollForFile(p: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fileExists(p)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${p} not found after ${timeoutMs}ms`);
}

describe("watermark_video tool end-to-end: async force re-process must not job-error", () => {
  let client: Client;
  let tempDir: string;
  let assetId: string;
  let projectDir: string;
  let assetDir: string;

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videocity-verify-wm-"));
    projectDir = join(tempDir, PROJECT);
    const videoPath = join(tempDir, "src.mp4");
    await generateTestVideo(videoPath);
    client = await createTestClient(tempDir);

    await client.callTool({ name: "create_project", arguments: { project_slug: PROJECT } });
    const data = (await readFile(videoPath)).toString("base64");
    const uploaded = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: PROJECT, filename: "original.mp4", data },
    });
    assetId = (parse(uploaded) as unknown as { assetId: string }).assetId;
    assetDir = join(projectDir, assetId);
    // First process_video (via upload) commits original.mp3.
    await pollForFile(join(assetDir, "original.mp3"), 60_000);
  });

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("watermarks, then the async force re-process completes with NO job-error", async () => {
    // The initial upload already produced a process_video commit; count both
    // markers BEFORE so the poll waits for the watermark's *new* async job, not
    // the stale upload commit.
    const procBefore = await countCommits(projectDir, /\] process_video$/);
    const errBefore = await countCommits(projectDir, /job-error/);

    const result = await client.callTool({
      name: "watermark_video",
      arguments: { project_slug: PROJECT, asset_id: assetId, handle: "justinwtanner" },
    });
    expect(result.isError).toBeFalsy();
    expect(parse(result as { content: unknown }).status).toBe("completed");

    // watermark_video enqueues process_video (force) fire-and-forget. Wait for a
    // NEW terminal commit from that async job (success or job-error).
    const start = Date.now();
    let procAfter = procBefore;
    let errAfter = errBefore;
    while (Date.now() - start < 90_000) {
      procAfter = await countCommits(projectDir, /\] process_video$/);
      errAfter = await countCommits(projectDir, /job-error/);
      if (procAfter > procBefore || errAfter > errBefore) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // Pre-fix: the force re-process threw "Failed to commit file write:" on the
    // byte-identical original.mp3, surfacing as a NEW job-error commit.
    expect(errAfter).toBe(errBefore);
    expect(procAfter).toBeGreaterThan(procBefore);

    // The audio the regression hinges on is stream-copied: the re-extracted mp3
    // is byte-identical to the upload's, yet the watermark must still succeed.
    expect(await fileExists(join(assetDir, "original.mp4"))).toBe(true);
    expect(await fileExists(join(assetDir, "original.mp3"))).toBe(true);
  });
});
