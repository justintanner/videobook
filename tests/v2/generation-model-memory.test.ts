import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Engine, NotebookCell } from "videobook-engine";
import { scopedBookEngine, withBookContext } from "../../server/src/book-context.js";
import { BookManager } from "../../server/src/book-manager.js";
import { applyGenerationRoutingDefaults } from "../../server/src/chat-generation-routing.js";
import { readGenerationModelMemory, rememberGenerationModel } from "../../server/src/generation-model-memory.js";
import { LIGHTNING_SCENE_MODEL, LIGHTNING_VIDEO_MODEL } from "../../server/src/lightning-defaults.js";
import { setEngineRoot, stopBookQueue } from "../../server/src/queue.js";
import type { ToolDef } from "../../server/src/tools/tool-def.js";
import { videobookDomainDefs } from "../../server/src/tools/videobook-domain.js";
import { asNotebook } from "../../src/videobook/workspace-responses";

const IMAGE_MODEL = "kie:gpt-image-2-6/sunburst-text-to-image";
const VIDEO_MODEL = "fal:minimax/h3/text-to-video";

type CellJson = { id: string; provider?: string; model?: string; tool?: string };

function resultJson(result: Awaited<ReturnType<ToolDef["handler"]>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined();
  return JSON.parse(result.content[0]!.text) as unknown;
}

