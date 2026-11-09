import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { computeEstimate, type CostEstimate, type CostHints } from "@apicity/cost";
import { createWaveSpeed } from "@apicity/wavespeed";
import { WaveSpeedRunwaymlAleph2RequestSchema } from "@apicity/wavespeed/zod";
import type { Engine } from "videobook-engine";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { pauseBookQueueForTests, resumeBookQueueForTests, waitForJob } from "../queue.js";
import { runFfmpeg } from "../ffmpeg.js";
import { pollPendingProviderTasks } from "../tools/reconcile-project-work.js";
import { readProviderTaskStatus } from "../provider-task-status.js";
import { MODEL_ENTRIES } from "./catalog.js";
import { estimateGeneration } from "./cost.js";
import { resolveModel } from "./descriptor.js";
import { arrayBounds, propertyAt, toJsonSchema } from "./json-schema.js";
import { buildWireRequest, type WireRequestInput } from "./request.js";
import { configureProviderEndpoints } from "./endpoints.js";
import { previewGeneration } from "./preview.js";
import { applyPromptDialect } from "./prompt-dialects.js";
import { wavespeedDotPath } from "./wavespeed.js";
import type { SlotKind } from "./types.js";
import { testBudget } from "../test-budget.js";

const FRAME = "https://example.test/first.png";
const LAST = "https://example.test/last.png";
const KEYFRAME = "https://example.test/keyframe.png";
const CLIP = "https://example.test/clip.mp4";
const SONG = "https://example.test/song.mp3";
const SAMPLE: Readonly<Record<SlotKind, string>> = { image: FRAME, video: CLIP, audio: SONG };
const IMAGE_REF = "22222222-2222-4222-8222-222222222222";
const VIDEO_REF = "33333333-3333-4333-8333-333333333333";
const AUDIO_REF = "44444444-4444-4444-8444-444444444444";

interface Recorded {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
}

function request(id: string, call: WireRequestInput): Record<string, unknown> {
  const built = buildWireRequest(resolveModel(id), call);
  if (!built.ok) throw new Error(built.error);
  return built.request;
}

function readBody(incoming: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => resolve(Buffer.concat(chunks).toString()));
    incoming.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function submitPaths(node: unknown, path: readonly string[]): string[] {
  if (typeof node === "function") return "schema" in node ? [path.join(".")] : [];
  if (node === null || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, child]) => submitPaths(child, [...path, key]));
}

async function estimateUnits(id: string, call: WireRequestInput, hints: CostHints = {}): Promise<number | undefined> {
  const result = await estimateGeneration(resolveModel(id), call, hints);
  if (!result.ok) throw new Error(result.error);
  expect(result.estimate.warnings, id).toEqual([]);
  return result.estimate.breakdown.units;
}

