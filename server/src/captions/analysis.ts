import { createHash } from "node:crypto";
import type { Engine, Job } from "videobook-engine";
import { z } from "zod";
import { getApiKey } from "../api-key.js";
import type { AnalysisComponentSpec, AnalysisComponentState, AnalysisComponentStatus } from "../analysis-components.js";
import {
  analysisComponentKey,
  analysisComponentState,
  enqueueAnalysisComponent,
  isActiveJob,
  latestJobWhere,
  readAnalysisComponent,
  writeAnalysisComponent,
} from "../analysis-components.js";
import { INTELLIGENCE_MODEL } from "../openai-intelligence.js";
import { queue } from "../queue.js";
import { timedTranscriptFrom } from "../transcript-projection.js";
import { parseLegacyAliveAnalysis, LEGACY_ALIVE_ANALYSIS_KEY } from "./legacy.js";
import type { LegacyAliveAnalysis } from "./legacy.js";
import { groupPhrases } from "./phrasing.js";
import type { CaptionMediaSource } from "./source.js";
import { captionMediaSource, TIMED_TRANSCRIPT_FILENAME } from "./source.js";

export const CAPTION_TRANSCRIPT_JOB = "caption_transcript";
export const CAPTION_VOCAL: AnalysisComponentSpec = { component: "caption-vocal", version: 1, jobType: "caption_vocal" };
export const CAPTION_REGIONS: AnalysisComponentSpec = { component: "caption-regions", version: 1, jobType: "caption_regions" };
export const CAPTION_COMPONENTS = ["transcript", "vocal", "regions"] as const;
export type CaptionComponentName = typeof CAPTION_COMPONENTS[number];

const MAX_REGION_FRAMES = 90;
const PREPARATION_KEY_PREFIX = "captions.prepare.";
const unit = z.number().finite().min(0).max(1);

const regionSchema = z.object({
  kind: z.enum(["face", "text", "graphic"]),
  confidence: unit,
  x: unit,
  y: unit,
  width: unit,
  height: unit,
});

export const vocalValueSchema = z.object({
  hopSeconds: z.number().positive(),
  envelopeHz: z.number().positive(),
  envelope: z.array(unit),
  onsets: z.array(z.number().finite().nonnegative()),
  words: z.array(z.object({ onset: z.number().finite().nonnegative(), energy: unit })),
});

export const regionsValueSchema = z.object({
  frames: z.array(z.object({ time: z.number().finite().nonnegative(), regions: z.array(regionSchema) })),
});

export type CaptionVocal = z.infer<typeof vocalValueSchema>;
export type CaptionRegions = z.infer<typeof regionsValueSchema>;
export type CaptionRegion = z.infer<typeof regionSchema>;

export interface CaptionTranscriptWord {
  text: string;
  start: number;
  end: number;
  speaker: string | null;
}

export interface CaptionTranscript {
  hash: string;
  language: string | null;
  words: CaptionTranscriptWord[];
}

export interface CaptionTranscriptState {
  status: AnalysisComponentStatus;
  jobId: number | null;
  error: string | null;
  hash: string | null;
  silent: boolean;
}

export interface CaptionAnalysisState {
  transcript: CaptionTranscriptState;
  vocal: AnalysisComponentState<CaptionVocal> | null;
  regions: AnalysisComponentState<CaptionRegions> | null;
}

export function silentTranscriptHash(mediaHash: string): string {
  return `silent:${mediaHash}`;
}

export function vocalComponentKey(mediaHash: string, transcriptHash: string): string {
  return analysisComponentKey(CAPTION_VOCAL, { sourceHash: mediaHash, dependencies: [transcriptHash] });
}

export function regionsComponentKey(mediaHash: string, transcriptHash: string): string {
  return analysisComponentKey(CAPTION_REGIONS, {
    sourceHash: mediaHash,
    dependencies: [transcriptHash],
    options: { model: INTELLIGENCE_MODEL, maxFrames: MAX_REGION_FRAMES },
  });
}

