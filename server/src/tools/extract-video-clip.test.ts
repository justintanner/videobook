import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { registerAllJobHandlers } from "../jobs/index.js";
import { queue, setEngineRoot } from "../queue.js";
import { extractVideoClipDef } from "./extract-video-clip.js";
import { splitVideoDef } from "./split-video.js";

const execFileAsync = promisify(execFile);

type TextContent = Array<{ type: string; text: string }>;

function resultValue(result: { content: TextContent }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("source-preserving video clip tools", () => {
  let engine: Engine;
  let root: string;
  let bookId: string;
  let sourceAssetId: string;
  let sourceArtifactId: string;
  let sourcePath: string;
  let notebookId: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-extract-clip-"));
    sourcePath = join(root, "source.mp4");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=5:size=320x180:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      sourcePath,
    ]);
    engine = createEngineForTest(root);
    await setEngineRoot(root, engine);
    registerAllJobHandlers(engine);
    bookId = engine.book.get().bookId;
    const source = await engine.artifacts.create({ kind: "video", name: "source" });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    sourceAssetId = source.value.artifactId;
    sourceArtifactId = source.value.artifactId;
    const written = await engine.files.writeFromPath(
      sourceArtifactId,
      "original.mp4",
      sourcePath,
    );
    expect(written.ok).toBe(true);
    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    notebookId = notebook.value.id;
    const inserted = await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({
      type: "video",
      label: "vid-source-cell",
      slot: { row: 0, column: 0 },
      outputArtifactId: sourceArtifactId,
    }));
    expect(inserted.ok).toBe(true);
  }, 120_000);

  afterAll(async () => {
    await queue.stop();
    if (root && engine) closeEngineForTest(root, engine);
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }, 60_000);

  it("extracts a new timestamped clip from a notebook address without an OpenAI key", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const result = await extractVideoClipDef(engine).handler({
        asset_id: "@a1",
        book_id: bookId,
        start_time: "1s",
        end_time: "0:03",
      });
      expect(result.isError).toBeFalsy();
      const extracted = resultValue(result);
      expect(extracted.source_asset_id).toBe(sourceAssetId);
      expect(extracted.output_artifact_id).toEqual(expect.any(String));
      expect(extracted.start_time).toBe(1);
      expect(extracted.end_time).toBe(3);
      expect(extracted.duration).toBe(2);

      const outputManifest = await engine.files.manifest(String(extracted.output_asset_id));
      expect(outputManifest.ok).toBe(true);
      if (!outputManifest.ok) return;
      const output = await probeVideo(join(outputManifest.value.path, "original.mp4"));
      expect(output.duration).toBeGreaterThan(1.8);
      expect(output.duration).toBeLessThanOrEqual(2.1);
      const sourceManifest = await engine.files.manifest(sourceAssetId);
      expect(sourceManifest.ok).toBe(true);
      if (!sourceManifest.ok) return;
      const source = await probeVideo(join(sourceManifest.value.path, "original.mp4"));
      expect(source.duration).toBeGreaterThan(4.8);
    } finally {
      if (originalKey) process.env.OPENAI_API_KEY = originalKey;
      else delete process.env.OPENAI_API_KEY;
    }
  }, 120_000);

  it("splits a notebook video at a human timestamp and preserves the source", async () => {
    const result = await splitVideoDef(engine).handler({
      asset_id: "@a1",
      book_id: bookId,
      chunk_a_end: "2s",
    });
    expect(result.isError).toBeFalsy();
    const split = resultValue(result);
    expect(split.source_asset_id).toBe(sourceAssetId);
    expect(split.chunk_a_end).toBe(2);
    expect(split.chunk_b_start).toBe(2);
    expect(split.chunk_a_asset_id).not.toBe(sourceAssetId);
    expect(split.chunk_b_asset_id).not.toBe(sourceAssetId);
    expect(split.chunk_a_artifact_id).toEqual(expect.any(String));
    expect(split.chunk_b_artifact_id).toEqual(expect.any(String));
    const sourceManifest = await engine.files.manifest(sourceAssetId);
    expect(sourceManifest.ok).toBe(true);
  }, 120_000);
});
