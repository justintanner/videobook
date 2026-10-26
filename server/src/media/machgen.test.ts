import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { MACHGEN_VIDEO_MODEL_TASK_TYPES } from "@apicity/machgen";
import type { Engine } from "videobook-engine";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { pauseBookQueueForTests, resumeBookQueueForTests, waitForJob } from "../queue.js";
import { runFfmpeg } from "../ffmpeg.js";
import { pollPendingProviderTasks } from "../tools/reconcile-project-work.js";
import { readProviderTaskStatus } from "../provider-task-status.js";
import { resolveModel } from "./descriptor.js";
import { buildWireRequest, type WireRequestInput } from "./request.js";
import { estimateGeneration } from "./cost.js";
import { applyPromptDialect } from "./prompt-dialects.js";
import { configureProviderEndpoints } from "./endpoints.js";
import { MACHGEN_MODELS } from "./machgen.js";
import type { Operation } from "./types.js";
import { testBudget } from "../test-budget.js";

const FRAME = "https://example.test/first.png";
const LAST = "https://example.test/last.png";
const CLIP = "https://example.test/clip.mp4";
const SONG = "https://example.test/song.mp3";

const OPERATION_BY_TASK: Record<string, Operation> = {
  T2V: "text_to_video",
  I2V: "image_to_video",
  R2V: "reference_to_video",
};

function request(id: string, call: WireRequestInput): Record<string, unknown> {
  const built = buildWireRequest(resolveModel(id), call);
  if (!built.ok) throw new Error(built.error);
  return built.request;
}

