import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { v7 as uuidv7 } from "uuid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { createEngineForTest } from "../engine.js";
import { buildRemixAnalysis, readRemixPreferences } from "../goal-remix-analysis.js";
import { waitForChainRun } from "../chain-executor.js";
import { compileShortClipStep, shortGenerationSegments } from "../goal-short-plan.js";
import { probeVideo } from "../ffmpeg.js";
import { cleanupSource } from "../video-cleanup/source.js";
import { cleanupCandidate } from "../video-cleanup/prepared.js";
import { readCleanupRequest } from "../video-cleanup/service.js";
import { indexRenderRequest, writeRenderSetting } from "../render-requests.js";
import { configureProviderPollDriverForTests, pauseBookQueueForTests, resetProviderPollDriverForTests, resumeBookQueueForTests, waitForBookQueuesIdleForTests } from "../queue.js";
import { readGoal, saveGoal } from "../goal-store.js";
import { reconcileAwaitingNotebookOutputs, runNotebookCell } from "../jobs/run-notebook.js";
import { installFalDynamicEstimator } from "../media/cost.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { createTestClient } from "../test-client.js";
import { copyVideoFixture } from "../test-media-fixtures.js";
import { redirectFalStorage, startShortStub, type ShortStub } from "../test-short-stub.js";
import { testBudget } from "../test-budget.js";
import { writeTaggingSettings } from "../tag-settings.js";
import { saveWatermarkProfile } from "../watermark-config.js";
import type { ShortGoalSnapshot } from "./goal.js";

