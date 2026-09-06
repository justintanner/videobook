import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, LOCAL_CLIP_MANIFEST, type Engine } from "videobook-engine";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  registerLocalClapSearchProvider,
  registerLocalClipSearchProvider,
} from "./local-search-models.js";
import { indexArtifact, registerSemanticIndexJob } from "./jobs/semantic-index.js";
import { registerPrepareSearchReferenceJob } from "./jobs/prepare-search-reference.js";
import { queue, setEngineRoot, stopBookQueue } from "./queue.js";

import { searchReferenceStore } from "./search-reference-store.js";

type ModelEnvironmentName =
  | "VIDEOBOOK_MODEL_CACHE_DIR"
  | "VIDEOBOOK_MODEL_DOWNLOAD";

const environmentNames: ModelEnvironmentName[] = [
  "VIDEOBOOK_MODEL_CACHE_DIR",
  "VIDEOBOOK_MODEL_DOWNLOAD",
];

interface TransformersRuntime { env: { remoteHost: string } }
const runtime: TransformersRuntime = await import(new URL("./transformers-runtime.js", import.meta.resolve("videobook-engine")).href);

describe("local search provider registration", () => {
  let tempDir: string;
  let environmentSnapshot: Array<[ModelEnvironmentName, string | undefined]>;
  let engines: Engine[];
  let server: Server;
  let originalHost: string;
  let requests: string[];

  beforeEach(async () => {
    environmentSnapshot = environmentNames.map((name) => [name, process.env[name]]);
    for (const name of environmentNames) delete process.env[name];
    tempDir = await mkdtemp(join(tmpdir(), "videobook-local-search-test-"));
    engines = [];
    requests = [];
    originalHost = runtime.env.remoteHost;
    server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Model fixture did not listen");
    runtime.env.remoteHost = `http://127.0.0.1:${address.port}/`;
  });

  afterEach(async () => {
    for (const engine of engines) await stopBookQueue(engine.book.get().bookId);
    runtime.env.remoteHost = originalHost;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const engine of engines) engine.close();
    for (const [name, value] of environmentSnapshot) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it.each([undefined, "disabled", "", "true", "typo"])("keeps missing models offline with configuration %s and gives a preparation command", async (configuration) => {
    if (configuration !== undefined) process.env.VIDEOBOOK_MODEL_DOWNLOAD = configuration;
    process.env.VIDEOBOOK_MODEL_CACHE_DIR = join(tempDir, "missing-models");
    const engine = createTestEngine("missing");
    const visual = registerLocalClipSearchProvider(engine);
    const audio = registerLocalClapSearchProvider(engine, "ffmpeg");
    await expect(visual.prepare()).rejects.toMatchObject({ error: { code: "OFFLINE",
      message: expect.stringContaining("npm run prepare:search-models -- --download --models visual") } });
    await expect(visual.embedText("a red bicycle")).rejects.toThrow("Local visual search is not ready");
    await expect(audio.prepare()).rejects.toMatchObject({ error: { code: "OFFLINE",
      message: expect.stringContaining("npm run prepare:search-models -- --download --models audio") } });
    await expect(audio.embedText("a ringing bell")).rejects.toThrow("Local audio search is not ready");
    expect(requests).toEqual([]);
  });

  it("allows pinned model requests only with the explicit enabled configuration", async () => {
    process.env.VIDEOBOOK_MODEL_DOWNLOAD = "enabled";
    process.env.VIDEOBOOK_MODEL_CACHE_DIR = join(tempDir, "enabled-models");
    const engine = createTestEngine("enabled");
    await expect(registerLocalClipSearchProvider(engine).prepare()).rejects.toMatchObject({ error: { code: "FEATURE_UNAVAILABLE" } });
    await expect(registerLocalClapSearchProvider(engine, "ffmpeg").prepare()).rejects.toMatchObject({ error: { code: "FEATURE_UNAVAILABLE" } });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((url) => !url.includes("/main/"))).toBe(true);
  });

  it("defers semantic indexing with a missing cache while preserving original media", async () => {
    process.env.VIDEOBOOK_MODEL_CACHE_DIR = join(tempDir, "missing-index-models");
    const engine = createTestEngine("deferred-index");
    await engine.ready;
    const created = await engine.artifacts.create("image", "Original image");
    if (!created.ok) throw new Error(created.error.message);
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgYPgPAAEDAQBdlO9aAAAAAElFTkSuQmCC", "base64");
    expect((await engine.files.write(created.value.artifactId, "original.png", image)).ok).toBe(true);
    expect(await indexArtifact(engine, created.value.artifactId, { semanticVisual: true })).toMatchObject({ success: true, semanticVisual: "deferred" });
    expect(await engine.files.read(created.value.artifactId, "original.png")).toMatchObject({ ok: true, value: image });
    expect(engine.artifacts.get(created.value.artifactId)).toMatchObject({ ok: true, value: { artifactId: created.value.artifactId } });
    expect(requests).toEqual([]);
  });

  it("forwards cancellation and deadlines through every provider override", async () => {
    process.env.VIDEOBOOK_MODEL_CACHE_DIR = join(tempDir, "cancelled-models");
    const engine = createTestEngine("cancelled-providers");
    const visual = registerLocalClipSearchProvider(engine);
    const audio = registerLocalClapSearchProvider(engine, "ffmpeg");
    const options = { signal: AbortSignal.abort() };
    for (const call of [
      () => visual.prepare(options),
      () => visual.embedText("red bicycle", options),
      () => visual.embedImage(join(tempDir, "image.png"), options),
      () => audio.prepare(options),
      () => audio.embedText("ringing bell", options),
      () => audio.embedAudio(join(tempDir, "audio.wav"), 0, 1, options),
    ]) await expect(call()).rejects.toMatchObject({ error: { code: "CANCELLED" } });
    await expect(visual.prepare({ timeoutMs: 1 })).rejects.toMatchObject({ error: { code: "TIMEOUT" } });
    await expect(audio.prepare({ timeoutMs: 1 })).rejects.toMatchObject({ error: { code: "TIMEOUT" } });
    expect(requests).toEqual([]);
  });

  it.each(["semantic_index", "prepare_search_reference"])("fails model preparation in the actual %s queue without failing media, then retries indexing offline", async (type) => {
    process.env.VIDEOBOOK_MODEL_CACHE_DIR = join(tempDir, "failed-queue-models");
    process.env.VIDEOBOOK_MODEL_DOWNLOAD = "enabled";
    const { engine, artifactId, image, bookId } = await queuedImage("failed-queue");
    const payload = { type, assetId: artifactId, bookId, mediaKind: "image", name: "Reference" };
    await expect(queue.enqueueAndWait("failed-model", payload, 10_000)).rejects.toThrow();
    expect(engine.jobs.queue.list({ states: ["failed"] })).toEqual([
      expect.objectContaining({ type, artifactId: null, error: expect.objectContaining({ code: "FEATURE_UNAVAILABLE" }) }),
    ]);
    expect(engine.jobs.artifactWork.read(artifactId)).toMatchObject({ ok: true, value: { status: "ready", ownerId: null } });
    expect(await engine.files.read(artifactId, "original.png")).toMatchObject({ ok: true, value: image });
    process.env.VIDEOBOOK_MODEL_DOWNLOAD = "disabled";
    await expect(queue.enqueueAndWait("retry-model", { ...payload, type: "semantic_index" }, 10_000)).resolves.toMatchObject({ semanticVisual: "deferred" });
    expect(requests.length).toBeGreaterThan(0);
  });

  it.each(["semantic_index", "prepare_search_reference"])("rejects corrupted pinned cache files in the actual %s queue without failing source media", async (type) => {
    const cache = join(tempDir, "corrupted-models");
    process.env.VIDEOBOOK_MODEL_CACHE_DIR = cache;
    const model = join(cache, LOCAL_CLIP_MANIFEST.modelId, LOCAL_CLIP_MANIFEST.modelRevision);
    await mkdir(model, { recursive: true });
    await writeFile(join(model, "config.json"), '{"model_type":"clip"}');
    const { engine, artifactId, image, bookId } = await queuedImage(`corrupted-${type}`);
    await expect(registerLocalClipSearchProvider(engine).prepare()).rejects.toMatchObject({ error: { code: "MODEL_UNAVAILABLE" } });
    await expect(queue.enqueueAndWait("corrupted-model", {
      type, assetId: artifactId, bookId, mediaKind: "image", name: "Reference",
    }, 10_000)).rejects.toThrow("integrity");
    expect(engine.jobs.queue.list({ states: ["failed"] })).toEqual([
      expect.objectContaining({ type, artifactId: null, error: expect.objectContaining({ code: "MODEL_UNAVAILABLE" }) }),
    ]);
    expect(engine.jobs.artifactWork.read(artifactId)).toMatchObject({ ok: true, value: { status: "ready", ownerId: null } });
    expect(await engine.files.read(artifactId, "original.png")).toMatchObject({ ok: true, value: image });
    expect(requests).toEqual([]);
  });

  it.runIf(process.env.VIDEOBOOK_RUN_MODEL_E2E === "1")("prepares an existing image through the queue and finds its indexed source using cached offline models", async () => {
    process.env.VIDEOBOOK_MODEL_CACHE_DIR = join(homedir(), ".cache", "videobook", "models");
    const { engine, artifactId, bookId } = await queuedImage("offline-similar");
    await expect(queue.enqueueAndWait("index-for-similar", {
      type: "semantic_index", assetId: artifactId, bookId,
    }, 30_000)).resolves.toMatchObject({ semanticVisual: "ready" });
    const descriptor = await queue.enqueueAndWait("prepare-similar", {
      type: "prepare_search_reference", assetId: artifactId, bookId, mediaKind: "image", name: "Reference",
    }, 30_000) as { reference_id: string };
    try {
      const prepared = searchReferenceStore.get(descriptor.reference_id);
      const result = await engine.temporalSearch.queryPrepared({ modalities: ["visual"] }, prepared.reference);
      expect(result).toMatchObject({ ok: true, value: { hits: [expect.objectContaining({ artifactId })] } });
      expect(engine.jobs.artifactWork.read(artifactId)).toMatchObject({ ok: true, value: { status: "ready" } });
      expect(requests).toEqual([]);
    } finally { searchReferenceStore.release(descriptor.reference_id); }
  });

  it.each(["semantic_index", "prepare_search_reference"])("cancels a stalled model worker from the actual %s queue", async (type) => {
    process.env.VIDEOBOOK_MODEL_CACHE_DIR = join(tempDir, "stalled-queue-models");
    process.env.VIDEOBOOK_MODEL_DOWNLOAD = "enabled";
    let activeRequests = 0;
    server.removeAllListeners("request");
    server.on("request", (request, response) => {
      requests.push(request.url ?? "");
      activeRequests += 1;
      response.once("close", () => { activeRequests -= 1; });
    });
    const { engine, artifactId, image, bookId } = await queuedImage(`stalled-${type}`);
    const job = await queue.enqueue(`stalled-${type}`, {
      type, assetId: artifactId, bookId, mediaKind: "image", name: "Reference",
    });
    await expect.poll(() => requests.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const started = Date.now();
    expect(await engine.jobs.queue.abort(job.id, "Cancel stalled preparation")).toBe(true);
    await stopBookQueue(bookId);
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect.poll(() => activeRequests).toBe(0);
    expect(engine.jobs.queue.get(job.id)?.state).toBe("aborted");
    expect(engine.jobs.artifactWork.read(artifactId)).toMatchObject({ ok: true, value: { status: "ready", ownerId: null } });
    expect(await engine.files.read(artifactId, "original.png")).toMatchObject({ ok: true, value: image });
  });

  it.runIf(process.env.VIDEOBOOK_RUN_MODEL_E2E === "1")("keeps malformed-image failure job-local and indexes a corrected retry with the cached model", async () => {
    process.env.VIDEOBOOK_MODEL_CACHE_DIR = join(homedir(), ".cache", "videobook", "models");
    const { engine, artifactId, image, bookId } = await queuedImage("malformed-queue");
    expect((await engine.files.write(artifactId, "original.png", Buffer.from("invalid image"))).ok).toBe(true);
    const payload = { type: "semantic_index", assetId: artifactId, bookId };
    await expect(queue.enqueueAndWait("malformed-model", payload, 30_000)).rejects.toThrow();
    expect(engine.jobs.queue.list({ states: ["failed"] })).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: "INVALID_INPUT" }) }),
    ]);
    expect(engine.jobs.artifactWork.read(artifactId)).toMatchObject({ ok: true, value: { status: "ready" } });
    expect((await engine.files.write(artifactId, "original.png", image)).ok).toBe(true);
    await expect(queue.enqueueAndWait("corrected-model", payload, 30_000)).resolves.toMatchObject({ semanticVisual: "ready" });
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const hash = manifest.value.files.find((file) => file.name === "original.png")!.objectHash;
    expect(engine.temporalSearch.plan(artifactId, hash, LOCAL_CLIP_MANIFEST.manifestId, LOCAL_CLIP_MANIFEST.manifestId)).toMatchObject({
      ok: true, value: { coverage: expect.arrayContaining([expect.objectContaining({ phase: "visual", state: "ready" })]) },
    });
    expect(requests).toEqual([]);
  });

  it.runIf(process.env.VIDEOBOOK_RUN_MODEL_E2E === "1")("indexes audio in the actual queue without passing its source to the image decoder", async () => {
    process.env.VIDEOBOOK_MODEL_CACHE_DIR = join(homedir(), ".cache", "videobook", "models");
    const engine = createTestEngine("audio-queue");
    await engine.ready;
    await setEngineRoot(join(tempDir, "audio-queue"), engine);
    registerSemanticIndexJob(engine);
    const created = await engine.artifacts.create("audio", "Tone");
    if (!created.ok) throw new Error(created.error.message);
    const artifactId = created.value.artifactId;
    const { stdout: audio } = await promisify(execFile)("ffmpeg", [
      "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000", "-f", "wav", "pipe:1",
    ], { encoding: "buffer" });
    expect((await engine.files.write(artifactId, "original.wav", audio)).ok).toBe(true);
    const files = await engine.files.manifest(artifactId);
    if (!files.ok) throw new Error(files.error.message);
    const source = files.value.files.find((file) => file.name === "original.wav")!;
    expect((await engine.streams.register({
      artifactId, sourcePath: source.name, objectHash: source.objectHash, streamIndex: 0,
      kind: "audio", timeBase: { numerator: 1, denominator: 48_000 }, durationTicks: 48_000,
      codec: "pcm_s16le", audio: { sampleRateHz: 48_000, channels: 1, channelLayout: "mono" },
    })).ok).toBe(true);
    await expect(queue.enqueueAndWait("audio-model", {
      type: "semantic_index", assetId: artifactId, bookId: engine.book.get().bookId,
    }, 30_000)).resolves.toMatchObject({ semanticVisual: "not-applicable", semanticAudio: "ready" });
    expect(engine.jobs.artifactWork.read(artifactId)).toMatchObject({ ok: true, value: { status: "ready" } });
    expect(requests).toEqual([]);
  });

  async function queuedImage(name: string) {
    const engine = createTestEngine(name);
    await engine.ready;
    await setEngineRoot(join(tempDir, name), engine);
    registerSemanticIndexJob(engine);
    registerPrepareSearchReferenceJob(engine);
    const created = await engine.artifacts.create("image", name);
    if (!created.ok) throw new Error(created.error.message);
    const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: "red" } }).png().toBuffer();
    expect((await engine.files.write(created.value.artifactId, "original.png", image)).ok).toBe(true);
    return { engine, artifactId: created.value.artifactId, image, bookId: engine.book.get().bookId };
  }

  function createTestEngine(name: string): Engine {
    const engine = createEngine({
      rootDir: join(tempDir, name),
      initialBookName: name,
    });
    engines.push(engine);
    return engine;
  }

  it("reuses a CLIP provider only while one Engine's environment is unchanged", () => {
    const firstEngine = createTestEngine("first-clip");
    process.env.VIDEOBOOK_MODEL_CACHE_DIR = join(tempDir, "models-a");

    const first = registerLocalClipSearchProvider(firstEngine);
    expect(registerLocalClipSearchProvider(firstEngine)).toBe(first);

    process.env.VIDEOBOOK_MODEL_CACHE_DIR = join(tempDir, "models-b");
    const changedCacheDirectory = registerLocalClipSearchProvider(firstEngine);
    expect(changedCacheDirectory).not.toBe(first);
    expect(registerLocalClipSearchProvider(firstEngine)).toBe(changedCacheDirectory);

    process.env.VIDEOBOOK_MODEL_DOWNLOAD = "enabled";
    const downloadsEnabled = registerLocalClipSearchProvider(firstEngine);
    expect(downloadsEnabled).not.toBe(changedCacheDirectory);
    expect(firstEngine.temporalSearch.providers.list()).toEqual([downloadsEnabled.manifestId]);

    const secondEngine = createTestEngine("second-clip");
    const secondEngineProvider = registerLocalClipSearchProvider(secondEngine);
    expect(secondEngineProvider).not.toBe(downloadsEnabled);
    expect(secondEngine.temporalSearch.providers.list()).toEqual([secondEngineProvider.manifestId]);
    expect(registerLocalClipSearchProvider(firstEngine)).toBe(downloadsEnabled);
  });

  it("keys CLAP providers by Engine, environment, and ffmpeg path", () => {
    const firstEngine = createTestEngine("first-clap");
    process.env.VIDEOBOOK_MODEL_CACHE_DIR = join(tempDir, "models-a");

    const first = registerLocalClapSearchProvider(firstEngine, "/tools/ffmpeg-a");
    expect(registerLocalClapSearchProvider(firstEngine, "/tools/ffmpeg-a")).toBe(first);

    const changedFfmpeg = registerLocalClapSearchProvider(firstEngine, "/tools/ffmpeg-b");
    expect(changedFfmpeg).not.toBe(first);

    process.env.VIDEOBOOK_MODEL_DOWNLOAD = "enabled";
    const downloadsEnabled = registerLocalClapSearchProvider(firstEngine, "/tools/ffmpeg-b");
    expect(downloadsEnabled).not.toBe(changedFfmpeg);
    expect(firstEngine.temporalSearch.providers.list()).toEqual([downloadsEnabled.manifestId]);

    const secondEngine = createTestEngine("second-clap");
    const secondEngineProvider = registerLocalClapSearchProvider(secondEngine, "/tools/ffmpeg-b");
    expect(secondEngineProvider).not.toBe(downloadsEnabled);
    expect(secondEngine.temporalSearch.providers.list()).toEqual([secondEngineProvider.manifestId]);
    expect(registerLocalClapSearchProvider(firstEngine, "/tools/ffmpeg-b")).toBe(downloadsEnabled);
  });
});
