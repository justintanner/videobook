import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { pauseBookQueueForTests, resumeBookQueueForTests, waitForJob, type JobHandlerContext, type LeaseToken } from "../queue.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";
import { pollPendingProviderTasks } from "../tools/reconcile-project-work.js";
import { generationSourceCostHints, runGenerateMedia, type GenerateMediaJob } from "../jobs/generate-media.js";
import { withBookContext } from "../book-context.js";
import { falAdapter } from "./adapters/fal.js";
import { resolveModel } from "./descriptor.js";
import { buildWireRequest } from "./request.js";
import { configureProviderEndpoints } from "./endpoints.js";

type RecordedRequest = { method: string; path: string; body: Buffer };

const ENV_KEYS = ["KIE_API_KEY", "FAL_API_KEY", "ELEVENLABS_API_KEY", "APICITY_PAYGATE_SECRET"] as const;

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function sendBytes(response: ServerResponse, bytes: Buffer, contentType: string): void {
  response.writeHead(200, { "content-type": contentType });
  response.end(bytes);
}

function toolJson(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text?: string }>;
  expect(result.isError, content[0]?.text).toBeFalsy();
  return JSON.parse(content[0]!.text!) as Record<string, unknown>;
}

function toolError(result: Awaited<ReturnType<Client["callTool"]>>): string {
  expect(result.isError).toBe(true);
  return (result.content as Array<{ text: string }>)[0]!.text;
}

