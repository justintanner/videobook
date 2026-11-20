import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { PRICING, computeEstimate, type CostHints } from "@apicity/cost";
import {
  NunchuxAlibabaVideoSynthesisRequestSchema,
  NunchuxBytedanceGenerationTasksRequestSchema,
  NunchuxGoogleInteractionsRequestSchema,
  NunchuxMinimaxVideoGenerationRequestSchema,
} from "@apicity/nunchux";
import type { Engine } from "videobook-engine";
import type { ZodType } from "zod";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { pauseBookQueueForTests, resumeBookQueueForTests, waitForJob } from "../queue.js";
import { runFfmpeg } from "../ffmpeg.js";
import { pollPendingProviderTasks } from "../tools/reconcile-project-work.js";
import { readProviderTaskStatus } from "../provider-task-status.js";
import { testBudget } from "../test-budget.js";
import { MODEL_ENTRIES } from "./catalog.js";
import { estimateGeneration } from "./cost.js";
import { resolveModel } from "./descriptor.js";
import { configureProviderEndpoints } from "./endpoints.js";
import { modelFrontierRankings } from "./frontier.js";
import { FRONTIER_CATALOG_GAPS } from "./frontier-gaps.js";
import { resolveGenerationSource } from "./generation-source.js";
import { previewGeneration } from "./preview.js";
import { applyPromptDialect } from "./prompt-dialects.js";
import { buildWireRequest, type WireRequestInput } from "./request.js";
import type { MediaRefs, SlotKind } from "./types.js";

const FRAME = "https://example.test/first.png";
const LAST = "https://example.test/last.png";
const CLIP = "https://example.test/clip.mp4";
const SONG = "https://example.test/song.mp3";
const SAMPLE: Readonly<Record<SlotKind, string>> = { image: FRAME, video: CLIP, audio: SONG };
const IMAGE_REF = "22222222-2222-4222-8222-222222222222";
const VIDEO_REF = "33333333-3333-4333-8333-333333333333";

const PRICED = Object.keys((PRICING as unknown as Record<string, Record<string, unknown>>).nunchux!).sort();
const UNPRICED = [
  "wan3.0-video-prime", "wan2.7-t2v", "wan2.7-i2v", "wan2.7-r2v",
  "happyhorse-1.1-t2v", "happyhorse-1.1-i2v", "happyhorse-1.1-r2v",
  "happyhorse-1.0-t2v", "happyhorse-1.0-i2v", "happyhorse-1.0-r2v",
  "gemini-3.1-flash-image", "gemini-3-pro-image",
].sort();

const REQUEST_SCHEMAS: Readonly<Record<string, ZodType>> = {
  "wan3.0-video": NunchuxAlibabaVideoSynthesisRequestSchema,
  "wan2.7-videoedit": NunchuxAlibabaVideoSynthesisRequestSchema,
  "happyhorse-1.0-video-edit": NunchuxAlibabaVideoSynthesisRequestSchema,
  "dreamina-seedance-2-5-260628": NunchuxBytedanceGenerationTasksRequestSchema,
  "dreamina-seedance-2-0-260128": NunchuxBytedanceGenerationTasksRequestSchema,
  "MiniMax-H3": NunchuxMinimaxVideoGenerationRequestSchema,
};

function enumModels(schema: ZodType): string[] {
  const model = (schema as unknown as { shape: { model: { options?: Array<{ options?: string[] }> } } }).shape.model;
  return model.options?.[0]?.options ?? [];
}

function request(id: string, call: WireRequestInput): Record<string, unknown> {
  const built = buildWireRequest(resolveModel(id), call);
  if (!built.ok) throw new Error(built.error);
  return built.request;
}

function refusal(id: string, call: WireRequestInput): string {
  const built = buildWireRequest(resolveModel(id), call);
  return built.ok ? "" : built.error;
}

async function estimate(id: string, call: WireRequestInput, hints: CostHints = {}): Promise<{ usd: number; warnings: string[] }> {
  const result = await estimateGeneration(resolveModel(id), call, hints);
  if (!result.ok) throw new Error(result.error);
  return { usd: result.estimate.usd, warnings: result.estimate.warnings };
}

function modeRefs(id: string, modeId: string): MediaRefs {
  const model = resolveModel(id);
  const mode = model.modes.find((candidate) => candidate.id === modeId)!;
  const role = mode.requireAny?.[0];
  const slot = role ? model.slots.find((candidate) => candidate.role === role) : undefined;
  return slot ? { [slot.role]: [SAMPLE[slot.kind]] } : {};
}

