import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { withBookContext } from "../book-context.js";
import { chatIntelligenceRequestOptions } from "../chat-models.js";
import { forecastLanguageCall } from "../cost.js";
import { createEngineForTest } from "../engine.js";
import { buildGoalShortPlan, buildLegacyGoalShortPlan, withShortFinishTitle, type GoalShortPlan, type ShortFinishTitle } from "../goal-short-plan.js";
import { goalShortContent, readGoal, readGoalCell, requireGoalShortContent, saveGoal, writeGoalShortContent } from "../goal-store.js";
import { graphicsDocumentFromLayers, type GraphicsTextLayer } from "../graphics/model.js";
import { goalTitlePrompt } from "../graphics/suggest.js";
import { saveGraphicsTemplate, setWatermarkGraphicsTemplate } from "../graphics/templates.js";
import { watermarkLayerInputs } from "../graphics/watermark-profile.js";
import { watermarkPayloadDocument, type BurnWatermarkPayload } from "../jobs/burn-watermark.js";
import { LIGHTNING_WATERMARK_PROFILE } from "../lightning-defaults.js";
import { installFalDynamicEstimator } from "../media/cost.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { pauseBookQueueForTests } from "../queue.js";
import { writeTaggingSettings } from "../tag-settings.js";
import { createTestClient } from "../test-client.js";
import { goalTestCharacters, settleGoalChain } from "../test-goals.js";
import { copyVideoFixture } from "../test-media-fixtures.js";
import { startShortStub, type ShortStub } from "../test-short-stub.js";
import { applyWatermarkDef } from "./apply-watermark.js";
import type { ShortGoalSnapshot } from "./goal.js";

const BRIEF = 'make @a1 wait for a bus in the rain, frame: "He stands under a bus shelter at dusk." beat 1: "He checks the road for the bus."';
const OPTIONS: ShortFinishTitle[] = [
  { headline: "รอรถเมล์กลางฝน", secondary: "Waiting for the bus in the rain" },
  { headline: "ฝนตกแต่รถเมล์ไม่มา", secondary: "The rain came, the bus did not" },
  { headline: "ใครเคยรอแบบนี้บ้าง", secondary: "Who has waited like this?" },
];
const TITLE: ShortFinishTitle = { headline: "รอรถเมล์\nกลางฝน", secondary: "Waiting for the bus" };
const RETITLED: ShortFinishTitle = { headline: "ฝนตกแต่รถเมล์ไม่มา", secondary: "" };
const FRAME = { width: 1080, height: 1920 };

type TitleRequest = { model: string; max_output_tokens: number; input: Array<{ role: string; content: string }>; text: { format: { name: string; strict: boolean } } };
type TitleAnswer = { goal_id: string; options: ShortFinishTitle[]; model: string };

