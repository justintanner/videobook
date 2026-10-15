import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  createEngine,
  type Engine,
  type NotebookCell,
  type NotebookDocument,
} from "videobook-engine";
import {
  LIGHTNING_SCENE_ASPECT_RATIO,
  LIGHTNING_SCENE_OUTPUT_FORMAT,
  LIGHTNING_SCENE_RESOLUTION,
  LIGHTNING_SCENE_TOOL,
  LIGHTNING_VIDEO_ASPECT_RATIO,
  LIGHTNING_VIDEO_DURATION,
  LIGHTNING_VIDEO_GENERATE_AUDIO,
  LIGHTNING_VIDEO_OUTPUT_FORMAT,
  LIGHTNING_VIDEO_RESOLUTION,
  LIGHTNING_VIDEO_TOOL,
} from "../../server/src/lightning-defaults.js";
import {
  prepareNotebookGeneration,
  registerRunNotebookJob,
  runNotebookCell,
} from "../../server/src/jobs/run-notebook.js";
import { translateToolPayload } from "../../server/src/payload-builders.js";
import {
  queue,
  registerJobHandler,
  setEngineRoot,
  stopBookQueue,
  waitForJob,
} from "../../server/src/queue.js";

const STALE = "An older long cinematic prompt that must not be submitted again";
const SHORT = "A short submitted prompt";
const SECOND = "A second short prompt";
const VIDEO_JOB = "generate_seedance25_video";

