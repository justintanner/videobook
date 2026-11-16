import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { createEngineForTest } from "../engine.js";
import { readRemixPreferences } from "../goal-remix-analysis.js";
import { waitForChainRun } from "../chain-executor.js";
import { compileShortClipStep } from "../goal-short-plan.js";
import { cleanupSource } from "../video-cleanup/source.js";
import { readGoal } from "../goal-store.js";
import { installFalDynamicEstimator } from "../media/cost.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { createTestClient } from "../test-client.js";
import { copyVideoFixture } from "../test-media-fixtures.js";
import { redirectFalStorage, startShortStub, type ShortStub } from "../test-short-stub.js";
import { testBudget } from "../test-budget.js";
import { writeTaggingSettings } from "../tag-settings.js";
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
    const cells = [
      engine.notebooks.createCell({ type: "video", label: "Display montage", slot: { row: 0, column: 0 }, outputArtifactId: sourceId }),
      engine.notebooks.createCell({ type: "image", label: "Identity photo", slot: { row: 0, column: 1 }, outputArtifactId: identityId }),
    ];
    const written = await engine.notebooks.write({ ...notebook.value, cells });
    if (!written.ok) throw new Error(written.error.message);
  });

  afterEach(async () => {
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
    let goal = await settled(await invoke({ action: "create", brief: authored() }));
    const preparedId = analysisOf(goal).recipe.referenceArtifactId;
    expect(preparedId).toBeTruthy();
    expect(preparedId).not.toBe(sourceId);
    const prepared = await cleanupSource(engine, preparedId!);
    expect(prepared.durationSeconds).toBeGreaterThan(14.5);
    expect(prepared.durationSeconds).toBeLessThanOrEqual(15);
    expect(prepared.fps).toBe(12);
    expect((await cleanupSource(engine, sourceId)).mediaHash).toBe(original.mediaHash);
    expect(compileShortClipStep(goal.shortPlan!, identityId).params.refs).toMatchObject({ video: [preparedId] });
    const again = await settled(await invoke({ action: "create", brief: authored() }));
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
});
