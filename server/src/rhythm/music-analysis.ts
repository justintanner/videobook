import { createHash } from "node:crypto";
import { join } from "node:path";
import { findAudioFile, findPrimaryMediaFile, type Engine } from "videobook-engine";
import { musicAnalysisSchema, type MusicAnalysis, type SectionLabels, type SectionLabelsState, sectionLabelsSchema } from "./model.js";
import { candidateSections } from "./energy.js";
import { extractWaveform, FFMPEG } from "../ffmpeg.js";
import { RHYTHM_ANALYZER_VERSION, RHYTHM_ANALYZER_ID, SECTION_LABELER_VERSION } from "./contract.js";
import { runRhythmWorker } from "./run-worker.js";

export interface MusicSource {
  artifactId: string;
  objectHash: string;
  streamId: string;
  streamIndex: number;
  analysisId: string;
  durationSeconds: number;
  inputPath: string;
}

export async function musicSource(engine: Engine, artifactId: string, streamId?: string): Promise<MusicSource> {
  const artifact = engine.artifacts.get(artifactId);
  if (!artifact.ok) throw new Error(artifact.error.message);
  if (!["audio", "video", "final"].includes(artifact.value.kind)) throw new Error("Choose an audio or video source");
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = artifact.value.kind === "audio"
    ? findAudioFile(manifest.value.files, artifact.value.kind)
    : findPrimaryMediaFile(manifest.value.files, artifact.value.kind);
  const streams = engine.streams.list(artifactId);
  if (!streams.ok) throw new Error(streams.error.message);
  const stream = streams.value.find((item) => item.kind === "audio" && item.sourcePath === file?.name
    && item.objectHash === file.objectHash && (!streamId || item.streamId === streamId));
  if (!stream || !file) throw new Error("Wait for the current audio source to finish processing");
  const durationSeconds = stream.durationTicks * stream.timeBase.numerator / stream.timeBase.denominator;
  if (!(durationSeconds > 0) || durationSeconds > 3600) throw new Error("Music analysis supports audio up to 60 minutes");
  const analysisId = createHash("sha256").update(JSON.stringify([
    file.objectHash, stream.streamIndex, RHYTHM_ANALYZER_ID, RHYTHM_ANALYZER_VERSION,
  ])).digest("hex");
  return { artifactId, objectHash: file.objectHash, streamId: stream.streamId, streamIndex: stream.streamIndex,
    analysisId, durationSeconds, inputPath: join(manifest.value.path, file.name) };
}

export async function cachedMusicAnalysis(engine: Engine, source: MusicSource): Promise<MusicAnalysis | null> {
  const read = await engine.metadata.artifacts.read(source.artifactId, `music.analysis.${source.analysisId}`);
  if (!read.ok) return null;
  const parsed = musicAnalysisSchema.safeParse(read.value);
  if (!parsed.success || parsed.data.objectHash !== source.objectHash || parsed.data.streamId !== source.streamId) return null;
  return parsed.data;
}

export async function analyzeMusicSource(engine: Engine, artifactId: string, analysisId: string, streamId: string, signal: AbortSignal) {
  const source = await musicSource(engine, artifactId, streamId);
  if (source.analysisId !== analysisId) throw new Error("The audio source changed; analyze it again");
  const analysis = await runRhythmWorker(FFMPEG, source.inputPath, signal, source.streamIndex);
  signal.throwIfAborted();
  const waveform = await extractWaveform(source.inputPath, 8192, source.streamIndex, signal);
  signal.throwIfAborted();
  if (!waveform.length) throw new Error("The soundtrack waveform could not be decoded. Retry analysis.");
  const current = await musicSource(engine, artifactId, streamId);
  if (current.analysisId !== analysisId) throw new Error("The audio source changed during analysis");
  const withinSource = (beat: { timeSeconds: number }) => beat.timeSeconds < source.durationSeconds;
  const energy = analysis.energy;
  const result = musicAnalysisSchema.parse({
    analysisId, artifactId, objectHash: source.objectHash, streamId, durationSeconds: source.durationSeconds,
    analyzerVersion: `${RHYTHM_ANALYZER_ID}@${RHYTHM_ANALYZER_VERSION}`,
    beats: analysis.beats.filter(withinSource), bpm: analysis.bpm, confidence: analysis.bpmConfidence,
    bars: analysis.bars?.filter(withinSource) ?? null, beatsPerBar: analysis.meter?.beatsPerBar ?? null,
    barSource: analysis.barSource,
    waveform, lowConfidence: analysis.lowConfidence,
    energy: energy ?? null,
    sections: energy ? candidateSections(energy, source.durationSeconds) : null,
  });
  const saved = await engine.metadata.artifacts.write(artifactId, `music.analysis.${analysisId}`, result);
  if (!saved.ok) throw new Error(saved.error.message);
  return result;
}

