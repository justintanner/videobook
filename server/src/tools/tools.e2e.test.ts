import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { queue, waitForJob } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

// change_video_speed and reverse_video use ffmpeggy for probing;
// its CJS build is broken in some environments (ESM syntax in cjs/).
let hasFFmpeggy = false;
try { require("ffmpeggy"); hasFFmpeggy = true; } catch { /* skip */ }

type TextContent = Array<{ type: string; text: string }>;
type ManifestFile = { name: string; size_bytes: number };

const PROJECT = "e2e-tools";
const TARGET_PROJECT = "e2e-export-target";

function parse(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as TextContent)[0].text);
}

async function generateTestVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    outputPath,
  ]);
}

async function pollManifestForFile(
  client: Client,
  projectSlug: string,
  assetId: string,
  fileName: string,
  timeoutMs = 30_000,
): Promise<ManifestFile> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: assetId, project_slug: projectSlug },
    });
    if (!result.isError) {
      const data = parse(result);
      const file = (data.files as ManifestFile[]).find((f) => f.name === fileName);
      if (file) return file;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${fileName} not found in ${assetId} after ${timeoutMs}ms`);
}

describe("non-generation MCP tools e2e", () => {
  let client: Client;
  let tempDir: string;
  let videoPath: string;

  // Shared state across sequential tests
  let imgAssetId: string;
  let scriptAssetId: string;
  let vidAssetId: string;
  let renamedAssetId: string;
  let dupAssetId: string;
  let exportedAssetId: string;
  let dupPreDeleteHash: string;

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-e2e-tools-"));
    videoPath = join(tempDir, "test-source.mp4");
    await generateTestVideo(videoPath);
    client = await createTestClient(tempDir);
  });

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  // ── Section 1: Project management ──────────────────────────────

  it("creates a project", async () => {
    const result = await client.callTool({
      name: "create_project",
      arguments: { project_slug: PROJECT },
    });
    expect(result.isError).toBeFalsy();
  });

  it("creates a second project", async () => {
    const result = await client.callTool({
      name: "create_project",
      arguments: { project_slug: TARGET_PROJECT },
    });
    expect(result.isError).toBeFalsy();
  });

  it("lists projects", async () => {
    const result = await client.callTool({
      name: "list_projects",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const projects = parse(result) as unknown as Array<{ slug: string }>;
    const slugs = projects.map((p) => p.slug);
    expect(slugs).toContain(PROJECT);
    expect(slugs).toContain(TARGET_PROJECT);
  });

  // ── Section 2: File upload ─────────────────────────────────────

  it("uploads an image", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: PROJECT, filename: "hero-shot.png", data },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    imgAssetId = parsed.assetId as string;
    expect(imgAssetId).toMatch(/^img-/);
  });

  it("uploads a markdown script", async () => {
    const data = Buffer.from("# Episode Notes\n\nSome content here.").toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: PROJECT, filename: "episode-notes.md", data },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    scriptAssetId = parsed.assetId as string;
    expect(scriptAssetId).toMatch(/^script-/);
  });

  it("uploads a video", async () => {
    const data = (await readFile(videoPath)).toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: PROJECT, filename: "original.mp4", data },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    vidAssetId = parsed.assetId as string;
    expect(vidAssetId).toMatch(/^vid-/);
  });

  // ── Section 3: Asset manifest ──────────────────────────────────

  it("reads image manifest", async () => {
    const result = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: imgAssetId, project_slug: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    const fileNames = (data.files as ManifestFile[]).map((f) => f.name);
    expect(fileNames).toContain("original.png");
    expect(fileNames).toContain(".original.json");
  });

  it("reads script manifest", async () => {
    const result = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: scriptAssetId, project_slug: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    const fileNames = (data.files as ManifestFile[]).map((f) => f.name);
    expect(fileNames).toContain("episode-notes.md");
  });

  // ── Section 4: Asset CRUD ──────────────────────────────────────

  it("renames an asset", async () => {
    const result = await client.callTool({
      name: "rename_asset",
      arguments: { asset_id: imgAssetId, new_name: "sunset beach", project_slug: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.old_asset_id).toBe(imgAssetId);
    renamedAssetId = parsed.new_asset_id as string;
    expect(renamedAssetId).toMatch(/^img-sunset-beach/);
  });

  it("reads renamed asset manifest", async () => {
    const result = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: renamedAssetId, project_slug: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    const fileNames = (data.files as ManifestFile[]).map((f) => f.name);
    expect(fileNames).toContain("original.png");
  });

  it("duplicates an asset", async () => {
    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: { asset_id: renamedAssetId, project_slug: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.source_asset_id).toBe(renamedAssetId);
    dupAssetId = parsed.new_asset_id as string;
    expect(dupAssetId).toMatch(/^img-/);
  });

  it("verifies duplicate files", async () => {
    const result = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: dupAssetId, project_slug: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    const fileNames = (data.files as ManifestFile[]).map((f) => f.name);
    expect(fileNames).toContain("original.png");
  });

  it("exports asset to another project", async () => {
    const result = await client.callTool({
      name: "export_asset_to_project",
      arguments: {
        asset_id: renamedAssetId,
        project_slug: PROJECT,
        target_project: TARGET_PROJECT,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.source_asset_id).toBe(renamedAssetId);
    expect(parsed.target_project).toBe(TARGET_PROJECT);
    exportedAssetId = parsed.new_asset_id as string;

    // Verify manifest in target project
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: exportedAssetId, project_slug: TARGET_PROJECT },
    });
    expect(manifest.isError).toBeFalsy();
    const manifestData = parse(manifest);
    const fileNames = (manifestData.files as ManifestFile[]).map((f) => f.name);
    expect(fileNames).toContain("original.png");
  });

  // ── Section 5: History & versioning ────────────────────────────

  it("gets project history", async () => {
    const result = await client.callTool({
      name: "project_history",
      arguments: { project_slug: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const commits = parse(result) as unknown as Array<{ hash: string }>;
    expect(commits.length).toBeGreaterThanOrEqual(2);
  });

  it("gets asset history", async () => {
    const result = await client.callTool({
      name: "asset_history",
      arguments: { asset_id: renamedAssetId, project_slug: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const commits = parse(result) as unknown as Array<{ hash: string }>;
    expect(commits.length).toBeGreaterThanOrEqual(1);
  });

  it("deletes an asset", async () => {
    // First, get a commit hash where the dup exists (for restore later)
    const historyResult = await client.callTool({
      name: "asset_history",
      arguments: { asset_id: dupAssetId, project_slug: PROJECT },
    });
    const commits = parse(historyResult) as unknown as Array<{ hash: string }>;
    dupPreDeleteHash = commits[0].hash;

    const result = await client.callTool({
      name: "delete_asset",
      arguments: { asset_id: dupAssetId, project_slug: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("deleted");

    // Verify manifest returns error
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: dupAssetId, project_slug: PROJECT },
    });
    expect(manifest.isError).toBe(true);
  });

  it("restores deleted asset", async () => {
    const result = await client.callTool({
      name: "restore_asset_version",
      arguments: {
        asset_id: dupAssetId,
        commit_hash: dupPreDeleteHash,
        project_slug: PROJECT,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("restored");
    expect(parsed.asset_id).toBe(dupAssetId);

    // Verify manifest succeeds again
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: dupAssetId, project_slug: PROJECT },
    });
    expect(manifest.isError).toBeFalsy();
  });

  it("rewinds project", async () => {
    // Get earliest commit for the target project
    const historyResult = await client.callTool({
      name: "project_history",
      arguments: { project_slug: TARGET_PROJECT },
    });
    const commits = parse(historyResult) as unknown as Array<{ hash: string }>;
    const earliestCommit = commits[commits.length - 1].hash;

    const result = await client.callTool({
      name: "rewind_project",
      arguments: { commit_hash: earliestCommit, project_slug: TARGET_PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("rewound");

    // Verify exported asset is gone
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: exportedAssetId, project_slug: TARGET_PROJECT },
    });
    expect(manifest.isError).toBe(true);
  });

  // ── Section 6: Default project ─────────────────────────────────

  it("gets default project", async () => {
    const result = await client.callTool({
      name: "get_default_project",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
  });

  // ── Section 7: Timeline ────────────────────────────────────────

  it("gets empty timeline", async () => {
    const result = await client.callTool({
      name: "get_timeline",
      arguments: { project_slug: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const slots = parse(result) as unknown as unknown[];
    expect(slots).toEqual([]);
  });

  it("sets timeline slots", async () => {
    const slots = [
      { slug: "vid-intro", volume: 80, audioFadeIn: 100 },
      { slug: "vid-outro", volume: 100, audioFadeOut: 200 },
    ];
    const result = await client.callTool({
      name: "edit_timeline",
      arguments: { project_slug: PROJECT, slots },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.path).toBeTruthy();
  });

  it("reads back timeline", async () => {
    const result = await client.callTool({
      name: "get_timeline",
      arguments: { project_slug: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const slots = parse(result) as unknown as Array<{
      slug: string;
      volume?: number;
      audioFadeIn?: number;
      audioFadeOut?: number;
    }>;
    expect(slots).toHaveLength(2);
    expect(slots[0].slug).toBe("vid-intro");
    expect(slots[0].volume).toBe(80);
    expect(slots[0].audioFadeIn).toBe(100);
    expect(slots[1].slug).toBe("vid-outro");
    expect(slots[1].volume).toBe(100);
    expect(slots[1].audioFadeOut).toBe(200);
  });

  // ── Section 8: Sync ────────────────────────────────────────────

  it("sync completes without error", async () => {
    const result = await client.callTool({
      name: "sync",
      arguments: { project_slug: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed).toHaveProperty("pending");
    expect(parsed).toHaveProperty("completed");
    expect(parsed).toHaveProperty("failed");
    expect(parsed).toHaveProperty("external_uploads");
  });

  // ── Section 9: Video processing (requires ffmpeg + queue) ─────

  it("waits for video processing", async () => {
    await pollManifestForFile(client, PROJECT, vidAssetId, ".original.json");
  });

  it("trims video", async () => {
    const result = await client.callTool({
      name: "trim_video",
      arguments: {
        asset_id: vidAssetId,
        project_slug: PROJECT,
        trim_start: 0.5,
        trim_end: 2.0,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id as string);
  });

  it.skipIf(!hasFFmpeggy)("changes video speed", async () => {
    const result = await client.callTool({
      name: "change_video_speed",
      arguments: {
        asset_id: vidAssetId,
        project_slug: PROJECT,
        speed: 2.0,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id as string);
  });

  it.skipIf(!hasFFmpeggy)("reverses video", async () => {
    const result = await client.callTool({
      name: "reverse_video",
      arguments: {
        asset_id: vidAssetId,
        project_slug: PROJECT,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id as string);
  });

  it("extracts first frame", async () => {
    const result = await client.callTool({
      name: "extract_first_frame",
      arguments: {
        asset_id: vidAssetId,
        project_slug: PROJECT,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.image_asset_id).toMatch(/^img-/);
    expect(parsed.source_video).toBe(vidAssetId);
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id as string);

    // Verify the image file exists
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.image_asset_id as string, project_slug: PROJECT },
    });
    expect(manifest.isError).toBeFalsy();
    const manifestData = parse(manifest);
    const fileNames = (manifestData.files as ManifestFile[]).map((f) => f.name);
    expect(fileNames).toContain("original.jpg");
  });

  it("extracts audio", async () => {
    const result = await client.callTool({
      name: "extract_audio",
      arguments: {
        asset_id: vidAssetId,
        project_slug: PROJECT,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.audio_asset_id).toMatch(/^aud-/);
    expect(parsed.source_video).toBe(vidAssetId);
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id as string);

    // Verify the audio file exists
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.audio_asset_id as string, project_slug: PROJECT },
    });
    expect(manifest.isError).toBeFalsy();
    const manifestData = parse(manifest);
    const fileNames = (manifestData.files as ManifestFile[]).map((f) => f.name);
    expect(fileNames).toContain("original.mp3");
  });
});
