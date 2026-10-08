import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { createEngineForTest } from "../engine.js";
import { createTestClient } from "../test-client.js";
import { pauseBookQueueForTests, stopBookQueue } from "../queue.js";
import { cancelChainRun, getChainRun, waitForChainRun } from "../chain-executor.js";
import { compileFrameSteps, compileStoryboardSteps, compileVideoSteps, compileReviseStillStep, goalBriefConstraints, goalPlanSchema, goalPlannerResponseSchema, goalPromptBudgetIssues, goalPromptWords, goalStillPrompt, GOAL_PROMPT_BUDGET, GOAL_IMAGE_TOOLS, GOAL_VIDEO_TOOL } from "../goal-plan.js";
import { normalizeSeedance25Request } from "../seedance25.js";
import { readGoal, saveGoal } from "../goal-store.js";
import { goalPlannerBrief } from "../goal-characters.js";
import { GOAL_STYLE_IDS, goalBriefStyle, goalStyleFragment, resolveGoalStyleOptions } from "../goal-styles.js";
import { LEGACY_GOAL_MESSAGE } from "../goal-state.js";
import { appendGoalClips } from "../jobs/assemble-goal.js";
import { goalTestCharacters, goalTestPlan, goalTestVideo, seedGoalStage } from "../test-goals.js";
import { probeVideo } from "../ffmpeg.js";
import type { GoalSnapshot } from "./goal.js";

const brief = "@a1@a2 make a funny video of a dog on a skateboard, three 10s clips";
const plan = goalTestPlan();
const characters = [0, 1].map(index => ({ artifactId: uuidv7(), cellId: uuidv7(), address: `@a${index + 1}`, label: `Character ${index + 1}` }));

