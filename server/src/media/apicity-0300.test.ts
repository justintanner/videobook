import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { CostHints } from "@apicity/cost";
import { AlibabaVideoSynthesisRequestSchema } from "@apicity/alibaba/zod";
import { FAL_ENDPOINT_REQUEST_SCHEMAS } from "@apicity/fal/zod";
import { GoogleGenerateContentRequestSchema, GoogleInteractionCreateRequestSchema } from "@apicity/google/zod";
import { GoogleFlowImagesRequestSchema, GoogleFlowVideosRequestSchema } from "@apicity/googleflow/zod";
import { MediaGenerationRequestSchema } from "@apicity/kie/zod";
import {
  WaveSpeedKwaivgiKlingImageV4p0EditRequestSchema,
  WaveSpeedKwaivgiKlingImageV4p0TextToImageRequestSchema,
  WaveSpeedOpenaiGptImage2p5FlareEditRequestSchema,
  WaveSpeedOpenaiGptImage2p5SunburstEditRequestSchema,
} from "@apicity/wavespeed/zod";
import type { Engine } from "videobook-engine";
import type { ZodType } from "zod";
import { createEngineForTest } from "../engine.js";
import { runFfmpeg } from "../ffmpeg.js";
import { readProviderTaskStatus } from "../provider-task-status.js";
import { waitForJob } from "../queue.js";
import { testBudget } from "../test-budget.js";
import { createTestClient } from "../test-client.js";
import { pollPendingProviderTasks } from "../tools/reconcile-project-work.js";
import { resetGoogleOAuthTokenCache } from "./adapters/google.js";
import { estimateGeneration } from "./cost.js";
import { resolveModel, UnknownModelError } from "./descriptor.js";
import { configureProviderEndpoints } from "./endpoints.js";
import { modelFrontierRankings } from "./frontier.js";
import { resolveGenerationSource } from "./generation-source.js";
import { listModels, modelListing } from "./listing.js";
import { applyPromptDialect } from "./prompt-dialects.js";
import { buildWireRequest, type WireRequestInput } from "./request.js";

const IMAGE = "https://example.com/image.png";
const IMAGE_2 = "https://example.com/image2.png";
const VIDEO = "https://example.com/video.mp4";
const AUDIO = "https://example.com/audio.mp3";
const IMAGE_ID = "01890f1c-0000-7000-8000-0000000000aa";
const IMAGE_ID_2 = "01890f1c-0000-7000-8000-0000000000bb";

function build(id: string, call: WireRequestInput): Record<string, unknown> {
  const built = buildWireRequest(resolveModel(id), call);
  if (!built.ok) throw new Error(built.error);
  return built.request;
}

function refusal(id: string, call: WireRequestInput): string {
  const built = buildWireRequest(resolveModel(id), call);
  return built.ok ? "" : built.error;
}

function optionsOf(id: string): Record<string, { defaultValue?: unknown; enumValues: Array<string | number>; minimum?: number; maximum?: number }> {
  return Object.fromEntries(resolveModel(id).options.map((option) => [option.name, option]));
}

async function estimate(id: string, call: WireRequestInput, hints: CostHints = {}): Promise<{ usd: number; warnings: string[] }> {
  const result = await estimateGeneration(resolveModel(id), call, hints);
  if (!result.ok) throw new Error(result.error);
  return { usd: result.estimate.usd, warnings: result.estimate.warnings };
}

function boards(id: string): Array<[string, number]> {
  return modelFrontierRankings(id).map((ranking) => [ranking.type, ranking.rank]);
}