describe("MachGen catalog", () => {
  it("catalogs six of the MachGen video models apicity publishes with their generation task types", () => {
    const published: Record<string, readonly string[]> = MACHGEN_VIDEO_MODEL_TASK_TYPES;
    expect(Object.keys(published).filter((apiId) => !(apiId in MACHGEN_MODELS)).sort()).toEqual([
      "Grok-Imagine-Video", "HappyHorse-1.0", "Kling-o3", "Kling-v3", "LTX-2.3-Pro", "MiniMax-H3-Turbo",
      "Pixverse-C1", "Pixverse-V6", "Seedance-2.0-Fast", "Seedance-2.0-Mini",
      "Topaz-Video-Generative", "Topaz-Video-Generative-Fast", "Topaz-Video-Precision", "Topaz-Video-Precision-Animation",
      "Veo-3.1", "Veo-3.1-Fast", "Vidu-Q3", "Vidu-Q3-Pro", "Vidu-Q3-Pro-Fast", "Vidu-Q3-Turbo", "Vidu-Q4-Preview", "Wan2.2-A14B",
    ]);
    for (const apiId of Object.keys(MACHGEN_MODELS)) {
      const tasks = (published[apiId] ?? []).filter((task) => task !== "UPSCALE");
      const model = resolveModel(`machgen:${apiId}`);
      expect(model).toMatchObject({ provider: "machgen", apiId, media: "video" });
      expect(model.title).toMatch(/\(MachGen\)$/u);
      expect(model.entry.hidden).toBeUndefined();
      expect(model.entry.operations).toEqual(tasks.map((task) => OPERATION_BY_TASK[task]));
      expect(MACHGEN_MODELS[apiId]!.taskTypes).toEqual(tasks);
    }
  });

  it("offers each model's resolutions, durations and defaults as options", () => {
    const options = (id: string) => Object.fromEntries(resolveModel(id).options.map((option) => [option.name, option]));
    expect(options("machgen:MiniMax-H3")).toMatchObject({
      resolution: { enumValues: ["480p", "768p", "1440p"], defaultValue: "1440p" },
      duration: { minimum: 1, maximum: 30, defaultValue: 12 },
      aspect_ratio: { enumValues: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], defaultValue: "9:16" },
      generate_audio: { valueType: "boolean", defaultValue: true },
      seed: { valueType: "integer" },
    });
    expect(options("machgen:Seedance-2.5").aspect_ratio).toMatchObject({ defaultValue: "9:16" });
    expect(options("machgen:Seedance-2.5").seed).toBeUndefined();
    expect(options("machgen:Seedance-2.0").resolution).toMatchObject({ enumValues: ["480p", "720p", "1080p", "2160p"] });
    expect(Object.keys(options("machgen:Alibaba-Wan-3.0")).sort()).toEqual(["duration", "resolution", "seed"]);
    expect(options("machgen:HappyHorse-1.1")).toMatchObject({ resolution: { enumValues: ["720p", "1080p"] }, duration: { minimum: 3, maximum: 15 } });
    expect(Object.keys(options("machgen:Grok-Imagine-Video-1.5")).sort()).toEqual(["duration", "resolution"]);
    expect(resolveModel("machgen:Grok-Imagine-Video-1.5").slots).toEqual([expect.objectContaining({ role: "first_frame", min: 1, max: 1 })]);
  });

  it.each([
    ["machgen:MiniMax-H3", { prompt: "a red boat" }, {
      model: "MiniMax-H3", task_type: "T2V", prompt: "a red boat",
      video_config: { height: 1440, duration_secs: 12, aspect_ratio: "9:16", audio: true },
    }],
    ["machgen:MiniMax-H3", { prompt: "end on the cat", refUrls: { last_frame: [LAST] }, options: { resolution: "480p", seed: 7 } }, {
      task_type: "I2V", seed: 7, src_image_urls: [LAST], keyframe_indices: [-1],
      video_config: { height: 480, duration_secs: 12, aspect_ratio: "9:16", audio: true },
    }],
    ["machgen:Seedance-2.5", { prompt: "the cat turns", refUrls: { first_frame: [FRAME], last_frame: [LAST] }, options: { aspect_ratio: "16:9", generate_audio: false } }, {
      model: "Seedance-2.5", task_type: "I2V", src_image_urls: [FRAME, LAST],
      video_config: { height: 1080, duration_secs: 12, aspect_ratio: "adaptive", audio: false },
    }],
    ["machgen:Seedance-2.0", { prompt: "dance", refUrls: { image: [FRAME], video: [CLIP], audio: [SONG] }, options: { duration: -1, resolution: "2160p" } }, {
      task_type: "R2V", src_image_urls: [FRAME], src_video_urls: [CLIP], src_audio_urls: [SONG],
      video_config: { height: 2160, duration_secs: -1, aspect_ratio: "9:16", audio: true },
    }],
    ["machgen:Alibaba-Wan-3.0", { prompt: "a slow pan", options: { duration: 2, resolution: "480p" } }, {
      model: "Alibaba-Wan-3.0", task_type: "T2V",
      video_config: { height: 480, duration_secs: 2, aspect_ratio: "adaptive", fps: 30, audio: true },
    }],
    ["machgen:HappyHorse-1.1", { prompt: "the cat blinks", refUrls: { first_frame: [FRAME] }, options: { resolution: "1080p", duration: 3 } }, {
      task_type: "I2V", src_image_urls: [FRAME], video_config: { height: 1080, duration_secs: 3 },
    }],
    ["machgen:Grok-Imagine-Video-1.5", { refUrls: { first_frame: [FRAME] }, options: { resolution: "480p", duration: 1 } }, {
      model: "Grok-Imagine-Video-1.5", task_type: "I2V", prompt: "", src_image_urls: [FRAME],
      video_config: { height: 480, duration_secs: 1 },
    }],
  ] as const)("%s builds the documented MachGen request", (id, call, expected) => {
    const built = request(id, call as WireRequestInput);
    expect(built).toMatchObject(expected);
    if (!("keyframe_indices" in expected)) expect(built).not.toHaveProperty("keyframe_indices");
    if (id === "machgen:HappyHorse-1.1") expect(built.video_config).not.toHaveProperty("aspect_ratio");
  });

  it.each([
    ["machgen:Seedance-2.5", { prompt: "x", refUrls: { first_frame: [FRAME], image: [LAST] } }, /Reference image urls: cannot be combined with first_frame_url/],
    ["machgen:Seedance-2.5", { prompt: "x", refUrls: { last_frame: [LAST] } }, /last_frame_url requires first_frame_url/],
    ["machgen:MiniMax-H3", { prompt: "x", refUrls: { first_frame: [FRAME], last_frame: [LAST] }, options: { duration: 16 } }, /Duration: a first and last frame allow at most 15 seconds/],
    ["machgen:MiniMax-H3", { prompt: "x", options: { resolution: "1440p", duration: 16 } }, /Duration: 1440p allows at most 15 seconds/],
    ["machgen:MiniMax-H3", { refUrls: { first_frame: [FRAME] } }, /requires a prompt/],
    ["machgen:Seedance-2.5", { prompt: "x", refUrls: { video: [CLIP] }, options: { duration: -1, aspect_ratio: "16:9" } }, /Aspect ratio: -1 duration with a reference video/],
    ["machgen:Seedance-2.0", { prompt: "x", refUrls: { audio: [SONG] } }, /needs at least one reference image or video/],
    ["machgen:Seedance-2.0", {}, /Prompt: Required/],
    ["machgen:Seedance-2.0", { prompt: "x", options: { duration: 16 } }, /Duration:/],
    ["machgen:Alibaba-Wan-3.0", { prompt: "x", options: { aspect_ratio: "16:9" } }, /not an option of machgen:Alibaba-Wan-3.0/],
    ["machgen:HappyHorse-1.1", { prompt: "x", refUrls: { video: [CLIP] } }, /does not accept video refs/],
    ["machgen:Grok-Imagine-Video-1.5", { prompt: "x" }, /requires at least 1 first_frame ref/],
  ] as const)("%s rejects a request MachGen would refuse", (id, call, error) => {
    const built = buildWireRequest(resolveModel(id), call as WireRequestInput);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error).toMatch(error);
  });

  it.each([
    ["machgen:MiniMax-H3", { prompt: "x", options: { resolution: "768p", duration: 5 } }, {}, 0.2],
    ["machgen:MiniMax-H3", { prompt: "x", options: { resolution: "480p", duration: 20 } }, {}, 0.6125],
    ["machgen:MiniMax-H3", { prompt: "x", refUrls: { video: [CLIP] }, options: { resolution: "768p", duration: 5 } }, { inputDurationSeconds: 4 }, 0.54],
    ["machgen:Seedance-2.5", { prompt: "x", options: { resolution: "720p", duration: 5 } }, {}, 1.15],
    ["machgen:Seedance-2.5", { prompt: "x", refUrls: { video: [CLIP] }, options: { resolution: "720p", duration: 5 } }, { inputDurationSeconds: 4 }, 1.26],
    ["machgen:Seedance-2.0", { prompt: "x", options: { resolution: "2160p", duration: 5 } }, {}, 3.9],
    ["machgen:Alibaba-Wan-3.0", { prompt: "x", options: { resolution: "1080p", duration: 10 } }, {}, 1.91],
    ["machgen:HappyHorse-1.1", { prompt: "x", options: { resolution: "1080p", duration: 5 } }, {}, 0.85],
    ["machgen:Grok-Imagine-Video-1.5", { refUrls: { first_frame: [FRAME] }, options: { resolution: "480p", duration: 5 } }, {}, 0.475],
  ] as const)("%s is priced from the @apicity/cost machgen rows", async (id, call, hints, usd) => {
    const result = await estimateGeneration(resolveModel(id), call as WireRequestInput, hints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.estimate.usd).toBeCloseTo(usd, 6);
    expect(result.estimate.warnings).toEqual([]);
  });

  it("explains a -1 duration estimate MachGen bills by the generated length", async () => {
    const result = await estimateGeneration(resolveModel("machgen:Seedance-2.5"), { prompt: "x", options: { duration: -1 } });
    expect(result.ok && result.estimate).toMatchObject({ usd: 0, warnings: [expect.stringContaining("duration_secs -1")] });
  });

  it("names references in plain words and drops frame mentions", () => {
    const refs = {
      first_frame: ["11111111-1111-4111-8111-111111111111"],
      image: ["22222222-2222-4222-8222-222222222222"],
      audio: ["33333333-3333-4333-8333-333333333333"],
    };
    expect(applyPromptDialect("natural_strip_frames", "Open on @firstframe, then @image1 dances to @audio1", refs))
      .toBe("Open on, then reference image 1 dances to reference audio 1");
  });
});

