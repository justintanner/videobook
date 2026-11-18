import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Engine } from "videobook-engine";
import { BookManager } from "../book-manager.js";
import { scopedBookEngine, withBookContext } from "../book-context.js";
import { probeImage } from "../image.js";
import { registerCropImageJob } from "../jobs/crop-image.js";
import { registerProcessImageJob } from "../jobs/process-image.js";
import { queue, setEngineRoot } from "../queue.js";
import { testBudget } from "../test-budget.js";
import { cropAssetDef } from "./crop-asset.js";

const CROPS = 5;

async function squarePng(shade: number): Promise<Buffer> {
  return sharp({
    create: { width: 1200, height: 1200, channels: 3, background: { r: shade, g: 120, b: 255 - shade } },
  }).png().toBuffer();
}

describe("crop_asset under load", () => {
  let rootDir: string | undefined;
  let books: BookManager | undefined;

  afterEach(async () => {
    await queue.stop();
    await books?.close();
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    rootDir = undefined;
    books = undefined;
  });

  async function harness() {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-crop-load-"));
    const manager = new BookManager({ libraryDir: join(rootDir, "books") });
    books = manager;
    await manager.ready();
    const created = await manager.create("crop-load");
    if (!created.ok) throw new Error(created.error.message);
    const bookId = created.value.bookId;
    const managed = manager.get(bookId);
    if (!managed.ok) throw new Error(managed.error.message);
    const engine = managed.value.engine;
    registerCropImageJob(scopedBookEngine);
    registerProcessImageJob(scopedBookEngine);
    await setEngineRoot(managed.value.rootDir, engine);
    const crop = cropAssetDef(scopedBookEngine);
    return {
      engine,
      async image(index: number): Promise<string> {
        const artifact = await engine.artifacts.create("image", `Square ${index}`);
        if (!artifact.ok) throw new Error(artifact.error.message);
        const written = await engine.files.write(artifact.value.artifactId, "original.png", await squarePng(index * 40));
        if (!written.ok) throw new Error(written.error.message);
        return artifact.value.artifactId;
      },
      crop: (assetId: string) => withBookContext({ bookId, engine }, () => crop.handler({
        asset_id: assetId, book_id: bookId, ratio: "1:1", x: 0.1, y: 0.1, w: 0.8, h: 0.8,
      })),
    };
  }

  async function dimensions(engine: Engine, assetId: string, filename: string) {
    const read = await engine.files.read(assetId, filename);
    if (!read.ok) throw new Error(read.error.message);
    return probeImage(read.value);
  }

  it("finishes five simultaneous crops in one book with their derived images", async () => {
    const h = await harness();
    const assets = await Promise.all(Array.from({ length: CROPS }, (_, index) => h.image(index)));

    const results = await Promise.all(assets.map((assetId) => h.crop(assetId)));

    for (const [index, result] of results.entries()) {
      expect(result.isError, result.content[0]?.text).toBeFalsy();
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ asset_id: assets[index], status: "completed" });
    }
    for (const assetId of assets) {
      expect(await dimensions(h.engine, assetId, "original.jpg")).toMatchObject({ width: 1080, height: 1080 });
      expect(await dimensions(h.engine, assetId, "landscape.jpg")).toMatchObject({ width: 1920, height: 1080 });
      expect(await dimensions(h.engine, assetId, "portrait.jpg")).toMatchObject({ width: 1080, height: 1920 });
      expect(await dimensions(h.engine, assetId, "square.jpg")).toMatchObject({ width: 1080, height: 1080 });
      expect(await h.engine.metadata.artifacts.read(assetId, "original")).toMatchObject({
        ok: true, value: { origin: "crop", ratio: "1:1", width: 1080, height: 1080 },
      });
    }
    expect(h.engine.jobs.queue.list({ states: ["queued", "running", "failed", "aborted"] })).toEqual([]);
  }, testBudget(60_000));

  it("reports a failure while deriving images to the crop caller", async () => {
    const h = await harness();
    const assetId = await h.image(0);
    const blocker = await h.engine.files.write(assetId, "landscape.jpg/blocker.txt", "not an image");
    expect(blocker.ok).toBe(true);

    const result = await h.crop(assetId);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^Crop failed: .*landscape\.jpg/);
    expect(await dimensions(h.engine, assetId, "original.jpg")).toMatchObject({ width: 1080, height: 1080 });
  }, testBudget(60_000));
});
