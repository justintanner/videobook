import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { waitForChainRun } from "../chain-executor.js";
import { createEngineForTest } from "../engine.js";
import { buildLegacyGoalShortPlan } from "../goal-short-plan.js";
import { LEGACY_SHORT_SILENCE, SHORT_RULES } from "../goal-short-rules.js";
import { createShortGoal, shortFingerprint } from "../goal-short-runtime.js";
import { readGoal, saveGoal } from "../goal-store.js";
import { installFalDynamicEstimator, lowerBoundWarnings } from "../media/cost.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { configureProviderPollDriverForTests, pauseBookQueueForTests, resetProviderPollDriverForTests } from "../queue.js";
import { testBudget } from "../test-budget.js";
import { createTestClient } from "../test-client.js";
import { goalTestCharacters } from "../test-goals.js";
import { copyVideoFixture } from "../test-media-fixtures.js";
import { redirectFalStorage, SHORT_STUB_REFUSAL, startShortStub, type ShortStub } from "../test-short-stub.js";
import type { ShortGoalSnapshot } from "./goal.js";

const TWO_BEATS = 'he waits, 20 seconds, frame: "A bus stop at dusk." beat 1: "He waits under the shelter." beat 2: "He boards the bus."';
const THREE_BEATS = 'he waits, 31 seconds, frame: "A bus stop at dusk." beat 1: "He waits." beat 2: "He checks the road." beat 3: "He boards the bus."';
const ONE_BEAT = 'he waits, frame: "A bus stop at dusk." beat 1: "He waits under the shelter."';
const STALE = "The frame or an earlier clip changed after this clip was made.";

