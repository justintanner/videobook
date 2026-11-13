import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngineForTest } from "../engine.js";
import { pauseBookQueueForTests, resumeBookQueueForTests } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";
import { goalTestCharacters, settleGoalChain } from "../test-goals.js";
import { v7 as uuidv7 } from "uuid";
import { readGoal, saveGoal } from "../goal-store.js";
import { probeVideo } from "../ffmpeg.js";
import { createShortGoal } from "../goal-short-runtime.js";
import type { ShortGoalSnapshot } from "./goal.js";

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
  const settleChain = (chainId: string, kind: "image" | "video") => settleGoalChain(engine, root, chainId, kind);

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
});
