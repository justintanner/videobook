import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngineForTest } from "../engine.js";
import { pauseBookQueueForTests, resumeBookQueueForTests } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { copyVideoFixture } from "../test-media-fixtures.js";
import { testBudget } from "../test-budget.js";
import { goalTestCharacters, settleGoalChain } from "../test-goals.js";
import { v7 as uuidv7 } from "uuid";
import { readGoal, saveGoal } from "../goal-store.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { withShortFinishTitle, type ShortFinishTitle } from "../goal-short-plan.js";
import { createShortGoal } from "../goal-short-runtime.js";
import type { ShortGoalSnapshot } from "./goal.js";

const execFileAsync = promisify(execFile);
const FIRST_TITLE: ShortFinishTitle = { headline: "รอรถเมล์กลางฝน", secondary: "Waiting for the bus in the rain" };
const SECOND_TITLE: ShortFinishTitle = { headline: "ฝนตกหนักมาก\nแต่รถเมล์ไม่มา", secondary: "The rain came. The bus did not." };

type BottomHalf = { blue: number; white: Set<number> };

async function bottomHalf(path: string, seconds = 1.5): Promise<BottomHalf> {
  const { width, height } = await probeVideo(path);
  const { stdout } = await execFileAsync(FFMPEG, ["-v", "error", "-ss", String(seconds), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: width * height * 4 });
  const white = new Set<number>();
  const shade: number[] = [];
  for (let pixel = width * Math.floor(height / 2); pixel < width * height; pixel += 1) {
    const [red, green, blue] = [stdout[pixel * 3]!, stdout[pixel * 3 + 1]!, stdout[pixel * 3 + 2]!];
    if (red > 128 && green > 128) white.add(pixel);
    else shade.push(blue);
  }
  return { blue: shade.reduce((sum, value) => sum + value, 0) / shade.length, white };
}

async function videoPath(engine: Engine, artifactId: string): Promise<string> {
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  return join(manifest.value.path, "original.mp4");
}

