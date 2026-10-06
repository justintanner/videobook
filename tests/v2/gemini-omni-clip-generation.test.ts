import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NotebookCell, NotebookEdge } from "videobook-engine";
import { BookManager } from "../../server/src/book-manager.js";
import { scopedBookEngine, withBookContext } from "../../server/src/book-context.js";
import {
  GEMINI_OMNI_CLIP_WINDOW_ERROR,
} from "../../server/src/gemini-omni-clip.js";
import { generateGeminiOmniVideoDef } from "../../server/src/tools/generate-gemini-omni-video.js";
import type { ToolDef } from "../../server/src/tools/tool-def.js";
import { videobookDomainDefs } from "../../server/src/tools/videobook-domain.js";
import { NotebookCellInspector } from "../../src/components/videobook/NotebookCellInspector";
import {
  generationSettingsError,
  type NotebookGenerationAction,
} from "../../src/videobook/notebook-generation-actions";

const CLIP_REQUIRED = "Video clip start: Required; Video clip ends: Required";

const geminiAction: NotebookGenerationAction = {
  id: "generation.generate_kie_gemini_omni_video",
  cellTypes: ["generate_video"],
  provider: "kie",
  providerLabel: "Kie",
  model: "gemini-omni-video",
  operation: "image_to_video",
  tool: "generate_kie_gemini_omni_video",
  title: "Gemini Omni Video",
  isDefault: true,
  defaultPriority: 0,
  inputContract: {
    modes: [
      { id: "t2v", slots: [], requiredGroups: [] },
      {
        id: "r2v",
        slots: [{
          field: "image_refs",
          kind: "image",
          targets: ["image"],
          min: 0,
          max: 7,
        }],
        requiredGroups: [["image_refs"]],
      },
      {
        id: "v2v",
        slots: [
          {
            field: "image_refs",
            kind: "image",
            targets: ["image"],
            min: 0,
            max: 7,
          },
          {
            field: "video_ref",
            kind: "video",
            targets: ["video"],
            min: 0,
            max: 1,
          },
        ],
        requiredGroups: [["video_ref"]],
      },
    ],
  },
  controls: [
    {
      name: "video_clip_start",
      label: "Video clip start",
      kind: "number",
      valueType: "number",
      required: false,
      minimum: 0,
      options: [],
      description: "Reference clip start time in seconds",
    },
    {
      name: "video_clip_ends",
      label: "Video clip ends",
      kind: "number",
      valueType: "number",
      required: false,
      minimum: 0,
      options: [],
      description: "Reference clip end time in seconds",
    },
  ],
};

function resultText(result: Awaited<ReturnType<ToolDef["handler"]>>): string {
  return result.content[0]?.text ?? "";
}

function runButton(html: string): string {
  const match = html.match(/<button[^>]*class="inspector-run-action"[^>]*>[\s\S]*?<\/button>/);
  if (!match) throw new Error("Generate button is missing");
  return match[0];
}

