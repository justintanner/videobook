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
import { cancelChainRun, getChainRun, waitForChainRun, type ChainRunRecord } from "../chain-executor.js";
import { compileGoalSteps, goalBriefConstraints, goalPlanSchema, GOAL_VIDEO_TOOL, type GoalPlan } from "../goal-plan.js";
import { readGoal, saveGoal, type GoalRecord } from "../goal-store.js";
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
  const goalCell = (cellId: string) => {
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    return notebook.value.cells.find(cell => cell.id === cellId);
  };
  const tile = (cellId: string) => raw({ cell_id: cellId, cell: { prompt: "rewritten" } }, "update_notebook_cell");

  it("saves the brief and plan in a goal tile on the first empty grid slot", async () => {
    const image = engine.notebooks.createCell({ type: "image", slot: { row: 0, column: 0 } });
    const inserted = await engine.notebooks.insertCell(notebookId, image);
    if (!inserted.ok) throw new Error(inserted.error.message);
    const goal = await create();
    expect(goal).toMatchObject({ address: "@a2", brief, revision: 1, plan, status: "review" });
    expect(goalCell(goal.cellId)).toMatchObject({
      type: "goal", label: plan.title, prompt: brief, slot: { row: 0, column: 1 },
      inputs: { goalId: goal.goalId, revision: 1, plan, estimate: goal.estimate },
    });
    expect(engine.settings.get<Record<string, Record<string, unknown>>>("application.goals.v1")?.[goal.goalId]).not.toHaveProperty("plan");
    expect((await tile(goal.cellId)).isError).toBe(true);
    expect((await raw({ cell_id: goal.cellId, cell: { slot: { row: 3, column: 3 } } }, "update_notebook_cell")).isError).toBeFalsy();
    expect((await invoke({ action: "status", goal_id: goal.goalId })).address).toBe("@d4");
    const created = await raw({ cell: { type: "goal", slot: { row: 5, column: 0 } } }, "create_notebook_cell");
    expect(created.isError).toBe(true);
    expect((created.content as Array<{ text: string }>)[0]!.text).toContain("/goal");
  });

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
    expect(goalCell(first.cellId)?.inputs).toMatchObject({ revision: 2, plan: edited });
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
    expect((await raw({ action: "retry", goal_id: pending.goalId })).isError).toBe(true);
    const retried = await invoke({ action: "retry", goal_id: failed.goalId });
    expect(retried).toMatchObject({ status: "planning", error: null });
    expect(retried.planningJobId).not.toBe(failed.planningJobId);
    expect(engine.jobs.queue.get(retried.planningJobId!)?.state).toBe("queued");
    expect((await raw({ action: "dismiss", goal_id: retried.goalId })).isError).toBe(true);
    expect((await invoke({ action: "dismiss", goal_id: pending.goalId })).dismissedAt).toBeTruthy();
  });

  it("stops an active goal when its tile is deleted and hides it from the list", async () => {
    await pauseBookQueueForTests(bookId);
    const pending = await invoke({ action: "create", brief });
    const reviewed = await create();
    const removed = await engine.notebooks.removeCell(notebookId, pending.cellId);
    if (!removed.ok) throw new Error(removed.error.message);
    const listed = await invoke<{ goals: GoalSnapshot[] }>({ action: "list" });
    expect(listed.goals.map(goal => goal.goalId)).toEqual([reviewed.goalId]);
    expect(readGoal(engine, pending.goalId).status).toBe("cancelled");
    expect(engine.jobs.queue.get(pending.planningJobId!)?.state).toBe("aborted");
    expect((await raw({ action: "run", goal_id: pending.goalId, revision: 0 })).isError).toBe(true);
  });

  it("retries a failed goal from its first unfinished shot without regenerating finished shots", async () => {
    const goal = await create();
    await pauseBookQueueForTests(bookId);
    const finished = uuidv7();
    const chainId = uuidv7();
    const producer = engine.notebooks.createCell({ type: "generate_video", slot: { row: 4, column: 0 }, tool: GOAL_VIDEO_TOOL, prompt: "Shot one" });
    const output = engine.notebooks.createCell({ type: "video", slot: { row: 5, column: 0 } });
    const tagged = engine.notebooks.createCell({
      type: "generate_video", slot: { row: 4, column: 1 }, tool: GOAL_VIDEO_TOOL, prompt: "Shot two",
      inputs: { chainRunId: `${chainId}:shot2` },
    });
    const board = engine.notebooks.read(notebookId);
    if (!board.ok) throw new Error(board.error.message);
    const placed = await engine.notebooks.write({
      ...board.value, cells: [...board.value.cells, producer, output, tagged],
      edges: [...board.value.edges, engine.notebooks.createEdge({ source: producer.id, target: output.id, targetInput: "media" })],
    });
    if (!placed.ok) throw new Error(placed.error.message);
    const approval = { actor: "chat" as const, approvedAt: goal.createdAt, estimateUsd: null, estimateUnavailable: true };
    const recorded: ChainRunRecord = {
      kind: "chain-run", chainId, bookId, notebookId, requestId: `goal:${goal.goalId}:1`, fingerprint: "fixture-failed-shot",
      status: "failed", createdAt: goal.createdAt, updatedAt: goal.updatedAt, error: "Provider rejected shot 2",
      autoApply: false, effect: "generation", awaitingStepId: null,
      steps: compileGoalSteps(goal.goalId, plan).map((step, index) => ({
        ...step, status: index === 0 ? "completed" : index === 1 ? "failed" : "skipped",
        outputs: index === 0 ? { asset_id: finished, cell_id: output.id, status: "completed" } : null,
        error: index === 1 ? "Provider rejected shot 2" : null, childJobIds: [], pins: [], autoApply: false,
        effect: step.tool === GOAL_VIDEO_TOOL ? "generation" : "mutation", requiresApproval: step.tool === GOAL_VIDEO_TOOL,
        approval: step.tool === GOAL_VIDEO_TOOL ? approval : null, review: null,
      })),
    };
    expect(engine.settings.set("application.chain-runs.v1", { runs: { [chainId]: recorded }, requestIndex: {} }).ok).toBe(true);
    const running: GoalRecord = { ...readGoal(engine, goal.goalId), chainId, status: "running", clipIds: plan.shots.map(() => uuidv7()) };
    saveGoal(engine, running);
    const failedGoal = await invoke({ action: "status", goal_id: goal.goalId });
    expect(failedGoal.status).toBe("failed");
    expect(failedGoal.steps.slice(0, 2)).toMatchObject([
      { id: "shot1", status: "completed", artifactId: finished, cellId: producer.id, address: "@e1", outputCellId: output.id },
      { id: "shot2", status: "failed", cellId: tagged.id, address: "@e2" },
    ]);
    const retried = await invoke({ action: "retry", goal_id: goal.goalId });
    expect(retried.status).toBe("running");
    await expect.poll(() => getChainRun(engine, chainId)?.steps[1]?.childJobIds.length).toBe(1);
    const chain = getChainRun(engine, chainId)!;
    expect(chain.steps[0]).toMatchObject({ status: "completed", outputs: { asset_id: finished } });
    expect(chain.steps[1]!.status).toBe("running");
    expect(chain.steps[1]!.startedAt).toBeTruthy();
    expect(chain.steps.slice(2).map(step => step.status)).toEqual(["approved", "pending"]);
    expect(engine.jobs.queue.list({ type: "generate_seedance25_video" })).toHaveLength(1);
    const snapshot = await invoke({ action: "status", goal_id: goal.goalId });
    expect(snapshot.steps[1]).toMatchObject({ id: "shot2", status: "running" });
    expect(snapshot.steps[1]!.startedAt).toBeTruthy();
    cancelChainRun(engine, chainId);
    await waitForChainRun(engine, chainId);
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
    const prior = saveGoal(engine, { ...readGoal(engine, goal.goalId), goalId: uuidv7(), clipIds: [uuidv7()], trackId });
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
