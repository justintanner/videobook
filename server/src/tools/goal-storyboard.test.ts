import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { getChainRun, waitForChainRun } from "../chain-executor.js";
import { createEngineForTest } from "../engine.js";
import { formatShortSeconds } from "../goal-short-plan.js";
import { shortFingerprint } from "../goal-short-runtime.js";
import { readGoal } from "../goal-store.js";
import { installFalDynamicEstimator } from "../media/cost.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { configureProviderPollDriverForTests, resetProviderPollDriverForTests } from "../queue.js";
import { writeTaggingSettings } from "../tag-settings.js";
import { testBudget } from "../test-budget.js";
import { createTestClient } from "../test-client.js";
import { goalTestCharacters } from "../test-goals.js";
import { copyVideoFixture } from "../test-media-fixtures.js";
import { redirectFalStorage, startShortStub, type ShortStub } from "../test-short-stub.js";
import type { ShortGoalSnapshot } from "./goal.js";

const CLEANUP_MODEL = "fal:google/nano-banana-2.1/edit";
const FRAME_MODEL = "fal:openai/gpt-image-2.6/sunburst/edit";
const CLIP_MODEL = "fal:minimax/h3-max/reference-to-video";
const CLEANUP = "/google/nano-banana-2.1/edit";
const FRAME_EDIT = "/openai/gpt-image-2.6/sunburst/edit";
const UMBRELLA = "make a 12s viral TikTok clip based on @b1 but with @a2 holding the umbrella for a monitor lizard, realistic";
const AUTHORED = 'frame: "He holds a red umbrella over a monitor lizard on a wet lane." beat 1: "He walks beside the lizard, keeping the umbrella over it."';
const PLAN = {
  title: "Umbrella for a lizard",
  frame: "A man holds a red umbrella over a monitor lizard on a wet lane.",
  beats: ["He walks beside the lizard, keeping the umbrella over it as rain falls."],
};
const STORYBOARD_FIRST = "Clean the storyboard first: approve the storyboard stage to remove its on-screen graphics before the frame is made.";
const FRAME_STALE = "Storyboard frame 1 changed after this frame was made.";

