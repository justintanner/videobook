import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import {
  registerLocalClapSearchProvider,
  registerLocalClipSearchProvider,
} from "./local-search-models.js";
import { indexArtifact } from "./jobs/semantic-index.js";

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
