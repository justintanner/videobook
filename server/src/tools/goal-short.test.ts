import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine, NotebookCell } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { getChainRun, waitForChainRun } from "../chain-executor.js";
import { createEngineForTest } from "../engine.js";
import { buildLegacyGoalShortPlan, formatShortSeconds } from "../goal-short-plan.js";
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
import { redirectFalStorage, SHORT_STUB_REFUSAL as REFUSAL, startShortStub, type ShortStub } from "../test-short-stub.js";
import { writeTaggingSettings } from "../tag-settings.js";
import type { ShortGoalSnapshot } from "./goal.js";

const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(" ");
const AUTHORED = 'he waits for a bus in the rain, frame: "He stands under a bus shelter at dusk." beat 1: "He checks the road for the bus."';
const NO_FAL_KEY = "Set FAL_API_KEY in Settings before generating this stage";
const NO_OPENAI_KEY = "Set OPENAI_API_KEY in Settings to revise with feedback, or edit the prompt and regenerate.";
const PHONE_SENTENCE = /[^.\n]*\bphones?\b[^.\n]*/giu;

type RewriteRequest = { instructions: string; input: Array<{ role: string; content: string }> };

describe("video_goal shorts", () => {
  let stub: ShortStub;
  let fixtures: string;
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

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-goal-short-fixtures-"));
    await copyVideoFixture({ width: 360, height: 640, durationSec: 3, fps: 12, source: "color", color: "green", audio: { frequency: 330 } }, join(fixtures, "clip.mp4"));
    const clip = await readFile(join(fixtures, "clip.mp4"));
    stub = await startShortStub({ frame: await sharp({ create: { width: 360, height: 640, channels: 3, background: "#5b7a4c" } }).png().toBuffer(), clip, extended: clip });
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
    root = await mkdtemp(join(tmpdir(), "videobook-goal-short-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    writeTaggingSettings(engine, { analysisOnNewAssets: false });
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

  async function short(brief = AUTHORED): Promise<ShortGoalSnapshot> {
    return status((await invoke({ action: "create", brief, request_id: uuidv7() })).goalId);
  }

  function sourceImagesOf(goal: ShortGoalSnapshot) {
    const plan = goal.shortPlan;
    if (!plan || plan.version !== 5) throw new Error("expected a version 5 plan");
    return plan.sourceImages;
  }

  function storyboardOf(goal: ShortGoalSnapshot) {
    const plan = goal.shortPlan;
    if (!plan || plan.version !== 5 || !plan.storyboard) throw new Error("expected a version 5 plan with a storyboard");
    return plan.storyboard;
  }

  function storyboardNote(mention: string, frames: readonly { address: string; atSeconds: number }[]) {
    const listed = frames.map((frame) => `${frame.address} at ${formatShortSeconds(frame.atSeconds)} s`);
    const list = listed.length > 1 ? `${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}` : listed.join("");
    return `${mention} is a video, so the short follows its storyboard of ${frames.length} frames: ${list}. Their on-screen graphics are removed before the frame is made.`;
  }

  function stepPrompt(chainId: string | null, stepId: string): string {
    const step = getChainRun(engine, chainId ?? "")?.steps.find((item) => item.id === stepId);
    const prompt = (step?.params as { prompt?: string } | undefined)?.prompt;
    return typeof prompt === "string" ? prompt : "";
  }

  async function imageReference(index: number) {
    const manifest = await engine.files.manifest(imageIds[index]!);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const cell = notebook.value.cells.find((candidate) => candidate.outputArtifactId === imageIds[index]);
    if (!cell) throw new Error("missing image cell");
    return {
      kind: "image" as const, artifactId: imageIds[index]!, cellId: cell.id, address: notebookGridTag(cell.slot),
      label: cell.label ?? "", objectHash: manifest.value.files[0]!.objectHash,
    };
  }

  async function settled(goal: ShortGoalSnapshot): Promise<ShortGoalSnapshot> {
    await waitForChainRun(engine, goal.chainId!, testBudget(90_000));
    return status(goal.goalId);
  }

  async function approved(goal: ShortGoalSnapshot): Promise<ShortGoalSnapshot> {
    return settled(await invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision }));
  }

  function mediaJobs(model: string) {
    return engine.jobs.queue.list({ type: "generate_media", limit: 100 }).filter((job) => job.payload.model === model);
  }

  it("creates a short from the brief, in review when authored and through the planner otherwise", async () => {
    const goal = await short();
    expect(goal).toMatchObject({ planVersion: 5, status: "review", stage: "frame", legacy: false });
    expect(goal).not.toHaveProperty("plan");
    expect(goal.shortPlan).toMatchObject({
      version: 5, aspectRatio: "9:16", sourceImages: [],
      frame: { prompt: "He stands under a bus shelter at dusk.", model: "fal:openai/gpt-image-2.6/sunburst/edit" },
      segments: [{ prompt: "He checks the road for the bus.", seconds: 12 }],
    });
    expect(goal.shortPlan).not.toHaveProperty("character");
    expect(JSON.stringify(goal)).not.toMatch(/Main character|a man in a green shirt/u);
    expect(stub.plannerRequests).toEqual([]);
    stub.plannerAnswers = [{ title: "Bus in the rain", frame: "He stands at a rainy bus stop at dusk.", beats: ["He checks the road, then steps back from a splash."] }];
    const planning = await createShortGoal(engine, bookId, notebookId, { brief: "he waits for a bus in the rain", requestId: uuidv7() });
    expect(planning).toMatchObject({ planVersion: 5, status: "planning", planningJobId: expect.any(Number) });
    await expect.poll(() => readGoal(engine, planning.goalId).status, { timeout: testBudget(30_000) }).toBe("review");
    expect(stub.plannerRequests).toHaveLength(1);
    expect(JSON.stringify(stub.plannerRequests)).not.toMatch(/Main character|a man in a green shirt/u);
    expect((await status(planning.goalId)).shortPlan).toMatchObject({ title: "Bus in the rain", segments: [{ seconds: 12 }] });
    const structured = await invoke({ action: "create", brief: "a bus stop short", plan: goal.shortPlan, request_id: "structured-short" });
    expect(structured).toMatchObject({ planVersion: 5, status: "review", shortPlan: { title: goal.shortPlan!.title } });
    expect((await invoke({ action: "create", brief: "a bus stop short", plan: goal.shortPlan, request_id: "structured-short" })).goalId).toBe(structured.goalId);
    stub.plannerAnswers = [{ title: "Bus stop", frame: "He waits at the bus shelter in the rain.", beats: ["He checks the road, then boards the bus."] }];
    const mentioned = await invoke({ action: "create", brief: "@a2 he waits for a bus" });
    expect(mentioned).toMatchObject({ planVersion: 5, status: "planning", legacy: false });
    await expect.poll(() => readGoal(engine, mentioned.goalId).status, { timeout: testBudget(30_000) }).toBe("review");
    const planned = await status(mentioned.goalId);
    expect(sourceImagesOf(planned)).toEqual([expect.objectContaining({ artifactId: imageIds[1], slot: "@image1" })]);
    expect(planned.shortPlan).not.toHaveProperty("character");
    expect(JSON.stringify(stub.plannerRequests)).not.toMatch(/Main character|a man in a green shirt/u);
    expect(JSON.stringify(planned)).not.toMatch(/nano-banana|seedance|kie:/iu);
  });

  it("rejects the character action and starts no character sheet", async () => {
    const message = await refusal({ action: "character", name: "Main character", description: "a man in a green shirt", reference_ids: ["@a1"], generate: true });
    expect(message).toMatch(/Invalid option: expected one of/u);
    expect(message).not.toContain("character");
    expect(chainRuns()).toBe(0);
    expect(stub.submissions).toEqual([]);
  });

  async function writeNotebook(cells: NotebookCell[]): Promise<void> {
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const written = await engine.notebooks.write({ ...notebook.value, cells });
    if (!written.ok) throw new Error(written.error.message);
  }

  async function pinStairsVideo(): Promise<string> {
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const video = await engine.artifacts.create("video", "Stairs");
    if (!video.ok) throw new Error(video.error.message);
    const file = await engine.files.writeFromPath(video.value.artifactId, "original.mp4", join(fixtures, "clip.mp4"));
    if (!file.ok) throw new Error(file.error.message);
    const videoCell = engine.notebooks.createCell({ type: "video", label: "Stairs", slot: { row: 0, column: 0 }, outputArtifactId: video.value.artifactId });
    await writeNotebook([
      ...notebook.value.cells.map((cell) => cell.outputArtifactId === imageIds[0] ? { ...cell, slot: { row: 1, column: 0 } } : cell),
      videoCell,
    ]);
    return video.value.artifactId;
  }

  async function addArtifactCell(kind: "image" | "video" | "audio", slot: { row: number; column: number }, file?: { name: string; bytes: Buffer }): Promise<string> {
    const created = await engine.artifacts.create(kind, `${kind} ${notebookGridTag(slot)}`);
    if (!created.ok) throw new Error(created.error.message);
    if (file) {
      const written = await engine.files.write(created.value.artifactId, file.name, file.bytes);
      if (!written.ok) throw new Error(written.error.message);
    }
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const cell = engine.notebooks.createCell({ type: kind, label: created.value.label ?? kind, slot, outputArtifactId: created.value.artifactId });
    await writeNotebook([...notebook.value.cells, cell]);
    return created.value.artifactId;
  }

  it("takes the storyboard from a mentioned video at its time and reuses those frame cells", async () => {
    const videoId = await pinStairsVideo();
    const goal = await short(`12 seconds, use @a1 at 1s and @a2, ${AUTHORED}`);
    expect(goal).toMatchObject({ stage: "storyboards", status: "review" });
    expect(sourceImagesOf(goal).map((reference) => reference.artifactId)).toEqual([imageIds[1]]);
    const storyboard = storyboardOf(goal);
    expect(storyboard.video).toMatchObject({ artifactId: videoId, label: "Stairs" });
    expect(storyboard.frames.map((frame) => frame.index)).toEqual([0, 1]);
    expect(storyboard.frames[0]!.atSeconds).toBeCloseTo(1.5, 1);
    expect(storyboard.frames[1]!.atSeconds).toBeCloseTo(2.5, 1);
    expect(goal.notes).toEqual([storyboardNote("@a1", storyboard.frames)]);
    const placed = engine.notebooks.read(notebookId);
    if (!placed.ok) throw new Error(placed.error.message);
    const videoCell = placed.value.cells.find((cell) => cell.outputArtifactId === videoId);
    if (!videoCell) throw new Error("missing stairs video");
    const videoAddress = notebookGridTag(videoCell.slot);
    const again = await short(`12 seconds, use ${videoAddress} at 1s, ${AUTHORED}`);
    expect(sourceImagesOf(again)).toEqual([]);
    expect(storyboardOf(again).frames.map((frame) => frame.artifactId)).toEqual(storyboard.frames.map((frame) => frame.artifactId));
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    expect(notebook.value.cells.filter((cell) => cell.inputs?.mediaRole === "extract-frame-output")).toHaveLength(2);
    expect(again.notes).toEqual([storyboardNote(videoAddress, storyboardOf(again).frames)]);
  });

  it("makes a goal from a video mention and an image mention, including the operator's brief", async () => {
    const videoId = await pinStairsVideo();
    stub.plannerAnswers = [{ title: "Slippery stairs", frame: "He stands at a rainy bus stop at dusk.", beats: ["He checks the road, then steps back from a splash."] }];
    const planning = await invoke({ action: "create", brief: "use @a1 and @a2 to make a funny stairs are slippery video" });
    expect(planning).toMatchObject({ status: "planning", stage: "storyboards" });
    expect(planning.shortPlan).toBeUndefined();
    expect(planning.notes).toEqual([expect.stringMatching(/^@a1 is a video, so the short follows its storyboard of 3 frames: @[a-z]+\d+ at 0\.5 s, @[a-z]+\d+ at 1\.5 s and @[a-z]+\d+ at 2\.5 s\. Their on-screen graphics are removed before the frame is made\.$/u)]);
    await expect.poll(() => readGoal(engine, planning.goalId).status, { timeout: testBudget(30_000) }).toBe("review");
    const goal = await status(planning.goalId);
    expect(goal).toMatchObject({ stage: "storyboards", status: "review" });
    expect(goal.notes).toEqual([storyboardNote("@a1", storyboardOf(goal).frames)]);
    expect(storyboardOf(goal)).toMatchObject({ video: { artifactId: videoId }, model: "kie:seedream/5-5-image-to-image", size: expect.stringMatching(/^(1K|1\.5K|2K)$/u) });
    expect(storyboardOf(goal).frames).toHaveLength(3);
    expect(stub.submissions).toEqual([]);
    expect(chainRuns()).toBe(0);
    expect(sourceImagesOf(goal).map((reference) => [reference.artifactId, reference.label])).toEqual([[imageIds[1], "Character 2"]]);
  });

  it("clamps a 90 second brief to 60 seconds and notes the length", async () => {
    const goal = await short('a 90 second short, frame: "He stands in the rain." beat 1: "He looks down the road." beat 2: "He steps under the shelter." beat 3: "He checks the time." beat 4: "He boards the bus."');
    expect(goal.status).toBe("review");
    expect(stub.plannerRequests).toEqual([]);
    expect(goal.notes).toEqual(["A short runs 5 to 60 seconds, so this one is 60."]);
    expect(goal.shortPlan!.segments).toEqual([
      { prompt: "He looks down the road.", seconds: 15 },
      { prompt: "He steps under the shelter.", seconds: 15 },
      { prompt: "He checks the time.", seconds: 15 },
      { prompt: "He boards the bus.", seconds: 15 },
    ]);
  });

  it("clamps a 2 second brief to 5 seconds and notes the length", async () => {
    const goal = await short('a 2 second short, frame: "He stands in the rain." beat 1: "He looks down the road."');
    expect(goal.status).toBe("review");
    expect(stub.plannerRequests).toEqual([]);
    expect(goal.notes).toEqual(["A short runs 5 to 60 seconds, so this one is 5."]);
    expect(goal.shortPlan!.segments).toEqual([{ prompt: "He looks down the road.", seconds: 5 }]);
  });

  it("grows a 15 second short so a quoted beat 3 has its own segment", async () => {
    const goal = await short('15 seconds, frame: "Dusk at the shelter." beat 1: "He waits." beat 2: "He looks up." beat 3: "He leaves."');
    expect(goal.status).toBe("review");
    expect(stub.plannerRequests).toEqual([]);
    expect(goal.notes).toEqual(["The brief quotes beat 3, so this short has 3 segments."]);
    expect(goal.shortPlan!.segments).toEqual([
      { prompt: "He waits.", seconds: 5 },
      { prompt: "He looks up.", seconds: 5 },
      { prompt: "He leaves.", seconds: 5 },
    ]);
  });

  it("folds a quoted beat beyond four into the last beat through MCP", async () => {
    const goal = await short('a 60 second short, frame: "He waits." beat 1: "He looks up." beat 2: "He stands." beat 3: "He walks." beat 4: "He stops." beat 5: "He waves."');
    expect(goal.status).toBe("review");
    expect(goal.shortPlan!.segments).toHaveLength(4);
    expect(goal.shortPlan!.segments[3]!.prompt).toBe("He stops. He waves.");
    expect(goal.notes).toContain("The brief quotes beat 5, so that line is part of the last beat.");
    expect(stub.plannerRequests).toEqual([]);
    expect(stub.submissions).toEqual([]);
    expect(chainRuns()).toBe(0);
  });

  it("plans an unquoted brief from its own words when OPENAI_API_KEY is unset", async () => {
    delete process.env.OPENAI_API_KEY;
    const goal = await short("he waits for a bus in the rain");
    expect(goal.status).toBe("review");
    expect(stub.plannerRequests).toEqual([]);
    expect(goal.notes).toEqual(["Planned from the brief as written. Add OPENAI_API_KEY in Settings for a written plan."]);
    expect(goal.shortPlan).toMatchObject({
      title: "he waits for a bus in",
      frame: { prompt: "he waits for a bus in the rain" },
      segments: [{ prompt: "he waits for a bus in the rain", seconds: 12 }],
    });
  });

  it("skips unusable mentions with a note and keeps the first 12 images", async () => {
    const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#228844" } }).png().toBuffer();
    const empty = notebookGridTag({ row: 7, column: 7 });
    const audio = notebookGridTag({ row: 2, column: 0 });
    const pending = notebookGridTag({ row: 2, column: 1 });
    const unreadableVideo = notebookGridTag({ row: 2, column: 2 });
    const unreadableImage = notebookGridTag({ row: 2, column: 3 });
    await addArtifactCell("audio", { row: 2, column: 0 });
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    await writeNotebook([...notebook.value.cells, engine.notebooks.createCell({ type: "generate_image", label: "Pending", slot: { row: 2, column: 1 } })]);
    await addArtifactCell("video", { row: 2, column: 2 });
    await addArtifactCell("image", { row: 2, column: 3 });
    const slots = Array.from({ length: 13 }, (_, index) => ({ row: 3 + Math.floor(index / 8), column: index % 8 }));
    const images: string[] = [];
    for (const slot of slots) images.push(await addArtifactCell("image", slot, { name: "original.png", bytes: png }));
    const tags = slots.map((slot) => notebookGridTag(slot));
    const goal = await short(`${empty} ${audio} ${pending} ${unreadableVideo} ${unreadableImage} ${tags.join(" ")}, ${AUTHORED}`);
    expect(goal.notes).toEqual([
      `${empty} is empty and was skipped.`,
      `${audio} is audio and was skipped.`,
      `${pending} has no output yet and was skipped.`,
      `${unreadableVideo} is a video, but its frames could not be read, so it was skipped.`,
      `${unreadableImage} has no readable image and was skipped.`,
      `${tags[12]} was skipped because a short takes at most 12 mentioned images.`,
    ]);
    expect(sourceImagesOf(goal).map((reference) => reference.artifactId)).toEqual(images.slice(0, 12));
  });

  it("loads a short saved before notes existed", async () => {
    const goal = await short();
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    await writeNotebook(notebook.value.cells.map((cell) => {
      if (cell.id !== goal.cellId) return cell;
      const inputs = { ...cell.inputs };
      delete inputs.notes;
      return { ...cell, inputs };
    }));
    expect((await status(goal.goalId)).notes).toEqual([]);
  });

  it("fingerprints the frame and each segment by what they are made from", async () => {
    const plan = (await short(`@a1 ${AUTHORED}`)).shortPlan!;
    if (plan.version !== 5) throw new Error("expected a version 5 plan");
    const frame = await shortFingerprint(engine, plan, "frame", 0, null);
    const moved = { ...plan, sourceImages: plan.sourceImages.map((reference) => ({ ...reference, address: "@h8" })) };
    expect(await shortFingerprint(engine, moved, "frame", 0, null)).toBe(frame);
    expect(await shortFingerprint(engine, { ...plan, frame: { ...plan.frame, prompt: "A different stop." } }, "frame", 0, null)).not.toBe(frame);
    const clip = await shortFingerprint(engine, plan, "videos", 0, "frame-a");
    expect(await shortFingerprint(engine, plan, "videos", 0, "frame-a")).toBe(clip);
    expect(await shortFingerprint(engine, plan, "videos", 0, "frame-b")).not.toBe(clip);
    expect(await shortFingerprint(engine, { ...plan, segments: [{ ...plan.segments[0]!, prompt: "He sits down." }] }, "videos", 0, "frame-a")).not.toBe(clip);
    const written = await engine.files.write(imageIds[0]!, "original.png", await sharp({ create: { width: 96, height: 128, channels: 3, background: "#654321" } }).png().toBuffer());
    if (!written.ok) throw new Error(written.error.message);
    expect(await shortFingerprint(engine, plan, "frame", 0, null)).not.toBe(frame);
    expect(await shortFingerprint(engine, plan, "videos", 0, "frame-a")).not.toBe(clip);
  });

  it("refuses an AI-tell check without a key or a generated output, queues nothing, and never lets findings gate a step", async () => {
    const goal = await short();
    const notGenerated = "Generate this frame or clip, and keep it selected, before checking it for AI tells.";
    expect(await refusal({ action: "check", goal_id: goal.goalId, stage: "frame", index: 0 })).toBe(notGenerated);
    const frame = await approved(goal);
    expect(await refusal({ action: "check", goal_id: goal.goalId, stage: "videos", index: 0 })).toBe(notGenerated);
    delete process.env.OPENAI_API_KEY;
    expect(await refusal({ action: "check", goal_id: goal.goalId, stage: "frame", index: 0 })).toBe("Set OPENAI_API_KEY in Settings before checking for AI tells.");
    process.env.OPENAI_API_KEY = "offline-openai-key";
    expect(engine.jobs.queue.list({ type: "check_goal_realism" })).toHaveLength(0);
    const warned = (artifactId: string) => saveGoal(engine, { ...readGoal(engine, goal.goalId), realism: { [artifactId]: { status: "completed", checkedAt: new Date().toISOString(), findings: [{ severity: "warn", text: "Six fingers on the right hand." }], error: null } } });
    warned(frame.stages.frame!.outputs[0]!.artifactId);
    const regenerated = await settled(await invoke({ action: "regenerate", goal_id: goal.goalId, revision: frame.revision, stage: "frame", index: 0 }));
    expect(regenerated.stages.frame!.outputs[0]!.artifactId).not.toBe(frame.stages.frame!.outputs[0]!.artifactId);
    expect(regenerated.stages.frame!.outputs[0]!.realism).toBeNull();
    warned(regenerated.stages.frame!.outputs[0]!.artifactId);
    const clip = await approved(await status(goal.goalId));
    expect(clip.stages.videos!.outputs).toHaveLength(1);
    warned(clip.stages.videos!.outputs[0]!.artifactId);
    await pauseBookQueueForTests(bookId);
    expect((await invoke({ action: "finish", goal_id: goal.goalId })).finish).toMatchObject({ status: "running" });
  });

  it("prices the frame and every segment, with H3 Max as a lower bound", async () => {
    const goal = await short('he waits, 20 seconds, frame: "A bus stop." beat 1: "He waits." beat 2: "He boards the bus."');
    expect(goal.estimate).toMatchObject({ frame: { usd: 0.21 }, videos: { usd: expect.any(Number) }, total: { usd: expect.any(Number) } });
    expect(goal.estimate.segments).toHaveLength(2);
    for (const segment of goal.estimate.segments!) expect(lowerBoundWarnings(segment.warnings), JSON.stringify(segment)).toBe(true);
    expect(goal.estimate.total.usd).toBeCloseTo(0.21 + goal.estimate.videos.usd!);
  });

  it("makes a frame from a brief with no image, with no character text and no character note", async () => {
    const goal = await short();
    expect(sourceImagesOf(goal)).toEqual([]);
    expect(goal.notes.join("\n")).not.toMatch(/character|source image/iu);
    const started = await invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision });
    expect(started.notes.join("\n")).not.toMatch(/character|source image|pick image/iu);
    expect(sourceImagesOf(started)).toEqual([]);
    expect(started.estimate.frame.usd).toBe(goal.estimate.frame.usd);
    const step = getChainRun(engine, started.chainId!)?.steps.find((item) => item.id === "frame");
    const prompt = String((step?.params as { prompt?: string } | undefined)?.prompt ?? "");
    expect(prompt).toContain("He stands under a bus shelter at dusk.");
    expect(prompt).toContain(SHORT_RULES.frame);
    expect(prompt).not.toMatch(/Main character|a man in a green shirt|source image/iu);
    expect(goal.shortPlan).toMatchObject({ frame: { model: "fal:openai/gpt-image-2.6/sunburst/edit" } });
    expect(step?.params).toMatchObject({ model: "fal:openai/gpt-image-2.6/sunburst/text-to-image" });
    expect(step?.params).not.toHaveProperty("refs");
    const made = await settled(started);
    expect(made.stages.frame?.outputs[0]?.artifactId).toEqual(expect.any(String));
    expect(stub.submissions.map((submission) => submission.path)).toEqual(["/openai/gpt-image-2.6/sunburst/text-to-image"]);
    expect(JSON.stringify(stub.submissions)).not.toMatch(/Main character|a man in a green shirt/u);
    expect(chainRuns()).toBe(1);
  });

  it("generates the frame and the base clip through fal, then opens the finish review on that clip", async () => {
    const goal = await short(`he waits under @a2, ${AUTHORED}`);
    const frame = await approved(goal);
    expect(stub.submissions.map((submission) => submission.path)).toEqual(["/openai/gpt-image-2.6/sunburst/edit"]);
    expect(stub.submissions[0]!.body).toMatchObject({ image_size: "portrait_16_9", quality: "high", output_format: "jpeg" });
    expect(String(stub.submissions[0]!.body.prompt)).toContain(SHORT_RULES.frame);
    expect(stepPrompt(frame.chainId, "frame")).toContain("@image1 is a source image: keep that person exactly");
    expect(String(stub.submissions[0]!.body.prompt)).toContain("reference image 1 is a source image: keep that person exactly");
    expect(stub.submissions[0]!.body.image_urls).toHaveLength(1);
    expect(mediaJobs("fal:openai/gpt-image-2.6/sunburst/edit")[0]?.payload).toMatchObject({ refs: { image: [imageIds[1]] }, options: { image_size: "portrait_16_9" } });
    expect(frame).toMatchObject({ stage: "videos", status: "review", error: null });
    const frameId = frame.stages.frame!.outputs[0]!.artifactId;
    const clip = await approved(frame);
    const submitted = stub.submissions.find((submission) => submission.path === "/minimax/h3-max/reference-to-video")!;
    expect(submitted.body).toMatchObject({ duration: 12, resolution: "1080P", aspect_ratio: "9:16", prompt_expansion_mode: "disabled", image_url: expect.stringMatching(/^http/u) });
    expect(submitted.body.reference_image_urls).toHaveLength(1);
    expect(stepPrompt(clip.chainId, "clip1")).toContain("@image1 is a source image: keep that person exactly, in the same clothes.");
    expect(String(submitted.body.prompt)).toContain("reference image 1 is a source image: keep that person exactly, in the same clothes.");
    expect(String(submitted.body.prompt)).toContain(`${SHORT_RULES.video}\n\n${SHORT_RULES.silence}`);
    expect(JSON.stringify(stub.submissions)).not.toMatch(/Main character|a man in a green shirt/u);
    expect(mediaJobs("fal:minimax/h3-max/reference-to-video")[0]?.payload).toMatchObject({ refs: { first_frame: [frameId], image: [imageIds[1]] }, transcribe: false });
    const clipId = clip.stages.videos!.outputs[0]!.artifactId;
    const original = await engine.metadata.artifacts.read<Record<string, unknown>>(clipId, "original");
    expect(original.ok && original.value).toMatchObject({ model: "fal:minimax/h3-max/reference-to-video", hasAudio: true, transcribe: false });
    expect(clip).toMatchObject({ stage: "videos", status: "review", finish: { status: "review", sourceArtifactId: clipId } });
    expect(await refusal({ action: "approve", goal_id: goal.goalId, revision: clip.revision })).toBe("Every segment of this short is generated. Finish it, regenerate a segment or add a beat.");
    await pauseBookQueueForTests(bookId);
    const finishing = await invoke({ action: "finish", goal_id: goal.goalId });
    expect(finishing.finish).toMatchObject({ status: "running", sourceArtifactId: clipId });
    expect(finishing.finish?.startSeconds).toBeUndefined();
    expect(finishing.coldOpen).toBeNull();
    expect(engine.jobs.queue.list({ type: "finish_goal" })).toHaveLength(1);
    expect(stub.unexpected).toEqual([]);
  });

  it("runs a saved version 4 short with its stored character and unchanged prompts", async () => {
    const plan = buildLegacyGoalShortPlan({
      title: "Waiting", aspectRatio: "9:16",
      character: { name: "Main character", description: "a man in a green shirt", references: [await imageReference(0)] },
      framePrompt: "He stands under a bus shelter at dusk.",
      beats: ["He checks the road for the bus."],
      segmentSeconds: [12],
      extraReferences: [],
    });
    const created = await invoke({ action: "create", brief: AUTHORED, plan, request_id: uuidv7() });
    expect(created).toMatchObject({ planVersion: 4, status: "review" });
    if (created.shortPlan?.version !== 4) throw new Error("expected a version 4 plan");
    const frameFingerprint = await shortFingerprint(engine, created.shortPlan, "frame", 0, null);
    const frame = await approved(created);
    expect(frame.stages.frame?.outputs).toHaveLength(1);
    const frameId = frame.stages.frame!.outputs[0]!.artifactId;
    expect(stepPrompt(frame.chainId, "frame")).toContain("@image1 is Main character (a man in a green shirt): keep the face, hair, build and clothes exactly.");
    expect(String(stub.submissions[0]!.body.prompt)).toContain("reference image 1 is Main character (a man in a green shirt): keep the face, hair, build and clothes exactly.");
    expect(await shortFingerprint(engine, frame.shortPlan!, "frame", 0, null)).toBe(frameFingerprint);
    const clipFingerprint = await shortFingerprint(engine, frame.shortPlan!, "videos", 0, frameId);
    const clip = await approved(frame);
    const clipId = clip.stages.videos!.outputs[0]!.artifactId;
    const clipPrompt = String(stub.submissions.find((submission) => submission.path === "/minimax/h3-max/reference-to-video")!.body.prompt);
    expect(stepPrompt(clip.chainId, "clip1")).toContain(`@image1 is Main character: keep the same person in the same clothes.\n\n${SHORT_RULES.video}\n\n${LEGACY_SHORT_SILENCE}`);
    expect(clipPrompt).toContain(`reference image 1 is Main character: keep the same person in the same clothes.\n\n${SHORT_RULES.video}\n\n${LEGACY_SHORT_SILENCE}`);
    expect(await shortFingerprint(engine, clip.shortPlan!, "videos", 0, frameId)).toBe(clipFingerprint);
    const regenerated = await settled(await invoke({ action: "regenerate", goal_id: created.goalId, revision: clip.revision, stage: "frame" }));
    expect(regenerated.stages.frame!.outputs[0]!.artifactId).not.toBe(frameId);
    expect(regenerated.stages.videos!.outputs[0]!.artifactId).toBe(clipId);
    expect(regenerated.stages.videos!.outputs[0]!.stale).toBe("The frame or an earlier clip changed after this clip was made.");
    expect(await shortFingerprint(engine, regenerated.shortPlan!, "frame", 0, null)).toBe(frameFingerprint);
    const restored = await invoke({ action: "select", goal_id: created.goalId, stage: "frame", index: 0, artifact_id: frameId });
    expect(restored.stages.frame!.outputs[0]!.artifactId).toBe(frameId);
    expect(restored.stages.videos!.outputs[0]!.artifactId).toBe(clipId);
    expect(restored.stages.videos!.outputs[0]!.stale).toBeNull();
    expect(await shortFingerprint(engine, restored.shortPlan!, "videos", 0, frameId)).toBe(clipFingerprint);
    await pauseBookQueueForTests(bookId);
    const finishing = await invoke({ action: "finish", goal_id: created.goalId });
    expect(finishing.finish).toMatchObject({ status: "running", sourceArtifactId: clipId });
    expect(await shortFingerprint(engine, finishing.shortPlan!, "frame", 0, null)).toBe(frameFingerprint);
    expect(await shortFingerprint(engine, finishing.shortPlan!, "videos", 0, frameId)).toBe(clipFingerprint);
  });

  it("regenerates, revises, selects versions and retries the frame and the base clip", async () => {
    const goal = await short(`@a1 ${AUTHORED}`);
    const firstFrame = await approved(goal);
    const firstFrameId = firstFrame.stages.frame!.outputs[0]!.artifactId;
    const clip = await approved(firstFrame);
    const regenerated = await settled(await invoke({ action: "regenerate", goal_id: goal.goalId, revision: clip.revision, stage: "frame" }));
    const secondFrameId = regenerated.stages.frame!.outputs[0]!.artifactId;
    expect(secondFrameId).not.toBe(firstFrameId);
    expect(regenerated).toMatchObject({ stage: "videos", status: "review", finish: null });
    expect(regenerated.stages.videos!.outputs[0]!.stale).toBe("The frame or an earlier clip changed after this clip was made.");
    const earlier = await invoke({ action: "select", goal_id: goal.goalId, stage: "frame", index: 0, artifact_id: firstFrameId });
    expect(earlier.stages.videos!.outputs[0]!.stale).toBeNull();
    expect(earlier.finish).toBeNull();
    const later = await invoke({ action: "select", goal_id: goal.goalId, stage: "frame", index: 0, artifact_id: secondFrameId });
    expect(later.stages.videos!.outputs[0]!.stale).not.toBeNull();
    stub.plannerAnswers = [{ prompt: "He checks the road for the bus as heavy rain hammers the shelter roof." }];
    const revised = await settled(await invoke({ action: "revise", goal_id: goal.goalId, revision: later.revision, stage: "videos", index: 0, feedback: "Make the rain heavier." }));
    expect(String(stub.submissions.at(-1)!.body.prompt)).toMatch(/^He checks the road for the bus as heavy rain hammers the shelter roof\.\n\n/u);
    expect(String(stub.submissions.at(-1)!.body.prompt)).not.toContain("Make the rain heavier.");
    expect(revised).toMatchObject({ revision: later.revision + 1, shortPlan: { segments: [{ prompt: "He checks the road for the bus as heavy rain hammers the shelter roof." }] } });
    expect(revised.stages.videos!.outputs[0]!.stale).toBeNull();
    expect(revised.stages.videos!.outputs[0]!.versions).toHaveLength(2);
    expect(revised.finish).toMatchObject({ status: "review", sourceArtifactId: revised.stages.videos!.outputs[0]!.artifactId });
    stub.failNext = true;
    const failed = await settled(await invoke({ action: "regenerate", goal_id: goal.goalId, revision: revised.revision, stage: "videos", index: 0 }));
    expect(failed).toMatchObject({ status: "failed", error: expect.stringContaining(REFUSAL) });
    const retried = await settled(await invoke({ action: "retry", goal_id: goal.goalId }));
    expect(retried).toMatchObject({ status: "review", stage: "videos" });
    expect(retried.stages.videos!.outputs[0]!.versions.length).toBeGreaterThanOrEqual(3);
    stub.failNext = true;
    const failedAgain = await settled(await invoke({ action: "regenerate", goal_id: goal.goalId, revision: retried.revision, stage: "frame" }));
    expect(failedAgain.status).toBe("failed");
    const written = await engine.files.write(imageIds[0]!, "original.png", await sharp({ create: { width: 96, height: 128, channels: 3, background: "#123456" } }).png().toBuffer());
    if (!written.ok) throw new Error(written.error.message);
    expect(await refusal({ action: "retry", goal_id: goal.goalId })).toBe("The references or selected versions changed after this attempt. Regenerate using the current selection instead of retrying the older request.");
  });

  it("revises a clip by rewriting its beat with the feedback, so the one paid call keeps no sentence the feedback contradicts", async () => {
    const beat = "He waits at the stop as a bus passes. The phone stays at chest height, keeping him framed.";
    const feedback = "A bus drives past and splashes his green shirt. He does not hold a phone. The bus shows no writing.";
    const goal = await short(`he waits for a bus in light rain, frame: "He stands under a bus shelter in light rain." beat 1: "${beat}"`);
    const clip = await approved(await approved(goal));
    const rewritten = "He waits at the stop, both hands empty at his sides, as a plain white bus drives past and splashes his green shirt. He looks down and sighs.";
    stub.plannerAnswers = [{ prompt: "A plain white bus splashes his green shirt. The phone stays at chest height, keeping him framed." }, { prompt: rewritten }];
    const before = stub.submissions.length;
    const revised = await settled(await invoke({ action: "revise", goal_id: goal.goalId, revision: clip.revision, stage: "videos", index: 0, feedback }));
    const [ask, again] = stub.plannerRequests as RewriteRequest[];
    expect(stub.plannerRequests).toHaveLength(2);
    expect(JSON.parse(ask!.input[0]!.content)).toMatchObject({ revise: "beat 1", prompt: beat, feedback, previous: "He stands under a bus shelter in light rain.", next: null });
    expect(ask!.instructions).toContain("Remove or rewrite every sentence the feedback contradicts");
    expect(again!.input.at(-1)!.content).toContain("Leave the phone out of the beat 1: call it the camera, which someone off screen holds.");
    const paid = stub.submissions.slice(before);
    expect(paid.map((submission) => submission.path)).toEqual(["/minimax/h3-max/reference-to-video"]);
    expect(paid[0]!.body).toMatchObject({ prompt_expansion_mode: "disabled" });
    const prompt = String(paid[0]!.body.prompt);
    expect(prompt.startsWith(`${rewritten}\n\n`)).toBe(true);
    expect(prompt).not.toContain("chest height");
    expect(prompt).not.toContain("does not hold");
    expect(prompt.match(PHONE_SENTENCE)).toEqual([SHORT_RULES.video.split(".")[0]]);
    expect(revised).toMatchObject({ status: "review", revision: clip.revision + 1, shortPlan: { segments: [{ prompt: rewritten }] } });
    expect(revised.stages.videos!.outputs[0]!.versions).toHaveLength(2);
    expect(revised.stages.videos!.outputs[0]!.versions[0]).toMatchObject({ basePrompt: rewritten, feedback, current: true });
    expect(stub.unexpected).toEqual([]);
  });

  it("drops a phone sentence the rewrite keeps twice once the feedback rules a phone out", async () => {
    const beat = "He waits at the stop as a bus passes. The phone stays at chest height, keeping him framed.";
    const goal = await short(`he waits for a bus, frame: "He stands under a bus shelter." beat 1: "${beat}"`);
    const clip = await approved(await approved(goal));
    stub.plannerAnswers = [{ prompt: beat }, { prompt: beat }];
    const revised = await settled(await invoke({ action: "revise", goal_id: goal.goalId, revision: clip.revision, stage: "videos", index: 0, feedback: "No phone in his hand." }));
    expect(revised.shortPlan!.segments[0]!.prompt).toBe("He waits at the stop as a bus passes.");
    expect(String(stub.submissions.at(-1)!.body.prompt).match(PHONE_SENTENCE)).toEqual([SHORT_RULES.video.split(".")[0]]);
  });

  it("rewrites an @ mention in revise feedback and accepts 1000 characters", async () => {
    const frame = await approved(await short());
    stub.plannerAnswers = [{ prompt: "He stands under a bus shelter at dusk beside the painted figure." }];
    const revised = await settled(await invoke({
      action: "revise", goal_id: frame.goalId, revision: frame.revision, stage: "frame", feedback: "Stand closer to @a1, not @h8.",
    }));
    const rewritten = "Stand closer to Character 1, not h8.";
    expect(revised.stages.frame!.outputs[0]!.versions[0]).toMatchObject({ feedback: rewritten });
    const request = stub.plannerRequests.at(-1) as RewriteRequest;
    expect(JSON.parse(request.input[0]!.content)).toMatchObject({ feedback: rewritten });
    const long = "D".repeat(1000);
    stub.plannerAnswers = [{ prompt: "He stands under a bus shelter at dusk beneath a darker sky." }];
    const again = await settled(await invoke({
      action: "revise", goal_id: frame.goalId, revision: revised.revision, stage: "frame", feedback: long,
    }));
    expect(again.stages.frame!.outputs[0]!.versions[0]).toMatchObject({ feedback: long });
    expect(JSON.parse((stub.plannerRequests.at(-1) as RewriteRequest).input[0]!.content)).toMatchObject({ feedback: long });
  });

  it("revises the frame by rewriting its prompt, then makes the clip from the new frame", async () => {
    const frame = await approved(await short());
    stub.plannerAnswers = [{ prompt: "He stands under a bus shelter at dusk beneath a dark, heavy sky." }];
    const revised = await settled(await invoke({ action: "revise", goal_id: frame.goalId, revision: frame.revision, stage: "frame", feedback: "Darker sky." }));
    expect(stub.submissions.at(-1)!.path).toBe("/openai/gpt-image-2.6/sunburst/text-to-image");
    expect(String(stub.submissions.at(-1)!.body.prompt)).toMatch(/^He stands under a bus shelter at dusk beneath a dark, heavy sky\.\n\n/u);
    expect(String(stub.submissions.at(-1)!.body.prompt)).not.toContain("Darker sky.");
    expect(revised).toMatchObject({ stage: "videos", status: "review", shortPlan: { frame: { prompt: "He stands under a bus shelter at dusk beneath a dark, heavy sky." } } });
    expect(revised.stages.frame!.outputs[0]!.versions).toHaveLength(2);
    expect((await approved(revised)).stages.videos!.outputs).toHaveLength(1);
  });

  it("refuses a revise without OPENAI_API_KEY, and spends nothing and changes nothing when the rewrite fails", async () => {
    const frame = await approved(await short());
    const runs = chainRuns();
    delete process.env.OPENAI_API_KEY;
    expect(await refusal({ action: "revise", goal_id: frame.goalId, revision: frame.revision, stage: "frame", feedback: "Darker sky." })).toBe(NO_OPENAI_KEY);
    expect(stub.plannerRequests).toEqual([]);
    process.env.OPENAI_API_KEY = "offline-openai-key";
    stub.plannerAnswers = [{ prompt: "" }, { prompt: words(41) }];
    expect(await refusal({ action: "revise", goal_id: frame.goalId, revision: frame.revision, stage: "frame", feedback: "Darker sky." }))
      .toBe("The rewritten frame still breaks its limits. Shorten the frame to at most 40 words; it has 41. Revise the frame again, or edit it and regenerate.");
    expect(stub.plannerRequests).toHaveLength(2);
    expect(chainRuns()).toBe(runs);
    expect(await status(frame.goalId)).toMatchObject({ status: "review", revision: frame.revision, shortPlan: { frame: { prompt: frame.shortPlan!.frame.prompt } } });
  });

  it("refuses every paid action without FAL_API_KEY before creating a chain", async () => {
    const frame = await approved(await short());
    const runs = chainRuns();
    delete process.env.FAL_API_KEY;
    for (const args of [
      { action: "approve", revision: frame.revision },
      { action: "regenerate", revision: frame.revision, stage: "frame" },
      { action: "revise", revision: frame.revision, stage: "frame", feedback: "Darker sky." },
    ]) {
      expect(await refusal({ ...args, goal_id: frame.goalId }), args.action).toBe(NO_FAL_KEY);
    }
    expect(chainRuns()).toBe(runs);
  });

  it("keeps a short's settings once its frame exists and the seconds of generated segments", async () => {
    const goal = await short('he waits, 20 seconds, frame: "A bus stop." beat 1: "He waits." beat 2: "He boards the bus."');
    const plan = goal.shortPlan!;
    const edited = await invoke({ action: "update", goal_id: goal.goalId, revision: goal.revision, plan: { ...plan, title: "Rainy stop", video: { ...plan.video, resolution: "768P" } } });
    expect(edited.shortPlan).toMatchObject({ title: "Rainy stop", video: { resolution: "768P" } });
    const frame = await approved(edited);
    expect(await refusal({ action: "update", goal_id: goal.goalId, revision: frame.revision, plan: { ...frame.shortPlan!, video: { ...frame.shortPlan!.video, resolution: "1080P" } } }))
      .toBe("Models, resolution, aspect ratio and rules stay with this short once its frame exists. Start a new /goal to change them.");
    const clip = await approved(frame);
    const rewritten = await invoke({ action: "update", goal_id: goal.goalId, revision: clip.revision, plan: { ...clip.shortPlan!, segments: [clip.shortPlan!.segments[0]!, { prompt: "He waves from the bus.", seconds: 10 }] } });
    expect(rewritten.shortPlan?.segments[1]?.prompt).toBe("He waves from the bus.");
    expect(await refusal({ action: "update", goal_id: goal.goalId, revision: rewritten.revision, plan: { ...rewritten.shortPlan!, segments: [{ ...rewritten.shortPlan!.segments[0]!, seconds: 11 }, rewritten.shortPlan!.segments[1]!] } }))
      .toBe("A generated segment keeps its place and seconds. Regenerate it, or start a new /goal to change them.");
  });
});
