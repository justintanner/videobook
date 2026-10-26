import type { Engine } from "videobook-engine";
import { analysisComponentKey } from "./analysis-components.js";
import type { SidecarAnalysisSpec, SidecarInput } from "./analysis-sidecars.js";
import { cachedSidecarAnalysis, fileObjectHash, readArtifactJson, recordSidecarAnalysis, STALE_ANALYSIS_INPUTS } from "./analysis-sidecars.js";
import { requireApiKey } from "./api-key.js";
import { sidecarMatchesSource, translatedTranscriptFilename, translateTranscript } from "./jobs/_translate-transcript.js";
import { buildIntelligenceResponses, INTELLIGENCE_MODEL } from "./openai-intelligence.js";
import { parseSegments } from "./remotion/subtitles/segments.js";
import { TIMED_TRANSCRIPT_FILE } from "./transcript-projection.js";

type SegmentsInput = Parameters<typeof parseSegments>[0];

export type TranscriptTranslationStatus = "cached" | "translated";

export function transcriptTranslationSpec(language: string): SidecarAnalysisSpec {
  return {
    component: `transcript-translation.${language}`,
    version: 1,
    jobType: "translate_transcript",
    sidecar: translatedTranscriptFilename(language),
  };
}

function transcriptTranslationKey(transcriptHash: string, language: string): string {
  return analysisComponentKey(transcriptTranslationSpec(language), { sourceHash: transcriptHash, options: { language, model: INTELLIGENCE_MODEL } });
}

async function legacyTranslationMatches(engine: Engine, artifactId: string, language: string): Promise<boolean> {
  const [raw, sidecar] = await Promise.all([
    readArtifactJson(engine, artifactId, TIMED_TRANSCRIPT_FILE),
    readArtifactJson(engine, artifactId, translatedTranscriptFilename(language)),
  ]);
  return Boolean(raw && sidecar && sidecarMatchesSource(sidecar, parseSegments(raw as SegmentsInput)));
}

export function transcriptTranslationRecord(engine: Engine, artifactId: string, transcriptHash: string, language: string): SidecarInput {
  return {
    artifactId,
    key: transcriptTranslationKey(transcriptHash, language),
    sourceHash: transcriptHash,
    adoptLegacy: () => legacyTranslationMatches(engine, artifactId, language),
  };
}

async function currentTranscriptHash(engine: Engine, artifactId: string): Promise<string> {
  const hash = await fileObjectHash(engine, artifactId, TIMED_TRANSCRIPT_FILE);
  if (!hash) throw new Error(`No transcript for ${artifactId}. Transcribe the asset first.`);
  return hash;
}

export async function ensureTranscriptTranslation(
  engine: Engine,
  artifactId: string,
  language: string,
  options: { force: boolean; signal?: AbortSignal },
): Promise<TranscriptTranslationStatus> {
  const transcriptHash = await currentTranscriptHash(engine, artifactId);
  const spec = transcriptTranslationSpec(language);
  const record = transcriptTranslationRecord(engine, artifactId, transcriptHash, language);
  if (!options.force && await cachedSidecarAnalysis(engine, spec, record)) return "cached";
  const raw = await readArtifactJson(engine, artifactId, TIMED_TRANSCRIPT_FILE);
  if (!raw) throw new Error(`The transcript for ${artifactId} is unreadable. Transcribe the asset again.`);
  const sidecar = await translateTranscript(raw, language, buildIntelligenceResponses(requireApiKey("OPENAI_API_KEY")), options.signal);
  options.signal?.throwIfAborted();
  if (await fileObjectHash(engine, artifactId, TIMED_TRANSCRIPT_FILE) !== transcriptHash) throw new Error(STALE_ANALYSIS_INPUTS);
  const written = await engine.files.write(artifactId, spec.sidecar, JSON.stringify(sidecar, null, 2));
  if (!written.ok) throw new Error(`Failed to write ${spec.sidecar}: ${written.error.message}`);
  await recordSidecarAnalysis(engine, spec, {
    ...record,
    provenance: { analyzer: "transcript-translation", provider: "openai", model: INTELLIGENCE_MODEL },
  });
  return "translated";
}
