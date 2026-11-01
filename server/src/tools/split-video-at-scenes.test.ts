import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { BookManager } from "../book-manager.js";
import { scopedBookEngine, withBookContext } from "../book-context.js";
import { registerDetectScenesJob } from "../jobs/detect-scenes.js";
import { registerRunNotebookJob } from "../jobs/run-notebook.js";
import { queue, setEngineRoot, stopBookQueue } from "../queue.js";
import { asSceneData } from "../scene-cuts.js";
import { SCENE_FILMSTRIP_FILE } from "../scene-filmstrip.js";
import { testBudget } from "../test-budget.js";
import { COMMON_VIDEO_FIXTURES, copyVideoFixture } from "../test-media-fixtures.js";
import { getVideoEditingToolDefs } from "./index.js";
import type { ToolDef } from "./tool-def.js";
import { videobookDomainDefs } from "./videobook-domain.js";

const FIXTURE_CUTS = [2, 4.5];
const FIXTURE_DURATION = 6;
const FRAME = 1 / 24;

type Harness = {
  bookId: string;
  engine: Engine;
  notebookId: string;
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

function resultJson(result: Awaited<ReturnType<ToolDef["handler"]>>): Record<string, unknown> {
  if (result.isError) throw new Error(result.content[0]?.text ?? "Tool failed");
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

async function waitForQueueJob(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < testBudget(1200); attempt += 1) {
    const status = await queue.getStatus(jobId);
    if (status?.state === "completed") return;
    if (status?.state === "failed") throw new Error(status.error?.message ?? "Job failed");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Job ${jobId} did not complete`);
}

describe("split_video_at_scenes", () => {
  let rootDir: string | undefined;
  let books: BookManager | undefined;
  let bookId: string | undefined;

  afterEach(async () => {
    if (bookId) await stopBookQueue(bookId);
    if (books) await books.close();
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    rootDir = undefined;
    books = undefined;
    bookId = undefined;
  });

  async function harness(): Promise<Harness> {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-scene-split-"));
    books = new BookManager({ libraryDir: join(rootDir, "books"), objectPrefix: "test-objects", catalogBackupName: "backup" });
    await books.ready();
    const created = await books.create("scene-split");
    if (!created.ok) throw new Error(created.error.message);
    bookId = created.value.bookId;
    const managed = books.get(bookId);
    if (!managed.ok) throw new Error(managed.error.message);
    const engine = managed.value.engine;
    await setEngineRoot(rootDir, engine);
    registerRunNotebookJob(engine);
    registerDetectScenesJob(engine);
    const defs = new Map([
      ...videobookDomainDefs(scopedBookEngine, books),
      ...getVideoEditingToolDefs(scopedBookEngine),
    ].map((def) => [def.name, def]));
    const currentBook = bookId;
    const call = async (name: string, args: Record<string, unknown>) => {
      const def = defs.get(name);
      if (!def) throw new Error(`Missing ${name}`);
      return await withBookContext({ bookId: currentBook, engine }, async () => resultJson(await def.handler(args)));
    };
    const notebooks = await call("list_notebooks", { book_id: bookId }) as unknown as Array<{ id: string }>;
    return { bookId, engine, notebookId: notebooks[0]!.id, call };
  }

  async function placeFixture(h: Harness): Promise<string> {
    const sourcePath = join(rootDir!, "scenes.mp4");
    await copyVideoFixture(COMMON_VIDEO_FIXTURES.sceneCuts, sourcePath);
    const artifact = await h.engine.artifacts.create({ kind: "video", label: "Scenes" });
    if (!artifact.ok) throw new Error(artifact.error.message);
    const written = await h.engine.files.writeFromPath(artifact.value.artifactId, "original.mp4", sourcePath);
    if (!written.ok) throw new Error(written.error.message);
    await h.call("create_notebook_cell", {
      book_id: h.bookId,
      notebook_id: h.notebookId,
      cell: { type: "video", label: "Scenes", slot: { row: 0, column: 0 }, output_artifact_id: artifact.value.artifactId },
    });
    return artifact.value.artifactId;
  }

  async function detectFull(h: Harness): Promise<Record<string, unknown>> {
    const first = await h.call("detect_scenes", { book_id: h.bookId, source_asset_id: "@a1", detail: "full" });
    if (first.status !== "cached") {
      for (let attempt = 0; attempt < testBudget(1200); attempt += 1) {
        const next = await h.call("detect_scenes", { book_id: h.bookId, source_asset_id: "@a1", detail: "full" });
        if (next.status === "cached") return next;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Scene detection did not finish");
    }
    return first;
  }

  it("detects frame-accurate camera cuts with a filmstrip", async () => {
    const h = await harness();
    const artifactId = await placeFixture(h);
    const detected = await detectFull(h);
    expect(detected).toMatchObject({ asset_id: artifactId, status: "cached", shots: 2 });
    const scenes = asSceneData(detected.scenes);
    expect(scenes).not.toBeNull();
    expect(scenes!.durationSeconds).toBeCloseTo(FIXTURE_DURATION, 1);
    expect(scenes!.cuts.map((cut) => cut.t)).toHaveLength(2);
    scenes!.cuts.forEach((cut, index) => {
      expect(Math.abs(cut.t - FIXTURE_CUTS[index]!)).toBeLessThanOrEqual(FRAME + 0.001);
    });
    expect(scenes!.filmstrip).toMatchObject({
      url: `/files/${h.bookId}/${artifactId}/${SCENE_FILMSTRIP_FILE}`,
      frames: 12,
      frameHeight: 72,
    });
    const sprite = await h.engine.files.read(artifactId, SCENE_FILMSTRIP_FILE);
    expect(sprite.ok).toBe(true);
    if (sprite.ok) expect([...sprite.value.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  }, testBudget(120_000));

  it("splits a notebook video into one cell per scene", async () => {
    const h = await harness();
    await placeFixture(h);
    const result = await h.call("split_video_at_scenes", { book_id: h.bookId, asset_id: "@a1" });
    expect(result).toMatchObject({ source_cell: "@a1" });
    const cuts = result.cut_points_seconds as number[];
    expect(cuts).toHaveLength(2);
    const outputIds = result.output_cell_ids as string[];
    expect(outputIds).toHaveLength(3);

    await waitForQueueJob(String(result.job_id));
    const notebook = h.engine.notebooks.read(h.notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const durations = outputIds.map((id) => {
      const cell = notebook.value.cells.find((candidate) => candidate.id === id);
      expect(cell).toMatchObject({ type: "video", outputArtifactId: expect.any(String), inputs: { state: "completed" } });
      return Number(cell?.inputs?.durationSeconds);
    });
    expect(durations[0]).toBeCloseTo(FIXTURE_CUTS[0]!, 1);
    expect(durations[1]).toBeCloseTo(FIXTURE_CUTS[1]! - FIXTURE_CUTS[0]!, 1);
    expect(durations.reduce((sum, value) => sum + value, 0)).toBeCloseTo(FIXTURE_DURATION, 1);
  }, testBudget(180_000));

  it("splits at reviewed cut points without running detection", async () => {
    const h = await harness();
    await placeFixture(h);
    const result = await h.call("split_video_at_scenes", {
      book_id: h.bookId,
      asset_id: "@a1",
      cut_points_seconds: [3],
    });
    expect(result.cut_points_seconds).toEqual([3]);
    expect(result.output_cell_ids).toHaveLength(2);
    await waitForQueueJob(String(result.job_id));
    const detection = await h.call("detect_scenes", { book_id: h.bookId, source_asset_id: "@a1" });
    expect(detection.status).toBe("queued");
  }, testBudget(180_000));
});