export async function readMusicAnalysis(engine: Engine, artifactId: string, streamId?: string) {
  const source = await musicSource(engine, artifactId, streamId);
  const analysis = await cachedMusicAnalysis(engine, source);
  const jobs = engine.jobs.queue.list({ type: "analyze_music", limit: 500 });
  const job = jobs.filter((item) => item.payload.musicArtifactId === artifactId && item.payload.analysisId === source.analysisId)
    .sort((left, right) => right.id - left.id)[0];
  const pending = job && ["queued", "running", "completing"].includes(job.state);
  const status = pending ? job.state === "queued" ? "queued" : "analyzing"
    : job?.state === "aborted" ? "cancelled" : job?.state === "failed" ? "failed"
      : analysis ? analysis.beats.length ? "ready" : "no-beats" : "missing";
  const sections = await readSectionState(engine, source, analysis);
  return { status, analysisId: source.analysisId, jobId: job?.id ?? null, error: job?.error?.message ?? null, analysis, sections };
}

async function readSectionState(engine: Engine, source: MusicSource, analysis: MusicAnalysis | null): Promise<SectionLabelsState> {
  if (!analysis?.energy || !analysis.sections) return { status: "missing", jobId: null, error: null, labels: null };
  const stored = await readSectionLabels(engine, source.artifactId, source.analysisId);
  if (stored && sectionLabelsCurrent(stored, analysis)) {
    return {
      status: stored.status === "ready" ? "ready" : "unavailable",
      jobId: null, error: stored.status === "ready" ? null : stored.reason,
      labels: stored.status === "ready" ? stored : null,
    };
  }
  const jobs = engine.jobs.queue.list({ type: "label_music_sections", limit: 500 });
  const job = jobs.filter((item) => item.payload.analysisId === source.analysisId).sort((left, right) => right.id - left.id)[0];
  const active = job && ["queued", "running", "completing"].includes(job.state);
  const status = active ? job!.state === "queued" ? "queued" as const : "labeling" as const
    : job?.state === "aborted" ? "cancelled" as const : job?.state === "failed" ? "failed" as const : "missing" as const;
  return { status, jobId: job?.id ?? null, error: job?.error?.message ?? null, labels: null };
}

export async function readSectionLabels(engine: Engine, artifactId: string, analysisId: string): Promise<SectionLabels | null> {
  const read = await engine.metadata.artifacts.read(artifactId, `music.sections.${analysisId}`);
  if (!read.ok) return null;
  const parsed = sectionLabelsSchema.safeParse(read.value);
  return parsed.success ? parsed.data : null;
}

export function sectionLabelsCurrent(stored: SectionLabels, analysis: MusicAnalysis): boolean {
  const candidates = analysis.sections?.candidates ?? [];
  const covered = stored.status === "ready"
    && stored.labels.length === candidates.length
    && stored.labels.every((label, index) => label.candidateId === candidates[index]?.id);
  return stored.analysisId === analysis.analysisId && stored.objectHash === analysis.objectHash
    && stored.streamId === analysis.streamId && stored.labeler.version === SECTION_LABELER_VERSION
    && stored.boundaries.algorithmVersion === analysis.sections?.algorithmVersion
    && stored.boundaries.algorithmId === analysis.sections?.algorithmId
    && (stored.status === "unavailable" || covered);
}
