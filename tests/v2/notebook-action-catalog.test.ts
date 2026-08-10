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
    const created = resultJson(await byName.get("create_book")!.handler({ name: "catalog" })) as {
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
        label: "analyze-source",
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
        label: string;
        address: string;
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
      label: "analyze-source",
      address: "@a2",
      slot: { row: 0, column: 1 },
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
        inputContract?: {
          modes: Array<{
            id: string;
            slots: Array<{
              field: string;
              kind: string;
              min: number;
              max: number | null;
            }>;
          }>;
        };
        controls?: Array<{
          name: string;
          defaultValue?: string | number | boolean;
          options?: Array<string | number | boolean>;
        }>;
      }>;
    };
    const geminiCatalogAction = generationCatalog.actions.find((action) =>
      action.tool === DEFAULT_VIDEO_TOOL);
    expect(geminiCatalogAction).toMatchObject({
      title: "Gemini Omni Video",
      providerLabel: "Kie",
      defaultPriority: 0,
    });
    expect(geminiCatalogAction?.inputContract?.modes.map((mode) => mode.id))
      .toEqual(["t2v", "r2v", "v2v"]);
    expect(geminiCatalogAction?.controls?.find((control) =>
      control.name === "aspect_ratio")).toMatchObject({
      options: ["16:9", "9:16"],
    });
    expect(geminiCatalogAction?.controls?.find((control) =>
      control.name === "duration")).toMatchObject({
      defaultValue: "8",
      options: ["4", "6", "8", "10"],
    });
    const seedance25Action = generationCatalog.actions.find((action) =>
      action.tool === "generate_kie_seedance_2_5_video");
    expect(seedance25Action).toMatchObject({
      title: "Seedance 2.5",
      providerLabel: "Kie",
    });
    expect(seedance25Action?.inputContract?.modes.map((mode) => mode.id))
      .toEqual(["t2v", "i2v", "r2v"]);
    expect(seedance25Action?.inputContract?.modes.find((mode) =>
      mode.id === "r2v")?.slots.map((slot) => ({
      field: slot.field,
      max: slot.max,
    }))).toEqual([
      { field: "image_refs", max: 30 },
      { field: "video_refs", max: 10 },
      { field: "audio_refs", max: 10 },
      { field: "replace_audio_with", max: 1 },
    ]);
    expect(seedance25Action?.controls?.map((control) => control.name)).toEqual([
      "return_last_frame",
      "generate_audio",
      "resolution",
      "aspect_ratio",
      "duration",
      "output_format",
      "web_search",
      "nsfw_checker",
    ]);
    expect(seedance25Action?.controls?.find((control) =>
      control.name === "duration")).toMatchObject({
      defaultValue: "5",
      options: ["-1", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30"],
    });
    expect(seedance25Action?.controls?.find((control) =>
      control.name === "output_format")).toMatchObject({
      defaultValue: "mp4",
      options: ["mp4", "mov"],
    });
    const motionControlAction = generationCatalog.actions.find((action) =>
      action.tool === "generate_kie_kling_3_0_motion_control");
    expect(motionControlAction).toMatchObject({
      title: "Kling 3.0 Motion Control",
      providerLabel: "Kie",
    });
    expect(motionControlAction?.inputContract?.modes).toEqual([{
      id: "default",
      slots: [
        {
          field: "character_image_refs",
          kind: "image",
          min: 1,
          max: 1,
          targets: ["image"],
        },
        {
          field: "motion_video_refs",
          kind: "video",
          min: 1,
          max: 1,
          targets: ["video"],
        },
      ],
      requiredGroups: [],
    }]);
    expect(motionControlAction?.controls?.find((control) =>
      control.name === "mode")).toMatchObject({
      options: ["720p", "1080p"],
    });
    const fullCatalog = resultJson(await invoke("list_notebook_actions", {})) as {
      actions: Array<{
        kind: string;
        tool?: string;
        controls?: Array<{ name: string; required?: boolean }>;
      }>;
    };
    expect(fullCatalog.actions
      .filter((action) => action.kind === "generation")
      .every((action) => Array.isArray(action.controls))).toBe(true);
    expect(fullCatalog.actions.find((action) =>
      action.tool === "generate_elevenlabs_text_to_audio")?.controls?.find(
      (control) => control.name === "voice_id",
    )).toMatchObject({ required: true });

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
      "label",
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
        label: "generate-image-01",
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
      payload: { input: { prompt: string } };
      estimate: { currency: string; usd: number };
    };
    expect(preview).toMatchObject({
      tool: "generate_kie_gpt_image_2_text_to_image",
      payload: {
        model: "gpt-image-2-text-to-image",
        input: { prompt: "draft prompt" },
      },
      estimate: { currency: "USD", usd: expect.any(Number) },
    });
    const afterPreview = resultJson(await invoke("get_notebook", {
      notebook_id: notebookId,
    })) as NotebookDocument;
    expect(afterPreview.cells.find((cell) => cell.id === generation.id))
      .toMatchObject({
        prompt: "persisted prompt",
        tool: DEFAULT_IMAGE_TOOL,
      });

    const pendingCellId = "01900000-0000-7000-8000-000000000021";
    const pendingPreview = resultJson(await invoke("preview_notebook_generation", {
      notebook_id: notebookId,
      cell_id: pendingCellId,
      draft: {
        type: "generate_image",
        label: "generate-image-pending",
        slot: { row: 2, column: 1 },
        prompt: "pending draft prompt",
        provider: "kie",
        model: "GptImage2TextToImageRequestSchema",
        operation: "text_to_image",
        tool: "generate_kie_gpt_image_2_text_to_image",
      },
      connections: [],
    })) as {
      tool: string;
      payload: { input: { prompt: string } };
      estimate: { usd: number };
    };
    expect(pendingPreview).toMatchObject({
      tool: "generate_kie_gpt_image_2_text_to_image",
      payload: { input: { prompt: "pending draft prompt" } },
      estimate: { usd: expect.any(Number) },
    });
    const afterPendingPreview = resultJson(await invoke("get_notebook", {
      notebook_id: notebookId,
    })) as NotebookDocument;
    expect(afterPendingPreview.cells.some((cell) => cell.id === pendingCellId))
      .toBe(false);

    const videoGeneration = resultJson(await invoke("create_notebook_cell", {
      notebook_id: notebookId,
      cell: {
        type: "generate_video",
        label: "generate-video-01",
        slot: { row: 3, column: 0 },
        prompt: "A moonlit garden in motion",
      },
    })) as { id: string; tool: string };
    expect(videoGeneration.tool).toBe(DEFAULT_VIDEO_TOOL);
    const videoPreview = resultJson(await invoke("preview_notebook_generation", {
      notebook_id: notebookId,
      cell_id: videoGeneration.id,
      draft: {
        prompt: "A moonlit garden in motion",
        provider: "kie",
        model: "GeminiOmniVideoRequestSchema",
        operation: "image_to_video",
        tool: DEFAULT_VIDEO_TOOL,
        inputs: {
          generationMode: "t2v",
          generationSettings: {
            duration: "6",
            aspect_ratio: "9:16",
          },
        },
      },
    })) as {
      tool: string;
      provider_path: string;
      payload: {
        input: { prompt: string; duration: string; aspect_ratio: string };
      };
    };
    expect(videoPreview).toMatchObject({
      tool: DEFAULT_VIDEO_TOOL,
      provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })",
      payload: {
        model: "gemini-omni-video",
        input: {
          prompt: "A moonlit garden in motion",
          duration: "6",
          aspect_ratio: "9:16",
        },
      },
    });
    const incompatibleModePreview = await invoke("preview_notebook_generation", {
      notebook_id: notebookId,
      cell_id: videoGeneration.id,
      draft: {
        prompt: "A moonlit garden in motion",
        provider: "kie",
        model: "GeminiOmniVideoRequestSchema",
        operation: "image_to_video",
        tool: DEFAULT_VIDEO_TOOL,
        inputs: {
          generationMode: "r2v",
          generationSettings: { duration: "8" },
        },
      },
    });
    expect(incompatibleModePreview.isError).toBe(true);
    expect(incompatibleModePreview.content[0]?.text).toContain(
      "does not accept the current media inputs",
    );

    const audioGeneration = resultJson(await invoke("create_notebook_cell", {
      notebook_id: notebookId,
      cell: {
        type: "generate_audio",
        label: "generate-audio-01",
        slot: { row: 5, column: 0 },
        prompt: "Welcome to the moon garden",
      },
    })) as { id: string; provider: string; model: string; operation: string; tool: string };
    const audioPreview = resultJson(await invoke("preview_notebook_generation", {
      notebook_id: notebookId,
      cell_id: audioGeneration.id,
      draft: {
        prompt: "Welcome to the moon garden",
        provider: audioGeneration.provider,
        model: audioGeneration.model,
        operation: audioGeneration.operation,
        tool: audioGeneration.tool,
        inputs: {
          generationMode: "default",
          generationSettings: { voice_id: "voice-test" },
        },
      },
    })) as { payload: { text: string; voice_id: string } };
    expect(audioPreview.payload).toMatchObject({
      text: "Welcome to the moon garden",
      voice_id: "voice-test",
    });

    const valid = validateCellConfiguration({
      id: analysis.id,
      type: "analyze",
      label: "analyze-source",
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
      label: "analyze-source",
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
      name: "legacy-notebook-read",
    })) as { bookId: string };
    const managed = books.get(created.bookId);
    expect(managed.ok).toBe(true);
    if (!managed.ok) return;
    const notebook = managed.value.engine.notebooks.list()[0]!;
    const legacy = managed.value.engine.notebooks.createCell({
      type: "analyze",
      label: "analyze-source",
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

  it("summarizes cell generations from generation rows, not version guesswork", async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books);
    const byName = new Map(defs.map((def) => [def.name, def]));
    const created = resultJson(await byName.get("create_book")!.handler({
      name: "generations-summary",
    })) as { bookId: string };
    const managed = books.get(created.bookId);
    expect(managed.ok).toBe(true);
    if (!managed.ok) return;
    const engine = managed.value.engine;

    const invoke = async (name: string, args: Record<string, unknown>) => {
      const def = byName.get(name);
      if (!def) throw new Error(`Missing ${name}`);
      return await withBookContext(
        { bookId: created.bookId, engine },
        () => def.handler({ book_id: created.bookId, ...args }),
      );
    };

    const notebookId = (resultJson(await invoke("list_notebooks", {})) as Array<{ id: string }>)[0]!.id;
    const cell = resultJson(await invoke("create_notebook_cell", {
      notebook_id: notebookId,
      cell: {
        type: "generate_image",
        label: "generate-image-01",
        slot: { row: 0, column: 0 },
        prompt: "a cat dances",
      },
    })) as { id: string };

    const output = await engine.artifacts.create("image", "gen-out");
    expect(output.ok).toBe(true);
    if (!output.ok) return;

    const first = await engine.generations.record({
      notebookId,
      cellId: cell.id,
      tool: "generate_seedream_image",
      runId: "run-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await engine.generations.record({
      notebookId,
      cellId: cell.id,
      tool: "generate_seedream_image",
      runId: "run-2",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const completed = await engine.generations.update(second.value.generationId, {
      status: "completed",
      outputArtifactId: output.value.artifactId,
    });
    expect(completed.ok).toBe(true);

    const details = resultJson(await invoke("get_notebook_cell_details", {
      notebook_id: notebookId,
      cell_id: cell.id,
    })) as {
      generations: {
        count: number;
        latestStatus: string | null;
        artifactIds: string[];
      };
    };
    expect(details.generations.count).toBe(2);
    expect(details.generations.latestStatus).toBe("completed");
    expect(details.generations.artifactIds).toEqual([output.value.artifactId]);

    const prompt = resultJson(await invoke("create_notebook_cell", {
      notebook_id: notebookId,
      cell: {
        type: "prompt",
        label: "prompt-01",
        slot: { row: 0, column: 1 },
        prompt: "a cat dances",
      },
    })) as { id: string };
    const emptyDetails = resultJson(await invoke("get_notebook_cell_details", {
      notebook_id: notebookId,
      cell_id: prompt.id,
    })) as {
      generations: { count: number; latestStatus: string | null };
    };
    expect(emptyDetails.generations.count).toBe(0);
    expect(emptyDetails.generations.latestStatus).toBeNull();
  });
});
