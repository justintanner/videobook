import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NotebookDocument } from "videobook-engine";
import { scopedBookEngine, withBookContext } from "../../server/src/book-context.js";
import { BookManager } from "../../server/src/book-manager.js";
import { resolveModel } from "../../server/src/media/descriptor.js";
import { buildWireRequest } from "../../server/src/media/request.js";
import { videobookDomainDefs } from "../../server/src/tools/videobook-domain.js";
import type { ToolDef } from "../../server/src/tools/tool-def.js";
import { asNotebook } from "../../src/videobook/workspace-responses";

type Invoke = (name: string, args: Record<string, unknown>) => Promise<unknown>;
type CellJson = { id: string; inputs?: { generationSettings?: Record<string, unknown> } };

function resultJson(result: Awaited<ReturnType<ToolDef["handler"]>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined();
  return JSON.parse(result.content[0]!.text) as unknown;
}

function defaultsOf(model: string): Record<string, unknown> {
  return Object.fromEntries(resolveModel(model).options.map((option) => [option.name, option.defaultValue]));
}

function videoCell(column: number, model: string, generationSettings?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "generate_video",
    slot: { row: 0, column },
    prompt: "a fox in snow",
    provider: model.split(":")[0],
    model,
    operation: "text_to_video",
    tool: "generate_video",
    ...(generationSettings ? { inputs: { generationSettings } } : {}),
  };
}

describe("preferred generation defaults", () => {
  it("defaults video models to 12 seconds, 9:16 and their highest quality", () => {
    expect(defaultsOf("kie:bytedance/seedance-2-5")).toMatchObject({ duration: 12, aspect_ratio: "9:16", resolution: "1080p" });
    expect(defaultsOf("kie:kling-3.0-omni/text-to-video")).toMatchObject({ duration: 12, aspect_ratio: "9:16", resolution: "4k" });
    expect(defaultsOf("fal:bytedance/seedance-2.5/us/text-to-video")).toMatchObject({ duration: "12", aspect_ratio: "9:16", resolution: "1080p", bitrate_mode: "high" });
    expect(defaultsOf("kie:veo3")).toMatchObject({ duration: 8, aspectRatio: "9:16", resolution: "4k" });
    expect(defaultsOf("kie:gemini-omni-video")).toMatchObject({ duration: "10", aspect_ratio: "9:16", resolution: "4k" });
  });

  it("defaults image models to 9:16, 2K and their highest quality without touching edit-only durations", () => {
    expect(defaultsOf("kie:nano-banana-pro")).toMatchObject({ aspect_ratio: "9:16", resolution: "2K" });
    expect(defaultsOf("fal:blackforestlabs/flux-3/text-to-image")).toMatchObject({ resolution: "2k" });
    expect(defaultsOf("kie:seedream/5-flash-text-to-image")).toMatchObject({ size: "2K" });
    expect(defaultsOf("kie:seedream/5-lite-text-to-image")).toMatchObject({ aspect_ratio: "9:16", quality: "high" });
    expect(defaultsOf("fal:ideogram/v4.5")).toMatchObject({ image_size: "portrait_16_9", quality: "high" });
    expect(defaultsOf("fal:minimax/h3-max/insert-video")).toMatchObject({ duration: 5 });
  });

  it("keeps catalog constraints that the preferred defaults would break", () => {
    expect(defaultsOf("kie:kling-3.0-omni/image-to-video")).toMatchObject({ aspect_ratio: "auto", duration: 12 });
    const references = buildWireRequest(resolveModel("xai:grok-imagine-video"), {
      prompt: "a fox", mode: "r2v", refUrls: { image: ["https://example.com/a.png"] },
    });
    expect(references).toMatchObject({ ok: true, input: { duration: 10 } });
  });
});

