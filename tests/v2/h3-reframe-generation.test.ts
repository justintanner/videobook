import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Engine } from "videobook-engine";
import { BookManager } from "../../server/src/book-manager.js";
import { scopedBookEngine, withBookContext } from "../../server/src/book-context.js";
import { probeVideo, runFfmpeg } from "../../server/src/ffmpeg.js";
import { resolveModel } from "../../server/src/media/descriptor.js";
import { checkReframeVideoGeometry } from "../../server/src/media/refs.js";
import { reframeVideoGeometryError } from "../../server/src/media/reframe-video.js";
import { videobookDomainDefs } from "../../server/src/tools/videobook-domain.js";
import type { ToolDef } from "../../server/src/tools/tool-def.js";

const MODEL = "fal:minimax/h3-max/reframe-video";

describe("H3 Reframe source geometry", () => {
  let fixtureDir: string;
  let sourcePath: string;
  let rootDir: string;
  let books: BookManager;
  let engine: Engine;
  let sourceId: string;
  let notebookId: string;
  let generationId: string;
  let tools: Map<string, ToolDef>;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "videobook-reframe-fixture-"));
    sourcePath = join(fixtureDir, "portrait.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=s=1536x2688:r=24:d=0.25", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", sourcePath]);
  });

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-reframe-"));
    books = new BookManager({ libraryDir: join(rootDir, "books") });
    await books.ready();
    tools = new Map(videobookDomainDefs(scopedBookEngine, books).map((tool) => [tool.name, tool]));
    const book = await tools.get("create_book")!.handler({ name: "reframe" });
    const bookId = (JSON.parse(book.content[0]!.text!) as { bookId: string }).bookId;
    const managed = books.get(bookId);
    if (!managed.ok) throw new Error(managed.error.message);
    engine = managed.value.engine;
    const notebooks = JSON.parse((await invoke("list_notebooks", {})).content[0]!.text!) as Array<{ id: string }>;
    notebookId = notebooks[0]!.id;
    const source = await engine.artifacts.create("video", "portrait");
    if (!source.ok) throw new Error(source.error.message);
    sourceId = source.value.artifactId;
    expect((await engine.files.writeFromPath(sourceId, "original.mp4", sourcePath)).ok).toBe(true);
    const { width, height, duration } = await probeVideo(sourcePath);
    expect((await engine.metadata.artifacts.write(sourceId, "original", { width, height, duration })).ok).toBe(true);
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const video = engine.notebooks.createCell({ type: "video", slot: { row: 0, column: 0 }, outputArtifactId: sourceId });
    const generation = engine.notebooks.createCell({
      type: "generate_video", slot: { row: 1, column: 0 }, prompt: "looks realistic", provider: "fal", model: MODEL,
      operation: "edit_video", tool: "generate_video",
      inputs: { generationMode: "default", generationSettings: { aspect_ratio: "9:16", resolution: "1080p" } },
    });
    generationId = generation.id;
    expect((await engine.notebooks.write({
      ...notebook.value, cells: [...notebook.value.cells, video, generation],
      edges: [engine.notebooks.createEdge({ source: video.id, target: generation.id, targetInput: "video" })],
    })).ok).toBe(true);
  });

  afterEach(async () => {
    await books.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  function invoke(name: string, args: Record<string, unknown>) {
    return withBookContext({ bookId: engine.book.get().bookId, engine }, () => tools.get(name)!.handler({
      book_id: engine.book.get().bookId, notebook_id: notebookId, cell_id: generationId, ...args,
    }));
  }

  function preview(settings: Record<string, unknown>) {
    return invoke("preview_notebook_generation", { draft: {
      prompt: "looks realistic", provider: "fal", model: MODEL, operation: "edit_video", tool: "generate_video",
      inputs: { generationMode: "default", generationSettings: settings },
    } });
  }

  it.each([{}, { aspect_ratio: "9:16", resolution: "768p" }, { aspect_ratio: "9:16", resolution: "1080p" }])(
    "rejects the portrait regression during preview with %j", async (settings) => {
      const before = engine.notebooks.read(notebookId);
      const result = await preview(settings);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("1536×2688 source fills the 9:16 canvas");
      expect(result.content[0]?.text).toContain("Choose a different aspect ratio");
      expect(engine.notebooks.read(notebookId)).toEqual(before);
      expect(engine.jobs.queue.list()).toHaveLength(0);
    },
  );

  it("refuses a saved invalid plan before reserving outputs", async () => {
    const before = engine.notebooks.read(notebookId);
    const result = await invoke("plan_notebook_generation", { timeline_start_frame: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("leaving no area to outpaint");
    expect(engine.notebooks.read(notebookId)).toEqual(before);
    expect(engine.jobs.queue.list()).toHaveLength(0);
  });

  it("allows landscape expansion at 1080p without rewriting saved settings", async () => {
    const before = engine.notebooks.read(notebookId);
    const result = await preview({ aspect_ratio: "16:9", resolution: "1080p" });
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text!).payload.input).toMatchObject({ aspect_ratio: "16:9", resolution: "1080p" });
    expect(engine.notebooks.read(notebookId)).toEqual(before);
  });

  it("probes local files without dimensions and uses a sibling file's own geometry", async () => {
    expect((await engine.metadata.artifacts.write(sourceId, "original", {})).ok).toBe(true);
    expect(await checkReframeVideoGeometry(engine, resolveModel(MODEL), { video: [`@${sourceId}`] }, {}))
      .toContain("1536×2688 source fills the 9:16 canvas");
    expect((await engine.files.writeFromPath(sourceId, "cut.mp4", sourcePath)).ok).toBe(true);
    expect((await engine.metadata.artifacts.write(sourceId, "original", { width: 1344, height: 768 })).ok).toBe(true);
    expect(await checkReframeVideoGeometry(engine, resolveModel(MODEL), { video: [`@${sourceId}/cut.mp4`] }, {}))
      .toContain("1536×2688 source fills the 9:16 canvas");
  });
});

describe("verified H3 native canvases", () => {
  it.each(["768p", "1080p"])("detects filled landscape and portrait canvases at %s", (resolution) => {
    expect(reframeVideoGeometryError({ aspect_ratio: "16:9", resolution }, 2688, 1536)).toContain("no area to outpaint");
    expect(reframeVideoGeometryError({ aspect_ratio: "9:16", resolution }, 1536, 2688)).toContain("no area to outpaint");
    expect(reframeVideoGeometryError({ aspect_ratio: "16:9", resolution }, 1536, 2688)).toBeNull();
  });

  it("detects square sources and leaves unverified canvas shapes to the provider", () => {
    expect(reframeVideoGeometryError({ aspect_ratio: "1:1", resolution: "480p" }, 640, 640)).toContain("no area to outpaint");
    expect(reframeVideoGeometryError({ aspect_ratio: "9:16", resolution: "480p" }, 1536, 2688)).toBeNull();
    expect(reframeVideoGeometryError({ aspect_ratio: "9:16" }, 768, 1536)).toBeNull();
    expect(reframeVideoGeometryError({ aspect_ratio: "9:16" }, 0, 0)).toBeNull();
  });
});
