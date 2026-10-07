import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { createEngineForTest } from "../engine.js";
import { createTestClient } from "../test-client.js";
import { pauseBookQueueForTests, queue } from "../queue.js";
import { getChainRun, waitForChainRun, type ChainRunRecord } from "../chain-executor.js";
import { compileGoalSteps, goalBriefConstraints, goalPlanSchema, GOAL_VIDEO_TOOL, type GoalPlan } from "../goal-plan.js";
import { readGoal, saveGoal } from "../goal-store.js";
import { appendGoalClips } from "../jobs/assemble-goal.js";
import { copyVideoFixture } from "../test-media-fixtures.js";
import { probeVideo } from "../ffmpeg.js";
import type { GoalSnapshot } from "./goal.js";

const brief = "make a funny video of a dog on a skateboard, multiple 10s clips";
const plan: GoalPlan = {
  title: "The unlikely skateboarder", continuity: "A scruffy brown terrier in a red helmet on a blue skateboard, sunny neighborhood park, playful cinematic comedy.",
  aspectRatio: "16:9",
  shots: [
    { title: "Ready to roll", prompt: "The terrier proudly steps onto its skateboard, which rolls slowly backward. Wide tracking shot, birds chirp.", durationSeconds: 10 },
    { title: "Unplanned tricks", prompt: "The terrier weaves around cones and startles at its own reflection. Low tracking shot, squeaky wheels.", durationSeconds: 10 },
    { title: "Victory lap", prompt: "The terrier stops by the treat stand, raising a paw as a biscuit lands on its helmet. Gentle push in, a happy bark.", durationSeconds: 10 },
  ],
};

describe("video goal plans", () => {
  it("honors explicit timing and counts and gives the example three ten-second shots", () => {
    expect(goalBriefConstraints(brief)).toEqual({ shotCount: 3, durationSeconds: 10, aspectRatio: "16:9" });
    expect(goalBriefConstraints("four 8-second clips, portrait")).toEqual({ shotCount: 4, durationSeconds: 8, aspectRatio: "9:16" });
    expect(goalBriefConstraints("2 x 12s, square")).toEqual({ shotCount: 2, durationSeconds: 12, aspectRatio: "1:1" });
    expect(goalBriefConstraints("A 30-second video, three 10-second clips").durationSeconds).toBe(10);
    expect(() => goalBriefConstraints("12 clips of 10s")).toThrow("1–8");
    expect(() => goalBriefConstraints("three 90-second clips")).toThrow("4 to 30");
    expect(() => goalBriefConstraints("3 clips of 4.5s")).toThrow("whole number");
  });

  it("compiles distinct shots with shared continuity and ordered output references", () => {
    const steps = compileGoalSteps(uuidv7(), goalPlanSchema.parse(plan));
    expect(steps).toHaveLength(4);
    expect(steps.slice(0, 3).map(step => step.params.duration)).toEqual(["10", "10", "10"]);
    for (const [index, step] of steps.slice(0, 3).entries()) {
      expect(step.params.prompt).toContain(plan.continuity);
      expect(step.params.prompt).toContain(plan.shots[index]!.prompt);
      expect(step.tool).toBe(GOAL_VIDEO_TOOL);
    }
    expect(steps[3]!.params.artifact_ids).toEqual([1, 2, 3].map(index => ({ $ref: { step_id: `shot${index}`, output: "asset_id" } })));
    expect(goalPlanSchema.safeParse({ ...plan, shots: [] }).success).toBe(false);
    expect(goalPlanSchema.safeParse({ ...plan, shots: Array(9).fill(plan.shots[0]) }).success).toBe(false);
  });
});

