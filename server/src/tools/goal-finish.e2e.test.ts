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
import { saveMainCharacter } from "../goal-short-character.js";
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
  const notebook = () => {
    const result = engine.notebooks.read(notebookId);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  const settleChain = (chainId: string, kind: "image" | "video") => settleGoalChain(engine, root, chainId, kind);

  it("finishes a short from its current clip with a cold open and a burned watermark", async () => {
    const oldFal = process.env.FAL_API_KEY;
    process.env.FAL_API_KEY = "test-goal-key";
    try {
      const character = notebook().cells.find((cell) => cell.type === "image" && cell.outputArtifactId)!.outputArtifactId!;
      saveMainCharacter(engine, { referenceArtifactIds: [character] });
      await pauseBookQueueForTests(bookId);
      const created = await createShortGoal(engine, bookId, notebookId, { brief: 'he waits, frame: "A bus stop at dusk." beat 1: "He checks the road."', requestId: uuidv7() });
      const frame = await approve(await status(created.goalId));
      await settleChain(frame.chainId!, "image");
      const clip = await approve(await status(created.goalId));
      const clipId = await settleChain(clip.chainId!, "video");
      expect((await status(created.goalId)).finish).toMatchObject({ status: "review", sourceArtifactId: clipId });
      const queued = await invoke({ action: "finish", goal_id: created.goalId, start_seconds: 0, end_seconds: 0.5 });
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
      expect(engine.jobs.queue.list({ type: "burn_watermark" }).length).toBeGreaterThan(0);
    } finally {
      await pauseBookQueueForTests(bookId);
      if (oldFal === undefined) delete process.env.FAL_API_KEY; else process.env.FAL_API_KEY = oldFal;
    }
  }, testBudget(300_000));
});
