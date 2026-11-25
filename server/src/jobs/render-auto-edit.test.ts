import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Engine } from "videobook-engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { latestAutoEditRender } from "../auto-edit/drafts.js";
import type { SegmentPlan } from "../auto-edit/plan.js";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { FFMPEG, FFPROBE, probeVideo } from "../ffmpeg.js";
import { registerAllJobHandlers } from "../jobs/index.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { queue, setEngineRoot } from "../queue.js";
import { testBudget } from "../test-budget.js";
import { autoEditDef } from "../tools/auto-edit.js";
import { cancelJobDef } from "../tools/cancel-job.js";
import type { ToolResult } from "../tools/tool-def.js";

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

describe("render_auto_edit job", () => {
  let fixtureRoot = "";
  let root = "";
  let engine: Engine;
  let bookId = "";
  let assetId = "";
  let notebookId = "";
  let sourceHash = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "render-auto-edit-fixtures-"));
    await runCmd([
      "-f", "lavfi", "-i", `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=4`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p",
      "-an", join(fixtureRoot, "silent4s.mp4"),
    ]);
  }, testBudget(60_000));

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "render-auto-edit-test-"));
    engine = createEngineForTest(root);
    registerAllJobHandlers(engine);
    await setEngineRoot(root, engine);
    bookId = engine.book.get().bookId;

    const created = await engine.artifacts.create({ kind: "video", label: "Clip" });
    if (!created.ok) throw new Error(created.error.message);
    assetId = created.value.artifactId;
    const clipPath = join(fixtureRoot, "silent4s.mp4");
    await engine.files.writeFromPath(assetId, "original.mp4", clipPath);
    const manifest = await engine.files.manifest(assetId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    sourceHash = manifest.value.files.find((file) => file.name === "original.mp4")!.objectHash;
    await registerMediaProbe(engine, assetId, "original.mp4", await probeVideo(clipPath));

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

  it("renders an explicit segment plan with cues to the exact planned frame count", async () => {
    const plan: SegmentPlan = {
      version: 1,
      source: { artifactId: assetId, sourceHash, fps: FPS, frames: 120, width: WIDTH, height: HEIGHT, hasAudio: false },
      segments: [
        { id: "open", role: "cold_open", startFrame: 60, endFrame: 90, speed: 1, motion: "repeat", audio: "mute", look: "none" },
        { id: "hit", role: "crash", startFrame: 30, endFrame: 60, speed: 0.5, motion: "blend", audio: "mute", look: "invert" },
      ],
    };
    const queued = parseResult<{ status: string; job_id: number; output_asset_id: string }>(
      await autoEditDef(engine).handler({
        book_id: bookId,
        asset_id: assetId,
        notebook_id: notebookId,
        op: "render",
        source_hash: sourceHash,
        request_id: randomUUID(),
        plan,
        cues: [{ sound: "impact", startSeconds: 1, volume: 70 }],
      }),
    );

    await expect.poll(() => engine.jobs.queue.get(queued.job_id)?.state, { timeout: testBudget(60_000) })
      .toMatch(/done|failed|aborted/);
    const job = engine.jobs.queue.get(queued.job_id)!;
    expect(job.error).toBeNull();
    expect(job.state).toBe("done");
    const result = job.result as { output_asset_id: string; frames: number; address: string };
    expect(result.frames).toBe(90);
    expect(result.address).toBe("@a2");

    const manifest = await engine.files.manifest(result.output_asset_id);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const outPath = join(manifest.value.path, "original.mp4");
    expect(await countFrames(outPath)).toBe(90);
    expect((await probeVideo(outPath)).hasAudio).toBe(true);
    expect(await audioRmsWindow(outPath, 1, 0.3)).toBeGreaterThan(0.01);
  }, testBudget(90_000));

  it("stops FFmpeg on cancel_job and records failure on the output without touching the source", async () => {
    const slowPlan: SegmentPlan = {
      version: 1,
      source: { artifactId: assetId, sourceHash, fps: FPS, frames: 120, width: WIDTH, height: HEIGHT, hasAudio: false },
      segments: [
        { id: "slow", role: "crash", startFrame: 0, endFrame: 120, speed: 0.25, motion: "flow", audio: "mute", look: "crash" },
      ],
    };
    const queued = parseResult<{ status: string; job_id: number; output_asset_id: string }>(
      await autoEditDef(engine).handler({
        book_id: bookId,
        asset_id: assetId,
        notebook_id: notebookId,
        op: "render",
        source_hash: sourceHash,
        request_id: randomUUID(),
        plan: slowPlan,
      }),
    );

    await expect.poll(() => engine.jobs.queue.get(queued.job_id)?.state, { timeout: testBudget(15_000) })
      .toBe("running");

    const cancel = await cancelJobDef(engine).handler({ book_id: bookId, job_id: queued.job_id });
    expect(cancel.isError).toBeFalsy();

    await expect.poll(() => engine.jobs.queue.get(queued.job_id)?.state, { timeout: testBudget(30_000) })
      .toMatch(/aborted|failed/);

    const lastRender = latestAutoEditRender(engine, assetId);
    expect(lastRender?.status).toBe("failed");
    const outManifest = await engine.files.manifest(queued.output_asset_id);
    expect(outManifest.ok && outManifest.value.files.some((file) => file.name === "original.mp4")).toBe(false);

    const srcStatus = await engine.status.get(assetId);
    expect(srcStatus.ok && srcStatus.value).toBe("ready");
    const srcManifest = await engine.files.manifest(assetId);
    expect(srcManifest.ok && srcManifest.value.files.find((file) => file.name === "original.mp4")?.objectHash).toBe(sourceHash);
  }, testBudget(90_000));
});
