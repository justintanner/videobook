import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { createEngineForTest } from "../engine.js";
import { createTestClient } from "../test-client.js";
import { pauseBookQueueForTests } from "../queue.js";
import { cancelChainRun, getChainRun, waitForChainRun } from "../chain-executor.js";
import { compileFrameSteps, compileStoryboardSteps, compileVideoSteps, goalBriefConstraints, goalPlanSchema, GOAL_IMAGE_TOOLS, GOAL_VIDEO_TOOL } from "../goal-plan.js";
import { readGoal, saveGoal } from "../goal-store.js";
import { goalPlannerBrief } from "../goal-characters.js";
import { LEGACY_GOAL_MESSAGE } from "../goal-state.js";
import { appendGoalClips } from "../jobs/assemble-goal.js";
import { goalTestCharacters, goalTestPlan, goalTestVideo, seedGoalStage } from "../test-goals.js";
import type { GoalSnapshot } from "./goal.js";

const brief = "@a1@a2 make a funny video of a dog on a skateboard, three 10s clips";
const plan = goalTestPlan();
const characters = [0, 1].map(index => ({ artifactId: uuidv7(), cellId: uuidv7(), address: `@a${index + 1}`, label: `Character ${index + 1}` }));

describe("video goal plans", () => {
  it("requires v2 prompts, bounded shots and supported output settings", () => {
    expect(goalPlanSchema.parse(plan)).toEqual(plan);
    const { version: _version, ...legacy } = plan;
    expect(goalPlanSchema.safeParse(legacy).success).toBe(false);
    expect(goalPlanSchema.safeParse({ ...plan, shots: [] }).success).toBe(false);
    expect(goalPlanSchema.safeParse({ ...plan, frame: { prompt: "Make @a1 the hero" } }).success).toBe(false);
    expect(goalPlanSchema.safeParse({ ...plan, shots: Array(9).fill(plan.shots[0]) }).success).toBe(false);
    expect(goalBriefConstraints(brief)).toEqual({ shotCount: 3, durationSeconds: 10, aspectRatio: "16:9" });
    expect(goalBriefConstraints("four 8-second clips, portrait")).toEqual({ shotCount: 4, durationSeconds: 8, aspectRatio: "9:16" });
    expect(goalBriefConstraints("2 x 12s, square")).toEqual({ shotCount: 2, durationSeconds: 12, aspectRatio: "1:1" });
    expect(() => goalBriefConstraints("12 clips of 10s")).toThrow("1–8");
    expect(() => goalBriefConstraints("3 clips of 4.5s")).toThrow("whole number");
    expect(() => goalBriefConstraints("three 90-second clips")).toThrow("4 to 30");
  });

  it("compiles three separately approved stages with ordered references and input legends", () => {
    const frame = compileFrameSteps(plan, characters);
    expect(frame).toHaveLength(1);
    expect(frame[0]).toMatchObject({ id: "frame", tool: GOAL_IMAGE_TOOLS.sunburst, params: { image_refs: ["@a1", "@a2"], resolution: "2K" } });
    expect(frame[0]!.params.prompt).toContain("@image1 is Character 1");
    const storyboards = compileStoryboardSteps(plan, characters, "@b2");
    expect(storyboards).toHaveLength(3);
    expect(storyboards[1]).toMatchObject({ id: "storyboard2", params: { image_refs: ["@b2", "@a1", "@a2"] } });
    expect(storyboards[1]!.params.prompt).toContain("@image1 is the approved full frame");
    expect(storyboards[1]!.params.prompt).toContain("@image2 is Character 1");
    expect(compileStoryboardSteps(plan, characters, "@b2", [1]).map(step => step.id)).toEqual(["storyboard2"]);
    const videos = compileVideoSteps(uuidv7(), plan, characters, ["@c1", "@c2", "@c3"]);
    expect(videos).toHaveLength(4);
    expect(videos[1]).toMatchObject({ id: "shot2", tool: GOAL_VIDEO_TOOL, params: { first_frame_ref: "@c2", duration: "10", aspect_ratio: "16:9", resolution: "720p", generate_audio: true } });
    expect(videos[1]!.params.image_refs).toBeUndefined();
    expect(videos[1]!.params.prompt).toContain("@firstframe is this shot's approved storyboard");
    expect(videos[3]!.params.artifact_ids).toEqual([1, 2, 3].map(index => ({ $ref: { step_id: `shot${index}`, output: "asset_id" } })));
    expect(compileVideoSteps(uuidv7(), goalTestPlan(1), characters, ["@c1"])).toHaveLength(1);
    for (const step of [...frame, ...storyboards, ...videos.slice(0, 3)]) {
      expect(step.params.prompt).toContain(plan.continuity);
      expect(step.params.prompt).not.toMatch(/@[abc][1-8]/u);
    }
    expect(goalPlannerBrief(brief, characters)).toContain("Character 1 Character 2");
  });
});