type PlannerRequest = { instructions: string; input: Array<{ role: string; content: Array<{ type: string; text?: string }> }> };
type RewriteRequest = { instructions: string; input: Array<{ role: string; content: string }> };

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("video_goal storyboard stage", () => {
  let stub: ShortStub;
  let fixtures: string;
  let umbrellaPath: string;
  let root: string;
  let engine: Engine;
  let client: Client;
  let bookId: string;
  let notebookId: string;
  let imageIds: string[];
  let videoId: string;
  let videoCellId: string;
  let restoreFetch: () => void;
  let restoreEndpoints: () => void;
  let restoreEstimator: () => void;
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-goal-storyboard-fixtures-"));
    umbrellaPath = await copyVideoFixture({ width: 360, height: 640, durationSec: 6, fps: 12, source: "color", color: "0x4f6b3a", audio: false }, join(fixtures, "umbrella.mp4"));
    await copyVideoFixture({ width: 360, height: 640, durationSec: 3, fps: 12, source: "color", color: "green", audio: { frequency: 330 } }, join(fixtures, "clip.mp4"));
    const clip = await readFile(join(fixtures, "clip.mp4"));
    stub = await startShortStub({ frame: await sharp({ create: { width: 360, height: 640, channels: 3, background: "#5b7a4c" } }).png().toBuffer(), clip, extended: clip });
  });

  afterAll(async () => {
    await stub.close();
    await rm(fixtures, { recursive: true, force: true });
  });

  async function addVideo(label: string, slot: { row: number; column: number }): Promise<{ artifactId: string; cellId: string }> {
    const artifactId = value(await engine.artifacts.create("video", label)).artifactId;
    value(await engine.files.writeFromPath(artifactId, "original.mp4", umbrellaPath));
    const cell = engine.notebooks.createCell({ type: "video", label, slot, outputArtifactId: artifactId });
    value(await engine.notebooks.insertCell(notebookId, cell));
    return { artifactId, cellId: cell.id };
  }

  beforeEach(async () => {
    stub.reset();
    for (const [key, setting] of [["FAL_API_KEY", "local-fal-key"], ["OPENAI_API_KEY", "offline-openai-key"], ["VIDEOBOOK_HAR_CAPTURE", "off"]] as const) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = setting;
    }
    restoreFetch = redirectFalStorage(stub.baseURL);
    restoreEndpoints = configureProviderEndpoints({ falQueueBaseURL: stub.baseURL, openaiBaseURL: stub.baseURL });
    restoreEstimator = installFalDynamicEstimator(async () => ({ total_cost: 0.21, currency: "USD" }));
    configureProviderPollDriverForTests({ intervalMs: 50 });
    root = await mkdtemp(join(tmpdir(), "videobook-goal-storyboard-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    writeTaggingSettings(engine, { analysisOnNewAssets: false });
    notebookId = value(await engine.notebooks.create("Umbrella")).id;
    imageIds = await goalTestCharacters(engine, notebookId);
    ({ artifactId: videoId, cellId: videoCellId } = await addVideo("Umbrella walk", { row: 1, column: 0 }));
  });

  afterEach(async () => {
    await client.close();
    resetProviderPollDriverForTests();
    restoreEstimator();
    restoreEndpoints();
    restoreFetch();
    for (const [key, setting] of savedEnv) {
      if (setting === undefined) delete process.env[key];
      else process.env[key] = setting;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const raw = (args: Record<string, unknown>) => client.callTool({ name: "video_goal", arguments: { book_id: bookId, notebook_id: notebookId, ...args } });
  const textOf = (result: Awaited<ReturnType<typeof raw>>) => (result.content as Array<{ text: string }>)[0]!.text;
  const notebook = (): NotebookDocument => value(engine.notebooks.read(notebookId));
  const chainRuns = () => Object.keys(engine.settings.get<{ runs: Record<string, unknown> }>("application.chain-runs.v1")?.runs ?? {}).length;
  const mediaJobs = (model: string) => engine.jobs.queue.list({ type: "generate_media", limit: 100 }).filter((job) => job.payload.model === model);

  async function invoke(args: Record<string, unknown>): Promise<ShortGoalSnapshot> {
    const result = await raw(args);
    expect(result.isError, textOf(result)).toBeFalsy();
    return JSON.parse(textOf(result)) as ShortGoalSnapshot;
  }

  async function refusal(args: Record<string, unknown>): Promise<string> {
    const result = await raw(args);
    expect(result.isError, textOf(result)).toBe(true);
    return textOf(result);
  }

  const status = (goalId: string) => invoke({ action: "status", goal_id: goalId });

  async function short(brief: string): Promise<ShortGoalSnapshot> {
    return status((await invoke({ action: "create", brief, request_id: uuidv7() })).goalId);
  }

  async function settled(goal: ShortGoalSnapshot): Promise<ShortGoalSnapshot> {
    await waitForChainRun(engine, goal.chainId!, testBudget(90_000));
    return status(goal.goalId);
  }

  async function approved(goal: ShortGoalSnapshot): Promise<ShortGoalSnapshot> {
    return settled(await invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision }));
  }

  function storyboardOf(goal: ShortGoalSnapshot) {
    const plan = goal.shortPlan;
    if (!plan || plan.version !== 5 || !plan.storyboard) throw new Error("expected a version 5 plan with a storyboard");
    return plan.storyboard;
  }

  function sourceImagesOf(goal: ShortGoalSnapshot) {
    const plan = goal.shortPlan;
    if (!plan || plan.version !== 5) throw new Error("expected a version 5 plan");
    return plan.sourceImages;
  }

  function stepPrompt(chainId: string | null, stepId: string): string {
    const step = getChainRun(engine, chainId ?? "")?.steps.find((item) => item.id === stepId);
    return String((step?.params as { prompt?: string } | undefined)?.prompt ?? "");
  }

  function rawFrameCells(): NotebookCell[] {
    return notebook().cells
      .filter((cell) => cell.inputs?.mediaRole === "extract-frame-output" && typeof cell.inputs.storyboardIndex === "number")
      .sort((left, right) => Number(left.inputs!.storyboardIndex) - Number(right.inputs!.storyboardIndex));
  }

  function storyboardNote(mention: string, frames: readonly { address: string; atSeconds: number }[]): string {
    const listed = frames.map((frame) => `${frame.address} at ${formatShortSeconds(frame.atSeconds)} s`);
    return `${mention} is a video, so the short follows its storyboard of ${frames.length} frames: ${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}. Their on-screen graphics are removed before the frame is made.`;
  }

  it("captures a 4-frame storyboard of the first video, plans from it in order, and opens at the storyboard stage with its estimate", async () => {
    await addVideo("Second video", { row: 1, column: 1 });
    stub.plannerAnswers = [PLAN];
    const planning = await invoke({ action: "create", brief: `${UMBRELLA}, cut like @b2` });
    expect(planning).toMatchObject({ planVersion: 5, status: "planning", stage: "storyboards", legacy: false });
    const cells = rawFrameCells();
    expect(cells.map((cell) => cell.inputs?.storyboardIndex)).toEqual([0, 1, 2, 3]);
    for (const cell of cells) {
      expect(cell).toMatchObject({ type: "image", inputs: { mediaRole: "extract-frame-output", sourceArtifactId: videoId, sourceCellId: videoCellId, frameMode: "time" } });
    }
    const times = cells.map((cell) => Number(cell.inputs?.atSeconds));
    [0.75, 2.25, 3.75, 5.25].forEach((seconds, index) => expect(times[index]).toBeCloseTo(seconds, 1));
    const addresses = cells.map((cell, index) => ({ address: notebookGridTag(cell.slot), atSeconds: times[index]! }));
    expect(planning.notes).toEqual([
      storyboardNote("@b1", addresses),
      "@b2 is another video and was skipped: the storyboard comes from the first video the brief mentions.",
    ]);

    await expect.poll(() => readGoal(engine, planning.goalId).status, { timeout: testBudget(30_000) }).toBe("review");
    const goal = await status(planning.goalId);
    expect(goal).toMatchObject({ stage: "storyboards", status: "review", error: null });
    const storyboard = storyboardOf(goal);
    expect(storyboard).toMatchObject({ video: { artifactId: videoId, cellId: videoCellId, label: "Umbrella walk" }, model: CLEANUP_MODEL });
    expect(storyboard.frames.map((frame) => [frame.index, frame.artifactId, frame.cellId])).toEqual(cells.map((cell, index) => [index, cell.outputArtifactId, cell.id]));
    for (const frame of storyboard.frames) expect(frame.prompt).toMatch(/^Remove every on-screen graphic that was added on top of the camera picture/u);
    expect(sourceImagesOf(goal)).toEqual([expect.objectContaining({ artifactId: imageIds[1], slot: "@image1" })]);
    expect(goal.shortPlan).not.toHaveProperty("character");
    expect(JSON.stringify(goal)).not.toMatch(/Main character|a man in a green shirt/u);

    expect(goal.estimate.storyboards.usd).toBeCloseTo(0.84);
    expect(goal.estimate.storyboardFrames?.map((estimate) => estimate.usd)).toEqual([0.21, 0.21, 0.21, 0.21]);
    expect(goal.estimate.total.usd).toBeCloseTo(0.84 + goal.estimate.frame.usd! + goal.estimate.videos.usd!);
    expect(goal.storyboard).toMatchObject({
      video: { artifactId: videoId },
      model: CLEANUP_MODEL,
      estimate: { usd: expect.closeTo(0.84) },
      frames: storyboard.frames.map((frame) => ({
        index: frame.index, atSeconds: frame.atSeconds,
        raw: { artifactId: frame.artifactId, cellId: frame.cellId, address: frame.address }, clean: null, estimate: { usd: 0.21 },
      })),
    });

    expect(stub.plannerRequests).toHaveLength(1);
    const request = stub.plannerRequests[0] as PlannerRequest;
    const content = request.input[0]!.content;
    expect(content.filter((part) => part.type === "input_text").slice(1).map((part) => part.text)).toEqual([
      "Source image 1: Character 2",
      ...storyboard.frames.map((frame, index) => `Storyboard frame ${index + 1} of 4 at ${formatShortSeconds(frame.atSeconds)} s`),
    ]);
    expect(content.filter((part) => part.type === "input_image")).toHaveLength(5);
    expect(JSON.parse(content[0]!.text!)).toMatchObject({
      brief: "make a 12s viral TikTok clip based on the storyboard but with Source image 1 holding the umbrella for a monitor lizard, realistic, cut like @b2",
    });
    expect(request.instructions).toContain("then the 4 storyboard frames, labelled Storyboard frame 1 of 4 and so on");
    expect(request.instructions).toContain("Follow the storyboard's action, camera and order across the opening frame and the beats, and apply the brief's changes to it");
    expect(request.instructions).toContain("Never describe anything drawn on top of the picture in the storyboard frames");

    const runs = chainRuns();
    expect(await refusal({ action: "approve", goal_id: goal.goalId, revision: goal.revision, stage: "frame" })).toBe(STORYBOARD_FIRST);
    expect(await refusal({ action: "check", goal_id: goal.goalId, stage: "storyboards", index: 0 }))
      .toBe("Check the frame or a clip for AI tells. Storyboard frames come from the video and are not checked.");
    expect(chainRuns()).toBe(runs);
    expect(stub.submissions).toEqual([]);
    expect(stub.unexpected).toEqual([]);
  });

  it("cleans every storyboard frame in one approval, regenerates and selects one, and makes the frame from the source image and clean frame 1", async () => {
    const goal = await short(`based on @b1 with @a2, ${AUTHORED}`);
    expect(goal).toMatchObject({ stage: "storyboards", status: "review" });
    expect(stub.plannerRequests).toEqual([]);
    const storyboard = storyboardOf(goal);
    expect(storyboard.frames).toHaveLength(4);

    const cleaned = await approved(goal);
    expect(cleaned).toMatchObject({ stage: "frame", status: "review", error: null, revision: goal.revision + 1 });
    expect(stub.submissions.map((submission) => submission.path)).toEqual([CLEANUP, CLEANUP, CLEANUP, CLEANUP]);
    for (const submission of stub.submissions) {
      expect(submission.body).toMatchObject({ prompt: storyboard.frames[0]!.prompt, aspect_ratio: "9:16", output_format: "jpeg", image_urls: [expect.stringMatching(/^http/u)] });
    }
    expect(mediaJobs(CLEANUP_MODEL).map((job) => (job.payload.refs as { image: string[] }).image).sort())
      .toEqual(storyboard.frames.map((frame) => [frame.artifactId]).sort());
    const outputs = cleaned.stages.storyboards!.outputs;
    expect(outputs.map((output) => output.index)).toEqual([0, 1, 2, 3]);
    const document = notebook();
    for (const output of outputs) {
      expect(document.cells.find((cell) => cell.id === output.cellId)).toMatchObject({ type: "image", outputArtifactId: output.artifactId });
      expect(document.cells.find((cell) => cell.id === output.producerCellId)).toMatchObject({ type: "generate_image" });
      expect(document.edges).toContainEqual(expect.objectContaining({ source: storyboard.frames[output.index]!.cellId, target: output.producerCellId }));
    }
    expect(cleaned.storyboard?.frames.map((frame) => frame.clean?.artifactId)).toEqual(outputs.map((output) => output.artifactId));

    const before = stub.submissions.length;
    const regenerated = await settled(await invoke({ action: "regenerate", goal_id: goal.goalId, revision: cleaned.revision, stage: "storyboards", index: 2 }));
    expect(stub.submissions.slice(before).map((submission) => submission.path)).toEqual([CLEANUP]);
    expect(regenerated).toMatchObject({ stage: "frame", status: "review" });
    const third = regenerated.stages.storyboards!.outputs[2]!;
    expect(third.artifactId).not.toBe(outputs[2]!.artifactId);
    expect(third.versions.map((version) => version.artifactId)).toEqual([third.artifactId, outputs[2]!.artifactId]);
    expect(regenerated.stages.storyboards!.outputs.filter((output) => output.index !== 2).map((output) => output.artifactId))
      .toEqual(outputs.filter((output) => output.index !== 2).map((output) => output.artifactId));
    const selected = await invoke({ action: "select", goal_id: goal.goalId, revision: regenerated.revision, stage: "storyboards", index: 2, artifact_id: outputs[2]!.artifactId });
    expect(selected.stages.storyboards!.outputs.map((output) => output.artifactId)).toEqual(outputs.map((output) => output.artifactId));
    expect(selected).toMatchObject({ stage: "frame", status: "review" });

    const cleanOne = outputs[0]!.artifactId;
    const beforeFrame = stub.submissions.length;
    const frame = await settled(await invoke({ action: "approve", goal_id: goal.goalId, revision: selected.revision, stage: "frame" }));
    expect(frame).toMatchObject({ stage: "videos", status: "review" });
    expect(stub.submissions.slice(beforeFrame).map((submission) => submission.path)).toEqual([FRAME_EDIT]);
    const frameBody = stub.submissions[beforeFrame]!.body;
    expect(frameBody.image_urls).toHaveLength(2);
    expect(mediaJobs(FRAME_MODEL)[0]?.payload).toMatchObject({ refs: { image: [imageIds[1], cleanOne] } });
    const framePayload = JSON.stringify(mediaJobs(FRAME_MODEL)[0]?.payload);
    for (const rawFrame of storyboard.frames) expect(framePayload).not.toContain(rawFrame.artifactId);
    expect(stepPrompt(frame.chainId, "frame")).toContain("@image1 is a source image: keep that person exactly as photographed");
    expect(stepPrompt(frame.chainId, "frame")).toContain("@image2 is the first frame of the storyboard: copy its camera angle, framing, pose and action, but take the people and animals from the source image and this prompt, never from @image2.");
    expect(String(frameBody.prompt)).toContain("reference image 2 is the first frame of the storyboard: copy its camera angle, framing, pose and action");
    expect(frame.stages.frame!.outputs[0]!.stale).toBeNull();

    const clip = await approved(frame);
    const frameId = frame.stages.frame!.outputs[0]!.artifactId;
    expect(mediaJobs(CLIP_MODEL)[0]?.payload).toMatchObject({ refs: { first_frame: [frameId], image: [imageIds[1]] } });
    const clipPayload = JSON.stringify(mediaJobs(CLIP_MODEL)[0]?.payload);
    for (const artifactId of [...storyboard.frames.map((rawFrame) => rawFrame.artifactId), ...outputs.map((output) => output.artifactId)]) {
      expect(clipPayload).not.toContain(artifactId);
    }

    const restaled = await settled(await invoke({ action: "regenerate", goal_id: goal.goalId, revision: clip.revision, stage: "storyboards", index: 0 }));
    expect(restaled).toMatchObject({ stage: "videos", status: "review", finish: { status: "review" } });
    expect(restaled.stages.frame!.outputs[0]!.stale).toBe(FRAME_STALE);
    expect(restaled.stages.videos!.outputs[0]!.stale).toBeNull();
    expect(await refusal({ action: "regenerate", goal_id: goal.goalId, revision: restaled.revision, stage: "videos", index: 0 }))
      .toBe("The frame prompt, references or storyboard changed after this frame was made. Regenerate the frame before continuing.");
    const restored = await invoke({ action: "select", goal_id: goal.goalId, stage: "storyboards", index: 0, artifact_id: cleanOne });
    expect(restored).toMatchObject({ stage: "videos", status: "review", finish: { status: "review" } });
    expect(restored.stages.frame!.outputs[0]!.stale).toBeNull();

    stub.failNext = true;
    const failed = await settled(await invoke({ action: "regenerate", goal_id: goal.goalId, revision: restored.revision, stage: "storyboards", index: 0 }));
    expect(failed).toMatchObject({ status: "failed", stage: "storyboards", resumeStage: "videos" });
    expect(failed.stages.storyboards!.outputs[0]!.artifactId).toBe(cleanOne);
    const recovered = await invoke({ action: "select", goal_id: goal.goalId, stage: "storyboards", index: 0, artifact_id: restaled.stages.storyboards!.outputs[0]!.artifactId });
    expect(recovered).toMatchObject({ stage: "videos", status: "review", error: null, resumeStage: null, resumeOutputs: null, finish: { status: "review" } });
    expect(recovered.stages.frame!.outputs[0]!.stale).toBe(FRAME_STALE);
    expect(stub.unexpected).toEqual([]);
  });

  it("revises one storyboard frame's clean-up prompt with the feedback before cleaning it again, and keeps the storyboard locked", async () => {
    const goal = await short(`based on @b1 with @a2, ${AUTHORED}`);
    const original = storyboardOf(goal).frames[1]!.prompt;
    const cleaned = await approved(goal);
    const rewritten = "Remove the sticker at the top left with its underline and every other overlay, and fill the sky behind them. Keep the people, the lizard, the umbrella and its printed logo exactly as they are.";
    stub.plannerAnswers = [{ prompt: rewritten }];
    const before = stub.submissions.length;
    const feedback = "The sticker at the top left is still there.";
    const revised = await settled(await invoke({ action: "revise", goal_id: goal.goalId, revision: cleaned.revision, stage: "storyboards", index: 1, feedback }));
    const request = stub.plannerRequests.at(-1) as RewriteRequest;
    expect(request.instructions).toContain("Revise the clean-up prompt for storyboard frame 2 of 4, one frame of a video.");
    expect(request.instructions).toContain("Write at most 160 words, and answer with the whole revised storyboard frame 2 clean-up.");
    expect(JSON.parse(request.input[0]!.content)).toMatchObject({
      revise: "storyboard frame 2 clean-up", prompt: original, feedback,
      brief: `based on the storyboard with Source image 1, ${AUTHORED}`,
    });
    expect(stub.submissions.slice(before)).toEqual([expect.objectContaining({ path: CLEANUP, body: expect.objectContaining({ prompt: rewritten }) })]);
    expect(storyboardOf(revised).frames.map((frame) => frame.prompt)).toEqual([original, rewritten, original, original]);
    expect(revised.stages.storyboards!.outputs[1]!.versions[0]).toMatchObject({ basePrompt: rewritten, feedback, current: true });
    expect(revised).toMatchObject({ stage: "frame", status: "review" });

    const plan = revised.shortPlan!;
    const storyboard = storyboardOf(revised);
    expect(await refusal({ action: "update", goal_id: goal.goalId, revision: revised.revision, plan: { ...plan, storyboard: { ...storyboard, frames: storyboard.frames.slice(0, 2) } } }))
      .toBe("The storyboard's video and frames stay with this short. Start a new /goal to change them.");
    const edited = await invoke({ action: "update", goal_id: goal.goalId, revision: revised.revision, plan: {
      ...plan, storyboard: { ...storyboard, frames: storyboard.frames.map((frame) => frame.index === 3 ? { ...frame, prompt: "Remove the caption at the bottom." } : frame) },
    } });
    expect(storyboardOf(edited).frames[3]!.prompt).toBe("Remove the caption at the bottom.");
    expect(stub.unexpected).toEqual([]);
  });

  it("starts a short with an image and no video at frame review, with no storyboard and the frame fingerprint of earlier version 5 shorts", async () => {
    const goal = await short(`@a2 ${AUTHORED}`);
    expect(goal).toMatchObject({ planVersion: 5, stage: "frame", status: "review", storyboard: null });
    expect(goal.shortPlan).not.toHaveProperty("storyboard");
    expect(rawFrameCells()).toEqual([]);
    expect(goal.estimate.storyboards).toEqual({ usd: 0, warnings: [] });
    expect(goal.estimate).not.toHaveProperty("storyboardFrames");
    expect(goal.estimate.total.usd).toBeCloseTo(goal.estimate.frame.usd! + goal.estimate.videos.usd!);
    expect(Object.keys(JSON.parse(await shortFingerprint(engine, goal.shortPlan!, "frame", 0, null)))).toEqual(["prompt", "rules", "settings", "references"]);
    expect(await refusal({ action: "approve", goal_id: goal.goalId, revision: goal.revision, stage: "storyboards" })).toBe("This short has no storyboard.");
    const frame = await settled(await invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision, stage: "frame" }));
    expect(frame).toMatchObject({ stage: "videos", status: "review" });
    expect(frame.stages.frame!.outputs[0]!.stale).toBeNull();
    expect(mediaJobs(FRAME_MODEL)[0]?.payload).toMatchObject({ refs: { image: [imageIds[1]] } });
    expect(stepPrompt(frame.chainId, "frame")).not.toMatch(/storyboard/iu);
    expect(stub.submissions.map((submission) => submission.path)).toEqual([FRAME_EDIT]);
  });
});