describe("generic media generation", () => {
  let fixtures: string;
  let png: Buffer;
  let mp4: Buffer;
  let mp3: Buffer;
  let longClip: string;
  let shortClip: string;
  let server: Server;
  let baseURL: string;
  let requests: RecordedRequest[];
  let root: string;
  let engine: Engine;
  let client: Client;
  let restoreEndpoints: () => void;
  const originalEnv = new Map<string, string | undefined>();

  function route(path: string, response: ServerResponse): void {
    if (path === "/api/v1/jobs/createTask") return sendJson(response, { code: 200, msg: "success", data: { taskId: "kie-task-1" } });
    if (path.startsWith("/api/v1/jobs/recordInfo")) {
      return sendJson(response, {
        code: 200,
        msg: "success",
        data: { taskId: "kie-task-1", state: "success", resultJson: JSON.stringify({ resultUrls: [`${baseURL}/files/out.png`] }) },
      });
    }
    if (path === "/minimax/h3-max/relight" || path === "/pixverse/music-video/vibemv") return sendJson(response, { request_id: "fal-duration", status: "IN_QUEUE" });
    if (path === "/bytedance/seedream/v5/flash/text-to-image") return sendJson(response, { request_id: "fal-1", status: "IN_QUEUE" });
    if (path === "/bytedance/seedream/requests/fal-1/status") return sendJson(response, { status: "COMPLETED" });
    if (path === "/bytedance/seedream/requests/fal-1") return sendJson(response, { images: [{ url: `${baseURL}/files/out.png` }] });
    if (path === "/v1/sound-generation") return sendBytes(response, mp3, "audio/mpeg");
    if (path === "/files/out.png") return sendBytes(response, png, "image/png");
    response.writeHead(404).end();
  }

  beforeAll(async () => {
    fixtures = await mkdtemp(join(tmpdir(), "videobook-media-fixtures-"));
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", join(fixtures, "red.png")]);
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-pix_fmt", "yuv420p", join(fixtures, "clip.mp4")]);
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libmp3lame", join(fixtures, "tone.mp3")]);
    longClip = join(fixtures, "long.mp4");
    shortClip = join(fixtures, "short.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=green:s=64x64:d=17", "-pix_fmt", "yuv420p", longClip]);
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=green:s=64x64:d=6", "-pix_fmt", "yuv420p", shortClip]);
    png = await readFile(join(fixtures, "red.png"));
    mp4 = await readFile(join(fixtures, "clip.mp4"));
    mp3 = await readFile(join(fixtures, "tone.mp3"));
    server = createServer((request, response) => {
      void readBody(request).then((body) => {
        requests.push({ method: request.method ?? "", path: request.url ?? "", body });
        route(request.url ?? "", response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixtures, { recursive: true, force: true });
  });

  beforeEach(async () => {
    requests = [];
    root = await mkdtemp(join(tmpdir(), "videobook-generate-media-"));
    engine = createEngineForTest(root);
    client = await createTestClient(root);
    await pauseBookQueueForTests(engine.book.get().bookId);
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = `local-media-${key.toLowerCase()}`;
    }
    restoreEndpoints = configureProviderEndpoints({ kieBaseURL: baseURL, falQueueBaseURL: baseURL, elevenlabsBaseURL: baseURL });
  });

  afterEach(async () => {
    restoreEndpoints();
    await client.close();
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function imageArtifact(): Promise<string> {
    const created = await engine.artifacts.create("img", "source image");
    if (!created.ok) throw new Error(created.error.message);
    expect((await engine.files.write(created.value.artifactId, "original.png", png)).ok).toBe(true);
    return created.value.artifactId;
  }

  async function ownerContext(assetId: string): Promise<JobHandlerContext> {
    const lease = await engine.jobs.artifactWork.begin(assetId, { kind: "generate", ownerKind: "job", durationMs: 60_000 });
    if (!lease) throw new Error("could not lease asset");
    let token: LeaseToken = { kind: "owner", ownerId: lease.ownerId };
    return {
      jobId: 1,
      signal: new AbortController().signal,
      setLease: (next) => { token = next; },
      getOwnerId: () => {
        if (token.kind !== "owner") throw new Error("lease handed off");
        return token.ownerId;
      },
      markAssetFailureHandled: () => {},
    };
  }

  async function probedVideoArtifact(file: string): Promise<string> {
    const created = await engine.artifacts.create("vid", "reference clip");
    if (!created.ok) throw new Error(created.error.message);
    expect((await engine.files.write(created.value.artifactId, "original.mp4", await readFile(file))).ok).toBe(true);
    const { duration } = await probeVideo(file);
    expect((await engine.metadata.artifacts.write(created.value.artifactId, "original", { duration })).ok).toBe(true);
    return created.value.artifactId;
  }

  function queuedJob(assetId: string): GenerateMediaJob {
    const job = engine.jobs.queue.list({ type: "generate_media" }).find((entry) => (entry.payload as GenerateMediaJob).assetId === assetId);
    if (!job) throw new Error(`no generate_media job for ${assetId}`);
    return job.payload as GenerateMediaJob;
  }

  async function completePending(): Promise<void> {
    const polled = await pollPendingProviderTasks(engine, engine.book.get().bookId);
    expect(polled.failed).toEqual([]);
    await resumeBookQueueForTests(engine.book.get().bookId);
    for (const completed of polled.completed) await waitForJob(completed.jobId, 30_000);
  }

  it("lists catalog models by media and operation", async () => {
    const all = toolJson(await client.callTool({ name: "list_generation_models", arguments: {} })) as { models: Array<{ id: string; media: string; operations: string[] }> };
    expect(all.models.some((model) => model.id === "kie:bytedance/seedance-2-5")).toBe(true);
    const speech = toolJson(await client.callTool({ name: "list_generation_models", arguments: { media: "audio", operation: "speech" } })) as { models: Array<{ media: string; operations: string[] }> };
    expect(speech.models.length).toBeGreaterThan(5);
    for (const model of speech.models) expect(model).toMatchObject({ media: "audio", operations: expect.arrayContaining(["speech"]) });
    const seedance = all.models.find((model) => model.id === "kie:bytedance/seedance-2-5") as unknown as { options: Array<{ name: string; defaultValue?: unknown }>; modes: Array<{ id: string }> };
    expect(seedance.options).toEqual(expect.arrayContaining([expect.objectContaining({ name: "resolution", defaultValue: "1080p" })]));
    expect(seedance.modes.map((mode) => mode.id)).toEqual(["t2v", "i2v", "r2v", "v2v"]);
  });

  it("rejects bad generation calls before creating an artifact", async () => {
    const book_id = engine.book.get().bookId;
    const before = engine.artifacts.list().length;
    expect(toolError(await client.callTool({ name: "generate_image", arguments: { book_id, model: "generate_kie_nano_banana_2_1_image", prompt: "x" } }))).toMatch(/Unknown model/);
    expect(toolError(await client.callTool({ name: "generate_image", arguments: { book_id, model: "kie:bytedance/seedance-2-5", prompt: "x" } }))).toMatch(/generates video, not image/);
    expect(toolError(await client.callTool({ name: "generate_video", arguments: { book_id, model: "kie:bytedance/seedance-2-5", prompt: "x", options: { duration: 999 } } }))).toMatch(/Duration:/);
    expect(toolError(await client.callTool({ name: "generate_image", arguments: { book_id, model: "kie:nano-banana-2-1", prompt: "x", refs: { image: ["0198c2a0-0000-7000-8000-00000000dead"] } } }))).toMatch(/image ref/);
    expect(toolError(await client.callTool({ name: "generate_audio", arguments: { book_id, model: "kie:suno/generate", prompt: "x", operation: "speech" } }))).toMatch(/does not support speech/);
    expect(toolError(await client.callTool({ name: "generate_image", arguments: { book_id, model: "kie:nano-banana-2-1", prompt: "x", operation: "text_to_video" } }))).toMatch(/Input validation error/);
    const image = await imageArtifact();
    expect(toolError(await client.callTool({ name: "generate_video", arguments: { book_id, model: "kie:bytedance/seedance-2-5", prompt: "x", refs: { video: [image] } } }))).toMatch(/video ref must be a video artifact/);
    expect(engine.artifacts.list()).toHaveLength(before + 1);
  });

  it("validates Seedance edit sources before enqueueing and rechecks queued work", async () => {
    const book_id = engine.book.get().bookId;
    const model = "kie:bytedance/seedance-2-5";
    const source = await probedVideoArtifact(shortClip);
    const args = { book_id, model, prompt: "Edit @video1", mode: "v2v", options: { duration: 13, aspect_ratio: "9:16" } };
    const before = engine.artifacts.list().length;
    expect(toolError(await client.callTool({ name: "generate_video", arguments: { ...args, refs: { video: ["https://example.test/source.mp4"] } } })))
      .toContain("known duration");
    expect(engine.artifacts.list()).toHaveLength(before);
    const accepted = toolJson(await client.callTool({ name: "generate_video", arguments: { ...args, refs: { video: [source] } } }));
    const job = queuedJob(String(accepted.asset_id));
    await engine.metadata.artifacts.write(source.replace(/^@/, ""), "original", { duration: 31 });
    await expect(runGenerateMedia(engine, job, await ownerContext(job.assetId))).rejects.toThrow("between 4 and 30 seconds");
    expect(requests).toHaveLength(0);
  });

  it("generates a kie image from a reference through submit, poll and completion", async () => {
    const source = `${baseURL}/files/out.png`;
    const enqueued = toolJson(await client.callTool({
      name: "generate_image",
      arguments: { book_id: engine.book.get().bookId, model: "kie:nano-banana-2-1", prompt: "@image1 in the snow", refs: { image: [source] }, options: { aspect_ratio: "16:9" } },
    }));
    const assetId = String(enqueued.asset_id);
    const job = queuedJob(assetId);
    expect(job).toMatchObject({ model: "kie:nano-banana-2-1", refs: { image: [source] } });
    await runGenerateMedia(engine, job, await ownerContext(assetId));
    const submitted = JSON.parse(requests.find((entry) => entry.path === "/api/v1/jobs/createTask")!.body.toString()) as { model: string; input: Record<string, unknown> };
    expect(submitted).toMatchObject({
      model: "nano-banana-2-1",
      input: { prompt: "reference image 1 in the snow", aspect_ratio: "16:9", resolution: "2K", output_format: "jpg" },
    });
    expect(submitted.input.image_input).toEqual([source]);
    const pending = engine.jobs.pending.read(assetId);
    expect(pending.ok && pending.value).toMatchObject({ taskId: "kie-task-1", taskType: "media_kie", meta: { model: "kie:nano-banana-2-1", media: "image" } });
    await completePending();
    const manifest = await engine.files.manifest(assetId);
    expect(manifest.ok && manifest.value.files.map((file) => file.name)).toContain("original.png");
  });

  it("generates a fal image through the queue endpoints", async () => {
    const enqueued = toolJson(await client.callTool({
      name: "generate_image",
      arguments: { book_id: engine.book.get().bookId, model: "fal:bytedance/seedream/v5/flash/text-to-image", prompt: "a lighthouse" },
    }));
    const assetId = String(enqueued.asset_id);
    await runGenerateMedia(engine, queuedJob(assetId), await ownerContext(assetId));
    const submitted = JSON.parse(requests.find((entry) => entry.path === "/bytedance/seedream/v5/flash/text-to-image")!.body.toString()) as Record<string, unknown>;
    expect(submitted).toMatchObject({ prompt: "a lighthouse", image_size: "auto_2K", num_images: 1 });
    const payload = await engine.metadata.artifacts.read(assetId, "generation-payload");
    expect(payload.ok && payload.value).toMatchObject({ endpoint_id: "bytedance/seedream/v5/flash/text-to-image" });
    await completePending();
    const manifest = await engine.files.manifest(assetId);
    expect(manifest.ok && manifest.value.files.map((file) => file.name)).toContain("original.png");
  });

  it.each([
    { id: "fal:minimax/h3-max/relight", kind: "video" as const, duration: 6 },
    { id: "fal:pixverse/music-video/vibemv", kind: "audio" as const, duration: 12 },
  ])("prices $id usage from persisted source duration hints", async ({ id, kind, duration }) => {
    const source = await engine.artifacts.create(kind, "priced source");
    const output = await engine.artifacts.create("video", "priced output");
    if (!source.ok || !output.ok) throw new Error("Could not create usage fixtures");
    expect((await engine.metadata.artifacts.write(source.value.artifactId, "original", { duration })).ok).toBe(true);
    const refs = {
      urls: { [kind]: [`${baseURL}/source.${kind === "video" ? "mp4" : "mp3"}`], image: [`${baseURL}/files/out.png`] },
      sourceImageIds: [],
      sourceVideoIds: kind === "video" ? [source.value.artifactId] : [],
      sourceAudioIds: kind === "audio" ? [source.value.artifactId] : [],
    };
    const model = resolveModel(id);
    const built = buildWireRequest(model, { refUrls: refs.urls, options: {} });
    if (!built.ok) throw new Error(built.error);
    const hints = await generationSourceCostHints(engine, refs, { model: id });
    expect(hints).toEqual({ inputDurationSeconds: duration });
    const assetId = output.value.artifactId;
    const bookId = engine.book.get().bookId;
    const ctx = await ownerContext(assetId);
    await withBookContext({ engine, bookId, artifactId: assetId, operation: "generate_media" }, () =>
      falAdapter.submit(built.request, {
        engine, bookId, assetId, assetDir: "", ctx, model, meta: {}, costHints: hints,
      }));
    const persisted = await engine.metadata.artifacts.read(assetId, "generation-cost-hints");
    expect(persisted.ok && persisted.value).toEqual({ inputDurationSeconds: duration, durationSeconds: duration });
    const usage = engine.usage.recent(10).find(entry => entry.artifactId === assetId);
    expect(usage).toMatchObject({ provider: "fal", model: model.apiId, basis: "estimated", status: "pending", warnings: [] });
    expect(usage?.costUsd).toBeGreaterThan(0);
    expect(usage?.units).toBe(duration);
  });

  it("keeps audio duration fallback out of Kie paygate hints", async () => {
    const source = await engine.artifacts.create("audio", "source song");
    if (!source.ok) throw new Error(source.error.message);
    expect((await engine.metadata.artifacts.write(source.value.artifactId, "original", { duration: 12 })).ok).toBe(true);
    const refs = { urls: {}, sourceImageIds: [], sourceVideoIds: [] as string[], sourceAudioIds: [source.value.artifactId] };
    expect(await generationSourceCostHints(engine, refs, { model: "kie:bytedance/seedance-2-5" })).toEqual({});
    const video = await probedVideoArtifact(shortClip);
    refs.sourceVideoIds.push(video);
    expect(await generationSourceCostHints(engine, refs, { model: "kie:bytedance/seedance-2-5" }))
      .toEqual({ inputDurationSeconds: 6 });
    expect(await generationSourceCostHints(engine, refs, { model: "kie:bytedance/seedance-2-5", mode: "v2v" }))
      .toEqual({ inputDurationSeconds: 6, durationSeconds: 6 });
  });

  it("writes synchronous ElevenLabs audio straight into the artifact", async () => {
    const enqueued = toolJson(await client.callTool({
      name: "generate_audio",
      arguments: { book_id: engine.book.get().bookId, model: "elevenlabs:sound-generation", prompt: "Glass shattering", options: { duration_seconds: 2 } },
    }));
    const assetId = String(enqueued.asset_id);
    const result = await runGenerateMedia(engine, queuedJob(assetId), await ownerContext(assetId));
    expect(result).toMatchObject({ status: "done" });
    expect(JSON.parse(requests.find((entry) => entry.path === "/v1/sound-generation")!.body.toString())).toMatchObject({ text: "Glass shattering", duration_seconds: 2 });
    const metadata = await engine.metadata.artifacts.read<Record<string, unknown>>(assetId, "original");
    expect(metadata.ok && metadata.value).toMatchObject({ model: "elevenlabs:sound-generation", prompt: "Glass shattering" });
    expect(metadata.ok && Number(metadata.value.duration)).toBeGreaterThan(0.5);
  });

  it("holds MiniMax H3 reference clips to the apicity duration window before creating or submitting work", async () => {
    const book_id = engine.book.get().bookId;
    const model = "kie:minimax-h3/reference-to-video";
    const long = await probedVideoArtifact(longClip);
    const short = await probedVideoArtifact(shortClip);
    const before = engine.artifacts.list().length;
    expect(toolError(await client.callTool({ name: "generate_video", arguments: { book_id, model, options: { duration: 6 }, prompt: "@video1 at dusk", refs: { video: [long] } } })))
      .toMatch(new RegExp(`video ref ${long} is 17 s; ${model} accepts 2-15 s per video reference`));
    expect(toolError(await client.callTool({ name: "generate_video", arguments: { book_id, model, options: { duration: 6 }, prompt: "@video1 @video2 @video3", refs: { video: [short, short, short] } } })))
      .toMatch(/video refs total 18 s; .* accepts at most 15 s of video references/);
    expect(engine.artifacts.list()).toHaveLength(before);

    const unknown = await engine.artifacts.create("vid", "clip without metadata");
    if (!unknown.ok) throw new Error(unknown.error.message);
    expect((await engine.files.write(unknown.value.artifactId, "original.mp4", await readFile(longClip))).ok).toBe(true);
    toolJson(await client.callTool({ name: "generate_video", arguments: { book_id, model, options: { duration: 6 }, prompt: "@video1 at dusk", refs: { video: [unknown.value.artifactId] } } }));
    const accepted = toolJson(await client.callTool({ name: "generate_video", arguments: { book_id, model, options: { duration: 6 }, prompt: "@video1 at dusk", refs: { video: [short] } } }));
    expect(queuedJob(String(accepted.asset_id)).refs).toEqual({ video: [short] });

    const stale = { ...queuedJob(String(accepted.asset_id)), refs: { video: [long] } };
    await expect(runGenerateMedia(engine, stale, await ownerContext(stale.assetId))).rejects.toThrow(/is 17 s; .* accepts 2-15 s/);
    expect(requests.filter((entry) => entry.path === "/api/v1/jobs/createTask")).toEqual([]);
  });

  it("keeps the video fixture available for reference-video models", async () => {
    const created = await engine.artifacts.create("vid", "clip");
    if (!created.ok) throw new Error(created.error.message);
    expect((await engine.files.write(created.value.artifactId, "original.mp4", mp4)).ok).toBe(true);
    const result = await client.callTool({
      name: "generate_video",
      arguments: { book_id: engine.book.get().bookId, model: "kie:kling-3.0/motion-control", prompt: "dance", refs: { video: [created.value.artifactId] } },
    });
    expect(toolError(result)).toMatch(/requires at least 1 image ref/);
  });

  it("rejects invalid H3 insertion windows before creating or uploading media", async () => {
    const book_id = engine.book.get().bookId;
    const source = await probedVideoArtifact(shortClip);
    const model = "fal:minimax/h3-max/insert-video";
    const before = engine.artifacts.list().length;
    for (const options of [
      { start_time: 14, resume_time: 6, duration: 13 },
      { start_time: 2, resume_time: 7, duration: 13 },
      { start_time: 7, resume_time: 8, duration: 13 },
      { start_time: "2", resume_time: "7", duration: "13" },
    ]) {
      const result = await client.callTool({ name: "generate_video", arguments: { book_id, model, refs: { video: [source] }, options } });
      expect(toolError(result)).toMatch(/Resume original|Replace from/);
    }
    expect(engine.artifacts.list()).toHaveLength(before);
    expect(engine.jobs.queue.list({ type: "generate_media" })).toHaveLength(0);
    const accepted = toolJson(await client.callTool({ name: "generate_video", arguments: {
      book_id, model, refs: { video: [source] }, options: { start_time: 2, resume_time: 4, duration: 13 },
    } }));
    const job = queuedJob(String(accepted.asset_id));
    await expect(runGenerateMedia(engine, { ...job, options: { ...job.options, start_time: 14 } }, await ownerContext(job.assetId)))
      .rejects.toThrow(/Replace from/);
    expect(requests).toHaveLength(0);
  });
});