describe("staged video goals through MCP", () => {
  let root: string;
  let client: Client;
  let engine: Engine;
  let bookId: string;
  let notebookId: string;
  let imageIds: string[];
  let oldKie: string | undefined;
  let oldOpenAi: string | undefined;

  beforeEach(async () => {
    oldKie = process.env.KIE_API_KEY;
    oldOpenAi = process.env.OPENAI_API_KEY;
    process.env.KIE_API_KEY = "test-goal-key";
    process.env.OPENAI_API_KEY = "test-goal-key";
    root = await mkdtemp(join(tmpdir(), "videobook-staged-goal-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    const notebook = await engine.notebooks.create("Goals");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    imageIds = await goalTestCharacters(engine, notebookId);
  });

  afterEach(async () => {
    await client?.close();
    if (oldKie === undefined) delete process.env.KIE_API_KEY; else process.env.KIE_API_KEY = oldKie;
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAi;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const raw = (args: Record<string, unknown>, tool = "video_goal") => client.callTool({ name: tool, arguments: { book_id: bookId, notebook_id: notebookId, ...args } });
  async function invoke<T = GoalSnapshot>(args: Record<string, unknown>, tool?: string): Promise<T> {
    const result = await raw(args, tool);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(result.isError, text).toBeFalsy();
    return JSON.parse(text) as T;
  }
  const create = (extra: Record<string, unknown> = {}) => invoke({ action: "create", brief, plan, ...extra });
  const status = (goalId: string) => invoke({ action: "status", goal_id: goalId });
  const approve = (goal: GoalSnapshot) => invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision });
  const notebook = () => {
    const result = engine.notebooks.read(notebookId);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  async function advance(goal: GoalSnapshot, stage: "frame" | "storyboards") {
    await seedGoalStage(engine, goal.goalId, stage);
    return status(goal.goalId);
  }

  it("resolves adjacent image mentions, saves character edges and per-stage estimates, and fences invalid inputs", async () => {
    const goal = await create({ request_id: "same-request" });
    expect(goal).toMatchObject({ planVersion: 2, stage: "frame", status: "review", revision: 1, address: "@a3", plan });
    expect(goal.characters.map(character => character.artifactId)).toEqual(imageIds);
    expect(notebook().edges.filter(edge => edge.target === goal.cellId).map(edge => edge.targetInput)).toEqual(["character", "character_2"]);
    expect(notebook().cells.find(cell => cell.id === goal.cellId)?.inputs).toMatchObject({ characters: goal.characters, plan, estimate: goal.estimate });
    expect(goal.estimate.frame.usd).toBeGreaterThan(0);
    expect(goal.estimate.total.usd).toBeCloseTo(goal.estimate.frame.usd! + goal.estimate.storyboards.usd! + goal.estimate.videos.usd!);
    expect((await create({ request_id: "same-request" })).goalId).toBe(goal.goalId);
    expect(engine.jobs.queue.list()).toHaveLength(0);
    expect((await raw({ action: "create", brief: "A dog rides a skateboard", plan })).content).toEqual([expect.objectContaining({ text: expect.stringContaining("Mention the character images") })]);
    expect((await raw({ action: "create", brief: "@h8 goes skating", plan })).isError).toBe(true);
    const video = await engine.artifacts.create("video", "not an image");
    if (!video.ok) throw new Error(video.error.message);
    await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({ type: "video", slot: { row: 0, column: 3 }, outputArtifactId: video.value.artifactId }));
    expect((await raw({ action: "create", brief: "@a4 goes skating", plan })).content).toEqual([expect.objectContaining({ text: "@a4 is not an image" })]);
    expect((await invoke<{ goals: GoalSnapshot[] }>({ action: "list" })).goals).toHaveLength(1);
    expect((await create({ brief: "@a1 @a1 skate" })).characters).toHaveLength(1);
  });

  it("saves edits by revision and queues only the approved frame with character provenance", async () => {
    const goal = await create();
    const changed = { ...plan, shots: plan.shots.map(shot => ({ ...shot, durationSeconds: 12 })) };
    const updated = await invoke({ action: "update", goal_id: goal.goalId, revision: 1, plan: changed });
    expect(updated.revision).toBe(2);
    expect(updated.estimate.videos.usd).toBeGreaterThan(goal.estimate.videos.usd!);
    expect((await raw({ action: "approve", goal_id: goal.goalId, revision: 1 })).isError).toBe(true);
    await pauseBookQueueForTests(bookId);
    const started = await approve(updated);
    await expect.poll(() => getChainRun(engine, started.chainId!)?.steps[0]?.childJobIds.length).toBe(1);
    const chain = getChainRun(engine, started.chainId!)!;
    expect(chain.steps).toHaveLength(1);
    expect(chain.steps[0]!.approval?.actor).toBe("chat");
    expect((await approve(updated)).chainId).toBe(started.chainId);
    const jobs = engine.jobs.queue.list({ type: "generate_gpt_image_2_5" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ sourceImageIds: imageIds, input: { resolution: "2K", aspect_ratio: "16:9" } });
    expect(engine.jobs.queue.list({ type: "generate_seedance25_video" })).toHaveLength(0);
    await expect.poll(() => notebook().cells.some(cell => cell.inputs?.chainRunId === `${started.chainId}:frame`)).toBe(true);
    const producer = notebook().cells.find(cell => cell.inputs?.chainRunId === `${started.chainId}:frame`)!;
    expect(producer).toMatchObject({ type: "generate_image", tool: GOAL_IMAGE_TOOLS.sunburst, inputs: { resolution: "2K", aspect_ratio: "16:9" } });
    expect(notebook().edges.filter(edge => edge.target === producer.id).map(edge => edge.source)).toEqual(goal.characters.map(character => character.cellId));
    expect((await invoke({ action: "cancel", goal_id: goal.goalId })).status).toBe("cancelled");
    await waitForChainRun(engine, started.chainId!);
  });

  it("advances completed frames and storyboards to separate reviews and pins their inputs for the next stage", async () => {
    const goal = await create();
    const frame = await advance(goal, "frame");
    expect(frame).toMatchObject({ status: "review", stage: "storyboards", revision: 2 });
    expect(frame.stages.frame?.outputs[0]?.artifactId).toBeTruthy();
    expect((await raw({ action: "approve", goal_id: goal.goalId, revision: 1 })).isError).toBe(true);
    await pauseBookQueueForTests(bookId);
    const boards = await approve(frame);
    await expect.poll(() => getChainRun(engine, boards.chainId!)?.steps[0]?.childJobIds.length).toBe(1);
    const boardChain = getChainRun(engine, boards.chainId!)!;
    expect(boardChain.steps.map(step => step.id)).toEqual(["storyboard1", "storyboard2", "storyboard3"]);
    expect(boardChain.steps[0]!.pins.map(pin => pin.artifactId)).toEqual([frame.stages.frame!.outputs[0]!.artifactId, ...imageIds]);
    cancelChainRun(engine, boards.chainId!);
    await waitForChainRun(engine, boards.chainId!);
    const ready = await advance(boards, "storyboards");
    expect(ready).toMatchObject({ status: "review", stage: "videos", revision: 3 });
    const videos = await approve(ready);
    await expect.poll(() => {
      const current = getChainRun(engine, videos.chainId!);
      if (current?.error) throw new Error(current.error);
      return current?.steps[0]?.childJobIds.length;
    }).toBe(1);
    const chain = getChainRun(engine, videos.chainId!)!;
    expect(chain.steps.map(step => step.id)).toEqual(["shot1", "shot2", "shot3", "assemble"]);
    expect(chain.steps[0]!.pins.find(pin => pin.field === "first_frame_ref")?.artifactId).toBe(ready.stages.storyboards!.outputs[0]!.artifactId);
    expect(chain.steps[0]!.pins.map(pin => pin.field)).toEqual(["first_frame_ref"]);
    expect(notebook().cells.some(cell => cell.type === "timeline")).toBe(true);
    await invoke({ action: "cancel", goal_id: goal.goalId });
    await waitForChainRun(engine, videos.chainId!);
    expect(getChainRun(engine, videos.chainId!)!.steps.slice(1).every(step => step.status === "skipped")).toBe(true);
  });

  it("regenerates only the chosen storyboard and preserves other outputs and earlier tiles", async () => {
    const ready = await advance(await advance(await create(), "frame"), "storyboards");
    const before = ready.stages.storyboards!.outputs;
    expect((await raw({ action: "regenerate", goal_id: ready.goalId, revision: ready.revision - 1, shot_indexes: [1] })).isError).toBe(true);
    await pauseBookQueueForTests(bookId);
    const regenerating = await invoke({ action: "regenerate", goal_id: ready.goalId, revision: ready.revision, shot_indexes: [1] });
    await expect.poll(() => getChainRun(engine, regenerating.chainId!)?.steps[0]?.childJobIds.length).toBe(1);
    expect(getChainRun(engine, regenerating.chainId!)?.steps.map(step => step.id)).toEqual(["storyboard2"]);
    expect(regenerating.stages.storyboards!.outputs).toEqual(before);
    cancelChainRun(engine, regenerating.chainId!);
    await waitForChainRun(engine, regenerating.chainId!);
    await seedGoalStage(engine, ready.goalId, "storyboards", { indexes: [1] });
    const after = await status(ready.goalId);
    expect(after.stages.storyboards!.outputs[0]).toEqual(before[0]);
    expect(after.stages.storyboards!.outputs[2]).toEqual(before[2]);
    expect(after.stages.storyboards!.outputs[1]!.artifactId).not.toBe(before[1]!.artifactId);
    expect(before.every(output => notebook().cells.some(cell => cell.id === output.cellId))).toBe(true);
    expect(after.stages.storyboards!.allSteps.length).toBeGreaterThan(3);
  });

  it("rejects changed approved prompts until their frames are regenerated and keeps references tied to cell identity", async () => {
    const ready = await advance(await create(), "frame");
    const updated = await invoke({ action: "update", goal_id: ready.goalId, revision: ready.revision, plan: { ...plan, frame: { prompt: "A closer view of both characters" } } });
    expect((await raw({ action: "approve", goal_id: ready.goalId, revision: updated.revision })).content).toEqual([expect.objectContaining({ text: expect.stringContaining("Regenerate the frame") })]);
    const moved = notebook();
    await engine.notebooks.write({ ...moved, cells: moved.cells.map(cell => cell.id === ready.characters[0]!.cellId ? { ...cell, slot: { row: 7, column: 0 } } : cell) });
    await pauseBookQueueForTests(bookId);
    const regenerate = await invoke({ action: "regenerate", goal_id: ready.goalId, revision: updated.revision });
    expect(getChainRun(engine, regenerate.chainId!)?.steps[0]?.pins[0]?.address).toMatch(/h1/u);
    await invoke({ action: "cancel", goal_id: ready.goalId });
    await waitForChainRun(engine, regenerate.chainId!);
  });

  it("persists planning failures, retries planning, and stops a removed goal", async () => {
    const failed = await invoke({ action: "create", brief });
    await expect.poll(async () => (await status(failed.goalId)).status).toBe("failed");
    expect((await status(failed.goalId)).error).toContain("placeholder");
    await pauseBookQueueForTests(bookId);
    const retried = await invoke({ action: "retry", goal_id: failed.goalId });
    expect(retried).toMatchObject({ status: "planning", stage: "frame", error: null });
    expect(retried.planningJobId).not.toBe(failed.planningJobId);
    expect(engine.jobs.queue.list({ type: "generate_gpt_image_2_5" })).toHaveLength(0);
    expect(engine.jobs.queue.list({ type: "generate_seedance25_video" })).toHaveLength(0);
    await engine.notebooks.removeCell(notebookId, retried.cellId);
    expect((await invoke<{ goals: GoalSnapshot[] }>({ action: "list" })).goals).toHaveLength(0);
    expect(readGoal(engine, retried.goalId).status).toBe("cancelled");
    expect(engine.jobs.queue.get(retried.planningJobId!)?.state).toBe("aborted");
    expect(notebook().edges.some(edge => edge.target === retried.cellId)).toBe(false);
  });

  it("retries the failed stage without repeating its completed frames", async () => {
    const ready = await advance(await create(), "frame");
    await seedGoalStage(engine, ready.goalId, "storyboards", { failedIndex: 1 });
    const failed = await status(ready.goalId);
    expect(failed.status).toBe("failed");
    const first = failed.stages.storyboards!.outputs[0]!;
    await pauseBookQueueForTests(bookId);
    const retried = await invoke({ action: "retry", goal_id: ready.goalId });
    expect(retried.chainId).toBe(failed.chainId);
    await expect.poll(() => getChainRun(engine, retried.chainId!)?.steps[1]?.childJobIds.length).toBe(1);
    expect(getChainRun(engine, retried.chainId!)?.steps[0]).toMatchObject({ status: "completed", outputs: { asset_id: first.artifactId } });
    expect(engine.jobs.queue.list({ type: "generate_gpt_image_2_5" })).toHaveLength(1);
    await invoke({ action: "cancel", goal_id: ready.goalId });
    await waitForChainRun(engine, retried.chainId!);
  });

  it("finishes a single clip without assembly and appends multiple clips idempotently", async () => {
    const single = await advance(await advance(await create({ plan: goalTestPlan(1), brief: "@a1 @a2 one clip" }), "frame"), "storyboards");
    const ids = [await goalTestVideo(engine, root, "red"), await goalTestVideo(engine, root, "green"), await goalTestVideo(engine, root, "blue")];
    const singleChain = await seedGoalStage(engine, single.goalId, "videos", { videoIds: [ids[0]!] });
    expect(getChainRun(engine, singleChain)?.steps).toHaveLength(1);
    expect(await status(single.goalId)).toMatchObject({ status: "completed", assembly: null });
    expect(engine.sequences.getPrimary().clips).toHaveLength(0);
    const multi = await advance(await advance(await create(), "frame"), "storyboards");
    await seedGoalStage(engine, multi.goalId, "videos", { videoIds: ids });
    const assembled = await invoke({ action: "assemble", goal_id: multi.goalId });
    expect(assembled.status).toBe("completed");
    const clips = engine.sequences.getPrimary().clips;
    expect(clips.map(clip => clip.source.artifactId)).toEqual(ids);
    expect(clips.map(clip => clip.timelineStartFrame)).toEqual([0, 120, 240]);
    expect(clips.every(clip => "audioPolicy" in clip && clip.audioPolicy === "preserve-pitch" && clip.audio?.muted === false)).toBe(true);
    await invoke({ action: "assemble", goal_id: multi.goalId });
    expect(engine.sequences.getPrimary().clips).toEqual(clips);
    const trackId = readGoal(engine, multi.goalId).trackId!;
    await engine.sequences.updateTrack(trackId, { locked: true });
    await expect(appendGoalClips(engine, { ...readGoal(engine, multi.goalId), goalId: uuidv7(), assembly: null, clipIds: ids.map(() => uuidv7()) }, ids)).rejects.toThrow("no longer editable");
  });

  it("keeps legacy goals readable, cancels active legacy runs once, and refuses paid continuation", async () => {
    const modern = await create();
    await seedGoalStage(engine, modern.goalId, "frame", { failedIndex: 0 });
    const stored = readGoal(engine, modern.goalId);
    const legacyPlan = { title: plan.title, continuity: plan.continuity, aspectRatio: plan.aspectRatio, shots: plan.shots.map(shot => ({ title: shot.title, prompt: shot.videoPrompt, durationSeconds: shot.durationSeconds })) };
    const document = notebook();
    await engine.notebooks.write({ ...document, cells: document.cells.map(cell => cell.id === stored.cellId ? { ...cell, inputs: { goalId: stored.goalId, revision: 1, plan: legacyPlan, estimate: { usd: 3, warnings: [] } } } : cell) });
    engine.settings.set("application.goals.v2", {});
    const { planVersion: _planVersion, stage: _stage, stages: _stages, ...legacy } = stored;
    engine.settings.set("application.goals.v1", { [legacy.goalId]: { ...legacy, status: "running" } });
    const before = engine.settings.get("application.goals.v1");
    const failed = await status(legacy.goalId);
    expect(failed).toMatchObject({ planVersion: 1, status: "failed", error: LEGACY_GOAL_MESSAGE, plan: legacyPlan });
    expect(engine.settings.get("application.goals.v1")).toEqual(before);
    expect((await status(legacy.goalId)).updatedAt).toBe(failed.updatedAt);
    for (const action of ["approve", "regenerate", "update", "retry"]) expect((await raw({ action, goal_id: legacy.goalId, revision: 1, plan })).isError).toBe(true);
    expect((await invoke({ action: "dismiss", goal_id: legacy.goalId })).dismissedAt).toBeTruthy();
    const complete = { ...readGoal(engine, legacy.goalId), status: "completed" as const, assembly: { sequenceId: uuidv7(), startFrame: 0, durationFrames: 900 }, dismissedAt: null };
    saveGoal(engine, complete);
    expect((await invoke<{ goals: GoalSnapshot[] }>({ action: "list" })).goals[0]).toMatchObject({ planVersion: 1, status: "completed", assembly: complete.assembly });
  });

  it("rejects cross-notebook access, missing revisions and premature assembly", async () => {
    const goal = await create();
    const other = await engine.notebooks.create("Other");
    if (!other.ok) throw new Error(other.error.message);
    expect((await raw({ action: "status", goal_id: goal.goalId, notebook_id: other.value.id })).isError).toBe(true);
    expect((await raw({ action: "approve", goal_id: goal.goalId })).isError).toBe(true);
    expect((await raw({ action: "assemble", goal_id: goal.goalId })).isError).toBe(true);
    expect((await raw({ action: "dismiss", goal_id: goal.goalId })).isError).toBe(true);
  });
});
