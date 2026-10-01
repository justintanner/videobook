import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine, type NotebookDocument } from "videobook-engine";
import {
  allocateGenerateImageResult,
  allocateGenerateVideoResult,
  listGenerateImageOutputs,
  listGenerateVideoOutputs,
  migrateStackedGenerationResults,
} from "../../server/src/notebook-cell-outputs.js";
import {
  claimNotebookGenerationPlan,
  failNotebookProviderOutput,
  notebookCellDefinitionFingerprint,
  registerRunNotebookJob,
  runNotebookCell,
} from "../../server/src/jobs/run-notebook.js";
import {
  queue,
  registerJobHandler,
  setEngineRoot,
  stopBookQueue,
  waitForJob,
} from "../../server/src/queue.js";
import { videobookDomainDefs } from "../../server/src/tools/videobook-domain.js";
import { scopedBookEngine, withBookContext } from "../../server/src/book-context.js";
import { BookManager } from "../../server/src/book-manager.js";
import type { ToolDef } from "../../server/src/tools/tool-def.js";
import {
  isImageVideoGenerationResultCell,
  notebookCellActionPresentation,
  notebookCellIsActiveStatus,
} from "../../src/videobook/notebook-cell-presentation";

function resultJson(result: Awaited<ReturnType<ToolDef["handler"]>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined();
  return JSON.parse(result.content[0]!.text) as unknown;
}