describe("notebook generation settings memory", () => {
  let rootDir: string;
  let books: BookManager;
  let invoke: Invoke;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-sticky-"));
    books = new BookManager({ libraryDir: join(rootDir, "books"), objectPrefix: "test-objects" });
    await books.ready();
    const byName = new Map(videobookDomainDefs(scopedBookEngine, books).map((def) => [def.name, def]));
    const created = resultJson(await byName.get("create_book")!.handler({ name: "sticky" })) as { bookId: string };
    const managed = books.get(created.bookId);
    if (!managed.ok) throw new Error(managed.error.message);
    invoke = async (name, args) => resultJson(await withBookContext(
      { bookId: created.bookId, engine: managed.value.engine },
      () => byName.get(name)!.handler({ book_id: created.bookId, ...args }),
    ));
  });

  afterEach(async () => {
    await books.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function notebookId(): Promise<string> {
    const notebooks = await invoke("list_notebooks", {}) as Array<{ id: string }>;
    return notebooks[0]!.id;
  }

  async function settingsOf(id: string, cellId: string): Promise<Record<string, unknown> | undefined> {
    const document = await invoke("get_notebook", { notebook_id: id }) as NotebookDocument;
    const cell = document.cells.find((candidate) => candidate.id === cellId) as CellJson | undefined;
    return cell?.inputs?.generationSettings;
  }

  it("leaves a fresh notebook on the model defaults", async () => {
    const id = await notebookId();
    const cell = await invoke("create_notebook_cell", { notebook_id: id, cell: videoCell(0, "kie:bytedance/seedance-2-5") }) as CellJson;
    expect(await settingsOf(id, cell.id)).toBeUndefined();
    const document = await invoke("get_notebook", { notebook_id: id }) as { generation_settings_memory: unknown };
    expect(document.generation_settings_memory).toEqual({});
  });

  it("starts new cells at the last aspect, duration and resolution chosen in the notebook", async () => {
    const id = await notebookId();
    const first = await invoke("create_notebook_cell", { notebook_id: id, cell: videoCell(0, "kie:bytedance/seedance-2-5") }) as CellJson;
    await invoke("update_notebook_cell", {
      notebook_id: id,
      cell_id: first.id,
      cell: { inputs: { generationSettings: { aspect_ratio: "16:9", duration: 8, resolution: "720p" } } },
    });

    const second = await invoke("create_notebook_cell", { notebook_id: id, cell: videoCell(1, "kie:kling-3.0-omni/text-to-video") }) as CellJson;
    expect(await settingsOf(id, second.id)).toEqual({ aspect_ratio: "16:9", duration: 8, resolution: "720p" });

    const fal = await invoke("create_notebook_cell", { notebook_id: id, cell: videoCell(2, "fal:bytedance/seedance-2.5/us/text-to-video") }) as CellJson;
    expect(await settingsOf(id, fal.id)).toEqual({ aspect_ratio: "16:9", duration: "8", resolution: "720p" });

    const document = await invoke("get_notebook", { notebook_id: id }) as { generation_settings_memory: unknown };
    expect(document.generation_settings_memory).toEqual({ aspect: "16:9", duration: 8, resolution: "720p" });
    expect(asNotebook(document)?.generationSettingsMemory).toEqual({ aspect: "16:9", duration: 8, resolution: "720p" });
  });

  it("remembers only the settings that changed and lets explicit settings win", async () => {
    const id = await notebookId();
    const first = await invoke("create_notebook_cell", {
      notebook_id: id,
      cell: videoCell(0, "kie:bytedance/seedance-2-5", { aspect_ratio: "16:9" }),
    }) as CellJson;
    const old = await invoke("create_notebook_cell", { notebook_id: id, cell: videoCell(1, "kie:bytedance/seedance-2-5") }) as CellJson;
    expect(await settingsOf(id, old.id)).toEqual({ aspect_ratio: "16:9" });

    await invoke("update_notebook_cell", {
      notebook_id: id,
      cell_id: first.id,
      cell: { inputs: { generationSettings: { aspect_ratio: "1:1" } } },
    });
    await invoke("update_notebook_cell", {
      notebook_id: id,
      cell_id: old.id,
      cell: { inputs: { generationSettings: { aspect_ratio: "16:9", duration: 6 } } },
    });

    const next = await invoke("create_notebook_cell", {
      notebook_id: id,
      cell: videoCell(2, "kie:bytedance/seedance-2-5", { resolution: "480p" }),
    }) as CellJson;
    expect(await settingsOf(id, next.id)).toEqual({ aspect_ratio: "1:1", duration: 6, resolution: "480p" });
  });

  it("skips remembered values a model cannot take and seeds when a cell switches models", async () => {
    const id = await notebookId();
    await invoke("create_notebook_cell", {
      notebook_id: id,
      cell: videoCell(0, "kie:bytedance/seedance-2-5", { aspect_ratio: "21:9", duration: 20 }),
    });
    const veo = await invoke("create_notebook_cell", { notebook_id: id, cell: videoCell(1, "kie:veo3") }) as CellJson;
    expect(await settingsOf(id, veo.id)).toBeUndefined();

    const seedance = await invoke("create_notebook_cell", { notebook_id: id, cell: videoCell(2, "kie:veo3") }) as CellJson;
    await invoke("update_notebook_cell", { notebook_id: id, cell_id: seedance.id, cell: { model: "kie:bytedance/seedance-2-5" } });
    expect(await settingsOf(id, seedance.id)).toEqual({ aspect_ratio: "21:9", duration: 20 });
  });

  it("keeps each notebook's memory separate", async () => {
    const id = await notebookId();
    await invoke("create_notebook_cell", {
      notebook_id: id,
      cell: videoCell(0, "kie:bytedance/seedance-2-5", { aspect_ratio: "16:9" }),
    });
    const other = await invoke("create_notebook", { name: "Second" }) as { id: string };
    const cell = await invoke("create_notebook_cell", { notebook_id: other.id, cell: videoCell(0, "kie:bytedance/seedance-2-5") }) as CellJson;
    expect(await settingsOf(other.id, cell.id)).toBeUndefined();
  });
});
