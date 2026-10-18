import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BookManager } from "../../server/src/book-manager.js";
import { scopedBookEngine, withBookContext } from "../../server/src/book-context.js";
import { videobookDomainDefs } from "../../server/src/tools/videobook-domain.js";
import type { ToolDef } from "../../server/src/tools/tool-def.js";
import {
  asNotebookGenerationActions,
  generationSettingsError,
} from "../../src/videobook/notebook-generation-actions";

function resultText(result: Awaited<ReturnType<ToolDef["handler"]>>): string {
  return result.content[0]?.text ?? "";
}

describe("MiniMax H3 Max insert video settings", () => {
  it("names blank start and resume times instead of coercing them to NaN", () => {
    const [action] = asNotebookGenerationActions({
      actions: [{
        kind: "generation",
        id: "generation.generate_fal_minimax_h3_max_insert_video",
        cellTypes: ["generate_video"],
        provider: "fal",
        providerLabel: "Fal",
        model: "minimax/h3-max/insert-video",
        operation: "insert_video",
        tool: "generate_fal_minimax_h3_max_insert_video",
        title: "fal MiniMax H3 Max insert-video",
        inputContract: {
          modes: [{
            id: "default",
            slots: [{
              field: "video_ref",
              kind: "video",
              targets: ["video"],
              min: 1,
              max: 1,
            }],
            requiredGroups: [],
          }],
        },
        controls: [
          {
            name: "start_time",
            label: "Start time",
            kind: "number",
            valueType: "number",
            required: true,
            minimum: 1.625,
            maximum: 60,
            description: "Insert start",
          },
          {
            name: "resume_time",
            label: "Resume time",
            kind: "number",
            valueType: "number",
            required: true,
            minimum: 1.625,
            exclusiveMinimum: true,
            maximum: 60,
            description: "Resume time",
          },
          {
            name: "duration",
            label: "Duration",
            kind: "number",
            valueType: "number",
            required: false,
            defaultValue: 5,
            minimum: 5,
            maximum: 13,
            description: "Duration",
          },
        ],
      }],
    });
    expect(action?.controls.find((control) => control.name === "resume_time"))
      .toMatchObject({ exclusiveMinimum: true, minimum: 1.625 });
    expect(generationSettingsError(action?.controls ?? [], { duration: 5 }))
      .toBe("Start time: Required; Resume time: Required");
    expect(generationSettingsError(action?.controls ?? [], {
      start_time: 1.625,
      resume_time: 1.625,
      duration: 5,
    })).toBe("Resume time: Must be greater than 1.625");
    expect(generationSettingsError(action?.controls ?? [], {
      start_time: 2,
      resume_time: 4,
      duration: 5,
    })).toBeNull();
  });

  describe("preview", () => {
    let rootDir: string;
    let books: BookManager;

    beforeEach(async () => {
      rootDir = await mkdtemp(join(tmpdir(), "videobook-h3-insert-"));
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

    async function preview(settings: Record<string, unknown>, duration = 9.04, plan = false) {
      const defs = videobookDomainDefs(scopedBookEngine, books);
      const byName = new Map(defs.map((def) => [def.name, def]));
      const created = JSON.parse(resultText(await byName.get("create_book")!.handler({
        name: "h3-insert",
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
      const source = await engine.artifacts.create("video", "source-clip");
      if (!source.ok) throw new Error(source.error.message);
      await engine.metadata.artifacts.write(source.value.artifactId, "original", { duration });
      const notebook = engine.notebooks.read(notebookId);
      if (!notebook.ok) throw new Error(notebook.error.message);
      const video = engine.notebooks.createCell({
        type: "video",
        slot: { row: 0, column: 0 },
        outputArtifactId: source.value.artifactId,
      });
      const generation = engine.notebooks.createCell({
        type: "generate_video",
        slot: { row: 1, column: 0 },
        prompt: "Motion video. Match motion, timing. Render coherent video.",
        provider: "fal",
        model: "fal:minimax/h3-max/insert-video",
        operation: "edit_video",
        tool: "generate_video",
        inputs: { generationMode: "default", generationSettings: settings },
      });
      const written = await engine.notebooks.write({
        ...notebook.value,
        cells: [...notebook.value.cells, video, generation],
        edges: [engine.notebooks.createEdge({
          source: video.id,
          target: generation.id,
          targetInput: "video",
        })],
      });
      if (!written.ok) throw new Error(written.error.message);
      if (plan) {
        const before = engine.notebooks.read(notebookId);
        const result = await invoke("plan_notebook_generation", { notebook_id: notebookId, cell_id: generation.id, timeline_start_frame: 0 });
        const after = engine.notebooks.read(notebookId);
        expect(after.ok && after.value.cells).toEqual(before.ok && before.value.cells);
        expect(engine.jobs.queue.list({ type: "run_notebook" })).toHaveLength(0);
        return result;
      }
      return invoke("preview_notebook_generation", {
        notebook_id: notebookId,
        cell_id: generation.id,
        draft: {
          prompt: generation.prompt,
          provider: "fal",
          model: "fal:minimax/h3-max/insert-video",
          operation: "edit_video",
          tool: "generate_video",
          inputs: {
            generationMode: "default",
            generationSettings: settings,
          },
        },
      });
    }

    it("rejects a blank insert window without reporting NaN", async () => {
      const result = await preview({});
      expect(result.isError).toBe(true);
      expect(resultText(result)).toBe("Start time: Required; Resume time: Required");
      expect(resultText(result)).not.toContain("NaN");
    });

    it("builds the fal payload once both times are inside the insert window", async () => {
      const result = await preview({ start_time: 2, resume_time: 4, duration: 5, resolution: "768p" });
      expect(result.isError, resultText(result)).toBeUndefined();
      const payload = JSON.parse(resultText(result)) as {
        payload: { input: { start_time: number; resume_time: number; duration: number; resolution: string } };
      };
      expect(payload.payload.input).toMatchObject({
        start_time: 2,
        resume_time: 4,
        duration: 5,
        resolution: "768p",
      });
    });

    it.each([
      [{ start_time: 14, resume_time: 6, duration: 13 }, /Resume original must be after/],
      [{ start_time: 14, resume_time: 16, duration: 13 }, /source video ends at 9.04s/],
      [{ start_time: 2, resume_time: 12, duration: 13 }, /within the 9.04s source video/],
      [{ start_time: 4, resume_time: 4, duration: 5 }, /Resume original must be after/],
    ])("rejects invalid insertion timing %j during preview", async (settings, message) => {
      const result = await preview(settings);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(message);
    });

    it("allows a new scene longer than the replaced section", async () => {
      const result = await preview({ start_time: 2, resume_time: 6, duration: 13 });
      expect(result.isError, resultText(result)).toBeUndefined();
      expect(JSON.parse(resultText(result)).payload.input).toMatchObject({ start_time: 2, resume_time: 6, duration: 13 });
    });

    it("refuses an out-of-bounds generation plan before reserving output cells", async () => {
      const result = await preview({ start_time: 2, resume_time: 12, duration: 13 }, 9.04, true);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("within the 9.04s source video");
    });
  });
});