describe("initial source-goal analysis", () => {
  let fixtures: string;
  let root: string;
  let engine: Engine;
  let client: Client;
  let stub: ShortStub;
  let bookId: string;
  let notebookId: string;
  let sourceId: string;
  let identityId: string;
  let restoreEndpoints: () => void;
  let restoreFetch: () => void;
  let restoreEstimator: () => void;
  const environment = new Map<string, string | undefined>();

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-initial-analysis-fixtures-"));
    await copyVideoFixture({ width: 180, height: 320, durationSec: 14, fps: 12, source: "color", color: "green", audio: { frequency: 330 } }, join(fixtures, "source.mp4"));
    await copyVideoFixture({ width: 180, height: 320, durationSec: 14, fps: 12, source: "color", color: "blue", audio: false }, join(fixtures, "changed.mp4"));
    await copyVideoFixture({ width: 180, height: 320, durationSec: 18, fps: 12, source: "color", color: "purple", audio: false }, join(fixtures, "long.mp4"));
    await copyVideoFixture({ width: 180, height: 320, durationSec: 1, fps: 12, source: "color", color: "purple", audio: false }, join(fixtures, "short.mp4"));
    const frame = await sharp({ create: { width: 180, height: 320, channels: 3, background: "#637b4d" } }).png().toBuffer();
    const clip = await readFile(join(fixtures, "source.mp4"));
    stub = await startShortStub({ frame, clip, extended: clip });
  });

  afterAll(async () => {
    await stub.close();
    await rm(fixtures, { recursive: true, force: true });
  });

  beforeEach(async () => {
    stub.reset();
    configureProviderPollDriverForTests({ intervalMs: 200 });
    for (const [key, value] of [["FAL_API_KEY", "local-fal-key"], ["OPENAI_API_KEY", "offline-openai-key"], ["VIDEOBOOK_HAR_CAPTURE", "off"]]) {
      environment.set(key!, process.env[key!]);
      process.env[key!] = value;
    }
    restoreEndpoints = configureProviderEndpoints({ falQueueBaseURL: stub.baseURL, openaiBaseURL: stub.baseURL });
    restoreFetch = redirectFalStorage(stub.baseURL);
    restoreEstimator = installFalDynamicEstimator(async () => ({ total_cost: 0.21, currency: "USD" }));
    root = await mkdtemp(join(tmpdir(), "videobook-initial-analysis-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    writeTaggingSettings(engine, { analysisOnNewAssets: false });
    const notebook = await engine.notebooks.create("Analysis");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    const source = await engine.artifacts.create("video", "Display montage");
    const identity = await engine.artifacts.create("image", "Identity photo");
    if (!source.ok || !identity.ok) throw new Error("Could not create references");
    sourceId = source.value.artifactId;
    identityId = identity.value.artifactId;
    const video = await engine.files.writeFromPath(sourceId, "original.mp4", join(fixtures, "source.mp4"));
    const image = await engine.files.write(identityId, "original.png", await sharp({ create: { width: 180, height: 320, channels: 3, background: "#637b4d" } }).png().toBuffer());
    if (!video.ok || !image.ok) throw new Error("Could not write references");
    const metadata = await engine.metadata.artifacts.write(sourceId, "original", { transcribe: false });
    if (!metadata.ok) throw new Error(metadata.error.message);
    const cells = [
      engine.notebooks.createCell({ type: "video", label: "Display montage", slot: { row: 0, column: 0 }, outputArtifactId: sourceId }),
      engine.notebooks.createCell({ type: "image", label: "Identity photo", slot: { row: 0, column: 1 }, outputArtifactId: identityId }),
    ];
    const written = await engine.notebooks.write({ ...notebook.value, cells });
    if (!written.ok) throw new Error(written.error.message);
  });

  afterEach(async () => {
    await resumeBookQueueForTests(bookId);
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(60_000) });
    resetProviderPollDriverForTests();
    await client.close();
    restoreEndpoints();
    restoreFetch();
    restoreEstimator();
    for (const [key, value] of environment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  function address(artifactId: string): string {
    const notebook = engine.notebooks.read(notebookId);
    const cell = notebook.ok ? notebook.value.cells.find(candidate => candidate.outputArtifactId === artifactId) : null;
    if (!cell) throw new Error("Reference cell is missing");
    return notebookGridTag(cell.slot);
  }
  const brief = () => `14 second montage from ${address(sourceId)}, with the man from ${address(identityId)} absent for the first 12 seconds. He appears and bites the gingerbread display in the final two seconds. Remove all OSG and keep the source audio. No new dialogue.`;
  const authored = () => `${brief()} replace: "Insert the man beside the display without replacing any figures." frame: "The man is ready to bite the display." video: "The empty display montage runs twelve seconds. The man enters and bites the display during the last two seconds."`;

  async function call(args: Record<string, unknown>) {
    return client.callTool({ name: "video_goal", arguments: { book_id: bookId, notebook_id: notebookId, ...args } });
  }

  async function invoke(args: Record<string, unknown>): Promise<ShortGoalSnapshot> {
    const result = await call(args);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(result.isError, text).not.toBe(true);
    return JSON.parse(text) as ShortGoalSnapshot;
  }

  async function settled(goal: ShortGoalSnapshot): Promise<ShortGoalSnapshot> {
    await expect.poll(() => readGoal(engine, goal.goalId).status, { timeout: testBudget(60_000) }).not.toBe("planning");
    const current = await invoke({ action: "status", goal_id: goal.goalId });
    expect(current.status, current.error ?? "").toBe("review");
    return current;
  }

  function analysisOf(goal: ShortGoalSnapshot) {
    if (goal.shortPlan?.version !== 5 || !goal.shortPlan.analysis) throw new Error("Expected initial analysis");
    return goal.shortPlan.analysis;
  }

  async function manualRerun(goal: ShortGoalSnapshot, prompt: string, legacyProducer = false) {
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const producerId = goal.stages.videos!.outputs[0]!.producerCellId;
    const producer = notebook.value.cells.find(cell => cell.id === producerId)!;
    const edited = { ...producer, prompt, ...(legacyProducer ? { inputs: Object.fromEntries(Object.entries(producer.inputs ?? {}).filter(([key]) => key !== "goalOrigin")) } : {}) };
    const saved = await engine.notebooks.write({ ...notebook.value, cells: notebook.value.cells.map(cell => cell.id === producerId ? edited : cell) });
    if (!saved.ok) throw new Error(saved.error.message);
    const rerun = await runNotebookCell(engine, bookId, notebookId, { ...notebook.value, cells: notebook.value.cells.map(cell => cell.id === producerId ? edited : cell) }, edited,
      { confirmPaid: true, runId: uuidv7() });
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(60_000) });
    await reconcileAwaitingNotebookOutputs(engine, bookId);
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(60_000) });
    return rerun.outputArtifactId;
  }

  function queueAnswer() {
    stub.plannerAnswers = [{
      title: "A bite of Christmas", replacement: "Insert the man beside the gingerbread display, keeping decorative figures and props.",
      frame: "The man is poised to bite the display itself. The display is intact.",
      beats: ["Preserve the display montage for twelve seconds. The man appears, bites the display itself and leaves a visible bite during the final two seconds."],
      understanding: { structure: "preserve-source", character: "insert", action: { start: 12, end: 14 },
        actionDescription: "The man bites the gingerbread display itself.", sourceFrameSeconds: 12,
        observations: { summary: "A display fills the sampled source frames.", subjects: ["display"], actions: [], overlays: [
          { description: "Added headline", kind: "overlay", x: 0.1, y: 0.1, width: 0.7, height: 0.1, start: 0, end: 14 },
          { description: "Printed sign on the display", kind: "physical", x: 0.3, y: 0.6, width: 0.2, height: 0.1, start: 0, end: 14 },
        ] }, uncertainties: [],
      },
    }];
  }

  it("resolves the whole recipe before generation and reuses source evidence for an authored rerun", async () => {
    queueAnswer();
    const creating = await invoke({ action: "create", brief: brief() });
    expect(creating.status).toBe("planning");
    const goal = await settled(creating);
    const analysis = analysisOf(goal);
    expect(analysis).toMatchObject({
      source: { artifactId: sourceId, durationSeconds: 14, fps: 12, hasAudio: true, semanticStatus: "sampled" },
      intent: { structure: "preserve-source", character: "insert", action: { start: 12, end: 14 }, audio: "source", cleanup: "remove", noDialogue: true },
      recipe: { keep: [{ start: 0, end: 12 }], change: [{ start: 12, end: 14 }], generatedSeconds: 2, sourceFrameSeconds: 12 },
    });
    expect(analysis.recipe.cleanupRegions).toHaveLength(1);
    expect(analysis.recipe.assembly).toMatchObject({ fps: 12, totalFrames: 168, changeStartFrame: 144, changeEndFrame: 168 });
    expect(shortGenerationSegments(goal.shortPlan!)).toEqual([{ prompt: "The man bites the gingerbread display itself.", seconds: 2 }]);
    expect(compileShortClipStep(goal.shortPlan!, "@a8").params.options).toMatchObject({ duration: 2 });
    expect(analysis.findings.some(finding => finding.code === "cleanup-review")).toBe(true);
    expect(goal.shortPlan?.rules.video).not.toMatch(/no cuts|continuous take/iu);
    expect(goal.shortPlan?.rules.silence).not.toContain("lips closed");
    expect(stub.submissions).toHaveLength(0);
    expect(stub.plannerRequests).toHaveLength(1);
    const sceneCount = engine.jobs.queue.list({ type: "detect_scenes", limit: 100 }).length;
    const second = await settled(await invoke({ action: "create", brief: authored() }));
    expect(analysisOf(second).source?.evidenceKey).toBe(analysis.source?.evidenceKey);
    expect(analysisOf(second).source?.observations).toEqual(analysis.source?.observations);
    expect(engine.jobs.queue.list({ type: "detect_scenes", limit: 100 })).toHaveLength(sceneCount);
    expect(stub.plannerRequests).toHaveLength(1);
    expect(stub.submissions).toHaveLength(0);
    await invoke({ action: "status", goal_id: second.goalId });
    expect(stub.plannerRequests).toHaveLength(1);
  });

  it("preflights retained-frame timing against the supported H3 range before submission", async () => {
    const goal = await settled(await invoke({ action: "create", brief: authored().replace("Remove all OSG", "Keep source graphics") }));
    const analysis = analysisOf(goal);
    const input = { brief: analysis.brief, totalSeconds: 14, notebookId, preferences: analysis.preferences, source: analysis.source };
    const tiny = await buildRemixAnalysis(engine, { ...input, intent: { ...analysis.intent, action: { start: 13.5, end: 14 } } });
    expect(tiny.recipe.generatedSeconds).toBe(0.92);
    expect(tiny.recipe.assembly).toMatchObject({ changeStartFrame: 162, changeEndFrame: 168 });
    const tooShort = await buildRemixAnalysis(engine, { ...input, intent: { ...analysis.intent, action: { start: 13.999, end: 14 } } });
    expect(tooShort.findings.some(finding => finding.code === "action-frames" && finding.severity === "error")).toBe(true);
    const tooLong = await buildRemixAnalysis(engine, { ...input, totalSeconds: 30, intent: { ...analysis.intent, action: { start: 12, end: 30 } } });
    expect(tooLong.findings.some(finding => finding.code === "action-duration" && finding.severity === "error")).toBe(true);
    expect(stub.submissions).toHaveLength(0);
  });

  it("keeps manual reruns as candidates until adoption and finishes the selected action window after reload", async () => {
    const sourceTag = address(sourceId);
    const identityTag = address(identityId);
    const prompts = authored().replace("Remove all OSG", "Keep source graphics")
      .replace("Insert the man beside the display", `Insert the man from ${identityTag} beside the display in ${sourceTag}`)
      .replace("The empty display montage runs twelve seconds", `The empty display montage from ${sourceTag} runs twelve seconds`);
    let goal = await settled(await invoke({ action: "create", brief: prompts }));
    const beforeMove = engine.notebooks.read(notebookId);
    if (!beforeMove.ok) throw new Error(beforeMove.error.message);
    const sourceCell = beforeMove.value.cells.find(cell => cell.outputArtifactId === sourceId)!;
    const identityCell = beforeMove.value.cells.find(cell => cell.outputArtifactId === identityId)!;
    const moved = await engine.notebooks.write({ ...beforeMove.value, cells: beforeMove.value.cells.map(cell => cell.id === sourceCell.id ? { ...cell, slot: identityCell.slot }
      : cell.id === identityCell.id ? { ...cell, slot: sourceCell.slot } : cell) });
    if (!moved.ok) throw new Error(moved.error.message);
    for (let stage = 0; stage < 3; stage++) {
      goal = await invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision });
      await waitForChainRun(engine, goal.chainId!, testBudget(60_000));
      goal = await invoke({ action: "status", goal_id: goal.goalId });
      expect(goal.status, goal.error ?? "").toBe("review");
    }
    const firstClip = goal.stages.videos!.outputs[0]!.artifactId;
    const video = stub.submissions.filter(submission => submission.path.includes("reference-to-video"));
    expect(video).toHaveLength(1);
    expect(video[0]!.body.duration).toBe(2);
    expect(video[0]!.body.prompt).toContain("starting at local time 0");
    expect(video[0]!.body.prompt).not.toMatch(/@[a-z]{1,2}[1-8]\b/u);
    expect(String(stub.submissions[0]!.body.prompt)).toContain("man from reference image 1");
    expect(stub.submissions.every(submission => !/@[a-z]{1,2}[1-8]\b/u.test(String(submission.body.prompt)))).toBe(true);
    const manualPrompt = "The man bites the gingerbread display, then shows the bite. Keep the entire action within two seconds.";
    const manualId = await manualRerun(goal, manualPrompt);
    goal = await invoke({ action: "status", goal_id: goal.goalId });
    expect(goal.finish?.sourceArtifactId).toBe(firstClip);
    expect(goal.generationHistory).toHaveLength(4);
    const manual = goal.generationHistory!.find(entry => entry.artifactId === manualId)!;
    expect(manual).toMatchObject({ prompt: manualPrompt, status: "completed", originGoalId: goal.goalId, revision: goal.stages.videos!.revision, actualModel: "fal:minimax/h3-max/reference-to-video" });
    expect(manual.lineage?.references.length).toBeGreaterThan(0);
    expect(goal.stages.videos!.outputs[0]!.versions).toHaveLength(2);
    expect((await call({ action: "select", goal_id: goal.goalId, stage: "videos", index: 0, artifact_id: manualId })).isError).toBe(true);
    expect((await call({ action: "adopt", goal_id: goal.goalId, revision: goal.revision, stage: "videos", index: 0, artifact_id: manualId, media_hash: "stale", confirmed: true })).isError).toBe(true);
    goal = await invoke({ action: "adopt", goal_id: goal.goalId, revision: goal.revision, stage: "videos", index: 0, artifact_id: manualId, media_hash: manual.mediaHash, confirmed: true });
    expect(goal.finish?.sourceArtifactId).toBe(manualId);
    await client.close();
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    goal = await invoke({ action: "status", goal_id: goal.goalId });
    expect(goal.stages.videos!.outputs[0]!.artifactId).toBe(manualId);
    expect(goal.generationHistory!.find(entry => entry.artifactId === manualId)?.prompt).toBe(manualPrompt);
    const clip = await cleanupSource(engine, manualId);
    expect(clip.durationSeconds).toBe(14);
    const unreviewed = await call({ action: "finish", goal_id: goal.goalId });
    expect(unreviewed.isError).toBe(true);
    expect(JSON.stringify(unreviewed.content)).toContain("Review the retained action window");
    const review = { action: "review_action", goal_id: goal.goalId, revision: goal.revision, artifact_id: clip.artifactId, media_hash: clip.mediaHash, confirmed: true };
    expect((await call({ ...review, start_seconds: 13 })).isError).toBe(true);
    expect((await call({ ...review, start_seconds: 12, media_hash: "old" })).isError).toBe(true);
    goal = await invoke({ ...review, start_seconds: 12 });
    expect(goal.actionWindow).toMatchObject({ startFrame: 144, endFrame: 168, mediaHash: clip.mediaHash });
    await pauseBookQueueForTests(bookId);
    const finishing = await invoke({ action: "finish", goal_id: goal.goalId });
    expect(finishing.finish?.status).toBe("running");
    expect((await invoke({ action: "finish", goal_id: goal.goalId })).finish?.jobId).toBe(finishing.finish?.jobId);
    const cancelled = await invoke({ action: "cancel", goal_id: goal.goalId });
    expect(cancelled.finish?.status).toBe("cancelled");
    expect(cancelled.finalArtifactId).toBeNull();
    await resumeBookQueueForTests(bookId);
    goal = await invoke({ action: "finish", goal_id: goal.goalId });
    await expect.poll(async () => {
      goal = await invoke({ action: "status", goal_id: goal.goalId });
      return `${goal.finish?.status}:${goal.finish?.error ?? ""}`;
    }, { timeout: testBudget(120_000) }).toBe("completed:");
    const assembled = await cleanupSource(engine, goal.finish!.assembledArtifactId!);
    expect(await probeVideo(assembled.path)).toMatchObject({ fps: 12, videoDuration: 14, hasAudio: false, width: 180, height: 320 });
    const final = await cleanupSource(engine, goal.finalArtifactId!);
    expect(await probeVideo(final.path)).toMatchObject({ videoDuration: 14, hasAudio: true });
    expect(stub.submissions).toHaveLength(4);
    expect(goal.finish?.sourceArtifactId).toBe(clip.artifactId);
    expect((await invoke({ ...review, revision: goal.revision, start_seconds: 12 })).finalArtifactId).toBe(goal.finalArtifactId);
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(60_000) });
    expect(engine.jobs.queue.list({ type: "transcribe_video_audio", limit: 100 }).filter(job =>
      [goal.finalArtifactId, goal.finish?.assembledArtifactId].includes(String(job.payload.assetId)))).toHaveLength(0);
    const analyzedAt = analysisOf(goal).analyzedAt;
    const sourceEvidence = analysisOf(goal).source;
    const actionWindow = goal.actionWindow;
    const generationRules = goal.shortPlan!.rules;
    const firstFinalId = goal.finalArtifactId;
    await saveWatermarkProfile({ handle: "accepted_finish" }, "tiktok", engine);
    expect(analysisOf(await invoke({ action: "status", goal_id: goal.goalId })).recipe.branding!.profile.handle).toBe("jtbkk");
    goal = await invoke({ action: "refresh_finish", goal_id: goal.goalId, revision: goal.revision });
    expect(analysisOf(goal).recipe.branding!.profile.handle).toBe("accepted_finish");
    expect(goal.finalArtifactId).toBeNull();
    expect(goal.actionWindow).toEqual(actionWindow);
    expect(goal.stages.videos!.outputs[0]).toMatchObject({ artifactId: manualId, stale: null });
    const plan = goal.shortPlan!;
    if (plan.version !== 5 || !plan.analysis) throw new Error("Expected analysis");
    goal = await invoke({ action: "update", goal_id: goal.goalId, revision: goal.revision, plan: { ...plan,
      analysis: { ...plan.analysis, intent: { ...plan.analysis.intent, audio: "mute" }, preferences: { ...plan.analysis.preferences, branding: false } } } });
    expect(goal.shortPlan!.rules).toEqual(generationRules);
    expect(goal.stages.videos!.outputs[0]).toMatchObject({ artifactId: manualId, stale: null });
    await invoke({ action: "finish", goal_id: goal.goalId });
    await expect.poll(async () => {
      goal = await invoke({ action: "status", goal_id: goal.goalId });
      return `${goal.finish?.status}:${goal.finish?.error ?? ""}`;
    }, { timeout: testBudget(60_000) }).toBe("completed:");
    expect(goal.finalArtifactId).not.toBe(firstFinalId);
    expect(goal.finish?.assembledArtifactId).toBe(assembled.artifactId);
    expect((await cleanupSource(engine, goal.finalArtifactId!)).hasAudio).toBe(false);
    const alternate = await engine.artifacts.create("video", "Alternate soundtrack");
    if (!alternate.ok) throw new Error(alternate.error.message);
    const alternateId = alternate.value.artifactId;
    await engine.files.writeFromPath(alternateId, "original.mp4", join(fixtures, "changed.mp4"));
    goal = await invoke({ action: "refresh_finish", goal_id: goal.goalId, revision: goal.revision, audio_artifact_id: alternateId });
    const mutedPlan = goal.shortPlan!;
    if (mutedPlan.version !== 5 || !mutedPlan.analysis) throw new Error("Expected analysis");
    goal = await invoke({ action: "update", goal_id: goal.goalId, revision: goal.revision, plan: { ...mutedPlan,
      analysis: { ...mutedPlan.analysis, intent: { ...mutedPlan.analysis.intent, audio: "source" } } } });
    expect(JSON.stringify((await call({ action: "finish", goal_id: goal.goalId })).content)).toContain("has no audio");
    const oldAudioHash = analysisOf(goal).recipe.soundtrack!.mediaHash;
    await engine.files.writeFromPath(alternateId, "original.mp4", join(fixtures, "source.mp4"));
    goal = await invoke({ action: "refresh_finish", goal_id: goal.goalId, revision: goal.revision, audio_artifact_id: alternateId });
    expect(analysisOf(goal).recipe.soundtrack!.mediaHash).not.toBe(oldAudioHash);
    expect(analysisOf(goal).recipe.soundtrack!.hasAudio).toBe(true);
    expect(analysisOf(goal).source).toEqual(sourceEvidence);
    expect(analysisOf(goal).analyzedAt).toBe(analyzedAt);
    expect(goal.stages.videos!.outputs[0]).toMatchObject({ artifactId: manualId, stale: null });
    expect(goal.actionWindow).toEqual(actionWindow);
    expect(stub.submissions).toHaveLength(4);
  }, testBudget(150_000));

  it("preflights authored prompts and refuses a contradictory paid request", async () => {
    const text = authored().replace("The empty display montage runs twelve seconds.", "One continuous take with no cuts.");
    const goal = await settled(await invoke({ action: "create", brief: text }));
    const analysis = analysisOf(goal);
    expect(analysis.findings.some(finding => finding.code === "conflicting-cuts")).toBe(true);
    const result = await call({ action: "approve", goal_id: goal.goalId, revision: goal.revision });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("continuous take");
    expect(stub.plannerRequests).toHaveLength(0);
    expect(stub.submissions).toHaveLength(0);
  });

  it("reuses reviewed upstream images after an account failure and adopts a cancelled goal's later manual take without reviving it", async () => {
    const create = () => invoke({ action: "create", brief: authored().replace("Remove all OSG", "Keep source graphics") });
    let first = await settled(await create());
    for (let step = 0; step < 2; step++) {
      first = await invoke({ action: "approve", goal_id: first.goalId, revision: first.revision });
      await waitForChainRun(engine, first.chainId!, testBudget(60_000));
      first = await invoke({ action: "status", goal_id: first.goalId });
    }
    stub.rejectNext = { status: 403, message: "Account balance exhausted" };
    first = await invoke({ action: "approve", goal_id: first.goalId, revision: first.revision });
    await waitForChainRun(engine, first.chainId!, testBudget(60_000));
    first = await invoke({ action: "status", goal_id: first.goalId });
    expect(first.status).toBe("failed");
    saveGoal(engine, { ...readGoal(engine, first.goalId), reviewedOutputs: [] });
    const paid = stub.submissions.length;
    let next = await settled(await create());
    expect(analysisOf(next).history.filter(entry => entry.approved)).toHaveLength(2);
    expect(analysisOf(next).history.filter(entry => entry.reusable)).toHaveLength(2);
    expect(analysisOf(next).history.find(entry => entry.stage === "videos")).toMatchObject({ status: "failed", failure: "account", selected: false });
    for (let step = 0; step < 2; step++) next = await invoke({ action: "approve", goal_id: next.goalId, revision: next.revision });
    expect(next.stage).toBe("videos");
    expect(next.stages.replacement!.outputs[0]!.artifactId).toBe(first.stages.replacement!.outputs[0]!.artifactId);
    expect(next.stages.frame!.outputs[0]!.artifactId).toBe(first.stages.frame!.outputs[0]!.artifactId);
    expect(stub.submissions).toHaveLength(paid);
    next = await invoke({ action: "approve", goal_id: next.goalId, revision: next.revision });
    await waitForChainRun(engine, next.chainId!, testBudget(60_000));
    next = await invoke({ action: "status", goal_id: next.goalId });
    const originalClip = next.finish!.sourceArtifactId;
    next = await invoke({ action: "cancel", goal_id: next.goalId });
    expect(next.status).toBe("cancelled");
    const laterId = await manualRerun(next, "A later reviewed take of the same bite, with the complete payoff.", true);
    next = await invoke({ action: "status", goal_id: next.goalId });
    expect(next.status).toBe("cancelled");
    expect(next.finish?.sourceArtifactId).toBe(originalClip);
    const later = next.generationHistory!.find(entry => entry.artifactId === laterId)!;
    expect(later.status).toBe("completed");
    expect((await call({ action: "adopt", goal_id: next.goalId, revision: next.revision, stage: "videos", index: 0, artifact_id: laterId, media_hash: later.mediaHash, confirmed: true })).isError).toBe(true);
    let recovered = await settled(await create());
    for (let step = 0; step < 2; step++) recovered = await invoke({ action: "approve", goal_id: recovered.goalId, revision: recovered.revision });
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const removed = await engine.notebooks.write({ ...notebook.value,
      cells: notebook.value.cells.filter(cell => cell.id !== later.cellId), edges: notebook.value.edges.filter(edge => edge.source !== later.cellId && edge.target !== later.cellId),
      execution: Object.fromEntries(Object.entries(notebook.value.execution ?? {}).filter(([cellId]) => cellId !== later.cellId)) });
    if (!removed.ok) throw new Error(removed.error.message);
    recovered = await invoke({ action: "adopt", goal_id: recovered.goalId, revision: recovered.revision, stage: "videos", index: 0, artifact_id: laterId, media_hash: later.mediaHash, confirmed: true });
    expect(recovered.finish?.sourceArtifactId).toBe(laterId);
    expect(recovered.stages.videos!.outputs[0]!.cellId).not.toBe(later.cellId);
    expect(readGoal(engine, next.goalId).status).toBe("cancelled");
    expect(stub.submissions).toHaveLength(paid + 2);
    const changed = await engine.files.writeFromPath(sourceId, "original.mp4", join(fixtures, "changed.mp4"));
    if (!changed.ok) throw new Error(changed.error.message);
    const stale = await call({ action: "adopt", goal_id: recovered.goalId, revision: recovered.revision, stage: "videos", index: 0, artifact_id: laterId, media_hash: later.mediaHash, confirmed: true });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toMatch(/changed/iu);
    const blockedRerun = await manualRerun(next, "The same reviewed bite after the source changed.");
    const stopped = await invoke({ action: "status", goal_id: next.goalId });
    expect(stopped.status).toBe("cancelled");
    expect(stopped.generationHistory!.find(entry => entry.artifactId === blockedRerun)).toMatchObject({ status: "failed", error: expect.stringMatching(/source changed/iu) });
    expect(stub.submissions).toHaveLength(paid + 2);
    expect(stub.unexpected).toEqual([]);
  }, testBudget(120_000));

  it("refreshes changed source evidence without resubmitting creative work and leaves cancelled goals stopped", async () => {
    const goal = await settled(await invoke({ action: "create", brief: authored() }));
    const originalHash = analysisOf(goal).source?.mediaHash;
    const changed = await engine.files.writeFromPath(sourceId, "original.mp4", join(fixtures, "changed.mp4"));
    expect(changed.ok).toBe(true);
    const refused = await call({ action: "approve", goal_id: goal.goalId, revision: goal.revision });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("source video changed");
    const refreshed = await settled(await invoke({ action: "analyze", goal_id: goal.goalId, revision: goal.revision }));
    expect(analysisOf(refreshed).source?.mediaHash).not.toBe(originalHash);
    expect(analysisOf(refreshed).source?.hasAudio).toBe(false);
    expect(refreshed.shortPlan?.version === 5 && refreshed.shortPlan.remix?.frame.artifactId).not.toBe(goal.shortPlan?.version === 5 && goal.shortPlan.remix?.frame.artifactId);
    expect(analysisOf(refreshed).findings.some(finding => finding.code === "missing-audio")).toBe(true);
    await invoke({ action: "cancel", goal_id: goal.goalId });
    const stopped = await call({ action: "analyze", goal_id: goal.goalId, revision: refreshed.revision });
    expect(stopped.isError).toBe(true);
    expect(readGoal(engine, goal.goalId).status).toBe("cancelled");
    expect(stub.plannerRequests).toHaveLength(0);
    expect(stub.submissions).toHaveLength(0);
  });

  it("saves effective defaults explicitly and keeps an existing plan independent of them", async () => {
    const goal = await settled(await invoke({ action: "create", brief: authored() }));
    const plan = goal.shortPlan;
    if (plan?.version !== 5 || !plan.analysis) throw new Error("Expected analyzed plan");
    const edited = { ...plan, analysis: { ...plan.analysis, intent: { ...plan.analysis.intent, audio: "mute" as const } } };
    const saved = await invoke({ action: "update", goal_id: goal.goalId, revision: goal.revision, plan: edited });
    expect(analysisOf(saved).intent.origins.audio).toBe("edited");
    expect(readRemixPreferences(engine).audio).toBe("source");
    await invoke({ action: "save_defaults", goal_id: goal.goalId, revision: saved.revision });
    expect(readRemixPreferences(engine).audio).toBe("mute");
    expect(analysisOf(await invoke({ action: "status", goal_id: goal.goalId })).intent.audio).toBe("mute");
    const other = createEngineForTest(join(root, "other-book"));
    expect(readRemixPreferences(other).audio).toBe("source");
    await other.close();
  });

  it("analyzes a supplied plan without rewriting its prompts or trusting edited evidence", async () => {
    const original = await settled(await invoke({ action: "create", brief: authored() }));
    const supplied = original.shortPlan!;
    const goal = await settled(await invoke({ action: "create", brief: brief(), plan: supplied }));
    expect(goal.shortPlan?.frame.prompt).toBe(supplied.frame.prompt);
    expect(goal.shortPlan?.segments).toEqual(supplied.segments);
    expect(analysisOf(goal).source?.mediaHash).toBe(analysisOf(original).source?.mediaHash);
    const forged = { ...goal.shortPlan, analysis: { ...analysisOf(goal), recipe: { ...analysisOf(goal).recipe, preparedArtifactId: identityId } } };
    const rejected = await call({ action: "update", goal_id: goal.goalId, revision: goal.revision, plan: forged });
    expect(rejected.isError).toBe(true);
    expect(stub.plannerRequests).toHaveLength(0);
    expect(stub.submissions).toHaveLength(0);
  });

  it("fails unreadable source analysis before any provider request", async () => {
    const removed = await engine.files.delete(sourceId, "original.mp4");
    expect(removed.ok).toBe(true);
    const created = await invoke({ action: "create", brief: authored() });
    await expect.poll(() => readGoal(engine, created.goalId).status, { timeout: testBudget(30_000) }).toBe("failed");
    expect(stub.plannerRequests).toHaveLength(0);
    expect(stub.submissions).toHaveLength(0);
  });

  it("prepares and reuses a bounded reference for long sources and submits that reference", async () => {
    await engine.files.writeFromPath(sourceId, "original.mp4", join(fixtures, "long.mp4"));
    const original = await cleanupSource(engine, sourceId);
    let goal = await settled(await invoke({ action: "create", brief: authored().replace("Remove all OSG", "Keep source graphics") }));
    const preparedId = analysisOf(goal).recipe.referenceArtifactId;
    expect(preparedId).toBeTruthy();
    expect(preparedId).not.toBe(sourceId);
    const prepared = await cleanupSource(engine, preparedId!);
    expect(prepared.durationSeconds).toBeGreaterThan(14.5);
    expect(prepared.durationSeconds).toBeLessThanOrEqual(15);
    expect(prepared.fps).toBe(12);
    expect((await cleanupSource(engine, sourceId)).mediaHash).toBe(original.mediaHash);
    expect(compileShortClipStep(goal.shortPlan!, identityId).params.refs).toMatchObject({ video: [preparedId] });
    const again = await settled(await invoke({ action: "create", brief: authored().replace("Remove all OSG", "Keep source graphics") }));
    expect(analysisOf(again).recipe.referenceArtifactId).toBe(preparedId);
    for (let stage = 0; stage < 3; stage++) {
      goal = await invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision });
      await waitForChainRun(engine, goal.chainId!, testBudget(60_000));
      goal = await invoke({ action: "status", goal_id: goal.goalId });
      expect(goal.status, goal.error ?? "").toBe("review");
    }
    const jobs = engine.jobs.queue.list({ type: "generate_media", limit: 100 });
    const video = jobs.find(job => job.payload.model === "fal:minimax/h3-max/reference-to-video");
    expect(video?.payload.refs).toMatchObject({ video: [preparedId] });
    expect(stub.submissions.at(-1)?.body.reference_video_urls).toHaveLength(1);
    expect((await cleanupSource(engine, sourceId)).mediaHash).toBe(original.mediaHash);
  });

  it("blocks too-short source references without a creative submission", async () => {
    await engine.files.writeFromPath(sourceId, "original.mp4", join(fixtures, "short.mp4"));
    const goal = await settled(await invoke({ action: "create", brief: `Use ${address(sourceId)}. replace: "Insert the man." frame: "The man waits." video: "The man waves."` }));
    expect(analysisOf(goal).findings.some(finding => finding.code === "short-reference")).toBe(true);
    const result = await call({ action: "approve", goal_id: goal.goalId, revision: goal.revision });
    expect(result.isError).toBe(true);
    expect(stub.submissions).toHaveLength(0);
  });

  it("reviews a cleanup once, pins the actual submitted bytes through moves and retry, and reuses it for another goal", async () => {
    queueAnswer();
    let goal = await settled(await invoke({ action: "create", brief: brief() }));
    const original = await cleanupSource(engine, sourceId);
    const refused = await call({ action: "approve", goal_id: goal.goalId, revision: goal.revision });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("Prepare and review");
    const regions = analysisOf(goal).recipe.cleanupRegions;
    expect(regions).toHaveLength(1);
    goal = await settled(await invoke({ action: "prepare", goal_id: goal.goalId, revision: goal.revision,
      preparation: { confirmed: true, method: "fill", regions } }));
    const recipe = analysisOf(goal).recipe;
    const preparedId = recipe.preparedArtifactId!;
    expect(preparedId).not.toBe(sourceId);
    expect(recipe.referenceArtifactId).toBe(preparedId);
    expect(recipe.preparedMediaHash).not.toBe(original.mediaHash);
    expect(goal.preparation?.status).toBe("review");
    expect(goal.preparation?.progress?.completedFrames).toBe(168);
    const preparedFrameId = goal.shortPlan?.version === 5 ? goal.shortPlan.remix?.frame.artifactId : null;
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    expect(notebook.value.cells.find(cell => cell.outputArtifactId === preparedFrameId)?.inputs?.sourceArtifactId).toBe(preparedId);
    expect((await call({ action: "approve", goal_id: goal.goalId, revision: goal.revision })).isError).toBe(true);
    expect((await call({ action: "review_source", goal_id: goal.goalId, revision: goal.revision, artifact_id: preparedId, media_hash: "stale", confirmed: true })).isError).toBe(true);
    goal = await invoke({ action: "review_source", goal_id: goal.goalId, revision: goal.revision, artifact_id: preparedId, media_hash: recipe.preparedMediaHash, confirmed: true });
    expect(goal.preparation?.status).toBe("ready");
    const moved = engine.notebooks.read(notebookId);
    if (!moved.ok) throw new Error(moved.error.message);
    const sourceCell = moved.value.cells.find(cell => cell.outputArtifactId === sourceId)!;
    const identityCell = moved.value.cells.find(cell => cell.outputArtifactId === identityId)!;
    await engine.notebooks.write({ ...moved.value, cells: moved.value.cells.map(cell => cell.id === sourceCell.id ? { ...cell, slot: identityCell.slot }
      : cell.id === identityCell.id ? { ...cell, slot: sourceCell.slot } : cell) });
    for (let stage = 0; stage < 2; stage++) {
      goal = await invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision });
      await waitForChainRun(engine, goal.chainId!, testBudget(60_000));
      goal = await invoke({ action: "status", goal_id: goal.goalId });
      expect(goal.status, goal.error ?? "").toBe("review");
    }
    stub.failNext = true;
    goal = await invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision });
    await waitForChainRun(engine, goal.chainId!, testBudget(60_000));
    goal = await invoke({ action: "status", goal_id: goal.goalId });
    expect(goal.status).toBe("failed");
    goal = await invoke({ action: "retry", goal_id: goal.goalId });
    await waitForChainRun(engine, goal.chainId!, testBudget(60_000));
    goal = await invoke({ action: "status", goal_id: goal.goalId });
    expect(goal.status, goal.error ?? "").toBe("review");
    const bytes = await engine.files.read(preparedId, "original.mp4");
    if (!bytes.ok) throw new Error(bytes.error.message);
    const submissions = stub.submissions.filter(submission => submission.path.includes("reference-to-video"));
    expect(submissions).toHaveLength(2);
    for (const submission of submissions) {
      const url = (submission.body.reference_video_urls as string[])[0]!;
      expect(stub.uploads.get(url)?.equals(bytes.value)).toBe(true);
    }
    expect(stub.submissions.filter(submission => submission.path.includes("/edit"))).toHaveLength(2);
    expect((await cleanupSource(engine, sourceId)).mediaHash).toBe(original.mediaHash);
    const jobs = engine.jobs.queue.list({ type: "generate_media", limit: 100 });
    expect(jobs.filter(job => job.payload.model === "fal:minimax/h3-max/reference-to-video").every(job =>
      JSON.stringify(job.payload.refs).includes(preparedId))).toBe(true);
    let next = await settled(await invoke({ action: "create", brief: authored() }));
    const candidate = analysisOf(next).recipe.cleanupCandidates.find(item => item.artifactId === preparedId)!;
    expect(candidate.reviewed).toBe(true);
    next = await settled(await invoke({ action: "prepare", goal_id: next.goalId, revision: next.revision,
      preparation: { confirmed: true, method: candidate.method, regions: candidate.regions, artifactId: preparedId, mediaHash: candidate.mediaHash } }));
    expect(next.preparation?.status).toBe("ready");
    expect(analysisOf(next).recipe.preparedArtifactId).toBe(preparedId);
    expect(readCleanupRequest(engine, next.preparation!.requestId)).toBeNull();
    expect(analysisOf(next).recipe.preparedFrameArtifactId).toBe(preparedFrameId);
    await invoke({ action: "save_defaults", goal_id: next.goalId, revision: next.revision });
    expect(readRemixPreferences(engine).cleanupMethod).toBe("fill");
    expect(stub.unexpected).toEqual([]);
  }, testBudget(150_000));

  it("invalidates changed masks and source bytes, retains preparation for sound edits, and rejects an invalid adopted copy", async () => {
    queueAnswer();
    let goal = await settled(await invoke({ action: "create", brief: brief() }));
    const regions = analysisOf(goal).recipe.cleanupRegions;
    goal = await settled(await invoke({ action: "prepare", goal_id: goal.goalId, revision: goal.revision, preparation: { confirmed: true, method: "fill", regions } }));
    const first = analysisOf(goal).recipe;
    const plan = goal.shortPlan!;
    if (plan.version !== 5 || !plan.analysis) throw new Error("Expected analysis");
    goal = await invoke({ action: "update", goal_id: goal.goalId, revision: goal.revision, plan: { ...plan,
      analysis: { ...plan.analysis, intent: { ...plan.analysis.intent, audio: "mute" } } } });
    expect(analysisOf(goal).recipe.preparedMediaHash).toBe(first.preparedMediaHash);
    const revised = regions.map(region => ({ ...region, height: region.height + 0.05 }));
    goal = await settled(await invoke({ action: "prepare", goal_id: goal.goalId, revision: goal.revision, preparation: { confirmed: true, method: "fill", regions: revised } }));
    const second = analysisOf(goal).recipe;
    expect(second.preparedArtifactId).not.toBe(first.preparedArtifactId);
    expect(second.preparedFrameArtifactId).not.toBe(first.preparedFrameArtifactId);
    expect((await call({ action: "prepare", goal_id: goal.goalId, revision: goal.revision,
      preparation: { confirmed: true, method: "fill", regions: revised, artifactId: first.preparedArtifactId, mediaHash: first.preparedMediaHash } })).isError).toBe(true);
    const invalid = await engine.artifacts.create("video", "Invalid cleaned copy");
    if (!invalid.ok) throw new Error(invalid.error.message);
    await engine.files.writeFromPath(invalid.value.artifactId, "original.mp4", join(fixtures, "short.mp4"));
    await engine.files.write(invalid.value.artifactId, "video-cleanup.json", JSON.stringify({ sourceArtifactId: sourceId, sourceHash: analysisOf(goal).source!.mediaHash, method: "fill", regions: revised }));
    const invalidCopy = await cleanupCandidate(engine, invalid.value.artifactId, analysisOf(goal).source!.mediaHash);
    expect(invalidCopy).not.toBeNull();
    const adopting = await invoke({ action: "prepare", goal_id: goal.goalId, revision: goal.revision,
      preparation: { confirmed: true, method: "fill", regions: revised, artifactId: invalid.value.artifactId, mediaHash: invalidCopy!.mediaHash } });
    await expect.poll(() => readGoal(engine, adopting.goalId).status, { timeout: testBudget(30_000) }).toBe("failed");
    goal = await invoke({ action: "status", goal_id: goal.goalId });
    expect(goal.error).toContain("does not preserve");
    await engine.files.writeFromPath(sourceId, "original.mp4", join(fixtures, "changed.mp4"));
    const stale = await call({ action: "prepare", goal_id: goal.goalId, revision: goal.revision, preparation: { confirmed: true, method: "fill", regions } });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain("source changed");
    expect(stub.submissions).toHaveLength(0);
  }, testBudget(100_000));

  it("keeps cancellation final and recovers interrupted preparation without a creative submission", async () => {
    queueAnswer();
    let goal = await settled(await invoke({ action: "create", brief: brief() }));
    const regions = analysisOf(goal).recipe.cleanupRegions;
    pauseBookQueueForTests(bookId);
    goal = await invoke({ action: "prepare", goal_id: goal.goalId, revision: goal.revision, preparation: { confirmed: true, method: "fill", regions } });
    const cancelled = await invoke({ action: "cancel", goal_id: goal.goalId });
    expect(cancelled.status).toBe("cancelled");
    resumeBookQueueForTests(bookId);
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(30_000) });
    expect((await invoke({ action: "status", goal_id: goal.goalId })).status).toBe("cancelled");
    expect((await call({ action: "prepare", goal_id: goal.goalId, revision: goal.revision, preparation: { confirmed: true, method: "fill", regions } })).isError).toBe(true);
    goal = await settled(await invoke({ action: "create", brief: authored() }));
    pauseBookQueueForTests(bookId);
    goal = await invoke({ action: "prepare", goal_id: goal.goalId, revision: goal.revision, preparation: { confirmed: true, method: "fill", regions } });
    await engine.jobs.queue.abort(goal.preparation!.jobId!, "Simulated restart interruption");
    goal = await invoke({ action: "status", goal_id: goal.goalId });
    expect(goal.preparation?.status).toBe("failed");
    resumeBookQueueForTests(bookId);
    goal = await settled(await invoke({ action: "retry", goal_id: goal.goalId }));
    expect(goal.preparation?.status).toBe("review");
    expect(stub.submissions).toHaveLength(0);
  }, testBudget(90_000));

  it("adopts an older cleaned derivative without its model and reuses its explicit review", async () => {
    const previous = process.env.VIDEOBOOK_CLEANUP_MODEL_DIR;
    process.env.VIDEOBOOK_CLEANUP_MODEL_DIR = join(root, "missing-models");
    try {
      queueAnswer();
      let goal = await settled(await invoke({ action: "create", brief: brief() }));
      const regions = analysisOf(goal).recipe.cleanupRegions;
      expect(analysisOf(goal).recipe.cleanupModelReady).toBe(false);
      const count = engine.jobs.queue.list({ type: "prepare_goal_source" }).length;
      const missing = await call({ action: "prepare", goal_id: goal.goalId, revision: goal.revision, preparation: { confirmed: true, method: "lama", regions } });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing.content)).toContain("Download the local removal model");
      expect(engine.jobs.queue.list({ type: "prepare_goal_source" })).toHaveLength(count);
      goal = await settled(await invoke({ action: "prepare", goal_id: goal.goalId, revision: goal.revision, preparation: { confirmed: true, method: "fill", regions } }));
      const rendered = analysisOf(goal).recipe;
      const legacy = await engine.artifacts.create("video", "Earlier cleaned source");
      if (!legacy.ok) throw new Error(legacy.error.message);
      const media = await engine.files.read(rendered.preparedArtifactId!, "original.mp4");
      if (!media.ok) throw new Error(media.error.message);
      await engine.files.write(legacy.value.artifactId, "original.mp4", media.value);
      await engine.files.write(legacy.value.artifactId, "video-cleanup.json", JSON.stringify({ sourceArtifactId: sourceId, sourceHash: analysisOf(goal).source!.mediaHash, method: "fill", regions }));
      const request = readCleanupRequest(engine, goal.preparation!.requestId)!;
      const { completedHash: _completed, contentKey: _key, ...old } = request;
      writeRenderSetting(engine, "video-cleanup.request.earlier", { ...old, requestId: "earlier", outputArtifactId: legacy.value.artifactId });
      indexRenderRequest(engine, `video-cleanup.requests.${sourceId}`, "earlier");
      goal = await settled(await invoke({ action: "create", brief: authored() }));
      const candidate = analysisOf(goal).recipe.cleanupCandidates.find(item => item.artifactId === legacy.value.artifactId)!;
      expect(candidate).toMatchObject({ reviewed: false, reusable: false });
      goal = await settled(await invoke({ action: "prepare", goal_id: goal.goalId, revision: goal.revision,
        preparation: { confirmed: true, method: "fill", regions, artifactId: candidate.artifactId, mediaHash: candidate.mediaHash } }));
      expect(goal.preparation?.status).toBe("review");
      expect(readCleanupRequest(engine, goal.preparation!.requestId)).toBeNull();
      goal = await invoke({ action: "review_source", goal_id: goal.goalId, revision: goal.revision, artifact_id: candidate.artifactId, media_hash: candidate.mediaHash, confirmed: true });
      let another = await settled(await invoke({ action: "create", brief: authored() }));
      another = await settled(await invoke({ action: "prepare", goal_id: another.goalId, revision: another.revision, preparation: { confirmed: true, method: "fill", regions } }));
      expect(another.preparation).toMatchObject({ status: "ready", mediaHash: candidate.mediaHash });
      expect(stub.submissions).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.VIDEOBOOK_CLEANUP_MODEL_DIR;
      else process.env.VIDEOBOOK_CLEANUP_MODEL_DIR = previous;
    }
  }, testBudget(90_000));
});
