import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine, type NotebookDocument } from "videobook-engine";
import { Seedance25RequestSchema } from "@apicity/kie/zod";
import { prepareNotebookGeneration } from "../../server/src/jobs/run-notebook.js";
import { withBookContext } from "../../server/src/book-context.js";
import { getAllToolDefs } from "../../server/src/tools/index.js";
import { previewGeneration } from "../../server/src/media/preview.js";
import { generationInputMentions } from "../../server/src/generation-input-mentions.js";
import { generationModeInputError } from "../../server/src/generation-input-policy.js";
import {
  asNotebookGenerationActions,
  generationConnectedInputs,
  generationInputAttachments,
  generationModeIsCompatible,
  type NotebookGenerationAction,
} from "../../src/videobook/notebook-generation-actions";

const kinds = ["image", "video", "audio"] as const;
type Counts = Record<typeof kinds[number], number>;
const model = "kie:bytedance/seedance-2-5";

function refsOf(input: Record<string, unknown>): Record<string, string[] | undefined> {
  return input.refs as Record<string, string[] | undefined>;
}

function previewPayload(input: Record<string, unknown>): Record<string, unknown> {
  const preview = previewGeneration(input);
  if (!preview.ok) throw new Error(preview.error);
  return preview.preview.payload;
}

describe("reference video generation inputs", () => {
  let rootDir: string;
  let engine: Engine;
  let empty: NotebookDocument;
  let actions: NotebookGenerationAction[];

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-reference-generation-"));
    engine = createEngine({ rootDir, initialBookName: "references", durableWrites: false });
    await engine.ready;
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    empty = notebook.value;
    const catalog = await getAllToolDefs(engine).find((definition) => definition.name === "list_notebook_actions")!
      .handler({ book_id: engine.book.get().bookId, cell_type: "generate_video" });
    expect(catalog.isError).toBeUndefined();
    actions = asNotebookGenerationActions(JSON.parse(catalog.content[0]!.text));
  });

  afterEach(async () => {
    engine.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function documentFor(counts: Counts, frameTargets: string[] = []) {
    const generator = engine.notebooks.createCell({
      type: "generate_video",
      slot: { row: 10, column: 0 },
      provider: "kie",
      model,
      operation: "text_to_video",
      tool: "generate_video",
      inputs: { generationMode: "r2v", generationSettings: { duration: 20, aspect_ratio: "9:16" } },
    });
    const document: NotebookDocument = { ...empty, cells: [generator], edges: [] };
    for (const kind of kinds) {
      for (let index = 0; index < counts[kind]; index += 1) {
        const artifact = await engine.artifacts.create(kind, `${kind} ${index + 1}`);
        if (!artifact.ok) throw new Error(artifact.error.message);
        const slot = document.cells.length - 1;
        const source = engine.notebooks.createCell({
          type: kind,
          slot: { row: Math.floor(slot / 8), column: slot % 8 },
          outputArtifactId: artifact.value.artifactId,
        });
        document.cells.push(source);
        document.edges.push(engine.notebooks.createEdge({
          source: source.id,
          target: generator.id,
          targetInput: kind === "image" && frameTargets[index]
            ? frameTargets[index]!
            : index === 0 ? kind : `${kind}_${index + 1}`,
        }));
      }
    }
    generator.prompt = generationInputMentions(generator.id, document.cells, document.edges)
      .map((mention) => `Use @${mention.token}`).join(". ") || "Animate the scene";
    return { document, generator };
  }

  function seedanceAction() {
    const action = actions.find((candidate) => candidate.model === model);
    if (!action) throw new Error("Missing Seedance action");
    return action;
  }

  it.each([1, 2, 3, 4, 5, 6, 7])("prepares reference combination %i identically in the picker and provider payload", async (combination) => {
    const counts = {
      image: combination & 1 ? 2 : 0,
      video: combination & 2 ? 2 : 0,
      audio: combination & 4 ? 2 : 0,
    };
    const { document, generator } = await documentFor(counts);
    const inputs = generationConnectedInputs(generator.id, document.cells, document.edges);
    expect(generationModeIsCompatible(seedanceAction(), "r2v", inputs)).toBe(true);
    const prepared = await prepareNotebookGeneration(engine, document, generator, engine.book.get().bookId);
    const payload = previewPayload(prepared.input);
    const checked = Seedance25RequestSchema.safeParse(payload);
    expect(checked.success, JSON.stringify(checked.error)).toBe(true);
    if (!checked.success) return;
    for (const kind of kinds) {
      expect(checked.data.input[`reference_${kind}_urls`] ?? []).toHaveLength(counts[kind]);
    }
    expect(checked.data.input.first_frame_url).toBeUndefined();
    expect(checked.data.input.last_frame_url).toBeUndefined();
    expect(checked.data.input.aspect_ratio).toBe("9:16");
    expect(prepared.mentions.unresolved).toEqual([]);
  });

  it.each([
    ["image", "first_frame"],
    ["first_frame", "last_frame"],
    ["last_frame"],
  ])("uses %j as R2V references while retaining frame prompt aliases", async (...targets) => {
    const { document, generator } = await documentFor({ image: targets.length, video: 1, audio: 1 }, targets);
    generator.prompt += ". " + targets.filter((target) => target.endsWith("_frame"))
      .map((target) => `Start from @${target.replace("_", "")}`).join(". ");
    generator.inputs = { ...generator.inputs, first_frame_ref: "stale-first", last_frame_ref: "stale-last" };
    const prepared = await prepareNotebookGeneration(engine, document, generator, engine.book.get().bookId);
    expect(refsOf(prepared.input).image).toHaveLength(targets.length);
    expect(refsOf(prepared.input).video).toHaveLength(1);
    expect(refsOf(prepared.input).audio).toHaveLength(1);
    expect(refsOf(prepared.input).first_frame).toBeUndefined();
    expect(refsOf(prepared.input).last_frame).toBeUndefined();
    expect(prepared.input.options).toMatchObject({ aspect_ratio: "9:16" });
    expect(prepared.mentions.unresolved).toEqual([]);
    expect(Seedance25RequestSchema.safeParse(previewPayload(prepared.input)).success).toBe(true);
    await expect(prepareNotebookGeneration(engine, document, {
      ...generator, inputs: { ...generator.inputs, generationMode: "i2v" },
    }, engine.book.get().bookId)).rejects.toThrow(/does not accept/);
  });

  it("accepts all 50 Seedance references and enforces each model's limits before preview", async () => {
    const { document, generator } = await documentFor({ image: 30, video: 10, audio: 10 }, ["first_frame", "last_frame"]);
    const action = seedanceAction();
    const inputs = generationConnectedInputs(generator.id, document.cells, document.edges);
    expect(generationModeIsCompatible(action, "r2v", inputs)).toBe(true);
    const prepared = await prepareNotebookGeneration(engine, document, generator, engine.book.get().bookId);
    expect(refsOf(prepared.input).image).toHaveLength(30);
    expect(refsOf(prepared.input).video).toHaveLength(10);
    expect(refsOf(prepared.input).audio).toHaveLength(10);
    const payload = previewPayload(prepared.input);
    expect(Seedance25RequestSchema.safeParse(payload).success).toBe(true);
    for (const kind of kinds) {
      const extra = engine.notebooks.createCell({ type: kind, slot: { row: 9, column: 0 } });
      const cells = [...document.cells, extra];
      expect(generationInputAttachments(action, "r2v", generator.id, cells, document.edges)
        .filter((attachment) => attachment.target === kind)).toEqual([]);
      const edge = engine.notebooks.createEdge({ source: extra.id, target: generator.id, targetInput: `${kind}_extra` });
      const overLimit = { ...document, cells, edges: [...document.edges, edge] };
      const overInputs = generationConnectedInputs(generator.id, cells, overLimit.edges);
      expect(generationModeIsCompatible(action, "r2v", overInputs)).toBe(false);
      const mode = action.inputContract.modes.find((candidate) => candidate.id === "r2v")!;
      expect(generationModeInputError(mode, overInputs)).toContain(`at most ${kind === "image" ? 30 : 10} ${kind}`);
      await expect(prepareNotebookGeneration(engine, overLimit, generator, engine.book.get().bookId))
        .rejects.toThrow(`at most ${kind === "image" ? 30 : 10} ${kind}`);
    }
    const gemini = actions.find((candidate) => candidate.model === "kie:gemini-omni-video")!;
    expect(generationModeIsCompatible(gemini, "r2v", [{ kind: "audio", target: "audio" }])).toBe(false);
    expect(generationModeIsCompatible(action, "r2v", [])).toBe(false);
  });

  it("persists the same prompt references when more images are connected and blocks removed references", async () => {
    const { document, generator } = await documentFor({ image: 2, video: 0, audio: 0 }, ["image", "first_frame"]);
    generator.prompt = "Follow @image2";
    const frame = document.cells.find((cell) => cell.id === document.edges[1]!.source)!;
    const image = engine.notebooks.createCell({
      type: "image", slot: { row: 3, column: 0 }, outputArtifactId: document.cells[1]!.outputArtifactId,
    });
    const saved = await engine.notebooks.write({ ...document, cells: [...document.cells, image] });
    if (!saved.ok) throw new Error(saved.error.message);
    const setInput = getAllToolDefs(engine).find((definition) => definition.name === "set_notebook_cell_input")!;
    const set = (target: string, source: string | null) => withBookContext(
      { bookId: engine.book.get().bookId, engine },
      () => setInput.handler({
        book_id: engine.book.get().bookId, notebook_id: document.id,
        target_cell_id: generator.id, target_input: target, source_cell_id: source,
      }),
    );
    expect((await set("image_2", image.id)).isError).toBeUndefined();
    const updated = engine.notebooks.read(document.id);
    if (!updated.ok) throw new Error(updated.error.message);
    const updatedGenerator = updated.value.cells.find((cell) => cell.id === generator.id)!;
    expect(updatedGenerator.prompt).toBe("Follow @image3");
    const prepared = await prepareNotebookGeneration(engine, updated.value, updatedGenerator, engine.book.get().bookId);
    expect(prepared.mentions.resolved[0]?.artifactId).toBe(frame.outputArtifactId);
    expect((await set("first_frame", null)).isError).toBeUndefined();
    const removed = engine.notebooks.read(document.id);
    if (!removed.ok) throw new Error(removed.error.message);
    await expect(prepareNotebookGeneration(engine, removed.value,
      removed.value.cells.find((cell) => cell.id === generator.id)!, engine.book.get().bookId))
      .rejects.toThrow(/@image3/);
  });

  it("preserves legacy image-reference routing and keeps replacement audio separate", async () => {
    const { document, generator } = await documentFor({ image: 2, video: 0, audio: 0 });
    for (const generationMode of [undefined, "default", "r2v"]) {
      const prepared = await prepareNotebookGeneration(engine, document, {
        ...generator, inputs: { ...generator.inputs, generationMode },
      }, engine.book.get().bookId);
      expect(refsOf(prepared.input).image).toHaveLength(2);
      expect(refsOf(prepared.input).first_frame).toBeUndefined();
    }
    const mixed = await documentFor({ image: 2, video: 1, audio: 2 }, ["first_frame", "last_frame"]);
    mixed.document.edges.at(-1)!.targetInput = "replace_audio";
    mixed.generator.prompt = "Use @image1 with @audio1";
    const prepared = await prepareNotebookGeneration(engine, mixed.document, mixed.generator, engine.book.get().bookId);
    expect(refsOf(prepared.input).image).toHaveLength(2);
    expect(refsOf(prepared.input).video).toHaveLength(1);
    expect(refsOf(prepared.input).audio).toHaveLength(1);
    expect(prepared.input.replace_audio_with).toBe(`${mixed.document.cells.at(-1)!.outputArtifactId}`);
  });
});
