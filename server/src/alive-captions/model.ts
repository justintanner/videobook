import { createHash } from "node:crypto";
import type { ArtifactManifestFile, Engine } from "videobook-engine";
import type { AliveAnalysis, AliveSettings } from "../remotion/subtitles/alive-types.js";
import { DEFAULT_ALIVE_SETTINGS } from "../remotion/subtitles/alive-types.js";
import { ALIVE_ANALYSIS_VERSION, aliveAnalysisSchema, aliveSettingsSchema } from "./schema.js";

const ALIVE_ANALYSIS_METADATA_KEY = "alive-captions.analysis";
const ALIVE_SETTINGS_METADATA_KEY = "alive-captions.settings";

export function aliveFingerprint(videoFile: ArtifactManifestFile, transcript: Buffer): string {
  return createHash("sha256").update(JSON.stringify({
    version: ALIVE_ANALYSIS_VERSION,
    video: { name: videoFile.name, size: videoFile.sizeBytes, objectHash: videoFile.objectHash },
    transcript: createHash("sha256").update(transcript).digest("hex"),
  })).digest("hex");
}

export async function readAliveAnalysis(engine: Engine, assetId: string): Promise<AliveAnalysis | null> {
  const result = await engine.metadata.artifacts.read<unknown>(assetId, ALIVE_ANALYSIS_METADATA_KEY);
  if (!result.ok) return null;
  const parsed = aliveAnalysisSchema.safeParse(result.value);
  return parsed.success ? parsed.data : null;
}

export async function writeAliveAnalysis(engine: Engine, assetId: string, analysis: AliveAnalysis): Promise<void> {
  const result = await engine.metadata.artifacts.write(assetId, ALIVE_ANALYSIS_METADATA_KEY, aliveAnalysisSchema.parse(analysis));
  if (!result.ok) throw new Error(`Failed to persist alive caption analysis: ${result.error.message}`);
}

/** Stored settings merged over the defaults; unreadable fields fall back individually. */
export async function readAliveSettings(engine: Engine, assetId: string): Promise<AliveSettings> {
  const result = await engine.metadata.artifacts.read<unknown>(assetId, ALIVE_SETTINGS_METADATA_KEY);
  if (!result.ok) return DEFAULT_ALIVE_SETTINGS;
  const partial = aliveSettingsSchema.partial().safeParse(result.value);
  return partial.success ? { ...DEFAULT_ALIVE_SETTINGS, ...partial.data } : DEFAULT_ALIVE_SETTINGS;
}

export async function writeAliveSettings(engine: Engine, assetId: string, settings: AliveSettings): Promise<void> {
  const result = await engine.metadata.artifacts.write(assetId, ALIVE_SETTINGS_METADATA_KEY, aliveSettingsSchema.parse(settings));
  if (!result.ok) throw new Error(`Failed to persist alive caption settings: ${result.error.message}`);
}
