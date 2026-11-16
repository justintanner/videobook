import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { v7 as uuidv7 } from "uuid";
import type { Client } from "@modelcontextprotocol/client";
import { findPrimaryMediaFile, type Engine } from "videobook-engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEngineForTest } from "../engine.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";
import { buildRemixAnalysis } from "../goal-remix-analysis.js";
import { remixAssemblyReviewKey } from "../goal-remix-model.js";
import { goalQualityAccepted } from "../goal-quality-model.js";
import { makeGoalQualityRequest } from "../goal-quality.js";
import { createShortGoal } from "../goal-short-runtime.js";
import { readGoal, requireGoalShortContent, saveGoal, writeGoalShortContent, type GoalRecord, type GoalStageRun } from "../goal-store.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { installFalDynamicEstimator } from "../media/cost.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { pauseBookQueueForTests, resumeBookQueueForTests, waitForBookQueuesIdleForTests } from "../queue.js";
import { writeTaggingSettings } from "../tag-settings.js";
import { createTestClient } from "../test-client.js";
import { goalTestCharacters } from "../test-goals.js";
import { copyVideoFixture } from "../test-media-fixtures.js";
import { testBudget } from "../test-budget.js";
import type { ShortGoalSnapshot } from "../tools/goal.js";

type Request = { instructions: string; input: { content: { type: string; text?: string; image_url?: string }[] }[] };
const BRIEF = '@a1 14 second montage. He is absent for the first 12 seconds then bites the gingerbread display in the final two seconds. No new dialogue. frame: "The man is ready to bite the display." video: "Keep the display empty until twelve seconds; then he enters and bites the display."';
const PASS = { status: "pass", findings: [] };

