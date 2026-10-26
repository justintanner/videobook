import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NotebookDocument } from "videobook-engine";
import { BookManager } from "../../server/src/book-manager.js";
import { scopedBookEngine, withBookContext } from "../../server/src/book-context.js";
import {
  DEFAULT_ANIMATION_MODEL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
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

  it("exposes deterministic analysis and Videobook generation defaults", () => {
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
    expect(actions.some((action) => action.model === DEFAULT_ANIMATION_MODEL)).toBe(true);
    expect(actions.find((action) =>
      action.kind === "generation"
      && action.cellTypes.includes("generate_video")
      && action.isDefault)?.model).toBe(DEFAULT_VIDEO_MODEL);
    expect(actions.find((action) =>
      action.kind === "generation"
      && action.cellTypes.includes("generate_image")
      && action.isDefault)?.model).toBe(DEFAULT_IMAGE_MODEL);
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
    expect(actions.find((action) => action.operation === "split_ranges"))
      .toMatchObject({
        cellTypes: ["split_video"],
        requiredInputs: ["video"],
      });
    expect(actions.some((action) =>
      action.operation === "extract_frame")).toBe(false);
    expect(actions.some((action) =>
      action.operation === "extract_audio")).toBe(false);
    expect(actions.some((action) =>
      action.cellTypes.some((type) =>
        type === "audio"
        || type === "image"
        || type === "video"
        || type === "character"))).toBe(false);
    expect(actions
      .filter((action) => action.kind === "generation"
        && (action.model === "fal:alibaba/qwen-image-3/edit" || action.model === "kie:qwen3/image-to-image"))
      .map((action) => ({
        tool: action.tool,
        provider: action.provider,
        providerLabel: action.providerLabel,
        model: action.model,
      }))).toEqual([
      {
        tool: "generate_image",
        provider: "fal",
        providerLabel: "Fal",
        model: "fal:alibaba/qwen-image-3/edit",
      },
      {
        tool: "generate_image",
        provider: "kie",
        providerLabel: "Kie",
        model: "kie:qwen3/image-to-image",
      },
    ]);
  });

  it("previews Kie Qwen 3 edits with provider-valid local image URLs", async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books);
    const byName = new Map(defs.map((def) => [def.name, def]));
    const created = resultJson(await byName.get("create_book")!.handler({
      name: "qwen-3-preview",
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

    const notebookId = (resultJson(await invoke("list_notebooks", {})) as Array<{
      id: string;
    }>)[0]!.id;
    const artifacts = await Promise.all([
      engine.artifacts.create("image", "qwen-source-1"),
      engine.artifacts.create("image", "qwen-source-2"),
      engine.artifacts.create("image", "qwen-source-3"),
    ]);
    expect(artifacts.every((artifact) => artifact.ok)).toBe(true);
    const artifactIds = artifacts.flatMap((artifact) =>
      artifact.ok ? [artifact.value.artifactId] : []);
    if (artifactIds.length !== 3) return;
    const notebook = engine.notebooks.read(notebookId);
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    const sources = artifactIds.map((artifactId, index) =>
      engine.notebooks.createCell({
        type: "image",
        label: `qwen-source-${index + 1}`,
        slot: { row: 0, column: index },
        outputArtifactId: artifactId,
      }));
    const generation = engine.notebooks.createCell({
      type: "generate_image",
      label: "qwen-edit",
      slot: { row: 1, column: 0 },
      prompt: "combine @image1 with the other references",
      provider: "fal",
      model: "fal:alibaba/qwen-image-3/edit",
      operation: "edit_image",
      tool: "generate_image",
      inputs: { generationMode: "default" },
    });
    const written = await engine.notebooks.write({
      ...notebook.value,
      cells: [...notebook.value.cells, ...sources, generation],
      edges: sources.map((source, index) =>
        engine.notebooks.createEdge({
          source: source.id,
          target: generation.id,
          targetInput: index === 0 ? "image" : `image_${index + 1}`,
        })),
    });
    expect(written.ok).toBe(true);

    const preview = resultJson(await invoke("preview_notebook_generation", {
      notebook_id: notebookId,
      cell_id: generation.id,
      draft: {
        prompt: generation.prompt,
        provider: "kie",
        model: "kie:qwen3/image-to-image",
        operation: "edit_image",
        tool: "generate_image",
        inputs: {
          generationMode: "default",
          generationSettings: {
            image_size: "9:16",
            prompt_extend: false,
            nsfw_checker: false,
            resolution: "2K",
          },
        },
      },
    })) as {
      tool: string;
      provider: string;
      model: string;
      payload: {
        model: string;
        input: {
          prompt: string;
          image_urls: string[];
          image_size: string;
          resolution: string;
        };
      };
      mentions: {
        url_placeholders: Array<{ path: string; reference: string; url: string }>;
      };
    };
    const expectedUrls = artifactIds.map((artifactId) =>
      `http://url.resolved.later.for/${artifactId}`);
    expect(preview).toMatchObject({
      tool: "generate_image",
      provider: "kie",
      model: "kie:qwen3/image-to-image",
      payload: {
        model: "qwen3/image-to-image",
        input: {
          prompt: "combine reference image 1 with the other references",
          image_urls: expectedUrls,
          image_size: "9:16",
          resolution: "2K",
        },
      },
    });
    expect(preview.mentions.url_placeholders).toEqual(
      expectedUrls.map((url, index) => ({
        path: `input.image_urls[${index}]`,
        reference: `@${artifactIds[index]}`,
        url,
      })),
    );
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
        model: string;
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
      action.model === "kie:gemini-omni-video");
    expect(geminiCatalogAction).toMatchObject({
      tool: "generate_video",
      title: "Gemini Omni",
      providerLabel: "Kie",
    });
    expect(geminiCatalogAction?.inputContract?.modes.map((mode) => mode.id))
      .toEqual(["i2v", "v2v"]);
    expect(geminiCatalogAction?.controls?.find((control) =>
      control.name === "aspect_ratio")).toMatchObject({
      options: ["16:9", "9:16"],
    });
    expect(geminiCatalogAction?.controls?.find((control) =>
      control.name === "duration")).toMatchObject({
      options: ["4", "6", "8", "10"],
    });
    const seedance25Action = generationCatalog.actions.find((action) =>
      action.model === "kie:bytedance/seedance-2-5");
    expect(seedance25Action).toMatchObject({
      tool: "generate_video",
      title: "Seedance 2.5",
      providerLabel: "Kie",
      defaultPriority: 0,
    });
    expect(seedance25Action?.inputContract?.modes.map((mode) => mode.id))
      .toEqual(["t2v", "i2v", "r2v", "v2v"]);
    expect(seedance25Action?.inputContract?.modes.find((mode) =>
      mode.id === "r2v")?.slots.map((slot) => ({
      field: slot.field,
      max: slot.max,
    }))).toEqual([
      { field: "image", max: 30 },
      { field: "video", max: 10 },
      { field: "audio", max: 10 },
      { field: "replace_audio", max: 1 },
    ]);
    expect(seedance25Action?.controls?.map((control) => control.name)).toEqual([
      "return_last_frame",
      "generate_audio",
      "resolution",
      "aspect_ratio",
      "duration",
      "output_format",
      "web_search",
      "draft",
      "nsfw_checker",
    ]);
    const seedanceDuration = seedance25Action?.controls?.find((control) =>
      control.name === "duration");
    expect(seedanceDuration).toMatchObject({ defaultValue: 12 });
    expect(seedanceDuration?.options ?? [12]).toContain(12);
    expect(seedance25Action?.controls?.find((control) =>
      control.name === "output_format")).toMatchObject({
      defaultValue: "mp4",
      options: ["mp4", "mov"],
    });
    expect(seedance25Action?.controls?.find((control) =>
      control.name === "resolution")).toMatchObject({
      defaultValue: "1080p",
      options: ["480p", "720p", "1080p"],
    });
    const wan30PrimeAction = generationCatalog.actions.find((action) =>
      action.model === "kie:wan/3-0-video-prime");
    expect(wan30PrimeAction).toMatchObject({
      tool: "generate_video",
      title: "Wan 3.0 Prime",
      providerLabel: "Kie",
    });
    expect(wan30PrimeAction?.inputContract?.modes.map((mode) => mode.id))
      .toEqual(["t2v", "i2v", "r2v"]);
    expect(wan30PrimeAction?.inputContract?.modes.find((mode) =>
      mode.id === "i2v")?.slots.map((slot) => slot.field)).toEqual([
      "first_frame",
      "last_frame",
      "replace_audio",
    ]);
    const motionControlAction = generationCatalog.actions.find((action) =>
      action.model === "kie:kling-3.0/motion-control");
    expect(motionControlAction).toMatchObject({
      tool: "generate_video",
      title: "Kling 3.0 Motion",
      providerLabel: "Kie",
    });
    const omniTransformationAction = generationCatalog.actions.find((action) =>
      action.model === "kie:kling-3.0-omni/transformation");
    expect(omniTransformationAction).toMatchObject({
      tool: "generate_video",
      title: "Kling 3.0 Omni Transformation",
      providerLabel: "Kie",
    });
    expect(omniTransformationAction?.inputContract?.modes.map((mode) => mode.id))
      .toEqual(["v2v", "v2v_refs"]);
    expect(omniTransformationAction?.inputContract?.modes[0]?.slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "video",
          kind: "video",
          min: 1,
          max: 1,
          targets: ["video"],
        }),
      ]),
    );
    expect(omniTransformationAction?.controls?.find((control) =>
      control.name === "resolution")).toMatchObject({
      options: ["720p", "1080p", "4k"],
    });
    const fullCatalog = resultJson(await invoke("list_notebook_actions", {})) as {
      actions: Array<{
        kind: string;
        tool?: string;
        provider?: string;
        providerLabel?: string;
        model?: string;
        controls?: Array<{ name: string; required?: boolean }>;
      }>;
    };
    expect(fullCatalog.actions
      .filter((action) => action.kind === "generation" && action.tool?.startsWith("generate_"))
      .every((action) => Array.isArray(action.controls))).toBe(true);
    expect(fullCatalog.actions.find((action) =>
      action.model === "elevenlabs:text-to-speech")?.controls?.find(
      (control) => control.name === "voice_id",
    )).toMatchObject({ required: true });
    const qwen3Actions = fullCatalog.actions.filter((action) =>
      action.kind === "generation"
      && (action.model === "fal:alibaba/qwen-image-3/edit" || action.model === "kie:qwen3/image-to-image"));
    expect(qwen3Actions.map((action) => ({
      tool: action.tool,
      provider: action.provider,
      providerLabel: action.providerLabel,
      model: action.model,
    }))).toEqual([
      {
        tool: "generate_image",
        provider: "fal",
        providerLabel: "Fal",
        model: "fal:alibaba/qwen-image-3/edit",
      },
      {
        tool: "generate_image",
        provider: "kie",
        providerLabel: "Kie",
        model: "kie:qwen3/image-to-image",
      },
    ]);
    expect(qwen3Actions.find((action) => action.provider === "fal")
      ?.controls?.map((control) => control.name)).toContain("enable_safety_checker");
    expect(qwen3Actions.find((action) => action.provider === "kie")
      ?.controls?.map((control) => control.name)).toContain("nsfw_checker");

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
    expect(generation.tool).toBe("generate_image");
    expect(generation.model).toBe(DEFAULT_IMAGE_MODEL);
    expect(DEFAULT_IMAGE_MODEL).toBe("kie:nano-banana-2-1");
    expect(resultJson(await invoke("preview_notebook_generation", {
      notebook_id: notebookId,
      cell_id: generation.id,
    }))).toMatchObject({
      tool: "generate_image",
      model: DEFAULT_IMAGE_MODEL,
      payload: {
        model: "nano-banana-2-1",
        input: {
          prompt: "persisted prompt",
          resolution: "2K",
          aspect_ratio: "9:16",
          output_format: "jpg",
        },
      },
    });

    const preview = resultJson(await invoke("preview_notebook_generation", {
      notebook_id: notebookId,
      cell_id: generation.id,
      draft: {
        prompt: "draft prompt",
        provider: "kie",
        model: "kie:gpt-image-2-5-flare-text-to-image",
        operation: "text_to_image",
        tool: "generate_image",
      },
    })) as {
      tool: string;
      payload: { input: { prompt: string } };
      estimate: { currency: string; usd: number };
    };
    expect(preview).toMatchObject({
      tool: "generate_image",
      model: "kie:gpt-image-2-5-flare-text-to-image",
      payload: {
        model: "gpt-image-2-5-flare-text-to-image",
        input: { prompt: "draft prompt", resolution: "2K" },
      },
      estimate: { currency: "USD", usd: expect.any(Number) },
    });
    const afterPreview = resultJson(await invoke("get_notebook", {
      notebook_id: notebookId,
    })) as NotebookDocument;
    expect(afterPreview.cells.find((cell) => cell.id === generation.id))
      .toMatchObject({
        prompt: "persisted prompt",
        tool: "generate_image",
        model: DEFAULT_IMAGE_MODEL,
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
        model: "kie:gpt-image-2-5-flare-text-to-image",
        operation: "text_to_image",
        tool: "generate_image",
      },
      connections: [],
    })) as {
      tool: string;
      payload: { input: { prompt: string } };
      estimate: { usd: number };
    };
    expect(pendingPreview).toMatchObject({
      tool: "generate_image",
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
        slot: { row: 4, column: 0 },
        prompt: "A moonlit garden in motion",
      },
    })) as { id: string; tool: string; model: string };
    expect(videoGeneration.tool).toBe("generate_video");
    expect(videoGeneration.model).toBe(DEFAULT_VIDEO_MODEL);
    const videoPreview = resultJson(await invoke("preview_notebook_generation", {
      notebook_id: notebookId,
      cell_id: videoGeneration.id,
      draft: {
        prompt: "A moonlit garden in motion",
        provider: "kie",
        model: DEFAULT_VIDEO_MODEL,
        operation: "text_to_video",
        tool: "generate_video",
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
      tool: "generate_video",
      model: DEFAULT_VIDEO_MODEL,
      provider_path: "kie.post.api.v1.jobs.createTask(request, { otp })",
      payload: {
        model: "bytedance/seedance-2-5",
        input: {
          prompt: "A moonlit garden in motion",
          duration: 6,
          aspect_ratio: "9:16",
          resolution: "1080p",
          generate_audio: true,
          output_format: "mp4",
        },
      },
    });
    const incompatibleModePreview = await invoke("preview_notebook_generation", {
      notebook_id: notebookId,
      cell_id: videoGeneration.id,
      draft: {
        prompt: "A moonlit garden in motion",
        provider: "kie",
        model: DEFAULT_VIDEO_MODEL,
        operation: "text_to_video",
        tool: "generate_video",
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
        slot: { row: 6, column: 0 },
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
        slot: { row: 1, column: 0 },
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