export async function readCaptionTranscript(engine: Engine, source: CaptionMediaSource): Promise<CaptionTranscript | null> {
  if (!source.transcriptFile) {
    return source.hasAudio ? null : { hash: silentTranscriptHash(source.mediaHash), language: null, words: [] };
  }
  const read = await engine.files.read(source.artifactId, TIMED_TRANSCRIPT_FILENAME);
  if (!read.ok) return null;
  let raw: unknown = null;
  try {
    raw = JSON.parse(read.value.toString()) as unknown;
  } catch {
    return null;
  }
  const parsed = timedTranscriptFrom(raw);
  const words = parsed?.kind === "timed"
    ? parsed.words.map((word) => ({ text: word.text.trim(), start: word.start, end: word.end, speaker: word.speakerId }))
      .filter((word) => word.text.length > 0)
    : [];
  return { hash: source.transcriptFile.objectHash, language: parsed?.kind === "timed" ? parsed.languageCode : null, words };
}

function transcriptJobFor(job: Job, source: CaptionMediaSource): boolean {
  return job.payload.sourceArtifactId === source.artifactId && job.payload.mediaHash === source.mediaHash;
}

function eagerTranscriptJob(engine: Engine, source: CaptionMediaSource): Job | null {
  const job = latestJobWhere(engine, "transcribe", (candidate) => candidate.payload.assetId === source.artifactId);
  return isActiveJob(job) ? job : null;
}

function transcriptUnavailable(): string | null {
  return getApiKey("ELEVENLABS_API_KEY") ? null : "Word timings need ElevenLabs speech-to-text. Add ELEVENLABS_API_KEY in provider settings.";
}

export function captionTranscriptState(engine: Engine, source: CaptionMediaSource): CaptionTranscriptState {
  if (source.transcriptFile) return { status: "ready", jobId: null, error: null, hash: source.transcriptFile.objectHash, silent: false };
  if (!source.hasAudio) return { status: "ready", jobId: null, error: null, hash: silentTranscriptHash(source.mediaHash), silent: true };
  const own = latestJobWhere(engine, CAPTION_TRANSCRIPT_JOB, (job) => transcriptJobFor(job, source));
  const active = own && isActiveJob(own) ? own : eagerTranscriptJob(engine, source);
  if (active) return { status: active.state === "queued" ? "queued" : "running", jobId: active.id, error: null, hash: null, silent: false };
  if (own && (own.state === "failed" || own.state === "aborted")) {
    return { status: "failed", jobId: own.id, error: own.error?.message ?? "Transcription was cancelled.", hash: null, silent: false };
  }
  const unavailable = transcriptUnavailable();
  return { status: unavailable ? "unavailable" : "missing", jobId: null, error: unavailable, hash: null, silent: false };
}

function regionsUnavailable(): string | null {
  return getApiKey("OPENAI_API_KEY") ? null : "Face and on-screen text avoidance needs OPENAI_API_KEY; subtitles still work without it.";
}

export function captionAnalysisStateFor(engine: Engine, source: CaptionMediaSource): CaptionAnalysisState {
  const transcript = captionTranscriptState(engine, source);
  if (transcript.status !== "ready" || !transcript.hash || transcript.silent) return { transcript, vocal: null, regions: null };
  return {
    transcript,
    vocal: analysisComponentState(engine, CAPTION_VOCAL, vocalComponentKey(source.mediaHash, transcript.hash), vocalValueSchema),
    regions: analysisComponentState(engine, CAPTION_REGIONS, regionsComponentKey(source.mediaHash, transcript.hash), regionsValueSchema, regionsUnavailable()),
  };
}

export function regionFrameRequests(words: readonly CaptionTranscriptWord[], durationSeconds: number): Array<{ id: string; time: number }> {
  const indexed = words.map((word, index) => ({ id: String(index), text: word.text, start: word.start, end: word.end }));
  const middles = groupPhrases(indexed).map((ids) => {
    const first = indexed[Number(ids[0])];
    const last = indexed[Number(ids[ids.length - 1])];
    return Math.round(((first.start + last.end) / 2) * 1000) / 1000;
  });
  const times = middles.length > 0 ? middles : [durationSeconds / 2];
  const step = times.length / Math.min(times.length, MAX_REGION_FRAMES);
  const sampled = Array.from({ length: Math.min(times.length, MAX_REGION_FRAMES) }, (_, index) => times[Math.floor(index * step)]);
  return sampled.map((time, index) => ({ id: `f${index + 1}`, time }));
}