describe("video goal plans", () => {
  it("requires v2 prompts, bounded shots and supported output settings", () => {
    expect(goalPlanSchema.parse(plan)).toEqual(plan);
    const { version: _version, ...legacy } = plan;
    expect(goalPlanSchema.safeParse(legacy).success).toBe(false);
    expect(goalPlanSchema.safeParse({ ...plan, shots: [] }).success).toBe(false);
    expect(goalPlanSchema.safeParse({ ...plan, frame: { prompt: "Make @a1 the hero" } }).success).toBe(false);
    expect(goalPlanSchema.safeParse({ ...plan, shots: Array(9).fill(plan.shots[0]) }).success).toBe(false);
    const { style: _style, ...withoutStyle } = plan;
    expect(goalPlanSchema.parse(withoutStyle).style).toEqual({ id: "cinematic", options: {} });
    expect(goalPlannerResponseSchema.parse(withoutStyle).style).toEqual({ id: "cinematic", options: {} });
    expect(goalPlanSchema.safeParse({ ...plan, style: { id: "ig-influencer", options: { format: "invalid" } } }).success).toBe(false);
    expect(goalPlanSchema.safeParse({ ...plan, style: { id: "cinematic", options: { format: "grwm" } } }).success).toBe(false);
    expect(goalPlanSchema.parse({ ...plan, style: { id: "ig-influencer", options: { format: "grwm" } } }).style.options)
      .toEqual(resolveGoalStyleOptions("ig-influencer", { format: "grwm" }));
    expect(goalBriefConstraints(brief)).toEqual({ shotCount: 3, durationSeconds: 10, aspectRatio: "9:16" });
    expect(goalBriefConstraints("two 4s funny clips")).toEqual({ shotCount: 2, durationSeconds: 4, aspectRatio: "9:16" });
    expect(goalBriefConstraints("four 8-second clips, portrait")).toEqual({ shotCount: 4, durationSeconds: 8, aspectRatio: "9:16" });
    expect(goalBriefConstraints("2 x 12s, square")).toEqual({ shotCount: 2, durationSeconds: 12, aspectRatio: "1:1" });
    expect(goalBriefConstraints("@a1 @a2 as Mr Bean in Thailand")).toEqual({ shotCount: 3, durationSeconds: 10, aspectRatio: "9:16" });
    for (const format of ["landscape", "horizontal", "widescreen", "16:9"]) {
      expect(goalBriefConstraints(`@a1 @a2 as Mr Bean in Thailand, ${format}`).aspectRatio).toBe("16:9");
    }
    for (const format of ["portrait", "vertical", "9:16"]) expect(goalBriefConstraints(format).aspectRatio).toBe("9:16");
    for (const format of ["square", "1:1"]) expect(goalBriefConstraints(format).aspectRatio).toBe("1:1");
    expect(() => goalBriefConstraints("12 clips of 10s")).toThrow("1–8");
    expect(() => goalBriefConstraints("3 clips of 4.5s")).toThrow("whole number");
    expect(() => goalBriefConstraints("three 90-second clips")).toThrow("4 to 30");
  });

  it("compiles three separately approved stages with ordered references and input legends", () => {
    const frame = compileFrameSteps(plan, characters);
    expect(frame).toHaveLength(1);
    expect(frame[0]).toMatchObject({ id: "frame", tool: GOAL_IMAGE_TOOLS.sunburst, params: { image_refs: ["@a1", "@a2"], resolution: "2K" } });
    expect(frame[0]!.params.prompt).toContain("@image1 Character 1");
    const storyboards = compileStoryboardSteps(plan, characters, "@b2");
    expect(storyboards).toHaveLength(3);
    expect(storyboards[1]).toMatchObject({ id: "storyboard2", params: { image_refs: ["@b2", "@a1", "@a2"] } });
    expect(storyboards[1]!.params.prompt).toContain("@image1 full frame");
    expect(storyboards[1]!.params.prompt).toContain("@image2 Character 1");
    expect(storyboards[1]!.params.prompt).toContain("2x2 storyboard");
    expect(storyboards[1]!.params.prompt).toContain("1 setup; 2 action; 3 reaction; 4 ending");
    expect(storyboards[1]!.params.prompt).toContain(plan.shots[1]!.videoPrompt);
    expect(storyboards[1]!.params.prompt).toContain("Each 9:16");
    expect(compileStoryboardSteps(plan, characters, "@b2", [1]).map(step => step.id)).toEqual(["storyboard2"]);
    const videos = compileVideoSteps(uuidv7(), plan, ["@c1", "@c2", "@c3"]);
    expect(videos).toHaveLength(4);
    expect(videos[1]).toMatchObject({ id: "shot2", tool: GOAL_VIDEO_TOOL, params: { image_refs: ["@c2"], duration: "10", aspect_ratio: "9:16", resolution: "720p", generate_audio: true } });
    expect(videos[1]!.params.first_frame_ref).toBeUndefined();
    expect(videos[1]!.params.last_frame_ref).toBeUndefined();
    expect(videos[1]!.params.prompt).toContain("@image1 storyboard");
    expect(videos[1]!.params.prompt).toContain("No grid, borders, text");
    expect(normalizeSeedance25Request({ model: "bytedance/seedance-2-5", input: { ...videos[1]!.params, prompt: String(videos[1]!.params.prompt), reference_image_urls: ["https://example.test/storyboard.png"] } })).toMatchObject({ input: { aspect_ratio: "9:16" } });
    expect(videos[3]!.params.artifact_ids).toEqual([1, 2, 3].map(index => ({ $ref: { step_id: `shot${index}`, output: "asset_id" } })));
    expect(compileVideoSteps(uuidv7(), goalTestPlan(1), ["@c1"])).toHaveLength(1);
    expect(frame[0]!.params.prompt).toContain(plan.continuity);
    for (const step of [...storyboards, ...videos.slice(0, 3)]) {
      expect(step.params.prompt).not.toContain(plan.continuity);
      expect(step.params.prompt).not.toMatch(/@[abc][1-8]/u);
      expect(goalPromptWords(String(step.params.prompt))).toBeLessThan(step.id.startsWith("storyboard") ? 180 : 110);
    }
    expect(goalPlannerBrief(brief, characters)).toContain("Character 1 Character 2");
  });

  it("keeps ending frames opt-in and passes them alongside storyboard references", () => {
    expect(plan.frameContinuity).toBe(false);
    const paired = { ...plan, frameContinuity: true };
    const steps = compileStoryboardSteps(paired, characters, "@b2");
    expect(steps.map(step => step.id)).toEqual(["storyboard1", "storyboard2", "storyboard3", "storyboard4", "storyboard5", "storyboard6"]);
    expect(steps[3]!.params.prompt).toContain("Final moment");
    expect(steps[3]!.params.prompt).not.toContain(plan.shots[1]!.storyboardPrompt);
    expect(steps[3]!.params.prompt).not.toContain(plan.continuity);
    expect(compileStoryboardSteps(paired, characters, "@b2", [1]).map(step => step.id)).toEqual(["storyboard2", "storyboard5"]);
    expect(() => compileVideoSteps(uuidv7(), paired, ["@c1", "@c2", "@c3"])).toThrow("ending frame");
    const videos = compileVideoSteps(uuidv7(), paired, ["@c1", "@c2", "@c3"], ["@d1", "@d2", "@d3"]);
    expect(videos[1]!.params).toMatchObject({ image_refs: ["@c2", "@d2"] });
    expect(videos[1]!.params.prompt).toContain("@image2 ending pose");
    expect(videos[1]!.params.first_frame_ref).toBeUndefined();
    expect(videos[1]!.params.last_frame_ref).toBeUndefined();
    expect(steps[3]!.params.prompt).not.toContain("four-panel");
  });

  it.each(["9:16", "16:9", "1:1"] as const)("keeps the four-panel contract when revising %s storyboards, including old single frames", aspectRatio => {
    const revised = compileReviseStillStep({ ...plan, aspectRatio }, characters, "storyboards", 1, "@c2", "Raise the umbrella", "@b2");
    expect(revised.params.image_refs).toEqual(["@c2", "@b2", "@a1", "@a2"]);
    expect(revised.params.prompt).toContain("2x2 storyboard");
    expect(revised.params.prompt).toContain(`Each ${aspectRatio}`);
    expect(revised.params.prompt).toContain("Four distinct moments");
    expect(revised.params.prompt).toContain(plan.shots[1]!.videoPrompt);
    expect(revised.params.prompt).toContain("Change @image1: Raise the umbrella");
    expect(revised.params.prompt).toContain("@image2: full frame; @image3: Character 1");
  });

  it("budgets planner prompts without rejecting longer saved plans", () => {
    expect(goalPromptBudgetIssues(plan)).toEqual([]);
    expect(goalPlannerResponseSchema.parse(plan)).toEqual(plan);
    const long = { ...plan, continuity: "x".repeat(700) };
    expect(goalPlanSchema.safeParse(long).success).toBe(true);
    expect(goalPlannerResponseSchema.safeParse(long).success).toBe(false);
    const words = (count: number) => Array(count).fill("word").join(" ");
    const budget = GOAL_PROMPT_BUDGET;
    expect(goalPromptBudgetIssues({
      ...plan, title: words(budget.title + 1), continuity: words(budget.continuity + 1), frame: { prompt: words(budget.frame + 1) },
      shots: [{ ...plan.shots[0]!, title: words(budget.title + 1), storyboardPrompt: words(budget.storyboard + 1), endingPrompt: words(budget.ending + 1), videoPrompt: words(budget.video + 1) }],
    })).toEqual([
      "Title: 7 words; limit 6.", "Continuity: 31 words; limit 30.", "Frame: 21 words; limit 20.",
      "Shot 1 title: 7 words; limit 6.", "Storyboard 1: 33 words; limit 32.", "Ending 1: 13 words; limit 12.", "Video 1: 13 words; limit 12.",
    ]);
    expect(goalPromptWords("  one\n two\tthree  ")).toBe(3);
    expect(goalPromptWords(" ")).toBe(0);
  });

  it("adds compact style anchors to each stage without changing still base prompts or tools", () => {
    const styled = { ...plan, frameContinuity: true, style: goalBriefStyle("IG influencer GRWM") };
    const boards = compileStoryboardSteps(styled, characters, "@b2");
    const steps = [
      [compileFrameSteps(styled, characters)[0]!, "frame"], [boards[0]!, "storyboard"], [boards[3]!, "ending"],
      [compileReviseStillStep(styled, characters, "storyboards", 0, "@c1", "Raise the umbrella", "@b2"), "revise"],
      [compileVideoSteps("goal", styled, ["@c1", "@c2", "@c3"], ["@d1", "@d2", "@d3"])[0]!, "video"],
    ] as const;
    for (const [step, stage] of steps) {
      expect(step.params.prompt).toContain(goalStyleFragment(styled.style, stage));
      expect(step.params.aspect_ratio).toBe("9:16");
      expect(step.tool).toBe(stage === "video" ? GOAL_VIDEO_TOOL : GOAL_IMAGE_TOOLS.sunburst);
    }
    expect(String(steps[4][0].params.prompt)).toMatch(/@image1 storyboard.*hyper-realistic.*@image2 ending pose.*No grid, borders, text\.$/su);
    expect(goalStillPrompt(styled, "frame", 0)).toBe(goalStillPrompt(plan, "frame", 0));
    expect(goalStillPrompt(styled, "storyboards", 0)).toBe(goalStillPrompt(plan, "storyboards", 0));
  });

  it.each(GOAL_STYLE_IDS)("keeps maximum planner-sized %s prompts terse with eight characters and ending references", id => {
    const words = (count: number) => Array(count).fill("word").join(" ");
    const budget = GOAL_PROMPT_BUDGET;
    const bounded = goalPlanSchema.parse({
      ...plan, style: { id, options: {} }, title: words(budget.title), continuity: words(budget.continuity), frame: { prompt: words(budget.frame) }, frameContinuity: true,
      shots: [{ title: words(budget.title), storyboardPrompt: words(budget.storyboard), videoPrompt: words(budget.video), endingPrompt: words(budget.ending), durationSeconds: 30 }],
    });
    const eight = Array.from({ length: 8 }, (_, index) => ({ ...characters[0]!, address: `@a${index + 1}` }));
    expect(goalPromptBudgetIssues(bounded)).toEqual([]);
    for (const step of compileStoryboardSteps(bounded, eight, "@b2")) expect(goalPromptWords(String(step.params.prompt))).toBeLessThan(140);
    for (const [stage, index] of [["frame", 0], ["storyboards", 0], ["storyboards", 1]] as const) {
      const step = compileReviseStillStep(bounded, eight, stage, index, "@c1", words(20), stage === "storyboards" ? "@b2" : undefined);
      expect(goalPromptWords(String(step.params.prompt))).toBeLessThan(160);
    }
    expect(goalPromptWords(String(compileVideoSteps("goal", bounded, ["@c1"], ["@d1"])[0]!.params.prompt))).toBeLessThan(60);
  });

  it("removes boilerplate from every previous cinematic prompt while leaving saved prose intact", async () => {
    const previous = JSON.parse(await readFile(new URL("../../../tests/fixtures/goals/cinematic-prompts.json", import.meta.url), "utf8")) as { plan: unknown; prompts: Record<string, string[]> };
    const saved = goalPlanSchema.parse(previous.plan);
    const compiled = {
      frame: compileFrameSteps(saved, characters), storyboards: compileStoryboardSteps(saved, characters, "@b2"),
      reviseFrame: [compileReviseStillStep(saved, characters, "frame", 0, "@b2", "Raise the umbrella")],
      reviseStoryboard: [compileReviseStillStep(saved, characters, "storyboards", 0, "@c1", "Raise the umbrella", "@b2")],
      reviseEnding: [compileReviseStillStep(saved, characters, "storyboards", 1, "@d1", "Raise the umbrella", "@b2")],
      video: compileVideoSteps("goal", saved, ["@c1"], ["@d1"]),
    };
    for (const [key, steps] of Object.entries(compiled)) {
      steps.forEach((step, index) => expect(goalPromptWords(String(step.params.prompt))).toBeLessThan(goalPromptWords(previous.prompts[key]![index]!)));
    }
    expect(compiled.frame[0]!.params.prompt).toContain(saved.frame.prompt);
    expect(compiled.video[0]!.params.prompt).toContain(saved.shots[0]!.videoPrompt);
  });
});