describe("unstacked image/video generation results", () => {
  let rootDir: string;
  let engine: Engine;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-unstack-"));
    engine = createEngine({ durableWrites: false, rootDir, initialBookName: "unstack" });
    await engine.ready;
  });

  afterEach(async () => {
    engine.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function writeProducer(
    type: "generate_image" | "generate_video",
    slot = { row: 0, column: 0 },
  ): Promise<{ notebookId: string; producerId: string }> {
    const created = await engine.notebooks.create("Main");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.message);
    const producer = engine.notebooks.createCell({
      type,
      label: type,
      slot,
      prompt: "a scene",
      provider: "kie",
      model: type === "generate_image"
        ? "NanoBananaProRequestSchema"
        : "GeminiOmniVideoRequestSchema",
      operation: type === "generate_image" ? "text_to_image" : "text_to_video",
      tool: type === "generate_image"
        ? "generate_kie_nano_banana_pro_text_to_image"
        : "generate_kie_gemini_omni_text_to_video",
    });
    const written = await engine.notebooks.write({
      ...created.value,
      cells: [producer],
      edges: [],
    });
    expect(written.ok).toBe(true);
    return { notebookId: created.value.id, producerId: producer.id };
  }

  it("does not pre-create a placeholder when configuring generate_image", async () => {
    const books = new BookManager({
      libraryDir: join(rootDir, "books"),
      objectPrefix: "test-objects",
    });
    await books.ready();
    try {
      const defs = videobookDomainDefs(scopedBookEngine, books);
      const byName = new Map(defs.map((def) => [def.name, def]));
      const created = resultJson(await byName.get("create_book")!.handler({
        name: "no-placeholder",
      })) as { bookId: string };
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
      const notebooks = resultJson(await invoke("list_notebooks", {})) as Array<{
        id: string;
      }>;
      const image = resultJson(await invoke("create_notebook_cell", {
        notebook_id: notebooks[0]!.id,
        cell: {
          type: "generate_image",
          slot: { row: 0, column: 0 },
          prompt: "no placeholder",
        },
      })) as { id: string; output_cell?: { id: string } };
      expect(image.output_cell).toBeUndefined();
      const document = resultJson(await invoke("get_notebook", {
        notebook_id: notebooks[0]!.id,
      })) as NotebookDocument;
      expect(document.cells).toHaveLength(1);
      expect(listGenerateImageOutputs(document, image.id)).toEqual([]);
    } finally {
      await books.close();
    }
  });

  it("allocates distinct result cells for two image invocations", async () => {
    const { notebookId, producerId } = await writeProducer("generate_image");
    const document = engine.notebooks.read(notebookId);
    expect(document.ok).toBe(true);
    if (!document.ok) throw new Error(document.error.message);
    const first = allocateGenerateImageResult(engine, document.value, producerId, {
      runId: "run-a",
      planId: "plan-a",
      acceptedAt: "2026-08-22T00:00:01.000Z",
    });
    const second = allocateGenerateImageResult(engine, first.document, producerId, {
      runId: "run-b",
      planId: "plan-b",
      acceptedAt: "2026-08-22T00:00:02.000Z",
    });
    expect(second.outputCell.id).not.toBe(first.outputCell.id);
    const listed = listGenerateImageOutputs(second.document, producerId);
    expect(listed.map((item) => item.outputCell.id)).toEqual([
      first.outputCell.id,
      second.outputCell.id,
    ]);
    expect(listed[0]?.outputCell.slot).toEqual({ row: 0, column: 1 });
    expect(listed[1]?.outputCell.slot).toEqual({ row: 0, column: 2 });
  });

  it("places video results downward without collisions", async () => {
    const { notebookId, producerId } = await writeProducer("generate_video");
    const document = engine.notebooks.read(notebookId);
    expect(document.ok).toBe(true);
    if (!document.ok) throw new Error(document.error.message);
    let working = document.value;
    const ids: string[] = [];
    for (const index of [1, 2, 3]) {
      const allocated = allocateGenerateVideoResult(engine, working, producerId, {
        runId: `run-v${index}`,
        acceptedAt: `2026-08-22T00:00:0${index}.000Z`,
      });
      working = allocated.document;
      ids.push(allocated.outputCell.id);
    }
    const listed = listGenerateVideoOutputs(working, producerId);
    expect(listed.map((item) => item.outputCell.id)).toEqual(ids);
    expect(listed.map((item) => item.outputCell.slot)).toEqual([
      { row: 1, column: 0 },
      { row: 2, column: 0 },
      { row: 3, column: 0 },
    ]);
  });

  it("claims three concurrent image plans with unique output cells", async () => {
    const { notebookId, producerId } = await writeProducer("generate_image");
    const document = engine.notebooks.read(notebookId);
    expect(document.ok).toBe(true);
    if (!document.ok) throw new Error(document.error.message);
    const producer = document.value.cells[0]!;
    const fingerprint = notebookCellDefinitionFingerprint(document.value, producer);
    const now = new Date().toISOString();
    const plans = [1, 2, 3].map((index) => {
      const planId = `019f0000-0000-7000-8000-00000000000${index}`;
      return {
        planId,
        cellId: producerId,
        status: "planned" as const,
        plan: {
          planId,
          cellDefinitionFingerprint: fingerprint,
          stages: [{ kind: "queued", input: { cell_id: producerId } }],
        },
        createdAt: now,
        updatedAt: now,
      };
    });
    const written = await engine.notebooks.write({
      ...document.value,
      generationPlans: plans,
    });
    expect(written.ok).toBe(true);
    const outputIds: string[] = [];
    for (const plan of plans) {
      const claimed = await claimNotebookGenerationPlan(
        engine,
        notebookId,
        producerId,
        plan.planId,
        `run-${plan.planId}`,
      );
      const outputCellId = (claimed.executionClaim as { outputCellId?: string })
        ?.outputCellId;
      expect(outputCellId).toEqual(expect.any(String));
      outputIds.push(outputCellId!);
    }
    expect(new Set(outputIds).size).toBe(3);
    const after = engine.notebooks.read(notebookId);
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error(after.error.message);
    expect(listGenerateImageOutputs(after.value, producerId)).toHaveLength(3);
    expect(after.value.execution?.[producerId]?.status).not.toBe("queued");
    for (const outputId of outputIds) {
      expect(after.value.execution?.[outputId]?.status).toBe("queued");
    }
  });

  it("marks only one invocation failed and leaves siblings queued", async () => {
    const { notebookId, producerId } = await writeProducer("generate_video");
    const document = engine.notebooks.read(notebookId);
    expect(document.ok).toBe(true);
    if (!document.ok) throw new Error(document.error.message);
    const first = allocateGenerateVideoResult(engine, document.value, producerId, {
      runId: "run-ok",
      acceptedAt: "2026-08-22T00:00:01.000Z",
    });
    const second = allocateGenerateVideoResult(engine, first.document, producerId, {
      runId: "run-fail",
      acceptedAt: "2026-08-22T00:00:02.000Z",
    });
    const third = allocateGenerateVideoResult(engine, second.document, producerId, {
      runId: "run-later",
      acceptedAt: "2026-08-22T00:00:03.000Z",
    });
    const withState: NotebookDocument = {
      ...third.document,
      execution: {
        [first.outputCell.id]: {
          fingerprint: "fp",
          status: "awaiting-output",
          runId: "run-ok",
          providerArtifactId: "artifact-ok",
        },
        [second.outputCell.id]: {
          fingerprint: "fp",
          status: "awaiting-output",
          runId: "run-fail",
          providerArtifactId: "artifact-fail",
        },
        [third.outputCell.id]: {
          fingerprint: "fp",
          status: "queued",
          runId: "run-later",
        },
      },
    };
    const written = await engine.notebooks.write(withState);
    expect(written.ok).toBe(true);
    await failNotebookProviderOutput(engine, {
      type: "await_notebook_output",
      bookId: engine.book.get().bookId,
      notebookId,
      cellId: producerId,
      providerArtifactId: "artifact-fail",
      runId: "run-fail",
      outputCellId: second.outputCell.id,
    });
    const after = engine.notebooks.read(notebookId);
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value.execution?.[second.outputCell.id]?.status).toBe("error");
    expect(after.value.execution?.[first.outputCell.id]?.status).toBe("awaiting-output");
    expect(after.value.execution?.[third.outputCell.id]?.status).toBe("queued");
    expect(after.value.execution?.[producerId]?.status).not.toBe("error");
  });

  it("expands stacked image artifacts into standalone tiles and is idempotent", async () => {
    const { notebookId, producerId } = await writeProducer("generate_image");
    const firstArtifact = await engine.artifacts.create({
      kind: "image",
      label: "first",
    });
    const secondArtifact = await engine.artifacts.create({
      kind: "image",
      label: "second",
    });
    expect(firstArtifact.ok && secondArtifact.ok).toBe(true);
    if (!firstArtifact.ok || !secondArtifact.ok) throw new Error("artifacts");
    const document = engine.notebooks.read(notebookId);
    expect(document.ok).toBe(true);
    if (!document.ok) throw new Error(document.error.message);
    const allocated = allocateGenerateImageResult(
      engine,
      document.value,
      producerId,
      {
        runId: "run-stack",
        acceptedAt: "2026-08-22T00:00:01.000Z",
        artifactId: secondArtifact.value.artifactId,
        state: "completed",
      },
    );
    const stacked: NotebookDocument = {
      ...allocated.document,
      cells: allocated.document.cells.map((cell) =>
        cell.id === allocated.outputCell.id
          ? {
              ...cell,
              outputArtifactId: secondArtifact.value.artifactId,
              inputs: {
                ...cell.inputs,
                outputVersionArtifactIds: [
                  firstArtifact.value.artifactId,
                  secondArtifact.value.artifactId,
                ],
              },
            }
          : cell),
    };
    const downstream = engine.notebooks.createCell({
      type: "extract_audio",
      slot: { row: 2, column: 1 },
    });
    const withEdge: NotebookDocument = {
      ...stacked,
      cells: [...stacked.cells, downstream],
      edges: [
        ...stacked.edges,
        engine.notebooks.createEdge({
          source: allocated.outputCell.id,
          target: downstream.id,
          targetInput: "media",
        }),
      ],
    };
    const migrated = migrateStackedGenerationResults(engine, withEdge);
    const results = listGenerateImageOutputs(migrated, producerId);
    expect(results).toHaveLength(2);
    const current = results.find((item) =>
      item.outputCell.id === allocated.outputCell.id);
    expect(current?.outputCell.outputArtifactId).toBe(secondArtifact.value.artifactId);
    expect(current?.outputCell.inputs?.outputVersionArtifactIds).toBeUndefined();
    expect(migrated.edges.some((edge) =>
      edge.source === allocated.outputCell.id && edge.target === downstream.id)).toBe(true);
    const historical = results.find((item) =>
      item.outputCell.id !== allocated.outputCell.id);
    expect(historical?.outputCell.outputArtifactId).toBe(firstArtifact.value.artifactId);
    const again = migrateStackedGenerationResults(engine, migrated);
    expect(listGenerateImageOutputs(again, producerId)).toHaveLength(2);
    expect(again.cells.map((cell) => cell.id).sort()).toEqual(
      migrated.cells.map((cell) => cell.id).sort(),
    );
  });

  it("keeps audio generation on a single versioned output cell", async () => {
    const created = await engine.notebooks.create("Main");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.message);
    const producer = engine.notebooks.createCell({
      type: "generate_audio",
      slot: { row: 0, column: 0 },
      prompt: "hum",
      tool: "generate_elevenlabs_t2a",
    });
    const first = await engine.artifacts.create({ kind: "audio", label: "a1" });
    const second = await engine.artifacts.create({ kind: "audio", label: "a2" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("audio");
    const output = engine.notebooks.createCell({
      type: "audio",
      slot: { row: 0, column: 1 },
      outputArtifactId: second.value.artifactId,
      inputs: {
        mediaRole: "generate-audio-output",
        producerCellId: producer.id,
        outputVersionArtifactIds: [
          first.value.artifactId,
          second.value.artifactId,
        ],
      },
    });
    const document: NotebookDocument = {
      ...created.value,
      cells: [producer, output],
      edges: [
        engine.notebooks.createEdge({
          source: producer.id,
          target: output.id,
          targetInput: "media",
        }),
      ],
    };
    const migrated = migrateStackedGenerationResults(engine, document);
    expect(migrated.cells).toHaveLength(2);
    const audio = migrated.cells.find((cell) => cell.id === output.id);
    expect(audio?.inputs?.outputVersionArtifactIds).toEqual([
      first.value.artifactId,
      second.value.artifactId,
    ]);
    expect(isImageVideoGenerationResultCell(audio!)).toBe(false);
  });
});

