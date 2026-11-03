import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { computeEstimate } from "@apicity/cost";
import type { Engine } from "videobook-engine";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { pauseBookQueueForTests, resumeBookQueueForTests, waitForJob } from "../queue.js";
import { runFfmpeg } from "../ffmpeg.js";
import { pollPendingProviderTasks } from "../tools/reconcile-project-work.js";
import { readProviderTaskStatus } from "../provider-task-status.js";
import { MODEL_ENTRIES } from "./catalog.js";
import { resolveModel } from "./descriptor.js";
import { buildWireRequest, type WireRequestInput } from "./request.js";
import { configureProviderEndpoints } from "./endpoints.js";
import { previewGeneration } from "./preview.js";
import { applyPromptDialect } from "./prompt-dialects.js";
import { testBudget } from "../test-budget.js";

const FRAME = "https://example.test/first.png";
const LAST = "https://example.test/last.png";
const CLIP = "https://example.test/clip.mp4";
const SONG = "https://example.test/song.mp3";

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

describe("WaveSpeed catalog", () => {
  const wavespeed = MODEL_ENTRIES.filter((entry) => entry.id.startsWith("wavespeed:"));

  it("catalogs every WaveSpeed video endpoint apicity publishes and prices each one", () => {
    expect(wavespeed).toHaveLength(23);
    for (const entry of wavespeed) {
      const model = resolveModel(entry.id);
      expect(model.title).toMatch(/\(WaveSpeed\)$/u);
      expect(model.media).toBe("video");
      const roles = Object.fromEntries(model.slots.map((slot) => [slot.role, slot.field]));
      const refs: NonNullable<WireRequestInput["refUrls"]> = {};
      if (roles.first_frame) refs.first_frame = [FRAME];
      if (model.entry.operations.includes("edit_video")) refs.video = [CLIP];
      const built = request(entry.id, { prompt: "a red boat", refUrls: refs });
      const estimate = computeEstimate({ provider: "wavespeed", payload: built, endpoint: model.apiId, costHints: { inputDurationSeconds: 5 } });
      expect(estimate.usd, entry.id).toBeGreaterThan(0);
    }
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
