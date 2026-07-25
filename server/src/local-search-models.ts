import { homedir } from "node:os";
import { join } from "node:path";
import {
  LocalClapTemporalProvider,
  LocalClipTemporalProvider,
  type Engine,
} from "videobook-engine";

let clipProvider: LocalClipTemporalProvider | null = null;
let clapProvider: LocalClapTemporalProvider | null = null;

function modelCacheDir(): string {
  return process.env.VIDEOBOOK_MODEL_CACHE_DIR?.trim()
    || join(homedir(), ".cache", "videobook", "models");
}

function allowModelDownload(): boolean {
  return process.env.VIDEOBOOK_MODEL_DOWNLOAD !== "disabled";
}

export function registerLocalClipSearchProvider(
  engine: Engine,
): LocalClipTemporalProvider {
  if (clipProvider) {
    engine.temporalSearch.providers.register(clipProvider);
    return clipProvider;
  }
  clipProvider = new LocalClipTemporalProvider({
    modelCacheDir: modelCacheDir(),
    allowModelDownload: allowModelDownload(),
  });
  engine.temporalSearch.providers.register(clipProvider);
  return clipProvider;
}

export function registerLocalClapSearchProvider(
  engine: Engine,
  ffmpegPath: string,
): LocalClapTemporalProvider {
  if (clapProvider) {
    engine.temporalSearch.providers.register(clapProvider);
    return clapProvider;
  }
  clapProvider = new LocalClapTemporalProvider({
    modelCacheDir: modelCacheDir(),
    ffmpegPath,
    allowModelDownload: allowModelDownload(),
  });
  engine.temporalSearch.providers.register(clapProvider);
  return clapProvider;
}
