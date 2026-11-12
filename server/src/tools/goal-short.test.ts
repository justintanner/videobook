import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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
import { saveMainCharacter } from "../goal-short-character.js";
import { SHORT_RULES } from "../goal-short-rules.js";
import { createShortGoal, shortFingerprint } from "../goal-short-runtime.js";
import { readGoal } from "../goal-store.js";
import { installFalDynamicEstimator, lowerBoundWarnings } from "../media/cost.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { configureProviderPollDriverForTests, resetProviderPollDriverForTests } from "../queue.js";
import { testBudget } from "../test-budget.js";
import { createTestClient } from "../test-client.js";
import { goalTestCharacters } from "../test-goals.js";
import { copyVideoFixture } from "../test-media-fixtures.js";
import type { GoalSnapshot } from "./goal.js";

const AUTHORED = 'he waits for a bus in the rain, frame: "He stands under a bus shelter at dusk." beat 1: "He checks the road for the bus."';
const NO_CHARACTER_REFERENCE = "Give the main character a reference image first: generate a character sheet or choose image cells.";
const NO_FAL_KEY = "Set FAL_API_KEY in Settings before generating this stage";
const REFUSAL = "Request blocked by the content policy";
const FAL_STORAGE_HOST = "rest.fal.ai";
const FREE_HOSTS = new Set(["litterbox.catbox.moe", "uguu.se", "tmpfile.link"]);
const SUBMIT = /^\/(openai\/gpt-image-2\.6\/(?:sunburst|flare)\/edit|minimax\/h3-max\/(?:reference-to-video|extend-video))$/u;
const POLL = /^\/(?:openai\/gpt-image-2\.6|minimax\/h3-max)\/requests\/([^/]+)(\/status)?$/u;

type Submission = { path: string; body: Record<string, unknown> };

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function responsesBody(text: string): string {
  return JSON.stringify({
    id: "resp_short", object: "response", created_at: 0, status: "completed", model: "gpt-6-astra",
    output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    instructions: null, previous_response_id: null, temperature: null, top_p: null, max_output_tokens: null,
    store: false, tools: [], reasoning: null, text: { format: { type: "text" } },
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 }, error: null, incomplete_details: null, metadata: {},
  });
}