describe("lightning generation defaults and submitted prompts", () => {
  let rootDir: string;
  let engine: Engine;
  let bookId: string;
  let previousKieKey: string | undefined;
  const seen: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    seen.length = 0;
    rootDir = await mkdtemp(join(tmpdir(), "videobook-lightning-gen-"));
    engine = createEngine({
      durableWrites: false,
      rootDir,
      initialBookName: "lightning-defaults",
    });
    await engine.ready;
    bookId = engine.book.get().bookId;
    previousKieKey = process.env.KIE_API_KEY;
    process.env.KIE_API_KEY = "test-kie-key-lightning";
    await setEngineRoot(rootDir, engine);
    registerRunNotebookJob(engine);
    registerJobHandler(VIDEO_JOB, async (payload) => {
      const job = payload as {
        vidAssetId: string;
        prompt?: string;
        duration?: string;
        resolution?: string;
        aspect_ratio?: string;
        generate_audio?: boolean;
        output_format?: string;
      };
      seen.push(job);
      await engine.files.write(job.vidAssetId, "original.mp4", Buffer.from("stub lightning video"));
      await engine.metadata.artifacts.write(job.vidAssetId, "original", { name: "original.mp4" });
      await engine.metadata.artifacts.write(job.vidAssetId, "generation-payload", {
        model: "bytedance/seedance-2-5",
        input: {
          prompt: job.prompt ?? "",
          duration: Number(job.duration),
          resolution: job.resolution,
          aspect_ratio: job.aspect_ratio,
          generate_audio: job.generate_audio,
          output_format: job.output_format,
        },
      });
      return { success: true, taskId: "stub-lightning-task" };
    });
  });

  afterEach(async () => {
    if (previousKieKey === undefined) delete process.env.KIE_API_KEY;
    else process.env.KIE_API_KEY = previousKieKey;
    await stopBookQueue(bookId);
    engine.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  async function writeCell(cell: NotebookCell): Promise<{
    notebookId: string;
    document: NotebookDocument;
  }> {
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    const written = await engine.notebooks.write({ ...notebook.value, cells: [cell] });
    if (!written.ok) throw new Error(written.error.message);
    const read = engine.notebooks.read(notebook.value.id);
    if (!read.ok) throw new Error(read.error.message);
    return { notebookId: notebook.value.id, document: read.value };
  }

  function videoCell(prompt: string, inputs: Record<string, unknown>): NotebookCell {
    return engine.notebooks.createCell({
      type: "generate_video",
      label: "Lightning video",
      slot: { row: 0, column: 0 },
      prompt,
      provider: "kie",
      model: "bytedance/seedance-2-5",
      operation: "text_to_video",
      tool: LIGHTNING_VIDEO_TOOL,
      inputs,
    });
  }

  async function waitForJobs(count: number): Promise<void> {
    const start = Date.now();
    while (seen.length < count) {
      if (Date.now() - start > 10_000) {
        throw new Error(`expected ${count} Seedance jobs, saw ${seen.length}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function finish(notebookId: string, cellId: string, artifactId: string, runId: string): Promise<void> {
    const awaitJobId = `await-notebook-${runId}-${cellId}-${artifactId}`;
    await queue.enqueue(awaitJobId, {
      type: "await_notebook_output",
      bookId,
      notebookId,
      cellId,
      providerArtifactId: artifactId,
      runId,
    });
    await waitForJob(awaitJobId, 30_000);
  }

  it("submits lightning video defaults and keeps the submitted prompt through completion and rerun", async () => {
    const cell = videoCell(SHORT, {
      generationMode: "t2v",
      state: "pending",
      resolvedPrompt: STALE,
    });
    const { notebookId, document } = await writeCell(cell);
    const prepared = await prepareNotebookGeneration(engine, document, cell, bookId);
    expect(prepared.input.prompt).toBe(SHORT);
    expect(prepared.input.prompt).not.toBe(STALE);
    expect(prepared.input).toMatchObject({
      duration: LIGHTNING_VIDEO_DURATION,
      resolution: LIGHTNING_VIDEO_RESOLUTION,
      aspect_ratio: LIGHTNING_VIDEO_ASPECT_RATIO,
      generate_audio: LIGHTNING_VIDEO_GENERATE_AUDIO,
      output_format: LIGHTNING_VIDEO_OUTPUT_FORMAT,
    });
    const translated = translateToolPayload(prepared.tool, prepared.input, prepared.provider);
    expect(translated?.payload).toMatchObject({
      model: "bytedance/seedance-2-5",
      input: {
        prompt: SHORT,
        duration: 13,
        resolution: "1080p",
        aspect_ratio: "16:9",
        generate_audio: true,
        output_format: "mp4",
      },
    });

    const runId = uuidv7();
    const result = await runNotebookCell(engine, bookId, notebookId, document, cell, {
      confirmPaid: true,
      runId,
    });
    await waitForJobs(1);
    expect(seen[0]).toMatchObject({
      prompt: SHORT,
      duration: LIGHTNING_VIDEO_DURATION,
      resolution: LIGHTNING_VIDEO_RESOLUTION,
      aspect_ratio: LIGHTNING_VIDEO_ASPECT_RATIO,
      generate_audio: true,
      output_format: LIGHTNING_VIDEO_OUTPUT_FORMAT,
    });
    expect(JSON.stringify(seen[0])).not.toContain(STALE);

    const dispatched = engine.generations.listForCell(notebookId, cell.id);
    expect(dispatched.ok).toBe(true);
    if (!dispatched.ok) return;
    expect(dispatched.value[0]).toMatchObject({
      prompt: SHORT,
      resolvedPrompt: SHORT,
      status: "awaiting_provider",
    });

    await finish(notebookId, cell.id, result.outputArtifactId!, runId);
    const completed = engine.notebooks.read(notebookId);
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    const action = completed.value.cells.find((candidate) => candidate.id === cell.id);
    const output = completed.value.cells.find((candidate) => candidate.id !== cell.id && candidate.type === "video");
    expect(action?.prompt).toBe(SHORT);
    expect(action?.inputs?.resolvedPrompt).toBe(SHORT);
    expect(output?.prompt).toBe(SHORT);
    expect(output?.inputs?.resolvedPrompt).toBe(SHORT);
    expect(output?.inputs?.dispatchedPayload).toMatchObject({
      model: "bytedance/seedance-2-5",
      input: { prompt: SHORT, duration: 13, resolution: "1080p", aspect_ratio: "16:9" },
    });
    const firstOutputId = output?.id;
    const firstArtifactId = output?.outputArtifactId;

    const rerunCell = completed.value.cells.find((candidate) => candidate.id === cell.id);
    if (!rerunCell) throw new Error("action cell missing");
    const updatedCell = { ...rerunCell, prompt: SECOND };
    const rewritten = await engine.notebooks.write({
      ...completed.value,
      cells: completed.value.cells.map((candidate) => candidate.id === cell.id ? updatedCell : candidate),
    });
    expect(rewritten.ok).toBe(true);
    const reread = engine.notebooks.read(notebookId);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    const secondRunId = uuidv7();
    const second = await runNotebookCell(
      engine,
      bookId,
      notebookId,
      reread.value,
      reread.value.cells.find((candidate) => candidate.id === cell.id)!,
      { confirmPaid: true, runId: secondRunId },
    );
    await waitForJobs(2);
    expect(seen[1]?.prompt).toBe(SECOND);
    expect(JSON.stringify(seen[1])).not.toContain(STALE);
    await finish(notebookId, cell.id, second.outputArtifactId!, secondRunId);

    const afterRerun = engine.notebooks.read(notebookId);
    expect(afterRerun.ok).toBe(true);
    if (!afterRerun.ok) return;
    const firstOutput = afterRerun.value.cells.find((candidate) => candidate.id === firstOutputId);
    const secondOutput = afterRerun.value.cells.find((candidate) =>
      candidate.type === "video" && candidate.id !== firstOutputId);
    expect(firstOutput?.prompt).toBe(SHORT);
    expect(firstOutput?.outputArtifactId).toBe(firstArtifactId);
    expect(secondOutput?.prompt).toBe(SECOND);
    expect(secondOutput?.inputs?.resolvedPrompt).toBe(SECOND);
    const rows = engine.generations.listForCell(notebookId, cell.id);
    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    expect(rows.value.map((row) => row.resolvedPrompt).sort()).toEqual([SECOND, SHORT]);
  });

  it("keeps explicit Seedance settings ahead of lightning defaults", async () => {
    const cell = videoCell("Keep my settings", {
      generationMode: "t2v",
      generationSettings: {
        duration: "5",
        resolution: "720p",
        aspect_ratio: "9:16",
        generate_audio: false,
        output_format: "mov",
      },
    });
    const { notebookId, document } = await writeCell(cell);
    const prepared = await prepareNotebookGeneration(engine, document, cell, bookId);
    expect(prepared.input).toMatchObject({
      prompt: "Keep my settings",
      duration: "5",
      resolution: "720p",
      aspect_ratio: "9:16",
      generate_audio: false,
      output_format: "mov",
    });
    const runId = uuidv7();
    await runNotebookCell(engine, bookId, notebookId, document, cell, { confirmPaid: true, runId });
    await waitForJobs(1);
    expect(seen[0]).toMatchObject({
      prompt: "Keep my settings",
      duration: "5",
      resolution: "720p",
      aspect_ratio: "9:16",
      generate_audio: false,
      output_format: "mov",
    });
  });

  it("previews a fresh Nano Banana 2.1 scene at 16:9 2K JPG", async () => {
    const cell = engine.notebooks.createCell({
      type: "generate_image",
      label: "Lightning scene",
      slot: { row: 0, column: 0 },
      prompt: SHORT,
      provider: "kie",
      model: "nano-banana-2-1",
      operation: "generate_image",
      tool: LIGHTNING_SCENE_TOOL,
      inputs: { resolvedPrompt: STALE },
    });
    const { document } = await writeCell(cell);
    const prepared = await prepareNotebookGeneration(engine, document, cell, bookId);
    expect(prepared.input.prompt).toBe(SHORT);
    expect(prepared.input).toMatchObject({
      aspect_ratio: LIGHTNING_SCENE_ASPECT_RATIO,
      resolution: LIGHTNING_SCENE_RESOLUTION,
      output_format: LIGHTNING_SCENE_OUTPUT_FORMAT,
    });
    const translated = translateToolPayload(prepared.tool, prepared.input, prepared.provider);
    expect(translated?.payload).toMatchObject({
      model: "nano-banana-2-1",
      input: {
        prompt: SHORT,
        aspect_ratio: "16:9",
        resolution: "2K",
        output_format: "jpg",
      },
    });
    expect(JSON.stringify(translated)).not.toContain(STALE);
  });
});