describe("staged video goals through MCP", () => {
  let root: string;
  let client: Client;
  let engine: Engine;
  let bookId: string;
  let notebookId: string;
  let imageIds: string[];
  let oldKie: string | undefined;
  let oldOpenAi: string | undefined;

  beforeEach(async () => {
    oldKie = process.env.KIE_API_KEY;
    oldOpenAi = process.env.OPENAI_API_KEY;
    process.env.KIE_API_KEY = "test-goal-key";
    process.env.OPENAI_API_KEY = "test-goal-key";
    root = await mkdtemp(join(tmpdir(), "videobook-staged-goal-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    const notebook = await engine.notebooks.create("Goals");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    imageIds = await goalTestCharacters(engine, notebookId);
  });

  afterEach(async () => {
    await client?.close();
    if (oldKie === undefined) delete process.env.KIE_API_KEY; else process.env.KIE_API_KEY = oldKie;
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAi;
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
  const status = (goalId: string) => invoke({ action: "status", goal_id: goalId });
  const approve = (goal: GoalSnapshot) => invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision });
  const notebook = () => {
    const result = engine.notebooks.read(notebookId);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  async function advance(goal: GoalSnapshot, stage: "frame" | "storyboards") {
    await seedGoalStage(engine, goal.goalId, stage);
    return status(goal.goalId);
  }

  it("resolves adjacent image mentions, saves character edges and per-stage estimates, and fences invalid inputs", async () => {
    const goal = await create({ request_id: "same-request" });
    expect(goal).toMatchObject({ planVersion: 2, stage: "frame", status: "review", revision: 1, address: "@a3", plan });
    expect(goal.characters.map(character => character.artifactId)).toEqual(imageIds);
    expect(notebook().edges.filter(edge => edge.target === goal.cellId).map(edge => edge.targetInput)).toEqual(["character", "character_2"]);
    const { still: _still, ...stageEstimates } = goal.estimate;
    expect(notebook().cells.find(cell => cell.id === goal.cellId)?.inputs).toMatchObject({ characters: goal.characters, plan, estimate: stageEstimates });
    expect(goal.estimate.frame.usd).toBeGreaterThan(0);
    expect(goal.estimate.total.usd).toBeCloseTo(goal.estimate.frame.usd! + goal.estimate.storyboards.usd! + goal.estimate.videos.usd!);
    expect((await create({ request_id: "same-request" })).goalId).toBe(goal.goalId);
    expect(engine.jobs.queue.list()).toHaveLength(0);
    expect((await raw({ action: "create", brief: "A dog rides a skateboard", plan })).content).toEqual([expect.objectContaining({ text: expect.stringContaining("Mention the character images") })]);
    expect((await raw({ action: "create", brief: "@h8 goes skating", plan })).isError).toBe(true);
    const video = await engine.artifacts.create("video", "not an image");
    if (!video.ok) throw new Error(video.error.message);
    await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({ type: "video", slot: { row: 0, column: 3 }, outputArtifactId: video.value.artifactId }));
    expect((await raw({ action: "create", brief: "@a4 goes skating", plan })).content).toEqual([expect.objectContaining({ text: "@a4 is not an image" })]);
    expect((await invoke<{ goals: GoalSnapshot[] }>({ action: "list" })).goals).toHaveLength(1);
    expect((await create({ brief: "@a1 @a1 skate" })).characters).toHaveLength(1);
  });

  it("saves edits by revision and queues only the approved frame with character provenance", async () => {
    const goal = await create();
    const changed = { ...plan, shots: plan.shots.map(shot => ({ ...shot, durationSeconds: 12 })) };
    const updated = await invoke({ action: "update", goal_id: goal.goalId, revision: 1, plan: changed });
    expect(updated.revision).toBe(2);
    expect(updated.estimate.videos.usd).toBeGreaterThan(goal.estimate.videos.usd!);
    expect((await raw({ action: "approve", goal_id: goal.goalId, revision: 1 })).isError).toBe(true);
    await pauseBookQueueForTests(bookId);
    const started = await approve(updated);
    await expect.poll(() => getChainRun(engine, started.chainId!)?.steps[0]?.childJobIds.length).toBe(1);
    const chain = getChainRun(engine, started.chainId!)!;
    expect(chain.steps).toHaveLength(1);
    expect(chain.steps[0]!.approval?.actor).toBe("chat");
    expect((await approve(updated)).chainId).toBe(started.chainId);
    const jobs = engine.jobs.queue.list({ type: "generate_gpt_image_2_5" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ sourceImageIds: imageIds, input: { resolution: "2K", aspect_ratio: "9:16" } });
    expect(engine.jobs.queue.list({ type: "generate_seedance25_video" })).toHaveLength(0);
    await expect.poll(() => notebook().cells.some(cell => cell.inputs?.chainRunId === `${started.chainId}:frame`)).toBe(true);
    const producer = notebook().cells.find(cell => cell.inputs?.chainRunId === `${started.chainId}:frame`)!;
    expect(producer).toMatchObject({ type: "generate_image", tool: GOAL_IMAGE_TOOLS.sunburst, inputs: { resolution: "2K", aspect_ratio: "9:16" } });
    expect(notebook().edges.filter(edge => edge.target === producer.id).map(edge => edge.source)).toEqual(goal.characters.map(character => character.cellId));
    expect((await invoke({ action: "cancel", goal_id: goal.goalId })).status).toBe("cancelled");
    await waitForChainRun(engine, started.chainId!);
  });

  it("round-trips style edits, defaults old stored plans, and locks style and options after the frame", async () => {
    const { style: _style, ...withoutStyle } = plan;
    const created = await create({ plan: withoutStyle });
    expect(created.plan).toEqual(plan);
    const document = notebook();
    const saved = await engine.notebooks.write({ ...document, cells: document.cells.map(cell => cell.id === created.cellId
      ? { ...cell, inputs: { ...cell.inputs, plan: withoutStyle } } : cell) });
    expect(saved.ok).toBe(true);
    expect((await status(created.goalId)).plan).toEqual(plan);
    const style = goalBriefStyle("IG influencer GRWM");
    const changed = await invoke({ action: "update", goal_id: created.goalId, revision: created.revision, plan: { ...plan, style } });
    expect(changed.revision).toBe(2);
    expect(changed.plan).toMatchObject({ style });
    expect((await invoke<{ goals: GoalSnapshot[] }>({ action: "list" })).goals[0]!.plan).toMatchObject({ style });
    expect((await status(created.goalId)).plan).toMatchObject({ style });
    expect(notebook().cells.find(cell => cell.id === created.cellId)!.inputs).not.toHaveProperty("requestedStyle");
    const frame = await advance(changed, "frame");
    for (const fixedStyle of [{ id: "cinematic", options: {} }, { ...style, options: { ...style.options, light: "golden-hour" } }]) {
      const rejected = await raw({ action: "update", goal_id: frame.goalId, revision: frame.revision, plan: { ...frame.plan, style: fixedStyle } });
      expect(rejected.isError).toBe(true);
      expect(rejected.content).toEqual([expect.objectContaining({ text: expect.stringContaining("fixed after generating the full frame") })]);
    }
    expect((await status(created.goalId)).stages.frame!.outputs[0]!.stale).toBeNull();
  });

  it("stores detected style while planning and lets an explicit plan override brief keywords", async () => {
    await pauseBookQueueForTests(bookId);
    const styledBrief = "@a1 as an IG influencer, GRWM morning routine";
    const created = await invoke({ action: "create", brief: styledBrief });
    expect(created).toMatchObject({ status: "planning", plan: null, requestedStyle: goalBriefStyle(styledBrief) });
    expect(notebook().cells.find(cell => cell.id === created.cellId)!.inputs?.requestedStyle).toEqual(goalBriefStyle(styledBrief));
    expect((await status(created.goalId)).requestedStyle).toEqual(created.requestedStyle);
    const explicit = await create({ brief: styledBrief });
    expect(explicit.plan).toMatchObject({ style: { id: "cinematic", options: {} } });
    expect(explicit).not.toHaveProperty("requestedStyle");
  });

  it("advances completed frames and storyboards to separate reviews and pins their inputs for the next stage", async () => {
    const goal = await create();
    const frame = await advance(goal, "frame");
    expect(frame).toMatchObject({ status: "review", stage: "storyboards", revision: 2 });
    expect(frame.stages.frame?.outputs[0]?.artifactId).toBeTruthy();
    expect((await raw({ action: "approve", goal_id: goal.goalId, revision: 1 })).isError).toBe(true);
    await pauseBookQueueForTests(bookId);
    const boards = await approve(frame);
    await expect.poll(() => getChainRun(engine, boards.chainId!)?.steps[0]?.childJobIds.length).toBe(1);
    const boardChain = getChainRun(engine, boards.chainId!)!;
    expect(boardChain.steps.map(step => step.id)).toEqual(["storyboard1", "storyboard2", "storyboard3"]);
    expect(boardChain.steps[0]!.pins.map(pin => pin.artifactId)).toEqual([frame.stages.frame!.outputs[0]!.artifactId, ...imageIds]);
    cancelChainRun(engine, boards.chainId!);
    await waitForChainRun(engine, boards.chainId!);
    const ready = await advance(boards, "storyboards");
    expect(ready).toMatchObject({ status: "review", stage: "videos", revision: 3 });
    const videos = await approve(ready);
    await expect.poll(() => {
      const current = getChainRun(engine, videos.chainId!);
      if (current?.error) throw new Error(current.error);
      return current?.steps[0]?.childJobIds.length;
    }).toBe(1);
    const chain = getChainRun(engine, videos.chainId!)!;
    expect(chain.steps.map(step => step.id)).toEqual(["shot1", "shot2", "shot3", "assemble"]);
    expect(chain.steps[0]!.pins.find(pin => pin.field === "image_refs")?.artifactId).toBe(ready.stages.storyboards!.outputs[0]!.artifactId);
    expect(chain.steps[0]!.pins.map(pin => pin.field)).toEqual(["image_refs"]);
    const payload = engine.jobs.queue.list({ type: "generate_seedance25_video" })[0]!.payload;
    expect(payload).toMatchObject({ imageInputs: [{ assetId: ready.stages.storyboards!.outputs[0]!.artifactId }], aspect_ratio: "9:16" });
    expect(payload.firstFrame).toBeUndefined();
    expect(payload.lastFrame).toBeUndefined();
    expect(notebook().cells.some(cell => cell.type === "timeline")).toBe(true);
    await invoke({ action: "cancel", goal_id: goal.goalId });
    await waitForChainRun(engine, videos.chainId!);
    expect(getChainRun(engine, videos.chainId!)!.steps.slice(1).every(step => step.status === "skipped")).toBe(true);
  });

  it("regenerates only the chosen storyboard and preserves other outputs and earlier tiles", async () => {
    const ready = await advance(await advance(await create(), "frame"), "storyboards");
    const before = ready.stages.storyboards!.outputs;
    expect((await raw({ action: "regenerate", goal_id: ready.goalId, revision: ready.revision - 1, shot_indexes: [1] })).isError).toBe(true);
    await pauseBookQueueForTests(bookId);
    const regenerating = await invoke({ action: "regenerate", goal_id: ready.goalId, revision: ready.revision, shot_indexes: [1] });
    await expect.poll(() => getChainRun(engine, regenerating.chainId!)?.steps[0]?.childJobIds.length).toBe(1);
    expect(getChainRun(engine, regenerating.chainId!)?.steps.map(step => step.id)).toEqual(["storyboard2"]);
    expect(regenerating.stages.storyboards!.outputs.map(output => output.artifactId)).toEqual(before.map(output => output.artifactId));
    expect(regenerating.stages.storyboards!.outputs[1]!.versions).toHaveLength(2);
    cancelChainRun(engine, regenerating.chainId!);
    await waitForChainRun(engine, regenerating.chainId!);
    await seedGoalStage(engine, ready.goalId, "storyboards", { indexes: [1] });
    const after = await status(ready.goalId);
    expect(after.stages.storyboards!.outputs[0]).toEqual(before[0]);
    expect(after.stages.storyboards!.outputs[2]).toEqual(before[2]);
    expect(after.stages.storyboards!.outputs[1]!.artifactId).not.toBe(before[1]!.artifactId);
    expect(before.every(output => notebook().cells.some(cell => cell.id === output.cellId))).toBe(true);
    expect(after.stages.storyboards!.allSteps.length).toBeGreaterThan(3);
  });

  it("rejects changed approved prompts until their frames are regenerated and keeps references tied to cell identity", async () => {
    const ready = await advance(await create(), "frame");
    const updated = await invoke({ action: "update", goal_id: ready.goalId, revision: ready.revision, plan: { ...plan, frame: { prompt: "A closer view of both characters" } } });
    expect((await raw({ action: "approve", goal_id: ready.goalId, revision: updated.revision })).content).toEqual([expect.objectContaining({ text: expect.stringContaining("Full frame was made from an older prompt") })]);
    const moved = notebook();
    await engine.notebooks.write({ ...moved, cells: moved.cells.map(cell => cell.id === ready.characters[0]!.cellId ? { ...cell, slot: { row: 7, column: 0 } } : cell) });
    await pauseBookQueueForTests(bookId);
    const regenerate = await invoke({ action: "regenerate", goal_id: ready.goalId, revision: updated.revision });
    expect(getChainRun(engine, regenerate.chainId!)?.steps[0]?.pins[0]?.address).toMatch(/h1/u);
    await invoke({ action: "cancel", goal_id: ready.goalId });
    await waitForChainRun(engine, regenerate.chainId!);
  });

  it("retains frame versions and uses the selected completed attempt without changing the plan revision", async () => {
    const first = await advance(await create(), "frame");
    const second = await advance(first, "frame");
    const artifactId = first.stages.frame!.outputs[0]!.artifactId;
    expect(second.stages.frame!.outputs[0]!.versions.map(version => version.artifactId)).toEqual([second.stages.frame!.outputs[0]!.artifactId, artifactId]);
    const selected = await invoke({ action: "select", goal_id: first.goalId, stage: "frame", index: 0, artifact_id: artifactId });
    expect(selected.revision).toBe(second.revision);
    expect(selected.stages.frame!.outputs[0]).toMatchObject({ artifactId, stale: null });
    expect(selected.stages.frame!.outputs[0]!.versions.map(version => version.current)).toEqual([false, true]);
    await pauseBookQueueForTests(bookId);
    const boards = await approve(selected);
    expect(getChainRun(engine, boards.chainId!)!.steps[0]!.params.image_refs).toEqual([first.stages.frame!.outputs[0]!.address, ...selected.characters.map(character => character.address)]);
    expect(getChainRun(engine, boards.chainId!)!.steps[0]!.pins[0]!.artifactId).toBe(artifactId);
    expect((await raw({ action: "select", goal_id: first.goalId, stage: "frame", index: 0, artifact_id: artifactId })).isError).toBe(true);
    await invoke({ action: "cancel", goal_id: first.goalId });
    await waitForChainRun(engine, boards.chainId!);
  });

  it("rejects versions from another goal, stage or index, and fences storyboards made from an older frame", async () => {
    const first = await advance(await create(), "frame");
    const second = await advance(first, "frame");
    const firstId = first.stages.frame!.outputs[0]!.artifactId;
    const secondId = second.stages.frame!.outputs[0]!.artifactId;
    const other = await advance(await create(), "frame");
    for (const args of [
      { stage: "frame", index: 1, artifact_id: firstId }, { stage: "storyboards", index: 0, artifact_id: firstId },
      { stage: "frame", index: 0, artifact_id: other.stages.frame!.outputs[0]!.artifactId },
    ]) expect((await raw({ action: "select", goal_id: first.goalId, ...args })).isError).toBe(true);
    await invoke({ action: "select", goal_id: first.goalId, stage: "frame", index: 0, artifact_id: firstId });
    const boards = await advance(second, "storyboards");
    expect(boards.stages.storyboards!.outputs.every(output => !output.stale)).toBe(true);
    const selected = await invoke({ action: "select", goal_id: first.goalId, stage: "frame", index: 0, artifact_id: secondId });
    expect(selected.stages.storyboards!.outputs.every(output => output.stale?.includes("older full frame"))).toBe(true);
    expect((await raw({ action: "approve", goal_id: first.goalId, revision: selected.revision })).content).toEqual([expect.objectContaining({ text: expect.stringContaining("Storyboard 1 was made from an older full frame") })]);
    const refreshed = await advance(selected, "storyboards");
    expect(refreshed.stages.storyboards!.outputs.every(output => !output.stale && output.versions.length === 2)).toBe(true);
    await pauseBookQueueForTests(bookId);
    const videos = await approve(refreshed);
    expect(videos.status).toBe("running");
    await invoke({ action: "cancel", goal_id: first.goalId });
    await waitForChainRun(engine, videos.chainId!);
  });

  it.each([true, false])("approves stored runs without attempt logs with character labels=%s", async labels => {
    const created = await create();
    const chainId = await seedGoalStage(engine, created.goalId, "frame", { legacy: true });
    const store = engine.settings.get<{ runs: Record<string, NonNullable<ReturnType<typeof getChainRun>>>; requestIndex: Record<string, string> }>("application.chain-runs.v1")!;
    const chain = store.runs[chainId]!;
    const legend = created.characters.map((character, index) => `@image${index + 1} is Character ${index + 1}${labels ? `: ${character.label}` : ""}`).join("; ");
    chain.steps[0]!.params.prompt = `${plan.continuity}\n\n${plan.frame.prompt}\n\nReferences: ${legend}.`;
    engine.settings.set("application.chain-runs.v1", store);
    const frame = await status(created.goalId);
    expect(frame.stages.frame!.attempts).toBeUndefined();
    expect(frame.stages.frame!.outputs[0]!.stale).toBeNull();
    await pauseBookQueueForTests(bookId);
    const boards = await approve(frame);
    expect(boards.status).toBe("running");
    await invoke({ action: "cancel", goal_id: created.goalId });
    await waitForChainRun(engine, boards.chainId!);
  });

  it.each([true, false])("keeps legacy single-frame previews with attempts=%s but requires a storyboard before video approval", async keepAttempts => {
    const ready = await advance(await advance(await create(), "frame"), "storyboards");
    const stored = readGoal(engine, ready.goalId);
    const run = stored.stages.storyboards!;
    saveGoal(engine, { ...stored, stages: { ...stored.stages, storyboards: {
      ...run, attempts: keepAttempts ? run.attempts!.map(attempt => ({ ...attempt, storyboardLayout: undefined, basePrompt: plan.shots[attempt.index]!.storyboardPrompt })) : undefined,
    } } });
    const legacy = await status(ready.goalId);
    expect(legacy.stages.storyboards!.outputs.map(output => output.artifactId)).toEqual(ready.stages.storyboards!.outputs.map(output => output.artifactId));
    expect(legacy.stages.storyboards!.outputs.every(output => output.stale?.includes("legacy single-frame preview"))).toBe(true);
    expect((await raw({ action: "approve", goal_id: ready.goalId, revision: legacy.revision })).content).toEqual([expect.objectContaining({ text: expect.stringContaining("four-panel storyboard") })]);
    expect(engine.jobs.queue.list({ type: "generate_seedance25_video" })).toHaveLength(0);
    await seedGoalStage(engine, ready.goalId, "storyboards", { revise: { index: 0, feedback: "Show the complete action" } });
    const revised = await status(ready.goalId);
    expect(revised.stages.storyboards!.outputs[0]!.stale).toBeNull();
    expect(revised.stages.storyboards!.outputs[1]!.stale).toContain("legacy single-frame preview");
    expect(revised.stages.storyboards!.attempts!.at(-1)).toMatchObject({ storyboardLayout: "four-panel", parentArtifactId: ready.stages.storyboards!.outputs[0]!.artifactId });
    expect(notebook().cells.some(cell => cell.id === ready.stages.storyboards!.outputs[0]!.cellId)).toBe(true);
    if (keepAttempts) {
      const selected = await invoke({ action: "select", goal_id: ready.goalId, stage: "storyboards", index: 0, artifact_id: ready.stages.storyboards!.outputs[0]!.artifactId });
      expect(selected.stages.storyboards!.outputs[0]!.stale).toContain("legacy single-frame preview");
    }
  });

  it.each([
    { storyboardPrompt: "1. Waits. 2. Pushes. 3. Wobbles. 4. Stops." },
    { videoPrompt: "Character 1 catches the rolling skateboard and bows. Applause." },
    { durationSeconds: 12 },
    { title: "A different ending" },
  ])("requires refreshed storyboard beats after editing %j", async change => {
    const ready = await advance(await advance(await create(), "frame"), "storyboards");
    const edited = await invoke({ action: "update", goal_id: ready.goalId, revision: ready.revision, plan: { ...plan, shots: plan.shots.map((shot, index) => index === 1 ? { ...shot, ...change } : shot) } });
    expect(edited.stages.storyboards!.outputs[1]!.stale).toContain("older prompt");
    expect(edited.stages.storyboards!.outputs[0]!.stale).toBeNull();
    expect((await raw({ action: "approve", goal_id: ready.goalId, revision: edited.revision })).isError).toBe(true);
    const restored = await invoke({ action: "update", goal_id: ready.goalId, revision: edited.revision, plan });
    expect(restored.stages.storyboards!.outputs.every(output => output.stale === null)).toBe(true);
    expect(engine.jobs.queue.list({ type: "generate_seedance25_video" })).toHaveLength(0);
  });

  it("revises the selected frame with ordered references and returns to its review when stopped", async () => {
    const frame = await advance(await create(), "frame");
    const original = frame.stages.frame!.outputs[0]!;
    await pauseBookQueueForTests(bookId);
    const revised = await invoke({ action: "revise", goal_id: frame.goalId, revision: frame.revision, stage: "frame", index: 0, feedback: "Give Character 1 a red cap" });
    await expect.poll(() => getChainRun(engine, revised.chainId!)?.steps[0]?.childJobIds.length).toBe(1);
    const step = getChainRun(engine, revised.chainId!)!.steps[0]!;
    const job = engine.jobs.queue.list({ type: "generate_gpt_image_2_5" })[0]!;
    expect(job.payload).toMatchObject({ sourceImageIds: [original.artifactId, ...imageIds], input: { aspect_ratio: "9:16", resolution: "2K", background: "opaque", prompt: expect.stringContaining("Change @image1: Give Character 1 a red cap") } });
    expect(step.params.prompt).toContain("@image2: Character 1");
    expect(revised.stages.frame!.attempts!.at(-1)).toMatchObject({ feedback: "Give Character 1 a red cap", parentArtifactId: original.artifactId, basePrompt: plan.frame.prompt });
    expect(revised.estimate.still).toEqual(frame.estimate.frame);
    expect(revised.resumeStage).toBe("storyboards");
    const stopped = await invoke({ action: "cancel", goal_id: frame.goalId });
    await waitForChainRun(engine, revised.chainId!);
    expect(stopped).toMatchObject({ status: "review", stage: "storyboards", chainId: frame.chainId, resumeStage: null });
    expect(stopped.stages.frame!.outputs[0]!.artifactId).toBe(original.artifactId);
    expect(stopped.stages.frame!.outputs[0]!.versions).toHaveLength(1);
    expect(stopped.stages.frame!.attempts!.map(attempt => attempt.chainId)).toEqual([frame.chainId]);
    expect(stopped.stages.frame!.previousChainIds).toContain(revised.chainId);
    expect(getChainRun(engine, revised.chainId!)?.status).toBe("cancelled");
    expect((await raw({ action: "retry", goal_id: frame.goalId })).isError).toBe(true);
    expect((await status(frame.goalId)).status).toBe("review");
    const discarded = await invoke({ action: "cancel", goal_id: frame.goalId });
    expect(discarded.status).toBe("cancelled");
  });

  it("completes revisions as selected versions and revises an ending frame independently", async () => {
    const frame = await advance(await create({ plan: { ...plan, frameContinuity: true } }), "frame");
    await seedGoalStage(engine, frame.goalId, "frame", { revise: { index: 0, feedback: "Give Character 1 a red cap" } });
    const revisedFrame = await status(frame.goalId);
    expect(revisedFrame).toMatchObject({ status: "review", stage: "storyboards" });
    expect(revisedFrame.stages.frame!.outputs[0]!.versions.map(version => version.current)).toEqual([true, false]);
    expect(revisedFrame.stages.frame!.outputs[0]!.versions[0]).toMatchObject({ feedback: "Give Character 1 a red cap", parentArtifactId: frame.stages.frame!.outputs[0]!.artifactId });
    const boards = await advance(revisedFrame, "storyboards");
    await seedGoalStage(engine, boards.goalId, "storyboards", { revise: { index: 1, feedback: "Move them closer" } });
    const revised = await status(boards.goalId);
    expect(revised).toMatchObject({ stage: "videos", status: "review" });
    expect(revised.stages.storyboards!.outputs[0]).toEqual(boards.stages.storyboards!.outputs[0]);
    expect(revised.stages.storyboards!.outputs[1]!.versions).toHaveLength(2);
    expect(revised.estimate.still.usd).toBeCloseTo(revised.estimate.storyboards.usd! / 6);
    await pauseBookQueueForTests(bookId);
    const ending = await invoke({ action: "revise", goal_id: revised.goalId, revision: revised.revision, stage: "storyboards", index: 4, feedback: "Both wave" });
    expect(getChainRun(engine, ending.chainId!)!.steps.map(step => step.id)).toEqual(["storyboard5"]);
    const step = getChainRun(engine, ending.chainId!)!.steps[0]!;
    expect(step.pins.map(pin => pin.artifactId)).toEqual([revised.stages.storyboards!.outputs[4]!.artifactId, revised.stages.frame!.outputs[0]!.artifactId, ...imageIds]);
    expect(step.params.prompt).toContain("@image2: full frame; @image3: Character 1");
    expect(goalPromptWords(String(step.params.prompt))).toBeLessThan(60);
    await invoke({ action: "cancel", goal_id: revised.goalId });
    await waitForChainRun(engine, ending.chainId!);
  });

  it.each(["revise", "regenerate"])("can %s the frame from the storyboard review while preserving stale storyboards", async action => {
    const boards = await advance(await advance(await create(), "frame"), "storyboards");
    const updated = await invoke({ action: "update", goal_id: boards.goalId, revision: boards.revision, plan: { ...plan, frame: { prompt: "Both characters beside a red bench" } } });
    await pauseBookQueueForTests(bookId);
    const started = await invoke({ action, goal_id: updated.goalId, revision: updated.revision, stage: "frame", index: 0, feedback: "Move to the red bench" });
    expect(started).toMatchObject({ stage: "frame", status: "running" });
    expect(started.stages.storyboards!.outputs).toEqual(boards.stages.storyboards!.outputs);
    await invoke({ action: "cancel", goal_id: started.goalId });
    await waitForChainRun(engine, started.chainId!);
    await seedGoalStage(engine, started.goalId, "frame", action === "revise" ? { revise: { index: 0, feedback: "Move to the red bench" } } : {});
    const ready = await status(started.goalId);
    expect(ready).toMatchObject({ status: "review", stage: "storyboards" });
    expect(ready.stages.storyboards!.outputs.every(output => output.stale?.includes("older full frame"))).toBe(true);
  });

  it("rejects invalid revision feedback, stale approvals and nonexistent stills without enqueueing", async () => {
    const created = await create();
    expect((await raw({ action: "revise", goal_id: created.goalId, revision: created.revision, stage: "frame", index: 0, feedback: "Closer" })).isError).toBe(true);
    const frame = await advance(created, "frame");
    for (const extra of [{ feedback: "Use @a1" }, { feedback: " " }, { feedback: "x".repeat(301) }, { revision: frame.revision - 1 }, { index: 1 }, { stage: "storyboards", index: 1 }]) {
      expect((await raw({ action: "revise", goal_id: frame.goalId, revision: frame.revision, stage: "frame", index: 0, feedback: "Closer", ...extra })).isError).toBe(true);
    }
    expect(engine.jobs.queue.list()).toHaveLength(0);
    await invoke({ action: "cancel", goal_id: frame.goalId });
    expect((await raw({ action: "revise", goal_id: frame.goalId, revision: frame.revision, stage: "frame", index: 0, feedback: "Closer" })).isError).toBe(true);
  });

  it("prices, reviews and regenerates ending frames before submitting reference videos", async () => {
    const base = await create();
    const pairedPlan = { ...plan, frameContinuity: true };
    const paired = await create({ plan: pairedPlan });
    expect(paired.estimate.frame).toEqual(base.estimate.frame);
    expect(paired.estimate.storyboards.usd).toBeCloseTo(base.estimate.storyboards.usd! * 2);
    expect(paired.estimate.videos).toEqual(base.estimate.videos);
    const ready = await advance(await advance(paired, "frame"), "storyboards");
    expect(ready.stages.storyboards!.outputs).toHaveLength(6);
    expect((await raw({ action: "update", goal_id: ready.goalId, revision: ready.revision, plan })).isError).toBe(true);
    const updatedPlan = { ...pairedPlan, shots: pairedPlan.shots.map((shot, index) => index === 1 ? { ...shot, endingPrompt: "Both characters stop beside a fountain" } : shot) };
    const edited = await invoke({ action: "update", goal_id: ready.goalId, revision: ready.revision, plan: updatedPlan });
    expect((await raw({ action: "approve", goal_id: ready.goalId, revision: edited.revision })).content).toEqual([expect.objectContaining({ text: expect.stringContaining("Ending frame 2 was made from an older prompt") })]);
    await pauseBookQueueForTests(bookId);
    const regenerating = await invoke({ action: "regenerate", goal_id: ready.goalId, revision: edited.revision, shot_indexes: [1] });
    await expect.poll(() => getChainRun(engine, regenerating.chainId!)?.steps[0]?.childJobIds.length).toBe(1);
    expect(getChainRun(engine, regenerating.chainId!)!.steps.map(step => step.id)).toEqual(["storyboard2", "storyboard5"]);
    cancelChainRun(engine, regenerating.chainId!);
    await waitForChainRun(engine, regenerating.chainId!);
    await seedGoalStage(engine, ready.goalId, "storyboards", { indexes: [1] });
    const regenerated = await status(ready.goalId);
    expect(regenerated.stages.storyboards!.outputs).toHaveLength(6);
    for (const index of [0, 2, 3, 5]) expect(regenerated.stages.storyboards!.outputs[index]).toEqual(ready.stages.storyboards!.outputs[index]);
    const video = await approve(regenerated);
    await expect.poll(() => getChainRun(engine, video.chainId!)?.steps[0]?.childJobIds.length).toBe(1);
    const step = getChainRun(engine, video.chainId!)!.steps[0]!;
    expect(step.pins.map(pin => pin.field)).toEqual(["image_refs", "image_refs"]);
    const job = engine.jobs.queue.list({ type: "generate_seedance25_video" })[0]!;
    expect(job.payload).toMatchObject({ imageInputs: [{ assetId: regenerated.stages.storyboards!.outputs[0]!.artifactId }, { assetId: regenerated.stages.storyboards!.outputs[3]!.artifactId }] });
    expect(job.payload.firstFrame).toBeUndefined();
    expect(job.payload.lastFrame).toBeUndefined();
    await invoke({ action: "cancel", goal_id: ready.goalId });
    await waitForChainRun(engine, video.chainId!);
  });

  it("persists planning failures, retries planning, and stops a removed goal", async () => {
    const failed = await invoke({ action: "create", brief });
    await expect.poll(async () => (await status(failed.goalId)).status).toBe("failed");
    expect((await status(failed.goalId)).error).toContain("placeholder");
    await pauseBookQueueForTests(bookId);
    const retried = await invoke({ action: "retry", goal_id: failed.goalId });
    expect(retried).toMatchObject({ status: "planning", stage: "frame", error: null });
    expect(retried.planningJobId).not.toBe(failed.planningJobId);
    expect(engine.jobs.queue.list({ type: "generate_gpt_image_2_5" })).toHaveLength(0);
    expect(engine.jobs.queue.list({ type: "generate_seedance25_video" })).toHaveLength(0);
    await engine.notebooks.removeCell(notebookId, retried.cellId);
    expect((await invoke<{ goals: GoalSnapshot[] }>({ action: "list" })).goals).toHaveLength(0);
    expect(readGoal(engine, retried.goalId).status).toBe("cancelled");
    expect(engine.jobs.queue.get(retried.planningJobId!)?.state).toBe("aborted");
    expect(notebook().edges.some(edge => edge.target === retried.cellId)).toBe(false);
  });

  it("retries the failed stage without repeating its completed frames", async () => {
    const ready = await advance(await create(), "frame");
    await seedGoalStage(engine, ready.goalId, "storyboards", { failedIndex: 1 });
    const failed = await status(ready.goalId);
    expect(failed.status).toBe("failed");
    const first = failed.stages.storyboards!.outputs[0]!;
    await pauseBookQueueForTests(bookId);
    const retried = await invoke({ action: "retry", goal_id: ready.goalId });
    expect(retried.chainId).toBe(failed.chainId);
    await expect.poll(() => getChainRun(engine, retried.chainId!)?.steps[1]?.childJobIds.length).toBe(1);
    expect(getChainRun(engine, retried.chainId!)?.steps[0]).toMatchObject({ status: "completed", outputs: { asset_id: first.artifactId } });
    expect(engine.jobs.queue.list({ type: "generate_gpt_image_2_5" })).toHaveLength(1);
    await invoke({ action: "cancel", goal_id: ready.goalId });
    await waitForChainRun(engine, retried.chainId!);
  });

  it("finishes a single clip without assembly and appends multiple clips idempotently", async () => {
    const single = await advance(await advance(await create({ plan: goalTestPlan(1), brief: "@a1 @a2 one clip" }), "frame"), "storyboards");
    const ids = [await goalTestVideo(engine, root, "red"), await goalTestVideo(engine, root, "green"), await goalTestVideo(engine, root, "blue")];
    const singleChain = await seedGoalStage(engine, single.goalId, "videos", { videoIds: [ids[0]!] });
    expect(getChainRun(engine, singleChain)?.steps).toHaveLength(1);
    expect(await status(single.goalId)).toMatchObject({ status: "completed", assembly: null });
    expect(engine.sequences.getPrimary().clips).toHaveLength(0);
    const multi = await advance(await advance(await create(), "frame"), "storyboards");
    await seedGoalStage(engine, multi.goalId, "videos", { videoIds: ids });
    const assembled = await invoke({ action: "assemble", goal_id: multi.goalId });
    expect(assembled.status).toBe("completed");
    const clips = engine.sequences.getPrimary().clips;
    expect(clips.map(clip => clip.source.artifactId)).toEqual(ids);
    expect(clips.map(clip => clip.timelineStartFrame)).toEqual([0, 120, 240]);
    expect(clips.every(clip => "audioPolicy" in clip && clip.audioPolicy === "preserve-pitch" && clip.audio?.muted === false)).toBe(true);
    await invoke({ action: "assemble", goal_id: multi.goalId });
    expect(engine.sequences.getPrimary().clips).toEqual(clips);
    const trackId = readGoal(engine, multi.goalId).trackId!;
    await engine.sequences.updateTrack(trackId, { locked: true });
    await expect(appendGoalClips(engine, { ...readGoal(engine, multi.goalId), goalId: uuidv7(), assembly: null, clipIds: ids.map(() => uuidv7()) }, ids)).rejects.toThrow("no longer editable");
  });

  it("combines three completed clips locally with sound, exact duration and one idempotent output", async () => {
    const goal = await create();
    await advance(goal, "frame");
    await advance(goal, "storyboards");
    const videoIds = await Promise.all(["red", "blue", "green"].map(color => goalTestVideo(engine, root, color)));
    await seedGoalStage(engine, goal.goalId, "videos", { videoIds });
    const completed = await invoke({ action: "assemble", goal_id: goal.goalId });
    expect(completed.status).toBe("completed");
    await pauseBookQueueForTests(bookId);
    const interrupted = await invoke({ action: "combine", goal_id: goal.goalId });
    await engine.jobs.queue.abort(interrupted.combined!.jobId!, "Interrupted before combining");
    const failed = await status(goal.goalId);
    expect(failed.combined).toMatchObject({ status: "failed", error: "Interrupted before combining" });
    expect(notebook().cells.find(cell => cell.id === failed.combined!.cellId)?.inputs?.state).toBe("error");
    await stopBookQueue(bookId);
    const combining = await invoke({ action: "combine", goal_id: goal.goalId });
    expect((await invoke({ action: "combine", goal_id: goal.goalId })).combined?.artifactId).toBe(combining.combined!.artifactId);
    await expect.poll(async () => (await invoke({ action: "status", goal_id: goal.goalId })).combined?.status, { timeout: 20_000 }).toBe("completed");
    const combined = (await invoke({ action: "status", goal_id: goal.goalId })).combined!;
    const manifest = await engine.files.manifest(combined.artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const probe = await probeVideo(join(manifest.value.path, "original.mp4"));
    expect(probe.hasAudio).toBe(true);
    expect(Math.abs(probe.videoDuration - 12)).toBeLessThanOrEqual(0.2);
    expect(notebook().edges.filter(edge => edge.target === combined.cellId).map(edge => edge.targetInput)).toEqual(["video", "video_2", "video_3"]);
    expect((await invoke({ action: "combine", goal_id: goal.goalId })).combined).toEqual(combined);
    expect(engine.jobs.queue.list({ type: "combine_goal" })).toHaveLength(2);
  });

  it("keeps legacy goals readable, cancels active legacy runs once, and refuses paid continuation", async () => {
    const modern = await create();
    await seedGoalStage(engine, modern.goalId, "frame", { failedIndex: 0 });
    const stored = readGoal(engine, modern.goalId);
    const legacyPlan = { title: plan.title, continuity: plan.continuity, aspectRatio: plan.aspectRatio, shots: plan.shots.map(shot => ({ title: shot.title, prompt: shot.videoPrompt, durationSeconds: shot.durationSeconds })) };
    const document = notebook();
    await engine.notebooks.write({ ...document, cells: document.cells.map(cell => cell.id === stored.cellId ? { ...cell, inputs: { goalId: stored.goalId, revision: 1, plan: legacyPlan, estimate: { usd: 3, warnings: [] } } } : cell) });
    engine.settings.set("application.goals.v2", {});
    const { planVersion: _planVersion, stage: _stage, stages: _stages, ...legacy } = stored;
    engine.settings.set("application.goals.v1", { [legacy.goalId]: { ...legacy, status: "running" } });
    const before = engine.settings.get("application.goals.v1");
    const failed = await status(legacy.goalId);
    expect(failed).toMatchObject({ planVersion: 1, status: "failed", error: LEGACY_GOAL_MESSAGE, plan: legacyPlan });
    expect(engine.settings.get("application.goals.v1")).toEqual(before);
    expect((await status(legacy.goalId)).updatedAt).toBe(failed.updatedAt);
    for (const action of ["approve", "regenerate", "update", "retry"]) expect((await raw({ action, goal_id: legacy.goalId, revision: 1, plan })).isError).toBe(true);
    expect((await invoke({ action: "dismiss", goal_id: legacy.goalId })).dismissedAt).toBeTruthy();
    const complete = { ...readGoal(engine, legacy.goalId), status: "completed" as const, assembly: { sequenceId: uuidv7(), startFrame: 0, durationFrames: 900 }, dismissedAt: null };
    saveGoal(engine, complete);
    expect((await invoke<{ goals: GoalSnapshot[] }>({ action: "list" })).goals[0]).toMatchObject({ planVersion: 1, status: "completed", assembly: complete.assembly });
  });

  it("rejects cross-notebook access, missing revisions and premature assembly", async () => {
    const goal = await create();
    const other = await engine.notebooks.create("Other");
    if (!other.ok) throw new Error(other.error.message);
    expect((await raw({ action: "status", goal_id: goal.goalId, notebook_id: other.value.id })).isError).toBe(true);
    expect((await raw({ action: "approve", goal_id: goal.goalId })).isError).toBe(true);
    expect((await raw({ action: "assemble", goal_id: goal.goalId })).isError).toBe(true);
    expect((await raw({ action: "dismiss", goal_id: goal.goalId })).isError).toBe(true);
  });
});
