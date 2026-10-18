import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactKind, Engine } from "videobook-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { findOriginalMediaFile } from "../original-media-file.js";
import { exportAssetFileDef } from "./export-asset-file.js";

describe("original media file actions", () => {
  let root: string;
  let downloads: string;
  let engine: Engine;
  let previousDownloads: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "export-media-"));
    downloads = await mkdtemp(join(tmpdir(), "export-media-downloads-"));
    engine = createEngineForTest(root);
    const renamed = await engine.book.rename("wood");
    if (!renamed.ok) throw new Error(renamed.error.message);
    previousDownloads = process.env.VIDEOBOOK_DOWNLOADS_DIR;
    process.env.VIDEOBOOK_DOWNLOADS_DIR = downloads;
  });

  afterEach(async () => {
    if (previousDownloads === undefined) delete process.env.VIDEOBOOK_DOWNLOADS_DIR;
    else process.env.VIDEOBOOK_DOWNLOADS_DIR = previousDownloads;
    closeEngineForTest(root, engine);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    await rm(downloads, { recursive: true, force: true, maxRetries: 3 });
  });

  async function asset(kind: ArtifactKind, files: Record<string, string>): Promise<string> {
    const created = await engine.artifacts.create(kind, "media / take");
    if (!created.ok) throw new Error(created.error.message);
    for (const [name, content] of Object.entries(files)) {
      const written = await engine.files.write(created.value.artifactId, name, content);
      if (!written.ok) throw new Error(written.error.message);
    }
    return created.value.artifactId;
  }

  it.each<[ArtifactKind, string]>([
    ["video", "mp4"], ["video", "mov"], ["video", "webm"], ["video", "mkv"],
    ["image", "png"], ["image", "jpg"], ["image", "webp"],
    ["audio", "mp3"], ["audio", "wav"], ["audio", "m4a"], ["audio", "aac"],
    ["audio", "ogg"], ["audio", "flac"], ["audio", "weba"], ["audio", "webm"],
  ])("exports the original %s .%s bytes using the book name with collision-safe filenames", async (kind, ext) => {
    const bytes = `original ${kind} ${ext}`;
    const artifactId = await asset(kind, {
      "thumbnail.jpg": "thumbnail",
      "proxy.mp4": "proxy",
      ...(kind === "audio" ? { "original.png": "cover" } : {}),
      [`original.${ext}`]: bytes,
    });
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    expect(findOriginalMediaFile(manifest.value.files, kind)?.name).toBe(`original.${ext}`);
    for (const suffix of ["", " (2)"]) {
      const result = await exportAssetFileDef(engine).handler({ asset_id: artifactId, to: "downloads" });
      expect(result.isError).toBeFalsy();
      const text = result.content as Array<{ text: string }>;
      const payload = JSON.parse(text[0]!.text) as { status: string; path: string };
      expect(payload).toEqual({ status: "exported", path: join(downloads, `wood${suffix}.${ext}`) });
      expect(await readFile(payload.path, "utf8")).toBe(bytes);
    }
    const original = await engine.files.read(artifactId, `original.${ext}`);
    expect(original.ok && original.value.toString()).toBe(bytes);
  });

  it("exports the final render using the current name after renaming the book", async () => {
    const artifactId = await asset("final", { "timeline_portrait.mp4": "render" });
    const definition = exportAssetFileDef(engine);
    const renamed = await engine.book.rename("forest");
    if (!renamed.ok) throw new Error(renamed.error.message);
    const result = await definition.handler({ asset_id: artifactId, to: "downloads" });
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(downloads, "forest.mp4"), "utf8")).toBe("render");
  });

  it.each(["video", "audio", "image"] as const)("rejects missing %s originals for download and copy", async (kind) => {
    const artifactId = await asset(kind, { "thumbnail.jpg": "thumbnail", "proxy.mp4": "proxy" });
    for (const to of ["downloads", "clipboard"]) {
      const result = await exportAssetFileDef(engine).handler({ asset_id: artifactId, to });
      expect(result).toMatchObject({ isError: true, content: [{ text: "No original media file found for asset" }] });
    }
    expect(await readdir(downloads)).toEqual([]);
  });
});
