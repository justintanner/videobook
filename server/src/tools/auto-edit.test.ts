import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Engine } from "videobook-engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkSegmentPlan, planOutputFrames, segmentOutputStartFrames, type SegmentPlan } from "../auto-edit/plan.js";
import { readStoredAutoEditDraft, type AutoEditGetResponse } from "../auto-edit/drafts.js";
import { DEFAULT_AUTO_EDIT_SECTIONS, type AutoEditAnchors } from "../auto-edit/style.js";
import { buildChatRoutingPrompt, buildRoutableTools } from "../chat-router.js";
import { builtinSound, type BuiltinSoundId } from "../sound-effects/catalog.js";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { FFMPEG, FFPROBE, probeVideo } from "../ffmpeg.js";
import { forgetAsset } from "../forget-asset.js";
import { registerAllJobHandlers } from "../jobs/index.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { pauseBookQueueForTests, queue, resumeBookQueueForTests, setEngineRoot, waitForBookQueuesIdleForTests } from "../queue.js";
import { testBudget } from "../test-budget.js";
import { autoEditDef } from "./auto-edit.js";
import { getAllToolDefs } from "./index.js";
import { reconcileProjectWork } from "./reconcile-project-work.js";
import type { ToolResult } from "./tool-def.js";
import { toolInputJsonSchema } from "./tool-json-schema.js";

const execFileAsync = promisify(execFile);
const WIDTH = 320;
const HEIGHT = 180;
const FPS = 30;
const SAMPLE_RATE = 48_000;

function parseResult<T>(result: ToolResult): T {
  if (result.isError) throw new Error(result.content[0]!.text);
  return JSON.parse(result.content[0]!.text) as T;
}

async function runCmd(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(FFMPEG, ["-hide_banner", "-v", "error", "-y", ...args], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: testBudget(60_000),
  });
  return stdout;
}

async function countFrames(path: string): Promise<number> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path,
  ]);
  return Number.parseInt(stdout.trim(), 10);
}

async function frameSsim(rendered: string, renderedFrame: number, source: string, sourceFrame: number): Promise<number> {
  const stats = await runCmd([
    "-i", rendered,
    "-i", source,
    "-filter_complex",
    `[0:v]select='eq(n,${renderedFrame})',format=gray,setpts=PTS-STARTPTS[a];[1:v]select='eq(n,${sourceFrame})',format=gray,setpts=PTS-STARTPTS[b];[a][b]ssim=stats_file=-`,
    "-f", "null", "-",
  ]);
  const match = /All:([\d.]+)/u.exec(stats);
  if (!match) throw new Error(`ssim produced no score: ${stats}`);
  return Number(match[1]);
}

function cueListenStart(cue: { sound: BuiltinSoundId; startSeconds: number }): number {
  return Math.max(0, cue.startSeconds + builtinSound(cue.sound).accentSeconds - 0.05);
}

async function audioRmsWindow(path: string, startSeconds: number, durationSeconds: number): Promise<number> {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-hide_banner", "-v", "error",
    "-ss", String(startSeconds), "-t", String(durationSeconds),
    "-i", path,
    "-map", "0:a:0", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: testBudget(30_000) });
  const pcm = new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (const sample of pcm) sum += sample * sample;
  return Math.sqrt(sum / pcm.length);
}

