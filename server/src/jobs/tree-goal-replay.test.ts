import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForChainRun } from "../chain-executor.js";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, FFPROBE, probeVideo } from "../ffmpeg.js";
import { goalAutomationTotals } from "../goal-automation-model.js";
import { readRemixPreferences, writeRemixPreferences } from "../goal-remix-analysis.js";
import { readGoal } from "../goal-store.js";
import { graphicsDocumentFromLayers } from "../graphics/model.js";
import { saveGraphicsTemplate, setWatermarkGraphicsTemplate } from "../graphics/templates.js";
import { installFalDynamicEstimator } from "../media/cost.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { configureProviderPollDriverForTests, resetProviderPollDriverForTests, waitForBookQueuesIdleForTests } from "../queue.js";
import { writeTaggingSettings } from "../tag-settings.js";
import { testBudget } from "../test-budget.js";
import { createTestClient } from "../test-client.js";
import { redirectFalStorage, startShortStub, type ShortStub } from "../test-short-stub.js";
import type { ShortGoalSnapshot } from "../tools/goal.js";
import { cleanupSource } from "../video-cleanup/source.js";
import { saveWatermarkProfile } from "../watermark-config.js";
import { reconcileAwaitingNotebookOutputs, runNotebookCell } from "./run-notebook.js";

const execFileAsync = promisify(execFile);
const replacement = "Insert the man beside the gingerbread display, keeping its decorative figures and printed sign.";
const framePrompt = "The man is poised to bite the display itself. The display is intact.";
const beat = "Preserve the display montage for twelve seconds. The man appears, bites the display itself and leaves a visible bite during the final two seconds.";

async function ffmpeg(args: string[]) {
  return execFileAsync(FFMPEG, ["-v", "error", "-y", ...args], { timeout: testBudget(60_000), maxBuffer: 8 * 1024 * 1024 });
}