describe("Gemini Omni clip window", () => {
  it("stops a connected video on the form until the clip is under 10 seconds", () => {
    const blank = generationSettingsError(geminiAction.controls, {}, {
      tool: geminiAction.tool,
      videoConnected: true,
    });
    const tooLong = generationSettingsError(geminiAction.controls, {
      video_clip_start: 0,
      video_clip_ends: 10,
    }, {
      tool: geminiAction.tool,
      videoConnected: true,
    });
    const reversed = generationSettingsError(geminiAction.controls, {
      video_clip_start: 4,
      video_clip_ends: 4,
    }, {
      tool: geminiAction.tool,
      videoConnected: true,
    });
    const open = generationSettingsError(geminiAction.controls, {
      video_clip_start: 0,
      video_clip_ends: 9.97,
    }, {
      tool: geminiAction.tool,
      videoConnected: true,
    });
    const imageOnly = generationSettingsError(geminiAction.controls, {}, {
      tool: geminiAction.tool,
      videoConnected: false,
    });
    expect(blank).toBe(CLIP_REQUIRED);
    expect(tooLong).toBe(GEMINI_OMNI_CLIP_WINDOW_ERROR);
    expect(reversed).toBe(GEMINI_OMNI_CLIP_WINDOW_ERROR);
    expect(open).toBeNull();
    expect(imageOnly).toBeNull();
  });

  it("disables Generate and shows the requirement before a video run", () => {
    const generation: NotebookCell = {
      id: "01900000-0000-7000-8000-0000000000b1",
      type: "generate_video",
      slot: { row: 1, column: 0 },
      prompt: "Animate subject. Match motion, timing.",
      provider: "kie",
      model: "gemini-omni-video",
      operation: "image_to_video",
      tool: "generate_kie_gemini_omni_video",
    };
    const video: NotebookCell = {
      id: "01900000-0000-7000-8000-0000000000a1",
      type: "video",
      slot: { row: 0, column: 0 },
      outputArtifactId: "01900000-0000-7000-8000-0000000000aa",
    };
    const edge: NotebookEdge = {
      id: "01900000-0000-7000-8000-0000000000e1",
      source: video.id,
      target: generation.id,
      targetInput: "video",
    };
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      bookId: "01900000-0000-7000-8000-000000000002",
      notebookId: "01900000-0000-7000-8000-000000000003",
      cell: generation,
      cells: [generation, video],
      edges: [edge],
      asset: undefined,
      status: "ready",
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      generationActions: [geminiAction],
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }));
    expect(html).toContain(CLIP_REQUIRED);
    expect(runButton(html)).toContain("disabled");
  });

  it("keeps Generate available once the clip window is valid", () => {
    const generation: NotebookCell = {
      id: "01900000-0000-7000-8000-0000000000b1",
      type: "generate_video",
      slot: { row: 1, column: 0 },
      prompt: "Animate subject. Match motion, timing.",
      provider: "kie",
      model: "gemini-omni-video",
      operation: "image_to_video",
      tool: "generate_kie_gemini_omni_video",
      inputs: {
        generationMode: "v2v",
        generationSettings: { video_clip_start: 0, video_clip_ends: 9.97 },
      },
    };
    const video: NotebookCell = {
      id: "01900000-0000-7000-8000-0000000000a1",
      type: "video",
      slot: { row: 0, column: 0 },
      outputArtifactId: "01900000-0000-7000-8000-0000000000aa",
    };
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      bookId: "01900000-0000-7000-8000-000000000002",
      notebookId: "01900000-0000-7000-8000-000000000003",
      cell: generation,
      cells: [generation, video],
      edges: [{
        id: "01900000-0000-7000-8000-0000000000e1",
        source: video.id,
        target: generation.id,
        targetInput: "video",
      }],
      asset: undefined,
      status: "ready",
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      generationActions: [geminiAction],
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }));
    expect(html).not.toContain(CLIP_REQUIRED);
    expect(html).not.toContain(GEMINI_OMNI_CLIP_WINDOW_ERROR);
    expect(runButton(html)).not.toContain("disabled");
  });

  it("rejects a direct tool call before creating a video", async () => {
    const previous = process.env.KIE_API_KEY;
    process.env.KIE_API_KEY = "local-clip-key";
    try {
      const result = await generateGeminiOmniVideoDef({} as never).handler({
        book_id: "book",
        prompt: "Animate subject",
        video_ref: "@video",
        duration: "8",
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toBe(CLIP_REQUIRED);
    } finally {
      if (previous === undefined) delete process.env.KIE_API_KEY;
      else process.env.KIE_API_KEY = previous;
    }
  });

  describe("preview and plan", () => {
    let rootDir: string;
    let books: BookManager;

    beforeEach(async () => {
      rootDir = await mkdtemp(join(tmpdir(), "videobook-gemini-omni-clip-"));
      books = new BookManager({
        libraryDir: join(rootDir, "books"),
        objectPrefix: "test-objects",
      });
      await books.ready();
    });

    afterEach(async () => {
      await books.close();
      await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });

    async function setup(options: { video: boolean }) {
      const defs = videobookDomainDefs(scopedBookEngine, books);
      const byName = new Map(defs.map((def) => [def.name, def]));
      const created = JSON.parse(resultText(await byName.get("create_book")!.handler({
        name: "gemini-omni-clip",
      }))) as { bookId: string };
      const managed = books.get(created.bookId);
      if (!managed.ok) throw new Error(managed.error.message);
      const engine = managed.value.engine;
      const invoke = (name: string, args: Record<string, unknown>) => {
        const def = byName.get(name);
        if (!def) throw new Error(`Missing ${name}`);
        return withBookContext(
          { bookId: created.bookId, engine },
          () => def.handler({ book_id: created.bookId, ...args }),
        );
      };
      const notebookId = (JSON.parse(resultText(await invoke("list_notebooks", {}))) as Array<{
        id: string;
      }>)[0]!.id;
      const source = await engine.artifacts.create(
        options.video ? "video" : "image",
        options.video ? "motion" : "subject",
      );
      if (!source.ok) throw new Error(source.error.message);
      const notebook = engine.notebooks.read(notebookId);
      if (!notebook.ok) throw new Error(notebook.error.message);
      const media = engine.notebooks.createCell({
        type: options.video ? "video" : "image",
        slot: { row: 0, column: 0 },
        outputArtifactId: source.value.artifactId,
      });
      const generation = engine.notebooks.createCell({
        type: "generate_video",
        slot: { row: 1, column: 0 },
        prompt: "Animate subject. Match motion, timing.",
        provider: "kie",
        model: "gemini-omni-video",
        operation: "image_to_video",
        tool: "generate_kie_gemini_omni_video",
      });
      const written = await engine.notebooks.write({
        ...notebook.value,
        cells: [...notebook.value.cells, media, generation],
        edges: [engine.notebooks.createEdge({
          source: media.id,
          target: generation.id,
          targetInput: options.video ? "video" : "image",
        })],
      });
      if (!written.ok) throw new Error(written.error.message);
      const cellIds = () => {
        const current = engine.notebooks.read(notebookId);
        if (!current.ok) throw new Error(current.error.message);
        return current.value.cells.map((cell) => cell.id).sort();
      };
      return {
        invoke,
        notebookId,
        generationId: generation.id,
        cellIds,
      };
    }

    function preview(
      ready: Awaited<ReturnType<typeof setup>>,
      settings: Record<string, unknown>,
      generationMode: string,
    ) {
      return ready.invoke("preview_notebook_generation", {
        notebook_id: ready.notebookId,
        cell_id: ready.generationId,
        draft: {
          prompt: "Animate subject. Match motion, timing.",
          provider: "kie",
          model: "gemini-omni-video",
          operation: "image_to_video",
          tool: "generate_kie_gemini_omni_video",
          inputs: {
            generationMode,
            generationSettings: settings,
          },
        },
      });
    }

    it("rejects a missing clip window before a generation plan can allocate output", async () => {
      const ready = await setup({ video: true });
      const before = ready.cellIds();
      const previewResult = await preview(ready, {}, "v2v");
      expect(previewResult.isError).toBe(true);
      expect(resultText(previewResult)).toBe(CLIP_REQUIRED);
      const plan = await ready.invoke("plan_notebook_generation", {
        notebook_id: ready.notebookId,
        cell_id: ready.generationId,
        source_surface: "ui",
        actor: "tester",
        timeline_start_frame: 0,
      });
      expect(plan.isError).toBe(true);
      expect(resultText(plan)).toBe(CLIP_REQUIRED);
      expect(ready.cellIds()).toEqual(before);
    });

    it("rejects a clip that is not shorter than 10 seconds", async () => {
      const ready = await setup({ video: true });
      const result = await preview(ready, {
        video_clip_start: 0,
        video_clip_ends: 10,
      }, "v2v");
      expect(result.isError).toBe(true);
      expect(resultText(result)).toBe(GEMINI_OMNI_CLIP_WINDOW_ERROR);
    });

    it("previews a clip window that stays under 10 seconds", async () => {
      const ready = await setup({ video: true });
      const before = ready.cellIds();
      const result = await preview(ready, {
        video_clip_start: 0,
        video_clip_ends: 9.97,
      }, "v2v");
      expect(result.isError, resultText(result)).toBeUndefined();
      const payload = JSON.parse(resultText(result)) as {
        payload: { input?: { video_list?: Array<{ start: number; ends: number }> } };
      };
      expect(payload.payload.input?.video_list?.[0]).toMatchObject({
        start: 0,
        ends: 9.97,
      });
      expect(ready.cellIds()).toEqual(before);
    });

    it("does not require clip times when no video is connected", async () => {
      const ready = await setup({ video: false });
      const result = await preview(ready, {}, "r2v");
      expect(result.isError, resultText(result)).toBeUndefined();
      expect(resultText(result)).not.toContain("video_clip");
    });
  });
});
