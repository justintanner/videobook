import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NotebookDocument } from "videobook-engine";
import { BookManager } from "../../server/src/book-manager.js";
import { scopedBookEngine, withBookContext } from "../../server/src/book-context.js";
import {
  DEFAULT_ANIMATION_TOOL,
  DEFAULT_IMAGE_TOOL,
  DEFAULT_VIDEO_TOOL,
  listNotebookActions,
  selectedCellDetails,
  validateCellConfiguration,
} from "../../server/src/notebook-action-catalog.js";
import { videobookDomainDefs } from "../../server/src/tools/videobook-domain.js";
import type { ToolDef } from "../../server/src/tools/tool-def.js";

function resultJson(result: Awaited<ReturnType<ToolDef["handler"]>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined();
  return JSON.parse(result.content[0]!.text) as unknown;
}

describe("notebook action catalog", () => {
  let rootDir: string;
  let books: BookManager;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-catalog-"));
    books = new BookManager({ libraryDir: join(rootDir, "books"), objectPrefix: "test-objects" });
    await books.ready();
  });

  afterEach(async () => {
    await books.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("exposes deterministic analysis and Videocity generation defaults", () => {
    const actions = listNotebookActions();
    const ids = actions.map((action) => action.id);
    expect(ids).toEqual([...ids].sort((left, right) => left.localeCompare(right)));
    const analysis = actions.find((action) => action.operation === "analyze_source");
    expect(analysis).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      tool: "openai_responses_analysis",
      defaults: {
        reasoning: { effort: "high" },
      },
    });
    expect(actions.find((action) => action.operation === "rewrite_prompt"))
      .toMatchObject({
        provider: "openai",
        model: "gpt-5.6-sol",
        defaults: {
          reasoning: { effort: "medium" },
        },
      });
    expect(actions.some((action) => action.tool === DEFAULT_ANIMATION_TOOL)).toBe(true);
    expect(actions.find((action) =>
      action.kind === "generation"
      && action.cellTypes.includes("generate_video")
      && action.isDefault)?.tool).toBe(DEFAULT_VIDEO_TOOL);
    expect(actions.find((action) =>
      action.kind === "generation"
      && action.cellTypes.includes("generate_image")
      && action.isDefault)?.tool).toBe(DEFAULT_IMAGE_TOOL);
    expect(actions
      .filter((action) => action.kind === "generation" && action.isDefault)
      .map((action) => action.cellTypes[0])
      .sort())
      .toEqual(["generate_audio", "generate_image", "generate_video"]);
    expect(actions.some((action) => action.tool === "ffmpeg")).toBe(true);
    expect(actions.find((action) => action.operation === "split_range"))
      .toMatchObject({
        cellTypes: ["split_video"],
        requiredInputs: ["video"],
      });
    expect(actions.find((action) => action.operation === "extract_audio"))
      .toMatchObject({
        cellTypes: ["extract_audio"],
        requiredInputs: ["video"],
      });
    expect(actions.find((action) => action.operation === "extract_frame"))
      .toMatchObject({
        cellTypes: ["extract_frame"],
        requiredInputs: ["video"],
        parameters: [
          {
            name: "frameMode",
            type: "enum",
            default: "first",
            enumValues: ["first", "time", "last"],
          },
          {
            name: "timestampSeconds",
            type: "number",
            default: null,
          },
        ],
      });
    expect(actions.some((action) =>
      action.operation === "extract_audio"
      && action.cellTypes.includes("audio"))).toBe(false);
    expect(actions.some((action) =>
      action.operation === "extract_frame"
      && action.cellTypes.includes("image"))).toBe(false);
    expect(actions.some((action) =>
      action.cellTypes.some((type) =>
        type === "audio"
        || type === "image"
        || type === "video"
        || type === "character"))).toBe(false);
  });

  it("rejects invalid tools and returns 14-column raw rows via MCP", async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books);
    const byName = new Map(defs.map((def) => [def.name, def]));
    const created = resultJson(await byName.get("create_book")!.handler({ slug: "catalog" })) as {
      bookId: string
    };
    const managed = books.get(created.bookId);
    expect(managed.ok).toBe(true);
    if (!managed.ok) return;

    const invoke = async (name: string, args: Record<string, unknown>) => {
      const def = byName.get(name);
      if (!def) throw new Error(`Missing ${name}`);
      return await withBookContext(
        { bookId: created.bookId, engine: managed.value.engine },
        () => def.handler({ book_id: created.bookId, ...args }),
      );
    };

    const notebooks = resultJson(await invoke("list_notebooks", {})) as Array<{ id: string }>;
    const notebookId = notebooks[0]!.id;
    const analysis = resultJson(await invoke("create_notebook_cell", {
      notebook_id: notebookId,
      cell: {
        type: "analyze",
        slug: "analyze-source",
        slot: { row: 0, column: 0 },
        prompt: "Segment the source",
        provider: "kie",
        model: "gemini-3.5-flash",
        operation: "analyze_source",
        tool: "kie_gemini_analysis",
      },
    })) as {
      id: string;
      provider: string;
      model: string;
      tool: string;
      output_cell: {
        id: string;
        type: string;
        slug: string;
        slot: { row: number; column: number };
        inputs: Record<string, unknown>;
      };
      output_edge: {
        source: string;
        target: string;
        targetInput: string;
      };
    };
    expect(analysis).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      tool: "openai_responses_analysis",
    });
    expect(analysis.output_cell).toMatchObject({
      type: "analysis",
      slug: "analysis-source",
      slot: { row: 1, column: 0 },
      inputs: {
        analysisRole: "result",
        producerCellId: analysis.id,
        state: "pending",
      },
    });
    expect(analysis.output_edge).toMatchObject({
      source: analysis.id,
      target: analysis.output_cell.id,
      targetInput: "result",
    });

    const catalog = resultJson(await invoke("list_notebook_actions", {
      cell_type: "analyze",
    })) as { actions: Array<{ operation: string; model: string | null }> };
    expect(catalog.actions.some((action) => action.operation === "analyze_source")).toBe(true);

    const generationCatalog = resultJson(await invoke("list_notebook_actions", {
      cell_type: "generate_video",
    })) as {
      actions: Array<{
        tool: string;
        title: string;
        providerLabel: string;
        defaultPriority?: number;
        inputContract?: { modes: Array<{ id: string }> };
      }>;
    };
    expect(generationCatalog.actions.find((action) =>
      action.tool === DEFAULT_VIDEO_TOOL)).toMatchObject({
      title: "Gemini Omni Video",
      providerLabel: "Kie",
      defaultPriority: 0,
      inputContract: { modes: [{ id: "default" }] },
    });

    const details = resultJson(await invoke("get_notebook_cell_details", {
      notebook_id: notebookId,
      cell_id: analysis.id,
    })) as {
      rawRow: Array<{ column: string }>
      validation: { ok: boolean }
      action: { tool: string | null }
    };
    expect(details.rawRow.map((row) => row.column)).toEqual([
      "notebook_id",
      "cell_id",
      "type",
      "slug",
      "grid_row",
      "grid_column",
      "output_entity_id",
      "prompt",
      "provider",
      "model",
      "operation",
      "tool",
      "inputs_json",
      "output_artifact_id",
    ]);
    expect(details.validation.ok).toBe(true);
    expect(details.action.tool).toBe("openai_responses_analysis");

    const invalid = await invoke("update_notebook_cell", {
      notebook_id: notebookId,
      cell_id: analysis.id,
      cell: { tool: "not-a-real-tool" },
    });
    expect(invalid.isError).toBe(true);

    const generation = resultJson(await invoke("create_notebook_cell", {
      notebook_id: notebookId,
      cell: {
        type: "generate_image",
        slug: "generate-image-01",
        slot: { row: 2, column: 0 },
        prompt: "persisted prompt",
      },
    })) as {
      id: string;
      provider: string;
      model: string;
      operation: string;
      tool: string;
    };
    expect(generation.tool).toBe(DEFAULT_IMAGE_TOOL);

    const preview = resultJson(await invoke("preview_notebook_generation", {
      notebook_id: notebookId,
      cell_id: generation.id,
      draft: {
        prompt: "draft prompt",
        provider: "kie",
        model: "GptImage2TextToImageRequestSchema",
        operation: "text_to_image",
        tool: "generate_kie_gpt_image_2_text_to_image",
      },
    })) as {
      tool: string;
      input: { prompt: string };
    };
    expect(preview).toMatchObject({
      tool: "generate_kie_gpt_image_2_text_to_image",
      input: { prompt: "draft prompt" },
    });
    const afterPreview = resultJson(await invoke("get_notebook", {
      notebook_id: notebookId,
    })) as NotebookDocument;
    expect(afterPreview.cells.find((cell) => cell.id === generation.id))
      .toMatchObject({
        prompt: "persisted prompt",
        tool: DEFAULT_IMAGE_TOOL,
      });

    const videoGeneration = resultJson(await invoke("create_notebook_cell", {
      notebook_id: notebookId,
      cell: {
        type: "generate_video",
        slug: "generate-video-01",
        slot: { row: 3, column: 0 },
        prompt: "A moonlit garden in motion",
      },
    })) as { id: string; tool: string };
    expect(videoGeneration.tool).toBe(DEFAULT_VIDEO_TOOL);
    const videoPreview = resultJson(await invoke("preview_notebook_generation", {
      notebook_id: notebookId,
      cell_id: videoGeneration.id,
    })) as {
      tool: string;
      input: { prompt: string; duration: string };
    };
    expect(videoPreview).toMatchObject({
      tool: DEFAULT_VIDEO_TOOL,
      input: {
        prompt: "A moonlit garden in motion",
        duration: "8",
      },
    });

    const valid = validateCellConfiguration({
      id: analysis.id,
      type: "analyze",
      slug: "analyze-source",
      slot: { row: 0, column: 0 },
      operation: "analyze_source",
      tool: "openai_responses_analysis",
      provider: "openai",
      model: "gpt-5.6-sol",
    }, {
      id: notebookId,
      name: "Main",
      cells: [],
      edges: [],
      createdAt: new Date().toISOString(),
    });
    expect(valid.ok).toBe(true);
  });

  it("normalizes exact legacy Analyze metadata only in read details", () => {
    const legacy = {
      id: "019f0000-0000-7000-8000-000000000001",
      type: "analyze" as const,
      slug: "analyze-source",
      slot: { row: 0, column: 0 },
      prompt: "Segment",
      provider: "kie",
      model: "gemini-3-5-flash",
      operation: "analyze_source",
      tool: "kie_gemini_analysis",
    };
    const document = {
      id: "019f0000-0000-7000-8000-000000000002",
      name: "Main",
      cells: [legacy],
      edges: [],
      createdAt: new Date().toISOString(),
    };
    const details = selectedCellDetails(
      document.id,
      document,
      legacy.id,
    ) as {
      cell: {
        provider: string;
        model: string;
        tool: string;
      };
      resolvedRequest: {
        provider: string;
        model: string;
        tool: string;
      };
    };
    expect(details.cell).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      tool: "openai_responses_analysis",
    });
    expect(details.resolvedRequest).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      tool: "openai_responses_analysis",
    });
    expect(legacy).toMatchObject({
      provider: "kie",
      model: "gemini-3-5-flash",
      tool: "kie_gemini_analysis",
    });
  });

  it("normalizes legacy Analyze metadata in notebook reads without persisting", async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books);
    const byName = new Map(defs.map((def) => [def.name, def]));
    const created = resultJson(await byName.get("create_book")!.handler({
      slug: "legacy-notebook-read",
    })) as { bookId: string };
    const managed = books.get(created.bookId);
    expect(managed.ok).toBe(true);
    if (!managed.ok) return;
    const notebook = managed.value.engine.notebooks.list()[0]!;
    const legacy = managed.value.engine.notebooks.createCell({
      type: "analyze",
      slug: "analyze-source",
      slot: { row: 0, column: 0 },
      prompt: "Segment",
      provider: "kie",
      model: "gemini-3.5-flash",
      operation: "analyze_source",
      tool: "kie_gemini_analysis",
    });
    const written = await managed.value.engine.notebooks.write({
      ...notebook,
      cells: [legacy],
    });
    expect(written.ok).toBe(true);
    const getNotebook = byName.get("get_notebook");
    expect(getNotebook).toBeTruthy();
    if (!getNotebook) return;
    const payload = resultJson(await withBookContext(
      { bookId: created.bookId, engine: managed.value.engine },
      () => getNotebook.handler({
        book_id: created.bookId,
        notebook_id: notebook.id,
      }),
    )) as {
      cells: Array<{
        id: string;
        provider: string;
        model: string;
        tool: string;
      }>;
    };
    expect(payload.cells.find((cell) => cell.id === legacy.id)).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      tool: "openai_responses_analysis",
    });
    const raw = managed.value.engine.notebooks.read(notebook.id);
    expect(raw.ok).toBe(true);
    if (!raw.ok) return;
    expect(raw.value.cells.find((cell) => cell.id === legacy.id)).toMatchObject({
      provider: "kie",
      model: "gemini-3.5-flash",
      tool: "kie_gemini_analysis",
    });
  });
});
