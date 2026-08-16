import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import {
  registerLocalClapSearchProvider,
  registerLocalClipSearchProvider,
} from "./local-search-models.js";

type ModelEnvironmentName =
  | "VIDEOBOOK_MODEL_CACHE_DIR"
  | "VIDEOBOOK_MODEL_DOWNLOAD";

const environmentNames: ModelEnvironmentName[] = [
  "VIDEOBOOK_MODEL_CACHE_DIR",
  "VIDEOBOOK_MODEL_DOWNLOAD",
];

describe("local search provider registration", () => {
  let tempDir: string;
  let environmentSnapshot: Array<[ModelEnvironmentName, string | undefined]>;
  let engines: Engine[];

  beforeEach(async () => {
    environmentSnapshot = environmentNames.map((name) => [name, process.env[name]]);
    for (const name of environmentNames) delete process.env[name];
    tempDir = await mkdtemp(join(tmpdir(), "videobook-local-search-test-"));
    engines = [];
  });

  afterEach(async () => {
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

    process.env.VIDEOBOOK_MODEL_DOWNLOAD = "disabled";
    const downloadsDisabled = registerLocalClipSearchProvider(firstEngine);
    expect(downloadsDisabled).not.toBe(changedCacheDirectory);
    expect(firstEngine.temporalSearch.providers.list()).toEqual([downloadsDisabled.manifestId]);

    const secondEngine = createTestEngine("second-clip");
    const secondEngineProvider = registerLocalClipSearchProvider(secondEngine);
    expect(secondEngineProvider).not.toBe(downloadsDisabled);
    expect(secondEngine.temporalSearch.providers.list()).toEqual([secondEngineProvider.manifestId]);
    expect(registerLocalClipSearchProvider(firstEngine)).toBe(downloadsDisabled);
  });

  it("keys CLAP providers by Engine, environment, and ffmpeg path", () => {
    const firstEngine = createTestEngine("first-clap");
    process.env.VIDEOBOOK_MODEL_CACHE_DIR = join(tempDir, "models-a");

    const first = registerLocalClapSearchProvider(firstEngine, "/tools/ffmpeg-a");
    expect(registerLocalClapSearchProvider(firstEngine, "/tools/ffmpeg-a")).toBe(first);

    const changedFfmpeg = registerLocalClapSearchProvider(firstEngine, "/tools/ffmpeg-b");
    expect(changedFfmpeg).not.toBe(first);

    process.env.VIDEOBOOK_MODEL_DOWNLOAD = "disabled";
    const downloadsDisabled = registerLocalClapSearchProvider(firstEngine, "/tools/ffmpeg-b");
    expect(downloadsDisabled).not.toBe(changedFfmpeg);
    expect(firstEngine.temporalSearch.providers.list()).toEqual([downloadsDisabled.manifestId]);

    const secondEngine = createTestEngine("second-clap");
    const secondEngineProvider = registerLocalClapSearchProvider(secondEngine, "/tools/ffmpeg-b");
    expect(secondEngineProvider).not.toBe(downloadsDisabled);
    expect(secondEngine.temporalSearch.providers.list()).toEqual([secondEngineProvider.manifestId]);
    expect(registerLocalClapSearchProvider(firstEngine, "/tools/ffmpeg-b")).toBe(downloadsDisabled);
  });
});