describe("video goal MCP lifecycle", () => {
  let root: string;
  let client: Client;
  let engine: Engine;
  let bookId: string;
  let notebookId: string;
  let oldKieKey: string | undefined;
  let oldOpenAiKey: string | undefined;

  beforeEach(async () => {
    oldKieKey = process.env.KIE_API_KEY;
    oldOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.KIE_API_KEY = "test-goal-key";
    process.env.OPENAI_API_KEY = "test-goal-key";
    root = await mkdtemp(join(tmpdir(), "videobook-goal-"));
    engine = createEngineForTest(root);
    client = await createTestClient(root);
    bookId = engine.book.get().bookId;
    const notebook = await engine.notebooks.create("Goals");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
  });

  afterEach(async () => {
    await client?.close();
    if (oldKieKey === undefined) delete process.env.KIE_API_KEY;
    else process.env.KIE_API_KEY = oldKieKey;
    if (oldOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldOpenAiKey;
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

  it("saves and estimates a plan without generation, restores it through list, and fences stale edits", async () => {
    const first = await create({ request_id: "same-goal" });
    expect(first).toMatchObject({ status: "review", revision: 1, plan });
    expect(first.estimate.usd).toBeGreaterThan(0);
    expect(engine.jobs.queue.list()).toHaveLength(0);
    expect((await create({ request_id: "same-goal" })).goalId).toBe(first.goalId);
    const edited = structuredClone(plan);
    edited.shots[0]!.durationSeconds = 20;
    const updated = await invoke({ action: "update", goal_id: first.goalId, revision: first.revision, plan: edited });
    expect(updated.revision).toBe(2);
    expect(updated.estimate.usd).toBeGreaterThan(first.estimate.usd!);
    expect((await raw({ action: "run", goal_id: first.goalId, revision: first.revision })).isError).toBe(true);
    expect((await raw({ action: "update", goal_id: first.goalId, revision: first.revision, plan })).isError).toBe(true);
    const saved = await invoke<{ goals: GoalSnapshot[] }>({ action: "list" });
    expect(saved.goals[0]).toMatchObject({ goalId: first.goalId, revision: 2, plan: edited });
    expect(engine.jobs.queue.list()).toHaveLength(0);
  });

  it("approves the exact whole plan once, checkpoints the first queued clip, and stops every later shot", async () => {
    const goal = await create();
    await pauseBookQueueForTests(bookId);
    const started = await invoke({ action: "run", goal_id: goal.goalId, revision: goal.revision });
    expect(started.status).toBe("running");
    expect(started.chainId).toBeTruthy();
    await expect.poll(() => getChainRun(engine, started.chainId!)?.steps[0]?.childJobIds.length).toBe(1);
    const chain = getChainRun(engine, started.chainId!)!;
    expect(chain.steps.filter(step => step.requiresApproval).every(step => step.approval?.actor === "chat")).toBe(true);
    expect(chain.steps[0]!.outputs?.vid_asset_id).toBeTruthy();
    expect((await invoke({ action: "run", goal_id: goal.goalId, revision: goal.revision })).chainId).toBe(started.chainId);
    expect(engine.jobs.queue.list({ type: "generate_seedance25_video" })).toHaveLength(1);
    const graph = engine.notebooks.read(notebookId);
    expect(graph.ok && graph.value.cells.some(cell => cell.type === "timeline")).toBe(true);
    const cancelled = await invoke({ action: "cancel", goal_id: goal.goalId });
    expect(cancelled.status).toBe("cancelled");
    await expect.poll(() => getChainRun(engine, started.chainId!)?.steps[1]?.status).toBe("skipped");
    expect(engine.jobs.queue.list({ type: "generate_seedance25_video" })).toHaveLength(1);
    expect((await raw({ action: "update", goal_id: goal.goalId, revision: goal.revision, plan })).isError).toBe(true);
  });

  it("persists planning errors without creating video jobs and can cancel queued planning", async () => {
    const failed = await invoke({ action: "create", brief });
    await expect.poll(async () => (await invoke({ action: "status", goal_id: failed.goalId })).status).toBe("failed");
    expect((await invoke({ action: "status", goal_id: failed.goalId })).error).toContain("placeholder");
    await pauseBookQueueForTests(bookId);
    const pending = await invoke({ action: "create", brief });
    expect(pending.status).toBe("planning");
    expect((await invoke({ action: "cancel", goal_id: pending.goalId })).status).toBe("cancelled");
    expect(engine.jobs.queue.get(pending.planningJobId!)?.state).toBe("aborted");
    expect(engine.jobs.queue.list({ type: "generate_seedance25_video" })).toHaveLength(0);
  });

  it("rejects cross-notebook access and premature assembly", async () => {
    const goal = await create();
    const other = await engine.notebooks.create("Other");
    if (!other.ok) throw new Error(other.error.message);
    expect((await raw({ action: "status", goal_id: goal.goalId, notebook_id: other.value.id })).isError).toBe(true);
    expect((await raw({ goal_id: goal.goalId, artifact_ids: [uuidv7()] }, "assemble_goal")).isError).toBe(true);
    expect((await raw({ action: "assemble", goal_id: goal.goalId })).isError).toBe(true);
    expect((await raw({ action: "run", goal_id: goal.goalId })).isError).toBe(true);
  });

  async function video(color: string): Promise<string> {
    const path = join(root, `${color}.mp4`);
    await copyVideoFixture({ width: 160, height: 90, durationSec: 4, fps: 10, source: "color", color, audio: { frequency: 440 } }, path);
    const artifact = await engine.artifacts.create("video", color);
    if (!artifact.ok) throw new Error(artifact.error.message);
    const artifactId = artifact.value.artifactId;
    const written = await engine.files.writeFromPath(artifactId, "original.mp4", path);
    if (!written.ok) throw new Error(written.error.message);
    const probe = await probeVideo(path);
    const metadata = await engine.metadata.artifacts.write(artifactId, "original", {
      duration: probe.duration, width: probe.width, height: probe.height, fps: probe.fps, hasAudio: probe.hasAudio,
    });
    if (!metadata.ok) throw new Error(metadata.error.message);
    const stream = probe.videoStream!;
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const registered = await engine.streams.register({
      artifactId, sourcePath: "original.mp4", objectHash: manifest.value.files[0]!.objectHash,
      streamIndex: stream.index, kind: "video", codec: stream.codec,
      timeBase: stream.timeBase, durationTicks: stream.durationTicks, video: stream.video,
    });
    if (!registered.ok) throw new Error(registered.error.message);
    return artifactId;
  }

  it("assembles recorded completed shots in order through the queue and does not duplicate them on retry", async () => {
    const goal = await create();
    const ids = [await video("red"), await video("green"), await video("blue")];
    const trackId = engine.sequences.getPrimary().tracks.find(track => track.kind === "video")!.trackId;
    const prior = saveGoal(engine, { ...readGoal(engine, goal.goalId), goalId: uuidv7(), plan: { ...plan, shots: [plan.shots[0]!] }, clipIds: [uuidv7()], trackId });
    await appendGoalClips(engine, prior, [ids[2]!]);
    const original = engine.sequences.getPrimary().clips[0]!;
    const chainId = uuidv7();
    const recorded: ChainRunRecord = {
      kind: "chain-run", chainId, bookId, notebookId, requestId: null, fingerprint: "fixture-completed-clips",
      status: "failed", createdAt: goal.createdAt, updatedAt: goal.updatedAt, error: "Assembly interrupted",
      autoApply: false, effect: "generation", awaitingStepId: null,
      steps: ids.map((id, index) => ({
        id: `shot${index + 1}`, tool: GOAL_VIDEO_TOOL, params: {}, status: "completed",
        outputs: { asset_id: id }, error: null, childJobIds: [], pins: [], autoApply: false,
        effect: "generation", requiresApproval: true, review: null,
        approval: { actor: "chat", approvedAt: goal.createdAt, estimateUsd: null, estimateUnavailable: true },
      })),
    };
    expect(engine.settings.set("application.chain-runs.v1", { runs: { [chainId]: recorded }, requestIndex: {} }).ok).toBe(true);
    saveGoal(engine, { ...readGoal(engine, goal.goalId), chainId, status: "running", trackId, clipIds: ids.map(() => uuidv7()) });
    const assembled = await invoke({ action: "assemble", goal_id: goal.goalId });
    expect(assembled.status).toBe("completed");
    expect(assembled.assembly?.startFrame).toBe(original.durationFrames);
    const clips = engine.sequences.getPrimary().clips;
    expect(clips[0]).toEqual(original);
    expect(clips.slice(1).map(clip => clip.source.artifactId)).toEqual(ids);
    expect(clips.slice(1).map(clip => clip.timelineStartFrame)).toEqual([120, 240, 360]);
    expect(clips.slice(1).every(clip => "audioPolicy" in clip && clip.audioPolicy === "preserve-pitch" && clip.audio?.muted === false)).toBe(true);
    await invoke({ action: "assemble", goal_id: goal.goalId });
    expect(engine.sequences.getPrimary().clips).toEqual(clips);
    expect(engine.jobs.queue.list({ type: "generate_seedance25_video" })).toHaveLength(0);
    const track = engine.sequences.getPrimary().tracks.find(candidate => candidate.trackId === trackId)!;
    await engine.sequences.updateTrack(track.trackId, { locked: true });
    const fresh = { ...readGoal(engine, goal.goalId), goalId: uuidv7(), clipIds: ids.map(() => uuidv7()), assembly: null };
    await expect(appendGoalClips(engine, fresh, ids)).rejects.toThrow("no longer editable");
    expect(engine.sequences.getPrimary().clips).toEqual(clips);
    await waitForChainRun(engine, chainId);
    await queue.stop();
  });
});
