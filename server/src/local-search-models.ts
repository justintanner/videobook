import { homedir } from "node:os";
import { join } from "node:path";
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
}

interface ClapProviderRegistration extends LocalModelConfiguration {
  ffmpegPath: string;
  provider: LocalClapTemporalProvider;
}

const clipProvidersByEngine = new WeakMap<Engine, ClipProviderRegistration>();
const clapProvidersByEngine = new WeakMap<Engine, ClapProviderRegistration>();

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

export function registerLocalClipSearchProvider(
  engine: Engine,
): LocalClipTemporalProvider {
  const configuration = localModelConfiguration();
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
