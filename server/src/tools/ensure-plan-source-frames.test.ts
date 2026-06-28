import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

type TextContent = Array<{ type: string; text: string }>;

// Video stream is 2.0s (20 frames @ 10fps); audio is 2.5s, so the container
// duration reports 2.5s. A final-scene `end` of 2.5 (what computeChunks derives
// from the format duration) seeks past the last decodable video frame — the
// exact case that left source frames missing. The -sseof path must still land a
// frame.
async function generateAudioLongerThanVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2.5",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    outputPath,
  ]);
}

async function uploadVideo(client: Client, projectSlug: string, videoPath: string): Promise<string> {
  const data = (await readFile(videoPath)).toString("base64");
  const result = await client.callTool({
    name: "upload_file",
    arguments: { project_slug: projectSlug, filename: "original.mp4", data },
  });
  return JSON.parse((result.content as TextContent)[0].text).assetId as string;
}

function planManifestNames(manifest: TextContent): Set<string> {
  const data = JSON.parse(manifest[0].text) as { files: Array<{ name: string }> };
  return new Set(data.files.map((f) => f.name));
}

describe("ensure_plan_source_frames tool", () => {
  let client: Client;
  let tempDir: string;
  const PROJECT = "ensure-frames-proj";
  let sourceAssetId: string;

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videocity-ensure-frames-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({ name: "create_project", arguments: { project_slug: PROJECT } });

    const videoPath = join(tempDir, "skewed.mp4");
    await generateAudioLongerThanVideo(videoPath);
    sourceAssetId = await uploadVideo(client, PROJECT, videoPath);

    // Two scenes: the first ends mid-clip (a plain seek), the second ends at the
    // container duration (overshoots the last frame → must use -sseof).
    const sidecar = {
      formula: "char_swap",
      source_asset_id: sourceAssetId,
      generation_status: "ready",
      scenes: [
        { start: 0, end: 1.0, clip_filename: "s1.mp4", audio_filename: "s1.mp3" },
        { start: 1.0, end: 2.5, clip_filename: "s2.mp4", audio_filename: "s2.mp3" },
      ],
    };

    const fs = createFsForTest(tempDir);
    const project = await fs.getProject(PROJECT);
    if (!project.ok) throw new Error(project.error.message);
    await mkdir(join(project.value.path, "plan"), { recursive: true });
    await fs.writeFile("plan", "index.md", "# test plan\n", PROJECT);
    await fs.writeFile("plan", ".plan.json", JSON.stringify(sidecar), PROJECT);
  });

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("extracts every scene's first and last source frame, including the overshooting final frame", async () => {
    const result = await client.callTool({
      name: "ensure_plan_source_frames",
      arguments: { project_slug: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as TextContent)[0].text).success).toBe(true);

    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: "plan", project_slug: PROJECT },
    });
    const names = planManifestNames(manifest.content as TextContent);
    const expected = [
      "s1-image1-source.jpg",
      "s1-image2-source.jpg",
      "s2-image1-source.jpg",
      "s2-image2-source.jpg",
    ];
    for (const name of expected) {
      expect(names.has(name), `expected ${name} on disk`).toBe(true);
    }

    const manifestData = JSON.parse((manifest.content as TextContent)[0].text) as { path: string };
    for (const name of expected) {
      const fileStat = await stat(join(manifestData.path, name));
      expect(fileStat.size, `${name} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it("is idempotent — a second run leaves the existing frames in place", async () => {
    const before = await stat(join(tempDir, PROJECT, "plan", "s1-image1-source.jpg"));

    const result = await client.callTool({
      name: "ensure_plan_source_frames",
      arguments: { project_slug: PROJECT },
    });
    expect(result.isError).toBeFalsy();

    const after = await stat(join(tempDir, PROJECT, "plan", "s1-image1-source.jpg"));
    // skipExisting means the present frame is never re-extracted, so its bytes
    // (and mtime) are untouched.
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("no-ops cleanly for a project without a plan", async () => {
    await client.callTool({ name: "create_project", arguments: { project_slug: "no-plan-proj" } });
    const result = await client.callTool({
      name: "ensure_plan_source_frames",
      arguments: { project_slug: "no-plan-proj" },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as TextContent)[0].text).success).toBe(true);
  });
});
