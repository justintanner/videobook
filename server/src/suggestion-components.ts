import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { analysisComponentKey } from "./analysis-components.js";
import type { SidecarAnalysisSpec, SidecarInput } from "./analysis-sidecars.js";
import { readArtifactJson } from "./analysis-sidecars.js";
import { INTELLIGENCE_MODEL } from "./openai-intelligence.js";
import { PLAIN_TRANSCRIPT_FILE, TIMED_TRANSCRIPT_FILE } from "./transcript-projection.js";
import { VIDEO_ANALYSIS_FILE } from "./video-analysis-projection.js";

export const SUGGESTED_CUTS: SidecarAnalysisSpec = { component: "suggested-cuts", version: 1, jobType: "suggest_cuts", sidecar: ".suggest-cuts.json" };

export const SUGGESTED_SFX: SidecarAnalysisSpec = { component: "suggested-sfx", version: 1, jobType: "suggest_sfx", sidecar: ".suggest-sfx.json" };

export const JOKES: SidecarAnalysisSpec = { component: "jokes", version: 1, jobType: "analyze_jokes", sidecar: ".analyze-jokes.json" };

export async function suggestionRecord(
  engine: Engine,
  spec: SidecarAnalysisSpec,
  artifactId: string,
  options: Record<string, unknown>,
): Promise<SidecarInput> {
  const manifest = await engine.files.manifest(artifactId, { includeDotfiles: true });
  if (!manifest.ok) throw new Error(manifest.error.message);
  const video = findVideoFile(manifest.value.files);
  if (!video) throw new Error("No video file found. Wait for the selected video's generation or upload to finish.");
  const hashOf = (name: string) => manifest.value.files.find((file) => file.name === name)?.objectHash ?? "";
  return {
    artifactId,
    key: analysisComponentKey(spec, {
      sourceHash: video.objectHash,
      dependencies: [`timed:${hashOf(TIMED_TRANSCRIPT_FILE)}`, `plain:${hashOf(PLAIN_TRANSCRIPT_FILE)}`, `analysis:${hashOf(VIDEO_ANALYSIS_FILE)}`],
      options: { ...options, model: INTELLIGENCE_MODEL },
    }),
    sourceHash: video.objectHash,
  };
}

export async function jokesRecord(engine: Engine, artifactId: string): Promise<SidecarInput> {
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const transcript = manifest.value.files.find((file) => file.name === TIMED_TRANSCRIPT_FILE);
  if (!transcript) throw new Error(`No ElevenLabs transcript found for ${artifactId} — run /transcribe @${artifactId} first.`);
  return {
    artifactId,
    key: analysisComponentKey(JOKES, { sourceHash: transcript.objectHash, options: { model: INTELLIGENCE_MODEL } }),
    sourceHash: transcript.objectHash,
  };
}

export async function cachedSuggestionSummary(engine: Engine, spec: SidecarAnalysisSpec, artifactId: string, list: string): Promise<Record<string, unknown>> {
  const document = await readArtifactJson(engine, artifactId, spec.sidecar);
  if (typeof document !== "object" || document === null) return {};
  const record = document as Record<string, unknown>;
  const entries = record[list];
  return { summary: record.summary ?? null, [list]: Array.isArray(entries) ? entries.length : 0 };
}
