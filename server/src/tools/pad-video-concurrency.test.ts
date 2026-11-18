import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { BookManager } from "../book-manager.js";
import { scopedBookEngine, withBookContext } from "../book-context.js";
import { probeVideo } from "../ffmpeg.js";
import { registerPadVideoJob } from "../jobs/pad-video.js";
import { registerProcessVideoJob } from "../jobs/process-video.js";
import { queue, setEngineRoot, waitForJob } from "../queue.js";
import { testBudget } from "../test-budget.js";
import { COMMON_VIDEO_FIXTURES, copyVideoFixture } from "../test-media-fixtures.js";
import { padVideoDef } from "./pad-video.js";

const PADS = 5;

describe("pad_video under load", () => {
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
    rootDir = await mkdtemp(join(tmpdir(), "videobook-pad-load-"));
    const root = rootDir;
    const manager = new BookManager({ libraryDir: join(root, "books") });
    books = manager;
    await manager.ready();
    const created = await manager.create("pad-load");
    if (!created.ok) throw new Error(created.error.message);
    const bookId = created.value.bookId;
    const managed = manager.get(bookId);
    if (!managed.ok) throw new Error(managed.error.message);
    const engine = managed.value.engine;
    registerPadVideoJob(scopedBookEngine);
    registerProcessVideoJob(scopedBookEngine);
    await setEngineRoot(managed.value.rootDir, engine);
    const pad = padVideoDef(scopedBookEngine);
    return {
      engine,
      async video(index: number): Promise<string> {
        const path = join(root, `source-${index}.mp4`);
        await copyVideoFixture(COMMON_VIDEO_FIXTURES.padVideo(2, true), path);
        const artifact = await engine.artifacts.create("video", `Source ${index}`);
        if (!artifact.ok) throw new Error(artifact.error.message);
        const written = await engine.files.writeFromPath(artifact.value.artifactId, "original.mp4", path);
        if (!written.ok) throw new Error(written.error.message);
        return artifact.value.artifactId;
      },
      async pad(assetId: string): Promise<string> {
        const result = await withBookContext({ bookId, engine }, () => pad.handler({ asset_id: assetId, book_id: bookId, padding: "2s" }));
        if (result.isError) throw new Error(result.content[0]?.text);
        return (JSON.parse(result.content[0]!.text) as { job_id: string }).job_id;
      },
    };
  }

  async function duration(engine: Engine, assetId: string): Promise<number> {
    const read = await engine.files.read(assetId, "original.mp4");
    if (!read.ok) throw new Error(read.error.message);
    const path = join(rootDir!, `${assetId}-padded.mp4`);
    await writeFile(path, read.value);
    return (await probeVideo(path)).videoDuration;
  }

  it("finishes five simultaneous pads in one book and reprocesses each padded video", async () => {
    const h = await harness();
    const assets = await Promise.all(Array.from({ length: PADS }, (_, index) => h.video(index)));

    const jobs = await Promise.all(assets.map((assetId) => h.pad(assetId)));
    await Promise.all(jobs.map((jobId) => waitForJob(jobId, testBudget(45_000))));

    for (const assetId of assets) {
      expect(await duration(h.engine, assetId)).toBeCloseTo(4, 1);
      expect(await h.engine.metadata.artifacts.read(assetId, "original")).toMatchObject({
        ok: true, value: { origin: "pad_video", target_secs: 4, has_audio: true },
      });
      expect((await h.engine.files.read(assetId, "original.jpg")).ok).toBe(true);
    }
    expect(h.engine.jobs.queue.list({ states: ["queued", "running", "failed", "aborted"] })).toEqual([]);
  }, testBudget(90_000));

  it("fails the pad job when reprocessing the padded video fails", async () => {
    const h = await harness();
    const assetId = await h.video(0);
    const blocker = await h.engine.files.write(assetId, "original.jpg/blocker.txt", "not an image");
    expect(blocker.ok).toBe(true);

    const jobId = await h.pad(assetId);

    await expect(waitForJob(jobId, testBudget(45_000))).rejects.toThrow(/failed: .*original\.jpg/);
    expect(await duration(h.engine, assetId)).toBeCloseTo(4, 1);
  }, testBudget(90_000));
});