describe("auto_edit tool", () => {
  let fixtureRoot = "";
  let root = "";
  let engine: Engine;
  let bookId = "";
  let assetId = "";
  let notebookId = "";
  let sourcePath = "";
  let sourceHash = "";

  const call = (args: Record<string, unknown> = {}) =>
    autoEditDef(engine).handler({ book_id: bookId, asset_id: "@a1", notebook_id: notebookId, ...args });

  const waitForJob = async (jobId: number) => {
    await expect.poll(() => engine.jobs.queue.get(jobId)?.state, { timeout: testBudget(90_000) })
      .toMatch(/done|failed|aborted/);
    const job = engine.jobs.queue.get(jobId)!;
    expect(job.error).toBeNull();
    expect(job.state).toBe("done");
    return job.result as { output_asset_id: string; cell_id: string; address: string; duration: number; frames: number };
  };

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "auto-edit-tool-fixtures-"));
    await runCmd([
      "-f", "lavfi", "-i", `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=6`,
      "-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=${SAMPLE_RATE}:d=6`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", join(fixtureRoot, "quiet-audio.mp4"),
    ]);
    await runCmd([
      "-i", join(fixtureRoot, "quiet-audio.mp4"),
      "-map", "0:v:0", "-c:v", "copy", "-an",
      join(fixtureRoot, "silent.mp4"),
    ]);
  }, testBudget(60_000));

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "auto-edit-tool-test-"));
    engine = createEngineForTest(root);
    registerAllJobHandlers(engine);
    await setEngineRoot(root, engine);
    bookId = engine.book.get().bookId;

    const created = await engine.artifacts.create({ kind: "video", label: "Original" });
    if (!created.ok) throw new Error(created.error.message);
    assetId = created.value.artifactId;
    await engine.files.writeFromPath(assetId, "original.mp4", join(fixtureRoot, "quiet-audio.mp4"));
    const manifest = await engine.files.manifest(assetId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    sourcePath = join(manifest.value.path, "original.mp4");
    sourceHash = manifest.value.files.find((file) => file.name === "original.mp4")!.objectHash;
    await registerMediaProbe(engine, assetId, "original.mp4", await probeVideo(sourcePath));

    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    await engine.notebooks.insertCell(
      notebookId,
      engine.notebooks.createCell({ type: "video", slot: { row: 0, column: 0 }, outputArtifactId: assetId }),
    );
  });

  afterEach(async () => {
    await queue.stop();
    closeEngineForTest(root, engine);
    await rm(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("advertises compact schemas and stays excluded from the chat router", () => {
    const def = autoEditDef(engine);
    const jsonSchema = toolInputJsonSchema(def.schema) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(jsonSchema.properties.anchors).toMatchObject({ type: "object" });
    expect(jsonSchema.properties.anchors).not.toHaveProperty("properties");
    expect(jsonSchema.properties.sections).toMatchObject({ type: "object" });
    expect(jsonSchema.properties.sections).not.toHaveProperty("properties");
    expect(jsonSchema.properties.plan).toMatchObject({ type: "object" });
    expect(jsonSchema.properties.plan).not.toHaveProperty("properties");
    expect(jsonSchema.properties.cues).toMatchObject({ type: "array" });
    expect(jsonSchema.properties.cues).not.toHaveProperty("items");

    const prompt = buildChatRoutingPrompt("book", buildRoutableTools(getAllToolDefs(engine)));
    expect(prompt).not.toContain("- auto_edit:");
  });

  it("returns default draft on get with no provider key, renders into a new cell, versions on second render, and forgets cleanly", async () => {
    const savedOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const initial = parseResult<AutoEditGetResponse>(await call({ op: "get" }));
      expect(initial.source).toMatchObject({
        artifact_id: assetId,
        source_hash: sourceHash,
        width: WIDTH,
        height: HEIGHT,
        fps: FPS,
        frames: 180,
        has_audio: true,
      });
      expect(initial.draft.default).toBe(true);
      expect(initial.last_render).toBeNull();
      expect(checkSegmentPlan(initial.plan)).toEqual([]);

      const anchors: AutoEditAnchors = {
        hook: { start: 1, end: 2.5 },
        moment: { start: 3.5, peak: 4, end: 4.5 },
        focus: { start: { x: 0.5, y: 0.5 }, peak: { x: 0.5, y: 0.5 }, end: { x: 0.5, y: 0.5 } },
        keep: { start: 0, end: 6 },
        cuts: [],
      };
      const req1 = randomUUID();
      const queued1 = parseResult<{ status: string; job_id: number; output_asset_id: string }>(
        await call({
          op: "render",
          source_hash: sourceHash,
          request_id: req1,
          anchors,
          sections: { ...DEFAULT_AUTO_EDIT_SECTIONS, sounds: true },
        }),
      );
      expect(queued1.status).toBe("queued");

      const repeated = parseResult<{ status: string; job_id: number; output_asset_id: string }>(
        await call({
          op: "render",
          source_hash: sourceHash,
          request_id: req1,
          anchors,
          sections: { ...DEFAULT_AUTO_EDIT_SECTIONS, sounds: true },
        }),
      );
      expect(repeated.job_id).toBe(queued1.job_id);
      expect(repeated.output_asset_id).toBe(queued1.output_asset_id);

      const conflicting = await call({
        op: "render",
        source_hash: sourceHash,
        request_id: req1,
        anchors: { ...anchors, hook: { start: 0, end: 2 } },
        sections: DEFAULT_AUTO_EDIT_SECTIONS,
      });
      expect(conflicting.isError).toBe(true);

      const result1 = await waitForJob(queued1.job_id);
      expect(result1.address).toBe("@b1");
      const notebookAfter1 = engine.notebooks.read(notebookId);
      if (!notebookAfter1.ok) throw new Error(notebookAfter1.error.message);
      expect(notebookAfter1.value.cells).toHaveLength(2);
      const outputCell1 = notebookAfter1.value.cells.find((cell) => cell.id === result1.cell_id)!;
      expect(outputCell1.label).toBe("Original — Auto-edit");

      const afterGet = parseResult<AutoEditGetResponse>(await call({ op: "get" }));
      expect(afterGet.draft.default).toBe(false);
      expect(afterGet.last_render).toMatchObject({
        output_asset_id: result1.output_asset_id,
        cell_id: result1.cell_id,
        address: "@b1",
        status: "completed",
      });

      const outManifest1 = await engine.files.manifest(result1.output_asset_id);
      if (!outManifest1.ok) throw new Error(outManifest1.error.message);
      const outPath1 = join(outManifest1.value.path, "original.mp4");
      const outProbe1 = await probeVideo(outPath1);
      expect(outProbe1).toMatchObject({ width: WIDTH, height: HEIGHT, fps: FPS, hasAudio: true });
      const expectedFrames = planOutputFrames(afterGet.plan);
      expect(result1.frames).toBe(expectedFrames);
      expect(await countFrames(outPath1)).toBe(expectedFrames);

      expect(await frameSsim(outPath1, 0, sourcePath, 30)).toBeGreaterThanOrEqual(0.96);
      expect(await frameSsim(outPath1, 20, sourcePath, 50)).toBeGreaterThanOrEqual(0.96);

      const starts = segmentOutputStartFrames(afterGet.plan);
      const crashIndex = afterGet.plan.segments.findIndex((segment) => segment.role === "crash");
      const crashMid = starts[crashIndex]! + 10;
      const crashSsim = await frameSsim(outPath1, crashMid, sourcePath, afterGet.plan.segments[crashIndex]!.startFrame + 5);
      expect(crashSsim).toBeLessThan(0.92);

      const firstCueTime = cueListenStart(afterGet.cues[0]!);
      const withSoundRms = await audioRmsWindow(outPath1, firstCueTime, 0.25);
      expect(withSoundRms).toBeGreaterThan(0.01);

      await waitForBookQueuesIdleForTests({ budgetMs: testBudget(60_000) });
      const processedManifest = await engine.files.manifest(result1.output_asset_id);
      if (!processedManifest.ok) throw new Error(processedManifest.error.message);
      const processedNames = processedManifest.value.files.map((file) => file.name);
      expect(processedNames).toEqual(expect.arrayContaining(["original.jpg", "proxy.mp4"]));
      expect(processedNames.some((name) => name.startsWith("original_frames/"))).toBe(true);
      const waveform = await engine.metadata.waveforms.read(result1.output_asset_id);
      expect(waveform.ok && waveform.value.peaks.length).toBeGreaterThan(0);
      expect(engine.jobs.queue.list({ type: "process_video", artifactId: result1.output_asset_id }).some((job) => job.state === "done")).toBe(true);
      expect(engine.jobs.queue.list({ type: "transcribe_video_audio", artifactId: result1.output_asset_id })).toEqual([]);
      expect(engine.jobs.queue.list({ type: "transcribe", artifactId: result1.output_asset_id })).toEqual([]);

      await pauseBookQueueForTests(bookId);
      process.env.OPENAI_API_KEY = "offline-auto-edit-key";
      const sweep = await reconcileProjectWork(engine, bookId);
      expect(sweep.auto_transcribe).toEqual([]);
      expect(sweep.auto_plain_transcript).toEqual([]);
      delete process.env.OPENAI_API_KEY;
      await resumeBookQueueForTests(bookId);

      const req2 = randomUUID();
      const queued2 = parseResult<{ status: string; job_id: number; output_asset_id: string }>(
        await call({
          op: "render",
          source_hash: sourceHash,
          request_id: req2,
          anchors,
          sections: { ...DEFAULT_AUTO_EDIT_SECTIONS, sounds: false },
        }),
      );
      const result2 = await waitForJob(queued2.job_id);
      expect(result2.cell_id).toBe(result1.cell_id);
      expect(result2.address).toBe("@b1");
      const notebookAfter2 = engine.notebooks.read(notebookId);
      if (!notebookAfter2.ok) throw new Error(notebookAfter2.error.message);
      expect(notebookAfter2.value.cells).toHaveLength(2);
      const versionedCell = notebookAfter2.value.cells.find((cell) => cell.id === result1.cell_id)!;
      expect(versionedCell.outputArtifactId).toBe(result2.output_asset_id);
      expect(versionedCell.inputs?.outputVersionArtifactIds).toEqual([result1.output_asset_id, result2.output_asset_id]);

      const outManifest2 = await engine.files.manifest(result2.output_asset_id);
      if (!outManifest2.ok) throw new Error(outManifest2.error.message);
      const outPath2 = join(outManifest2.value.path, "original.mp4");
      const withoutSoundRms = await audioRmsWindow(outPath2, firstCueTime, 0.4);
      expect(withoutSoundRms).toBeLessThan(0.002);

      const srcManifest = await engine.files.manifest(assetId);
      expect(srcManifest.ok && srcManifest.value.files.find((file) => file.name === "original.mp4")?.objectHash).toBe(sourceHash);

      expect(readStoredAutoEditDraft(engine, assetId)).not.toBeNull();
      const forgotten = await forgetAsset(engine, { assetId, clearReferences: true });
      expect(forgotten.status).toBe("forgotten");
      expect(readStoredAutoEditDraft(engine, assetId)).toBeNull();
    } finally {
      if (savedOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOpenAi;
    }
  }, testBudget(120_000));

  it("adds a sound stream with cues on a silent source", async () => {
    const silentPath = join(fixtureRoot, "silent.mp4");
    await engine.files.writeFromPath(assetId, "original.mp4", silentPath);
    await registerMediaProbe(engine, assetId, "original.mp4", await probeVideo(silentPath));
    const got = parseResult<AutoEditGetResponse>(await call({ op: "get" }));
    expect(got.source.has_audio).toBe(false);

    const queued = parseResult<{ status: string; job_id: number; output_asset_id: string }>(
      await call({
        op: "render",
        source_hash: got.source.source_hash,
        request_id: randomUUID(),
        anchors: got.draft.anchors,
        sections: { ...DEFAULT_AUTO_EDIT_SECTIONS, sounds: true },
      }),
    );
    const result = await waitForJob(queued.job_id);
    const manifest = await engine.files.manifest(result.output_asset_id);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const outPath = join(manifest.value.path, "original.mp4");
    const probe = await probeVideo(outPath);
    expect(probe.hasAudio).toBe(true);
    expect(await audioRmsWindow(outPath, cueListenStart(got.cues[0]!), 0.25)).toBeGreaterThan(0.01);
  }, testBudget(90_000));

  it("refuses stale source_hash, invalid plans, conflicting inputs, and full notebooks without creating an artifact", async () => {
    const stale = await call({ op: "render", source_hash: "stale", request_id: randomUUID() });
    expect(stale.isError).toBe(true);
    expect(engine.artifacts.list()).toHaveLength(1);

    const both = await call({
      op: "render",
      source_hash: sourceHash,
      request_id: randomUUID(),
      anchors: parseResult<AutoEditGetResponse>(await call({ op: "get" })).draft.anchors,
      plan: parseResult<AutoEditGetResponse>(await call({ op: "get" })).plan,
    });
    expect(both.isError).toBe(true);
    expect(engine.artifacts.list()).toHaveLength(1);

    const badPlan: SegmentPlan = {
      version: 1,
      source: { artifactId: assetId, sourceHash, fps: FPS, frames: 180, width: WIDTH, height: HEIGHT, hasAudio: true },
      segments: [{ id: "oob", role: "body", startFrame: 0, endFrame: 300, speed: 1, motion: "repeat", audio: "source", look: "none" }],
    };
    const invalid = await call({
      op: "render",
      source_hash: sourceHash,
      request_id: randomUUID(),
      plan: badPlan,
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]!.text).toContain("outside");
    expect(engine.artifacts.list()).toHaveLength(1);

    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const cells = Array.from({ length: 512 }, (_, index) => engine.notebooks.createCell({
      type: "video",
      slot: { row: Math.floor(index / 8), column: index % 8 },
      ...(index === 0 ? { outputArtifactId: assetId } : {}),
    }));
    const filled = await engine.notebooks.write({ ...notebook.value, cells });
    expect(filled.ok).toBe(true);
    const full = await call({ op: "render", source_hash: sourceHash, request_id: randomUUID() });
    expect(full.isError).toBe(true);
    expect(full.content[0]!.text).toContain("one empty cell");
    expect(engine.artifacts.list()).toHaveLength(1);
  });
});
