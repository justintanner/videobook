import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  LocalClapTemporalProvider,
  LocalClipTemporalProvider,
  type Engine,
  type MediaOperationOptions,
} from "videobook-engine";

interface LocalModelConfiguration {
  modelCacheDir: string;
  allowModelDownload: boolean;
}

interface ClipProviderRegistration extends LocalModelConfiguration {
  provider: LocalClipTemporalProvider;
  fixture?: boolean;
}

interface ClapProviderRegistration extends LocalModelConfiguration {
  ffmpegPath: string;
  provider: LocalClapTemporalProvider;
  fixture?: boolean;
}

const clipProvidersByEngine = new WeakMap<Engine, ClipProviderRegistration>();
const clapProvidersByEngine = new WeakMap<Engine, ClapProviderRegistration>();
const fixturesByBookId = new Map<string, {
  clip: LocalClipTemporalProvider;
  clap: LocalClapTemporalProvider;
}>();

function modelCacheDir(): string {
  return process.env.VIDEOBOOK_MODEL_CACHE_DIR?.trim()
    || join(homedir(), ".cache", "videobook", "models");
}

function allowModelDownload(): boolean {
  return process.env.VIDEOBOOK_MODEL_DOWNLOAD === "enabled";
}

export function localModelConfiguration(): LocalModelConfiguration {
  return {
    modelCacheDir: modelCacheDir(),
    allowModelDownload: allowModelDownload(),
  };
}

async function withPreparationHint<T>(model: "visual" | "audio", run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (cause) {
    if (cause instanceof Error && "error" in cause && cause.error && typeof cause.error === "object"
      && "code" in cause.error && cause.error.code === "OFFLINE" && "message" in cause.error) {
      const hint = `Local ${model} search is not ready. Run npm run prepare:search-models -- --download --models ${model} on the server, then retry.`;
      cause.message = `${hint} ${cause.message}`;
      cause.error.message = cause.message;
    }
    throw cause;
  }
}

class ClipSearchProvider extends LocalClipTemporalProvider {
  override prepare(options: MediaOperationOptions = {}) { return withPreparationHint("visual", () => super.prepare(options)); }
  override embedText(text: string, options: MediaOperationOptions = {}) { return withPreparationHint("visual", () => super.embedText(text, options)); }
  override embedImage(path: string, options: MediaOperationOptions = {}) { return withPreparationHint("visual", () => super.embedImage(path, options)); }
}

class ClapSearchProvider extends LocalClapTemporalProvider {
  override prepare(options: MediaOperationOptions = {}) { return withPreparationHint("audio", () => super.prepare(options)); }
  override embedText(text: string, options: MediaOperationOptions = {}) { return withPreparationHint("audio", () => super.embedText(text, options)); }
  override embedAudio(path: string, startSeconds?: number, durationSeconds?: number, options: MediaOperationOptions = {}) {
    return withPreparationHint("audio", () => super.embedAudio(path, startSeconds, durationSeconds, options));
  }
}

function hasMatchingConfiguration(
  cached: LocalModelConfiguration,
  current: LocalModelConfiguration,
): boolean {
  return cached.modelCacheDir === current.modelCacheDir
    && cached.allowModelDownload === current.allowModelDownload;
}

function fault(code: string, message: string): never {
  throw Object.assign(new Error(message), {
    name: code,
    error: { code, message },
  });
}

function throwIfAborted(options: MediaOperationOptions = {}): void {
  if (!options.signal?.aborted) return;
  fault("CANCELLED", "Cancelled");
}

function invalidInput(message: string): never {
  fault("INVALID_INPUT", message);
}

function hashEmbedding(payload: Buffer | string, dimensions: number): Float32Array {
  const digest = createHash("sha256").update(payload).digest();
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    vector[index] = digest[index % digest.length]! / 127.5 - 1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < dimensions; index += 1) vector[index] /= norm;
  }
  return vector;
}

class HashClipSearchProvider extends LocalClipTemporalProvider {
  constructor() {
    super({ modelCacheDir: "/dev/null", allowModelDownload: false });
  }

  override prepare(options: MediaOperationOptions = {}): Promise<void> {
    throwIfAborted(options);
    return Promise.resolve();
  }

  override embedText(text: string, options: MediaOperationOptions = {}): Promise<Float32Array> {
    throwIfAborted(options);
    return Promise.resolve(hashEmbedding(text, this.dimensions));
  }

