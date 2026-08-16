import { homedir } from "node:os";
import { join } from "node:path";
import {
  LocalClapTemporalProvider,
  LocalClipTemporalProvider,
  type Engine,
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
  return process.env.VIDEOBOOK_MODEL_DOWNLOAD !== "disabled";
}

function localModelConfiguration(): LocalModelConfiguration {
  return {
    modelCacheDir: modelCacheDir(),
    allowModelDownload: allowModelDownload(),
  };
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
    engine.temporalSearch.providers.register(cached.provider);
    return cached.provider;
  }
  const provider = new LocalClipTemporalProvider(configuration);
  clipProvidersByEngine.set(engine, {
    ...configuration,
    provider,
  });
  engine.temporalSearch.providers.register(provider);
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
    engine.temporalSearch.providers.register(cached.provider);
    return cached.provider;
  }
  const provider = new LocalClapTemporalProvider({
    ...configuration,
    ffmpegPath,
  });
  clapProvidersByEngine.set(engine, {
    ...configuration,
    ffmpegPath,
    provider,
  });
  engine.temporalSearch.providers.register(provider);
  return provider;
}