describe("WaveSpeed catalog", () => {
  const wavespeed = MODEL_ENTRIES.filter((entry) => entry.id.startsWith("wavespeed:"));

  it("catalogs every WaveSpeed video endpoint apicity publishes and prices each one", () => {
    const published = submitPaths(createWaveSpeed({ apiKey: "offline" }).api, ["api"]);
    expect(wavespeed.map((entry) => wavespeedDotPath(entry.id.slice("wavespeed:".length))).sort()).toEqual(published.sort());
    for (const entry of wavespeed) {
      const model = resolveModel(entry.id);
      expect(model.title).toMatch(/\(WaveSpeed\)$/u);
      expect(model.media).toBe("video");
      const refs: NonNullable<WireRequestInput["refUrls"]> = {};
      for (const slot of model.slots) {
        if (slot.min > 0) refs[slot.role] = Array.from({ length: slot.min }, () => SAMPLE[slot.kind]);
      }
      const built = request(entry.id, { prompt: "a red boat", refUrls: refs });
      const estimate = computeEstimate({ provider: "wavespeed", payload: built, endpoint: model.apiId, costHints: { inputDurationSeconds: 5 } });
      expect(estimate.usd, entry.id).toBeGreaterThan(0);
    }
  });

  it("maps WaveSpeed's image lists, reference media and source videos onto roles", () => {
    expect(request("wavespeed:alibaba/happyhorse-1.0/video-edit", { prompt: "make it night", refUrls: { video: [CLIP], image: [FRAME, LAST] } }))
      .toMatchObject({ video: CLIP, images: [FRAME, LAST] });
    expect(request("wavespeed:kwaivgi/kling-video-o3-pro/video-edit", { prompt: "make it night", refUrls: { video: [CLIP], image: [FRAME] } }))
      .toMatchObject({ video: CLIP, images: [FRAME] });
    expect(request("wavespeed:alibaba/wan-2.7/video-edit", { prompt: "make it night", refUrls: { video: [CLIP], image: [FRAME] } }))
      .toMatchObject({ video: CLIP, reference_images: [FRAME] });
    expect(request("wavespeed:bytedance/seedance-2.0/video-edit", { prompt: "make it night", refUrls: { video: [CLIP], image: [FRAME], audio: [SONG] } }))
      .toMatchObject({ video: CLIP, reference_images: [FRAME], reference_audios: [SONG] });
    expect(request("wavespeed:bytedance/seedance-2.0/reference-to-video", { prompt: "a walk", refUrls: { image: [FRAME], video: [CLIP], audio: [SONG] } }))
      .toMatchObject({ reference_images: [FRAME], reference_videos: [CLIP], reference_audios: [SONG] });
    expect(request("wavespeed:google/gemini-omni-1.1-flash/reference-to-video", { prompt: "a walk", refUrls: { image: [FRAME], video: [CLIP] } }))
      .toMatchObject({ images: [FRAME], reference_videos: [CLIP] });
    expect(request("wavespeed:alibaba/happyhorse-1.1/reference-to-video", { prompt: "a walk", refUrls: { image: [FRAME, LAST] } }))
      .toMatchObject({ images: [FRAME, LAST] });
    expect(request("wavespeed:x-ai/grok-imagine-video-v1.5/reference-to-video", { prompt: "a walk", refUrls: { image: [FRAME] } }))
      .toMatchObject({ reference_images: [FRAME] });
    for (const id of ["wavespeed:alibaba/happyhorse-1.1/reference-to-video", "wavespeed:x-ai/grok-imagine-video-v1.5/reference-to-video"]) {
      expect(buildWireRequest(resolveModel(id), { prompt: "a walk" })).toEqual({ ok: false, error: `${id} requires at least 1 image ref` });
    }
    expect(resolveModel("wavespeed:kwaivgi/kling-video-o3-pro/video-edit")).toMatchObject({ title: "Kling o3 Pro Edit (WaveSpeed)", entry: { operations: ["edit_video"], guide: "kling30" } });
  });

  it("places Runway Aleph 2 keyframes at the first frame, timed positions and the last frame", () => {
    const aleph = resolveModel("wavespeed:runwayml/aleph-2");
    const cap = arrayBounds(propertyAt(toJsonSchema(WaveSpeedRunwaymlAleph2RequestSchema), "keyframe_images")!).max;
    expect(aleph).toMatchObject({ title: "Runway Aleph 2 Edit (WaveSpeed)", entry: { operations: ["edit_video"], inputLimits: [{ max: cap }] } });
    expect(aleph.slots.map((slot) => [slot.role, slot.min, slot.max])).toEqual([["first_frame", 0, 1], ["last_frame", 0, 1], ["video", 1, 1], ["keyframe", 0, cap]]);
    expect(aleph.slots.find((slot) => slot.role === "keyframe")?.itemParams.map((param) => param.name)).toEqual(["timestamp_s"]);
    expect(request(aleph.id, {
      prompt: "turn the street to snow",
      refUrls: { video: [CLIP], first_frame: [FRAME], keyframe: [KEYFRAME, FRAME], last_frame: [LAST] },
      refParams: { keyframe: [{ timestamp_s: 2 }, { timestamp_s: 4.5 }] },
    })).toEqual({
      prompt: "turn the street to snow",
      video: CLIP,
      keyframe_images: [FRAME, KEYFRAME, FRAME, LAST],
      keyframe_positions: ["first", "2", "4.5", "last"],
    });
    expect(request(aleph.id, { prompt: "turn the street to snow", refUrls: { video: [CLIP] } })).toEqual({ prompt: "turn the street to snow", video: CLIP });
    expect(buildWireRequest(aleph, { prompt: "snow", refUrls: { video: [CLIP], keyframe: [KEYFRAME] } }))
      .toEqual({ ok: false, error: "Keyframes: set keyframe 1's time in seconds" });
    expect(buildWireRequest(aleph, {
      prompt: "snow",
      refUrls: { video: [CLIP], first_frame: [FRAME], keyframe: Array.from({ length: cap! }, () => KEYFRAME) },
      refParams: { keyframe: Array.from({ length: cap! }, (_, index) => ({ timestamp_s: index + 1 })) },
    })).toEqual({ ok: false, error: `Keyframes: First, last and timed keyframes together can't exceed ${cap}` });
    const preview = previewGeneration({ model: aleph.id, prompt: "snow", refs: { video: [CLIP] } });
    expect(preview.ok && preview.preview.providerPath).toBe("wavespeed.api.v3.runwayml.aleph2(request)");
  });

  it("names connected references in each new endpoint's prompt syntax", () => {
    const rewrite = (id: string, prompt: string, refs: Parameters<typeof applyPromptDialect>[2]) => applyPromptDialect(resolveModel(id).entry.dialect, prompt, refs);
    expect(rewrite("wavespeed:alibaba/happyhorse-1.1/reference-to-video", "@image1 gallops", { image: [IMAGE_REF] })).toBe("[Image 1] gallops");
    expect(rewrite("wavespeed:alibaba/happyhorse-1.0/video-edit", "dress @video1 like @image1", { video: [VIDEO_REF], image: [IMAGE_REF] }))
      .toBe("dress the source video like reference image 1");
    expect(rewrite("wavespeed:bytedance/seedance-2.0/reference-to-video", "@image1 dances to @audio1 like @video1", { image: [IMAGE_REF], video: [VIDEO_REF], audio: [AUDIO_REF] }))
      .toBe("@Image1 dances to @Audio1 like @Video1");
    expect(rewrite("wavespeed:kwaivgi/kling-video-o3-pro/video-edit", "give @video1 the coat from @image1", { video: [VIDEO_REF], image: [IMAGE_REF] }))
      .toBe("give the source video the coat from reference image 1");
    expect(rewrite("wavespeed:runwayml/aleph-2", "@firstframe @keyframe1 turn @video1 to winter", { first_frame: [IMAGE_REF], keyframe: ["55555555-5555-4555-8555-555555555555"], video: [VIDEO_REF] }))
      .toBe("turn the source video to winter");
  });

  it("bills the new edits by their source video and Seedance 2.0 references by their reference videos", async () => {
    const edit = { prompt: "make it night", refUrls: { video: [CLIP] } };
    expect(await estimateUnits("wavespeed:alibaba/happyhorse-1.0/video-edit", edit, { inputDurationSeconds: 4.2 })).toBe(5);
    expect(await estimateUnits("wavespeed:alibaba/happyhorse-1.0/video-edit", edit, { inputDurationSeconds: 1 })).toBe(3);
    expect(await estimateUnits("wavespeed:kwaivgi/kling-video-o3-pro/video-edit", edit, { inputDurationSeconds: 20 })).toBe(15);
    expect(await estimateUnits("wavespeed:runwayml/aleph-2", edit, { inputDurationSeconds: 40 })).toBe(30);
    expect(await estimateUnits("wavespeed:alibaba/wan-2.7/video-edit", edit, { inputDurationSeconds: 4.2 })).toBe(5);
    expect(await estimateUnits("wavespeed:alibaba/wan-2.7/video-edit", { ...edit, options: { duration: 8 } })).toBe(8);
    expect(await estimateUnits("wavespeed:bytedance/seedance-2.0/video-edit", edit, { inputDurationSeconds: 6 })).toBe(12);
    const references = { prompt: "a walk", refUrls: { video: [CLIP, CLIP] }, options: { duration: 5 } };
    expect(await estimateUnits("wavespeed:bytedance/seedance-2.0/reference-to-video", references, { inputDurationSeconds: 7 })).toBe(12);
    expect(await estimateUnits("wavespeed:google/gemini-omni-1.1-flash/reference-to-video", references)).toBe(5);
    const unpriced = await estimateGeneration(resolveModel("wavespeed:runwayml/aleph-2"), edit);
    expect(unpriced.ok && unpriced.estimate).toMatchObject({ usd: 0, warnings: [expect.stringContaining("inputDurationSeconds")] });
  });

  it("maps frames, references and the edited video onto WaveSpeed's fields", () => {
    expect(request("wavespeed:minimax/h3/image-to-video", { prompt: "the cat blinks", refUrls: { first_frame: [FRAME], last_frame: [LAST] }, options: { duration: 6 } }))
      .toMatchObject({ prompt: "the cat blinks", image: FRAME, last_image: LAST, duration: 6 });
    expect(request("wavespeed:alibaba/wan-3.0/reference-to-video", { prompt: "a walk", refUrls: { image: [FRAME], video: [CLIP], audio: [SONG] } }))
      .toMatchObject({ reference_images: [FRAME], reference_videos: [CLIP], reference_audios: [SONG] });
    expect(request("wavespeed:bytedance/seedance-2.5/video-edit", { prompt: "make it night", refUrls: { video: [CLIP], image: [FRAME] } }))
      .toMatchObject({ prompt: "make it night", video: CLIP, reference_images: [FRAME] });
    expect(resolveModel("wavespeed:x-ai/grok-imagine-video-v1.5/image-to-video").slots.map((slot) => slot.role)).toEqual(["first_frame"]);
  });

  it("offers WaveSpeed's durations and resolutions as options", () => {
    const options = Object.fromEntries(resolveModel("wavespeed:bytedance/seedance-2.5/text-to-video").options.map((option) => [option.name, option]));
    expect(options.duration).toMatchObject({ minimum: 4, maximum: 30 });
    expect(options.resolution?.enumValues).toEqual(["480p", "720p", "1080p", "4k"]);
  });

  it("previews the WaveSpeed method a cell would call", async () => {
    const preview = previewGeneration({ model: "wavespeed:minimax/h3/text-to-video", prompt: "a red boat" });
    expect(preview.ok && preview.preview.providerPath).toBe("wavespeed.api.v3.minimax.h3.textToVideo(request)");
  });

  it("drops frame mentions from prompts and names references in plain words", () => {
    const frames = resolveModel("wavespeed:minimax/h3/image-to-video").entry.dialect;
    expect(applyPromptDialect(frames, "@firstframe the cat blinks", { first_frame: ["11111111-1111-4111-8111-111111111111"] })).toBe("the cat blinks");
    const references = resolveModel("wavespeed:alibaba/wan-3.0/reference-to-video").entry.dialect;
    expect(applyPromptDialect(references, "@image1 walks", { image: ["22222222-2222-4222-8222-222222222222"] })).toBe("reference image 1 walks");
  });
});

