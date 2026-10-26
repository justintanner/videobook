import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { getApiKey } from "../api-key.js";
import { runAnalysisComponentJob } from "../analysis-components.js";
import {
  CAPTION_REGIONS,
  CAPTION_TRANSCRIPT_JOB,
  CAPTION_TRANSLATION,
  CAPTION_VOCAL,
  continueCaptionPreparation,
  readCaptionTranscript,
  regionFrameRequests,
  regionsComponentKey,
  regionsValueSchema,
  translationComponentKey,
  translationValueSchema,
  vocalComponentKey,
  vocalValueSchema,
} from "../captions/analysis.js";
import type { CaptionRegions, CaptionTranscript, CaptionTranslation } from "../captions/analysis.js";
import { detectFrameRegions, extractFrames } from "../captions/frames.js";
import type { FrameRegion } from "../captions/frames.js";
import type { CaptionMediaSource } from "../captions/source.js";
import { captionMediaSource } from "../captions/source.js";
import { analyzeVocalTiming } from "../captions/vocal.js";
import { runFfmpeg } from "../ffmpeg.js";
import { logger } from "../logger.js";
import { INTELLIGENCE_MODEL } from "../openai-intelligence.js";
import { registerJobHandler } from "../queue.js";
import { parseSegments } from "../remotion/subtitles/segments.js";
import { audioObjectHash } from "../transcript-components.js";
import { requestElevenLabsTranscript, writeElevenLabsTranscript } from "./_transcribe.js";
import { translatedTranscriptFilename } from "./_translate-transcript.js";
import { fileObjectHash } from "../analysis-sidecars.js";
import { ensureTranscriptTranslation, readArtifactJson } from "../transcript-translation.js";

const TRANSCRIBE_OPTIONS = { tagAudioEvents: true, diarize: true } as const;

interface TranscriptPayload {
  bookId: string;
  sourceArtifactId: string;
  mediaHash: string;
  force?: boolean;
}

interface ComponentPayload extends TranscriptPayload {
  transcriptHash: string;
  componentKey: string;
}

interface TranslationPayload extends ComponentPayload {
  language: string;
}

async function continuePreparation(engine: Engine, payload: TranscriptPayload): Promise<void> {
  try {
    await continueCaptionPreparation(engine, payload.bookId, payload.sourceArtifactId);
  } catch (error) {
    logger.warn("caption-preparation-continue-failed", { artifactId: payload.sourceArtifactId, error });
  }
}

const STALE_SOURCE = "The video changed while its subtitles were being prepared, so this result was discarded. Prepare them again.";

async function unchangedSource(engine: Engine, artifactId: string, mediaHash: string): Promise<CaptionMediaSource> {
  const source = await captionMediaSource(engine, artifactId);
  if (source.mediaHash !== mediaHash) throw new Error(STALE_SOURCE);
  return source;
}

function currentSource(engine: Engine, payload: TranscriptPayload): Promise<CaptionMediaSource> {
  return unchangedSource(engine, payload.sourceArtifactId, payload.mediaHash);
}

