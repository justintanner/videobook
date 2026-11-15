import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import { COMMON_VIDEO_FIXTURES, copyVideoFixture } from "../../server/src/test-media-fixtures.js";
import { registerExtractNotebookAudioJob } from "../../server/src/jobs/extract-notebook-audio.js";
import { setEngineRoot, stopBookQueue, waitForJob } from "../../server/src/queue.js";
import { withBookContext } from "../../server/src/book-context.js";
import { probeVideo } from "../../server/src/ffmpeg.js";
import { chatActionPlanSchema, chatDef, prepareVoiceChatAction } from "../../server/src/tools/chat.js";
import type { ToolDef } from "../../server/src/tools/tool-def.js";
import { testBudget } from "../../server/src/test-budget.js";
import { discoverVoiceActions } from "../../server/src/voice-actions.js";

function resultJson(result: Awaited<ReturnType<ToolDef["handler"]>>): Record<string, unknown> {
  if (result.isError) throw new Error(result.content[0]?.text ?? "Tool failed");
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

/**
 * The half of extract_audio that has to be real: the tool enqueues a job, and
 * the audio it produces carries where it came from and which slice it took.
 * Reading a legacy extract_audio cell back as audio is a pure document rewrite
 * and lives in notebook-extract-audio-alias.test.ts.
 *
 * Runs FFmpeg through the book queue, so it takes the 60s budget its siblings
 * use (notebook-audio-command.test.ts) rather than the 30s default — under a
 * full-suite run another worker's encoders can starve it well past 30s.
 */
describe("extract_audio action", () => {
  let rootDir: string | undefined;
  let engine: Engine | undefined;
  let bookId: string | undefined;

  afterEach(async () => {
    if (bookId) await stopBookQueue(bookId);
    engine?.close();
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("extracts audio through chat without approval and records its source and range", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vb-extract-audio-action-"));
    engine = createEngine({ durableWrites: false, rootDir, initialBookName: "extract-audio" });
    await engine.ready;
    bookId = engine.book.get().bookId;
    await setEngineRoot(rootDir, engine);
    registerExtractNotebookAudioJob(engine);

    const videoPath = join(rootDir, "source.mp4");
    await copyVideoFixture(COMMON_VIDEO_FIXTURES.extractAudio, videoPath);
    const video = await engine.artifacts.create({ kind: "video", label: "Source" });
    expect(video.ok).toBe(true);
    if (!video.ok) return;
    const ingested = await engine.files.writeFromPath(
      video.value.artifactId,
      "original.mp4",
      videoPath,
    );
    expect(ingested.ok).toBe(true);

    const notebook = await engine.notebooks.create("Main");
    expect(notebook.ok).toBe(true);
    if (!notebook.ok) return;
    const source = engine.notebooks.createCell({
      type: "video",
      label: "Source video",
      slot: { row: 0, column: 0 },
      outputArtifactId: video.value.artifactId,
    });
    const written = await engine.notebooks.write({
      ...notebook.value,
      cells: [source],
      edges: [],
    });
    expect(written.ok).toBe(true);

    for (const name of ["extract_audio", "extract_notebook_audio"]) {
      expect(discoverVoiceActions(engine, name.replaceAll("_", " "))).toContainEqual(
        expect.objectContaining({ name, requiresReview: false }),
      );
    }
    const context = { bookId, engine };
    const routed = await withBookContext(context, () => prepareVoiceChatAction(context.engine, {
      book_id: context.bookId,
      notebook_id: notebook.value.id,
      prompt: "Extract audio from @a1 starting at 0.2 seconds for 0.8 seconds",
    }, {
      tool: "extract_notebook_audio",
      params: { source_cell_id: source.id, start_seconds: 0.2, duration_seconds: 0.8 },
      message: "Extracting audio.",
    }));
    const plan = chatActionPlanSchema.parse(resultJson(routed));
    expect(plan.confirmation).toMatchObject({ required: false, reason: expect.stringContaining("Audio extraction") });
    const created = resultJson(await withBookContext(context, () => chatDef(context.engine).handler({
      book_id: context.bookId,
      action_plan: plan,
    })));
    expect(typeof created.cell_id).toBe("string");
    expect(typeof created.job_id).toBe("string");
    await waitForJob(String(created.job_id));

    const after = engine.notebooks.read(notebook.value.id);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const produced = after.value.cells.find((cell) => cell.id === created.cell_id);
    expect(produced).toMatchObject({
      type: "audio",
      inputs: expect.objectContaining({
        mediaRole: "extract-audio-output",
        sourceCellId: source.id,
        startSeconds: 0.2,
        durationSeconds: 0.8,
        state: "completed",
      }),
    });
    expect(produced?.outputArtifactId).toEqual(expect.any(String));
    expect(after.value.edges).toContainEqual(expect.objectContaining({ source: source.id, target: produced!.id }));
    const manifest = await engine.files.manifest(produced!.outputArtifactId!);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const probe = await probeVideo(join(manifest.value.path, "original.m4a"));
    expect(probe.hasAudio).toBe(true);
    expect(probe.audioDuration ?? probe.duration).toBeCloseTo(0.8, 1);
    const meta = await engine.metadata.artifacts.read(produced!.outputArtifactId!, "original");
    expect(meta.ok).toBe(true);
    if (meta.ok) {
      expect(meta.value).toEqual(expect.objectContaining({
        origin: "extract_audio",
        sourceArtifactId: video.value.artifactId,
      }));
    }
  }, testBudget(60_000));
});
