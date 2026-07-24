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
import type { Engine } from "videobook-engine";
import { createEngineForTest } from "../fs.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

const hasKieKey = !!process.env.KIE_API_KEY;
const hasOpenAiKey = !!process.env.OPENAI_API_KEY;
const hasKimiKey = !!process.env.KIMI_CODING_API_KEY;

type TextContent = Array<{ type: string; text: string }>;
type ManifestFile = { name: string; size_bytes: number };

const PROJECT = "e2e-tools";
const TARGET_PROJECT = "e2e-export-target";

function parse(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as TextContent)[0].text);
}

function parseText(result: { content: unknown }): string {
  return (result.content as TextContent)[0].text;
}

function value<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
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

describe("MCP tools e2e", () => {
  let client: Client;
  let tempDir: string;
  let videoPath: string;
  let fs: Engine;

  // Shared state across sequential tests
  let imgAssetId: string;
  let imgArtifactId: string;
  let scriptAssetId: string;
  let vidAssetId: string;
  let renamedAssetId: string;
  let dupAssetId: string;
  let exportedAssetId: string;
  let dupPreDeleteHash: string;
  let dupArtifactId: string;

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videocity-e2e-tools-"));
    videoPath = join(tempDir, "test-source.mp4");
    await generateTestVideo(videoPath);
    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
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
      arguments: { book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const project = value(fs.projects.get(PROJECT));
    expect(project.slug).toBe(PROJECT);
    expect(project.isDefault).toBe(true);
  });

  it("creates a second project", async () => {
    const result = await client.callTool({
      name: "create_project",
      arguments: { book_id: TARGET_PROJECT },
    });
    expect(result.isError).toBeFalsy();
    expect(value(fs.projects.get(TARGET_PROJECT)).slug).toBe(
      TARGET_PROJECT,
    );
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
      arguments: { book_id: PROJECT, filename: "hero-shot.png", data },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    imgAssetId = parsed.assetId as string;
    expect(imgAssetId).toMatch(/^img-/);
    const artifact = value(fs.artifacts.get(PROJECT));
    imgArtifactId = artifact.artifactId;
    expect(
      value(
        await fs.files.read(imgArtifactId, "original.png"),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("uploads a markdown script", async () => {
    const data = Buffer.from("# Episode Notes\n\nSome content here.").toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: { book_id: PROJECT, filename: "episode-notes.md", data },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    scriptAssetId = parsed.assetId as string;
    expect(scriptAssetId).toMatch(/^script-/);
    expect(
      value(
        await fs.files.read(scriptAssetId, "original.md"),
      ).toString(),
    ).toBe("# Episode Notes\n\nSome content here.");
  });

  it("uploads a video", async () => {
    const data = (await readFile(videoPath)).toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: { book_id: PROJECT, filename: "original.mp4", data },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    vidAssetId = parsed.assetId as string;
    expect(vidAssetId).toMatch(/^vid-/);
    expect(
      value(
        await fs.files.read(vidAssetId, "original.mp4"),
      ).length,
    ).toBeGreaterThan(0);
  });

  // ── Section 3: Asset manifest ──────────────────────────────────

  it("reads image manifest", async () => {
    const result = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: imgAssetId, book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    const fileNames = (data.files as ManifestFile[]).map((f) => f.name);
    expect(fileNames).toContain("original.png");
  });

  it("reads script manifest", async () => {
    const result = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: scriptAssetId, book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    const fileNames = (data.files as ManifestFile[]).map((f) => f.name);
    expect(fileNames).toContain("original.md");
  });

  // ── Section 4: Asset CRUD ──────────────────────────────────────

  it("renames an asset", async () => {
    const result = await client.callTool({
      name: "rename_asset",
      arguments: { asset_id: imgAssetId, new_name: "sunset beach", book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.old_asset_id).toBe(imgAssetId);
    renamedAssetId = parsed.new_asset_id as string;
    expect(renamedAssetId).toMatch(/^img-sunset-beach/);
    expect(fs.artifacts.resolveSlug(PROJECT).ok).toBe(false);
    const renamed = value(
      fs.artifacts.get(PROJECT),
    );
    expect(renamed.slug).toBe(renamedAssetId);
    expect(
      value(
        await fs.files.read(imgArtifactId, "original.png"
        ),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("reads renamed asset manifest", async () => {
    const result = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: renamedAssetId, book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    const fileNames = (data.files as ManifestFile[]).map((f) => f.name);
    expect(fileNames).toContain("original.png");
  });

  it("duplicates an asset", async () => {
    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: { asset_id: renamedAssetId, book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.source_asset_id).toBe(renamedAssetId);
    dupAssetId = parsed.new_asset_id as string;
    expect(dupAssetId).toMatch(/^img-/);
    expect(
      value(
        await fs.files.read(dupAssetId, "original.png"),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("verifies duplicate files", async () => {
    const result = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: dupAssetId, book_id: PROJECT },
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
        book_id: PROJECT,
        target_project: TARGET_PROJECT,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.source_asset_id).toBe(renamedAssetId);
    expect(parsed.target_project).toBe(TARGET_PROJECT);
    exportedAssetId = parsed.new_asset_id as string;
    expect(
      value(
        await fs.files.read(exportedAssetId, "original.png"
        ),
      ).length,
    ).toBeGreaterThan(0);

    // Verify manifest in target project
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: exportedAssetId, book_id: TARGET_PROJECT },
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
      arguments: { book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const commits = parse(result) as unknown as Array<{ hash: string }>;
    expect(commits.length).toBeGreaterThanOrEqual(2);
  });

  it("gets asset history", async () => {
    const result = await client.callTool({
      name: "asset_history",
      arguments: { asset_id: renamedAssetId, book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const commits = parse(result) as unknown as Array<{ hash: string }>;
    expect(commits.length).toBeGreaterThanOrEqual(1);
  });

  it("deletes an asset", async () => {
    // First, get a commit hash where the dup exists (for restore later)
    const historyResult = await client.callTool({
      name: "asset_history",
      arguments: { asset_id: dupAssetId, book_id: PROJECT },
    });
    const commits = parse(historyResult) as unknown as Array<{ hash: string }>;
    dupPreDeleteHash = commits[0].hash;
    dupArtifactId = value(
      fs.artifacts.get(PROJECT),
    ).artifactId;

    const result = await client.callTool({
      name: "delete_asset",
      arguments: { asset_id: dupAssetId, book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("deleted");
    expect(fs.artifacts.get(PROJECT).ok).toBe(false);

    // Verify manifest returns error
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: dupAssetId, book_id: PROJECT },
    });
    expect(manifest.isError).toBe(true);
  });

  it("restores deleted asset", async () => {
    const result = await client.callTool({
      name: "restore_asset_version",
      arguments: {
        asset_id: dupArtifactId,
        commit_hash: dupPreDeleteHash,
        book_id: PROJECT,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("restored");
    expect(parsed.asset_id).toBe(dupArtifactId);
    const restored = value(
      fs.artifacts.get(PROJECT),
    );
    expect(restored.slug).toBe(dupAssetId);
    expect(
      value(
        await fs.files.read(dupArtifactId, "original.png"
        ),
      ).length,
    ).toBeGreaterThan(0);

    // Verify manifest succeeds again
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: dupAssetId, book_id: PROJECT },
    });
    expect(manifest.isError).toBeFalsy();
  });

  it("rewinds project", async () => {
    // Get earliest commit for the target project
    const historyResult = await client.callTool({
      name: "project_history",
      arguments: { book_id: TARGET_PROJECT },
    });
    const commits = parse(historyResult) as unknown as Array<{ hash: string }>;
    const earliestCommit = commits[commits.length - 1].hash;

    const result = await client.callTool({
      name: "rewind_project",
      arguments: { commit_hash: earliestCommit, book_id: TARGET_PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("rewound");
    expect(
      fs.artifacts.get(TARGET_PROJECT).ok,
    ).toBe(false);

    // Verify exported asset is gone
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: exportedAssetId, book_id: TARGET_PROJECT },
    });
    expect(manifest.isError).toBe(true);
  });

  // ── Section 6: Default project ─────────────────────────────────

  it("gets default project", async () => {
    const result = await client.callTool({
      name: "ensure_default_project",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.slug).toBe(PROJECT);
    expect(value(fs.projects.get()).slug).toBe(PROJECT);
  });

  // ── Section 7: Timeline ────────────────────────────────────────

  it("gets empty timeline", async () => {
    const result = await client.callTool({
      name: "get_timeline",
      arguments: { book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const timeline = parse(result) as { slots: unknown[]; render: string };
    expect(timeline.slots).toEqual([]);
    expect(timeline.render).toBe("landscape");
  });

  it("sets timeline slots", async () => {
    const slots = [
      { slug: "vid-intro", volume: 80, audioFadeIn: 100 },
      { slug: "vid-outro", volume: 100, audioFadeOut: 200 },
    ];
    const result = await client.callTool({
      name: "set_timeline",
      arguments: { book_id: PROJECT, slots },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.path).toBeTruthy();
    const timeline = value(
      await fs.metadata.book.read<{
        slots: Array<Record<string, unknown>>;
        render: string;
      }>("timeline"),
    );
    expect(timeline.slots).toHaveLength(2);
    expect(timeline.slots[0].slug).toBe("vid-intro");
    expect(timeline.slots[1].slug).toBe("vid-outro");
  });

  it("reads back timeline", async () => {
    const result = await client.callTool({
      name: "get_timeline",
      arguments: { book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const timeline = parse(result) as { slots: Array<{
      slug: string;
      volume?: number;
      audioFadeIn?: number;
      audioFadeOut?: number;
    }>; render: string };
    expect(timeline.slots).toHaveLength(2);
    expect(timeline.slots[0].slug).toBe("vid-intro");
    expect(timeline.slots[0].volume).toBe(80);
    expect(timeline.slots[0].audioFadeIn).toBe(100);
    expect(timeline.slots[1].slug).toBe("vid-outro");
    expect(timeline.slots[1].volume).toBe(100);
    expect(timeline.slots[1].audioFadeOut).toBe(200);
  });

  // ── Section 8: Sync ────────────────────────────────────────────

  it("sync completes without error", async () => {
    const result = await client.callTool({
      name: "reconcile_project_work",
      arguments: { book_id: PROJECT },
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
    const meta = value(
      await fs.metadata.artifacts.read<Record<string, unknown>>(vidAssetId, "original"
      ),
    );
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
    expect(meta.duration).toBeGreaterThan(0);
  });

  it("sleep returns ready for processed asset", async () => {
    const result = await client.callTool({
      name: "wait_for_asset_ready",
      arguments: {
        asset_id: vidAssetId,
        book_id: PROJECT,
        timeout_seconds: 10,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("ready");
    expect(parsed.asset_id).toBe(vidAssetId);
  });

  it("trims video", async () => {
    const result = await client.callTool({
      name: "trim_video",
      arguments: {
        asset_id: vidAssetId,
        book_id: PROJECT,
        trim_start: 0.5,
        trim_end: 2.0,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("completed");
    expect(
      value(
        await fs.files.read(vidAssetId, "original.mp4"),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("changes video speed", async () => {
    const result = await client.callTool({
      name: "change_video_speed",
      arguments: {
        asset_id: vidAssetId,
        book_id: PROJECT,
        speed: 2.0,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id as string);
    expect(
      value(
        await fs.files.read(vidAssetId, "original.mp4"),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("reverses video", async () => {
    const result = await client.callTool({
      name: "reverse_video",
      arguments: {
        asset_id: vidAssetId,
        book_id: PROJECT,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id as string);
    expect(
      value(
        await fs.files.read(vidAssetId, "original.mp4"),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("extracts first frame", async () => {
    const result = await client.callTool({
      name: "extract_first_frame",
      arguments: {
        asset_id: vidAssetId,
        book_id: PROJECT,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.image_asset_id).toMatch(/^img-/);
    expect(parsed.source_video).toBe(vidAssetId);
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id as string);

    // Verify the image file exists
    const firstFrameId = parsed.image_asset_id as string;
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: firstFrameId, book_id: PROJECT },
    });
    expect(manifest.isError).toBeFalsy();
    const manifestData = parse(manifest);
    const fileNames = (manifestData.files as ManifestFile[]).map((f) => f.name);
    expect(fileNames).toContain("original.jpg");
    expect(
      value(
        await fs.files.read(firstFrameId, "original.jpg"
        ),
      ).length,
    ).toBeGreaterThan(0);
    const firstFrameMeta = value(
      await fs.metadata.artifacts.read<Record<string, unknown>>(firstFrameId, "original"
      ),
    );
    expect(firstFrameMeta.origin).toBe("first_frame");
  });

  it("extracts last frame", async () => {
    const result = await client.callTool({
      name: "extract_last_frame",
      arguments: {
        asset_id: vidAssetId,
        book_id: PROJECT,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.image_asset_id).toMatch(/^img-/);
    expect(parsed.source_video).toBe(vidAssetId);
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id as string);

    const lastFrameId = parsed.image_asset_id as string;
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: lastFrameId, book_id: PROJECT },
    });
    expect(manifest.isError).toBeFalsy();
    const manifestData = parse(manifest);
    const fileNames = (manifestData.files as ManifestFile[]).map((f) => f.name);
    expect(fileNames).toContain("original.jpg");
    expect(
      value(
        await fs.files.read(lastFrameId, "original.jpg"
        ),
      ).length,
    ).toBeGreaterThan(0);
    const lastFrameMeta = value(
      await fs.metadata.artifacts.read<Record<string, unknown>>(lastFrameId, "original"
      ),
    );
    expect(lastFrameMeta.origin).toBe("last_frame");
  });

  it("extracts audio", async () => {
    const result = await client.callTool({
      name: "extract_audio",
      arguments: {
        asset_id: vidAssetId,
        book_id: PROJECT,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.audio_asset_id).toMatch(/^aud-/);
    expect(parsed.source_video).toBe(vidAssetId);
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id as string);

    // Verify the audio file exists
    const audioId = parsed.audio_asset_id as string;
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: audioId, book_id: PROJECT },
    });
    expect(manifest.isError).toBeFalsy();
    const manifestData = parse(manifest);
    const fileNames = (manifestData.files as ManifestFile[]).map((f) => f.name);
    expect(fileNames).toContain("original.mp3");
    expect(
      value(
        await fs.files.read(audioId, "original.mp3"),
      ).length,
    ).toBeGreaterThan(0);
    const audioMeta = value(
      await fs.metadata.artifacts.read<Record<string, unknown>>(audioId, "original"
      ),
    );
    expect(audioMeta.origin).toBe("extract_audio");
  });

  // ── Section 10: Render video (enqueue only) ────────────────────

  it("enqueues render for landscape without subtitles", async () => {
    const result = await client.callTool({
      name: "render_video",
      arguments: {
        asset_id: vidAssetId,
        book_id: PROJECT,
        subtitles_enabled: false,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.asset_id).toBe(vidAssetId);
    expect(parsed.orientations).toEqual(["landscape", "portrait", "square"]);
    // Don't waitForJob — Remotion rendering not available in test env
  });

  // ── Section 11: Render timeline (error — no rendered files) ────

  it("render_timeline errors when slots lack rendered files", async () => {
    const result = await client.callTool({
      name: "render_timeline",
      arguments: { book_id: PROJECT },
    });
    expect(result.isError).toBe(true);
    // Timeline slots reference vid-intro which doesn't exist as an asset
    expect(parseText(result)).toContain("vid-intro");
  });

  // ── Section 12: Download video (validation) ────────────────────

  it("download_video rejects start >= end", async () => {
    const result = await client.callTool({
      name: "download_video",
      arguments: {
        url: "https://example.com/video.mp4",
        start_time: "60",
        end_time: "30",
        book_id: PROJECT,
      },
    });
    expect(result.isError).toBe(true);
    expect(parseText(result)).toContain("start_time must be less than end_time");
  });

  // ── Section 13: API status ─────────────────────────────────────

  it("api_status returns error without KIMI_CODING_API_KEY", async () => {
    if (hasKimiKey) return; // skip check when key is set
    const result = await client.callTool({
      name: "check_kimi_coding_api",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(parseText(result)).toContain("KIMI_CODING_API_KEY");
  });

  // ── Section 14: Transcribe (requires ELEVENLABS_API_KEY) ─────────

  it("transcribe returns error without ELEVENLABS_API_KEY", async () => {
    const result = await client.callTool({
      name: "transcribe",
      arguments: {
        asset_id: vidAssetId,
        book_id: PROJECT,
      },
    });
    expect(result.isError).toBe(true);
    expect(parseText(result)).toContain("ELEVENLABS_API_KEY");
  });

  // ── Section 15: Generation tools (require KIE_API_KEY) ─────────

  it("generate_nano_banana_image returns error without KIE_API_KEY", async () => {
    if (hasKieKey) return;
    const result = await client.callTool({
      name: "generate_kie_nano_banana_pro_text_to_image",
      arguments: {
        prompt: "a sunset over the ocean",
        book_id: PROJECT,
      },
    });
    expect(result.isError).toBe(true);
    expect(parseText(result)).toContain("KIE_API_KEY");
  });

  it("generate_grok_imagine_video returns error without KIE_API_KEY", async () => {
    if (hasKieKey) return;
    const result = await client.callTool({
      name: "generate_kie_grok_imagine_image_to_video",
      arguments: {
        asset_id: renamedAssetId,
        book_id: PROJECT,
      },
    });
    expect(result.isError).toBe(true);
    expect(parseText(result)).toContain("KIE_API_KEY");
  });

  it("generate_grok_imagine_image returns error without KIE_API_KEY", async () => {
    if (hasKieKey) return;
    const result = await client.callTool({
      name: "generate_kie_grok_imagine_image_to_image",
      arguments: {
        asset_id: renamedAssetId,
        book_id: PROJECT,
      },
    });
    expect(result.isError).toBe(true);
    expect(parseText(result)).toContain("KIE_API_KEY");
  });

  it("generate_gpt_image returns error without KIE_API_KEY", async () => {
    if (hasKieKey) return;
    const result = await client.callTool({
      name: "generate_kie_gpt_image_2_image_to_image",
      arguments: {
        prompt: "a sunset",
        book_id: PROJECT,
        image_slugs: [`@${renamedAssetId}`],
      },
    });
    expect(result.isError).toBe(true);
    expect(parseText(result)).toContain("KIE_API_KEY");
  });

  // ── Section 16: Preview tools (require OPENAI_API_KEY) ─────────

  it("preview_video returns error without OPENAI_API_KEY", async () => {
    if (hasOpenAiKey) return;
    const result = await client.callTool({
      name: "prepare_video_generation",
      arguments: {
        prompt: "generate a sunset video",
        book_id: PROJECT,
      },
    });
    expect(result.isError).toBe(true);
    expect(parseText(result)).toContain("OPENAI_API_KEY");
  });

  it("preview_image returns model options without OPENAI_API_KEY", async () => {
    const result = await client.callTool({
      name: "prepare_image_generation",
      arguments: {
        prompt: "generate a sunset image",
        book_id: PROJECT,
      },
    });
    expect(result.isError).toBeFalsy();
    expect(parse(result).category).toBe("image");
  });

  it("chat returns error without KIE_API_KEY", async () => {
    if (hasKieKey) return;
    const result = await client.callTool({
      name: "chat",
      arguments: {
        prompt: "trim the first 2 seconds",
        book_id: PROJECT,
      },
    });
    expect(result.isError).toBe(true);
    expect(parseText(result)).toContain("KIE_API_KEY");
  });
});