async function sourceAudio(engine: Engine, source: CaptionMediaSource, signal: AbortSignal): Promise<string> {
  if (source.audioFile) return source.audioFile.name;
  const dir = await mkdtemp(join(tmpdir(), "videobook-caption-audio-"));
  try {
    const output = join(dir, "original.mp3");
    await runFfmpeg(["-y", "-i", source.path, "-vn", "-acodec", "libmp3lame", "-q:a", "2", "-f", "mp3", output], { signal });
    const written = await engine.files.writeFromPath(source.artifactId, "original.mp3", output);
    if (!written.ok) throw new Error(written.error.message);
    return "original.mp3";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runTranscript(engine: Engine, payload: TranscriptPayload, signal: AbortSignal) {
  const source = await currentSource(engine, payload);
  if (!source.hasAudio) return { silent: true };
  if (source.transcriptFile && !payload.force) {
    await continuePreparation(engine, payload);
    return { transcriptHash: source.transcriptFile.objectHash, reused: true };
  }
  const audio = await sourceAudio(engine, source, signal);
  const audioHash = await audioObjectHash(engine, source.artifactId, audio);
  const response = await requestElevenLabsTranscript(engine, source.artifactId, audio, TRANSCRIBE_OPTIONS);
  signal.throwIfAborted();
  await currentSource(engine, payload);
  if (await audioObjectHash(engine, source.artifactId, audio) !== audioHash) throw new Error(STALE_SOURCE);
  await writeElevenLabsTranscript(engine, source.artifactId, response, TRANSCRIBE_OPTIONS, audioHash);
  const written = await currentSource(engine, payload);
  await continuePreparation(engine, payload);
  return { transcriptHash: written.transcriptFile?.objectHash ?? null, reused: false };
}

async function sourceTranscript(engine: Engine, payload: ComponentPayload): Promise<{ source: CaptionMediaSource; transcript: CaptionTranscript }> {
  const source = await currentSource(engine, payload);
  const transcript = await readCaptionTranscript(engine, source);
  if (!transcript || transcript.hash !== payload.transcriptHash) throw new Error(STALE_SOURCE);
  return { source, transcript };
}

async function currentKey(engine: Engine, payload: ComponentPayload, keyFor: (mediaHash: string, transcriptHash: string) => string): Promise<string | null> {
  const source = await captionMediaSource(engine, payload.sourceArtifactId);
  const transcript = await readCaptionTranscript(engine, source);
  return transcript ? keyFor(source.mediaHash, transcript.hash) : null;
}

function clampRegion(region: FrameRegion): FrameRegion {
  const unit = (value: number) => Math.max(0, Math.min(1, value));
  return { kind: region.kind, confidence: unit(region.confidence), x: unit(region.x), y: unit(region.y), width: unit(region.width), height: unit(region.height) };
}

async function analyzeRegions(source: CaptionMediaSource, transcript: CaptionTranscript, signal: AbortSignal): Promise<CaptionRegions> {
  const apiKey = getApiKey("OPENAI_API_KEY");
  if (!apiKey) throw new Error("Face and on-screen text avoidance needs OPENAI_API_KEY.");
  const frames = await extractFrames(source.path, regionFrameRequests(transcript.words, source.durationSeconds), source.durationSeconds, signal);
  const regions = await detectFrameRegions(frames, apiKey, signal);
  return { frames: frames.map((frame) => ({ time: frame.time, regions: (regions.get(frame.id) ?? []).map(clampRegion) })) };
}

async function runVocal(engine: Engine, payload: ComponentPayload, signal: AbortSignal) {
  const stored = await runAnalysisComponentJob({
    engine,
    spec: CAPTION_VOCAL,
    key: payload.componentKey,
    artifactId: payload.sourceArtifactId,
    force: payload.force === true,
    schema: vocalValueSchema,
    currentKey: () => currentKey(engine, payload, vocalComponentKey),
    compute: async () => {
      const { source, transcript } = await sourceTranscript(engine, payload);
      return {
        value: await analyzeVocalTiming(source, transcript, signal),
        sourceHash: source.mediaHash,
        provenance: { analyzer: "caption-vocal-dsp", provider: null, model: null },
      };
    },
  });
  await continuePreparation(engine, payload);
  return { componentKey: stored.key, onsets: stored.value.onsets.length };
}

async function runRegions(engine: Engine, payload: ComponentPayload, signal: AbortSignal) {
  const stored = await runAnalysisComponentJob({
    engine,
    spec: CAPTION_REGIONS,
    key: payload.componentKey,
    artifactId: payload.sourceArtifactId,
    force: payload.force === true,
    schema: regionsValueSchema,
    currentKey: () => currentKey(engine, payload, regionsComponentKey),
    compute: async () => {
      const { source, transcript } = await sourceTranscript(engine, payload);
      return {
        value: await analyzeRegions(source, transcript, signal),
        sourceHash: source.mediaHash,
        provenance: { analyzer: "caption-regions", provider: "openai", model: INTELLIGENCE_MODEL },
      };
    },
  });
  await continuePreparation(engine, payload);
  return { componentKey: stored.key, frames: stored.value.frames.length };
}

type SegmentsInput = Parameters<typeof parseSegments>[0];

async function translation(engine: Engine, source: CaptionMediaSource, language: string, force: boolean, signal: AbortSignal): Promise<CaptionTranslation> {
  await ensureTranscriptTranslation(engine, source.artifactId, language, { force, signal });
  await unchangedSource(engine, source.artifactId, source.mediaHash);
  const filename = translatedTranscriptFilename(language);
  const [sidecar, fileHash] = await Promise.all([
    readArtifactJson(engine, source.artifactId, filename),
    fileObjectHash(engine, source.artifactId, filename),
  ]);
  if (!sidecar || !fileHash) throw new Error("The translated subtitles were not saved.");
  const wordCount = parseSegments(sidecar as SegmentsInput).reduce((count, segment) => count + segment.words.length, 0);
  return { file: filename, fileHash, language, wordCount };
}

async function runTranslation(engine: Engine, payload: TranslationPayload, signal: AbortSignal) {
  const keyFor = (mediaHash: string, transcriptHash: string) => translationComponentKey(mediaHash, transcriptHash, payload.language);
  const stored = await runAnalysisComponentJob({
    engine,
    spec: CAPTION_TRANSLATION,
    key: payload.componentKey,
    artifactId: payload.sourceArtifactId,
    force: payload.force === true,
    schema: translationValueSchema,
    currentKey: () => currentKey(engine, payload, keyFor),
    compute: async () => {
      const { source } = await sourceTranscript(engine, payload);
      return {
        value: await translation(engine, source, payload.language, payload.force === true, signal),
        sourceHash: source.mediaHash,
        provenance: { analyzer: "caption-translation", provider: "openai", model: INTELLIGENCE_MODEL },
      };
    },
  });
  await continuePreparation(engine, payload);
  return { componentKey: stored.key, file: stored.value.file };
}

export function registerCaptionAnalysisJobs(engine: Engine): void {
  registerJobHandler(CAPTION_TRANSLATION.jobType, (payload, ctx) => runTranslation(engine, payload as unknown as TranslationPayload, ctx.signal));
  registerJobHandler(CAPTION_TRANSCRIPT_JOB, (payload, ctx) => runTranscript(engine, payload as unknown as TranscriptPayload, ctx.signal));
  registerJobHandler(CAPTION_VOCAL.jobType, (payload, ctx) => runVocal(engine, payload as unknown as ComponentPayload, ctx.signal));
  registerJobHandler(CAPTION_REGIONS.jobType, (payload, ctx) => runRegions(engine, payload as unknown as ComponentPayload, ctx.signal));
}