describe("video_goal burned title", () => {
  let stub: ShortStub;
  let fixtures: string;
  let root: string;
  let engine: Engine;
  let client: Client;
  let bookId: string;
  let notebookId: string;
  let restoreEndpoints: () => void;
  let restoreEstimator: () => void;
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-goal-title-fixtures-"));
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
    restoreEndpoints = configureProviderEndpoints({ falQueueBaseURL: stub.baseURL, openaiBaseURL: stub.baseURL });
    restoreEstimator = installFalDynamicEstimator(async () => ({ total_cost: 0.21, currency: "USD" }));
    root = await mkdtemp(join(tmpdir(), "videobook-goal-title-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    writeTaggingSettings(engine, { analysisOnNewAssets: false });
    const notebook = await engine.notebooks.create("Shorts");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    await goalTestCharacters(engine, notebookId);
  });

  afterEach(async () => {
    await pauseBookQueueForTests(bookId);
    await client.close();
    restoreEstimator();
    restoreEndpoints();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const raw = (args: Record<string, unknown>) => client.callTool({ name: "video_goal", arguments: { book_id: bookId, notebook_id: notebookId, ...args } });
  const textOf = (result: Awaited<ReturnType<typeof raw>>) => (result.content as Array<{ text: string }>)[0]!.text;

  async function invoke<T = ShortGoalSnapshot>(args: Record<string, unknown>): Promise<T> {
    const result = await raw(args);
    expect(result.isError, textOf(result)).toBeFalsy();
    return JSON.parse(textOf(result)) as T;
  }

  async function refusal(args: Record<string, unknown>): Promise<string> {
    const result = await raw(args);
    expect(result.isError, textOf(result)).toBe(true);
    return textOf(result);
  }

  const status = (goalId: string) => invoke({ action: "status", goal_id: goalId });
  const short = async () => status((await invoke({ action: "create", brief: BRIEF, request_id: uuidv7() })).goalId);
  const writeTitle = (goal: ShortGoalSnapshot) => invoke<TitleAnswer>({ action: "title", goal_id: goal.goalId });
  const requests = () => stub.plannerRequests as TitleRequest[];
  const titleJobs = () => engine.jobs.queue.list({ type: "suggest_graphics", limit: 100 }).filter((job) => job.payload.goalId !== undefined);

  function stored(goal: ShortGoalSnapshot) {
    const content = requireGoalShortContent(engine, readGoal(engine, goal.goalId));
    if (!content.plan) throw new Error("expected a planned short");
    return { content, source: { brief: content.brief, draft: content.draft, plan: content.plan } };
  }

  function retitle(goal: ShortGoalSnapshot, title: ShortFinishTitle | null) {
    return invoke({ action: "update", goal_id: goal.goalId, revision: goal.revision, plan: withShortFinishTitle(goal.shortPlan!, title) });
  }

  async function saveWatermarkTemplate(layers: Parameters<typeof graphicsDocumentFromLayers>[0]): Promise<void> {
    const template = await saveGraphicsTemplate(engine, { name: `Watermark ${uuidv7()}`, document: graphicsDocumentFromLayers(layers) });
    await setWatermarkGraphicsTemplate(engine, "tiktok", template.id);
  }

  const handleOnly = () => watermarkLayerInputs(LIGHTNING_WATERMARK_PROFILE, FRAME, { includeQr: false });
  const headlineOnly = () => [
    { kind: "text" as const, name: "Title", position: { anchor: "bottom-left" as const, x: 0, y: 1, space: "safe" as const }, items: [{ text: "", slot: "headline" as const, size: 0.09 }] },
    ...handleOnly(),
  ];

  function finishJob(goal: ShortGoalSnapshot) {
    const job = engine.jobs.queue.get(goal.finish?.jobId ?? -1);
    expect(job?.type).toBe("finish_goal");
    return job!.payload as { goalId: string; identity: string; title?: ShortFinishTitle };
  }

  async function reviewedTake(): Promise<{ goal: ShortGoalSnapshot; clipId: string }> {
    await pauseBookQueueForTests(bookId);
    const created = await short();
    const frame = await invoke({ action: "approve", goal_id: created.goalId, revision: created.revision });
    await settleGoalChain(engine, root, frame.chainId!, "image");
    const before = await status(created.goalId);
    const clip = await invoke({ action: "approve", goal_id: created.goalId, revision: before.revision });
    const clipId = await settleGoalChain(engine, root, clip.chainId!, "video");
    const goal = await status(created.goalId);
    expect(goal.finish).toMatchObject({ status: "review", sourceArtifactId: clipId });
    return { goal, clipId };
  }

  it("prices Write title from the prompt it sends, covering one retry, apart from the short's total", async () => {
    const goal = await short();
    const { content, source } = stored(goal);
    const first = forecastLanguageCall(chatIntelligenceRequestOptions().model, goalTitlePrompt(source), 4096);
    expect(first.status).toBe("priced");
    const title = goal.estimate.title!;
    expect(title.usd).toBeGreaterThan(2 * first.usd);
    expect(title.usd).toBeLessThan(2 * first.usd + 0.01);
    expect(content.estimate.title).toEqual(title);
    const { frame, storyboards, videos, total } = goal.estimate;
    expect(total.usd).toBeCloseTo((frame.usd ?? 0) + (storyboards.usd ?? 0) + (videos.usd ?? 0), 6);

    const { title: _title, ...older } = content.estimate;
    await writeGoalShortContent(engine, readGoal(engine, goal.goalId), { ...content, estimate: older });
    expect(goalShortContent(readGoalCell(engine, readGoal(engine, goal.goalId))!).estimate).not.toHaveProperty("title");
    expect((await status(goal.goalId)).estimate.title).toEqual(title);
    expect(requests()).toEqual([]);
  });

  it("writes three options from the brief, the beats and the source image labels, with no transcript, and stores none of them", async () => {
    const goal = await short();
    stub.plannerAnswers = [{ options: OPTIONS }];
    const answer = await writeTitle(goal);
    expect(answer).toEqual({ goal_id: goal.goalId, options: OPTIONS, model: "gpt-6-astra" });
    expect(requests()).toHaveLength(1);
    const [request] = requests();
    expect(request).toMatchObject({ model: "gpt-6-astra", max_output_tokens: 4096, text: { format: { name: "goal_titles", strict: true } } });
    expect(request!.input).toHaveLength(1);
    const prompt = request!.input[0]!.content;
    expect(prompt).toBe(goalTitlePrompt(stored(goal).source));
    expect(prompt).toContain("BRIEF: make Source image 1 wait for a bus in the rain");
    expect(prompt).toContain(`WORKING TITLE: ${goal.shortPlan!.title}`);
    expect(prompt).toContain("1. He checks the road for the bus.");
    expect(prompt).toContain("Source image 1: Character 1");
    expect(prompt).not.toMatch(/TRANSCRIPT|ANALYSIS|@a1/u);
    expect(titleJobs().map((job) => job.payload)).toEqual([{ type: "suggest_graphics", bookId, goalId: goal.goalId }]);
    expect(engine.usage.recent(20).filter((entry) => entry.provider === "openai")).toEqual([
      expect.objectContaining({ externalId: "resp_short", status: "completed", inputTokens: 10, outputTokens: 10 }),
    ]);
    const after = await status(goal.goalId);
    expect(after.revision).toBe(goal.revision);
    expect(after.shortPlan?.finish).not.toHaveProperty("title");
  });

  it("reads a storyboard short's video and a saved character short's character in place of the source image labels", () => {
    const image = { kind: "image" as const, artifactId: "image-1", cellId: "image-1-cell", address: "@a1", label: "Man with an umbrella", objectHash: "1".repeat(64) };
    const boarded = buildGoalShortPlan({
      title: "Umbrella for a lizard", aspectRatio: "9:16", sourceImages: [image], framePrompt: "A man holds a red umbrella over a lizard.", beats: ["He walks beside the lizard."], segmentSeconds: [12],
      storyboard: {
        video: { artifactId: "video-1", cellId: "video-1-cell", address: "@d1", label: "Umbrella walk" }, model: "fal:google/nano-banana-2.1/edit",
        frames: [{ kind: "image", artifactId: "raw-1", cellId: "raw-1-cell", address: "@a3", label: "Storyboard 1 of 1", objectHash: "5".repeat(64), index: 0, atSeconds: 0.75, aspectRatio: "9:16", prompt: "Remove the captions." }],
      },
    });
    const prompt = goalTitlePrompt({ brief: "@a1 shelters a lizard like @d1", draft: null, plan: boarded });
    expect(prompt).toContain("BRIEF: Source image 1 shelters a lizard like the storyboard");
    expect(prompt).toContain("Source image 1: Man with an umbrella");
    expect(prompt).toContain("STORYBOARD VIDEO: Umbrella walk");
    const legacy: GoalShortPlan = buildLegacyGoalShortPlan({
      title: "Waiting for the bus", aspectRatio: "9:16", character: { name: "Somchai", description: "a man in a green shirt", references: [] },
      framePrompt: "A bus stop at dusk.", beats: ["He checks the road."], segmentSeconds: [12], extraReferences: [],
    });
    const saved = goalTitlePrompt({ brief: "he waits for a bus", draft: null, plan: legacy });
    expect(saved).toContain("MAIN CHARACTER: Somchai, a man in a green shirt");
    expect(saved).not.toContain("SOURCE IMAGES");
    expect(saved).not.toContain("STORYBOARD VIDEO");
  });

  it("asks again once when an answer is in the wrong script or too long, then fails if the second is no better", async () => {
    const goal = await short();
    stub.plannerAnswers = [
      { options: [{ headline: "Waiting for the bus", secondary: "รอรถเมล์" }, { headline: "รอ".repeat(141), secondary: "Too long" }, OPTIONS[0]] },
      { options: OPTIONS },
    ];
    expect((await writeTitle(goal)).options).toEqual(OPTIONS);
    expect(requests()).toHaveLength(2);
    const retry = requests()[1]!.input;
    expect(retry).toHaveLength(2);
    expect(retry[0]).toEqual(requests()[0]!.input[0]);
    expect(retry[1]!.content).toMatch(/^Your last answer broke the rules: every headline must be in Thai and every English line in English/u);

    stub.reset();
    stub.plannerAnswers = [
      { options: [{ headline: "Waiting", secondary: "Still waiting" }, { headline: "รอรถเมล์", secondary: "รอรถเมล์" }, { headline: "รอรถเมล์", secondary: "" }] },
      "not a title",
    ];
    expect(await refusal({ action: "title", goal_id: goal.goalId })).toBe("Astra did not write a title in Thai with an English line. Write title again, or type the title.");
    expect(requests()).toHaveLength(2);
  });

  it("makes no call without an OpenAI key or when the TikTok watermark template has no headline", async () => {
    const goal = await short();
    expect(goal.titleSlots).toEqual({ headline: true, secondary: true });
    delete process.env.OPENAI_API_KEY;
    expect(await refusal({ action: "title", goal_id: goal.goalId })).toBe("Writing a title needs an OpenAI API key, and OPENAI_API_KEY is not set. Type the title instead.");
    process.env.OPENAI_API_KEY = "offline-openai-key";

    await saveWatermarkTemplate(handleOnly());
    expect((await status(goal.goalId)).titleSlots).toEqual({ headline: false, secondary: false });
    expect(await refusal({ action: "title", goal_id: goal.goalId })).toBe("The saved TikTok watermark template has no headline, so Finish cannot burn a title. Add a headline to that template in the graphics editor, or finish without a title.");

    await saveWatermarkTemplate(headlineOnly());
    expect((await status(goal.goalId)).titleSlots).toEqual({ headline: true, secondary: false });
    expect(requests()).toEqual([]);
    expect(titleJobs()).toEqual([]);
  });

  it("stores, retypes and clears the title through update, keeping the watermark locked", async () => {
    const goal = await short();
    const titled = await retitle(goal, TITLE);
    expect(titled.revision).toBe(goal.revision + 1);
    expect(titled.shortPlan?.finish.title).toEqual(TITLE);
    const typed = withShortFinishTitle(titled.shortPlan!, null);
    const retyped = await invoke({ action: "update", goal_id: goal.goalId, revision: titled.revision, plan: { ...typed, finish: { ...typed.finish, title: { headline: " รอรถเมล์\r\nกลางฝน ", secondary: "" } } } });
    expect(retyped.shortPlan?.finish.title).toEqual({ headline: "รอรถเมล์\nกลางฝน", secondary: "" });
    expect(await refusal({ action: "update", goal_id: goal.goalId, revision: retyped.revision, plan: { ...typed, finish: { ...typed.finish, title: { headline: "", secondary: "Waiting" } } } }))
      .toMatch(/The burned title is empty\./u);
    const blank = await invoke({ action: "update", goal_id: goal.goalId, revision: retyped.revision, plan: { ...typed, finish: { ...typed.finish, title: { headline: " ", secondary: "\n" } } } });
    expect(blank.shortPlan?.finish).not.toHaveProperty("title");
    const again = await retitle(blank, TITLE);
    const cleared = await invoke({ action: "update", goal_id: goal.goalId, revision: again.revision, plan: { ...again.shortPlan!, finish: { ...again.shortPlan!.finish, title: null } } });
    expect(cleared.shortPlan?.finish).not.toHaveProperty("title");
    const plan = cleared.shortPlan!;
    expect(await refusal({ action: "update", goal_id: goal.goalId, revision: cleared.revision, plan: { ...plan, finish: { ...plan.finish, watermark: { ...plan.finish.watermark, handle: "someone" } } } }))
      .toBe("The source images stay with this short. Start a new /goal to change them.");
    expect(await refusal({ action: "update", goal_id: goal.goalId, revision: goal.revision, plan: withShortFinishTitle(plan, TITLE) }))
      .toBe("The goal changed. Review the current version before approving it.");
  });

  it("finishes with the title in its job and identity, and finishes again from the reviewed take after the title changes", async () => {
    const { goal, clipId } = await reviewedTake();
    const untitled = await invoke({ action: "finish", goal_id: goal.goalId });
    expect(finishJob(untitled)).not.toHaveProperty("title");
    expect(untitled.finish?.identity).not.toContain("title");
    await invoke({ action: "cancel", goal_id: goal.goalId });

    const titled = await retitle(await status(goal.goalId), TITLE);
    expect(titled.finish?.status).toBe("cancelled");
    const finishing = await invoke({ action: "finish", goal_id: goal.goalId });
    expect(finishJob(finishing)).toMatchObject({ goalId: goal.goalId, identity: finishing.finish?.identity, title: TITLE });
    expect(finishing.finish?.identity).toContain(JSON.stringify({ title: TITLE }).slice(1, -1));
    expect(finishing.finish?.identity).not.toBe(untitled.finish?.identity);
    expect(await refusal({ action: "update", goal_id: goal.goalId, revision: titled.revision, plan: withShortFinishTitle(titled.shortPlan!, RETITLED) }))
      .toBe("Wait until finishing stops before changing the burned title.");

    const done = readGoal(engine, goal.goalId);
    saveGoal(engine, { ...done, status: "completed", finish: { ...done.finish!, status: "completed", finalArtifactId: clipId } });
    const finished = await status(goal.goalId);
    expect(finished.finalArtifactId).toBe(clipId);
    const reopened = await retitle(finished, RETITLED);
    expect(reopened).toMatchObject({ status: "review", finalArtifactId: null, finish: { status: "review", sourceArtifactId: clipId, finalArtifactId: null, error: null } });
    const again = await invoke({ action: "finish", goal_id: goal.goalId });
    expect(finishJob(again).title).toEqual(RETITLED);
    expect(again.finish).toMatchObject({ status: "running", sourceArtifactId: clipId });
    expect(again.finish?.identity).not.toBe(finishing.finish?.identity);
  });

  it("leaves the title out of a finish whose watermark template cannot draw it", async () => {
    const { goal } = await reviewedTake();
    const titled = await retitle(goal, TITLE);
    await saveWatermarkTemplate(headlineOnly());
    const headlineOnlyFinish = await invoke({ action: "finish", goal_id: goal.goalId });
    expect(finishJob(headlineOnlyFinish).title).toEqual({ headline: TITLE.headline, secondary: "" });
    await invoke({ action: "cancel", goal_id: goal.goalId });
    await saveWatermarkTemplate(handleOnly());
    const handleOnlyFinish = await invoke({ action: "finish", goal_id: goal.goalId });
    expect(finishJob(handleOnlyFinish)).not.toHaveProperty("title");
    expect(handleOnlyFinish.finish?.identity).not.toContain("title");
    expect(titled.shortPlan?.finish.title).toEqual(TITLE);
  });

  it("hands the title to the burn as headline and English line slot values, and burns the handle alone without one", async () => {
    const { clipId } = await reviewedTake();
    const burn = async (title: ShortFinishTitle | null) => {
      const result = await withBookContext({ bookId, engine }, () => applyWatermarkDef(engine, { transcribe: false, title })
        .handler({ book_id: bookId, asset_id: clipId, platform: "tiktok", mode: "burn", wait: false }));
      expect(result.isError).toBeFalsy();
      const { job_id: jobId } = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { job_id: number };
      const payload = engine.jobs.queue.get(jobId)?.payload as unknown as BurnWatermarkPayload;
      const document = await watermarkPayloadDocument(engine, payload, 4, FRAME, payload.corner, null);
      const block = document.layers.find((layer): layer is GraphicsTextLayer => layer.kind === "text" && layer.name === "Title");
      return { payload, items: block?.items.map((item) => [item.slot, item.text]), shade: document.layers.some((layer) => layer.kind === "scrim") };
    };
    const titled = await burn(TITLE);
    expect(titled.payload).toMatchObject({ headline: TITLE.headline, secondary: TITLE.secondary, transcribe: false });
    expect(titled).toMatchObject({ items: [["headline", TITLE.headline], ["secondary", TITLE.secondary]], shade: true });
    const headlineOnlyBurn = await burn(RETITLED);
    expect(headlineOnlyBurn.payload).not.toHaveProperty("secondary");
    expect(headlineOnlyBurn.items).toEqual([["headline", RETITLED.headline], ["secondary", ""]]);
    const plain = await burn(null);
    expect(plain.payload).not.toHaveProperty("headline");
    expect(plain).toMatchObject({ items: [["headline", ""], ["secondary", ""]], shade: false });
  });
});
