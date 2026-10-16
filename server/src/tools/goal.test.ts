import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { Client } from "@modelcontextprotocol/client";
import { findPrimaryMediaFile, MVP_CONTRACT_VERSION, type Engine, type EditIntent } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { createEngineForTest } from "../engine.js";
import { createTestClient } from "../test-client.js";
import { pauseBookQueueForTests, resumeBookQueueForTests, stopBookQueue } from "../queue.js";
import { cancelChainRun, getChainRun, resumeOpenChains, waitForChainRun } from "../chain-executor.js";
import { copyVideoFixture } from "../test-media-fixtures.js";
import { compileFrameSteps, compileGoalV3Steps, compileStoryboardSteps, compileVideoSteps, compileReviseStillStep, goalBriefConstraints, goalPlanSchema, goalPlannerResponseSchema, goalPromptBudgetIssues, goalPromptWords, goalStillPrompt, GOAL_PROMPT_BUDGET, GOAL_VIDEO_MODEL, GOAL_VIDEO_TOOL } from "../goal-plan.js";
import { resolveModel } from "../media/descriptor.js";
import { buildWireRequest } from "../media/request.js";
import { readGoal, saveGoal } from "../goal-store.js";
import { goalPlannerBrief } from "../goal-characters.js";
import { GOAL_STYLE_IDS, goalBriefStyle, goalStyleFragment, resolveGoalStyleOptions } from "../goal-styles.js";
import { LEGACY_GOAL_MESSAGE } from "../goal-state.js";
import { appendGoalClips } from "../jobs/assemble-goal.js";
import { goalTestCharacters, goalTestPlan, goalTestSimplePlan, goalTestVideo, seedGoalStage } from "../test-goals.js";
import { goalPlannerImages } from "../goal-reference-images.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { saveWatermarkProfile } from "../watermark-config.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import type { GoalSnapshot } from "./goal.js";