describe("video_goal shorts", () => {
  let server: Server;
  let baseURL: string;
  let framePng: Buffer;
  let clipMp4: Buffer;
  let fixtures: string;
  let submissions: Submission[];
  let failNext: boolean;
  let failing: Set<string>;
  let answers: unknown[];
  let planned: unknown[];
  let unexpected: string[];
  let counter = 0;
  let root: string;
  let engine: Engine;
  let client: Client;
  let bookId: string;
  let notebookId: string;
  let imageIds: string[];
  let originalFetch: typeof fetch;
  let restoreEndpoints: () => void;
  let restoreEstimator: () => void;
  const savedEnv = new Map<string, string | undefined>();

  function route(method: string, path: string, body: Buffer, response: ServerResponse): void {
    if (method === "POST" && SUBMIT.test(path)) {
      const id = `${path.includes("h3-max") ? "clip" : "frame"}-${++counter}`;
      if (failNext) failing.add(id);
      failNext = false;
      submissions.push({ path, body: JSON.parse(body.toString()) as Record<string, unknown> });
      return sendJson(response, { request_id: id, status: "IN_QUEUE" });
    }
    const poll = POLL.exec(path);
    if (method === "GET" && poll) {
      const id = poll[1]!;
      if (poll[2]) return sendJson(response, failing.has(id) ? { status: "COMPLETED", error: REFUSAL } : { status: "COMPLETED" });
      return sendJson(response, id.startsWith("clip")
        ? { video: { url: `${baseURL}/files/clip.mp4`, content_type: "video/mp4" } }
        : { images: [{ url: `${baseURL}/files/frame.png`, content_type: "image/png" }] });
    }
    if (method === "GET" && path.startsWith("/files/")) {
      const clip = path.endsWith(".mp4");
      response.writeHead(200, { "content-type": clip ? "video/mp4" : "image/png" });
      response.end(clip ? clipMp4 : framePng);
      return;
    }
    if (method === "POST" && path === `/${FAL_STORAGE_HOST}/storage/upload/initiate`) {
      const { file_name: name } = JSON.parse(body.toString()) as { file_name: string };
      return sendJson(response, { file_url: `${baseURL}/files/${name}`, upload_url: `${baseURL}/fal-storage/${name}` });
    }
    if (method === "PUT" && path.startsWith("/fal-storage/")) {
      response.end();
      return;
    }
    if (method === "POST" && path.endsWith("/responses")) {
      planned.push(JSON.parse(body.toString()));
      const answer = answers.shift();
      response.writeHead(answer === undefined ? 500 : 200, { "content-type": "application/json" });
      response.end(answer === undefined ? JSON.stringify({ error: { message: "no answer queued" } }) : responsesBody(JSON.stringify(answer)));
      return;
    }
    unexpected.push(`${method} ${path}`);
    response.writeHead(FREE_HOSTS.has(path.split("/")[1] ?? "") ? 503 : 404).end();
  }

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-goal-short-fixtures-"));
    framePng = await sharp({ create: { width: 360, height: 640, channels: 3, background: "#5b7a4c" } }).png().toBuffer();
    await copyVideoFixture({ width: 360, height: 640, durationSec: 3, fps: 12, source: "color", color: "green", audio: { frequency: 330 } }, join(fixtures, "clip.mp4"));
    clipMp4 = await readFile(join(fixtures, "clip.mp4"));
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => route(request.method ?? "", new URL(request.url ?? "/", "http://127.0.0.1").pathname, Buffer.concat(chunks), response));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixtures, { recursive: true, force: true });
  });

  beforeEach(async () => {
    submissions = [];
    failNext = false;
    failing = new Set();
    answers = [];
    planned = [];
    unexpected = [];
    for (const [key, value] of [["FAL_API_KEY", "local-fal-key"], ["OPENAI_API_KEY", "offline-openai-key"], ["VIDEOBOOK_HAR_CAPTURE", "off"]] as const) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.hostname === FAL_STORAGE_HOST || FREE_HOSTS.has(url.hostname)
        ? originalFetch(`${baseURL}/${url.hostname}${url.pathname}${url.search}`, init)
        : originalFetch(input, init);
    };
    restoreEndpoints = configureProviderEndpoints({ falQueueBaseURL: baseURL, openaiBaseURL: baseURL });
    restoreEstimator = installFalDynamicEstimator(async () => ({ total_cost: 0.21, currency: "USD" }));
    configureProviderPollDriverForTests({ intervalMs: 50 });
    root = await mkdtemp(join(tmpdir(), "videobook-goal-short-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    const notebook = await engine.notebooks.create("Shorts");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    imageIds = await goalTestCharacters(engine, notebookId);
    saveMainCharacter(engine, { referenceArtifactIds: [imageIds[0]!] });
  });

  afterEach(async () => {
    await client.close();
    resetProviderPollDriverForTests();
    restoreEstimator();
    restoreEndpoints();
    globalThis.fetch = originalFetch;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const raw = (args: Record<string, unknown>) => client.callTool({ name: "video_goal", arguments: { book_id: bookId, notebook_id: notebookId, ...args } });
  const textOf = (result: Awaited<ReturnType<typeof raw>>) => (result.content as Array<{ text: string }>)[0]!.text;

  async function invoke(args: Record<string, unknown>): Promise<GoalSnapshot> {
    const result = await raw(args);
    expect(result.isError, textOf(result)).toBeFalsy();
    return JSON.parse(textOf(result)) as GoalSnapshot;
  }

  async function refusal(args: Record<string, unknown>): Promise<string> {
    const result = await raw(args);
    expect(result.isError, textOf(result)).toBe(true);
    return textOf(result);
  }

  const status = (goalId: string) => invoke({ action: "status", goal_id: goalId });
  const chainRuns = () => Object.keys(engine.settings.get<{ runs: Record<string, unknown> }>("application.chain-runs.v1")?.runs ?? {}).length;

  async function short(brief = AUTHORED): Promise<GoalSnapshot> {
    return status((await createShortGoal(engine, bookId, notebookId, { brief, requestId: uuidv7() })).goalId);
  }

  async function settled(goal: GoalSnapshot): Promise<GoalSnapshot> {
    await waitForChainRun(engine, goal.chainId!, testBudget(90_000));
    return status(goal.goalId);
  }

  async function approved(goal: GoalSnapshot): Promise<GoalSnapshot> {
    return settled(await invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision }));
  }

  function mediaJobs(model: string) {
    return engine.jobs.queue.list({ type: "generate_media", limit: 100 }).filter((job) => job.payload.model === model);
  }

  it("creates a short for the saved character, in review when authored and through the planner otherwise", async () => {
    const goal = await short();
    expect(goal).toMatchObject({ planVersion: 4, status: "review", stage: "frame", plan: null });
    expect(goal.shortPlan).toMatchObject({
      version: 4, aspectRatio: "9:16",
      character: { name: "Main character", description: "a man in a green shirt", silent: true, references: [{ artifactId: imageIds[0], slot: "@image1" }] },
      frame: { prompt: "He stands under a bus shelter at dusk.", model: "fal:openai/gpt-image-2.6/sunburst/edit", references: [] },
      segments: [{ prompt: "He checks the road for the bus.", seconds: 12 }],
    });
    expect(planned).toEqual([]);
    answers = [{ title: "Bus in the rain", frame: "He stands at a rainy bus stop at dusk.", beats: ["He checks the road, then steps back from a splash."] }];
    const planning = await createShortGoal(engine, bookId, notebookId, { brief: "he waits for a bus in the rain", requestId: uuidv7() });
    expect(planning).toMatchObject({ planVersion: 4, status: "planning", planningJobId: expect.any(Number) });
    await expect.poll(() => readGoal(engine, planning.goalId).status, { timeout: testBudget(30_000) }).toBe("review");
    expect(planned).toHaveLength(1);
    expect((await status(planning.goalId)).shortPlan).toMatchObject({ title: "Bus in the rain", segments: [{ seconds: 12 }] });
    const structured = await invoke({ action: "create", brief: "a bus stop short", plan: goal.shortPlan, request_id: "structured-short" });
    expect(structured).toMatchObject({ planVersion: 4, status: "review", shortPlan: { title: goal.shortPlan!.title } });
    expect((await invoke({ action: "create", brief: "a bus stop short", plan: goal.shortPlan, request_id: "structured-short" })).goalId).toBe(structured.goalId);
    expect((await invoke({ action: "create", brief: "@a2 waits for a bus" })).planVersion).toBe(3);
  });

  it("refuses a mentioned video by name and takes mentioned images as extra frame references", async () => {
    const video = await engine.artifacts.create("video", "Street clip");
    if (!video.ok) throw new Error(video.error.message);
    const inserted = await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({ type: "video", slot: { row: 0, column: 2 }, outputArtifactId: video.value.artifactId }));
    if (!inserted.ok) throw new Error(inserted.error.message);
    await expect(createShortGoal(engine, bookId, notebookId, { brief: `he waits by @a3, ${AUTHORED}`, requestId: uuidv7() }))
      .rejects.toThrow("@a3 is a video. Use Extract frame on it and mention the frame image instead.");
    const goal = await short(`he waits under @a2, ${AUTHORED}`);
    expect(goal.shortPlan?.frame.references).toEqual([expect.objectContaining({ artifactId: imageIds[1], slot: "@image2" })]);
  });

  it("fingerprints the frame and each segment by what they are made from", async () => {
    const plan = (await short()).shortPlan!;
    const frame = await shortFingerprint(engine, plan, "frame", 0, null);
    const moved = { ...plan, character: { ...plan.character, references: plan.character.references.map((reference) => ({ ...reference, address: "@h8" })) } };
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

  it("prices the frame and every segment, with H3 Max as a lower bound", async () => {
    const goal = await short('he waits, 20 seconds, frame: "A bus stop." beat 1: "He waits." beat 2: "He boards the bus."');
    expect(goal.estimate).toMatchObject({ frame: { usd: 0.21 }, videos: { usd: expect.any(Number) }, total: { usd: expect.any(Number) } });
    expect(goal.estimate.segments).toHaveLength(2);
    for (const segment of goal.estimate.segments!) expect(lowerBoundWarnings(segment.warnings), JSON.stringify(segment)).toBe(true);
    expect(goal.estimate.total.usd).toBeCloseTo(0.21 + goal.estimate.videos.usd!);
  });

  it("refuses the frame without a character reference, and copies the book's references at the first approval", async () => {
    saveMainCharacter(engine, { referenceArtifactIds: [] });
    const goal = await short();
    expect(goal.shortPlan?.character.references).toEqual([]);
    expect(await refusal({ action: "approve", goal_id: goal.goalId, revision: goal.revision })).toBe(NO_CHARACTER_REFERENCE);
    expect(chainRuns()).toBe(0);
    saveMainCharacter(engine, { referenceArtifactIds: [imageIds[1]!] });
    const started = await invoke({ action: "approve", goal_id: goal.goalId, revision: goal.revision });
    expect(started.shortPlan?.character.references.map((reference) => [reference.artifactId, reference.slot])).toEqual([[imageIds[1], "@image1"]]);
    await expect.poll(() => mediaJobs("fal:openai/gpt-image-2.6/sunburst/edit").length, { timeout: testBudget(15_000) }).toBe(1);
    expect(mediaJobs("fal:openai/gpt-image-2.6/sunburst/edit")[0]!.payload).toMatchObject({ refs: { image: [imageIds[1]] } });
    await settled(started);
  });

  it("generates the frame and the base clip through fal, then opens the finish review on that clip", async () => {
    const goal = await short(`he waits under @a2, ${AUTHORED}`);
    const frame = await approved(goal);
    expect(submissions.map((submission) => submission.path)).toEqual(["/openai/gpt-image-2.6/sunburst/edit"]);
    expect(submissions[0]!.body).toMatchObject({ image_size: "portrait_16_9", quality: "high", output_format: "jpeg" });
    expect(String(submissions[0]!.body.prompt)).toContain(SHORT_RULES.frame);
    expect(submissions[0]!.body.image_urls).toHaveLength(2);
    expect(mediaJobs("fal:openai/gpt-image-2.6/sunburst/edit")[0]?.payload).toMatchObject({ refs: { image: [imageIds[0], imageIds[1]] }, options: { image_size: "portrait_16_9" } });
    expect(frame).toMatchObject({ stage: "videos", status: "review", error: null });
    const frameId = frame.stages.frame!.outputs[0]!.artifactId;
    const clip = await approved(frame);
    const submitted = submissions.find((submission) => submission.path === "/minimax/h3-max/reference-to-video")!;
    expect(submitted.body).toMatchObject({ duration: 12, resolution: "1080P", aspect_ratio: "9:16", prompt_expansion_mode: "disabled", image_url: expect.stringMatching(/^http/u) });
    expect(submitted.body.reference_image_urls).toHaveLength(1);
    expect(String(submitted.body.prompt)).toContain(`${SHORT_RULES.video}\n\n${SHORT_RULES.silence}`);
    expect(mediaJobs("fal:minimax/h3-max/reference-to-video")[0]?.payload).toMatchObject({ refs: { first_frame: [frameId], image: [imageIds[0]] } });
    const clipId = clip.stages.videos!.outputs[0]!.artifactId;
    expect(clip).toMatchObject({ stage: "videos", status: "review", finish: { status: "review", sourceArtifactId: clipId } });
    expect((await invoke({ action: "finish", goal_id: goal.goalId })).finish).toMatchObject({ status: "review", sourceArtifactId: clipId });
    expect(await refusal({ action: "approve", goal_id: goal.goalId, revision: clip.revision })).toBe("Every segment of this short is generated. Finish it, or regenerate a segment.");
    expect(await refusal({ action: "combine", goal_id: goal.goalId })).toBe("A short is one clip extended in place, so it has no assembly or combine.");
    expect(unexpected).toEqual([]);
  });

  it("regenerates, revises, selects versions and retries the frame and the base clip", async () => {
    const goal = await short();
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
    const revised = await settled(await invoke({ action: "revise", goal_id: goal.goalId, revision: later.revision, stage: "videos", index: 0, feedback: "Make the rain heavier." }));
    expect(String(submissions.at(-1)!.body.prompt)).toMatch(/Make the rain heavier\.$/u);
    expect(revised.stages.videos!.outputs[0]!.stale).toBeNull();
    expect(revised.stages.videos!.outputs[0]!.versions).toHaveLength(2);
    expect(revised.finish).toMatchObject({ status: "review", sourceArtifactId: revised.stages.videos!.outputs[0]!.artifactId });
    failNext = true;
    const failed = await settled(await invoke({ action: "regenerate", goal_id: goal.goalId, revision: revised.revision, stage: "videos", index: 0 }));
    expect(failed).toMatchObject({ status: "failed", error: expect.stringContaining(REFUSAL) });
    const retried = await settled(await invoke({ action: "retry", goal_id: goal.goalId }));
    expect(retried).toMatchObject({ status: "review", stage: "videos" });
    expect(retried.stages.videos!.outputs[0]!.versions.length).toBeGreaterThanOrEqual(3);
    failNext = true;
    const failedAgain = await settled(await invoke({ action: "regenerate", goal_id: goal.goalId, revision: retried.revision, stage: "frame" }));
    expect(failedAgain.status).toBe("failed");
    const written = await engine.files.write(imageIds[0]!, "original.png", await sharp({ create: { width: 96, height: 128, channels: 3, background: "#123456" } }).png().toBuffer());
    if (!written.ok) throw new Error(written.error.message);
    expect(await refusal({ action: "retry", goal_id: goal.goalId })).toBe("The references or selected versions changed after this attempt. Regenerate using the current selection instead of retrying the older request.");
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

  it("keeps a short's settings once its frame exists and refuses a beat it cannot continue yet", async () => {
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
    expect(await refusal({ action: "approve", goal_id: goal.goalId, revision: rewritten.revision })).toBe("Continuing a short is not available yet.");
  });
});
