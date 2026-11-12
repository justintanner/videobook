import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { waitForChainRun } from "../chain-executor.js";
import { createEngineForTest } from "../engine.js";
import { runFfmpeg } from "../ffmpeg.js";
import { saveMainCharacter } from "../goal-short-character.js";
import { createShortGoal } from "../goal-short-runtime.js";
import { readGoal } from "../goal-store.js";
import { installFalDynamicEstimator } from "../media/cost.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { configureProviderPollDriverForTests, resetProviderPollDriverForTests } from "../queue.js";
import { writeTaggingSettings } from "../tag-settings.js";
import { testBudget } from "../test-budget.js";
import { createTestClient } from "../test-client.js";
import { goalTestCharacters } from "../test-goals.js";
import { redirectFalStorage, startShortStub, type ShortStub } from "../test-short-stub.js";
import type { ShortGoalSnapshot } from "../tools/goal.js";

type ResponsesRequest = { input: Array<{ content: Array<{ type: string; text?: string; image_url?: string }> }> };

const ONE_BEAT = 'he waits, frame: "A bus stop at dusk." beat 1: "He waits under the shelter."';
const SEVEN = [
  { severity: "note", text: "Slight waxiness on the left cheek." },
  { severity: "warn", text: "Six fingers on the right hand." },
  { severity: "note", text: "The bus sign is soft." },
  { severity: "warn", text: "Shirt is blue, the reference shirt is green." },
  { severity: "note", text: "Rain streaks repeat." },
  { severity: "note", text: "Puddle reflection is warped." },
  { severity: "warn", text: "Lips part as if he speaks, which reads as dialogue in the clip and looks wrong for a silent character today." },
];

async function twoColorClip(path: string, first: string, firstSeconds: number, second: string, secondSeconds: number) {
  const total = firstSeconds + secondSeconds;
  await runFfmpeg([
    "-y", "-f", "lavfi", "-i", `color=c=${first}:s=180x320:r=12:d=${firstSeconds}`, "-f", "lavfi", "-i", `color=c=${second}:s=180x320:r=12:d=${secondSeconds}`,
    "-f", "lavfi", "-i", `sine=frequency=330:duration=${total}`, "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
  ]);
}

