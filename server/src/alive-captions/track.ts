import type { Engine } from "videobook-engine";
import type { AliveCue, AliveSettings, FrameGeometry } from "../remotion/subtitles/alive-types.js";
import { resolveAliveCues } from "../remotion/subtitles/alive-layout.js";
import { analyzeAliveCaptions } from "./analyze.js";
import { readAliveSettings } from "./model.js";

export interface AliveRenderTrack {
  settings: AliveSettings;
  cues: AliveCue[];
}

/** Cues positioned for one render target, analysing the video first when the cache is stale. */
export async function aliveRenderTrack(
  engine: Engine,
  assetId: string,
  geometry: FrameGeometry,
  signal: AbortSignal,
): Promise<AliveRenderTrack> {
  const analysis = await analyzeAliveCaptions(engine, assetId, signal);
  const settings = await readAliveSettings(engine, assetId);
  return { settings, cues: resolveAliveCues(analysis.phrases, settings, geometry) };
}