describe("Nunchux catalog", () => {
  const nunchux = MODEL_ENTRIES.filter((entry) => entry.id.startsWith("nunchux:"));

  it("catalogs every model @apicity/cost prices and none of the unpriced ids the schemas also accept", () => {
    expect(nunchux.map((entry) => entry.id.slice("nunchux:".length)).sort()).toEqual(PRICED);
    const accepted = [
      ...enumModels(NunchuxAlibabaVideoSynthesisRequestSchema),
      ...enumModels(NunchuxBytedanceGenerationTasksRequestSchema),
      ...enumModels(NunchuxGoogleInteractionsRequestSchema),
      ...enumModels(NunchuxMinimaxVideoGenerationRequestSchema),
    ];
    expect(accepted.filter((model) => !PRICED.includes(model)).sort()).toEqual(UNPRICED);
    expect(Object.keys(FRONTIER_CATALOG_GAPS).filter((key) => key.startsWith("nunchux:"))).toEqual([]);
  });

  it.each(PRICED.filter((apiId) => apiId !== "gemini-nano-banana-2.1" && !apiId.startsWith("gpt-image-")))("%s builds every mode as a request apicity's schema accepts and @apicity/cost prices", async (apiId) => {
    const id = `nunchux:${apiId}`;
    const model = resolveModel(id);
    expect(model.title).toMatch(/\(Nunchux\)$/u);
    expect(model.entry.hidden).toBeUndefined();
    for (const mode of model.modes) {
      const call = { prompt: "a red boat drifts", refUrls: modeRefs(id, mode.id), mode: mode.id };
      const built = request(id, call);
      expect(REQUEST_SCHEMAS[apiId]!.safeParse(built).success, `${id} ${mode.id}`).toBe(true);
      const priced = await estimate(id, call, { inputDurationSeconds: 5, aspectRatio: "9:16" });
      expect(priced.warnings, `${id} ${mode.id}`).toEqual([]);
      expect(priced.usd, `${id} ${mode.id}`).toBeGreaterThan(0);
    }
  });

  it("builds Nano Banana 2.1 text and edit requests that become apicity's inline-image body", async () => {
    const id = "nunchux:gemini-nano-banana-2.1";
    const model = resolveModel(id);
    expect(model).toMatchObject({ media: "image", title: "Nano Banana 2.1 (Nunchux)", entry: { operations: ["text_to_image", "edit_image"], guide: "nano_banana" } });
    expect(model.slots).toEqual([expect.objectContaining({ role: "image", field: "image_urls", min: 0, max: 14 })]);
    expect(request(id, { prompt: "a red boat" })).toEqual({
      model: "gemini-nano-banana-2.1",
      input: [{ type: "text", text: "a red boat" }],
      response_format: { type: "image", image_size: "2K", aspect_ratio: "9:16" },
    });
    const edit = request(id, { prompt: "add a hat", refUrls: { image: ["asset://a/original.png"] }, options: { resolution: "1K" } });
    expect(edit.input).toEqual([{ type: "text", text: "add a hat" }, { type: "image", ref: "asset://a/original.png" }]);
    const inline = { ...edit, input: [{ type: "text", text: "add a hat" }, { type: "image", data: "aGF0", mime_type: "image/png" }] };
    expect(NunchuxGoogleInteractionsRequestSchema.safeParse(inline).success).toBe(true);
    expect(refusal(id, { prompt: "x", refUrls: { image: Array.from({ length: 15 }, () => FRAME) } })).toMatch(/at most 14 image refs/u);
    expect((await estimate(id, { prompt: "a red boat", options: { resolution: "1K" } })).usd).toBeCloseTo(0.0336, 9);
    expect((await estimate(id, { prompt: "a red boat", options: { resolution: "4K" } })).usd).toBeCloseTo(0.113, 9);
  });

  it("maps frames and references onto Wan's media list and keeps them apart", () => {
    const wan = "nunchux:wan3.0-video";
    expect(request(wan, { prompt: "a walk", refUrls: { image: [FRAME], video: [CLIP], audio: [SONG] }, options: { resolution: "480P", duration: 2 } })).toEqual({
      model: "wan3.0-video",
      input: { prompt: "a walk", media: [
        { type: "reference_image", url: FRAME }, { type: "reference_video", url: CLIP }, { type: "reference_audio", url: SONG },
      ] },
      parameters: { resolution: "480P", duration: 2, watermark: false },
    });
    expect(request(wan, { prompt: "a walk", refUrls: { first_frame: [FRAME], last_frame: [LAST] } }).input)
      .toEqual({ prompt: "a walk", media: [{ type: "first_frame", url: FRAME }, { type: "last_frame", url: LAST }] });
    expect(refusal(wan, { prompt: "x", refUrls: { first_frame: [FRAME], image: [FRAME] } })).toMatch(/Frames can't be combined with reference media/u);
    expect(refusal(wan, { prompt: "x", refUrls: { last_frame: [LAST] } })).toMatch(/A last frame needs a first frame/u);
    expect(resolveModel(wan).entry.rules?.refDurationMs?.audio).toEqual({ minimum: 0, maximum: 15_000, maximumTotal: 15_000 });
  });

  it("sends Wan 2.7 and HappyHorse edits their source video and follows its length unless a duration is set", async () => {
    for (const [id, cap] of [["nunchux:wan2.7-videoedit", 10], ["nunchux:happyhorse-1.0-video-edit", 15]] as const) {
      const model = resolveModel(id);
      expect(model.slots.map((slot) => [slot.role, slot.field, slot.min, slot.max])).toEqual([["video", "video_url", 1, 1]]);
      expect(model.options.find((option) => option.name === "resolution")).toMatchObject({ enumValues: ["720P", "1080P"], defaultValue: "1080P" });
      expect(model.options.find((option) => option.name === "duration")).toMatchObject({ maximum: cap });
      const built = request(id, { prompt: "make it night", refUrls: { video: [CLIP] }, options: { resolution: "720P" } });
      expect(built).toEqual({ model: id.slice("nunchux:".length), input: { prompt: "make it night", media: [{ type: "video", url: CLIP }] }, parameters: { resolution: "720P", watermark: false } });
      expect(await estimate(id, { prompt: "make it night", refUrls: { video: [CLIP] } })).toMatchObject({ usd: 0, warnings: [expect.stringContaining("inputDurationSeconds")] });
    }
    expect((await estimate("nunchux:wan2.7-videoedit", { prompt: "night", refUrls: { video: [CLIP] }, options: { resolution: "720P" } }, { inputDurationSeconds: 4 })).usd).toBeCloseTo(8 * 0.1, 9);
    expect((await estimate("nunchux:happyhorse-1.0-video-edit", { prompt: "night", refUrls: { video: [CLIP] }, options: { resolution: "720P" } }, { inputDurationSeconds: 3 })).usd).toBeCloseTo(6 * 0.14, 9);
    expect(resolveModel("nunchux:wan2.7-videoedit").entry.rules?.refDurationMs?.video).toEqual({ minimum: 2000, maximum: 10_000, maximumTotal: 10_000 });
    expect(applyPromptDialect(resolveModel("nunchux:happyhorse-1.0-video-edit").entry.dialect, "dress @video1 like a painting", { video: [VIDEO_REF] }))
      .toBe("dress the source video like a painting");
  });

  it("orders Seedance content with the text first and a role on every frame and reference", async () => {
    const seedance = "nunchux:dreamina-seedance-2-5-260628";
    expect(request(seedance, { prompt: "the cat blinks", refUrls: { first_frame: [FRAME] }, options: { duration: 4, resolution: "480p", generate_audio: false } })).toEqual({
      model: "dreamina-seedance-2-5-260628",
      content: [{ type: "text", text: "the cat blinks" }, { type: "image_url", role: "first_frame", image_url: { url: FRAME } }],
      duration: 4, resolution: "480p", generate_audio: false,
    });
    expect(request(seedance, { prompt: "a walk", refUrls: { image: [FRAME], video: [CLIP], audio: [SONG] } }).content).toEqual([
      { type: "text", text: "a walk" },
      { type: "image_url", role: "reference_image", image_url: { url: FRAME } },
      { type: "video_url", role: "reference_video", video_url: { url: CLIP } },
      { type: "audio_url", role: "reference_audio", audio_url: { url: SONG } },
    ]);
    expect(resolveModel("nunchux:dreamina-seedance-2-0-260128").slots.map((slot) => [slot.role, slot.max]))
      .toEqual([["first_frame", 1], ["last_frame", 1], ["image", 9], ["video", 3], ["audio", 3]]);
    const frames = { prompt: "the cat blinks", refUrls: { first_frame: [FRAME] }, options: { duration: 4, resolution: "480p" } };
    expect((await estimate(seedance, frames)).warnings).toEqual([expect.stringContaining("costHints.aspectRatio")]);
    expect(await estimate(seedance, frames, { aspectRatio: "3:4" })).toMatchObject({ warnings: [], usd: expect.any(Number) });
    const dialect = resolveModel(seedance).entry.dialect;
    expect(applyPromptDialect(dialect, "@firstframe the cat blinks", { first_frame: [IMAGE_REF] })).toBe("the cat blinks");
    expect(applyPromptDialect(dialect, "@image1 waves", { image: [IMAGE_REF] })).toBe("reference image 1 waves");
  });

  it("sends MiniMax H3 a ratio only for text-to-video and caps its references at 12 files", () => {
    const h3 = "nunchux:MiniMax-H3";
    expect(request(h3, { prompt: "a boat", options: { aspect_ratio: "16:9", duration: 4, resolution: "768P" } }))
      .toEqual({ model: "MiniMax-H3", content: [{ type: "text", text: "a boat" }], resolution: "768P", duration: 4, ratio: "16:9" });
    const frames = request(h3, { prompt: "the cat blinks", refUrls: { first_frame: [FRAME] }, options: { aspect_ratio: "16:9" } });
    expect(frames).not.toHaveProperty("ratio");
    expect(resolveModel(h3).modes.find((mode) => mode.id === "i2v")?.omit).toEqual(["aspect_ratio"]);
    expect(refusal(h3, { prompt: "x", refUrls: { image: Array.from({ length: 9 }, () => FRAME), video: [CLIP, CLIP, CLIP], audio: [SONG] } }))
      .toMatch(/References can't exceed 12 files in all/u);
    expect(resolveModel(h3).entry.rules?.refDurationMs?.video).toEqual({ minimum: 2000, maximum: 15_000, maximumTotal: 15_000 });
  });

  it("ranks each Nunchux model on the boards it holds and previews its method", () => {
    const boards = (apiId: string) => modelFrontierRankings(`nunchux:${apiId}`).map((ranking) => [ranking.type, ranking.rank]);
    expect(boards("gemini-nano-banana-2.1")).toEqual([["t2i", 8], ["i2i", 10]]);
    expect(boards("gpt-image-2.6-sunburst")).toEqual([["t2i", 1], ["i2i", 2]]);
    expect(boards("gpt-image-2.6-flare")).toEqual([["t2i", 3], ["i2i", 3]]);
    expect(boards("wan3.0-video")).toEqual([["t2v", 1], ["r2v", 1]]);
    expect(boards("MiniMax-H3")).toEqual([["t2v", 3], ["i2v", 4], ["r2v", 3]]);
    expect(boards("dreamina-seedance-2-0-260128")).toEqual([["i2v", 3]]);
    expect(boards("wan2.7-videoedit")).toEqual([["v2v", 9]]);
    const preview = previewGeneration({ model: "nunchux:MiniMax-H3", prompt: "a boat", options: { aspect_ratio: "16:9" } });
    expect(preview.ok && preview.preview.providerPath).toBe("nunchux.v1.minimax.v2.videoGeneration(request)");
  });
});

describe("Nunchux cost hints and URL refs from the book", () => {
  let root: string;
  let engine: Engine;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-nunchux-source-"));
    engine = createEngineForTest(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function bookImage(width: number, height: number): Promise<string> {
    const created = await engine.artifacts.create("image", "frame");
    if (!created.ok) throw new Error(created.error.message);
    const png = await sharp({ create: { width, height, channels: 3, background: "#2878b4" } }).png().toBuffer();
    expect((await engine.files.write(created.value.artifactId, "original.png", png)).ok).toBe(true);
    expect((await engine.metadata.artifacts.write(created.value.artifactId, "original", { width, height })).ok).toBe(true);
    return created.value.artifactId;
  }

  it("prices a Seedance first frame at the supported ratio nearest the book image's shape", async () => {
    const seedance = resolveModel("nunchux:dreamina-seedance-2-0-260128");
    for (const [width, height, ratio] of [[96, 128, "3:4"], [1920, 1080, "16:9"], [2100, 900, "21:9"], [500, 520, "1:1"]] as const) {
      const frame = await bookImage(width, height);
      const source = await resolveGenerationSource(engine, seedance, { first_frame: [frame] });
      expect(source).toMatchObject({ ok: true, costHints: { aspectRatio: ratio } });
    }
    expect(await resolveGenerationSource(engine, seedance, { first_frame: [FRAME] })).toMatchObject({ ok: true, costHints: {} });
    expect(await resolveGenerationSource(engine, resolveModel("nunchux:MiniMax-H3"), { first_frame: [await bookImage(96, 128)] })).toMatchObject({ costHints: {} });
  });

  it("refuses a URL for a Nano Banana edit before any work, since Nunchux takes the image inline", async () => {
    const banana = resolveModel("nunchux:gemini-nano-banana-2.1");
    expect(await resolveGenerationSource(engine, banana, { image: [FRAME] })).toEqual({
      ok: false,
      error: `Nano Banana 2.1 (Nunchux) takes images from this book, not a URL (${FRAME}): Nunchux receives edit images as inline data`,
    });
    expect(await resolveGenerationSource(engine, banana, { image: [await bookImage(64, 64)] })).toMatchObject({ ok: true });
  });
});

interface Recorded {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
}

type Reply = { code: number; body: unknown };

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

const INVALID_KEY: Reply = {
  code: 401,
  body: { error: { code: "invalid_api_key", message: "Invalid or revoked API key.", request_id: "83879ae04d83408abf4e13cad4f718a4" }, request_id: "83879ae04d83408abf4e13cad4f718a4" },
};

describe("Nunchux provider tasks", () => {
  let fixtures: string;
  let mp4: Buffer;
  let png: Buffer;
  let server: Server;
  let baseURL: string;
  let recorded: Recorded[];
  let submitReply: Reply | null;
  let pollReply: Reply;
  let root: string;
  let engine: Engine;
  let client: Client;
  let restoreEndpoints: () => void;
  let originalKey: string | undefined;

  const SUBMIT_REPLIES: Readonly<Record<string, unknown>> = {
    "/v1/alibaba/services/aigc/video-generation/video-synthesis": { output: { task_id: "nunchux-wan-video-task", task_status: "PENDING" }, request_id: "0d8e3a0e-0a94-9c9c-82fa-8235806e5a5c" },
    "/v1/bytedance/contents/generations/tasks": { id: "nunchux-seedance-image-video-task" },
    "/v1/minimax/v2/video_generation": { task_id: "nunchux-minimax-task" },
  };

  function interaction(): unknown {
    return {
      id: "v1_nunchux-interaction", object: "interaction", model: "gemini-nano-banana-2.1", status: "completed",
      created: "2026-11-18T10:26:09Z", updated: "2026-11-18T10:26:09Z", service_tier: "standard",
      usage: { total_tokens: 2556 },
      steps: [{ type: "thought", signature: "c2ln" }, { type: "model_output", content: [{ type: "image", mime_type: "image/png", data: png.toString("base64") }] }],
    };
  }

  const GPT_USAGE = { input_tokens: 1220, input_tokens_details: { text_tokens: 20, image_tokens: 1200 }, output_tokens: 4160, output_tokens_details: { image_tokens: 4160 }, total_tokens: 5380 };

  function gptImage(): unknown {
    return { created: 1795170000, background: "opaque", output_format: "png", quality: "high", size: "1152x2048", data: [{ b64_json: png.toString("base64"), generation_id: "gen_nunchux_1" }], usage: GPT_USAGE };
  }

  function route(method: string, path: string, response: ServerResponse): void {
    if (method === "GET" && path === "/outputs/clip.mp4") {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end(mp4);
      return;
    }
    if (method === "POST" && submitReply) return sendJson(response, submitReply.code, submitReply.body);
    if (method === "POST" && path === "/v1/google/v1beta/interactions") return sendJson(response, 200, interaction());
    if (method === "POST" && path.startsWith("/v2/openai/images/")) return sendJson(response, 200, gptImage());
    if (method === "POST" && path in SUBMIT_REPLIES) return sendJson(response, 200, SUBMIT_REPLIES[path]);
    if (method === "GET") return sendJson(response, pollReply.code, pollReply.body);
    sendJson(response, 404, { detail: "Not found" });
  }

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-nunchux-fixtures-"));
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=green:s=64x64:d=1", "-pix_fmt", "yuv420p", join(fixtures, "clip.mp4")]);
    mp4 = await readFile(join(fixtures, "clip.mp4"));
    png = await sharp({ create: { width: 48, height: 64, channels: 3, background: "#cf593b" } }).png().toBuffer();
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
    submitReply = null;
    pollReply = { code: 404, body: { detail: "Not found" } };
    root = await mkdtemp(join(tmpdir(), "videobook-nunchux-"));
    engine = createEngineForTest(root);
    client = await createTestClient(root);
    await pauseBookQueueForTests(engine.book.get().bookId);
    originalKey = process.env.NUNCHUX_API_KEY;
    process.env.NUNCHUX_API_KEY = "local-nunchux-key";
    restoreEndpoints = configureProviderEndpoints({ nunchuxBaseURL: baseURL });
  });

  afterEach(async () => {
    restoreEndpoints();
    await client.close();
    if (originalKey === undefined) delete process.env.NUNCHUX_API_KEY;
    else process.env.NUNCHUX_API_KEY = originalKey;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
    return (result.content as Array<{ text: string }>)[0]!.text;
  }

  async function enqueued(tool: "generate_video" | "generate_image", args: Record<string, unknown>): Promise<{ assetId: string; jobId: string }> {
    const bookId = engine.book.get().bookId;
    const result = await client.callTool({ name: tool, arguments: { book_id: bookId, ...args } });
    expect(result.isError, toolText(result)).toBeFalsy();
    const { asset_id: assetId, job_id: jobId } = JSON.parse(toolText(result)) as { asset_id: string; job_id: string };
    await resumeBookQueueForTests(bookId);
    return { assetId, jobId };
  }

  async function submitted(args: Record<string, unknown>): Promise<string> {
    const { assetId, jobId } = await enqueued("generate_video", args);
    await waitForJob(jobId, testBudget(30_000));
    return assetId;
  }

  const FAMILIES = [
    {
      family: "alibaba",
      args: { model: "nunchux:wan3.0-video", prompt: "a walk across the floor", refs: { image: [FRAME] }, options: { resolution: "480P", duration: 2 } },
      submitPath: "/v1/alibaba/services/aigc/video-generation/video-synthesis",
      body: { model: "wan3.0-video", input: { prompt: "a walk across the floor", media: [{ type: "reference_image", url: FRAME }] }, parameters: { resolution: "480P", duration: 2, watermark: false } },
      taskId: "nunchux-wan-video-task",
      pollPath: "/v1/alibaba/tasks/nunchux-wan-video-task",
      running: { output: { task_id: "nunchux-wan-video-task", model: "wan3.0-video", resolution: "480P", duration: 2, task_status: "RUNNING" } },
      done: (url: string) => ({ output: { task_id: "nunchux-wan-video-task", model: "wan3.0-video", task_status: "SUCCEEDED", video_url: url }, usage: { output_video_duration: 2, duration: 2, video_count: 1 } }),
    },
    {
      family: "bytedance",
      args: { model: "nunchux:dreamina-seedance-2-5-260628", prompt: "the cat blinks", refs: { first_frame: [FRAME] }, options: { duration: 4, resolution: "480p", generate_audio: false } },
      submitPath: "/v1/bytedance/contents/generations/tasks",
      body: { model: "dreamina-seedance-2-5-260628", content: [{ type: "text", text: "the cat blinks" }, { type: "image_url", role: "first_frame", image_url: { url: FRAME } }], duration: 4, resolution: "480p", generate_audio: false },
      taskId: "nunchux-seedance-image-video-task",
      pollPath: "/v1/bytedance/contents/generations/tasks/nunchux-seedance-image-video-task",
      running: { id: "nunchux-seedance-image-video-task", model: "dreamina-seedance-2-5-260628", status: "running" },
      done: (url: string) => ({ id: "nunchux-seedance-image-video-task", model: "dreamina-seedance-2-5-260628", status: "succeeded", content: { video_url: url }, usage: { completion_tokens: 39820, total_tokens: 39820 }, ratio: "281:374", duration: 4 }),
    },
    {
      family: "minimax",
      args: { model: "nunchux:MiniMax-H3", prompt: "a red paper boat drifts", options: { aspect_ratio: "16:9", duration: 4, resolution: "768P" } },
      submitPath: "/v1/minimax/v2/video_generation",
      body: { model: "MiniMax-H3", content: [{ type: "text", text: "a red paper boat drifts" }], resolution: "768P", duration: 4, ratio: "16:9" },
      taskId: "nunchux-minimax-task",
      pollPath: "/v1/minimax/v2/query/video_generation/nunchux-minimax-task",
      running: { task: { id: "nunchux-minimax-task", model: "MiniMax-H3", status: "running" } },
      done: (url: string) => ({ task: { id: "nunchux-minimax-task", model: "MiniMax-H3", status: "succeeded", content: { url }, usage: { total_seconds: 4, input_seconds: 0, output_seconds: 4, input_image_count: 0 } } }),
    },
  ] as const;

  it.each(FAMILIES)("submits, polls and downloads a $family video with the Nunchux key", async ({ args, submitPath, body, taskId, pollPath, running, done }) => {
    const assetId = await submitted(args);
    const submit = recorded.find((entry) => entry.method === "POST")!;
    expect(submit).toMatchObject({ path: submitPath, authorization: "Bearer local-nunchux-key" });
    expect(JSON.parse(submit.body)).toEqual(body);
    expect(engine.jobs.pending.read(assetId)).toMatchObject({
      ok: true,
      value: { taskId, taskType: "nunchux_media", meta: { model: args.model, media: "video", nunchuxModel: args.model.slice("nunchux:".length) } },
    });
    const usage = () => engine.usage.recent(10).find((entry) => entry.artifactId === assetId);
    expect(usage()).toMatchObject({ provider: "nunchux", model: body.model, activity: "video", status: "pending", externalId: taskId });
    expect(await readProviderTaskStatus(engine, assetId)).toEqual({ provider: "nunchux", model: body.model, taskId });

    const bookId = engine.book.get().bookId;
    pollReply = { code: 200, body: running };
    const waiting = await pollPendingProviderTasks(engine, bookId);
    expect(waiting.pending).toEqual([expect.objectContaining({ assetId, taskType: "nunchux_media", state: "running" })]);
    expect(recorded.find((entry) => entry.path === pollPath)?.authorization).toBe("Bearer local-nunchux-key");

    pollReply = { code: 200, body: done(`${baseURL}/outputs/clip.mp4`) };
    const finished = await pollPendingProviderTasks(engine, bookId);
    expect(finished.failed).toEqual([]);
    expect(finished.completed).toEqual([expect.objectContaining({ assetId, taskType: "nunchux_media" })]);
    await waitForJob(finished.completed[0]!.jobId, testBudget(30_000));
    const stored = await engine.files.read(assetId, "original.mp4");
    expect(stored.ok && Buffer.from(stored.value)).toEqual(mp4);
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: null });
    expect(usage()).toMatchObject({ status: "completed" });
  });

  it("prices the Wan and MiniMax submissions from @apicity/cost", async () => {
    const [wan, , minimax] = FAMILIES;
    for (const family of [wan, minimax]) {
      const assetId = await submitted(family.args);
      const listPrice = computeEstimate({ provider: "nunchux", payload: family.body as unknown as Record<string, unknown> }).usd;
      expect(listPrice).toBeGreaterThan(0);
      expect(engine.usage.recent(10).find((entry) => entry.artifactId === assetId)).toMatchObject({ basis: "estimated", costUsd: expect.closeTo(listPrice, 6), warnings: [] });
    }
  });

  it("edits a book image with Nano Banana 2.1 by sending it inline and stores the returned image", async () => {
    const created = await engine.artifacts.create("image", "cat");
    if (!created.ok) throw new Error(created.error.message);
    const source = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#2878b4" } }).png().toBuffer();
    expect((await engine.files.write(created.value.artifactId, "original.png", source)).ok).toBe(true);
    const { assetId, jobId } = await enqueued("generate_image", {
      model: "nunchux:gemini-nano-banana-2.1", prompt: "put a small red hat on it", refs: { image: [created.value.artifactId] }, options: { resolution: "1K" },
    });
    await waitForJob(jobId, testBudget(30_000));
    const submit = recorded.find((entry) => entry.path === "/v1/google/v1beta/interactions")!;
    expect(submit.authorization).toBe("Bearer local-nunchux-key");
    expect(JSON.parse(submit.body)).toEqual({
      model: "gemini-nano-banana-2.1",
      input: [{ type: "text", text: "put a small red hat on it" }, { type: "image", data: source.toString("base64"), mime_type: "image/png" }],
      response_format: { type: "image", image_size: "1K", aspect_ratio: "9:16" },
    });
    await expect.poll(async () => {
      const stored = await engine.files.read(assetId, "original.png");
      return stored.ok ? Buffer.from(stored.value).equals(png) : false;
    }, { timeout: testBudget(30_000) }).toBe(true);
    expect(engine.usage.recent(10).find((entry) => entry.artifactId === assetId)).toMatchObject({
      provider: "nunchux", model: "gemini-nano-banana-2.1", activity: "images", status: "completed", costUsd: expect.closeTo(0.0336, 6),
    });
  });

  it("generates and edits GPT Image 2.6 synchronously, sends book images inline and prices the call from the reported tokens", async () => {
    const generated = await enqueued("generate_image", { model: "nunchux:gpt-image-2.6-flare", prompt: "a red kite", options: { quality: "low" } });
    await waitForJob(generated.jobId, testBudget(30_000));
    const generation = recorded.find((entry) => entry.path === "/v2/openai/images/generations")!;
    expect(generation.authorization).toBe("Bearer local-nunchux-key");
    expect(JSON.parse(generation.body)).toEqual({ model: "gpt-image-2.6-flare", prompt: "a red kite", size: "1152x2048", quality: "low", output_format: "png", background: "auto" });

    const created = await engine.artifacts.create("image", "kite");
    if (!created.ok) throw new Error(created.error.message);
    const source = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#2878b4" } }).png().toBuffer();
    expect((await engine.files.write(created.value.artifactId, "original.png", source)).ok).toBe(true);
    const edited = await enqueued("generate_image", {
      model: "nunchux:gpt-image-2.6-sunburst", prompt: "make it night", refs: { image: [created.value.artifactId] }, options: { aspect_ratio: "16:9", resolution: "1K" },
    });
    await waitForJob(edited.jobId, testBudget(30_000));
    const edit = recorded.find((entry) => entry.path === "/v2/openai/images/edits")!;
    expect(JSON.parse(edit.body)).toEqual({
      model: "gpt-image-2.6-sunburst", prompt: "make it night", images: [{ image_url: `data:image/png;base64,${source.toString("base64")}` }],
      size: "1536x864", quality: "high", output_format: "png", background: "auto",
    });

    const tokens = { inputTokens: 1220, imageInputTokens: 1200, imageOutputTokens: 4160 };
    for (const { assetId, model } of [{ ...generated, model: "gpt-image-2.6-flare" }, { ...edited, model: "gpt-image-2.6-sunburst" }]) {
      await expect.poll(async () => {
        const stored = await engine.files.read(assetId, "original.png");
        return stored.ok ? Buffer.from(stored.value).equals(png) : false;
      }, { timeout: testBudget(30_000) }).toBe(true);
      const price = computeEstimate({ provider: "nunchux", payload: { model }, costHints: tokens });
      expect(price.warnings).toEqual([]);
      expect(price.usd).toBeCloseTo(20 * 5 / 1e6 + 1200 * 8 / 1e6 + 4160 * 30 / 1e6, 9);
      expect(engine.usage.recent(10).find((entry) => entry.artifactId === assetId)).toMatchObject({
        provider: "nunchux", model, activity: "images", status: "completed", basis: "estimated", costUsd: expect.closeTo(price.usd, 9),
        inputTokens: 1220, outputTokens: 4160, warnings: [],
      });
    }
  });

  it("refuses a plain http image URL for a GPT Image 2.6 edit before creating work", async () => {
    const before = engine.artifacts.list().length;
    const refused = await client.callTool({
      name: "generate_image",
      arguments: { book_id: engine.book.get().bookId, model: "nunchux:gpt-image-2.6-flare", prompt: "add a hat", refs: { image: [FRAME.replace("https://", "http://")] } },
    });
    expect(refused.isError).toBe(true);
    expect(toolText(refused)).toContain("takes https image URLs or images from this book");
    expect(engine.artifacts.list()).toHaveLength(before);
    expect(recorded).toEqual([]);
  });

  it("fails a generation Nunchux refuses at submit with its API error", async () => {
    submitReply = INVALID_KEY;
    const { assetId, jobId } = await enqueued("generate_video", FAMILIES[2].args);
    await expect(waitForJob(jobId, testBudget(30_000))).rejects.toThrow("Nunchux API error 401: Invalid or revoked API key.");
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: null });
    expect(engine.usage.recent(10).find((entry) => entry.artifactId === assetId)).toMatchObject({ provider: "nunchux", status: "failed" });
  });

  it("fails a task Nunchux reports as failed and one whose handle it no longer knows, but keeps polling through rate limits", async () => {
    const bookId = engine.book.get().bookId;
    const failed = await submitted(FAMILIES[0].args);
    pollReply = { code: 200, body: { output: { task_id: "nunchux-wan-video-task", task_status: "FAILED", code: "DataInspectionFailed", message: "Input data may contain inappropriate content." } } };
    const reported = await pollPendingProviderTasks(engine, bookId);
    expect(reported.failed).toEqual([expect.objectContaining({ assetId: failed, failMsg: "Nunchux task failed: Input data may contain inappropriate content." })]);
    expect(engine.jobs.pending.read(failed)).toMatchObject({ ok: true, value: null });

    const limited = await submitted(FAMILIES[2].args);
    pollReply = { code: 429, body: { error: { code: "rate_limited", message: "Too many requests" } } };
    const throttled = await pollPendingProviderTasks(engine, bookId);
    expect(throttled.failed).toEqual([expect.objectContaining({ assetId: limited, failMsg: "Nunchux API error 429: Too many requests" })]);
    expect(engine.jobs.pending.read(limited)).toMatchObject({ ok: true, value: expect.objectContaining({ taskId: "nunchux-minimax-task" }) });

    pollReply = { code: 401, body: { detail: "Invalid task handle", request_id: "95bce0170aad4b849bf67264cf389e48" } };
    const unknown = await pollPendingProviderTasks(engine, bookId);
    expect(unknown.failed).toEqual([expect.objectContaining({ assetId: limited, failMsg: "Nunchux API error 401: Invalid task handle" })]);
    const failure = engine.jobs.failures.read(limited);
    expect(failure.ok && failure.value?.message).toBe("Nunchux API error 401: Invalid task handle");
  });

  it("refuses Nunchux generation without NUNCHUX_API_KEY and leaves its tasks unpolled", async () => {
    const assetId = await submitted(FAMILIES[2].args);
    recorded = [];
    delete process.env.NUNCHUX_API_KEY;
    const before = engine.artifacts.list().length;
    const refused = await client.callTool({
      name: "generate_video",
      arguments: { book_id: engine.book.get().bookId, ...FAMILIES[2].args },
    });
    expect(refused.isError).toBe(true);
    expect(toolText(refused)).toBe("NUNCHUX_API_KEY environment variable is not set");
    expect(engine.artifacts.list()).toHaveLength(before);
    expect(await pollPendingProviderTasks(engine, engine.book.get().bookId)).toEqual({ pending: [], completed: [], failed: [] });
    expect(recorded).toEqual([]);
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: expect.objectContaining({ taskId: "nunchux-minimax-task" }) });
  });

  it("refuses a Nano Banana edit of a URL before creating work", async () => {
    const before = engine.artifacts.list().length;
    const refused = await client.callTool({
      name: "generate_image",
      arguments: { book_id: engine.book.get().bookId, model: "nunchux:gemini-nano-banana-2.1", prompt: "add a hat", refs: { image: [FRAME] } },
    });
    expect(refused.isError).toBe(true);
    expect(toolText(refused)).toContain("takes images from this book, not a URL");
    expect(engine.artifacts.list()).toHaveLength(before);
    expect(recorded).toEqual([]);
  });
});