describe("unstacked generation run and await", () => {
  const VIDEO_TOOL = "generate_kie_grok_imagine_text_to_video";
  const VIDEO_JOB_TYPE = "generate_grok_imagine_t2v_video";
  const IMAGE_TOOL = "generate_kie_nano_banana_pro_text_to_image";
  const IMAGE_JOB_TYPE = "generate_nano_banana_image";

  let rootDir: string;
  let engine: Engine;
  let bookId: string;
  let previousKieKey: string | undefined;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-unstack-run-"));
    engine = createEngine({ durableWrites: false, rootDir, initialBookName: "unstack-run" });
    await engine.ready;
    bookId = engine.book.get().bookId;
    previousKieKey = process.env.KIE_API_KEY;
    process.env.KIE_API_KEY = "test-kie-key-unstack";
    await setEngineRoot(rootDir, engine);
    registerRunNotebookJob(engine);
  });

  afterEach(async () => {
    if (previousKieKey === undefined) delete process.env.KIE_API_KEY;
    else process.env.KIE_API_KEY = previousKieKey;
    await stopBookQueue(bookId);
    engine.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  function stubMediaJob(jobType: string, filename: string, bytes: string): void {
    registerJobHandler(jobType, async (payload) => {
      const assetId = jobType === IMAGE_JOB_TYPE
        ? (payload as { imgAssetId: string }).imgAssetId
        : (payload as { vidAssetId: string }).vidAssetId;
      await engine.files.write(assetId, filename, Buffer.from(bytes));
      await engine.metadata.artifacts.write(assetId, "original", { name: filename });
      return { success: true, taskId: `stub-${assetId}` };
    });
  }

  async function seedProducer(input: {
    type: "generate_image" | "generate_video";
    tool: string;
    model: string;
    operation: string;
  }): Promise<{ notebookId: string; cell: NotebookDocument["cells"][number] }> {
    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const cell = engine.notebooks.createCell({
      type: input.type,
      label: input.type,
      slot: { row: 0, column: 0 },
      prompt: "a scene",
      provider: "kie",
      model: input.model,
      operation: input.operation,
      tool: input.tool,
    });
    const written = await engine.notebooks.write({
      ...notebook.value,
      cells: [cell],
    });
    expect(written.ok).toBe(true);
    return { notebookId: notebook.value.id, cell };
  }

  async function completeAwait(input: {
    notebookId: string;
    producerId: string;
    runId: string;
    artifactId: string;
    outputCellId?: string;
  }): Promise<void> {
    const awaitJobId =
      `await-notebook-${input.runId}-${input.producerId}-${input.artifactId}`;
    await queue.enqueue(awaitJobId, {
      type: "await_notebook_output",
      bookId,
      notebookId: input.notebookId,
      cellId: input.producerId,
      providerArtifactId: input.artifactId,
      runId: input.runId,
      ...(input.outputCellId ? { outputCellId: input.outputCellId } : {}),
    });
    await waitForJob(awaitJobId, 30_000);
    await waitForJob(`resume-notebook-${input.runId}`, 30_000);
  }

  it("keeps a generate_video producer idle after an accepted provider-active run", async () => {
    stubMediaJob(VIDEO_JOB_TYPE, "original.mp4", "stub-video");
    const { notebookId, cell } = await seedProducer({
      type: "generate_video",
      tool: VIDEO_TOOL,
      model: "GrokTextToVideoRequestSchema",
      operation: "text_to_video",
    });
    const document = engine.notebooks.read(notebookId);
    expect(document.ok).toBe(true);
    if (!document.ok) throw new Error(document.error.message);
    const runId = "019f0000-0000-7000-8000-00000000aa01";
    const result = await runNotebookCell(
      engine,
      bookId,
      notebookId,
      document.value,
      cell,
      { confirmPaid: true, runId },
    );
    expect(result.status).toBe("awaiting-output");
    const after = engine.notebooks.read(notebookId);
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error(after.error.message);
    const producer = after.value.cells.find((candidate) => candidate.id === cell.id)!;
    const outputs = listGenerateVideoOutputs(after.value, cell.id);
    expect(outputs).toHaveLength(1);
    expect(producer.inputs?.state).not.toBe("awaiting-output");
    expect(producer.inputs?.state).not.toBe("queued");
    expect(producer.inputs?.state).not.toBe("running");
    expect(after.value.execution?.[cell.id]?.status).not.toBe("awaiting-output");
    expect(after.value.execution?.[outputs[0]!.outputCell.id]?.status)
      .toBe("awaiting-output");
    const producerStatus = after.value.execution?.[cell.id]?.status
      ?? (typeof producer.inputs?.state === "string" ? producer.inputs.state : "ready");
    expect(notebookCellIsActiveStatus(producerStatus)).toBe(false);
    expect(notebookCellActionPresentation(producer, producerStatus)?.disabled)
      .toBe(false);
  });

  it("completes three same-producer image and video runs out of order on distinct tiles", async () => {
    stubMediaJob(IMAGE_JOB_TYPE, "original.jpg", "stub-image");
    stubMediaJob(VIDEO_JOB_TYPE, "original.mp4", "stub-video");
    const image = await seedProducer({
      type: "generate_image",
      tool: IMAGE_TOOL,
      model: "NanoBananaProRequestSchema",
      operation: "text_to_image",
    });
    const videoNotebook = await engine.notebooks.create("Video");
    expect(videoNotebook.ok).toBe(true);
    if (!videoNotebook.ok) throw new Error(videoNotebook.error.message);
    const videoCell = engine.notebooks.createCell({
      type: "generate_video",
      label: "generate_video",
      slot: { row: 0, column: 0 },
      prompt: "a scene",
      provider: "kie",
      model: "GrokTextToVideoRequestSchema",
      operation: "text_to_video",
      tool: VIDEO_TOOL,
    });
    const videoWritten = await engine.notebooks.write({
      ...videoNotebook.value,
      cells: [videoCell],
    });
    expect(videoWritten.ok).toBe(true);

    async function acceptThree(
      notebookId: string,
      producerId: string,
      runMarker: "b" | "c",
    ): Promise<Array<{ runId: string; artifactId: string; outputCellId: string }>> {
      const accepted: Array<{
        runId: string;
        artifactId: string;
        outputCellId: string;
      }> = [];
      for (const index of [1, 2, 3]) {
        const fresh = engine.notebooks.read(notebookId);
        expect(fresh.ok).toBe(true);
        if (!fresh.ok) throw new Error(fresh.error.message);
        const producer = fresh.value.cells.find((candidate) =>
          candidate.id === producerId);
        expect(producer).toBeTruthy();
        const runId = `019f0000-0000-7000-8000-00000000${runMarker}00${index}`;
        const result = await runNotebookCell(
          engine,
          bookId,
          notebookId,
          fresh.value,
          producer!,
          { confirmPaid: true, runId },
        );
        expect(result.status).toBe("awaiting-output");
        const after = engine.notebooks.read(notebookId);
        expect(after.ok).toBe(true);
        if (!after.ok) throw new Error(after.error.message);
        const output = after.value.cells.find((candidate) =>
          after.value.execution?.[candidate.id]?.runId === runId);
        expect(output?.id).toBeTruthy();
        expect(after.value.execution?.[producerId]?.status).not.toBe("awaiting-output");
        expect(after.value.cells.find((candidate) => candidate.id === producerId)
          ?.inputs?.state).not.toBe("awaiting-output");
        accepted.push({
          runId,
          artifactId: result.outputArtifactId,
          outputCellId: output!.id,
        });
      }
      expect(new Set(accepted.map((item) => item.outputCellId)).size).toBe(3);
      expect(new Set(accepted.map((item) => item.artifactId)).size).toBe(3);
      return accepted;
    }

    const imageRuns = await acceptThree(image.notebookId, image.cell.id, "b");
    const videoRuns = await acceptThree(
      videoNotebook.value.id,
      videoCell.id,
      "c",
    );

    for (const run of [...imageRuns].reverse()) {
      await completeAwait({
        notebookId: image.notebookId,
        producerId: image.cell.id,
        ...run,
      });
    }
    for (const run of [...videoRuns].reverse()) {
      await completeAwait({
        notebookId: videoNotebook.value.id,
        producerId: videoCell.id,
        ...run,
      });
    }

    const imageDoc = engine.notebooks.read(image.notebookId);
    const videoDoc = engine.notebooks.read(videoNotebook.value.id);
    expect(imageDoc.ok && videoDoc.ok).toBe(true);
    if (!imageDoc.ok || !videoDoc.ok) throw new Error("notebooks");
    for (const run of imageRuns) {
      const tile = imageDoc.value.cells.find((cell) => cell.id === run.outputCellId);
      expect(tile?.outputArtifactId).toBe(run.artifactId);
      expect(imageDoc.value.execution?.[run.outputCellId]?.status).toBe("completed");
    }
    for (const run of videoRuns) {
      const tile = videoDoc.value.cells.find((cell) => cell.id === run.outputCellId);
      expect(tile?.outputArtifactId).toBe(run.artifactId);
      expect(videoDoc.value.execution?.[run.outputCellId]?.status).toBe("completed");
    }
    expect(listGenerateImageOutputs(imageDoc.value, image.cell.id)).toHaveLength(3);
    expect(listGenerateVideoOutputs(videoDoc.value, videoCell.id)).toHaveLength(3);
  }, 60_000);
});