describe("check_goal_realism", () => {
  let stub: ShortStub;
  let fixtures: string;
  let root: string;
  let engine: Engine;
  let client: Client;
  let bookId: string;
  let notebookId: string;
  let restoreFetch: () => void;
  let restoreEndpoints: () => void;
  let restoreEstimator: () => void;
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-goal-realism-fixtures-"));
    await twoColorClip(join(fixtures, "clip.mp4"), "green", 5, "green", 0.5);
    await twoColorClip(join(fixtures, "extended.mp4"), "green", 5, "blue", 2);
    stub = await startShortStub({
      frame: await sharp({ create: { width: 180, height: 320, channels: 3, background: "#5b7a4c" } }).png().toBuffer(),
      clip: await readFile(join(fixtures, "clip.mp4")),
      extended: await readFile(join(fixtures, "extended.mp4")),
    });
  });

  afterAll(async () => {
    await stub.close();
    await rm(fixtures, { recursive: true, force: true });
  });

  beforeEach(async () => {
    stub.reset();
    for (const [key, value] of [["FAL_API_KEY", "local-fal-key"], ["OPENAI_API_KEY", "offline-openai-key"], ["VIDEOBOOK_HAR_CAPTURE", "off"]] as const) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    restoreFetch = redirectFalStorage(stub.baseURL);
    restoreEndpoints = configureProviderEndpoints({ falQueueBaseURL: stub.baseURL, openaiBaseURL: stub.baseURL });
    restoreEstimator = installFalDynamicEstimator(async () => ({ total_cost: 0.21, currency: "USD" }));
    configureProviderPollDriverForTests({ intervalMs: 50 });
    root = await mkdtemp(join(tmpdir(), "videobook-goal-realism-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    writeTaggingSettings(engine, { analysisOnNewAssets: false });
    const notebook = await engine.notebooks.create("Shorts");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    const imageIds = await goalTestCharacters(engine, notebookId);
    saveMainCharacter(engine, { referenceArtifactIds: [imageIds[0]!] });
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
  const status = (goalId: string) => invoke({ action: "status", goal_id: goalId });
  async function approved(goal: ShortGoalSnapshot): Promise<ShortGoalSnapshot> {
    const started = await invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision });
    await waitForChainRun(engine, started.chainId!, testBudget(90_000));
    return status(goal.goalId);
  }
  async function short(brief: string): Promise<ShortGoalSnapshot> {
    return status((await createShortGoal(engine, bookId, notebookId, { brief, requestId: uuidv7() })).goalId);
  }
  async function checked(goalId: string, artifactId: string) {
    await expect.poll(() => readGoal(engine, goalId).realism?.[artifactId]?.status, { timeout: testBudget(30_000) }).not.toBe("running");
    return readGoal(engine, goalId).realism?.[artifactId];
  }
  const images = (request: unknown) => (request as ResponsesRequest).input.flatMap(message => message.content.filter(part => part.type === "input_image").map(part => part.image_url!));
  async function meanColor(dataUrl: string) {
    const stats = await sharp(Buffer.from(dataUrl.split(",")[1]!, "base64")).stats();
    return stats.channels.slice(0, 3).map(channel => Math.round(channel.mean));
  }

  it("checks the frame against the character reference and keeps five findings, warnings first", async () => {
    const frame = await approved(await short(ONE_BEAT));
    const output = frame.stages.frame!.outputs[0]!;
    stub.plannerAnswers = [{ findings: SEVEN }];
    const queued = await invoke({ action: "check", goal_id: frame.goalId, stage: "frame", index: 0 });
    expect(queued.stages.frame!.outputs[0]!.realism).toMatchObject({ status: "running", findings: [] });
    const result = await checked(frame.goalId, output.artifactId);
    expect(stub.plannerRequests).toHaveLength(1);
    expect(images(stub.plannerRequests[0])).toHaveLength(2);
    expect(result).toMatchObject({ status: "completed", error: null, checkedAt: expect.any(String) });
    expect(result!.findings.map(finding => finding.severity)).toEqual(["warn", "warn", "warn", "note", "note"]);
    expect(result!.findings[0]!.text).toBe("Six fingers on the right hand.");
    expect(result!.findings[2]!.text.split(/\s+/u).length).toBeLessThanOrEqual(20);
    const snapshot = await status(frame.goalId);
    expect(snapshot.stages.frame!.outputs[0]!.realism).toMatchObject({ status: "completed", findings: result!.findings });
    expect(JSON.stringify(readGoal(engine, frame.goalId).realism)).not.toContain("objectHash");
  });

  it("checks a continuation from four frames of its new footage only and adds nothing to the book", async () => {
    let goal = await approved(await approved(await short(ONE_BEAT)));
    const plan = goal.shortPlan!;
    goal = await invoke({ action: "update", goal_id: goal.goalId, revision: goal.revision, plan: { ...plan, segments: [...plan.segments, { prompt: "He steps out into the rain.", seconds: 2 }] } });
    goal = await approved(goal);
    const clip = goal.stages.videos!.outputs.find(output => output.index === 1)!;
    const document = engine.notebooks.read(notebookId);
    if (!document.ok) throw new Error(document.error.message);
    const cells = JSON.stringify(document.value.cells);
    const artifacts = engine.artifacts.list().map(artifact => artifact.artifactId).sort();
    stub.plannerAnswers = [{ findings: [] }];
    await invoke({ action: "check", goal_id: goal.goalId, stage: "videos", index: 1 });
    expect(await checked(goal.goalId, clip.artifactId)).toMatchObject({ status: "completed", findings: [], error: null });
    const sent = images(stub.plannerRequests.at(-1));
    expect(sent).toHaveLength(5);
    for (const frame of sent.slice(1)) {
      const [red, green, blue] = await meanColor(frame);
      expect(blue, `frame ${red},${green},${blue}`).toBeGreaterThan(150);
      expect(green).toBeLessThan(90);
    }
    const after = engine.notebooks.read(notebookId);
    if (!after.ok) throw new Error(after.error.message);
    expect(JSON.stringify(after.value.cells)).toBe(cells);
    expect(engine.artifacts.list().map(artifact => artifact.artifactId).sort()).toEqual(artifacts);
  }, testBudget(120_000));

  it("stores a failed check when the model answers nothing usable", async () => {
    const frame = await approved(await short(ONE_BEAT));
    const output = frame.stages.frame!.outputs[0]!;
    await invoke({ action: "check", goal_id: frame.goalId, stage: "frame", index: 0 });
    const result = await checked(frame.goalId, output.artifactId);
    expect(result).toMatchObject({ status: "failed", findings: [], error: expect.any(String) });
  });
});