describe("generation model memory", () => {
  let rootDir: string;
  let libraryDir: string;
  let books: BookManager;
  let bookId: string;
  let engine: Engine;
  let defs: Map<string, ToolDef>;
  const savedKeys = { KIE_API_KEY: process.env.KIE_API_KEY, FAL_API_KEY: process.env.FAL_API_KEY };

  async function openLibrary(): Promise<void> {
    books = new BookManager({ libraryDir, objectPrefix: "test-objects" });
    await books.ready();
    defs = new Map(videobookDomainDefs(scopedBookEngine, books).map((def) => [def.name, def]));
  }

  function useBook(id: string): void {
    const managed = books.get(id);
    if (!managed.ok) throw new Error(managed.error.message);
    bookId = id;
    engine = managed.value.engine;
  }

  async function invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    return resultJson(await withBookContext(
      { bookId, engine },
      () => defs.get(name)!.handler({ book_id: bookId, ...args }),
    ));
  }

  async function newCell(notebookId: string, type: string, column: number, model?: string): Promise<CellJson> {
    return await invoke("create_notebook_cell", {
      notebook_id: notebookId,
      cell: { type, slot: { row: 0, column }, prompt: model ? "a fox in snow" : "", ...(model ? { model } : {}) },
    }) as CellJson;
  }

  function storedCell(notebookId: string, cellId: string): NotebookCell {
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    return notebook.value.cells.find((cell) => cell.id === cellId)!;
  }

  async function runAsUser(notebookId: string, cellId: string): Promise<void> {
    const plan = await invoke("plan_notebook_generation", {
      notebook_id: notebookId,
      cell_id: cellId,
      source_surface: "ui",
      actor: "videobook-user",
      timeline_start_frame: 0,
    });
    await setEngineRoot(rootDir, engine);
    try {
      await invoke("run_notebook_cell", { notebook_id: notebookId, cell_id: cellId, plan, actor: "videobook-user" });
    } finally {
      await stopBookQueue(bookId);
    }
  }

  beforeEach(async () => {
    process.env.KIE_API_KEY = "test-key";
    process.env.FAL_API_KEY = "test-key";
    rootDir = await mkdtemp(join(tmpdir(), "videobook-model-memory-"));
    libraryDir = join(rootDir, "books");
    await openLibrary();
    const created = resultJson(await defs.get("create_book")!.handler({ name: "model-memory" })) as { bookId: string };
    useBook(created.bookId);
  });

  afterEach(async () => {
    await books.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
    for (const [name, value] of Object.entries(savedKeys)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("starts new cells in every notebook on the last image and video model a user ran", async () => {
    const first = engine.notebooks.list()[0]!.id;
    const untouched = await newCell(first, "generate_image", 0);
    expect(untouched).toMatchObject({ provider: "kie", model: LIGHTNING_SCENE_MODEL });

    const image = await newCell(first, "generate_image", 1, IMAGE_MODEL);
    const video = await newCell(first, "generate_video", 2, VIDEO_MODEL);
    expect(readGenerationModelMemory(engine)).toEqual({});
    await runAsUser(first, image.id);
    await runAsUser(first, video.id);
    expect(readGenerationModelMemory(engine)).toEqual({ image: IMAGE_MODEL, video: VIDEO_MODEL });

    const snapshot = await invoke("get_notebook", { notebook_id: first }) as { generation_model_memory: unknown };
    expect(snapshot.generation_model_memory).toEqual({ image: IMAGE_MODEL, video: VIDEO_MODEL });
    expect(asNotebook(snapshot)?.generationModelMemory).toEqual({ image: IMAGE_MODEL, video: VIDEO_MODEL });

    const second = (await invoke("create_notebook", { name: "Second" }) as { id: string }).id;
    expect(await newCell(second, "generate_image", 0)).toMatchObject({ provider: "kie", model: IMAGE_MODEL, tool: "generate_image" });
    expect(await newCell(second, "generate_video", 1)).toMatchObject({ provider: "fal", model: VIDEO_MODEL, tool: "generate_video" });
    expect(await newCell(second, "generate_image", 2, LIGHTNING_SCENE_MODEL)).toMatchObject({ model: LIGHTNING_SCENE_MODEL });
  });

  it("keeps the remembered models across a server restart", async () => {
    const notebookId = engine.notebooks.list()[0]!.id;
    const video = await newCell(notebookId, "generate_video", 0, VIDEO_MODEL);
    await runAsUser(notebookId, video.id);

    await books.close();
    await openLibrary();
    useBook(bookId);
    expect(readGenerationModelMemory(engine)).toEqual({ video: VIDEO_MODEL });
    const snapshot = await invoke("get_notebook", { notebook_id: notebookId }) as { generation_model_memory: unknown };
    expect(snapshot.generation_model_memory).toEqual({ video: VIDEO_MODEL });
    expect(await newCell(notebookId, "generate_video", 1)).toMatchObject({ provider: "fal", model: VIDEO_MODEL });
  });

  it("falls back to the same family on the same provider, then to Lightning, when the remembered model cannot be used", async () => {
    const notebookId = engine.notebooks.list()[0]!.id;
    const edit = await newCell(notebookId, "generate_image", 0, "kie:gpt-image-2-6/sunburst-image-to-image");
    const animate = await newCell(notebookId, "generate_video", 1, "fal:minimax/h3/image-to-video");
    rememberGenerationModel(engine, storedCell(notebookId, edit.id));
    rememberGenerationModel(engine, storedCell(notebookId, animate.id));
    expect(readGenerationModelMemory(engine)).toEqual({
      image: "kie:gpt-image-2-6/sunburst-image-to-image",
      video: "fal:minimax/h3/image-to-video",
    });

    expect(await newCell(notebookId, "generate_image", 2)).toMatchObject({ provider: "kie", model: IMAGE_MODEL });
    expect(await newCell(notebookId, "generate_video", 3)).toMatchObject({ provider: "fal", model: VIDEO_MODEL });

    delete process.env.FAL_API_KEY;
    expect(await newCell(notebookId, "generate_video", 4)).toMatchObject({ provider: "kie", model: LIGHTNING_VIDEO_MODEL });

    const retired = engine.settings.set("generation-model-memory", { image: "kie:retired-image-model" });
    expect(retired.ok).toBe(true);
    expect(await newCell(notebookId, "generate_image", 5)).toMatchObject({ provider: "kie", model: LIGHTNING_SCENE_MODEL });
  });

  it("does not remember follow-ups, image edits or cells that were only created", async () => {
    const notebookId = engine.notebooks.list()[0]!.id;
    await newCell(notebookId, "generate_video", 0, VIDEO_MODEL);
    const cell = (id: string, model: string, tool: string): NotebookCell => engine.notebooks.createCell({
      type: id === "image" ? "generate_image" : "generate_video",
      slot: { row: 1, column: 0 },
      model,
      tool,
    });
    rememberGenerationModel(engine, cell("video", "fal:minimax/h3-max-turbo/extend-video", "generate_video"));
    rememberGenerationModel(engine, cell("video", "kie:topaz/video-upscale", "generate_video"));
    rememberGenerationModel(engine, cell("video", "fal:fal-ai/heygen/v2/translate/speed", "generate_video"));
    rememberGenerationModel(engine, cell("video", "fal:fal-ai/heygen/v2/translate/precision", "generate_video"));
    rememberGenerationModel(engine, cell("image", "nano-banana-2-1", "edit_image_subjects"));
    expect(readGenerationModelMemory(engine)).toEqual({});
  });

  it("defaults a chat generation with no named model to the remembered model", async () => {
    const memory = { image: IMAGE_MODEL, video: VIDEO_MODEL };
    expect(await applyGenerationRoutingDefaults("generate_image", { prompt: "a red fox" }, memory))
      .toEqual({ prompt: "a red fox", model: IMAGE_MODEL });
    expect(await applyGenerationRoutingDefaults("generate_video", { prompt: "a red fox", model: LIGHTNING_VIDEO_MODEL }, memory))
      .toEqual({ prompt: "a red fox", model: LIGHTNING_VIDEO_MODEL });
    expect(await applyGenerationRoutingDefaults("generate_video", { prompt: "animate it", first_frame_ref: "art-1" }, memory))
      .toMatchObject({ model: "fal:minimax/h3/image-to-video", refs: { first_frame: ["art-1"] } });
    const chain = await applyGenerationRoutingDefaults("chain", {
      steps: [{ id: "picture", tool: "generate_image", params: { prompt: "a red fox" } }],
    }, memory);
    expect(chain.steps).toEqual([{ id: "picture", tool: "generate_image", params: { prompt: "a red fox", model: IMAGE_MODEL } }]);

    delete process.env.FAL_API_KEY;
    expect(await applyGenerationRoutingDefaults("generate_video", { prompt: "a red fox" }, memory))
      .toEqual({ prompt: "a red fox", model: LIGHTNING_VIDEO_MODEL });
  });
});