describe("goal finishing burns the saved watermark through the graphics renderer", () => {
  let root: string;
  let client: Client;
  let engine: Engine;
  let bookId: string;
  let notebookId: string;
  let oldOpenAi: string | undefined;

  beforeEach(async () => {
    oldOpenAi = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-goal-key";
    root = await mkdtemp(join(tmpdir(), "videobook-goal-finish-e2e-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    const notebook = await engine.notebooks.create("Goals");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    await goalTestCharacters(engine, notebookId);
  });

  afterEach(async () => {
    await client?.close();
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAi;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const raw = (args: Record<string, unknown>) => client.callTool({ name: "video_goal", arguments: { book_id: bookId, notebook_id: notebookId, ...args } });
  async function invoke(args: Record<string, unknown>): Promise<ShortGoalSnapshot> {
    const result = await raw(args);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(result.isError, text).toBeFalsy();
    return JSON.parse(text) as ShortGoalSnapshot;
  }
  const status = (goalId: string) => invoke({ action: "status", goal_id: goalId });
  const approve = (goal: ShortGoalSnapshot) => invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision });
  const settleChain = async (chainId: string, kind: "image" | "video") => {
    const artifactId = await settleGoalChain(engine, root, chainId, kind);
    if (kind === "video") {
      const scratch = join(root, "portrait.mp4");
      await copyVideoFixture({ width: 360, height: 640, durationSec: 4, fps: 12, source: "color", color: "blue", audio: { frequency: 440 } }, scratch);
      const written = await engine.files.writeFromPath(artifactId, "original.mp4", scratch);
      if (!written.ok) throw new Error(written.error.message);
      await registerMediaProbe(engine, artifactId, "original.mp4", await probeVideo(scratch));
    }
    return artifactId;
  };

  it.each(["new", "saved-running", "saved-failed"])("finishes %s from the reviewed take with only a burned watermark", async (savedState) => {
    const oldFal = process.env.FAL_API_KEY;
    process.env.FAL_API_KEY = "test-goal-key";
    try {
      await pauseBookQueueForTests(bookId);
      const created = await createShortGoal(engine, bookId, notebookId, { brief: 'he waits, frame: "A bus stop at dusk." beat 1: "He checks the road."', requestId: uuidv7() });
      const frame = await approve(await status(created.goalId));
      await settleChain(frame.chainId!, "image");
      const clip = await approve(await status(created.goalId));
      const clipId = await settleChain(clip.chainId!, "video");
      expect((await status(created.goalId)).finish).toMatchObject({ status: "review", sourceArtifactId: clipId });
      if (savedState === "saved-failed") {
        const saved = readGoal(engine, created.goalId);
        saveGoal(engine, { ...saved, finish: { ...saved.finish!, status: "failed", startSeconds: 0, endSeconds: 0.5, coldOpenRequestId: uuidv7(), coldOpenArtifactId: clipId } });
      }
      const queued = await invoke({ action: "finish", goal_id: created.goalId });
      expect(queued.coldOpen).toBeNull();
      expect(queued.finish?.startSeconds).toBeUndefined();
      if (savedState === "saved-running") {
        const saved = readGoal(engine, created.goalId);
        saveGoal(engine, { ...saved, finish: { ...saved.finish!, startSeconds: 0, endSeconds: 0.5, coldOpenRequestId: uuidv7(), coldOpenArtifactId: clipId } });
        expect((await invoke({ action: "finish", goal_id: created.goalId })).finish?.jobId).toBe(queued.finish?.jobId);
      }
      expect(queued.finish).toMatchObject({ status: "running", sourceArtifactId: clipId });
      await resumeBookQueueForTests(bookId);
      let finished: ShortGoalSnapshot | null = null;
      await expect.poll(async () => {
        finished = await status(created.goalId);
        return `${finished.status}:${finished.finish?.status ?? "none"}:${finished.finish?.error ?? ""}`;
      }, { timeout: testBudget(120_000), interval: 500 }).toBe("completed:completed:");
      const done = finished as ShortGoalSnapshot | null;
      expect(done?.finalArtifactId).toEqual(expect.any(String));
      expect(done?.finalArtifactId).not.toBe(clipId);
      expect(engine.jobs.queue.list({ type: "edit_cold_open" })).toHaveLength(0);
      expect(engine.jobs.queue.list({ type: "prepare_cold_open" })).toHaveLength(0);
      const manifest = await engine.files.manifest(done!.finalArtifactId!);
      if (!manifest.ok) throw new Error(manifest.error.message);
      const probe = await probeVideo(join(manifest.value.path, "original.mp4"));
      expect(probe.videoDuration).toBeCloseTo(4, 1);
      expect(probe).toMatchObject({ width: 360, height: 640 });
      const late = await bottomHalf(join(manifest.value.path, "original.mp4"), 3.6);
      expect(late.white.size).toBeGreaterThan(20);
      expect(Math.min(...late.white) / probe.width).toBeGreaterThan(probe.height * 0.7);
      expect(late.blue).toBeGreaterThan(240);
      const saved = readGoal(engine, created.goalId);
      saveGoal(engine, { ...saved, finish: { ...saved.finish!, startSeconds: 0, endSeconds: 0.5, coldOpenArtifactId: clipId, coldOpenRequestId: uuidv7() } });
      const before = engine.jobs.queue.list().length;
      const preserved = await invoke({ action: "finish", goal_id: created.goalId });
      expect(preserved.finalArtifactId).toBe(done!.finalArtifactId);
      expect(preserved.finish?.startSeconds).toBe(0);
      expect(engine.jobs.queue.list()).toHaveLength(before);
      expect(await engine.files.manifest(done!.finalArtifactId!)).toEqual(manifest);
      expect(engine.jobs.queue.list({ type: "burn_watermark" }).length).toBeGreaterThan(0);
      const finalOriginal = await engine.metadata.artifacts.read<Record<string, unknown>>(done!.finalArtifactId!, "original");
      expect(finalOriginal.ok && finalOriginal.value).toMatchObject({ origin: "watermark", transcribe: false });
    } finally {
      await pauseBookQueueForTests(bookId);
      if (oldFal === undefined) delete process.env.FAL_API_KEY; else process.env.FAL_API_KEY = oldFal;
    }
  }, testBudget(300_000));

  it("burns the short's Thai title and English line, and a changed title finishes again from the reviewed take", async () => {
    const oldFal = process.env.FAL_API_KEY;
    process.env.FAL_API_KEY = "test-goal-key";
    const finished = async (goalId: string) => {
      await resumeBookQueueForTests(bookId);
      let done: ShortGoalSnapshot | null = null;
      await expect.poll(async () => {
        done = await status(goalId);
        return `${done.status}:${done.finish?.status ?? "none"}:${done.finish?.error ?? ""}`;
      }, { timeout: testBudget(120_000), interval: 500 }).toBe("completed:completed:");
      await pauseBookQueueForTests(bookId);
      return (done as ShortGoalSnapshot | null)!.finalArtifactId!;
    };
    try {
      await pauseBookQueueForTests(bookId);
      const created = await createShortGoal(engine, bookId, notebookId, { brief: 'he waits, frame: "A bus stop at dusk." beat 1: "He checks the road."', requestId: uuidv7() });
      const frame = await approve(await status(created.goalId));
      await settleChain(frame.chainId!, "image");
      const clip = await approve(await status(created.goalId));
      const clipId = await settleChain(clip.chainId!, "video");
      const reviewed = await status(created.goalId);
      const titled = await invoke({ action: "update", goal_id: created.goalId, revision: reviewed.revision, plan: withShortFinishTitle(reviewed.shortPlan!, FIRST_TITLE) });
      await invoke({ action: "finish", goal_id: created.goalId });
      const first = await finished(created.goalId);

      const retitled = await invoke({ action: "update", goal_id: created.goalId, revision: titled.revision, plan: withShortFinishTitle(titled.shortPlan!, SECOND_TITLE) });
      expect(retitled).toMatchObject({ status: "review", finalArtifactId: null, finish: { status: "review", sourceArtifactId: clipId } });
      await invoke({ action: "finish", goal_id: created.goalId });
      const second = await finished(created.goalId);
      expect(second).not.toBe(first);

      const burns = engine.jobs.queue.list({ type: "burn_watermark" }).map(job => job.payload as { assetId: string; headline?: string; secondary?: string });
      expect(burns.filter(burn => burn.assetId === first)).toEqual([expect.objectContaining({ headline: FIRST_TITLE.headline, secondary: FIRST_TITLE.secondary })]);
      expect(burns.filter(burn => burn.assetId === second)).toEqual([expect.objectContaining({ headline: SECOND_TITLE.headline, secondary: SECOND_TITLE.secondary })]);

      const take = await bottomHalf(await videoPath(engine, clipId));
      const once = await bottomHalf(await videoPath(engine, first));
      const again = await bottomHalf(await videoPath(engine, second));
      expect(take.white.size).toBe(0);
      expect(once.white.size).toBeGreaterThan(20);
      expect(again.white.size).toBeGreaterThan(20);
      expect(once.blue).toBeLessThan(take.blue - 40);
      expect(Math.abs(again.blue - once.blue)).toBeLessThan(15);
      const moved = [...again.white].filter(pixel => !once.white.has(pixel)).length + [...once.white].filter(pixel => !again.white.has(pixel)).length;
      expect(moved).toBeGreaterThan(Math.min(once.white.size, again.white.size) / 2);
    } finally {
      await pauseBookQueueForTests(bookId);
      if (oldFal === undefined) delete process.env.FAL_API_KEY; else process.env.FAL_API_KEY = oldFal;
    }
  }, testBudget(300_000));
});