interface PreparationMarker {
  mediaHash: string;
  regions: boolean;
  requestedAt: number;
}

function preparationKey(artifactId: string): string {
  return `${PREPARATION_KEY_PREFIX}${artifactId}`;
}

function readMarker(engine: Engine, artifactId: string): PreparationMarker | null {
  const value = engine.settings.get<PreparationMarker>(preparationKey(artifactId));
  return value && typeof value.mediaHash === "string" ? value : null;
}

export function clearCaptionPreparation(engine: Engine, artifactId: string): void {
  engine.settings.delete(preparationKey(artifactId));
}

function componentPayload(bookId: string, source: CaptionMediaSource, transcriptHash: string) {
  return { bookId, sourceArtifactId: source.artifactId, mediaHash: source.mediaHash, transcriptHash };
}

async function enqueueTranscript(bookId: string, source: CaptionMediaSource, force: boolean): Promise<void> {
  await queue.enqueue(`caption-transcript:${source.artifactId}:${source.mediaHash}`, {
    type: CAPTION_TRANSCRIPT_JOB,
    bookId,
    sourceArtifactId: source.artifactId,
    mediaHash: source.mediaHash,
    force,
  });
}

function needsWork(state: AnalysisComponentState<unknown>, force: boolean): boolean {
  if (state.status === "queued" || state.status === "running" || state.status === "unavailable") return false;
  return force || state.status === "missing" || state.status === "failed";
}

async function advancePreparation(
  engine: Engine,
  bookId: string,
  source: CaptionMediaSource,
  options: { regions: boolean; force: readonly CaptionComponentName[] },
): Promise<void> {
  const state = captionAnalysisStateFor(engine, source);
  const forceTranscript = options.force.includes("transcript") && state.transcript.status === "ready" && !state.transcript.silent;
  if (state.transcript.status === "missing" || state.transcript.status === "failed" || forceTranscript) {
    await enqueueTranscript(bookId, source, forceTranscript);
    return;
  }
  if (state.transcript.status !== "ready" || !state.transcript.hash || state.transcript.silent) return;
  const payload = componentPayload(bookId, source, state.transcript.hash);
  if (state.vocal && needsWork(state.vocal, options.force.includes("vocal"))) {
    await enqueueAnalysisComponent(engine, CAPTION_VOCAL, state.vocal.key, payload, {
      force: options.force.includes("vocal"),
      hasResult: state.vocal.value !== null,
    });
  }
  if (options.regions && state.regions && needsWork(state.regions, options.force.includes("regions"))) {
    await enqueueAnalysisComponent(engine, CAPTION_REGIONS, state.regions.key, payload, {
      force: options.force.includes("regions"),
      hasResult: state.regions.value !== null,
    });
  }
}

function preparationSettled(state: CaptionAnalysisState, regions: boolean): boolean {
  const busy = (status: AnalysisComponentStatus | undefined) => status === "queued" || status === "running" || status === "missing";
  if (busy(state.transcript.status)) return false;
  if (busy(state.vocal?.status)) return false;
  return !(regions && busy(state.regions?.status));
}

export async function prepareCaptionAnalysis(
  engine: Engine,
  bookId: string,
  artifactId: string,
  options: { regions: boolean; force: readonly CaptionComponentName[] },
): Promise<{ source: CaptionMediaSource; state: CaptionAnalysisState }> {
  const source = await captionMediaSource(engine, artifactId);
  const marker: PreparationMarker = { mediaHash: source.mediaHash, regions: options.regions, requestedAt: Date.now() };
  const stored = engine.settings.set(preparationKey(artifactId), marker);
  if (!stored.ok) throw new Error(stored.error.message);
  await importLegacyAliveAnalysis(engine, source);
  await advancePreparation(engine, bookId, source, options);
  const state = captionAnalysisStateFor(engine, source);
  if (preparationSettled(state, options.regions)) clearCaptionPreparation(engine, artifactId);
  return { source, state };
}