describe("WaveSpeed provider tasks", () => {
  const PREDICTION_ID = "ws-prediction-0001";
  let fixtures: string;
  let mp4: Buffer;
  let server: Server;
  let baseURL: string;
  let recorded: Recorded[];
  let prediction: { code: number; body: Record<string, unknown> };
  let root: string;
  let engine: Engine;
  let client: Client;
  let restoreEndpoints: () => void;
  let originalKey: string | undefined;

  function route(method: string, path: string, response: ServerResponse): void {
    if (method === "GET" && path === "/outputs/clip.mp4") {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end(mp4);
      return;
    }
    if (method === "GET" && path === `/api/v3/predictions/${PREDICTION_ID}/result`) return sendJson(response, prediction.code, prediction.body);
    if (method === "POST" && path.startsWith("/api/v3/")) {
      return sendJson(response, 200, { code: 200, message: "success", data: { id: PREDICTION_ID, model: path.slice("/api/v3/".length), status: "created", outputs: [] } });
    }
    sendJson(response, 404, { code: 404, message: "not found" });
  }

  function predicted(status: string, extra: Record<string, unknown> = {}): { code: number; body: Record<string, unknown> } {
    return { code: 200, body: { code: 200, message: "success", data: { id: PREDICTION_ID, model: "minimax/h3/image-to-video", status, outputs: [], error: "", ...extra } } };
  }

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-wavespeed-fixtures-"));
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-pix_fmt", "yuv420p", join(fixtures, "clip.mp4")]);
    mp4 = await readFile(join(fixtures, "clip.mp4"));
    server = createServer((incoming, response) => {
      void readBody(incoming).then((body) => {
        recorded.push({ method: incoming.method ?? "", path: incoming.url ?? "", authorization: incoming.headers.authorization, body });
        route(incoming.method ?? "", incoming.url ?? "", response);
      });
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
    recorded = [];
    prediction = predicted("processing");
    root = await mkdtemp(join(tmpdir(), "videobook-wavespeed-"));
    engine = createEngineForTest(root);
    client = await createTestClient(root);
    await pauseBookQueueForTests(engine.book.get().bookId);
    originalKey = process.env.WAVESPEED_API_KEY;
    process.env.WAVESPEED_API_KEY = "local-wavespeed-key";
    restoreEndpoints = configureProviderEndpoints({ wavespeedBaseURL: baseURL });
  });

  afterEach(async () => {
    restoreEndpoints();
    await client.close();
    if (originalKey === undefined) delete process.env.WAVESPEED_API_KEY;
    else process.env.WAVESPEED_API_KEY = originalKey;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
    return (result.content as Array<{ text: string }>)[0]!.text;
  }

  async function submitted(): Promise<string> {
    const bookId = engine.book.get().bookId;
    const result = await client.callTool({
      name: "generate_video",
      arguments: { book_id: bookId, model: "wavespeed:minimax/h3/image-to-video", prompt: "the cat blinks", refs: { first_frame: [FRAME] }, options: { duration: 6 } },
    });
    expect(result.isError, toolText(result)).toBeFalsy();
    const enqueued = JSON.parse(toolText(result)) as { asset_id: string; job_id: string };
    await resumeBookQueueForTests(bookId);
    await waitForJob(enqueued.job_id, testBudget(30_000));
    return enqueued.asset_id;
  }

  it("submits, polls and downloads a WaveSpeed video with the API key", async () => {
    const assetId = await submitted();
    const submit = recorded.find((entry) => entry.method === "POST")!;
    expect(submit.path).toBe("/api/v3/minimax/h3/image-to-video");
    expect(submit.authorization).toBe("Bearer local-wavespeed-key");
    expect(JSON.parse(submit.body)).toEqual({ prompt: "the cat blinks", image: FRAME, duration: 6, resolution: "2k" });
    const pending = engine.jobs.pending.read(assetId);
    expect(pending.ok && pending.value).toMatchObject({
      taskId: PREDICTION_ID,
      taskType: "wavespeed_media",
      meta: { model: "wavespeed:minimax/h3/image-to-video", media: "video", wavespeedModel: "minimax/h3/image-to-video" },
    });
    const listPrice = computeEstimate({ provider: "wavespeed", payload: { prompt: "the cat blinks", image: FRAME, duration: 6, resolution: "2k" }, endpoint: "minimax/h3/image-to-video" }).usd;
    expect(engine.usage.recent(10).find((entry) => entry.artifactId === assetId)).toMatchObject({
      provider: "wavespeed", model: "minimax/h3/image-to-video", activity: "video", status: "pending",
      externalId: PREDICTION_ID, basis: "estimated", costUsd: expect.closeTo(listPrice, 6), warnings: [],
    });
    expect(await readProviderTaskStatus(engine, assetId)).toEqual({ provider: "wavespeed", model: "minimax/h3/image-to-video", taskId: PREDICTION_ID });

    const bookId = engine.book.get().bookId;
    const running = await pollPendingProviderTasks(engine, bookId);
    expect(running.pending).toEqual([expect.objectContaining({ assetId, taskType: "wavespeed_media", state: "processing" })]);
    expect(recorded.find((entry) => entry.path === `/api/v3/predictions/${PREDICTION_ID}/result`)?.authorization).toBe("Bearer local-wavespeed-key");

    prediction = predicted("completed", { outputs: [`${baseURL}/outputs/clip.mp4`] });
    const done = await pollPendingProviderTasks(engine, bookId);
    expect(done.failed).toEqual([]);
    expect(done.completed).toEqual([expect.objectContaining({ assetId, taskType: "wavespeed_media" })]);
    await waitForJob(done.completed[0]!.jobId, testBudget(30_000));

    const stored = await engine.files.read(assetId, "original.mp4");
    expect(stored.ok && Buffer.from(stored.value)).toEqual(mp4);
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: null });
    expect(engine.usage.recent(10).find((entry) => entry.artifactId === assetId)).toMatchObject({ status: "completed" });
  });

  it("submits a Runway Aleph 2 edit and its keyframes to WaveSpeed's task-less Aleph endpoint", async () => {
    const bookId = engine.book.get().bookId;
    const result = await client.callTool({
      name: "generate_video",
      arguments: {
        book_id: bookId,
        model: "wavespeed:runwayml/aleph-2",
        prompt: "turn the street to snow",
        refs: { video: [CLIP], first_frame: [FRAME], keyframe: [KEYFRAME] },
        ref_params: { keyframe: [{ timestamp_s: 2.5 }] },
      },
    });
    expect(result.isError, toolText(result)).toBeFalsy();
    const enqueued = JSON.parse(toolText(result)) as { asset_id: string; job_id: string };
    await resumeBookQueueForTests(bookId);
    await waitForJob(enqueued.job_id, testBudget(30_000));
    const submit = recorded.find((entry) => entry.method === "POST")!;
    expect(submit.path).toBe("/api/v3/runwayml/aleph-2");
    expect(JSON.parse(submit.body)).toEqual({
      prompt: "turn the street to snow",
      video: CLIP,
      keyframe_images: [FRAME, KEYFRAME],
      keyframe_positions: ["first", "2.5"],
    });
    expect(engine.jobs.pending.read(enqueued.asset_id)).toMatchObject({
      ok: true,
      value: { taskId: PREDICTION_ID, taskType: "wavespeed_media", meta: { model: "wavespeed:runwayml/aleph-2", wavespeedModel: "runwayml/aleph-2" } },
    });
  });

  it("fails a WaveSpeed prediction the provider reports as failed", async () => {
    const assetId = await submitted();
    prediction = predicted("failed", { error: "content policy violation" });
    const polled = await pollPendingProviderTasks(engine, engine.book.get().bookId);
    expect(polled.failed).toEqual([expect.objectContaining({ assetId, failMsg: "content policy violation" })]);
    const failure = engine.jobs.failures.read(assetId);
    expect(failure.ok && failure.value?.message).toBe("content policy violation");
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: null });
  });

  it("keeps polling through WaveSpeed rate limits but fails a prediction WaveSpeed no longer knows", async () => {
    const assetId = await submitted();
    const bookId = engine.book.get().bookId;
    prediction = { code: 429, body: { code: 429, message: "Too Many Requests" } };
    const limited = await pollPendingProviderTasks(engine, bookId);
    expect(limited.failed).toEqual([expect.objectContaining({ assetId, failMsg: "WaveSpeed API error 429: Too Many Requests" })]);
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: expect.objectContaining({ taskId: PREDICTION_ID }) });

    prediction = { code: 404, body: { code: 404, message: "prediction not found" } };
    await pollPendingProviderTasks(engine, bookId);
    const failure = engine.jobs.failures.read(assetId);
    expect(failure.ok && failure.value?.message).toBe("WaveSpeed API error 404: prediction not found");
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: null });
  });

  it("refuses WaveSpeed generation without WAVESPEED_API_KEY and leaves its predictions unpolled", async () => {
    const assetId = await submitted();
    recorded = [];
    delete process.env.WAVESPEED_API_KEY;
    const before = engine.artifacts.list().length;
    const refused = await client.callTool({
      name: "generate_video",
      arguments: { book_id: engine.book.get().bookId, model: "wavespeed:minimax/h3/text-to-video", prompt: "a red boat" },
    });
    expect(refused.isError).toBe(true);
    expect(toolText(refused)).toBe("WAVESPEED_API_KEY environment variable is not set");
    expect(engine.artifacts.list()).toHaveLength(before);

    const polled = await pollPendingProviderTasks(engine, engine.book.get().bookId);
    expect(polled).toEqual({ pending: [], completed: [], failed: [] });
    expect(recorded).toEqual([]);
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: expect.objectContaining({ taskId: PREDICTION_ID }) });
  });
});