describe("goal output checks", () => {
  let fixtures: string;
  let root: string;
  let engine: Engine;
  let client: Client;
  let bookId: string;
  let notebookId: string;
  let identityId: string;
  let restoreEndpoints: () => void;
  let restoreEstimator: () => void;
  let answer: unknown;
  let hold: boolean;
  let pending: ServerResponse | null;
  let requests: Request[];
  const environment = new Map<string, string | undefined>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (!request.url?.endsWith("/responses")) { response.writeHead(404).end(); return; }
      requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Request);
      if (hold) pending = response;
      else respond(response);
    });
  });
  function respond(response: ServerResponse) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "offline-quality-response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(answer) }] }], usage: { input_tokens: 200, output_tokens: 80 } }));
  }

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-quality-fixtures-"));
    await copyVideoFixture({ width: 160, height: 284, durationSec: 14, fps: 30, source: "color", color: "blue", audio: false }, join(fixtures, "source.mp4"));
    await copyVideoFixture({ width: 160, height: 284, durationSec: 14.4, fps: 30, source: "color", color: "blue", audio: false }, join(fixtures, "overrun.mp4"));
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=red:s=160x284:r=30:d=3", "-vf", "drawbox=color=lime:t=fill:enable='between(t,0.5,2.49)'", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(fixtures, "action.mp4")]);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(fixtures, { recursive: true, force: true });
  });
  beforeEach(async () => {
    answer = PASS;
    hold = false;
    pending = null;
    requests = [];
    for (const [key, value] of [["FAL_API_KEY", "offline-fal"], ["OPENAI_API_KEY", "offline-openai"], ["VIDEOBOOK_HAR_CAPTURE", "off"]]) {
      environment.set(key!, process.env[key!]); process.env[key!] = value;
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing provider address");
    restoreEndpoints = configureProviderEndpoints({ openaiBaseURL: `http://127.0.0.1:${address.port}` });
    restoreEstimator = installFalDynamicEstimator(async () => ({ total_cost: 0.21, currency: "USD" }));
    root = await mkdtemp(join(tmpdir(), "videobook-quality-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    writeTaggingSettings(engine, { analysisOnNewAssets: false });
    const notebook = await engine.notebooks.create("Quality");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    [identityId] = await goalTestCharacters(engine, notebookId) as [string, string];
  });
  afterEach(async () => {
    if (pending) respond(pending);
    await resumeBookQueueForTests(bookId);
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(30_000) });
    await client.close();
    restoreEndpoints(); restoreEstimator();
    for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  async function invoke(args: Record<string, unknown>): Promise<ShortGoalSnapshot> {
    const result = await client.callTool({ name: "video_goal", arguments: { book_id: bookId, notebook_id: notebookId, ...args } });
    const text = (result.content as { text: string }[])[0]!.text;
    expect(result.isError, text).toBeFalsy();
    return JSON.parse(text) as ShortGoalSnapshot;
  }
  async function video(name: string) {
    const created = await engine.artifacts.create("video", name);
    if (!created.ok) throw new Error(created.error.message);
    const path = join(fixtures, name);
    const written = await engine.files.writeFromPath(created.value.artifactId, "original.mp4", path);
    if (!written.ok) throw new Error(written.error.message);
    await registerMediaProbe(engine, created.value.artifactId, "original.mp4", await probeVideo(path), { transcribe: false });
    return created.value.artifactId;
  }
  async function hash(artifactId: string): Promise<string> {
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    return findPrimaryMediaFile(manifest.value.files, "video")!.objectHash;
  }
  function stage(artifactId: string): GoalStageRun {
    return { chainId: null, revision: 1, approvedAt: new Date().toISOString(), shotIndexes: [0], previousChainIds: [],
      outputs: [{ index: 0, artifactId, cellId: null, producerCellId: null, address: null }] };
  }
  async function fixture(localized = false): Promise<GoalRecord> {
    const goal = await createShortGoal(engine, bookId, notebookId, { brief: BRIEF, requestId: uuidv7() });
    const content = requireGoalShortContent(engine, goal);
    if (content.plan?.version !== 5 || !content.plan.analysis) throw new Error("Missing analysis");
    const clip = await video(localized ? "action.mp4" : "source.mp4");
    const frame = await engine.artifacts.create("image", "Action setup");
    if (!frame.ok) throw new Error(frame.error.message);
    const copied = await engine.files.copy(identityId, "original.png", frame.value.artifactId, "original.png");
    if (!copied.ok) throw new Error(copied.error.message);
    const source = localized ? await video("source.mp4") : null;
    const analysis = await buildRemixAnalysis(engine, {
      brief: BRIEF, totalSeconds: 14, notebookId,
      preferences: { ...content.plan.analysis.preferences, branding: false, audio: "mute", cleanup: "keep" },
      source: source ? { artifactId: source, mediaHash: await hash(source), durationSeconds: 14, fps: 30, width: 160, height: 284, hasAudio: false,
        cuts: [2, 4, 6, 8, 10, 11], sampleTimes: [1, 3, 5, 7, 9, 11, 13], observations: null, semanticStatus: "sampled", transcript: null, evidenceKey: "offline-source" } : null,
    });
    await writeGoalShortContent(engine, goal, { ...content, plan: { ...content.plan, analysis } });
    return saveGoal(engine, { ...goal, status: "review", stage: "videos", stages: { frame: stage(frame.value.artifactId), videos: stage(clip) },
      finish: { status: "review", sourceArtifactId: clip, finalArtifactId: null, error: null },
      ...(localized ? { actionWindow: { artifactId: clip, mediaHash: await hash(clip), recipeKey: remixAssemblyReviewKey(analysis), startFrame: 15, endFrame: 75, durationSeconds: 3, reviewedAt: new Date().toISOString() } } : {}),
    });
  }
  async function checked(goalId: string, slot: string) {
    await expect.poll(() => readGoal(engine, goalId).quality?.[slot]?.status, { timeout: testBudget(30_000) }).toBe("completed");
    return readGoal(engine, goalId).quality![slot]!;
  }
  async function local(goal: GoalRecord) {
    await invoke({ action: "status", goal_id: goal.goalId });
    await checked(goal.goalId, "frame:0");
    return checked(goal.goalId, "videos:0");
  }
  async function semantic(goal: GoalRecord, stageName = "videos") {
    await invoke({ action: "check_output", goal_id: goal.goalId, revision: requireGoalShortContent(engine, readGoal(engine, goal.goalId)).revision, stage: stageName, index: 0, semantic: true });
    return checked(goal.goalId, `${stageName}:0`);
  }

  it("runs local checks automatically, distinguishes compliance, and caches one paid review across reload", async () => {
    const goal = await fixture();
    expect((await local(goal)).result).toMatchObject({ technical: { status: "pass", frameCount: 420 }, semantic: { status: "not-requested", attempted: false } });
    expect(requests).toHaveLength(0);
    const result = await semantic(goal);
    expect(goalQualityAccepted(result.result, true)).toBe(true);
    expect(result.result?.semantic.sampleTimes).toEqual(expect.arrayContaining([11.9, 12.1, 13, 13.9]));
    expect(requests).toHaveLength(1);
    await client.close();
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    expect((await semantic(goal)).key).toBe(result.key);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.instructions).toContain("Allow natural eating");
    expect(requests[0]!.instructions).toContain("Physical signs/printing are not added overlays");
  });

  it("samples only the reviewed action densely, labels discarded context and retains targeted violations", async () => {
    const goal = await fixture(true);
    const content = requireGoalShortContent(engine, goal);
    const times = content.plan?.version === 5 ? content.plan.analysis!.recipe.checkTimes : [];
    expect(times).toEqual(expect.arrayContaining([11.9, 12.1, 13, 13.9]));
    expect(times.length).toBeLessThanOrEqual(12);
    expect((await local(goal)).result?.technical.status).toBe("pass");
    answer = { status: "fail", findings: [
      { code: "payoff", severity: "error", text: "At 1.5s he holds a cookie instead of biting the display.", atSeconds: 1.5, correction: "Replace only the action take with a direct bite of the display." },
      { code: "overlay", severity: "error", text: "The creator headline remains above the display.", atSeconds: 2, correction: "Remove the headline from the prepared reference and review the action again." },
    ] };
    const check = await semantic(goal);
    expect(goalQualityAccepted(check.result, true)).toBe(false);
    expect(check.result?.semantic.sampleTimes).toHaveLength(9);
    expect(check.result?.semantic.findings).toMatchObject([{ code: "payoff", atSeconds: 1.5 }, { code: "overlay", atSeconds: 2 }]);
    const parts = requests[0]!.input.flatMap(message => message.content);
    const frames = parts.filter(part => part.type === "input_image").slice(1);
    expect(frames).toHaveLength(9);
    for (const image of frames.slice(1, -1)) {
      const stats = await sharp(Buffer.from(image.image_url!.split(",")[1]!, "base64")).stats();
      expect(stats.channels[1]!.mean).toBeGreaterThan(220);
      expect(stats.channels[0]!.mean).toBeLessThan(30);
    }
    expect(parts.filter(part => part.text?.includes("discarded context"))).toHaveLength(2);
  });

  it("fails wrong duration and changed input locally without semantic spending", async () => {
    const goal = await fixture();
    const output = goal.stages.videos!.outputs[0]!.artifactId;
    const written = await engine.files.write(output, "original.mp4", await readFile(join(fixtures, "overrun.mp4")));
    expect(written.ok).toBe(true);
    const localCheck = await local(goal);
    expect(localCheck.result?.technical.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "duration" })]));
    await semantic(goal);
    expect(requests).toHaveLength(0);
    const identity = await engine.files.write(identityId, "original.png", await sharp({ create: { width: 64, height: 64, channels: 3, background: "black" } }).png().toBuffer());
    expect(identity.ok).toBe(true);
    const changed = await local(goal);
    expect(changed.key).not.toBe(localCheck.key);
    expect(changed.result?.technical.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "changed-input" })]));
  });

  it("treats an unusable provider answer as unverified and never automatically resubmits it", async () => {
    const goal = await fixture();
    await local(goal);
    answer = { refusal: "Cannot assess these samples" };
    const check = await semantic(goal);
    expect(check.result?.semantic).toMatchObject({ status: "unverified", attempted: true });
    expect(goalQualityAccepted(check.result, true)).toBe(false);
    await semantic(goal);
    expect(requests).toHaveLength(1);
    const content = requireGoalShortContent(engine, goal);
    if (content.plan?.version !== 5) throw new Error("Missing plan");
    const plan = { ...content.plan, segments: content.plan.segments.map(segment => ({ ...segment, prompt: `${segment.prompt} Show the direct bite clearly.` })) };
    await invoke({ action: "update", goal_id: goal.goalId, revision: content.revision, plan });
    await checked(goal.goalId, "videos:0");
    answer = PASS;
    const updated = await semantic(goal);
    expect(updated.key).not.toBe(check.key);
    expect(requests).toHaveLength(2);
  });

  it.each(["fail", "unverified"])("keeps an explicit %s verdict blocking even with an empty findings list", async status => {
    const goal = await fixture();
    await local(goal);
    answer = { status, findings: [] };
    const check = await semantic(goal);
    expect(check.result?.semantic.status).toBe(status);
    expect(goalQualityAccepted(check.result, false)).toBe(false);
    expect(goalQualityAccepted(check.result, true)).toBe(false);
  });

  it("keeps missing credentials unverified and permits the first paid check after credentials are restored", async () => {
    const goal = await fixture();
    await local(goal);
    delete process.env.OPENAI_API_KEY;
    expect((await semantic(goal)).result?.semantic).toMatchObject({ status: "unverified", attempted: false });
    expect(requests).toHaveLength(0);
    process.env.OPENAI_API_KEY = "offline-restored";
    expect((await semantic(goal)).result?.semantic).toMatchObject({ status: "pass", attempted: true });
    expect(requests).toHaveLength(1);
  });

  it.each(["cancel", "change"])("does not attach a stale semantic completion after %s", async action => {
    const goal = await fixture();
    await local(goal);
    hold = true;
    const revision = requireGoalShortContent(engine, goal).revision;
    await invoke({ action: "check_output", goal_id: goal.goalId, revision, stage: "videos", index: 0, semantic: true });
    await expect.poll(() => pending, { timeout: testBudget(30_000) }).not.toBeNull();
    const oldKey = readGoal(engine, goal.goalId).quality!["videos:0"]!.key;
    if (action === "cancel") await invoke({ action: "cancel", goal_id: goal.goalId });
    else {
      const written = await engine.files.write(goal.stages.videos!.outputs[0]!.artifactId, "original.mp4", await readFile(join(fixtures, "overrun.mp4")));
      expect(written.ok).toBe(true);
    }
    respond(pending!); pending = null;
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(30_000) });
    const latest = await invoke({ action: "status", goal_id: goal.goalId });
    expect(latest.quality?.["videos:0"]?.result?.semantic.status).not.toBe("pass");
    if (action === "cancel") expect(latest.status).toBe("cancelled");
    else expect(latest.quality?.["videos:0"]?.key).not.toBe(oldKey);
    expect(requests).toHaveLength(1);
  });

  it("rejects a stale action review and retries an interrupted local check without a provider call", async () => {
    const goal = await fixture(true);
    saveGoal(engine, { ...goal, actionWindow: { ...goal.actionWindow!, recipeKey: "old-assembly" } });
    expect((await local(goal)).result?.technical.status).toBe("unverified");
    await pauseBookQueueForTests(bookId);
    const current = readGoal(engine, goal.goalId);
    saveGoal(engine, { ...current, actionWindow: goal.actionWindow, quality: {} });
    const queued = await invoke({ action: "status", goal_id: goal.goalId });
    const check = queued.quality!["videos:0"]!;
    expect(check.status).toBe("running");
    await engine.jobs.queue.abort(check.jobId!, "offline interruption");
    expect((await invoke({ action: "status", goal_id: goal.goalId })).quality!["videos:0"]!.status).toBe("failed");
    await resumeBookQueueForTests(bookId);
    await invoke({ action: "check_output", goal_id: goal.goalId, revision: queued.revision, stage: "videos", index: 0 });
    expect((await checked(goal.goalId, "videos:0")).result?.technical.status).toBe("pass");
    expect(requests).toHaveLength(0);
    expect((await makeGoalQualityRequest(engine, readGoal(engine, goal.goalId), "videos", 0, false)).reviewedWindow).toBe(true);
  });
});