async function pixels(path: string, seconds: number, crop: string): Promise<Buffer> {
  return (await execFileAsync(FFMPEG, ["-v", "error", "-ss", String(seconds), "-i", path, "-vf", crop,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", timeout: testBudget(30_000) })).stdout;
}

async function similarity(output: string, original: string, frame: number, crop = "null") {
  const select = `select=eq(n\\,${frame}),${crop},format=gray,setpts=PTS-STARTPTS`;
  const { stdout } = await ffmpeg(["-i", output, "-i", original, "-filter_complex", `[0:v]${select}[out];[1:v]${select}[ref];[out][ref]ssim=stats_file=-`, "-f", "null", "-"]);
  return Number(/All:([\d.]+)/u.exec(stdout)?.[1]);
}

async function audioAmplitudes(path: string, seconds: number) {
  const { stdout } = await execFileAsync(FFMPEG, ["-v", "error", "-ss", String(seconds), "-i", path, "-t", "0.125", "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], { encoding: "buffer", timeout: testBudget(30_000) });
  const samples = Array.from({ length: stdout.length / 4 }, (_, i) => stdout.readFloatLE(i * 4));
  return [330, 880].map(frequency => 2 * Math.hypot(
    samples.reduce((sum, value, i) => sum + value * Math.cos(2 * Math.PI * frequency * i / 48000), 0),
    samples.reduce((sum, value, i) => sum + value * Math.sin(2 * Math.PI * frequency * i / 48000), 0),
  ) / samples.length);
}

describe("offline Tree workflow replay", () => {
  let root: string;
  let engine: Engine;
  let client: Client;
  let stub: ShortStub;
  let bookId: string;
  let notebookId: string;
  let sourceId: string;
  let identityId: string;
  let templateId: string;
  let restoreEndpoints: () => void;
  let restoreFetch: () => void;
  let restoreEstimator: () => void;
  const environment = new Map<string, string | undefined>();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-tree-replay-"));
    const artwork = join(root, "display.png");
    await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="320"><rect x="18" y="26" width="144" height="28" fill="white"/><text x="26" y="46" font-size="16" fill="black">BIG DISPLAY</text><rect x="35" y="170" width="110" height="80" fill="#9c662f"/><text x="48" y="220" font-size="24" fill="white">SHOP</text></svg>')).png().toFile(artwork);
    await ffmpeg(["-f", "lavfi", "-i", "color=blue:size=180x320:rate=12:duration=14", "-i", artwork,
      "-f", "lavfi", "-i", "sine=frequency=330:duration=14:sample_rate=48000", "-filter_complex",
      "[0:v]drawbox=color=green:t=fill:enable='between(t,4,7.999)',drawbox=color=purple:t=fill:enable='gte(t,8)'[base];[base][1:v]overlay[outv]",
      "-map", "[outv]", "-map", "2:a", "-t", "14", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", "-threads", "2", join(root, "source.mp4")]);
    for (const payoff of [false, true]) await ffmpeg(["-f", "lavfi", "-i", "color=yellow:size=180x320:rate=12:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=880:duration=3:sample_rate=48000", "-vf",
      `drawbox=x=30:y=170:w=110:h=80:color=0x9c662f:t=fill,drawbox=x=125:y=110:w=30:h=55:color=black:t=fill${payoff ? ",drawbox=x=110:y=170:w=30:h=20:color=yellow:t=fill:enable='gte(t,2)'" : ""}`,
      "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", "-threads", "2", join(root, payoff ? "payoff.mp4" : "wrong.mp4")]);
    const still = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="320"><rect width="180" height="320" fill="#607844"/><rect x="30" y="170" width="110" height="80" fill="#9c662f"/><circle cx="140" cy="115" r="15" fill="black"/><rect x="130" y="130" width="20" height="60" fill="black"/></svg>')).png().toBuffer();
    const wrong = await readFile(join(root, "wrong.mp4"));
    stub = await startShortStub({ frame: still, clip: wrong, extended: wrong });
    stub.outputUnits = 1;
    for (const [key, value] of [["FAL_API_KEY", "offline-tree"], ["OPENAI_API_KEY", "offline-tree"], ["VIDEOBOOK_HAR_CAPTURE", "off"]]) {
      environment.set(key!, process.env[key!]); process.env[key!] = value;
    }
    restoreEndpoints = configureProviderEndpoints({ falQueueBaseURL: stub.baseURL, openaiBaseURL: stub.baseURL });
    restoreFetch = redirectFalStorage(stub.baseURL);
    restoreEstimator = installFalDynamicEstimator(async () => ({ total_cost: 0.21, currency: "USD" }));
    configureProviderPollDriverForTests({ intervalMs: 100 });
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    writeTaggingSettings(engine, { analysisOnNewAssets: false });
    writeRemixPreferences(engine, { audio: "source", cleanupMethod: "fill", branding: true, autoContinue: true, allowanceUsd: 2, reviewImages: false });
    const notebook = await engine.notebooks.create("Tree replay");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    const source = await engine.artifacts.create("video", "Three-shot display");
    const identity = await engine.artifacts.create("image", "Synthetic identity");
    const stamp = await engine.artifacts.create("image", "Accepted red stamp");
    if (!source.ok || !identity.ok || !stamp.ok) throw new Error("Could not create replay inputs");
    sourceId = source.value.artifactId; identityId = identity.value.artifactId;
    expect((await engine.files.writeFromPath(sourceId, "original.mp4", join(root, "source.mp4"))).ok).toBe(true);
    expect((await engine.files.write(identityId, "original.png", still)).ok).toBe(true);
    expect((await engine.files.write(stamp.value.artifactId, "original.png", await sharp({ create: { width: 32, height: 32, channels: 3, background: "red" } }).png().toBuffer())).ok).toBe(true);
    expect((await engine.metadata.artifacts.write(sourceId, "original", { transcribe: false })).ok).toBe(true);
    expect((await engine.notebooks.write({ ...notebook.value, cells: [
      engine.notebooks.createCell({ type: "video", slot: { row: 0, column: 0 }, outputArtifactId: sourceId }),
      engine.notebooks.createCell({ type: "image", slot: { row: 0, column: 1 }, outputArtifactId: identityId }),
    ] })).ok).toBe(true);
    const template = await saveGraphicsTemplate(engine, { name: "Tree accepted stamp", document: graphicsDocumentFromLayers([
      { kind: "image", artifactId: stamp.value.artifactId, position: { anchor: "center", x: 0.9, y: 0.94, space: "frame" }, size: 0.1, timing: { start: 0, end: 14, fade: 0 } },
    ]) });
    templateId = template.id;
    await setWatermarkGraphicsTemplate(engine, "tiktok", templateId);
    await saveWatermarkProfile({ handle: "tree_reviewed" }, "tiktok", engine);
  });

  afterAll(async () => {
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(60_000) });
    await client.close(); resetProviderPollDriverForTests();
    restoreEndpoints(); restoreFetch(); restoreEstimator();
    await stub.close();
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
  const analysisOf = (goal: ShortGoalSnapshot) => {
    if (goal.shortPlan?.version !== 5 || !goal.shortPlan.analysis) throw new Error("Missing analyzed recipe");
    return goal.shortPlan.analysis;
  };
  async function settled(goal: ShortGoalSnapshot) {
    await expect.poll(() => readGoal(engine, goal.goalId).status, { timeout: testBudget(60_000) }).not.toBe("planning");
    const current = await status(goal.goalId);
    expect(current.status, current.error ?? "").toBe("review");
    return current;
  }
  const auto = (goal: ShortGoalSnapshot) => invoke({ action: "auto_continue", goal_id: goal.goalId, revision: goal.revision, confirmed: true, allowance_usd: 2 });
  async function paused(goalId: string, reason: RegExp) {
    await expect.poll(() => readGoal(engine, goalId).automation, { timeout: testBudget(60_000) }).toMatchObject({ status: "paused", reason: expect.stringMatching(reason) });
    return status(goalId);
  }
  async function semantic(goal: ShortGoalSnapshot, verdict: "pass" | "fail") {
    await expect.poll(() => readGoal(engine, goal.goalId).quality?.["videos:0"]?.status, { timeout: testBudget(40_000) }).toBe("completed");
    stub.plannerAnswers.push({ status: verdict, findings: verdict === "pass" ? [] : [
      { code: "wrong-payoff", severity: "error", text: "The display stays intact at the end.", atSeconds: 2.9, correction: "Keep a visible bite through the end of the selected action." },
    ] });
    await invoke({ action: "check_output", goal_id: goal.goalId, revision: goal.revision, stage: "videos", index: 0, semantic: true });
    await expect.poll(() => readGoal(engine, goal.goalId).quality?.["videos:0"]?.status, { timeout: testBudget(40_000) }).toBe("completed");
    expect(readGoal(engine, goal.goalId).quality?.["videos:0"]?.result?.semantic.status).toBe(verdict);
    return status(goal.goalId);
  }

  it("resolves once, preserves the cleaned montage, adopts the reviewed payoff and reuses its stills on a warm run", async () => {
    const brief = "14 second montage from @a1, with the man from @a2 absent for the first 12 seconds. He appears and bites the gingerbread display in the final two seconds. Remove all OSG and keep source audio. No new dialogue.";
    stub.plannerAnswers.push({ title: "A bite of the display", replacement, frame: framePrompt, beats: [beat],
      understanding: { structure: "preserve-source", character: "insert", action: { start: 12, end: 14 }, actionDescription: "The man bites the gingerbread display itself.", sourceFrameSeconds: 12,
        observations: { summary: "Three shots of a display with a screen headline and physical lettering.", subjects: ["gingerbread display"], actions: [], overlays: [
          { description: "Screen headline", kind: "overlay", x: 0.05, y: 0.05, width: 0.9, height: 0.15, start: 0, end: 14 },
          { description: "Printed SHOP sign", kind: "physical", x: 0.2, y: 0.55, width: 0.6, height: 0.25, start: 0, end: 14 },
        ] }, uncertainties: [] } });
    let goal = await settled(await invoke({ action: "create", brief }));
    const initial = analysisOf(goal);
    expect(initial).toMatchObject({ source: { durationSeconds: 14, fps: 12, hasAudio: true, semanticStatus: "sampled" },
      intent: { structure: "preserve-source", character: "insert", audio: "source", cleanup: "remove", action: { start: 12, end: 14 }, noDialogue: true },
      recipe: { generatedSeconds: 2, sourceFrameSeconds: 12, cleanupFrames: 168, assembly: { totalFrames: 168, changeStartFrame: 144, changeEndFrame: 168 },
        branding: { template: { id: templateId }, profile: { handle: "tree_reviewed" } }, soundtrack: { artifactId: sourceId, hasAudio: true } } });
    expect(initial.source!.cuts.length).toBeGreaterThanOrEqual(2);
    expect(initial.recipe.cleanupRegions).toHaveLength(1);
    expect(initial.recipe.checkTimes.filter(time => time >= 12).length).toBeGreaterThan(2);
    expect(initial.recipe.outputAssertions).toBeDefined();
    expect(goal.estimate?.planning).toBeDefined();
    expect(stub.plannerRequests).toHaveLength(1);
    expect(stub.submissions).toHaveLength(0);
    const scenes = engine.jobs.queue.list({ type: "detect_scenes" }).length;
    await saveGraphicsTemplate(engine, { templateId, name: "Later book edit", document: graphicsDocumentFromLayers([]) });
    await saveWatermarkProfile({ handle: "later_handle" }, "tiktok", engine);
    goal = await settled(await invoke({ action: "prepare", goal_id: goal.goalId, revision: goal.revision,
      preparation: { confirmed: true, method: "fill", regions: initial.recipe.cleanupRegions } }));
    const recipe = analysisOf(goal).recipe;
    const prepared = await cleanupSource(engine, recipe.preparedArtifactId!);
    const original = await cleanupSource(engine, sourceId);
    for (const at of [1, 5, 10]) {
      const cleaned = await pixels(prepared.path, at, "crop=120:8:30:28");
      const old = await pixels(original.path, at, "crop=120:8:30:28");
      expect(old.reduce((sum, v) => sum + v, 0) / old.length).toBeGreaterThan(220);
      expect(cleaned.reduce((sum, v) => sum + v, 0) / cleaned.length).toBeLessThan(100);
      expect(await similarity(prepared.path, original.path, at * 12, "crop=110:80:35:170")).toBeGreaterThan(0.97);
    }
    expect(prepared).toMatchObject({ durationSeconds: 14, fps: 12, hasAudio: true });
    goal = await invoke({ action: "review_source", goal_id: goal.goalId, revision: goal.revision, artifact_id: prepared.artifactId, media_hash: prepared.mediaHash, confirmed: true });
    await auto(goal);
    goal = await paused(goal.goalId, /lower bound/u);
    expect(stub.submissions).toHaveLength(2);
    expect(readGoal(engine, goal.goalId).reviewedOutputs ?? []).toEqual([]);
    expect(goal.quality?.["replacement:0"].result?.technical.status).toBe("pass");
    expect(goal.quality?.["frame:0"].result?.technical.status).toBe("pass");
    expect(goalAutomationTotals(goal.automation!)).toMatchObject({ spent: 0.42, reserved: 0 });
    const images = [goal.stages.replacement!.outputs[0]!.artifactId, goal.stages.frame!.outputs[0]!.artifactId];
    goal = await invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision, stage: "videos" });
    await waitForChainRun(engine, goal.chainId!, testBudget(60_000));
    goal = await status(goal.goalId);
    expect(readGoal(engine, goal.goalId).reviewedOutputs?.map(value => value.artifactId)).toEqual(images);
    const firstTake = goal.stages.videos!.outputs[0]!.artifactId;
    const first = await cleanupSource(engine, firstTake);
    goal = await invoke({ action: "review_action", goal_id: goal.goalId, revision: goal.revision, artifact_id: firstTake, media_hash: first.mediaHash, start_seconds: 1, confirmed: true });
    goal = await semantic(goal, "fail");
    await auto(goal);
    await paused(goal.goalId, /display stays intact/u);
    stub.media.clip = await readFile(join(root, "payoff.mp4"));
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const producerId = goal.stages.videos!.outputs[0]!.producerCellId;
    const producer = { ...notebook.value.cells.find(cell => cell.id === producerId)!, prompt: "The man bites the display and leaves a visible missing corner at the end." };
    const updated = { ...notebook.value, cells: notebook.value.cells.map(cell => cell.id === producerId ? producer : cell) };
    expect((await engine.notebooks.write(updated)).ok).toBe(true);
    const rerun = await runNotebookCell(engine, bookId, notebookId, updated, producer, { confirmPaid: true, runId: uuidv7() });
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(60_000) });
    await reconcileAwaitingNotebookOutputs(engine, bookId);
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(60_000) });
    goal = await status(goal.goalId);
    expect(goal.stages.videos!.outputs[0]!.artifactId).toBe(firstTake);
    const take = goal.generationHistory!.find(entry => entry.artifactId === rerun.outputArtifactId)!;
    expect(take.status).toBe("completed");
    goal = await invoke({ action: "adopt", goal_id: goal.goalId, revision: goal.revision, stage: "videos", index: 0, artifact_id: take.artifactId, media_hash: take.mediaHash, confirmed: true });
    goal = await invoke({ action: "review_action", goal_id: goal.goalId, revision: goal.revision, artifact_id: take.artifactId, media_hash: take.mediaHash, start_seconds: 1, confirmed: true });
    goal = await semantic(goal, "pass");
    await client.close();
    engine = createEngineForTest(join(root, "book")); client = await createTestClient(join(root, "book"));
    goal = await status(goal.goalId);
    expect(goal.actionWindow).toMatchObject({ artifactId: take.artifactId, mediaHash: take.mediaHash, startFrame: 12, endFrame: 36 });
    await auto(goal);
    await expect.poll(() => readGoal(engine, goal.goalId).automation, { timeout: testBudget(120_000) }).toMatchObject({ status: "completed" });
    goal = await status(goal.goalId);
    expect(goal.finish).toMatchObject({ status: "completed", sourceArtifactId: take.artifactId });
    expect(goal.quality?.["finish:0"].result?.technical).toMatchObject({ status: "pass", frameCount: 168 });
    const assembled = await cleanupSource(engine, goal.finish!.assembledArtifactId!);
    const final = await cleanupSource(engine, goal.finalArtifactId!);
    expect(await probeVideo(final.path)).toMatchObject({ videoDuration: 14, hasAudio: true, fps: 12 });
    expect(Number((await execFileAsync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", final.path], { timeout: testBudget(30_000) })).stdout.trim())).toBe(168);
    for (const at of [0, 48, 96, 143]) expect(await similarity(assembled.path, prepared.path, at)).toBeGreaterThan(0.96);
    expect((await pixels(final.path, 12, "crop=2:2:160:90"))[0]).toBeGreaterThan(220);
    const payoff = await pixels(final.path, 13.9, "crop=2:2:118:178");
    expect(payoff[0]).toBeGreaterThan(220); expect(payoff[1]).toBeGreaterThan(220);
    const stamp = await pixels(final.path, 1, "crop=2:2:162:300");
    expect(stamp[0]).toBeGreaterThan(220); expect(stamp[1]).toBeLessThan(30);
    for (const at of [0.5, 12.5, 13.5]) {
      const [source, generated] = await audioAmplitudes(final.path, at);
      expect(source).toBeGreaterThan(0.07); expect(generated).toBeLessThan(0.01);
    }
    expect(analysisOf(goal).recipe.branding?.profile.handle).toBe("tree_reviewed");
    const preparedBytes = await engine.files.read(prepared.artifactId, "original.mp4");
    if (!preparedBytes.ok) throw new Error(preparedBytes.error.message);
    for (const submission of stub.submissions.filter(value => value.path.includes("reference-to-video"))) {
      expect(submission.body.duration).toBe(2);
      expect(stub.uploads.get((submission.body.reference_video_urls as string[])[0]!)?.equals(preparedBytes.value)).toBe(true);
    }
    expect(stub.submissions).toHaveLength(4);
    expect(stub.plannerRequests).toHaveLength(3);
    expect((await cleanupSource(engine, sourceId)).mediaHash).toBe(original.mediaHash);
    const beforeCleanupJobs = engine.jobs.queue.list({ type: "remove_video_graphics" }).length;
    let warm = await settled(await invoke({ action: "create", brief, plan: goal.shortPlan }));
    expect(analysisOf(warm).source?.evidenceKey).toBe(initial.source!.evidenceKey);
    expect(analysisOf(warm).history.length).toBeGreaterThanOrEqual(4);
    const candidate = analysisOf(warm).recipe.cleanupCandidates.find(value => value.artifactId === prepared.artifactId)!;
    expect(candidate.reviewed).toBe(true);
    warm = await settled(await invoke({ action: "prepare", goal_id: warm.goalId, revision: warm.revision,
      preparation: { confirmed: true, method: candidate.method, regions: candidate.regions, artifactId: candidate.artifactId, mediaHash: candidate.mediaHash } }));
    delete process.env.FAL_API_KEY;
    await auto(warm);
    warm = await paused(warm.goalId, /FAL_API_KEY/u);
    expect([warm.stages.replacement!.outputs[0]!.artifactId, warm.stages.frame!.outputs[0]!.artifactId]).toEqual(images);
    expect(warm.automation?.reservations).toEqual([]);
    expect(engine.jobs.queue.list({ type: "remove_video_graphics" })).toHaveLength(beforeCleanupJobs);
    expect(engine.jobs.queue.list({ type: "detect_scenes" })).toHaveLength(scenes);
    expect(stub.submissions).toHaveLength(4); expect(stub.plannerRequests).toHaveLength(3);
    expect(readRemixPreferences(engine)).toMatchObject({ autoContinue: true, reviewImages: false, audio: "source", cleanupMethod: "fill" });
    const other = createEngineForTest(join(root, "other-book"));
    expect(readRemixPreferences(other)).toMatchObject({ autoContinue: false, reviewImages: true, allowanceUsd: null });
    expect(stub.unexpected).toEqual([]);
  }, testBudget(300_000));
});