type Recorded = { method: string; path: string; authorization: string | undefined; body: string };

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

describe("MachGen provider tasks", () => {
  const TASK_ID = "a7b3c9d1-0000-4000-8000-000000000001";
  let fixtures: string;
  let mp4: Buffer;
  let server: Server;
  let baseURL: string;
  let recorded: Recorded[];
  let taskStatus: { code: number; body: Record<string, unknown> };
  let root: string;
  let engine: Engine;
  let client: Client;
  let restoreEndpoints: () => void;
  let originalKey: string | undefined;

  function route(method: string, path: string, response: ServerResponse): void {
    if (method === "POST" && path === "/api/v0/generate") {
      return sendJson(response, 200, { task_id: TASK_ID, metadata: { model: "Seedance-2.5", task_type: "I2V" }, task_output: null, moderation: null });
    }
    if (method === "GET" && path === `/api/v0/tasks/${TASK_ID}`) return sendJson(response, taskStatus.code, taskStatus.body);
    if (method === "GET" && path === `/api/v0/assets/${TASK_ID}`) {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end(mp4);
      return;
    }
    sendJson(response, 404, { detail: "Not Found" });
  }

  function status(state: string, extra: Record<string, unknown> = {}): { code: number; body: Record<string, unknown> } {
    return { code: 200, body: { task_id: TASK_ID, metadata: { model: "Seedance-2.5" }, task_output: null, status: state, error_msg: null, ...extra } };
  }

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-machgen-fixtures-"));
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-pix_fmt", "yuv420p", join(fixtures, "clip.mp4")]);
    mp4 = await readFile(join(fixtures, "clip.mp4"));
    server = createServer((incoming, response) => {
      void readBody(incoming).then((body) => {
        const authorization = incoming.headers.authorization;
        recorded.push({ method: incoming.method ?? "", path: incoming.url ?? "", authorization, body });
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
    taskStatus = status("RUNNING");
    root = await mkdtemp(join(tmpdir(), "videobook-machgen-"));
    engine = createEngineForTest(root);
    client = await createTestClient(root);
    await pauseBookQueueForTests(engine.book.get().bookId);
    originalKey = process.env.MACHGEN_API_KEY;
    process.env.MACHGEN_API_KEY = "local-machgen-key";
    restoreEndpoints = configureProviderEndpoints({ machgenBaseURL: baseURL });
  });

  afterEach(async () => {
    restoreEndpoints();
    await client.close();
    if (originalKey === undefined) delete process.env.MACHGEN_API_KEY;
    else process.env.MACHGEN_API_KEY = originalKey;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
    return (result.content as Array<{ text: string }>)[0]!.text;
  }

  async function submitted(): Promise<string> {
    const bookId = engine.book.get().bookId;
    const result = await client.callTool({
      name: "generate_video",
      arguments: { book_id: bookId, model: "machgen:Seedance-2.5", prompt: "the cat blinks", refs: { first_frame: [FRAME] } },
    });
    expect(result.isError, toolText(result)).toBeFalsy();
    const enqueued = JSON.parse(toolText(result)) as { asset_id: string; job_id: string };
    await resumeBookQueueForTests(bookId);
    await waitForJob(enqueued.job_id, testBudget(30_000));
    return enqueued.asset_id;
  }

  it("submits, polls and downloads a MachGen video with the API key", async () => {
    const assetId = await submitted();
    const generate = recorded.find((entry) => entry.path === "/api/v0/generate")!;
    expect(generate.authorization).toBe("Bearer local-machgen-key");
    expect(JSON.parse(generate.body)).toEqual({
      model: "Seedance-2.5",
      task_type: "I2V",
      prompt: "the cat blinks",
      video_config: { height: 1080, duration_secs: 12, aspect_ratio: "adaptive", audio: true },
      src_image_urls: [FRAME],
    });
    const pending = engine.jobs.pending.read(assetId);
    expect(pending.ok && pending.value).toMatchObject({
      taskId: TASK_ID,
      taskType: "machgen_media",
      meta: { model: "machgen:Seedance-2.5", media: "video", machgenModel: "Seedance-2.5" },
    });
    const hints = await engine.metadata.artifacts.read(assetId, "generation-cost-hints");
    expect(hints.ok && hints.value).toEqual({ durationSeconds: 12 });
    expect(engine.usage.recent(10).find((entry) => entry.artifactId === assetId)).toMatchObject({
      provider: "machgen", model: "Seedance-2.5", activity: "video", status: "pending",
      externalId: TASK_ID, basis: "estimated", costUsd: expect.closeTo(7.08, 6), warnings: [],
    });
    expect(await readProviderTaskStatus(engine, assetId)).toEqual({ provider: "machgen", model: "Seedance-2.5", taskId: TASK_ID });

    const bookId = engine.book.get().bookId;
    const running = await pollPendingProviderTasks(engine, bookId);
    expect(running.pending).toEqual([expect.objectContaining({ assetId, taskType: "machgen_media", state: "running" })]);
    expect(running.completed).toEqual([]);

    taskStatus = status("COMPLETED", { task_output: { video: `${baseURL}/api/v0/assets/${TASK_ID}` } });
    const done = await pollPendingProviderTasks(engine, bookId);
    expect(done.failed).toEqual([]);
    expect(done.completed).toEqual([expect.objectContaining({ assetId, taskType: "machgen_media" })]);
    await waitForJob(done.completed[0]!.jobId, testBudget(30_000));

    const download = recorded.find((entry) => entry.path === `/api/v0/assets/${TASK_ID}`);
    expect(download?.authorization).toBe("Bearer local-machgen-key");
    const manifest = await engine.files.manifest(assetId);
    expect(manifest.ok && manifest.value.files.map((file) => file.name)).toContain("original.mp4");
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: null });
    expect(engine.usage.recent(10).find((entry) => entry.artifactId === assetId)).toMatchObject({ status: "completed" });
  });

  it("fails a MachGen task the provider reports as failed", async () => {
    const assetId = await submitted();
    taskStatus = status("FAILED", { error_msg: "Request Rejected" });
    const polled = await pollPendingProviderTasks(engine, engine.book.get().bookId);
    expect(polled.failed).toEqual([expect.objectContaining({ assetId, failMsg: "Request Rejected" })]);
    const failure = engine.jobs.failures.read(assetId);
    expect(failure.ok && failure.value?.message).toBe("Request Rejected");
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: null });
  });

  it("keeps polling through MachGen rate limits but fails a task MachGen no longer knows", async () => {
    const assetId = await submitted();
    const bookId = engine.book.get().bookId;
    taskStatus = { code: 429, body: { detail: "Too Many Requests" } };
    const limited = await pollPendingProviderTasks(engine, bookId);
    expect(limited.failed).toEqual([expect.objectContaining({ assetId, failMsg: "MachGen API error 429: Too Many Requests" })]);
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: expect.objectContaining({ taskId: TASK_ID }) });
    expect(engine.jobs.failures.read(assetId)).toMatchObject({ ok: true, value: null });

    taskStatus = { code: 404, body: { detail: "Task not found" } };
    await pollPendingProviderTasks(engine, bookId);
    const failure = engine.jobs.failures.read(assetId);
    expect(failure.ok && failure.value?.message).toBe("MachGen API error 404: Task not found");
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: null });
  });

  it("refuses MachGen generation without MACHGEN_API_KEY and leaves its tasks unpolled", async () => {
    const assetId = await submitted();
    recorded = [];
    delete process.env.MACHGEN_API_KEY;
    const before = engine.artifacts.list().length;
    const refused = await client.callTool({
      name: "generate_video",
      arguments: { book_id: engine.book.get().bookId, model: "machgen:MiniMax-H3", prompt: "a red boat" },
    });
    expect(refused.isError).toBe(true);
    expect(toolText(refused)).toBe("MACHGEN_API_KEY environment variable is not set");
    expect(engine.artifacts.list()).toHaveLength(before);

    const polled = await pollPendingProviderTasks(engine, engine.book.get().bookId);
    expect(polled).toEqual({ pending: [], completed: [], failed: [] });
    expect(recorded).toEqual([]);
    expect(engine.jobs.pending.read(assetId)).toMatchObject({ ok: true, value: expect.objectContaining({ taskId: TASK_ID }) });
  });
});