describe("continuing a short with H3 Max Extend", () => {
  let stub: ShortStub;
  let fixtures: string;
  let clips: Record<"base" | "extended" | "short" | "long", Buffer>;
  let root: string;
  let engine: Engine;
  let client: Client;
  let bookId: string;
  let notebookId: string;
  let imageIds: string[];
  let restoreFetch: () => void;
  let restoreEndpoints: () => void;
  let restoreEstimator: () => void;
  const savedEnv = new Map<string, string | undefined>();

  async function fixture(name: string, durationSec: number): Promise<Buffer> {
    const path = join(fixtures, `${name}.mp4`);
    await copyVideoFixture({ width: 90, height: 160, durationSec, fps: 4, source: "color", color: "green", audio: { frequency: 330 } }, path);
    return readFile(path);
  }

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-goal-continue-fixtures-"));
    clips = { base: await fixture("base", 10), extended: await fixture("extended", 20), short: await fixture("short", 1), long: await fixture("long", 61) };
    stub = await startShortStub({ frame: await sharp({ create: { width: 90, height: 160, channels: 3, background: "#5b7a4c" } }).png().toBuffer(), clip: clips.base, extended: clips.extended });
  });

  afterAll(async () => {
    await stub.close();
    await rm(fixtures, { recursive: true, force: true });
  });

  beforeEach(async () => {
    stub.reset();
    stub.media = { ...stub.media, clip: clips.base, extended: clips.extended };
    for (const [key, value] of [["FAL_API_KEY", "local-fal-key"], ["VIDEOBOOK_HAR_CAPTURE", "off"]] as const) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    restoreFetch = redirectFalStorage(stub.baseURL);
    restoreEndpoints = configureProviderEndpoints({ falQueueBaseURL: stub.baseURL });
    restoreEstimator = installFalDynamicEstimator(async () => ({ total_cost: 0.21, currency: "USD" }));
    configureProviderPollDriverForTests({ intervalMs: 50 });
    root = await mkdtemp(join(tmpdir(), "videobook-goal-continue-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    const notebook = await engine.notebooks.create("Shorts");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    imageIds = await goalTestCharacters(engine, notebookId);
  });

  afterEach(async () => {
    await client.close();
    resetProviderPollDriverForTests();
    restoreEstimator();
    restoreEndpoints();
    restoreFetch();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const raw = (args: Record<string, unknown>) => client.callTool({ name: "video_goal", arguments: { book_id: bookId, notebook_id: notebookId, ...args } });
  const textOf = (result: Awaited<ReturnType<typeof raw>>) => (result.content as Array<{ text: string }>)[0]!.text;

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
  const chainRuns = () => Object.keys(engine.settings.get<{ runs: Record<string, unknown> }>("application.chain-runs.v1")?.runs ?? {}).length;
  const extensions = () => stub.submissions.filter((submission) => submission.path === "/minimax/h3-max/extend-video");
  const output = (goal: ShortGoalSnapshot, index: number) => goal.stages.videos!.outputs.find((item) => item.index === index)!;

  async function short(brief: string): Promise<ShortGoalSnapshot> {
    return status((await createShortGoal(engine, bookId, notebookId, { brief, requestId: uuidv7() })).goalId);
  }

  async function settled(goal: ShortGoalSnapshot): Promise<ShortGoalSnapshot> {
    await waitForChainRun(engine, goal.chainId!, testBudget(90_000));
    return status(goal.goalId);
  }

  async function approved(goal: ShortGoalSnapshot): Promise<ShortGoalSnapshot> {
    return settled(await invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision }));
  }

  it("extends the base clip with H3 Max Extend and finishes from the whole short", async () => {
    const frame = await approved(await short(TWO_BEATS));
    const base = await approved(frame);
    expect(base).toMatchObject({ stage: "videos", status: "review", finish: null });
    const baseId = output(base, 0).artifactId;
    const extended = await approved(base);
    expect(extensions()).toHaveLength(1);
    expect(extensions()[0]!.body).toMatchObject({
      duration: 10, output: "extended", enable_prompt_expansion: false, aspect_ratio: "auto", resolution: "1080P", video_url: expect.stringMatching(/^http/u),
    });
    expect(String(extensions()[0]!.body.prompt)).toMatch(/^He boards the bus\.\n\nContinue the same shot/u);
    const job = engine.jobs.queue.list({ type: "generate_media", limit: 100 }).find((item) => item.payload.model === "fal:minimax/h3-max/extend-video");
    expect(job?.payload).toMatchObject({ refs: { video: [baseId] }, transcribe: false });
    const wholeId = output(extended, 1).artifactId;
    const original = await engine.metadata.artifacts.read<Record<string, unknown>>(wholeId, "original");
    expect(original.ok && original.value).toMatchObject({ model: "fal:minimax/h3-max/extend-video", hasAudio: true, transcribe: false });
    expect(extended).toMatchObject({ stage: "videos", status: "review", finish: { status: "review", sourceArtifactId: wholeId } });
    await pauseBookQueueForTests(bookId);
    expect((await invoke({ action: "finish", goal_id: extended.goalId })).finish).toMatchObject({ status: "running", sourceArtifactId: wholeId });
    expect(stub.unexpected).toEqual([]);
  });

  it("continues and finishes a version 4 short saved with a character, keeping its stored prompts", async () => {
    const manifest = await engine.files.manifest(imageIds[0]!);
    const notebook = engine.notebooks.read(notebookId);
    if (!manifest.ok || !notebook.ok) throw new Error("missing the character image");
    const cell = notebook.value.cells.find((candidate) => candidate.outputArtifactId === imageIds[0])!;
    const plan = buildLegacyGoalShortPlan({
      title: "Waiting", aspectRatio: "9:16",
      character: {
        name: "Main character", description: "a man in a green shirt",
        references: [{ kind: "image", artifactId: imageIds[0]!, cellId: cell.id, address: notebookGridTag(cell.slot), label: "Character 1", objectHash: manifest.value.files[0]!.objectHash }],
      },
      framePrompt: "A bus stop at dusk.", beats: ["He waits under the shelter.", "He boards the bus."], segmentSeconds: [10, 10], extraReferences: [],
    });
    const created = await invoke({ action: "create", brief: TWO_BEATS, plan, request_id: uuidv7() });
    expect(created).toMatchObject({ planVersion: 4, stage: "frame", status: "review", storyboard: null });
    const frame = await approved(created);
    const base = await approved(frame);
    const frameId = frame.stages.frame!.outputs[0]!.artifactId;
    const clipFingerprint = await shortFingerprint(engine, base.shortPlan!, "videos", 0, frameId);
    const extended = await approved(base);
    expect(stub.submissions.map((submission) => submission.path)).toEqual(["/openai/gpt-image-2.6/sunburst/edit", "/minimax/h3-max/reference-to-video", "/minimax/h3-max/extend-video"]);
    expect(String(stub.submissions[1]!.body.prompt)).toContain(`reference image 1 is Main character: keep the same person in the same clothes.\n\n${SHORT_RULES.video}\n\n${LEGACY_SHORT_SILENCE}`);
    expect(String(extensions()[0]!.body.prompt)).toBe(`He boards the bus.\n\nContinue the same shot: the same person, clothes, place and light.\n\n${SHORT_RULES.video}\n\n${LEGACY_SHORT_SILENCE}`);
    expect(await shortFingerprint(engine, extended.shortPlan!, "videos", 0, frameId)).toBe(clipFingerprint);
    const wholeId = output(extended, 1).artifactId;
    expect(extended).toMatchObject({ planVersion: 4, stage: "videos", status: "review", finish: { status: "review", sourceArtifactId: wholeId } });
    expect(extended.stages.frame!.outputs[0]!.artifactId).toBe(frameId);
    await pauseBookQueueForTests(bookId);
    expect((await invoke({ action: "finish", goal_id: created.goalId })).finish).toMatchObject({ status: "running", sourceArtifactId: wholeId });
    expect(stub.unexpected).toEqual([]);
  });

  it("adds a beat to a finished one-segment short and extends it, clearing the earlier finish", async () => {
    const frame = await approved(await short(ONE_BEAT));
    const clip = await approved(frame);
    const clipId = output(clip, 0).artifactId;
    const finished = saveGoal(engine, { ...readGoal(engine, clip.goalId), status: "completed", finish: { status: "completed", sourceArtifactId: clipId, finalArtifactId: clipId, error: null } });
    expect(finished.status).toBe("completed");
    const plan = clip.shortPlan!;
    const appended = await invoke({ action: "update", goal_id: clip.goalId, revision: clip.revision, plan: { ...plan, segments: [...plan.segments, { prompt: "He steps onto the bus.", seconds: 6 }] } });
    expect(appended).toMatchObject({ status: "review", finish: { status: "completed" } });
    expect(appended.estimate.segments).toHaveLength(2);
    expect(appended.estimate.segments![1]!.usd).toBeGreaterThan(0);
    const started = await invoke({ action: "approve", goal_id: clip.goalId, revision: appended.revision });
    expect(started.finish).toBeNull();
    const extended = await settled(started);
    expect(extensions()[0]!.body).toMatchObject({ duration: 6 });
    expect(extended.finish).toMatchObject({ status: "review", sourceArtifactId: output(extended, 1).artifactId });
  });

  it("refuses a fifth segment, more than 60 seconds and a source clip outside 1.625 to 60 seconds", async () => {
    const goal = await short(TWO_BEATS);
    const plan = goal.shortPlan!;
    const beat = (seconds: number) => ({ prompt: "He waits.", seconds });
    expect(await refusal({ action: "update", goal_id: goal.goalId, revision: goal.revision, plan: { ...plan, segments: [beat(10), beat(10), beat(10), beat(10), beat(10)] } })).toMatch(/Input validation error/u);
    expect(await refusal({ action: "update", goal_id: goal.goalId, revision: goal.revision, plan: { ...plan, segments: [beat(15), beat(15), beat(15), beat(16)] } })).toMatch(/Input validation error/u);
    const outside: [Buffer, (seconds: number) => boolean][] = [[clips.short, (seconds) => seconds < 1.625], [clips.long, (seconds) => seconds > 60]];
    for (const [clip, beyond] of outside) {
      stub.media = { ...stub.media, clip };
      const base = await approved(await approved(await short(TWO_BEATS)));
      const runs = chainRuns();
      const message = await refusal({ action: "approve", goal_id: base.goalId, revision: base.revision });
      const reported = /^The current clip runs (\d+\.\d{2}) seconds, and H3 Extend takes a source of 1\.625 to 60 seconds\.$/u.exec(message);
      expect(reported, message).not.toBeNull();
      expect(beyond(Number(reported![1]))).toBe(true);
      expect(chainRuns()).toBe(runs);
    }
  });

  it("marks later segments stale when an earlier one changes and regenerates them from the new source", async () => {
    const goal = await short(THREE_BEATS);
    const frame = await approved(goal);
    const first = await approved(frame);
    const second = await approved(first);
    const third = await approved(second);
    expect(third.finish).toMatchObject({ status: "review", sourceArtifactId: output(third, 2).artifactId });
    const oldSecond = output(third, 1).artifactId;
    const regenerated = await settled(await invoke({ action: "regenerate", goal_id: goal.goalId, revision: third.revision, stage: "videos", index: 1 }));
    const newSecond = output(regenerated, 1).artifactId;
    expect(newSecond).not.toBe(oldSecond);
    expect(output(regenerated, 2).stale).toBe(STALE);
    expect(output(regenerated, 2).versions).toHaveLength(1);
    expect(regenerated).toMatchObject({ status: "review", finish: null });
    const before = extensions().length;
    const refreshed = await approved(regenerated);
    expect(extensions()).toHaveLength(before + 1);
    const sources = engine.jobs.queue.list({ type: "generate_media", limit: 100 })
      .filter((job) => job.payload.model === "fal:minimax/h3-max/extend-video")
      .map((job) => (job.payload.refs as { video?: string[] }).video?.[0]);
    expect(sources).toContain(newSecond);
    expect(output(refreshed, 2).stale).toBeNull();
    expect(output(refreshed, 2).versions).toHaveLength(2);
    expect(refreshed.finish).toMatchObject({ status: "review", sourceArtifactId: output(refreshed, 2).artifactId });
    const reselected = await invoke({ action: "select", goal_id: goal.goalId, stage: "videos", index: 1, artifact_id: oldSecond });
    expect(output(reselected, 2).stale).toBe(STALE);
    expect(reselected.finish).toBeNull();
    const firstFrame = frame.stages.frame!.outputs[0]!.artifactId;
    const newFrame = await settled(await invoke({ action: "regenerate", goal_id: goal.goalId, revision: reselected.revision, stage: "frame" }));
    expect(newFrame.stages.frame!.outputs[0]!.artifactId).not.toBe(firstFrame);
    expect([0, 1, 2].map((index) => output(newFrame, index).stale)).toEqual([STALE, STALE, STALE]);
  });

  it("refuses to retry a continuation whose source clip changed", async () => {
    const frame = await approved(await short(TWO_BEATS));
    const firstBase = await approved(frame);
    const versionA = output(firstBase, 0).artifactId;
    const secondBase = await settled(await invoke({ action: "regenerate", goal_id: firstBase.goalId, revision: firstBase.revision, stage: "videos", index: 0 }));
    expect(output(secondBase, 0).artifactId).not.toBe(versionA);
    stub.failNext = true;
    const failed = await settled(await invoke({ action: "approve", goal_id: secondBase.goalId, revision: secondBase.revision }));
    expect(failed).toMatchObject({ status: "failed", error: expect.stringContaining(SHORT_STUB_REFUSAL) });
    const stored = readGoal(engine, failed.goalId);
    const videos = stored.stages.videos!;
    saveGoal(engine, { ...stored, stages: { ...stored.stages, videos: { ...videos, outputs: videos.outputs.map((item) => item.index === 0 ? { ...item, artifactId: versionA } : item) } } });
    expect(await refusal({ action: "retry", goal_id: failed.goalId }))
      .toBe("The references or selected versions changed after this attempt. Regenerate using the current selection instead of retrying the older request.");
  });

  it("prices each segment and sums them, keeping the lower-bound marker", async () => {
    const goal = await short(THREE_BEATS);
    expect(goal.estimate.segments).toHaveLength(3);
    const segments = goal.estimate.segments!;
    expect(goal.estimate.videos.usd).toBeCloseTo(segments.reduce((sum, segment) => sum + segment.usd!, 0));
    expect(lowerBoundWarnings(goal.estimate.videos.warnings)).toBe(true);
    for (const segment of segments) expect(lowerBoundWarnings(segment.warnings)).toBe(true);
  });
});