const SUNBURST_EDIT_MODEL = "kie:gpt-image-2-5-sunburst-image-to-image";
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
    expect(goalBriefConstraints("Two portrait 4s clips")).toEqual({ shotCount: 2, durationSeconds: 4, aspectRatio: "9:16" });
    expect(goalBriefConstraints("two funny 4-second vertical clips")).toEqual({ shotCount: 2, durationSeconds: 4, aspectRatio: "9:16" });
    expect(goalBriefConstraints("2 landscape 8s shots")).toEqual({ shotCount: 1, durationSeconds: 8, aspectRatio: "16:9" });
    expect(goalBriefConstraints("four square 6-second scenes")).toEqual({ shotCount: 1, durationSeconds: 6, aspectRatio: "1:1" });
    expect(goalBriefConstraints("two portrait characters, 4s clips")).toEqual({ shotCount: 1, durationSeconds: 4, aspectRatio: "9:16" });
    expect(goalBriefConstraints("four 8-second clips, portrait")).toEqual({ shotCount: 4, durationSeconds: 8, aspectRatio: "9:16" });
    expect(goalBriefConstraints("2 x 12s, square")).toEqual({ shotCount: 2, durationSeconds: 12, aspectRatio: "1:1" });
    expect(goalBriefConstraints("@a1 @a2 as Mr Bean in Thailand")).toEqual({ shotCount: 1, durationSeconds: 20, aspectRatio: "9:16" });
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
    expect(frame[0]).toMatchObject({ id: "frame", tool: "generate_image", params: { model: SUNBURST_EDIT_MODEL, refs: { image: ["@a1", "@a2"] }, options: { resolution: "2K" } } });
    expect(frame[0]!.params.prompt).toContain("@image1 Character 1");
    const storyboards = compileStoryboardSteps(plan, characters, "@b2");
    expect(storyboards).toHaveLength(3);
    expect(storyboards[1]).toMatchObject({ id: "storyboard2", params: { refs: { image: ["@b2", "@a1", "@a2"] } } });
    expect(storyboards[1]!.params.prompt).toContain("@image1 full frame: keep clothes, props");
    expect(storyboards[1]!.params.prompt).toContain("@image2 Character 1");
    expect(storyboards[1]!.params.prompt).toContain("2x2 storyboard");
    expect(storyboards[1]!.params.prompt).toContain("setup; action; reaction; ending");
    expect(storyboards[1]!.params.prompt).toContain("Below pictures: timing + action/camera notes");
    expect(storyboards[1]!.params.prompt).toContain("Times: 0–2.5s; 2.5–5s; 5–7.5s; 7.5–10s");
    expect(storyboards[1]!.params.prompt).toContain("Pictures text-free");
    expect(storyboards[1]!.params.prompt).toContain(plan.shots[1]!.videoPrompt);
    expect(storyboards[1]!.params.prompt).toContain("Each 9:16");
    expect(compileStoryboardSteps(plan, characters, "@b2", [1]).map(step => step.id)).toEqual(["storyboard2"]);
    const videos = compileVideoSteps(uuidv7(), plan, ["@c1", "@c2", "@c3"]);
    expect(videos).toHaveLength(4);
    expect(videos[1]).toMatchObject({ id: "shot2", tool: GOAL_VIDEO_TOOL, params: { model: GOAL_VIDEO_MODEL, refs: { image: ["@c2"] }, mode: "r2v", options: { duration: 10, aspect_ratio: "9:16", resolution: "720p", generate_audio: true } } });
    expect(videos[1]!.params.refs).toEqual({ image: ["@c2"] });
    expect(videos[1]!.params.prompt).toContain("@image1 storyboard");
    expect(videos[1]!.params.prompt).toContain("Four beats in order, 2.5s each");
    expect(videos[1]!.params.prompt).toContain("No grid, borders, notes, text");
    expect(videos[1]!.params.prompt).toContain("No music.");
    const shotRequest = buildWireRequest(resolveModel(GOAL_VIDEO_MODEL), {
      prompt: String(videos[1]!.params.prompt),
      refUrls: { image: ["https://example.test/storyboard.png"] },
      mode: String(videos[1]!.params.mode),
      options: videos[1]!.params.options as Record<string, unknown>,
    });
    expect(shotRequest).toMatchObject({ ok: true, request: { input: { aspect_ratio: "9:16" } } });
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
    expect(steps[3]!.params.prompt).toContain("@image1 full frame: keep clothes, props");
    expect(steps[3]!.params.prompt).not.toContain(plan.shots[1]!.storyboardPrompt);
    expect(steps[3]!.params.prompt).not.toContain(plan.continuity);
    expect(compileStoryboardSteps(paired, characters, "@b2", [1]).map(step => step.id)).toEqual(["storyboard2", "storyboard5"]);
    expect(() => compileVideoSteps(uuidv7(), paired, ["@c1", "@c2", "@c3"])).toThrow("ending frame");
    const videos = compileVideoSteps(uuidv7(), paired, ["@c1", "@c2", "@c3"], ["@d1", "@d2", "@d3"]);
    expect(videos[1]!.params.refs).toEqual({ image: ["@c2", "@d2"] });
    expect(videos[1]!.params.prompt).toContain("@image2 ending pose");
    expect(steps[3]!.params.prompt).not.toContain("four-panel");
  });

  it.each([{ seconds: 4, beat: "1s" }, { seconds: 10, beat: "2.5s" }, { seconds: 30, beat: "7.5s" }])("paces four storyboard beats within $seconds seconds", ({ seconds, beat }) => {
    const timed = { ...plan, shots: [{ ...plan.shots[0]!, durationSeconds: seconds }] };
    const [video] = compileVideoSteps(uuidv7(), timed, ["@c1"]);
    expect(video!.params.prompt).toContain(`Four beats in order, ${beat} each`);
    for (const step of [compileStoryboardSteps(timed, characters, "@b1")[0]!, compileReviseStillStep(timed, characters, "storyboards", 0, "@b2", "Raise chin", "@b1")]) {
      expect(step.params.prompt).toContain(`Times: 0–${beat};`);
      expect(step.params.prompt).toContain(`${seconds * 0.75}–${seconds}s`);
      expect(step.params.prompt).toContain("action/camera notes");
    }
  });

  it.each(["9:16", "16:9", "1:1"] as const)("keeps the four-panel contract when revising %s storyboards, including old single frames", aspectRatio => {
    const revised = compileReviseStillStep({ ...plan, aspectRatio }, characters, "storyboards", 1, "@c2", "Raise the umbrella", "@b2");
    expect(revised.params.refs).toEqual({ image: ["@c2", "@b2", "@a1", "@a2"] });
    expect(revised.params.prompt).toContain("2x2 storyboard");
    expect(revised.params.prompt).toContain("Below pictures: timing + action/camera notes");
    expect(revised.params.prompt).toContain("Pictures text-free");
    expect(revised.params.prompt).toContain(`Each ${aspectRatio}`);
    expect(revised.params.prompt).toContain("Four distinct moments");
    expect(revised.params.prompt).toContain(plan.shots[1]!.videoPrompt);
    expect(revised.params.prompt).toContain("Change @image1: Raise the umbrella");
    expect(revised.params.prompt).toContain("@image2: full frame; @image3: Character 1");
  });

  it("budgets planner prompts without rejecting longer saved plans", () => {
    expect(goalPromptBudgetIssues(plan)).toEqual([]);
    expect(goalPlannerResponseSchema.parse(plan)).toEqual({ ...plan, storyboardLayout: "six-panel", referenceRoles: [] });
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
      expect(step.params.options).toMatchObject({ aspect_ratio: "9:16" });
      expect(step.tool).toBe(stage === "video" ? GOAL_VIDEO_TOOL : "generate_image");
      expect(step.params.model).toBe(stage === "video" ? GOAL_VIDEO_MODEL : SUNBURST_EDIT_MODEL);
    }
    expect(String(steps[4][0].params.prompt)).toMatch(/@image1 storyboard.*hyper-realistic.*@image2 ending pose.*No grid, borders, notes, text\. No music\.$/su);
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
      steps.forEach((step, index) => {
        const prompt = String(step.params.prompt);
        const fragment = goalStyleFragment(saved.style, key === "video" ? "video" : "frame");
        expect(prompt).toContain(fragment);
        expect(goalPromptWords(prompt.replace(fragment, ""))).toBeLessThan(goalPromptWords(previous.prompts[key]![index]!));
      });
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
  const mediaJobs = (model: string) => engine.jobs.queue.list({ type: "generate_media" }).filter(job => job.payload.model === model);
  const textOf = (result: { content?: unknown }) => (result.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
  function providerJob(artifactId: string) {
    const job = engine.jobs.queue.list().find(item => item.artifactId === artifactId && item.type.startsWith("generate_"));
    if (!job) {
      const seen = engine.jobs.queue.list().map(item => `${item.type}:${item.state}:${item.artifactId ?? ""}`).join(", ");
      throw new Error(`missing provider job for ${artifactId}; queued=[${seen}]`);
    }
    return job;
  }
  async function completeProviderJob(artifactId: string): Promise<void> {
    const job = providerJob(artifactId);
    let current = job;
    if (current.state === "queued") {
      let leased = engine.jobs.queue.dequeue(process.pid, 60_000);
      while (leased?.type === "process_image") {
        await engine.jobs.queue.complete(leased.id, { result: { settled: true } });
        leased = engine.jobs.queue.dequeue(process.pid, 60_000);
      }
      if (!leased || leased.id !== job.id) throw new Error(`leased ${leased?.type ?? "nothing"} instead of ${job.type}`);
      current = leased;
    }
    const completed = await engine.jobs.queue.complete(current.id, { result: { settled: true } });
    if (!completed) throw new Error(`could not complete ${job.type} from ${current.state}`);
  }
  async function settleChain(chainId: string, kind: "image" | "video"): Promise<string> {
    await expect.poll(() => {
      const step = getChainRun(engine, chainId)?.steps[0];
      const artifactId = step?.outputs?.asset_id;
      return step?.status === "running" && typeof artifactId === "string" && step.childJobIds.length > 0;
    }, { timeout: 15_000 }).toBe(true);
    const step = getChainRun(engine, chainId)!.steps[0]!;
    const artifactId = String(step.outputs?.asset_id);
    if (kind === "image") {
      const written = await engine.files.write(artifactId, "original.jpg", await sharp({ create: { width: 96, height: 54, channels: 3, background: "#cf593b" } }).jpeg().toBuffer());
      if (!written.ok) throw new Error(written.error.message);
    } else {
      const path = join(root, `${artifactId}.mp4`);
      await copyVideoFixture({ width: 160, height: 90, durationSec: 4, fps: 12, source: "color", color: "blue", audio: { frequency: 440 } }, path);
      const written = await engine.files.writeFromPath(artifactId, "original.mp4", path);
      if (!written.ok) throw new Error(written.error.message);
      await registerMediaProbe(engine, artifactId, "original.mp4", await probeVideo(path));
    }
    await completeProviderJob(artifactId);
    await expect.poll(() => engine.jobs.queue.list().some(job => job.type === "await_notebook_output" && job.payload.providerArtifactId === artifactId), { timeout: 15_000 }).toBe(true);
    await resumeBookQueueForTests(bookId);
    await expect.poll(() => getChainRun(engine, chainId)?.status, { timeout: 20_000 }).toBe("completed");
    await pauseBookQueueForTests(bookId);
    return artifactId;
  }

  it("resolves adjacent image mentions, saves character edges and per-stage estimates, and fences invalid inputs", async () => {
    const goal = await create({ request_id: "same-request" });
    expect(goal).toMatchObject({ planVersion: 2, stage: "frame", status: "review", revision: 1, address: "@b1", plan });
    expect(goal.characters.map(character => character.artifactId)).toEqual(imageIds);
    expect(notebook().edges.filter(edge => edge.target === goal.cellId).map(edge => edge.targetInput)).toEqual(["character", "character_2"]);
    const { still: _still, ...stageEstimates } = goal.estimate;
    expect(notebook().cells.find(cell => cell.id === goal.cellId)?.inputs).toMatchObject({ characters: goal.characters, plan, estimate: stageEstimates });
    expect(goal.estimate.frame.usd).toBeGreaterThan(0);
    expect(goal.estimate.total.usd).toBeCloseTo(goal.estimate.frame.usd! + goal.estimate.storyboards.usd! + goal.estimate.videos.usd!);
    expect((await create({ request_id: "same-request" })).goalId).toBe(goal.goalId);
    expect(engine.jobs.queue.list()).toHaveLength(0);
    expect((await raw({ action: "create", brief: "A dog rides a skateboard", plan })).content).toEqual([expect.objectContaining({ text: expect.stringContaining("Mention the reference images") })]);
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
    const jobs = mediaJobs(SUNBURST_EDIT_MODEL);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ refs: { image: imageIds }, options: { resolution: "2K", aspect_ratio: "9:16" } });
    expect(mediaJobs(GOAL_VIDEO_MODEL)).toHaveLength(0);
    await expect.poll(() => notebook().cells.some(cell => cell.inputs?.chainRunId === `${started.chainId}:frame`)).toBe(true);
    const producer = notebook().cells.find(cell => cell.inputs?.chainRunId === `${started.chainId}:frame`)!;
    expect(producer).toMatchObject({ type: "generate_image", tool: "generate_image", model: SUNBURST_EDIT_MODEL, inputs: { generationSettings: { resolution: "2K", aspect_ratio: "9:16" } } });
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

  it("keeps a new goal on the lightning plan and lets an explicit plan override brief keywords", async () => {
    const styledBrief = "@a1 as an IG influencer, GRWM morning routine";
    const created = await invoke({ action: "create", brief: styledBrief });
    expect(created).toMatchObject({ status: "review", planVersion: 3 });
    expect(created.plan).toMatchObject({ version: 3, aspectRatio: "16:9", video: { durationSeconds: 13 } });
    expect(created).not.toHaveProperty("requestedStyle");
    expect(notebook().cells.find(cell => cell.id === created.cellId)!.inputs).not.toHaveProperty("requestedStyle");
    const explicit = await create({ brief: styledBrief });
    expect(explicit.plan).toMatchObject({ style: { id: "cinematic", options: {} } });
    expect(explicit).not.toHaveProperty("requestedStyle");
  });

  it("rejects row overflow before accepting paid generation even when individual slots remain", async () => {
    const goal = await create();
    const document = notebook();
    const generators = Array.from({ length: 5 }, (_, index) => engine.notebooks.createCell({ type: "generate_image", slot: { row: 0, column: index + 3 } }));
    const videos = Array.from({ length: 488 }, (_, index) => engine.notebooks.createCell({ type: "video", slot: { row: 2 + Math.floor(index / 8), column: index % 8 } }));
    const timeline = engine.notebooks.createCell({ type: "timeline", slot: { row: 63, column: 0 } });
    const filled = { ...document, cells: [...document.cells, ...generators, ...videos, timeline] };
    const written = await engine.notebooks.write(filled);
    expect(written.ok, written.ok ? undefined : written.error.message).toBe(true);
    const before = notebook();
    const jobs = engine.jobs.queue.list();
    const result = await raw({ action: "approve", goal_id: goal.goalId, revision: goal.revision });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining("65 rows") })]);
    expect(engine.jobs.queue.list()).toEqual(jobs);
    expect(notebook().cells).toEqual(before.cells);
    expect((await status(goal.goalId)).status).toBe("review");
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
    expect(chain.steps[0]!.pins.find(pin => pin.field === "refs.image")?.artifactId).toBe(ready.stages.storyboards!.outputs[0]!.artifactId);
    expect(chain.steps[0]!.pins.map(pin => pin.field)).toEqual(["refs.image"]);
    const payload = mediaJobs(GOAL_VIDEO_MODEL)[0]!.payload;
    expect(payload).toMatchObject({ mode: "r2v", options: { aspect_ratio: "9:16" } });
    expect(payload.refs).toEqual({ image: [ready.stages.storyboards!.outputs[0]!.artifactId] });
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
    for (const index of [0, 2]) {
      const output = before[index]!;
      const address = notebookGridTag(notebook().cells.find(cell => cell.id === output.cellId)!.slot);
      expect(after.stages.storyboards!.outputs[index]).toEqual({ ...output, address, versions: output.versions.map(version => ({ ...version, address })) });
    }
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
    expect(getChainRun(engine, regenerate.chainId!)?.steps[0]?.pins[0]).toMatchObject({
      address: notebookGridTag(notebook().cells.find(cell => cell.id === ready.characters[0]!.cellId)!.slot),
      cellId: ready.characters[0]!.cellId, artifactId: imageIds[0],
    });
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
    expect(getChainRun(engine, boards.chainId!)!.steps[0]!.params.refs).toEqual({ image: [first.stages.frame!.outputs[0]!.address, ...selected.characters.map(character => character.address)] });
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
    expect(mediaJobs(GOAL_VIDEO_MODEL)).toHaveLength(0);
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
    expect(mediaJobs(GOAL_VIDEO_MODEL)).toHaveLength(0);
  });

  it("revises the selected frame with ordered references and returns to its review when stopped", async () => {
    const frame = await advance(await create(), "frame");
    const original = frame.stages.frame!.outputs[0]!;
    await pauseBookQueueForTests(bookId);
    const revised = await invoke({ action: "revise", goal_id: frame.goalId, revision: frame.revision, stage: "frame", index: 0, feedback: "Give Character 1 a red cap" });
    await expect.poll(() => getChainRun(engine, revised.chainId!)?.steps[0]?.childJobIds.length).toBe(1);
    const step = getChainRun(engine, revised.chainId!)!.steps[0]!;
    const job = mediaJobs(SUNBURST_EDIT_MODEL)[0]!;
    expect(job.payload).toMatchObject({ refs: { image: [original.artifactId, ...imageIds] }, prompt: expect.stringContaining("Change @image1: Give Character 1 a red cap"), options: { aspect_ratio: "9:16", resolution: "2K", background: "opaque" } });
    expect(step.params.prompt).toContain("@image2: Character 1");
    expect(revised.stages.frame!.attempts!.at(-1)).toMatchObject({ feedback: "Give Character 1 a red cap", parentArtifactId: original.artifactId, basePrompt: plan.frame.prompt });
    expect(revised.estimate.still).toEqual(frame.estimate.frame);
    expect(revised.resumeStage).toBe("storyboards");
    const stopped = await invoke({ action: "cancel", goal_id: frame.goalId });
    await waitForChainRun(engine, revised.chainId!);
    expect(stopped).toMatchObject({ status: "review", stage: "storyboards", chainId: frame.chainId, resumeStage: null });
    expect(stopped.stages.frame!.outputs[0]!.artifactId).toBe(original.artifactId);
    expect(stopped.stages.frame!.outputs[0]!.versions).toHaveLength(2);
    expect(stopped.stages.frame!.attempts!.map(attempt => attempt.chainId)).toEqual([frame.chainId, revised.chainId]);
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
    expect(started.stages.storyboards!.outputs.map(output => output.artifactId)).toEqual(boards.stages.storyboards!.outputs.map(output => output.artifactId));
    expect(started.stages.storyboards!.outputs.every(output => output.stale)).toBe(true);
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
    expect(step.pins.map(pin => pin.field)).toEqual(["refs.image", "refs.image"]);
    const job = mediaJobs(GOAL_VIDEO_MODEL)[0]!;
    expect(job.payload.refs).toEqual({ image: [regenerated.stages.storyboards!.outputs[0]!.artifactId, regenerated.stages.storyboards!.outputs[3]!.artifactId] });
    await invoke({ action: "cancel", goal_id: ready.goalId });
    await waitForChainRun(engine, video.chainId!);
  });

  it("persists planning failures, retries planning, and stops a removed goal", async () => {
    const seeded = await create();
    saveGoal(engine, { ...readGoal(engine, seeded.goalId), status: "failed", chainId: null, error: "placeholder key" });
    await pauseBookQueueForTests(bookId);
    const retried = await invoke({ action: "retry", goal_id: seeded.goalId });
    expect(retried).toMatchObject({ status: "planning", stage: "frame", error: null, planVersion: 2 });
    expect(retried.planningJobId).toBeTruthy();
    expect(retried.planningJobId).not.toBe(seeded.planningJobId);
    expect(mediaJobs(SUNBURST_EDIT_MODEL)).toHaveLength(0);
    expect(mediaJobs(GOAL_VIDEO_MODEL)).toHaveLength(0);
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
    expect(mediaJobs(SUNBURST_EDIT_MODEL)).toHaveLength(1);
    await invoke({ action: "cancel", goal_id: ready.goalId });
    await waitForChainRun(engine, retried.chainId!);
  });

  it("rejects retrying a failed storyboard after selecting a different scene version", async () => {
    const first = await advance(await create({ plan: goalTestSimplePlan() }), "frame");
    const second = await advance(first, "frame");
    await seedGoalStage(engine, second.goalId, "storyboards", { failedIndex: 0 });
    expect((await status(second.goalId)).status).toBe("failed");
    await invoke({ action: "select", goal_id: second.goalId, stage: "frame", index: 0, artifact_id: first.stages.frame!.outputs[0]!.artifactId });
    const rejected = await raw({ action: "retry", goal_id: second.goalId });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.content)).toContain("selected versions changed");
    expect(engine.jobs.queue.list()).toHaveLength(0);
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

  it("plans from real reference pixels and compiles a 20-second six-panel video with scene and supporting references", async () => {
    const simple = goalTestSimplePlan();
    const created = await create({ brief: "@a1 @a2 interview", plan: simple });
    const images = await goalPlannerImages(engine, created.characters);
    expect(images.filter(item => item.type === "input_text").map(item => item.text)).toEqual(["Reference 1: Character 1", "Reference 2: Character 2"]);
    expect(images.filter(item => item.type === "input_image").every(item => item.image_url.startsWith("data:image/png;base64,iVBOR"))).toBe(true);
    expect(compileFrameSteps(simple, created.characters)[0]).toMatchObject({ tool: "generate_image", params: { model: "kie:nano-banana-2-1" } });
    const frame = await advance(created, "frame");
    const boards = await advance(frame, "storyboards");
    const storyboard = getChainRun(engine, boards.stages.storyboards!.chainId)!.steps[0]!;
    expect(storyboard.params.prompt).toContain("2 columns by 3 rows, six-panel");
    expect(storyboard.params.prompt).toContain("16.7–20s");
    expect(storyboard.params.prompt).not.toContain(simple.shots[0]!.videoPrompt);
    expect(storyboard.params.prompt).toContain("Reference 1 (scene)");
    await pauseBookQueueForTests(bookId);
    const videos = await approve(boards);
    const steps = getChainRun(engine, videos.chainId!)!.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.pins.map(pin => pin.artifactId)).toEqual([boards.stages.storyboards!.outputs[0]!.artifactId, frame.stages.frame!.outputs[0]!.artifactId, ...imageIds]);
    expect(steps[0]!.params).toMatchObject({ model: GOAL_VIDEO_MODEL, mode: "r2v", options: { duration: 20, aspect_ratio: "9:16", generate_audio: true, resolution: "720p" } });
    expect(steps[0]!.params.refs).not.toHaveProperty("first_frame");
    expect(steps[0]!.params.prompt).toContain("Six beats in reading order");
    expect(engine.sequences.getPrimary().clips).toHaveLength(0);
    await invoke({ action: "cancel", goal_id: created.goalId });
    await waitForChainRun(engine, videos.chainId!);
  });

  it("keeps completed video versions, revises only video directions, and restores the selected clip when stopped", async () => {
    const simple = goalTestSimplePlan();
    const boards = await advance(await advance(await create({ plan: simple }), "frame"), "storyboards");
    const original = await goalTestVideo(engine, root, "red");
    await seedGoalStage(engine, boards.goalId, "videos", { videoIds: [original] });
    const completed = await status(boards.goalId);
    expect(completed.status).toBe("completed");
    const updatedPlan = { ...simple, shots: simple.shots.map(shot => ({ ...shot, videoPrompt: "Quicker gestures; waves and laughter." })) };
    const updated = await invoke({ action: "update", goal_id: completed.goalId, revision: completed.revision, plan: updatedPlan });
    expect(updated.stages.storyboards!.outputs[0]!.stale).toBeNull();
    expect(updated.stages.videos!.outputs[0]!.stale).toBeTruthy();
    await pauseBookQueueForTests(bookId);
    const running = await invoke({ action: "revise", goal_id: completed.goalId, revision: updated.revision, stage: "videos", index: 0, feedback: "Hold the final reaction longer" });
    const step = getChainRun(engine, running.chainId!)!.steps[0]!;
    expect(step.params.prompt).toContain("Quicker gestures");
    expect(step.params.prompt).toContain("Hold the final reaction longer");
    expect(step.pins.some(pin => pin.artifactId === original)).toBe(false);
    expect(running.stages.videos!.outputs[0]!.artifactId).toBe(original);
    const stopped = await invoke({ action: "cancel", goal_id: completed.goalId });
    await waitForChainRun(engine, running.chainId!);
    expect(stopped).toMatchObject({ status: "completed", stage: "videos", clipIds: completed.clipIds });
    expect(stopped.stages.videos!.outputs[0]!.artifactId).toBe(original);
    expect(stopped.stages.videos!.attempts).toHaveLength(2);
    const revised = await goalTestVideo(engine, root, "blue");
    await seedGoalStage(engine, completed.goalId, "videos", { videoIds: [revised], revise: { index: 0, feedback: "Hold the final reaction longer" } });
    const ready = await status(completed.goalId);
    expect(ready).toMatchObject({ status: "completed", assembly: null });
    expect(ready.stages.videos!.outputs[0]!.stale).toBeNull();
    const selected = await invoke({ action: "select", goal_id: completed.goalId, revision: ready.revision, stage: "videos", index: 0, artifact_id: original });
    expect(selected.stages.videos!.outputs[0]!.artifactId).toBe(original);
    expect(selected.stages.videos!.outputs[0]!.versions.filter(version => version.artifactId)).toHaveLength(2);
  });

  it("marks dependencies stale for source pixels, image settings and selected scene changes without spending downstream", async () => {
    const simple = goalTestSimplePlan();
    const boards = await advance(await advance(await create({ plan: simple }), "frame"), "storyboards");
    const updated = await invoke({ action: "update", goal_id: boards.goalId, revision: boards.revision, plan: { ...simple, imageResolution: "1K" } });
    expect(updated.stages.frame!.outputs[0]!.stale).toBeTruthy();
    expect(updated.stages.storyboards!.outputs[0]!.stale).toBeTruthy();
    expect((await raw({ action: "approve", goal_id: boards.goalId, revision: updated.revision })).isError).toBe(true);
    const restored = await invoke({ action: "update", goal_id: boards.goalId, revision: updated.revision, plan: simple });
    expect(restored.stages.storyboards!.outputs[0]!.stale).toBeNull();
    await seedGoalStage(engine, boards.goalId, "frame", { revise: { index: 0, feedback: "Bigger microphone" } });
    const revised = await status(boards.goalId);
    expect(revised.stage).toBe("videos");
    expect(revised.stages.frame!.outputs[0]!.stale).toBeNull();
    expect(revised.stages.storyboards!.outputs[0]!.stale).toBeTruthy();
    const selected = await invoke({ action: "select", goal_id: boards.goalId, stage: "frame", index: 0, artifact_id: boards.stages.frame!.outputs[0]!.artifactId });
    expect(selected.stages.storyboards!.outputs[0]!.stale).toBeNull();
    const bytes = await engine.files.read(imageIds[1]!, "original.png");
    if (!bytes.ok) throw new Error(bytes.error.message);
    await engine.files.write(imageIds[0]!, "original.png", bytes.value);
    expect((await status(boards.goalId)).stages.frame!.outputs[0]!.stale).toBeTruthy();
    expect(engine.jobs.queue.list()).toHaveLength(0);
  });

  it("preserves a completed selection after a failed revision and safely reassembles only unchanged goal clips", async () => {
    const simple = goalTestSimplePlan(2);
    const boards = await advance(await advance(await create({ plan: simple }), "frame"), "storyboards");
    const ids = await Promise.all(["red", "green", "blue"].map(color => goalTestVideo(engine, root, color)));
    await seedGoalStage(engine, boards.goalId, "videos", { videoIds: ids.slice(0, 2) });
    const assembled = await invoke({ action: "assemble", goal_id: boards.goalId });
    const originalClips = engine.sequences.getPrimary().clips;
    await seedGoalStage(engine, boards.goalId, "videos", { indexes: [0], videoIds: [ids[2]!], failedIndex: 0 });
    const failed = await status(boards.goalId);
    expect(failed.status).toBe("failed");
    expect(failed.stages.videos!.outputs.map(output => output.artifactId)).toEqual(ids.slice(0, 2));
    await seedGoalStage(engine, boards.goalId, "videos", { indexes: [0], videoIds: [ids[2]!] });
    const revised = await status(boards.goalId);
    expect(revised.assemblyStale).toBe(true);
    expect(revised.clipIds).toEqual(assembled.clipIds);
    expect(engine.sequences.getPrimary().clips).toEqual(originalClips);
    expect((await raw({ action: "combine", goal_id: boards.goalId })).isError).toBe(true);
    const reassembled = await invoke({ action: "assemble", goal_id: boards.goalId });
    expect(reassembled.assemblyStale).toBe(false);
    expect(engine.sequences.getPrimary().clips.map(clip => clip.source.artifactId)).toEqual([ids[2], ids[1]]);
    const sequence = engine.sequences.getPrimary();
    const clip = sequence.clips[0]!;
    const intent: EditIntent = {
      intentVersion: MVP_CONTRACT_VERSION, commandId: uuidv7(), sequenceId: sequence.sequenceId, baseRevision: sequence.revision,
      actor: "user", sourceSurface: "system", confirmationPolicy: "reversible-single-step",
      operations: [{ kind: "set-clip-audio", clipId: clip.clipId, audio: { ...clip.audio!, gainDb: -6 } }],
    };
    const preview = engine.edits.preview(intent);
    if (!preview.ok) throw new Error(preview.error.message);
    const changed = await engine.edits.commit(intent, preview.value.previewHash);
    if (!changed.ok) throw new Error(changed.error.message);
    await expect(appendGoalClips(engine, readGoal(engine, boards.goalId), ids.slice(0, 2))).rejects.toThrow("timeline clips were edited");
    expect(engine.sequences.getPrimary().clips[0]!.audio?.gainDb).toBe(-6);
    expect(engine.sequences.getPrimary().clips.map(clip => clip.source.artifactId)).toEqual([ids[2], ids[1]]);
  });

  it("retains legacy video versions when their original stage predates attempt history", async () => {
    const boards = await advance(await advance(await create({ plan: goalTestPlan(1) }), "frame"), "storyboards");
    const original = await goalTestVideo(engine, root, "red");
    await seedGoalStage(engine, boards.goalId, "videos", { videoIds: [original], legacy: true });
    const complete = await status(boards.goalId);
    expect(complete.stages.videos!.outputs[0]!.versions[0]).toMatchObject({ artifactId: original, current: true });
    await pauseBookQueueForTests(bookId);
    const revision = await invoke({ action: "revise", goal_id: boards.goalId, revision: complete.revision, stage: "videos", index: 0, feedback: "Slow the reaction" });
    expect(revision.stages.videos!.attempts!.map(attempt => attempt.artifactId)).toEqual([original, null]);
    await invoke({ action: "cancel", goal_id: boards.goalId });
    await waitForChainRun(engine, revision.chainId!);
    const selected = await invoke({ action: "select", goal_id: boards.goalId, stage: "videos", index: 0, artifact_id: original });
    expect(selected.stages.videos!.outputs[0]!.stale).toBeNull();
  });

  it("detects revised legacy assemblies without overwriting a timeline that lacks an edit snapshot", async () => {
    const boards = await advance(await advance(await create({ plan: goalTestPlan(2) }), "frame"), "storyboards");
    const ids = await Promise.all(["red", "blue", "green"].map(color => goalTestVideo(engine, root, color)));
    await seedGoalStage(engine, boards.goalId, "videos", { videoIds: ids.slice(0, 2), legacy: true });
    await invoke({ action: "assemble", goal_id: boards.goalId });
    const stored = readGoal(engine, boards.goalId);
    const { artifactIds: _ids, clipSnapshot: _snapshot, ...assembly } = stored.assembly!;
    saveGoal(engine, { ...stored, assembly });
    expect((await status(boards.goalId)).assemblyStale).toBe(false);
    await seedGoalStage(engine, boards.goalId, "videos", { indexes: [0], videoIds: [ids[2]!] });
    expect((await status(boards.goalId)).assemblyStale).toBe(true);
    expect((await raw({ action: "combine", goal_id: boards.goalId })).isError).toBe(true);
    expect((await raw({ action: "assemble", goal_id: boards.goalId })).isError).toBe(true);
    expect(engine.sequences.getPrimary().clips.map(clip => clip.source.artifactId)).toEqual(ids.slice(0, 2));
  });

  it("plans a concise v3 scene and video from mixed image and video references", async () => {
    const videoId = await goalTestVideo(engine, root, "red");
    const before = await engine.files.manifest(videoId);
    if (!before.ok) throw new Error(before.error.message);
    const videoCell = engine.notebooks.createCell({ type: "video", label: "Market clip", slot: { row: 0, column: 2 }, outputArtifactId: videoId });
    const inserted = await engine.notebooks.insertCell(notebookId, videoCell);
    expect(inserted.ok, inserted.ok ? "" : inserted.error.message).toBe(true);
    const goal = await invoke({ action: "create", brief: "@a1 @a3 skate through the morning market" });
    expect(engine.jobs.queue.list({ type: "plan_goal" })).toHaveLength(0);
    expect(goal).toMatchObject({
      planVersion: 3, status: "review", stage: "frame",
      plan: {
        version: 3, aspectRatio: "16:9",
        scene: { tool: "generate_image", model: "kie:nano-banana-2-1", aspectRatio: "16:9", resolution: "2K", outputFormat: "jpg" },
        video: { tool: "generate_video", model: GOAL_VIDEO_MODEL, aspectRatio: "16:9", resolution: "1080p", durationSeconds: 13, generateAudio: true, outputFormat: "mp4" },
        finish: { suggestedColdOpenSeconds: 2.3, watermark: { platform: "tiktok", handle: "jtbkk", mode: "burn" } },
      },
    });
    if (!goal.plan || !("version" in goal.plan) || goal.plan.version !== 3) throw new Error("expected a v3 plan");
    const plan = goal.plan;
    expect(plan).not.toHaveProperty("shots");
    expect(goalPromptWords(plan.scene.prompt)).toBeLessThanOrEqual(25);
    expect(goalPromptWords(plan.video.prompt)).toBeLessThanOrEqual(60);
    expect(plan.scene.prompt).toContain("@image1");
    expect(plan.video.prompt).toContain("@image1");
    expect(plan.video.prompt).toContain("@video1");
    expect(`${plan.scene.prompt} ${plan.video.prompt}`).not.toMatch(/@a\d|storyboard|cinematic|Thailand/u);
    const videoFile = findPrimaryMediaFile(before.value.files, "video");
    const imageManifest = await engine.files.manifest(imageIds[0]!);
    if (!imageManifest.ok || !videoFile) throw new Error("missing reference media");
    const imageFile = findPrimaryMediaFile(imageManifest.value.files, "image");
    expect(plan.references.map(reference => reference.objectHash).sort()).toEqual([imageFile!.objectHash, videoFile.objectHash].sort());
    const frameRef = plan.scene.imageRefs[0]!;
    const frameCell = notebook().cells.find(cell => cell.id === frameRef.cellId);
    const frameManifest = await engine.files.manifest(frameRef.artifactId);
    if (!frameCell || !frameManifest.ok) throw new Error("missing scene frame");
    expect(frameCell).toMatchObject({ type: "image", outputArtifactId: frameRef.artifactId, inputs: { sourceCellId: videoCell.id, atSeconds: 1 } });
    expect(notebook().edges.some(edge => edge.source === videoCell.id && edge.target === frameCell.id)).toBe(true);
    expect(frameRef).toMatchObject({ kind: "image", slot: "@image1", objectHash: findPrimaryMediaFile(frameManifest.value.files, "image")!.objectHash });
    expect(plan.scene.imageRefs.map(reference => [reference.slot, reference.artifactId])).toEqual([["@image1", frameRef.artifactId], ["@image2", imageIds[0]]]);
    expect(plan.scene.prompt).toMatch(/^Place @image2 into @image1, keeping its framing/u);
    expect(plan.sampledFrames).toEqual([{ artifactId: frameRef.artifactId, objectHash: frameRef.objectHash, seconds: 1 }]);
    const after = await engine.files.manifest(videoId);
    expect(after.ok && after.value.files.map(file => file.name).sort()).toEqual(before.value.files.map(file => file.name).sort());
    expect(notebook().edges.filter(edge => edge.target === goal.cellId).map(edge => edge.targetInput)).toEqual(["character"]);
    expect(plan.references.find(reference => reference.kind === "video")).toMatchObject({ artifactId: videoId, cellId: videoCell.id, objectHash: videoFile.objectHash });
    expect(goal.estimate.videos.usd).toBeGreaterThan(0);
    expect(goal.estimate.total.usd).toBeCloseTo((goal.estimate.frame.usd ?? 0) + (goal.estimate.storyboards.usd ?? 0) + (goal.estimate.videos.usd ?? 0));

    const mention = () => {
      const document = notebook();
      const image = document.cells.find(cell => cell.outputArtifactId === imageIds[0]);
      const video = document.cells.find(cell => cell.outputArtifactId === videoId);
      if (!image || !video) throw new Error("missing reference cells");
      return `${notebookGridTag(image.slot)} ${notebookGridTag(video.slot)}`;
    };
    const quote = "keep every word of this authored scene even when it runs past the twenty five word ceiling for fresh scene prompts today and again tomorrow morning";
    const authored = await invoke({ action: "create", brief: `${mention()} scene: "${quote}"` });
    if (!authored.plan || !("version" in authored.plan) || authored.plan.version !== 3) throw new Error("expected a quoted v3 plan");
    expect(goalPromptWords(quote)).toBeGreaterThan(25);
    expect(authored.plan.scene.prompt).toContain(quote);
    expect(authored.plan.scene.prompt).toContain("@image1");

    const many = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const truncated = await invoke({ action: "create", brief: `${mention()} ${many}` });
    if (!truncated.plan || !("version" in truncated.plan) || truncated.plan.version !== 3) throw new Error("expected a truncated v3 plan");
    expect(goalPromptWords(truncated.plan.scene.prompt)).toBeLessThanOrEqual(25);
    expect(goalPromptWords(truncated.plan.video.prompt)).toBeLessThanOrEqual(60);
    expect(truncated.plan.scene.prompt).not.toContain("word39");

    const portrait = await invoke({ action: "create", brief: `${mention()} a portrait clip of the market` });
    expect(portrait.plan).toMatchObject({ aspectRatio: "9:16", scene: { aspectRatio: "9:16" }, video: { aspectRatio: "9:16", durationSeconds: 13 } });
    const tallId = await goalTestVideo(engine, root, "blue", { width: 90, height: 160 });
    const tallCell = engine.notebooks.createCell({ type: "video", label: "Tall clip", slot: { row: 7, column: 0 }, outputArtifactId: tallId });
    const tallInserted = await engine.notebooks.insertCell(notebookId, tallCell);
    expect(tallInserted.ok, tallInserted.ok ? "" : tallInserted.error.message).toBe(true);
    const tall = await invoke({ action: "create", brief: `${mention().split(" ")[0]} ${notebookGridTag(tallCell.slot)} a clip of the workshop` });
    expect(tall.plan).toMatchObject({ aspectRatio: "9:16", scene: { aspectRatio: "9:16" }, video: { aspectRatio: "9:16" } });
    const timed = await invoke({ action: "create", brief: `${mention()} 10 seconds through the market` });
    expect(timed.plan).toMatchObject({ video: { durationSeconds: 10 } });
    expect(timed.estimate.videos.usd).toBeLessThan(goal.estimate.videos.usd!);

    const steps = compileGoalV3Steps(plan);
    expect(steps.map(step => step.id)).toEqual(["scene", "video"]);
    expect(JSON.stringify(steps)).not.toMatch(/storyboard|ending|cinematic/iu);
    const sceneParams = steps[0]!.params;
    const sceneRequest = buildWireRequest(resolveModel(String(sceneParams.model)), {
      prompt: String(sceneParams.prompt),
      refUrls: { image: ["https://example.test/scene.png"] },
      options: sceneParams.options as Record<string, unknown>,
    });
    expect(sceneRequest).toMatchObject({ ok: true, request: { model: "nano-banana-2-1", input: { aspect_ratio: "16:9", resolution: "2K", output_format: "jpg" } } });
    const videoParams = steps[1]!.params;
    const videoRequest = buildWireRequest(resolveModel(String(videoParams.model)), {
      prompt: String(videoParams.prompt),
      refUrls: { image: ["https://example.test/ref.png"], video: ["https://example.test/motion.mp4"] },
      mode: String(videoParams.mode),
      options: videoParams.options as Record<string, unknown>,
    });
    expect(videoRequest).toMatchObject({
      ok: true,
      request: {
        model: "bytedance/seedance-2-5",
        input: {
          reference_image_urls: ["https://example.test/ref.png"],
          reference_video_urls: ["https://example.test/motion.mp4"],
          aspect_ratio: "16:9", resolution: "1080p", duration: 13, generate_audio: true, output_format: "mp4",
        },
      },
    });

    const document = notebook();
    const image = document.cells.find(cell => cell.outputArtifactId === imageIds[0])!;
    const slot = { row: 6, column: 3 };
    const written = await engine.notebooks.write({
      ...document,
      cells: document.cells.map(cell => cell.id === image.id ? { ...cell, slot } : cell),
    });
    expect(written.ok, written.ok ? "" : written.error.message).toBe(true);
    const refreshed = await status(goal.goalId);
    if (!refreshed.plan || !("version" in refreshed.plan) || refreshed.plan.version !== 3) throw new Error("expected the refreshed v3 plan");
    expect(refreshed.plan.scene.prompt).toBe(plan.scene.prompt);
    expect(refreshed.plan.video.prompt).toBe(plan.video.prompt);
    expect(refreshed.plan.references.find(reference => reference.cellId === image.id)?.address).toBe(notebookGridTag(slot));
    expect(refreshed.plan.scene.imageRefs.find(reference => reference.cellId === image.id)?.address).toBe(notebookGridTag(slot));
    const classicBrief = imageIds.map(id => {
      const cell = notebook().cells.find(item => item.outputArtifactId === id);
      if (!cell) throw new Error("missing image cell");
      return notebookGridTag(cell.slot);
    }).join(" ");
    const classic = await create({ brief: `${classicBrief} make a funny video of a dog on a skateboard, three 10s clips` });
    expect(classic.planVersion).toBe(2);
    expect(classic.plan).toMatchObject({ version: 2 });
  }, 60_000);

  it("approves a v3 scene then a video and stops at finishing review", async () => {
    const goal = await invoke({ action: "create", brief: "@a1 @a2 skate through the morning market" });
    expect(goal).toMatchObject({ planVersion: 3, status: "review", stage: "frame", finalArtifactId: null, finish: null });
    expect(goal.estimate.still.usd).toBe(goal.estimate.frame.usd);
    expect(goal.estimate.still.usd).toBeGreaterThan(0);
    expect(textOf(await raw({ action: "approve", goal_id: goal.goalId, revision: 0 }))).toContain("The goal changed");
    delete process.env.KIE_API_KEY;
    expect(textOf(await raw({ action: "approve", goal_id: goal.goalId, revision: goal.revision }))).toContain("KIE_API_KEY");
    process.env.KIE_API_KEY = "test-goal-key";
    await pauseBookQueueForTests(bookId);
    const started = await approve(goal);
    expect((await approve(goal)).chainId).toBe(started.chainId);
    const sceneChain = getChainRun(engine, started.chainId!)!;
    expect(sceneChain.steps.map(step => ({ id: step.id, tool: step.tool }))).toEqual([{ id: "scene", tool: "generate_image" }]);
    expect(sceneChain.steps[0]!.params.model).toBe("kie:nano-banana-2-1");
    expect(sceneChain.steps[0]!.approval?.actor).toBe("chat");
    expect(sceneChain.steps.some(step => step.id === "assemble" || step.tool.includes("storyboard"))).toBe(false);
    expect(mediaJobs(GOAL_VIDEO_MODEL)).toHaveLength(0);
    const sceneArtifactId = await settleChain(started.chainId!, "image");
    const reviewed = await status(goal.goalId);
    expect(reviewed).toMatchObject({ status: "review", stage: "videos", revision: goal.revision + 1, finalArtifactId: null, finish: null });
    expect(reviewed.stages.frame?.outputs[0]?.artifactId).toBe(sceneArtifactId);
    expect(reviewed.estimate.still.usd).toBe(reviewed.estimate.videos.usd);
    expect(reviewed.estimate.still.usd).toBeGreaterThan(0);
    expect(readGoal(engine, goal.goalId)).toMatchObject({ status: "review", stage: "videos", chainId: started.chainId });
    expect((await status(goal.goalId)).stages.frame?.outputs[0]?.artifactId).toBe(sceneArtifactId);
    const other = await engine.notebooks.create("Other goals");
    if (!other.ok) throw new Error(other.error.message);
    expect((await raw({ action: "status", goal_id: goal.goalId, notebook_id: other.value.id })).isError).toBe(true);

    const videoRun = await approve(reviewed);
    const videoChain = getChainRun(engine, videoRun.chainId!)!;
    expect(videoChain.steps.map(step => step.id)).toEqual(["video"]);
    expect(videoChain.steps[0]).toMatchObject({ tool: GOAL_VIDEO_TOOL, params: { model: GOAL_VIDEO_MODEL } });
    expect(videoChain.steps[0]!.pins.some(pin => pin.artifactId === sceneArtifactId)).toBe(true);
    expect(videoChain.steps[0]!.approval?.actor).toBe("chat");
    expect(videoChain.steps.some(step => step.id === "assemble" || step.tool.includes("storyboard"))).toBe(false);
    const videoArtifactId = await settleChain(videoRun.chainId!, "video");
    const finishing = await status(goal.goalId);
    expect(finishing.status).toBe("review");
    expect(finishing.finish).toMatchObject({ status: "review", sourceArtifactId: videoArtifactId, finalArtifactId: null, error: null });
    expect(finishing.finalArtifactId).toBeNull();
    expect(finishing.stages.videos?.outputs.map(output => output.artifactId)).toEqual([videoArtifactId]);
    expect(textOf(await raw({ action: "approve", goal_id: goal.goalId, revision: finishing.revision }))).toContain("finishing review");
    expect(textOf(await raw({ action: "assemble", goal_id: goal.goalId }))).toContain("storyboard");
    expect(textOf(await raw({ action: "update", goal_id: goal.goalId, revision: finishing.revision, plan }))).toContain("storyboard");
    expect(engine.sequences.getPrimary().clips).toHaveLength(0);

    const again = await invoke({ action: "regenerate", goal_id: goal.goalId, revision: finishing.revision, stage: "videos", index: 0 });
    expect(again.finish).toBeNull();
    expect(again.status).toBe("running");
    const replacement = await settleChain(again.chainId!, "video");
    const replaced = await status(goal.goalId);
    expect(replaced.finish).toMatchObject({ status: "review", sourceArtifactId: replacement, finalArtifactId: null });
    saveGoal(engine, {
      ...readGoal(engine, goal.goalId),
      status: "completed",
      finish: { status: "completed", sourceArtifactId: replacement, finalArtifactId: replacement, error: null },
    });
    expect(await status(goal.goalId)).toMatchObject({ status: "completed", finalArtifactId: replacement });
    const selected = await invoke({ action: "select", goal_id: goal.goalId, revision: replaced.revision, stage: "videos", index: 0, artifact_id: videoArtifactId });
    expect(selected.stages.videos?.outputs[0]?.artifactId).toBe(videoArtifactId);
    expect(selected.status).toBe("review");
    expect(selected.finalArtifactId).toBeNull();
    expect(selected.finish).toMatchObject({ status: "review", sourceArtifactId: videoArtifactId, finalArtifactId: null, error: null });
    const revising = await invoke({ action: "revise", goal_id: goal.goalId, revision: selected.revision, stage: "frame", index: 0, feedback: "Raise the board" });
    expect(revising.finish).toBeNull();
    expect(revising.status).toBe("running");
    expect(getChainRun(engine, revising.chainId!)?.steps[0]?.params.prompt).toContain("Raise the board");
    const restored = await invoke({ action: "cancel", goal_id: goal.goalId });
    await waitForChainRun(engine, revising.chainId!);
    expect(restored).toMatchObject({ status: "review", stage: "videos" });
    expect(restored.stages.frame?.outputs[0]?.artifactId).toBe(sceneArtifactId);
    expect(restored.finish).toMatchObject({ status: "review", sourceArtifactId: videoArtifactId, finalArtifactId: null });
    expect(engine.sequences.getPrimary().clips).toHaveLength(0);
  }, 60_000);

  it("saves a v3 title and prompt without rewriting settings or a title-only finish", async () => {
    const goal = await invoke({ action: "create", brief: "@a1 @a2 skate through the morning market" });
    if (!goal.plan || !("version" in goal.plan) || goal.plan.version !== 3) throw new Error("expected a v3 plan");
    const videoId = await goalTestVideo(engine, root, "green");
    const seeded = { status: "review" as const, sourceArtifactId: videoId, finalArtifactId: null, error: null };
    saveGoal(engine, { ...readGoal(engine, goal.goalId), finish: seeded });
    const titled = await invoke({ action: "update", goal_id: goal.goalId, revision: goal.revision, plan: { ...goal.plan, title: "Market morning" } });
    expect(titled.revision).toBe(goal.revision + 1);
    expect(titled.finish).toMatchObject(seeded);
    expect(titled.estimate.total).toEqual(goal.estimate.total);
    if (!titled.plan || !("scene" in titled.plan)) throw new Error("expected the saved scene");
    const authored = "keep every word of this authored scene even when it runs past the twenty five word ceiling for fresh scene prompts today and again tomorrow morning";
    const prompted = await invoke({
      action: "update", goal_id: goal.goalId, revision: titled.revision,
      plan: { ...titled.plan, scene: { ...titled.plan.scene, prompt: authored } },
    });
    expect(prompted.finish).toBeNull();
    expect(prompted.revision).toBe(titled.revision + 1);
    expect(prompted.estimate.total).toEqual(goal.estimate.total);
    if (!prompted.plan || !("scene" in prompted.plan)) throw new Error("expected the edited scene");
    expect(prompted.plan.scene.prompt).toBe(authored);
    const rejected = await raw({
      action: "update", goal_id: goal.goalId, revision: prompted.revision,
      plan: { ...prompted.plan, scene: { ...prompted.plan.scene, aspectRatio: "9:16" } },
    });
    expect(textOf(rejected)).toContain("settings stay with this goal");
    expect((await status(goal.goalId)).revision).toBe(prompted.revision);
    saveGoal(engine, {
      ...readGoal(engine, goal.goalId),
      status: "completed",
      finish: { status: "completed", sourceArtifactId: videoId, finalArtifactId: videoId, error: null },
    });
    const completed = await status(goal.goalId);
    expect(completed).toMatchObject({ status: "completed", finalArtifactId: videoId });
    if (!completed.plan || !("scene" in completed.plan) || !("video" in completed.plan)) throw new Error("expected the completed v3 plan");
    const retitled = await invoke({
      action: "update", goal_id: goal.goalId, revision: completed.revision,
      plan: { ...completed.plan, title: "Still the finished cut" },
    });
    expect(retitled).toMatchObject({ status: "completed", finalArtifactId: videoId });
    expect(retitled.finish?.status).toBe("completed");
    if (!retitled.plan || !("scene" in retitled.plan) || !("video" in retitled.plan)) throw new Error("expected the titled plan");
    const reopened = await invoke({
      action: "update", goal_id: goal.goalId, revision: retitled.revision,
      plan: {
        ...retitled.plan,
        scene: { ...retitled.plan.scene, prompt: `${retitled.plan.scene.prompt} once more` },
        video: { ...retitled.plan.video, prompt: `${retitled.plan.video.prompt} once more` },
      },
    });
    expect(reopened.status).toBe("review");
    expect(reopened.finalArtifactId).toBeNull();
    expect(reopened.finish).toBeNull();
  }, 60_000);

  it("retries an interrupted v3 scene unless the reference changed, including a video-only goal", async () => {
    const goal = await invoke({ action: "create", brief: "@a1 @a2 skate through the morning market" });
    await pauseBookQueueForTests(bookId);
    const started = await approve(goal);
    await expect.poll(() => getChainRun(engine, started.chainId!)?.steps[0]?.childJobIds.length, { timeout: 15_000 }).toBe(1);
    const providerArtifactId = String(getChainRun(engine, started.chainId!)!.steps[0]!.outputs?.asset_id);
    expect(await engine.jobs.queue.abort(providerJob(providerArtifactId).id, "Fixture generation stopped")).toBe(true);
    await expect.poll(() => getChainRun(engine, started.chainId!)?.status, { timeout: 15_000 }).toBe("failed");
    const chain = getChainRun(engine, started.chainId!)!;
    const store = engine.settings.get<{ runs: Record<string, typeof chain>; requestIndex: Record<string, string> }>("application.chain-runs.v1") ?? { runs: {}, requestIndex: {} };
    const restored = engine.settings.set("application.chain-runs.v1", {
      ...store,
      runs: { ...store.runs, [chain.chainId]: { ...chain, status: "running", error: null, steps: chain.steps.map(step => ({ ...step, status: "running" as const, error: null })) } },
    });
    if (!restored.ok) throw new Error(restored.error.message);
    resumeOpenChains(engine, () => undefined);
    expect(getChainRun(engine, started.chainId!)?.status).toBe("interrupted");
    const interrupted = await status(goal.goalId);
    expect(interrupted.status).toBe("interrupted");
    const retried = await invoke({ action: "retry", goal_id: goal.goalId });
    expect(retried.status).toBe("running");
    expect(retried.chainId).toBe(started.chainId);
    await expect.poll(() => getChainRun(engine, retried.chainId!)?.steps[0]?.childJobIds.length, { timeout: 15_000 }).toBe(1);
    const runningArtifactId = String(getChainRun(engine, retried.chainId!)!.steps[0]!.outputs?.asset_id);
    const aborted = await engine.jobs.queue.abort(providerJob(runningArtifactId).id, "Fixture generation stopped");
    expect(aborted).toBe(true);
    await expect.poll(() => getChainRun(engine, retried.chainId!)?.status, { timeout: 15_000 }).toBe("failed");
    const failed = await status(goal.goalId);
    expect(failed.status).toBe("failed");
    const rewritten = await engine.files.write(imageIds[0]!, "original.png", await sharp({ create: { width: 32, height: 32, channels: 3, background: "#111111" } }).png().toBuffer());
    if (!rewritten.ok) throw new Error(rewritten.error.message);
    expect(textOf(await raw({ action: "retry", goal_id: goal.goalId }))).toContain("references or selected versions changed");

    const videoId = await goalTestVideo(engine, root, "green");
    const videoCell = engine.notebooks.createCell({ type: "video", label: "Only clip", slot: { row: 4, column: 0 }, outputArtifactId: videoId });
    const inserted = await engine.notebooks.insertCell(notebookId, videoCell);
    expect(inserted.ok, inserted.ok ? "" : inserted.error.message).toBe(true);
    const videoAddress = notebookGridTag(notebook().cells.find(cell => cell.id === videoCell.id)!.slot);
    const videoOnly = await invoke({ action: "create", brief: `${videoAddress} glide over the market` });
    expect(videoOnly.characters).toHaveLength(0);
    expect(notebook().edges.filter(edge => edge.target === videoOnly.cellId)).toHaveLength(0);
    const scene = await approve(videoOnly);
    if (!videoOnly.plan || !("version" in videoOnly.plan) || videoOnly.plan.version !== 3) throw new Error("expected a v3 plan");
    expect(videoOnly.plan.scene.prompt).toMatch(/^Edit @image1, keeping its framing/u);
    expect(getChainRun(engine, scene.chainId!)?.steps[0]?.params.refs).toEqual({ image: [notebookGridTag(notebook().cells.find(cell => cell.id === videoOnly.plan!.scene.imageRefs[0]!.cellId)!.slot)] });
    const sceneArtifactId = await settleChain(scene.chainId!, "image");
    const ready = await status(videoOnly.goalId);
    expect(ready).toMatchObject({ status: "review", stage: "videos" });
    const video = await approve(ready);
    const pins = getChainRun(engine, video.chainId!)!.steps[0]!.pins.map(pin => pin.artifactId);
    expect(pins).toEqual(expect.arrayContaining([sceneArtifactId, videoId]));
    expect(pins).toHaveLength(2);
    await invoke({ action: "cancel", goal_id: videoOnly.goalId });
    await waitForChainRun(engine, video.chainId!);
  }, 60_000);

  it("refuses to finish a v2 goal with a cold open", async () => {
    const goal = await create();
    expect(textOf(await raw({ action: "finish", goal_id: goal.goalId }))).toContain("scene and video goal");
  });

  it("finishes a reviewed video with one cold-open copy and one watermarked copy", async () => {
    const exec = promisify(execFile);
    async function mediaHash(artifactId: string): Promise<string> {
      const manifest = await engine.files.manifest(artifactId);
      if (!manifest.ok) throw new Error(manifest.error.message);
      const file = findPrimaryMediaFile(manifest.value.files, "video");
      if (!file) throw new Error(`missing video ${artifactId}`);
      return file.objectHash;
    }
    async function mediaProbe(artifactId: string) {
      const manifest = await engine.files.manifest(artifactId);
      if (!manifest.ok) throw new Error(manifest.error.message);
      const file = findPrimaryMediaFile(manifest.value.files, "video");
      if (!file) throw new Error(`missing video ${artifactId}`);
      return { file, probe: await probeVideo(join(manifest.value.path, file.name)) };
    }
    async function frameAt(artifactId: string, seconds: number): Promise<Buffer> {
      const media = await mediaProbe(artifactId);
      const manifest = await engine.files.manifest(artifactId);
      if (!manifest.ok) throw new Error(manifest.error.message);
      const frame = await exec(FFMPEG, [
        "-v", "error", "-ss", String(seconds), "-i", join(manifest.value.path, media.file.name),
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
      ], { encoding: "buffer", maxBuffer: 2_000_000 });
      return frame.stdout;
    }
    const regionMean = (left: Buffer, right: Buffer, width: number, box: { x: number; y: number; w: number; h: number }): number => {
      let sum = 0;
      let count = 0;
      for (let y = box.y; y < box.y + box.h; y += 1) {
        for (let x = box.x; x < box.x + box.w; x += 1) {
          const offset = (y * width + x) * 3;
          sum += Math.abs(left[offset]! - right[offset]!) + Math.abs(left[offset + 1]! - right[offset + 1]!) + Math.abs(left[offset + 2]! - right[offset + 2]!);
          count += 3;
        }
      }
      return count === 0 ? 0 : sum / count;
    };
    const coldOpens = () => engine.jobs.queue.list({ type: "edit_cold_open" }).length;
    const burns = () => engine.jobs.queue.list({ type: "burn_watermark" }).length;
    let latest: GoalSnapshot | null = null;
    async function awaitFinish(goalId: string): Promise<GoalSnapshot> {
      await resumeBookQueueForTests(bookId);
      try {
        await expect.poll(async () => {
          latest = await status(goalId);
          return `${latest.status}:${latest.finish?.status ?? "none"}:${latest.finish?.error ?? ""}`;
        }, { timeout: 120_000, interval: 500 }).toBe("completed:completed:");
      } finally {
        await pauseBookQueueForTests(bookId);
      }
      if (!latest?.finish || latest.finish.status !== "completed" || !latest.finalArtifactId) throw new Error("finish did not complete");
      return latest;
    }

    await pauseBookQueueForTests(bookId);
    const goal = await invoke({ action: "create", brief: "@a1 @a2 skate through the morning market" });
    const scene = await approve(goal);
    const sceneChainId = scene.chainId!;
    await settleChain(sceneChainId, "image");
    const reviewed = await status(goal.goalId);
    const video = await approve(reviewed);
    const videoChainId = video.chainId!;
    const videoArtifactId = await settleChain(videoChainId, "video");
    const sourceHash = await mediaHash(videoArtifactId);
    const sourceProbe = await mediaProbe(videoArtifactId);

    const suggested = await invoke({ action: "finish", goal_id: goal.goalId });
    expect(suggested.coldOpen).toMatchObject({ startSeconds: 0, endSeconds: 2.3, analysisUsd: 0, sourceObjectHash: sourceHash });
    expect(suggested.finish).toMatchObject({ status: "review", sourceArtifactId: videoArtifactId, finalArtifactId: null });
    expect(suggested.finalArtifactId).toBeNull();
    expect(engine.jobs.queue.list({ type: "finish_goal" })).toHaveLength(0);
    expect(engine.jobs.queue.list({ type: "prepare_cold_open" })).toHaveLength(0);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);

    const queued = await invoke({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 0.5 });
    expect(queued.finish).toMatchObject({ status: "running", sourceArtifactId: videoArtifactId, finalArtifactId: null, startSeconds: 0, endSeconds: 0.5 });
    const firstJobId = readGoal(engine, goal.goalId).finish?.jobId;
    expect(firstJobId).toEqual(queued.finish?.jobId);
    expect(typeof firstJobId).toBe("number");
    expect(engine.jobs.queue.get(firstJobId!)?.state).toBe("queued");
    const finished = await awaitFinish(goal.goalId);
    const coldOpenArtifactId = finished.finish?.coldOpenArtifactId;
    const finalArtifactId = finished.finalArtifactId;
    if (!coldOpenArtifactId || !finalArtifactId) throw new Error("missing finish artifacts");
    const coldProbe = await mediaProbe(coldOpenArtifactId);
    const finalProbe = await mediaProbe(finalArtifactId);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);
    expect(await mediaHash(coldOpenArtifactId)).not.toBe(sourceHash);
    expect(await mediaHash(finalArtifactId)).not.toBe(await mediaHash(coldOpenArtifactId));
    expect(coldProbe.probe).toMatchObject({ width: sourceProbe.probe.width, height: sourceProbe.probe.height, hasAudio: true });
    expect(finalProbe.probe).toMatchObject({ width: sourceProbe.probe.width, height: sourceProbe.probe.height, hasAudio: true });
    expect(coldProbe.probe.fps).toBeCloseTo(sourceProbe.probe.fps, 0);
    expect(finalProbe.probe.fps).toBeCloseTo(sourceProbe.probe.fps, 0);
    expect(Math.abs(coldProbe.probe.videoDuration - (sourceProbe.probe.videoDuration + 0.5))).toBeLessThan(0.25);
    expect(Math.abs(finalProbe.probe.videoDuration - coldProbe.probe.videoDuration)).toBeLessThan(0.5);
    const width = sourceProbe.probe.width;
    const height = sourceProbe.probe.height;
    const handleBox = { x: Math.round(width * 0.2), y: 0, w: Math.round(width * 0.6), h: Math.max(8, Math.round(height * 0.28)) };
    const quietBox = { x: 0, y: Math.round(height * 0.4), w: Math.round(width * 0.45), h: Math.round(height * 0.2) };
    const qrBox = { x: Math.round(width * 0.55), y: Math.round(height * 0.5), w: Math.round(width * 0.4), h: Math.round(height * 0.45) };
    const earlyFinal = await frameAt(finalArtifactId, 1);
    const earlyCold = await frameAt(coldOpenArtifactId, 1);
    const handleDelta = regionMean(earlyFinal, earlyCold, width, handleBox);
    const earlyQuiet = regionMean(earlyFinal, earlyCold, width, quietBox);
    expect(handleDelta, `handle ${handleDelta} quiet ${earlyQuiet}`).toBeGreaterThan(1);
    expect(handleDelta).toBeGreaterThan(earlyQuiet * 3);
    const lateAt = Math.max(0, coldProbe.probe.videoDuration - 1.2);
    const lateFinal = await frameAt(finalArtifactId, lateAt);
    const lateCold = await frameAt(coldOpenArtifactId, lateAt);
    const qrRegion = regionMean(lateFinal, lateCold, width, qrBox);
    const lateQuiet = regionMean(lateFinal, lateCold, width, { x: 0, y: 0, w: Math.round(width * 0.3), h: Math.round(height * 0.25) });
    expect(qrRegion, `qr ${qrRegion} quiet ${lateQuiet}`).toBeGreaterThan(1);
    expect(qrRegion).toBeGreaterThan(lateQuiet * 3);
    expect(notebook().cells.some(cell => cell.outputArtifactId === videoArtifactId)).toBe(true);
    expect(notebook().cells.some(cell => cell.outputArtifactId === finalArtifactId)).toBe(true);
    expect(coldOpens()).toBe(1);
    expect(burns()).toBe(1);
    expect(getChainRun(engine, sceneChainId)?.status).toBe("completed");
    expect(getChainRun(engine, videoChainId)?.status).toBe("completed");

    const stored = readGoal(engine, goal.goalId);
    saveGoal(engine, {
      ...stored, status: "review",
      finish: stored.finish ? { ...stored.finish, status: "running", finalArtifactId: null, error: null } : stored.finish,
    });
    const recovered = await status(goal.goalId);
    expect(recovered).toMatchObject({ status: "completed", finalArtifactId });
    expect(recovered.finish?.coldOpenArtifactId).toBe(coldOpenArtifactId);
    expect(coldOpens()).toBe(1);
    expect(burns()).toBe(1);
    const finalHash = await mediaHash(finalArtifactId);
    const replay = await invoke({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 0.5 });
    expect(replay.finalArtifactId).toBe(finalArtifactId);
    expect(replay.finish?.coldOpenArtifactId).toBe(coldOpenArtifactId);
    expect(await mediaHash(finalArtifactId)).toBe(finalHash);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);
    expect(coldOpens()).toBe(1);
    expect(burns()).toBe(1);

    const changedRange = await invoke({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 1 });
    expect(changedRange.finish).toMatchObject({ status: "running", finalArtifactId: null, sourceArtifactId: videoArtifactId });
    const abortedJobId = readGoal(engine, goal.goalId).finish?.jobId;
    expect(typeof abortedJobId).toBe("number");
    expect(engine.jobs.queue.get(abortedJobId!)?.state).toBe("queued");
    expect(await engine.jobs.queue.abort(abortedJobId!, "Finishing cancelled")).toBe(true);
    const aborted = await status(goal.goalId);
    expect(aborted.status).toBe("review");
    expect(aborted.finish?.status).toBe("failed");
    expect(aborted.finalArtifactId).toBeNull();
    expect(getChainRun(engine, sceneChainId)?.status).toBe("completed");
    expect(getChainRun(engine, videoChainId)?.status).toBe("completed");
    expect(textOf(await raw({ action: "retry", goal_id: goal.goalId }))).toContain("failed or was interrupted");
    expect(coldOpens()).toBe(1);
    const retried = await awaitFinish((await invoke({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 1 })).goalId);
    expect(retried.finalArtifactId).not.toBe(finalArtifactId);
    expect(retried.finish?.coldOpenArtifactId).not.toBe(coldOpenArtifactId);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);
    expect(coldOpens()).toBe(2);
    expect(getChainRun(engine, sceneChainId)?.status).toBe("completed");
    expect(getChainRun(engine, videoChainId)?.status).toBe("completed");
    const secondFinal = retried.finalArtifactId!;

    await saveWatermarkProfile({ handle: "nightmarket" }, "tiktok", engine);
    const rewatermarked = await awaitFinish((await invoke({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 1 })).goalId);
    expect(rewatermarked.finalArtifactId).not.toBe(secondFinal);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);
    expect(await mediaHash(secondFinal)).not.toBe(sourceHash);
    expect(coldOpens()).toBe(3);
    const thirdFinal = rewatermarked.finalArtifactId!;
    const thirdHash = await mediaHash(thirdFinal);
    const burnsBeforeQr = burns();
    const coldOpensBeforeQr = coldOpens();

    await saveWatermarkProfile({ qrStartSeconds: 0.4, qrEndSeconds: 1.1 }, "tiktok", engine);
    const qrRewatermarked = await awaitFinish((await invoke({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 1 })).goalId);
    expect(qrRewatermarked.finalArtifactId).not.toBe(thirdFinal);
    expect(qrRewatermarked.finish?.coldOpenArtifactId).not.toBe(rewatermarked.finish?.coldOpenArtifactId);
    const fourthFinal = qrRewatermarked.finalArtifactId!;
    const fourthHash = await mediaHash(fourthFinal);
    expect(fourthHash).not.toBe(thirdHash);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);
    expect(await mediaHash(thirdFinal)).toBe(thirdHash);
    expect(coldOpens()).toBe(coldOpensBeforeQr + 1);
    expect(burns()).toBe(burnsBeforeQr + 1);

    const cancelling = await invoke({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 1.5 });
    expect(cancelling.finish?.status).toBe("running");
    expect(engine.jobs.queue.get(readGoal(engine, goal.goalId).finish!.jobId!)?.state).toBe("queued");
    const cancelled = await invoke({ action: "cancel", goal_id: goal.goalId });
    expect(cancelled).toMatchObject({ status: "review" });
    expect(cancelled.finish?.status).toBe("cancelled");
    expect(getChainRun(engine, sceneChainId)?.status).toBe("completed");
    expect(getChainRun(engine, videoChainId)?.status).toBe("completed");
    expect(engine.jobs.queue.list().some(job => job.type.startsWith("generate_") && ["queued", "running", "completing"].includes(job.state))).toBe(false);
    expect(coldOpens()).toBe(coldOpensBeforeQr + 1);
    expect(burns()).toBe(burnsBeforeQr + 1);
    expect(await mediaHash(thirdFinal)).toBe(thirdHash);
    expect(await mediaHash(fourthFinal)).toBe(fourthHash);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);

    saveGoal(engine, {
      ...readGoal(engine, goal.goalId), status: "review",
      assembly: { sequenceId: "seq", startFrame: 0, durationFrames: 1, artifactIds: ["not-the-selected-video"] },
    });
    expect(textOf(await raw({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 0.5 }))).toContain("timeline clips were edited");
    expect(engine.sequences.getPrimary().clips).toHaveLength(0);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);

    const combinedId = await goalTestVideo(engine, root, "green");
    const combinedHash = await mediaHash(combinedId);
    saveGoal(engine, {
      ...readGoal(engine, goal.goalId), status: "review",
      assembly: { sequenceId: "seq", startFrame: 0, durationFrames: 1, artifactIds: [videoArtifactId] },
      combined: { artifactId: combinedId, cellId: goal.cellId, jobId: null, status: "completed", error: null },
    });
    const combinedStart = await invoke({ action: "finish", goal_id: goal.goalId, start_seconds: 0, end_seconds: 0.5 });
    expect(combinedStart.finish).toMatchObject({ status: "running", sourceArtifactId: combinedId, finalArtifactId: null });
    const combinedDone = await awaitFinish(goal.goalId);
    expect(combinedDone.finish?.sourceArtifactId).toBe(combinedId);
    expect(combinedDone.finalArtifactId).not.toBe(combinedId);
    expect(await mediaHash(combinedId)).toBe(combinedHash);
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);
    expect(await mediaHash(thirdFinal)).toBe(thirdHash);
    expect(await mediaHash(fourthFinal)).toBe(fourthHash);
    expect(engine.sequences.getPrimary().clips).toHaveLength(0);
    expect(getChainRun(engine, sceneChainId)?.status).toBe("completed");
    expect(getChainRun(engine, videoChainId)?.status).toBe("completed");

    const sceneBefore = combinedDone.stages.frame?.outputs[0]?.artifactId;
    const finalBefore = combinedDone.finalArtifactId;
    if (!sceneBefore || !finalBefore) throw new Error("missing the completed scene or final");
    const finalBeforeHash = await mediaHash(finalBefore);
    const regenerating = await invoke({
      action: "regenerate", goal_id: goal.goalId, revision: combinedDone.revision, stage: "frame", index: 0,
    });
    expect(regenerating).toMatchObject({ status: "running", finish: null });
    expect(readGoal(engine, goal.goalId).resumeStatus).toBe("completed");
    const stopped = await invoke({ action: "cancel", goal_id: goal.goalId });
    await waitForChainRun(engine, regenerating.chainId!);
    expect(stopped).toMatchObject({ status: "completed", finalArtifactId: finalBefore });
    expect(stopped.finish?.status).toBe("completed");
    expect((await status(goal.goalId)).finalArtifactId).toBe(finalBefore);
    const restarted = await invoke({
      action: "revise", goal_id: goal.goalId, revision: stopped.revision, stage: "frame", index: 0, feedback: "Raise the board",
    });
    expect(restarted).toMatchObject({ status: "running", finish: null });
    expect(readGoal(engine, goal.goalId).resumeStatus).toBe("completed");
    const regeneratedScene = await settleChain(restarted.chainId!, "image");
    expect(regeneratedScene).not.toBe(sceneBefore);
    const reopened = await status(goal.goalId);
    expect(reopened).toMatchObject({ status: "review", stage: "videos", finalArtifactId: null, finish: null });
    expect(reopened.stages.frame?.outputs[0]?.artifactId).toBe(regeneratedScene);
    expect(getChainRun(engine, sceneChainId)?.status).toBe("completed");
    expect(getChainRun(engine, videoChainId)?.status).toBe("completed");
    expect(await mediaHash(videoArtifactId)).toBe(sourceHash);
    expect(await mediaHash(finalBefore)).toBe(finalBeforeHash);
  }, 300_000);
});