describe("WaveSpeed cost hints from book videos", () => {
  let root: string;
  let engine: Engine;
  let client: Client;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-wavespeed-cost-"));
    engine = createEngineForTest(root);
    client = await createTestClient(root);
  });

  afterEach(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function bookVideo(seconds: number): Promise<string> {
    const asset = await engine.artifacts.create("video", `source-${seconds}`);
    if (!asset.ok) throw new Error(asset.error.message);
    await engine.metadata.artifacts.write(asset.value.artifactId, "original", { duration: seconds });
    return `@${asset.value.artifactId}`;
  }

  async function estimate(model: string, refs: Record<string, string[]>, options: Record<string, unknown> = {}): Promise<CostEstimate> {
    const result = await client.callTool({
      name: "estimate_cost",
      arguments: { calls: [{ tool_name: "generate_video", input: { book_id: engine.book.get().bookId, model, prompt: "make it night", refs, options } }] },
    });
    return (JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { estimate: CostEstimate }).estimate;
  }

  it("prices each new edit from its connected source video and Seedance 2.0 references from theirs", async () => {
    const source = await bookVideo(4.2);
    const edits: Array<[string, number]> = [
      ["wavespeed:alibaba/happyhorse-1.0/video-edit", 5],
      ["wavespeed:alibaba/wan-2.7/video-edit", 5],
      ["wavespeed:bytedance/seedance-2.0/video-edit", 10],
      ["wavespeed:kwaivgi/kling-video-o3-pro/video-edit", 5],
      ["wavespeed:runwayml/aleph-2", 5],
    ];
    for (const [model, units] of edits) {
      const priced = await estimate(model, { video: [source] });
      expect(priced, model).toMatchObject({ warnings: [], breakdown: { units } });
      expect(priced.usd, model).toBeGreaterThan(0);
    }
    const references = [await bookVideo(3), await bookVideo(4)];
    expect(await estimate("wavespeed:bytedance/seedance-2.0/reference-to-video", { video: references }, { duration: 5 }))
      .toMatchObject({ warnings: [], breakdown: { units: 12 } });
    const remote = await estimate("wavespeed:kwaivgi/kling-video-o3-pro/video-edit", { video: [CLIP] });
    expect(remote.usd).toBe(0);
    expect(remote.warnings.join(" ")).toContain("inputDurationSeconds");
  });
});
