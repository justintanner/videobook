import { join } from "node:path";
import { findVideoFile, type Engine } from "videobook-engine";
import { getApiKey } from "../api-key.js";
import { probeVideo } from "../ffmpeg.js";
import { logger } from "../logger.js";
import { parseSegments } from "../remotion/subtitles/segments.js";
import type { Segment } from "../remotion/subtitles/types.js";
import type { AliveAnalysis, AlivePhrase, AliveRegion } from "../remotion/subtitles/alive-types.js";
import { buildPhraseLines, phraseFrameTime } from "../remotion/subtitles/alive-layout.js";
import type { PhraseWordInput } from "../remotion/subtitles/alive-layout.js";
import {
  HOP_SECONDS,
  VOCAL_SAMPLE_RATE,
  decodeVocalPcm,
  detectOnsets,
  envelopeSeries,
  rmsFrames,
  snapWordStarts,
  wordEnergies,
} from "./audio.js";
import { detectPhraseRegions, extractPhraseFrames } from "./frames.js";
import { aliveFingerprint, readAliveAnalysis, writeAliveAnalysis } from "./model.js";
import { ALIVE_ANALYSIS_VERSION } from "./schema.js";

const ENVELOPE_HZ = 20;

export interface AliveAudioTrack {
  rms: Float32Array;
  hopSeconds: number;
}

export interface BuildAliveAnalysisInput {
  segments: Segment[];
  audio: AliveAudioTrack | null;
  durationSeconds: number;
  sourceWidth: number;
  sourceHeight: number;
  fingerprint: string;
}

function segmentInputs(segments: Segment[], audio: AliveAudioTrack | null, onsets: number[]): PhraseWordInput[][] {
  const words = segments.flatMap((segment) => segment.words);
  const starts = snapWordStarts(words, onsets);
  const energies = audio ? wordEnergies(words, audio.rms, audio.hopSeconds) : words.map(() => 0.5);
  let cursor = 0;
  return segments.map((segment) => segment.words.map((word) => {
    const index = cursor++;
    return { raw: word.word, start: word.start, end: word.end, onsetStart: starts[index], energy: energies[index] };
  }));
}

function toPhrase(lines: AlivePhrase["lines"], index: number): AlivePhrase {
  const frameTime = phraseFrameTime(lines);
  return { id: `p${index + 1}`, frameTime: Math.round(frameTime * 1000) / 1000, regions: [], lines };
}

/** Phrases, vocal onsets and energy for a transcript; regions are attached separately. */
function buildAliveAnalysis(input: BuildAliveAnalysisInput): AliveAnalysis {
  const { audio } = input;
  const onsets = audio ? detectOnsets(audio.rms, audio.hopSeconds) : [];
  return {
    version: ALIVE_ANALYSIS_VERSION,
    fingerprint: input.fingerprint,
    analyzedAt: new Date().toISOString(),
    durationSeconds: input.durationSeconds,
    sourceWidth: input.sourceWidth,
    sourceHeight: input.sourceHeight,
    envelopeHz: ENVELOPE_HZ,
    envelope: audio ? envelopeSeries(audio.rms, ENVELOPE_HZ, audio.hopSeconds) : [],
    onsets,
    regionsAnalyzed: false,
    phrases: buildPhraseLines(segmentInputs(input.segments, audio, onsets)).map(toPhrase),
  };
}

function attachRegions(analysis: AliveAnalysis, regions: Map<string, AliveRegion[]>): AliveAnalysis {
  return {
    ...analysis,
    regionsAnalyzed: true,
    phrases: analysis.phrases.map((phrase) => ({ ...phrase, regions: regions.get(phrase.id) ?? [] })),
  };
}

export interface AliveSource {
  videoPath: string;
  fingerprint: string;
  transcript: Buffer;
}

/** Locate the video file and timed transcript an analysis is keyed on. */
export async function aliveSource(engine: Engine, assetId: string): Promise<AliveSource> {
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const videoFile = findVideoFile(manifest.value.files);
  if (!videoFile) throw new Error(`No video file found in ${assetId}.`);
  const transcript = await engine.files.read(assetId, "elevenlabs.json");
  if (!transcript.ok) throw new Error(`No timed transcript found for ${assetId}. Run /transcribe @${assetId} first.`);
  return {
    videoPath: join(manifest.value.path, videoFile.name),
    fingerprint: aliveFingerprint(videoFile, transcript.value),
    transcript: transcript.value,
  };
}

export async function cachedAliveAnalysis(engine: Engine, assetId: string, fingerprint: string): Promise<AliveAnalysis | null> {
  const cached = await readAliveAnalysis(engine, assetId);
  return cached && cached.fingerprint === fingerprint ? cached : null;
}

async function readAudio(videoPath: string, hasAudio: boolean, signal: AbortSignal): Promise<AliveAudioTrack | null> {
  if (!hasAudio) return null;
  const pcm = await decodeVocalPcm(videoPath, signal);
  return pcm ? { rms: rmsFrames(pcm, VOCAL_SAMPLE_RATE, HOP_SECONDS), hopSeconds: HOP_SECONDS } : null;
}

async function withRegions(analysis: AliveAnalysis, videoPath: string, signal: AbortSignal): Promise<AliveAnalysis> {
  const apiKey = getApiKey("OPENAI_API_KEY");
  if (!apiKey || analysis.phrases.length === 0) return analysis;
  try {
    const frames = await extractPhraseFrames(videoPath, analysis.phrases, analysis.durationSeconds, signal);
    return attachRegions(analysis, await detectPhraseRegions(frames, apiKey, signal));
  } catch (error) {
    signal.throwIfAborted();
    // Placement degrades to the default columns; captions must not fail on vision.
    logger.warn("alive-captions-regions-failed", { error });
    return analysis;
  }
}

/**
 * Full analysis for one video: transcript phrases, vocal onsets and energy,
 * then per-phrase face/text regions when a vision provider is configured.
 * Persists and returns the result; a fresh cache hit is returned as-is.
 */
export async function analyzeAliveCaptions(engine: Engine, assetId: string, signal: AbortSignal, force = false): Promise<AliveAnalysis> {
  const source = await aliveSource(engine, assetId);
  const cached = force ? null : await cachedAliveAnalysis(engine, assetId, source.fingerprint);
  if (cached) return cached;
  const probe = await probeVideo(source.videoPath, { signal });
  const segments = parseSegments(JSON.parse(source.transcript.toString()) as Parameters<typeof parseSegments>[0]);
  const base = buildAliveAnalysis({
    segments,
    audio: await readAudio(source.videoPath, probe.hasAudio, signal),
    durationSeconds: probe.duration,
    sourceWidth: probe.width,
    sourceHeight: probe.height,
    fingerprint: source.fingerprint,
  });
  const analysis = await withRegions(base, source.videoPath, signal);
  await writeAliveAnalysis(engine, assetId, analysis);
  return analysis;
}
