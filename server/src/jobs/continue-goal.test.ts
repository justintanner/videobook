import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { resumeOpenChains, waitForChainRun, type ChainRunRecord } from "../chain-executor.js";
import { createEngineForTest } from "../engine.js";
import { goalAutomationTotals } from "../goal-automation-model.js";
import { guardGoalSubmission } from "../goal-automation-guard.js";
import { runGoalContinuation, sweepGoalAutomation } from "../goal-automation.js";
import { writeRemixPreferences } from "../goal-remix-analysis.js";
import { createShortGoal } from "../goal-short-runtime.js";
import { readGoal, requireGoalShortContent, saveGoal, writeGoalShortContent } from "../goal-store.js";
import { installFalDynamicEstimator } from "../media/cost.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { configureProviderPollDriverForTests, pauseBookQueueForTests, resetProviderPollDriverForTests, resumeBookQueueForTests, waitForBookQueuesIdleForTests } from "../queue.js";
import { writeTaggingSettings } from "../tag-settings.js";
import { testBudget } from "../test-budget.js";
import { createTestClient } from "../test-client.js";
import { goalTestCharacters } from "../test-goals.js";
import { copyVideoFixture } from "../test-media-fixtures.js";
import { redirectFalStorage, startShortStub, type ShortStub } from "../test-short-stub.js";
import type { ShortGoalSnapshot } from "../tools/goal.js";
import { getAllToolDefs } from "../tools/index.js";
import type { GenerateMediaJob } from "./generate-media.js";

const BRIEF = '@a1, 5 seconds. frame: "A man waits under a bus shelter." video: "He waits, then waves to the bus."';

