import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { queue, waitForJob } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";
import type { ArtifactKind, Engine } from "videobook-engine";
import { isUuidV7 } from "videobook-engine";
import { createEngineForTest } from "../engine.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

const hasKieKey = !!process.env.KIE_API_KEY;
const hasOpenAiKey = !!process.env.OPENAI_API_KEY;
const hasKimiKey = !!process.env.KIMI_CODING_API_KEY;

type TextContent = Array<{ type: string; text: string }>;
type ManifestFile = { name: string; size_bytes: number };

const PROJECT = "e2e-tools";

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
  let bookId: string;

  // Shared state across sequential tests
  let imgAssetId: string;
  let scriptAssetId: string;
  let vidAssetId: string;
  let dupAssetId: string;
  let dupPreDeleteHash: string;

  function assertKind(artifactId: string, kind: ArtifactKind): void {
    const artifact = fs.artifacts.get(artifactId);
    expect(artifact.ok).toBe(true);
    expect(artifact.ok && artifact.value.kind).toBe(kind);
  }

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videocity-e2e-tools-"));
    videoPath = join(tempDir, "test-source.mp4");
    await generateTestVideo(videoPath);
    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
    bookId = fs.book.get().bookId;
  });

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  // ── Section 1: Book management ─────────────────────────────────

  it("creates a project alias for the active book", async () => {
    const result = await client.callTool({
      name: "create_project",
      arguments: { book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const book = await client.callTool({
      name: "get_book",
      arguments: { book_id: PROJECT },
    });
    expect(book.isError).toBeFalsy();
    expect(parse(book).bookId).toBe(bookId);
  });

  it("lists the active book", async () => {
    const result = await client.callTool({ name: "list_books", arguments: {} });
    expect(result.isError).toBeFalsy();
    const books = parse(result) as unknown as Array<{ bookId: string; name: string }>;
    expect(books.every((book) => isUuidV7(book.bookId))).toBe(true);
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
    expect(isUuidV7(imgAssetId)).toBe(true);
    expect(parsed.artifactId).toBe(imgAssetId);
    assertKind(imgAssetId, "image");
    expect(
      value(
        await fs.files.read(imgAssetId, "original.png"),
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
    expect(isUuidV7(scriptAssetId)).toBe(true);
    assertKind(scriptAssetId, "script");
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
    expect(isUuidV7(vidAssetId)).toBe(true);
    assertKind(vidAssetId, "video");
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

  it("relabels an asset without moving its id", async () => {
    const result = await client.callTool({
      name: "rename_asset",
      arguments: { asset_id: imgAssetId, new_name: "sunset beach", book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.artifact_id).toBe(imgAssetId);
    expect(parsed.label).toBe("sunset beach");
    const relabelled = fs.artifacts.get(imgAssetId);
    expect(relabelled.ok && relabelled.value.label).toBe("sunset beach");
    expect(
      value(
        await fs.files.read(imgAssetId, "original.png"),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("reads the relabelled asset manifest under the same id", async () => {
    const result = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: imgAssetId, book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result);
    const fileNames = (data.files as ManifestFile[]).map((f) => f.name);
    expect(fileNames).toContain("original.png");
  });

  it("duplicates an asset", async () => {
    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: { asset_id: imgAssetId, book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.source_asset_id).toBe(imgAssetId);
    dupAssetId = parsed.new_asset_id as string;
    expect(isUuidV7(dupAssetId)).toBe(true);
    expect(dupAssetId).not.toBe(imgAssetId);
    assertKind(dupAssetId, "image");
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

  // ── Section 5: History & versioning ────────────────────────────

  it("records book actions", async () => {
    const result = await client.callTool({
      name: "list_book_actions",
      arguments: { book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const history = parse(result) as unknown as {
      actions: Array<{ operation: string }>;
    };
    expect(history.actions.length).toBeGreaterThanOrEqual(2);
  });

  it("gets asset history", async () => {
    const result = await client.callTool({
      name: "asset_history",
      arguments: { asset_id: imgAssetId, book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const commits = parse(result) as unknown as Array<{ hash: string }>;
    expect(commits.length).toBeGreaterThanOrEqual(1);
  });

  it("deletes an asset", async () => {
    // First, get a revision hash where the dup exists (for restore later)
    const historyResult = await client.callTool({
      name: "asset_history",
      arguments: { asset_id: dupAssetId, book_id: PROJECT },
    });
    const commits = parse(historyResult) as unknown as Array<{ hash: string }>;
    dupPreDeleteHash = commits[0].hash;

    const result = await client.callTool({
      name: "delete_asset",
      arguments: { asset_id: dupAssetId, book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("deleted");
    expect(fs.artifacts.get(dupAssetId).ok).toBe(false);

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
        asset_id: dupAssetId,
        commit_hash: dupPreDeleteHash,
        book_id: PROJECT,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parse(result);
    expect(parsed.status).toBe("restored");
    expect(parsed.asset_id).toBe(dupAssetId);
    const restored = fs.artifacts.get(dupAssetId);
    expect(restored.ok).toBe(true);
    expect(restored.ok && restored.value.artifactId).toBe(dupAssetId);
    expect(
      value(
        await fs.files.read(dupAssetId, "original.png"),
      ).length,
    ).toBeGreaterThan(0);

    // Verify manifest succeeds again
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: dupAssetId, book_id: PROJECT },
    });
    expect(manifest.isError).toBeFalsy();
  });

  // ── Section 6: Timeline ────────────────────────────────────────

  it("gets empty timeline", async () => {
    const result = await client.callTool({
      name: "get_timeline",
      arguments: { book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const timeline = parse(result) as unknown as { slots: unknown[]; render: string };
    expect(timeline.slots).toEqual([]);
    expect(timeline.render).toBe("landscape");
  });

  it("sets timeline slots by artifact id", async () => {
    const result = await client.callTool({
      name: "set_timeline",
      arguments: {
        book_id: PROJECT,
        render: "landscape",
        slots: [{
          artifact_id: vidAssetId,
          volume: 80,
          audioFadeIn: 0.1,
          audioFadeOut: 0.2,
        }],
      },
    });
    expect(result.isError, parseText(result)).toBeFalsy();
    const timeline = parse(result) as unknown as {
      slots: Array<{ id: string; artifact_id: string }>;
    };
    expect(timeline.slots).toHaveLength(1);
    expect(timeline.slots[0].artifact_id).toBe(vidAssetId);
    expect(isUuidV7(timeline.slots[0].id)).toBe(true);
  });

  it("reads back timeline", async () => {
    const result = await client.callTool({
      name: "get_timeline",
      arguments: { book_id: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    const timeline = parse(result) as unknown as {
      slots: Array<{
        artifact_id: string;
        volume?: number;
        audioFadeIn?: number;
        audioFadeOut?: number;
      }>;
      render: string;
    };
    expect(timeline.render).toBe("landscape");
    expect(timeline.slots).toHaveLength(1);
    expect(timeline.slots[0].artifact_id).toBe(vidAssetId);
    expect(timeline.slots[0].volume).toBe(80);
  });

  // ── Section 7: Sync ────────────────────────────────────────────

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

  // ── Section 8: Video processing (requires ffmpeg + queue) ─────

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
    const firstFrameId = parsed.image_asset_id as string;
    expect(isUuidV7(firstFrameId)).toBe(true);
    assertKind(firstFrameId, "image");
    expect(parsed.source_video).toBe(vidAssetId);
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id as string);

    // Verify the image file exists
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
    const lastFrameId = parsed.image_asset_id as string;
    expect(isUuidV7(lastFrameId)).toBe(true);
    assertKind(lastFrameId, "image");
    expect(parsed.source_video).toBe(vidAssetId);
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id as string);

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
    const audioId = parsed.audio_asset_id as string;
    expect(isUuidV7(audioId)).toBe(true);
    assertKind(audioId, "audio");
    expect(parsed.source_video).toBe(vidAssetId);
    expect(parsed.status).toBe("enqueued");
    await waitForJob(parsed.job_id as string);

    // Verify the audio file exists
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

  // ── Section 9: Render video (enqueue only) ─────────────────────

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

  // ── Section 10: Render timeline (error — no rendered files) ────

  it("render_timeline errors when slots lack rendered files", async () => {
    const result = await client.callTool({
      name: "render_timeline",
      arguments: { book_id: PROJECT },
    });
    expect(result.isError).toBe(true);
    // The single slot points at the uploaded video, which has no rendered
    // orientation file yet, so the tool reports it by stable artifact id.
    const parsed = parse(result);
    expect(parsed.status).toBe("missing_renders");
    expect(parsed.missing_artifact_ids).toEqual([vidAssetId]);
  });

  // ── Section 11: Download video (validation) ────────────────────

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

  // ── Section 12: API status ─────────────────────────────────────

  it("api_status returns error without KIMI_CODING_API_KEY", async () => {
    if (hasKimiKey) return; // skip check when key is set
    const result = await client.callTool({
      name: "check_kimi_coding_api",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(parseText(result)).toContain("KIMI_CODING_API_KEY");
  });

  // ── Section 13: Transcribe (requires ELEVENLABS_API_KEY) ─────────

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

  // ── Section 14: Generation tools (require KIE_API_KEY) ─────────

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
        asset_id: imgAssetId,
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
        asset_id: imgAssetId,
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
        image_refs: [imgAssetId],
      },
    });
    expect(result.isError).toBe(true);
    expect(parseText(result)).toContain("KIE_API_KEY");
  });

  // ── Section 15: Preview tools (require OPENAI_API_KEY) ─────────

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

  it("chat returns error without OPENAI_API_KEY", async () => {
    if (hasOpenAiKey) return;
    const result = await client.callTool({
      name: "chat",
      arguments: {
        prompt: "trim the first 2 seconds",
        book_id: PROJECT,
      },
    });
    expect(result.isError).toBe(true);
    expect(parseText(result)).toContain("OPENAI_API_KEY");
  });
});