export async function continueCaptionPreparation(engine: Engine, bookId: string, artifactId: string): Promise<void> {
  const marker = readMarker(engine, artifactId);
  if (!marker) return;
  const source = await captionMediaSource(engine, artifactId);
  if (source.mediaHash !== marker.mediaHash) {
    clearCaptionPreparation(engine, artifactId);
    return;
  }
  await importLegacyAliveAnalysis(engine, source);
  await advancePreparation(engine, bookId, source, { regions: marker.regions, force: [] });
  if (preparationSettled(captionAnalysisStateFor(engine, source), marker.regions)) clearCaptionPreparation(engine, artifactId);
}

function legacyFingerprint(source: CaptionMediaSource, transcript: Buffer): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    video: { name: source.file.name, size: source.file.sizeBytes, objectHash: source.file.objectHash },
    transcript: createHash("sha256").update(transcript).digest("hex"),
  })).digest("hex");
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function legacyRegions(legacy: LegacyAliveAnalysis): CaptionRegions {
  return {
    frames: legacy.phrases.map((phrase) => ({
      time: Math.max(0, phrase.frameTime),
      regions: phrase.regions.map((region) => ({
        kind: region.kind,
        confidence: clamp01(region.confidence),
        x: clamp01(region.x),
        y: clamp01(region.y),
        width: clamp01(region.width),
        height: clamp01(region.height),
      })),
    })),
  };
}

function legacyVocal(legacy: LegacyAliveAnalysis, transcript: CaptionTranscript): CaptionVocal {
  const byStart = new Map<number, { onset: number; energy: number }>();
  for (const word of legacy.phrases.flatMap((phrase) => phrase.lines.flat())) {
    byStart.set(word.transcriptStart, { onset: Math.max(0, word.onsetStart), energy: clamp01(word.energy) });
  }
  return {
    hopSeconds: 0.01,
    envelopeHz: legacy.envelopeHz,
    envelope: legacy.envelope.map(clamp01),
    onsets: legacy.onsets.filter((onset) => onset >= 0),
    words: transcript.words.map((word) => byStart.get(word.start) ?? { onset: word.start, energy: 0.5 }),
  };
}

function legacyProvenance(provider: string | null) {
  return { analyzer: "alive-captions", version: 1, provider, model: null, createdAt: new Date().toISOString() };
}

async function readLegacyAnalysis(engine: Engine, source: CaptionMediaSource): Promise<LegacyAliveAnalysis | null> {
  if (!source.transcriptFile) return null;
  const metadata = await engine.metadata.artifacts.read<unknown>(source.artifactId, LEGACY_ALIVE_ANALYSIS_KEY);
  if (!metadata.ok) return null;
  const legacy = parseLegacyAliveAnalysis(metadata.value);
  if (!legacy) return null;
  const transcript = await engine.files.read(source.artifactId, TIMED_TRANSCRIPT_FILENAME);
  return transcript.ok && legacy.fingerprint === legacyFingerprint(source, transcript.value) ? legacy : null;
}

export async function importLegacyAliveAnalysis(engine: Engine, source: CaptionMediaSource): Promise<boolean> {
  const legacy = await readLegacyAnalysis(engine, source);
  if (!legacy) return false;
  const transcript = await readCaptionTranscript(engine, source);
  if (!transcript) return false;
  const vocalKey = vocalComponentKey(source.mediaHash, transcript.hash);
  if (!readAnalysisComponent(engine, CAPTION_VOCAL, vocalKey, vocalValueSchema)) {
    writeAnalysisComponent(engine, {
      component: CAPTION_VOCAL.component, key: vocalKey, artifactId: source.artifactId, sourceHash: source.mediaHash,
      provenance: legacyProvenance(null), value: vocalValueSchema.parse(legacyVocal(legacy, transcript)),
    });
  }
  const regionsKey = regionsComponentKey(source.mediaHash, transcript.hash);
  if (legacy.regionsAnalyzed && !readAnalysisComponent(engine, CAPTION_REGIONS, regionsKey, regionsValueSchema)) {
    writeAnalysisComponent(engine, {
      component: CAPTION_REGIONS.component, key: regionsKey, artifactId: source.artifactId, sourceHash: source.mediaHash,
      provenance: legacyProvenance("openai"), value: regionsValueSchema.parse(legacyRegions(legacy)),
    });
  }
  return true;
}