  override async embedImage(sourcePath: string, options: MediaOperationOptions = {}): Promise<Float32Array> {
    throwIfAborted(options);
    try {
      const decoded = await sharp(sourcePath, { failOn: "error", limitInputPixels: 40_000_000 })
        .rotate()
        .toColourspace("srgb")
        .removeAlpha()
        .raw()
        .toBuffer();
      return hashEmbedding(decoded, this.dimensions);
    } catch (error) {
      if (error && typeof error === "object" && "error" in error) throw error;
      invalidInput("Unable to decode model image within the supported limits");
    }
  }
}

class HashClapSearchProvider extends LocalClapTemporalProvider {
  constructor() {
    super({ modelCacheDir: "/dev/null", allowModelDownload: false, ffmpegPath: "ffmpeg" });
  }

  override prepare(options: MediaOperationOptions = {}): Promise<void> {
    throwIfAborted(options);
    return Promise.resolve();
  }

  override embedText(text: string, options: MediaOperationOptions = {}): Promise<Float32Array> {
    throwIfAborted(options);
    return Promise.resolve(hashEmbedding(text, this.dimensions));
  }

  override async embedAudio(
    sourcePath: string,
    startSeconds = 0,
    durationSeconds = 10,
    options: MediaOperationOptions = {},
  ): Promise<Float32Array> {
    throwIfAborted(options);
    if (!(startSeconds >= 0) || !(durationSeconds > 0)) {
      invalidInput("CLAP audio range must have a non-negative start and positive duration");
    }
    const bytes = await readFile(sourcePath);
    return hashEmbedding(
      Buffer.concat([bytes, Buffer.from(`${startSeconds}:${durationSeconds}`)]),
      this.dimensions,
    );
  }
}

export function installLocalSearchProviderFixtures(engine: Engine): void {
  const configuration = localModelConfiguration();
  const clip = new HashClipSearchProvider();
  const clap = new HashClapSearchProvider();
  clipProvidersByEngine.set(engine, { ...configuration, provider: clip, fixture: true });
  clapProvidersByEngine.set(engine, {
    ...configuration,
    ffmpegPath: "ffmpeg",
    provider: clap,
    fixture: true,
  });
  fixturesByBookId.set(engine.book.get().bookId, { clip, clap });
  engine.temporalSearch.providers.register(clip, { modelDownloads: false });
  engine.temporalSearch.providers.register(clap, { modelDownloads: false });
}

function fixtureProviders(engine: Engine): {
  clip: LocalClipTemporalProvider;
  clap: LocalClapTemporalProvider;
} | undefined {
  const cached = clipProvidersByEngine.get(engine);
  const clap = clapProvidersByEngine.get(engine);
  if (cached?.fixture && clap?.fixture) return { clip: cached.provider, clap: clap.provider };
  try {
    return fixturesByBookId.get(engine.book.get().bookId);
  } catch {
    return undefined;
  }
}

export function registerLocalClipSearchProvider(
  engine: Engine,
): LocalClipTemporalProvider {
  const configuration = localModelConfiguration();
  const fixture = fixtureProviders(engine);
  if (fixture) {
    engine.temporalSearch.providers.register(fixture.clip, { modelDownloads: false });
    return fixture.clip;
  }
  const cached = clipProvidersByEngine.get(engine);
  if (cached && hasMatchingConfiguration(cached, configuration)) {
    engine.temporalSearch.providers.register(cached.provider, { modelDownloads: configuration.allowModelDownload });
    return cached.provider;
  }
  const provider = new ClipSearchProvider(configuration);
  clipProvidersByEngine.set(engine, {
    ...configuration,
    provider,
  });
  engine.temporalSearch.providers.register(provider, { modelDownloads: configuration.allowModelDownload });
  return provider;
}

export function registerLocalClapSearchProvider(
  engine: Engine,
  ffmpegPath: string,
): LocalClapTemporalProvider {
  const configuration = localModelConfiguration();
  const fixture = fixtureProviders(engine);
  if (fixture) {
    engine.temporalSearch.providers.register(fixture.clap, { modelDownloads: false });
    return fixture.clap;
  }
  const cached = clapProvidersByEngine.get(engine);
  if (
    cached
    && cached.ffmpegPath === ffmpegPath
    && hasMatchingConfiguration(cached, configuration)
  ) {
    engine.temporalSearch.providers.register(cached.provider, { modelDownloads: configuration.allowModelDownload });
    return cached.provider;
  }
  const provider = new ClapSearchProvider({
    ...configuration,
    ffmpegPath,
  });
  clapProvidersByEngine.set(engine, {
    ...configuration,
    ffmpegPath,
    provider,
  });
  engine.temporalSearch.providers.register(provider, { modelDownloads: configuration.allowModelDownload });
  return provider;
}
