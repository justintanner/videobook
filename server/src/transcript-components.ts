import type { Engine } from "videobook-engine";
import { analysisComponentKey } from "./analysis-components.js";
import type { SidecarAnalysisSpec, SidecarInput } from "./analysis-sidecars.js";
import { cachedSidecarAnalysis, fileObjectHash, recordSidecarAnalysis } from "./analysis-sidecars.js";
import { PLAIN_TRANSCRIPT_FILE, TIMED_TRANSCRIPT_FILE } from "./transcript-projection.js";

export const ELEVENLABS_TRANSCRIPT: SidecarAnalysisSpec = {
  component: "transcript-elevenlabs",
  version: 1,
  jobType: "transcribe",
  sidecar: TIMED_TRANSCRIPT_FILE,
};

export const OPENAI_TRANSCRIPT: SidecarAnalysisSpec = {
  component: "transcript-openai",
  version: 1,
  jobType: "transcribe_video_audio",
  sidecar: PLAIN_TRANSCRIPT_FILE,
};

export interface ElevenLabsTranscriptOptions {
  tagAudioEvents: boolean;
  diarize: boolean;
  languageCode?: string;
}

export const DEFAULT_TRANSCRIPT_OPTIONS: ElevenLabsTranscriptOptions = { tagAudioEvents: true, diarize: true };

export function elevenLabsTranscriptKey(audioHash: string, options: ElevenLabsTranscriptOptions): string {
  return analysisComponentKey(ELEVENLABS_TRANSCRIPT, {
    sourceHash: audioHash,
    options: { model: "scribe_v2", tagAudioEvents: options.tagAudioEvents, diarize: options.diarize, languageCode: options.languageCode ?? null },
  });
}

function defaultOptions(options: ElevenLabsTranscriptOptions): boolean {
  return options.tagAudioEvents && options.diarize && !options.languageCode;
}

export function openAiTranscriptKey(mediaHash: string): string {
  return analysisComponentKey(OPENAI_TRANSCRIPT, { sourceHash: mediaHash, options: { model: "gpt-transcribe" } });
}

export interface ElevenLabsTranscriptInput {
  artifactId: string;
  audioHash: string;
  options: ElevenLabsTranscriptOptions;
}

export function elevenLabsTranscriptRecord(input: ElevenLabsTranscriptInput): SidecarInput {
  return {
    artifactId: input.artifactId,
    key: elevenLabsTranscriptKey(input.audioHash, input.options),
    sourceHash: input.audioHash,
    adoptLegacy: async () => defaultOptions(input.options),
  };
}

export function hasCurrentElevenLabsTranscript(engine: Engine, input: ElevenLabsTranscriptInput): Promise<boolean> {
  return cachedSidecarAnalysis(engine, ELEVENLABS_TRANSCRIPT, elevenLabsTranscriptRecord(input));
}

export async function recordElevenLabsTranscript(engine: Engine, input: ElevenLabsTranscriptInput): Promise<void> {
  await recordSidecarAnalysis(engine, ELEVENLABS_TRANSCRIPT, {
    ...elevenLabsTranscriptRecord(input),
    provenance: { analyzer: "elevenlabs-speech-to-text", provider: "elevenlabs", model: "scribe_v2" },
  });
}

export function openAiTranscriptRecord(artifactId: string, mediaHash: string): SidecarInput {
  return { artifactId, key: openAiTranscriptKey(mediaHash), sourceHash: mediaHash, adoptLegacy: async () => true };
}

export async function recordOpenAiTranscript(engine: Engine, artifactId: string, mediaHash: string): Promise<void> {
  await recordSidecarAnalysis(engine, OPENAI_TRANSCRIPT, {
    ...openAiTranscriptRecord(artifactId, mediaHash),
    provenance: { analyzer: "openai-speech-to-text", provider: "openai", model: "gpt-transcribe" },
  });
}

export async function audioObjectHash(engine: Engine, artifactId: string, filename: string): Promise<string> {
  const hash = await fileObjectHash(engine, artifactId, filename);
  if (!hash) throw new Error(`${filename} is missing from ${artifactId}; process the media again before transcribing it.`);
  return hash;
}