describe("durable automatic goal continuation", () => {
  let stub: ShortStub;
  let clip: Buffer;
  let audioClip: Buffer;
  let fixtures: string;
  let root: string;
  let engine: Engine;
  let client: Client;
  let bookId: string;
  let notebookId: string;
  let restoreFetch: () => void;
  let restoreEndpoints: () => void;
  let restoreEstimator: () => void;
  const environment = new Map<string, string | undefined>();

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-auto-fixtures-"));
    const path = join(fixtures, "clip.mp4");
    await copyVideoFixture({ width: 90, height: 160, durationSec: 5, fps: 12, source: "color", color: "blue", audio: false }, path);
    clip = await readFile(path);
    const audioPath = join(fixtures, "audio.mp4");
    await copyVideoFixture({ width: 90, height: 160, durationSec: 5, fps: 12, source: "color", color: "blue", audio: { frequency: 440 } }, audioPath);
    audioClip = await readFile(audioPath);
    stub = await startShortStub({ frame: await sharp({ create: { width: 90, height: 160, channels: 3, background: "#557744" } }).png().toBuffer(), clip, extended: clip });
  });
  afterAll(async () => { await stub.close(); await rm(fixtures, { recursive: true, force: true }); });
  beforeEach(async () => {
    stub.reset(); stub.outputUnits = 1; stub.media.clip = clip;
    for (const [key, value] of [["FAL_API_KEY", "offline-auto-key"], ["OPENAI_API_KEY", "offline-auto-key"], ["VIDEOBOOK_HAR_CAPTURE", "off"]]) {
      environment.set(key!, process.env[key!]); process.env[key!] = value;
    }
    restoreFetch = redirectFalStorage(stub.baseURL);
    restoreEndpoints = configureProviderEndpoints({ falQueueBaseURL: stub.baseURL, openaiBaseURL: stub.baseURL });
    restoreEstimator = installFalDynamicEstimator(async () => ({ total_cost: 0.21, currency: "USD" }));
    configureProviderPollDriverForTests({ intervalMs: 50 });
    root = await mkdtemp(join(tmpdir(), "videobook-auto-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    writeTaggingSettings(engine, { analysisOnNewAssets: false });
    writeRemixPreferences(engine, { audio: "mute", branding: false, reviewImages: false, autoContinue: true, allowanceUsd: 10 });
    const notebook = await engine.notebooks.create("Automatic shorts");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    await goalTestCharacters(engine, notebookId);
  });
  afterEach(async () => {
    stub.holdResults = false;
    await resumeBookQueueForTests(bookId);
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(30_000) });
    await client.close(); resetProviderPollDriverForTests();
    restoreEstimator(); restoreEndpoints(); restoreFetch();
    for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  async function invoke(args: Record<string, unknown>): Promise<ShortGoalSnapshot> {
    const result = await client.callTool({ name: "video_goal", arguments: { book_id: bookId, notebook_id: notebookId, ...args } });
    const text = (result.content as { text: string }[])[0]!.text;
    expect(result.isError, text).toBeFalsy();
    return JSON.parse(text) as ShortGoalSnapshot;
  }
  const status = (goalId: string) => invoke({ action: "status", goal_id: goalId });
  async function create() { return status((await createShortGoal(engine, bookId, notebookId, { brief: BRIEF, requestId: uuidv7() })).goalId); }
  const receipts = (goal: ShortGoalSnapshot, stages: string[]) => goal.generationHistory?.filter(entry => entry.selected && stages.includes(entry.stage) && entry.artifactId && entry.mediaHash)
    .map(entry => ({ artifact_id: entry.artifactId, media_hash: entry.mediaHash })) ?? [];
  const start = (goal: ShortGoalSnapshot, args: Record<string, unknown> = {}) => invoke({ action: "auto_continue", goal_id: goal.goalId, revision: goal.revision, confirmed: true, allowance_usd: 10,
    reviewed_images: receipts(goal, ["replacement", "frame"]), ...args });
  async function stopped(goalId: string, reason: RegExp) {
    await expect.poll(() => readGoal(engine, goalId).automation, { timeout: testBudget(40_000) }).toMatchObject({ status: "paused", reason: expect.stringMatching(reason) });
    return status(goalId);
  }
  async function manuallyGenerateVideo(goal: ShortGoalSnapshot) {
    const running = await invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision, stage: "videos" });
    await waitForChainRun(engine, running.chainId!, testBudget(40_000));
    return status(goal.goalId);
  }

  it("submits once after duplicate approval, reserves and settles actual cost, then stops before H3's lower-bound price", async () => {
    const goal = await create();
    expect(goal.automation).toBeUndefined();
    await Promise.all([start(goal), start(goal)]);
    const paused = await stopped(goal.goalId, /complete next-step estimate.*lower bound/u);
    expect(stub.submissions).toHaveLength(1);
    expect(stub.noRetryHeaders).toEqual(["1"]);
    expect(paused.stages.frame?.outputs).toHaveLength(1);
    expect(paused.automation?.reservations).toHaveLength(1);
    expect(paused.automation?.reservations[0]).toMatchObject({ status: "settled", amountUsd: 0.21, spentUsd: 0.21, submittedArtifactIds: [expect.any(String)], usageIds: [expect.any(String)] });
    expect(goalAutomationTotals(paused.automation!)).toMatchObject({ spent: 0.21, reserved: 0, remaining: 9.79 });
    await sweepGoalAutomation(engine);
    expect(stub.submissions).toHaveLength(1);
    expect(stub.plannerRequests).toEqual([]);
    expect(stub.unexpected).toEqual([]);
  });

  it("honors image review, resumes without remaking the image, then finishes locally after the uncertain-price video was reviewed manually", async () => {
    writeRemixPreferences(engine, { audio: "mute", branding: false, reviewImages: true, autoContinue: true, allowanceUsd: 10 });
    const goal = await create();
    await start(goal);
    const review = await stopped(goal.goalId, /Review the action setup image/u);
    await start(review, { reviewed_images: [] });
    await stopped(goal.goalId, /Review the action setup image/u);
    const staleApproval = await client.callTool({ name: "video_goal", arguments: { book_id: bookId, notebook_id: notebookId, action: "auto_continue", goal_id: goal.goalId,
      revision: review.revision, confirmed: true, allowance_usd: 10, reviewed_images: [{ artifact_id: review.stages.frame!.outputs[0]!.artifactId, media_hash: "earlier-file" }] } });
    expect(staleApproval.isError).toBe(true);
    expect((staleApproval.content as { text: string }[])[0]!.text).toContain("reviewed output changed");
    await start(review);
    const priced = await stopped(goal.goalId, /lower bound/u);
    const generated = await manuallyGenerateVideo(priced);
    await start(generated);
    await expect.poll(() => {
      const current = readGoal(engine, goal.goalId);
      return JSON.stringify({ status: current.automation?.status, reason: current.automation?.reason, step: current.automation?.step,
        finish: current.finish?.status, finishError: current.finish?.error });
    }, { timeout: testBudget(10_000) }).toContain('"status":"completed"');
    const done = await status(goal.goalId);
    expect(done.finish).toMatchObject({ status: "completed", finalArtifactId: expect.any(String) });
    expect(done.quality?.["finish:0"].result?.technical.status).toBe("pass");
    expect(done.stages.frame?.outputs[0]?.artifactId).toBe(review.stages.frame?.outputs[0]?.artifactId);
    expect(stub.submissions).toHaveLength(2);
    expect(stub.plannerRequests).toEqual([]);
  }, testBudget(120_000));

  it("pauses before upload when the allowance or credential is missing", async () => {
    const goal = await create();
    await start(goal, { allowance_usd: 0 });
    const budget = await stopped(goal.goalId, /exceeds the remaining allowance/u);
    expect(stub.submissions).toEqual([]); expect(stub.uploads.size).toBe(0);
    delete process.env.FAL_API_KEY;
    await start(budget);
    await stopped(goal.goalId, /FAL_API_KEY/u);
    expect(stub.submissions).toEqual([]); expect(stub.uploads.size).toBe(0);
  });

  it("holds an unsettled reservation after an omitted bill and never invents actual cost", async () => {
    stub.outputUnits = null;
    const goal = await create();
    await start(goal);
    const paused = await stopped(goal.goalId, /provider cost is still unsettled/u);
    expect(paused.automation?.reservations[0]).toMatchObject({ status: "uncertain", spentUsd: 0 });
    expect(goalAutomationTotals(paused.automation!)).toMatchObject({ spent: 0, reserved: 0.21, unsettled: true });
    await start(paused);
    await stopped(goal.goalId, /provider cost is still unsettled/u);
    expect(stub.submissions).toHaveLength(1);
  });

  it("stops when actual cost exceeds the estimate-based allowance", async () => {
    restoreEstimator();
    restoreEstimator = installFalDynamicEstimator(async request => ({ total_cost: request.estimate_type === "unit_price" ? 0.5 : 0.21, currency: "USD" }));
    const goal = await create();
    await start(goal, { allowance_usd: 0.3 });
    const paused = await stopped(goal.goalId, /Recorded provider cost exceeds/u);
    expect(goalAutomationTotals(paused.automation!)).toMatchObject({ spent: 0.5, reserved: 0, remaining: 0 });
    expect(stub.submissions).toHaveLength(1);
  });

  it("stops for a required visual review without silently requesting an unknown-price check", async () => {
    writeRemixPreferences(engine, { branding: false, reviewImages: false, semanticChecks: true });
    const goal = await create();
    await start(goal);
    const paused = await stopped(goal.goalId, /required visual check/u);
    expect(paused.quality?.["frame:0"].result).toMatchObject({ technical: { status: "pass" }, semantic: { status: "not-requested" } });
    expect(stub.plannerRequests).toEqual([]);
    expect(stub.submissions).toHaveLength(1);
  });

  it("requires listening to generated audio and resumes local finishing after explicit review", async () => {
    stub.media.clip = audioClip;
    const goal = await create();
    await start(goal);
    const paused = await stopped(goal.goalId, /lower bound/u);
    const generated = await manuallyGenerateVideo(paused);
    await start(generated);
    const audio = await stopped(goal.goalId, /Listen to the generated audio/u);
    await start(audio, { reviewed_audio: receipts(audio, ["videos"]) });
    await expect.poll(() => readGoal(engine, goal.goalId).automation?.status, { timeout: testBudget(30_000) }).toBe("completed");
    expect(stub.submissions).toHaveLength(2);
    expect(stub.plannerRequests).toEqual([]);
  }, testBudget(90_000));

  it("recovers a transient download failure using the same provider task", async () => {
    stub.downloadFailures = 1;
    const goal = await create();
    await start(goal);
    await stopped(goal.goalId, /lower bound/u);
    expect(stub.submissions).toHaveLength(1);
    expect(readGoal(engine, goal.goalId).stages.frame?.outputs).toHaveLength(1);
  });

  it.each([403, 422])("preserves completed work and stops after HTTP %s without creative retry", async code => {
    stub.rejectNext = { status: code, message: code === 403 ? "User locked: exhausted balance" : "Invalid reference request" };
    const goal = await create();
    await start(goal);
    await stopped(goal.goalId, new RegExp(String(code), "u"));
    expect(stub.submissions).toHaveLength(1);
    expect(stub.noRetryHeaders).toEqual(["1"]);
    expect(readGoal(engine, goal.goalId).stages.frame?.attempts).toHaveLength(1);
    const retry = await invoke({ action: "retry", goal_id: goal.goalId });
    await waitForChainRun(engine, retry.chainId!, testBudget(30_000));
    expect(stub.submissions).toHaveLength(2);
    const current = await status(goal.goalId);
    expect(current.stages.frame?.attempts).toHaveLength(2);
    expect(current.stages.frame?.outputs).toHaveLength(1);
    expect(current.automation?.status).toBe("paused");
  });

  it("does not rotate uploads after a confirmed account failure", async () => {
    stub.uploadFailureStatus = 403;
    const goal = await create();
    await start(goal);
    await stopped(goal.goalId, /403/u);
    expect(stub.submissions).toEqual([]);
    expect(stub.uploads.size).toBe(0);
    expect(stub.unexpected).toEqual([]);
  });

  it.each(["pending", "missing-placement-checkpoint", "provider-failure"])("recovers %s after reload without another submission", async scenario => {
    stub.holdResults = true;
    stub.failNext = scenario === "provider-failure";
    const goal = await create();
    await start(goal);
    await expect.poll(() => stub.submissions.length, { timeout: testBudget(20_000) }).toBe(1);
    await expect.poll(() => stub.polls, { timeout: testBudget(20_000) }).toBeGreaterThan(0);
    await client.close();
    engine = createEngineForTest(join(root, "book"));
    if (scenario === "missing-placement-checkpoint") {
      const store = engine.settings.get<{ runs: Record<string, ChainRunRecord>; requestIndex: Record<string, string> }>("application.chain-runs.v1")!;
      const run = store.runs[readGoal(engine, goal.goalId).chainId!]!;
      delete run.steps[0]!.outputs!.cell_id;
      delete run.steps[0]!.outputs!.address;
      expect(engine.settings.set("application.chain-runs.v1", store).ok).toBe(true);
    }
    client = await createTestClient(join(root, "book"));
    const definitions = getAllToolDefs(engine);
    resumeOpenChains(engine, name => definitions.find(value => value.name === name));
    stub.holdResults = false;
    const paused = await stopped(goal.goalId, scenario === "provider-failure" ? /policy|refus/u : /lower bound/u);
    expect(stub.submissions).toHaveLength(1);
    expect(paused.automation?.reservations).toHaveLength(1);
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    expect(notebook.value.cells.filter(cell => cell.type === "generate_image")).toHaveLength(1);
    if (scenario === "provider-failure") {
      expect(paused.status).toBe("failed");
      return;
    }
    expect(paused.stages.frame?.outputs).toHaveLength(1);
    expect(paused.automation?.reservations[0]?.status).toBe("settled");
  }, testBudget(120_000));

  it("fences repeated submission, changed plans and cancellation before another provider call", async () => {
    const goal = await create();
    await start(goal);
    await stopped(goal.goalId, /lower bound/u);
    const job = engine.jobs.queue.list({ type: "generate_media", limit: 100 })[0]!.payload as GenerateMediaJob;
    const current = readGoal(engine, goal.goalId);
    saveGoal(engine, { ...current, automation: { ...current.automation!, status: "running" } });
    await expect(guardGoalSubmission(engine, job, true)).rejects.toThrow(/already started/u);
    const content = requireGoalShortContent(engine, current);
    await writeGoalShortContent(engine, current, { ...content, brief: `${content.brief} Changed intent.` });
    await expect(guardGoalSubmission(engine, job, false)).rejects.toThrow(/recipe changed/u);
    await invoke({ action: "cancel", goal_id: goal.goalId });
    await expect(guardGoalSubmission(engine, job, true)).rejects.toThrow(/stopped/u);
    expect(stub.submissions).toHaveLength(1);
  });

  it("revalidates price and actual reference bytes between reservation and submission", async () => {
    const goal = await create();
    await pauseBookQueueForTests(bookId);
    const approved = await start(goal);
    await runGoalContinuation(engine, { goalId: goal.goalId, automationId: approved.automation!.id, planKey: approved.automation!.planKey }, approved.automation!.jobId!);
    await expect.poll(() => engine.jobs.queue.list({ type: "generate_media" }).length, { timeout: testBudget(10_000) }).toBe(1);
    const job = engine.jobs.queue.list({ type: "generate_media" })[0]!.payload as GenerateMediaJob;
    await expect(guardGoalSubmission(engine, job, false)).resolves.toBeUndefined();
    const current = readGoal(engine, goal.goalId);
    const automation = current.automation!;
    saveGoal(engine, { ...current, automation: { ...automation, reservations: automation.reservations.map(value => ({ ...value, amountUsd: 0.01 })) } });
    await expect(guardGoalSubmission(engine, job, true)).rejects.toThrow(/fresh estimate/u);
    saveGoal(engine, { ...readGoal(engine, goal.goalId), automation });
    const source = job.refs.image![0]!;
    await engine.files.write(source, "original.png", await sharp({ create: { width: 96, height: 128, channels: 3, background: "#ff0000" } }).png().toBuffer());
    await expect(guardGoalSubmission(engine, job, true)).rejects.toThrow(/source image changed/u);
    await invoke({ action: "cancel", goal_id: goal.goalId });
    expect(stub.submissions).toEqual([]);
    expect(stub.uploads.size).toBe(0);
  });

  it("pauses queued automatic work without waiting for a generation and keeps saved goals manual", async () => {
    const goal = await create();
    await pauseBookQueueForTests(bookId);
    await start(goal);
    const paused = await invoke({ action: "pause_auto", goal_id: goal.goalId });
    expect(paused.automation?.status).toBe("paused");
    await resumeBookQueueForTests(bookId);
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(10_000) });
    expect(stub.submissions).toEqual([]);
    const content = requireGoalShortContent(engine, readGoal(engine, goal.goalId));
    if (content.plan?.version !== 5) throw new Error("Expected current goal");
    const { analysis: _analysis, ...old } = content.plan;
    await writeGoalShortContent(engine, readGoal(engine, goal.goalId), { ...content, plan: old });
    const result = await client.callTool({ name: "video_goal", arguments: { book_id: bookId, notebook_id: notebookId, action: "auto_continue", goal_id: goal.goalId, revision: content.revision, confirmed: true, allowance_usd: 10 } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("current analyzed short");
  });
});