describe("apicity 0.30.0 catalog additions and updates", () => {
  it("removes machgen:MiniMax-H3-Omni from the catalog", () => {
    expect(() => resolveModel("machgen:MiniMax-H3-Omni")).toThrow(UnknownModelError);
  });

  it("catalogs fal Kling 4.0 Image and Seedream 5.5 Edit with dialects, refusals, boards and pricing", async () => {
    const schemas = FAL_ENDPOINT_REQUEST_SCHEMAS as unknown as Record<string, ZodType>;
    const t2i = build("fal:kling/v4/text-to-image", { prompt: "a red fox" });
    expect(schemas["kling/v4/text-to-image"]!.safeParse(t2i).success).toBe(true);
    expect(boards("fal:kling/v4/text-to-image")).toEqual([["t2i", 7]]);
    const t2iPrice = await estimate("fal:kling/v4/text-to-image", { prompt: "a red fox" });
    expect(t2iPrice.usd).toBe(0);
    expect(t2iPrice.warnings.join(" ")).toContain("x-fal-billable-units");

    const editModel = resolveModel("fal:kling/v4/image-to-image");
    expect(editModel.slots).toEqual([expect.objectContaining({ role: "image", field: "image_urls", min: 1, max: 10 })]);
    expect(applyPromptDialect(editModel.entry.dialect, "put the hat from @image2 on @image1", { image: [IMAGE_ID, IMAGE_ID_2] }))
      .toBe("put the hat from @Image2 on @Image1");
    const i2i = build("fal:kling/v4/image-to-image", { prompt: "edit @Image1", refUrls: { image: [IMAGE] } });
    expect(schemas["kling/v4/image-to-image"]!.safeParse(i2i).success).toBe(true);
    expect(boards("fal:kling/v4/image-to-image")).toEqual([["i2i", 6]]);
    const i2iPrice = await estimate("fal:kling/v4/image-to-image", { prompt: "edit", refUrls: { image: [IMAGE] } });
    expect(i2iPrice.usd).toBe(0);
    expect(i2iPrice.warnings.join(" ")).toContain("x-fal-billable-units");

    const seedream = build("fal:bytedance/seedream/v5.5/edit", { prompt: "make it snow", refUrls: { image: [IMAGE] } });
    expect(schemas["bytedance/seedream/v5.5/edit"]!.safeParse(seedream).success).toBe(true);
    expect(boards("fal:bytedance/seedream/v5.5/edit")).toEqual([["i2i", 8]]);
    expect(refusal("fal:bytedance/seedream/v5.5/edit", {
      prompt: "cut out subject",
      refUrls: { image: [IMAGE] },
      options: { background: "transparent", output_format: "jpeg" },
    })).toBe("Background: a transparent background needs png or webp output");
    expect((await estimate("fal:bytedance/seedream/v5.5/edit", { prompt: "make it snow", refUrls: { image: [IMAGE] } })).usd).toBeGreaterThan(0);
  });

  it("catalogs WaveSpeed Kling 4.0 Image and GPT Image 2.5 edits with schemas, boards and pricing", async () => {
    const t2i = build("wavespeed:kwaivgi/kling-image-v4.0/text-to-image", { prompt: "a red fox" });
    expect(WaveSpeedKwaivgiKlingImageV4p0TextToImageRequestSchema.safeParse(t2i).success).toBe(true);
    expect(boards("wavespeed:kwaivgi/kling-image-v4.0/text-to-image")).toEqual([["t2i", 7]]);
    expect((await estimate("wavespeed:kwaivgi/kling-image-v4.0/text-to-image", { prompt: "a red fox" })).usd).toBeGreaterThan(0);

    const klingEdit = resolveModel("wavespeed:kwaivgi/kling-image-v4.0/edit");
    expect(klingEdit.slots).toEqual([expect.objectContaining({ role: "image", field: "images", min: 1, max: 10 })]);
    expect(applyPromptDialect(klingEdit.entry.dialect, "combine @image1 and @image2", { image: [IMAGE_ID, IMAGE_ID_2] }))
      .toBe("combine <<<image_1>>> and <<<image_2>>>");
    const editReq = build("wavespeed:kwaivgi/kling-image-v4.0/edit", { prompt: "combine <<<image_1>>>", refUrls: { image: [IMAGE] } });
    expect(WaveSpeedKwaivgiKlingImageV4p0EditRequestSchema.safeParse(editReq).success).toBe(true);
    expect(boards("wavespeed:kwaivgi/kling-image-v4.0/edit")).toEqual([["i2i", 6]]);
    expect((await estimate("wavespeed:kwaivgi/kling-image-v4.0/edit", { prompt: "combine", refUrls: { image: [IMAGE] } })).usd).toBeGreaterThan(0);

    for (const [id, schema, rank] of [
      ["wavespeed:openai/gpt-image-2.5-sunburst/edit", WaveSpeedOpenaiGptImage2p5SunburstEditRequestSchema, 4],
      ["wavespeed:openai/gpt-image-2.5-flare/edit", WaveSpeedOpenaiGptImage2p5FlareEditRequestSchema, 5],
    ] as const) {
      const model = resolveModel(id);
      expect(model.slots).toEqual([expect.objectContaining({ role: "image", field: "images", min: 1, max: 16 })]);
      expect(model.fieldSlots).toEqual([expect.objectContaining({ field: "mask_image", label: "Mask" })]);
      const req = build(id, { prompt: "recolor", refUrls: { image: [IMAGE] }, fieldUrls: { mask_image: [IMAGE_2] } });
      expect(schema.safeParse(req).success).toBe(true);
      expect(boards(id)).toEqual([["i2i", rank]]);
      expect((await estimate(id, { prompt: "recolor", refUrls: { image: [IMAGE] } })).usd).toBeGreaterThan(0);
    }
  });

  it("exposes KIE Kling 4.0 4k, HDR and 4:3/3:4 while pinning the default resolution to 1080p", async () => {
    for (const id of ["kie:kling-4.0/reference-to-video", "kie:kling-4.0/keyframe-to-video"]) {
      const options = optionsOf(id);
      expect(options.resolution).toMatchObject({ enumValues: ["720p", "1080p", "4k"], defaultValue: "1080p" });
      expect(options.dynamic_range?.enumValues).toEqual(["sdr", "hdr"]);
      expect(options.aspect_ratio?.enumValues).toEqual(expect.arrayContaining(["4:3", "3:4"]));
      const req4k = build(id, { prompt: "a wide valley", options: { resolution: "4k", dynamic_range: "hdr", aspect_ratio: "4:3" } });
      expect(MediaGenerationRequestSchema.safeParse(req4k).success).toBe(true);
      const p1080 = await estimate(id, { prompt: "a wide valley", options: { resolution: "1080p", duration: 5 } });
      const p4k = await estimate(id, { prompt: "a wide valley", options: { resolution: "4k", duration: 5 } });
      expect(p1080.warnings).toEqual([]);
      expect(p4k.warnings).toEqual([]);
      expect(p4k.usd).toBeGreaterThan(p1080.usd);
    }
  });

  it("catalogs Alibaba Wan 3.0, Wan 3.0 Prime and HappyHorse 1.0 Video Edit on DashScope International", async () => {
    for (const id of ["alibaba:wan3.0-video", "alibaba:wan3.0-video-prime"]) {
      const t2v = build(id, { prompt: "a drifting paper boat", options: { resolution: "1080P", duration: 5 } });
      expect(AlibabaVideoSynthesisRequestSchema.safeParse(t2v).success).toBe(true);
      expect(refusal(id, { prompt: "x", refUrls: { first_frame: [IMAGE], image: [IMAGE_2] } })).toMatch(/can't be combined/u);
      expect(boards(id)).toEqual([["t2v", 1], ["v2v", 1], ["r2v", 1]]);
      const priced = await estimate(id, { prompt: "a drifting paper boat", options: { resolution: "1080P", duration: 5 } });
      expect(priced.warnings).toEqual([]);
      expect(priced.usd).toBeGreaterThan(0);
    }

    const hh = build("alibaba:happyhorse-1.0-video-edit", { prompt: "make it snow", refUrls: { video: [VIDEO], image: [IMAGE] } });
    expect(AlibabaVideoSynthesisRequestSchema.safeParse(hh).success).toBe(true);
    expect(boards("alibaba:happyhorse-1.0-video-edit")).toEqual([["v2v", 7]]);
    const hhPrice = await estimate("alibaba:happyhorse-1.0-video-edit", { prompt: "make it snow", refUrls: { video: [VIDEO] } }, { inputDurationSeconds: 5 });
    expect(hhPrice.warnings).toEqual([]);
    expect(hhPrice.usd).toBeGreaterThan(0);
  });

  it("catalogs OpenAI GPT Image models with mask/markup guards, boards and hidden GPT Image 2 revealed by frontier", async () => {
    for (const [id, expectedBoards] of [
      ["openai:gpt-image-2.6-sunburst", [["t2i", 1], ["i2i", 2]]],
      ["openai:gpt-image-2.6-flare", [["t2i", 3], ["i2i", 3]]],
      ["openai:gpt-image-2.5-sunburst", [["t2i", 2], ["i2i", 4]]],
      ["openai:gpt-image-2.5-flare", [["t2i", 5], ["i2i", 5]]],
      ["openai:gpt-image-2", [["t2i", 6]]],
    ] as const) {
      const model = resolveModel(id);
      expect(model.slots).toEqual([expect.objectContaining({ role: "image", field: "images", min: 0, max: 16 })]);
      expect(boards(id)).toEqual(expectedBoards);
      const priced = await estimate(id, { prompt: "a wooden lighthouse" });
      expect(priced.usd).toBeGreaterThan(0);
    }
    expect(listModels().some((model) => model.id === "openai:gpt-image-2")).toBe(true);
    expect(refusal("openai:gpt-image-2.6-sunburst", {
      prompt: "edit",
      refUrls: { image: [IMAGE] },
      fieldUrls: { mask: [IMAGE], markup: [IMAGE_2] },
    })).toBe("Markup: can't be combined with a mask");
    expect(refusal("openai:gpt-image-2.6-sunburst", {
      prompt: "icon",
      options: { background: "transparent", output_format: "jpeg" },
    })).toBe("Background: a transparent background needs png or webp output");
  });

  it("catalogs Google Vertex Nano Banana 2.1 and Gemini Omni 1.2/1.1 with per-model credentials and schemas", () => {
    const nb = build("google:gemini-nano-banana-2.1", { prompt: "a blue ceramic vase" });
    expect(GoogleGenerateContentRequestSchema.safeParse(nb).success).toBe(true);
    expect(boards("google:gemini-nano-banana-2.1")).toEqual([["t2i", 8], ["i2i", 10]]);

    const omni12 = build("google:gemini-omni-1.2-flash", { prompt: "a fox leaps", options: { duration: 8 } });
    expect(GoogleInteractionCreateRequestSchema.safeParse(omni12).success).toBe(true);
    expect(omni12).toMatchObject({ model: "gemini-omni-1.2-flash", store: false, response_format: [{ duration: "8s", resolution: "720p" }] });
    expect(boards("google:gemini-omni-1.2-flash")).toEqual([["t2v", 6], ["v2v", 2], ["r2v", 5]]);

    const omni12Edit = build("google:gemini-omni-1.2-flash", { prompt: "add snow", refUrls: { video: [VIDEO] }, mode: "v2v" });
    expect(GoogleInteractionCreateRequestSchema.safeParse(omni12Edit).success).toBe(true);
    expect((omni12Edit.response_format as Array<Record<string, unknown>>)[0]).not.toHaveProperty("duration");
    expect(omni12Edit).toMatchObject({ generation_config: { video_config: { task: "edit" } } });

    expect(boards("google:gemini-omni-1.1-flash-preview")).toEqual([["v2v", 5]]);

    const savedApi = process.env.GOOGLE_API_KEY;
    const savedSa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    try {
      process.env.GOOGLE_API_KEY = "test-api-key";
      delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      expect(modelListing(resolveModel("google:gemini-nano-banana-2.1")).available).toBe(true);
      expect(modelListing(resolveModel("google:gemini-omni-1.2-flash")).available).toBe(false);
      delete process.env.GOOGLE_API_KEY;
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "{\"client_email\":\"a@b\"}";
      expect(modelListing(resolveModel("google:gemini-nano-banana-2.1")).available).toBe(false);
      expect(modelListing(resolveModel("google:gemini-omni-1.2-flash")).available).toBe(true);
    } finally {
      if (savedApi === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = savedApi;
      if (savedSa === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON; else process.env.GOOGLE_SERVICE_ACCOUNT_JSON = savedSa;
    }
  });

  it("catalogs Google Flow Omni Flash 1.2, Omni Flash 1.1 and Nano Banana 2 with guards, boards and pricing", async () => {
    const nb = build("googleflow:nano-banana-2", { prompt: "a blue vase", refUrls: { image: [IMAGE, IMAGE_2] }, options: { aspectRatio: "auto" } });
    expect(GoogleFlowImagesRequestSchema.safeParse(nb).success).toBe(true);
    expect(nb).toMatchObject({ model: "nano-banana-2", reference_1: IMAGE, reference_2: IMAGE_2, aspectRatio: "auto" });
    expect(boards("googleflow:nano-banana-2")).toEqual([["t2i", 8], ["i2i", 10]]);
    expect(refusal("googleflow:nano-banana-2", { prompt: "a vase", options: { aspectRatio: "auto" } }))
      .toMatch(/requires at least one reference image/u);

    const v12 = build("googleflow:omni-flash-1.2", {
      prompt: "waves crash",
      refUrls: { image: [IMAGE], audio: [AUDIO] },
      options: { duration: 12, resolution: "720p" },
      mode: "r2v",
    });
    expect(GoogleFlowVideosRequestSchema.safeParse(v12).success).toBe(true);
    expect(v12).toMatchObject({ model: "omni-flash-1.2", async: true, duration: 12, referenceImage_1: IMAGE, referenceAudio_1: AUDIO });
    expect(boards("googleflow:omni-flash-1.2")).toEqual([["t2v", 6], ["v2v", 2], ["r2v", 5]]);
    expect(refusal("googleflow:omni-flash-1.2", {
      prompt: "x",
      refUrls: { first_frame: [IMAGE], last_frame: [IMAGE_2] },
      options: { duration: 12 },
      mode: "i2v",
    })).toMatch(/at most 10 seconds/u);
    expect(refusal("googleflow:omni-flash-1.2", { prompt: "x", refUrls: { last_frame: [IMAGE_2] } }))
      .toMatch(/endImage requires startImage/u);
    const v12Edit = build("googleflow:omni-flash-1.2", { prompt: "make it night", refUrls: { video: [VIDEO] }, mode: "v2v" });
    expect(GoogleFlowVideosRequestSchema.safeParse(v12Edit).success).toBe(true);
    expect(v12Edit).not.toHaveProperty("duration");
    const v12Price = await estimate("googleflow:omni-flash-1.2", { prompt: "waves", options: { duration: 8, resolution: "720p" } });
    expect(v12Price.warnings).toEqual([]);
    expect(v12Price.usd).toBeGreaterThan(0);

    const v11 = build("googleflow:omni-flash", { prompt: "waves", options: { duration: 8 } });
    expect(GoogleFlowVideosRequestSchema.safeParse(v11).success).toBe(true);
    expect(boards("googleflow:omni-flash")).toEqual([["v2v", 5]]);
    const v11Price = await estimate("googleflow:omni-flash", { prompt: "waves", options: { duration: 8, resolution: "720p" } });
    expect(v11Price.warnings).toEqual([]);
    expect(v11Price.usd).toBeGreaterThan(0);
  });
});

interface RecordedRequest {
  method: string;
  path: string;
  authorization?: string;
  contentType?: string;
  body: Buffer;
}

function readRequestBody(incoming: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => resolve(Buffer.concat(chunks)));
    incoming.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

describe("0.30.0 provider end-to-end stubs (Alibaba video, OpenAI images, Google Vertex, Google Flow)", () => {
  const ENV_KEYS = [
    "DASHSCOPE_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_FLOW_API_KEY",
  ] as const;

  let fixturesDir: string;
  let mp4: Buffer;
  let png: Buffer;
  let server: Server;
  let baseURL: string;
  let recorded: RecordedRequest[];
  let root: string;
  let engine: Engine;
  let client: Client;
  let bookId: string;
  let restoreEndpoints: () => void;
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;
  let privateKeyPem: string;

  beforeAll(async () => {
    fixturesDir = await mkdtemp(join(tmpdir(), "videobook-0300-fixtures-"));
    const mp4Path = join(fixturesDir, "sample.mp4");
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1",
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", mp4Path,
    ]);
    mp4 = await readFile(mp4Path);
    png = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 220, g: 60, b: 40 } } }).png().toBuffer();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    server = createServer(async (incoming, response) => {
      const body = await readRequestBody(incoming);
      const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
      recorded.push({
        method: incoming.method ?? "GET",
        path: url.pathname,
        authorization: incoming.headers.authorization,
        contentType: incoming.headers["content-type"],
        body,
      });

      if (url.pathname === "/media/output.mp4") {
        response.writeHead(200, { "content-type": "video/mp4" });
        response.end(mp4);
        return;
      }
      if (url.pathname === "/media/output.png") {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(png);
        return;
      }
      if (url.pathname === "/oauth/token" && incoming.method === "POST") {
        sendJson(response, 200, { access_token: "ya29.stub-vertex-token", expires_in: 3600 });
        return;
      }
      if (url.pathname === "/api/v1/services/aigc/video-generation/video-synthesis" && incoming.method === "POST") {
        sendJson(response, 200, { request_id: "req-ali-1", output: { task_id: "ali-task-1", task_status: "PENDING" } });
        return;
      }
      if (url.pathname === "/api/v1/tasks/ali-task-1" && incoming.method === "GET") {
        sendJson(response, 200, {
          request_id: "req-ali-poll",
          output: { task_id: "ali-task-1", task_status: "SUCCEEDED", video_url: `${baseURL}/media/output.mp4` },
        });
        return;
      }
      if ((url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits") && incoming.method === "POST") {
        sendJson(response, 200, {
          created: 1795200000,
          data: [{ b64_json: png.toString("base64") }],
          usage: {
            input_tokens: 100,
            output_tokens: 1000,
            total_tokens: 1100,
            input_tokens_details: { text_tokens: 100, image_tokens: 0 },
            output_tokens_details: { image_tokens: 1000, text_tokens: 0 },
          },
        });
        return;
      }
      if (url.pathname.endsWith(":generateContent") && incoming.method === "POST") {
        sendJson(response, 200, {
          responseId: "goog-img-1",
          candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }] } }],
          usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 1120, totalTokenCount: 1145 },
        });
        return;
      }
      if (url.pathname === "/v1/projects/stub-project/locations/global/interactions" && incoming.method === "POST") {
        sendJson(response, 200, {
          id: "goog-int-1",
          status: "completed",
          steps: [{ type: "model_output", content: [{ type: "video", mime_type: "video/mp4", data: mp4.toString("base64") }] }],
          usage: { input_tokens: 50, output_tokens: 800, total_tokens: 850 },
        });
        return;
      }
      if (url.pathname === "/v1/google-flow/assets" && incoming.method === "POST") {
        sendJson(response, 200, { mediaGenerationId: "gf-media-1" });
        return;
      }
      if (url.pathname === "/v1/google-flow/images" && incoming.method === "POST") {
        sendJson(response, 200, {
          jobId: "gf-img-job-1",
          media: [{ image: { generatedImage: { fifeUrl: `${baseURL}/media/output.png` } } }],
        });
        return;
      }
      if (url.pathname === "/v1/google-flow/videos" && incoming.method === "POST") {
        sendJson(response, 201, { jobid: "gf-vid-job-1", type: "video", status: "created", created: new Date().toISOString() });
        return;
      }
      if (url.pathname === "/v1/google-flow/jobs/gf-vid-job-1" && incoming.method === "GET") {
        sendJson(response, 200, {
          jobid: "gf-vid-job-1",
          type: "video",
          status: "completed",
          created: new Date().toISOString(),
          response: { jobId: "gf-vid-job-1", media: [{ mediaGenerationId: "gf-out-1", videoUrl: `${baseURL}/media/output.mp4` }] },
        });
        return;
      }
      sendJson(response, 404, { error: `unexpected ${incoming.method} ${url.pathname}` });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as AddressInfo;
    baseURL = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixturesDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    recorded = [];
    resetGoogleOAuthTokenCache();
    savedEnv = {};
    for (const key of ENV_KEYS) {
      if (process.env[key] !== undefined) savedEnv[key] = process.env[key];
    }
    process.env.DASHSCOPE_API_KEY = "stub-dashscope";
    process.env.OPENAI_API_KEY = "stub-openai";
    process.env.GOOGLE_API_KEY = "stub-google-api";
    process.env.GOOGLE_CLOUD_PROJECT = "stub-project";
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
      client_email: "stub@stub-project.iam.gserviceaccount.com",
      private_key: privateKeyPem,
      token_uri: `${baseURL}/oauth/token`,
      project_id: "stub-project",
    });
    process.env.GOOGLE_FLOW_API_KEY = "stub-googleflow";

    restoreEndpoints = configureProviderEndpoints({
      alibabaBaseURL: `${baseURL}/compatible-mode/v1`,
      openaiBaseURL: `${baseURL}/v1`,
      googleBaseURL: `${baseURL}/v1`,
      googleTokenURL: `${baseURL}/oauth/token`,
      googleFlowBaseURL: `${baseURL}/v1/google-flow`,
      pollIntervalMs: 1,
    });

    root = await mkdtemp(join(tmpdir(), "videobook-0300-e2e-"));
    client = await createTestClient(root);
    engine = createEngineForTest(root);
    await engine.ready;
    bookId = engine.book.get().bookId;
  });

  afterEach(async () => {
    restoreEndpoints();
    resetGoogleOAuthTokenCache();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await client.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function seedBookImage(): Promise<string> {
    const created = await engine.artifacts.create({ kind: "image", label: "Seed" });
    if (!created.ok) throw new Error(created.error.message);
    const written = await engine.files.write(created.value.artifactId, "original.png", png);
    if (!written.ok) throw new Error(written.error.message);
    return created.value.artifactId;
  }

  function parseTool(result: { content?: unknown; isError?: unknown }): Record<string, unknown> {
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    return JSON.parse(text) as Record<string, unknown>;
  }

  it("refuses external URLs for OpenAI, Google Vertex and Google Flow before any network call", async () => {
    for (const id of ["openai:gpt-image-2.6-sunburst", "google:gemini-nano-banana-2.1", "googleflow:nano-banana-2"]) {
      const resolved = await resolveGenerationSource(engine, resolveModel(id), { image: [IMAGE] });
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) expect(resolved.error).toContain("takes media from this book, not a URL");
    }
    expect(recorded).toEqual([]);
  });

  it("submits, polls and completes an Alibaba Wan 3.0 video task via DashScope International", async () => {
    const start = parseTool(await client.callTool({
      name: "generate_video",
      arguments: { book_id: bookId, model: "alibaba:wan3.0-video", prompt: "a blue river flows", options: { duration: 5, resolution: "1080P" } },
    }));
    await waitForJob(String(start.job_id), testBudget(30_000));
    const assetId = String(start.asset_id);
    expect(await readProviderTaskStatus(engine, assetId)).toEqual({
      provider: "alibaba",
      model: "wan3.0-video",
      taskId: "ali-task-1",
    });

    const polled = await pollPendingProviderTasks(engine, bookId);
    expect(polled.completed).toHaveLength(1);
    await waitForJob(polled.completed[0]!.jobId, testBudget(30_000));
    expect((await engine.files.read(assetId, "original.mp4")).ok).toBe(true);
    expect(recorded.some((req) => req.method === "POST" && req.path === "/api/v1/services/aigc/video-generation/video-synthesis")).toBe(true);
    expect(recorded.some((req) => req.method === "GET" && req.path === "/api/v1/tasks/ali-task-1")).toBe(true);
  });

  it("generates and edits OpenAI GPT Image 2.6 Sunburst synchronously with multipart book image uploads", async () => {
    const gen = parseTool(await client.callTool({
      name: "generate_image",
      arguments: { book_id: bookId, model: "openai:gpt-image-2.6-sunburst", prompt: "a red barn" },
    }));
    await waitForJob(String(gen.job_id), testBudget(30_000));
    expect((await engine.files.read(String(gen.asset_id), "original.png")).ok).toBe(true);

    const seedId = await seedBookImage();
    const edit = parseTool(await client.callTool({
      name: "generate_image",
      arguments: { book_id: bookId, model: "openai:gpt-image-2.6-sunburst", prompt: "add snow", refs: { image: [seedId] } },
    }));
    await waitForJob(String(edit.job_id), testBudget(30_000));
    expect((await engine.files.read(String(edit.asset_id), "original.png")).ok).toBe(true);

    expect(recorded.some((req) => req.method === "POST" && req.path === "/v1/images/generations")).toBe(true);
    const editReq = recorded.find((req) => req.method === "POST" && req.path === "/v1/images/edits");
    expect(editReq?.contentType).toContain("multipart/form-data");
  });

  it("runs Google Vertex Nano Banana 2.1 with API key and Gemini Omni 1.2 Flash with OAuth2 service account", async () => {
    const seedId = await seedBookImage();
    const nb = parseTool(await client.callTool({
      name: "generate_image",
      arguments: { book_id: bookId, model: "google:gemini-nano-banana-2.1", prompt: "make it blue", refs: { image: [seedId] } },
    }));
    await waitForJob(String(nb.job_id), testBudget(30_000));
    expect((await engine.files.read(String(nb.asset_id), "original.png")).ok).toBe(true);
    const nbReq = recorded.find((req) => req.path.endsWith(":generateContent"));
    expect(nbReq).toBeDefined();
    expect(JSON.parse(nbReq!.body.toString("utf8"))).toMatchObject({
      contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }, { text: "make it blue" }] }],
    });

    const omni = parseTool(await client.callTool({
      name: "generate_video",
      arguments: { book_id: bookId, model: "google:gemini-omni-1.2-flash", prompt: "the fox runs", refs: { image: [seedId] }, mode: "r2v" },
    }));
    await waitForJob(String(omni.job_id), testBudget(30_000));
    expect((await engine.files.read(String(omni.asset_id), "original.mp4")).ok).toBe(true);
    expect(recorded.some((req) => req.method === "POST" && req.path === "/oauth/token")).toBe(true);
    const intReq = recorded.find((req) => req.path === "/v1/projects/stub-project/locations/global/interactions");
    expect(intReq?.authorization).toBe("Bearer ya29.stub-vertex-token");
  });

  it("runs Google Flow Nano Banana 2 image edits and async Omni Flash 1.2 video jobs through polling", async () => {
    const seedId = await seedBookImage();
    const img = parseTool(await client.callTool({
      name: "generate_image",
      arguments: { book_id: bookId, model: "googleflow:nano-banana-2", prompt: "add snow", refs: { image: [seedId] } },
    }));
    await waitForJob(String(img.job_id), testBudget(30_000));
    expect((await engine.files.read(String(img.asset_id), "original.png")).ok).toBe(true);
    expect(recorded.some((req) => req.method === "POST" && req.path === "/v1/google-flow/assets")).toBe(true);
    const imgReq = recorded.find((req) => req.method === "POST" && req.path === "/v1/google-flow/images");
    expect(JSON.parse(imgReq!.body.toString("utf8"))).toMatchObject({ model: "nano-banana-2", reference_1: "gf-media-1" });

    const vid = parseTool(await client.callTool({
      name: "generate_video",
      arguments: { book_id: bookId, model: "googleflow:omni-flash-1.2", prompt: "waves crash on rocks" },
    }));
    await waitForJob(String(vid.job_id), testBudget(30_000));
    const vidAssetId = String(vid.asset_id);
    expect(await readProviderTaskStatus(engine, vidAssetId)).toEqual({
      provider: "googleflow",
      model: "omni-flash-1.2",
      taskId: "gf-vid-job-1",
    });

    const polled = await pollPendingProviderTasks(engine, bookId);
    expect(polled.completed).toHaveLength(1);
    await waitForJob(polled.completed[0]!.jobId, testBudget(30_000));
    expect((await engine.files.read(vidAssetId, "original.mp4")).ok).toBe(true);
    expect(recorded.some((req) => req.method === "GET" && req.path === "/v1/google-flow/jobs/gf-vid-job-1")).toBe(true);
  });
});
