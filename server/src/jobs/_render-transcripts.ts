import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import type { SidecarAnalysisSpec, SidecarInput } from "../analysis-sidecars.js";
import { cachedSidecarAnalysis, fileObjectHash } from "../analysis-sidecars.js";
import type { CaptionMediaSource } from "../captions/source.js";
import type { ProbeResult } from "../ffmpeg.js";
import { extractMp3 } from "../ffmpeg.js";
import { logger } from "../logger.js";
import {
  DEFAULT_TRANSCRIPT_OPTIONS,
  ELEVENLABS_TRANSCRIPT,
  elevenLabsTranscriptRecord,
  OPENAI_TRANSCRIPT,
  openAiTranscriptRecord,
  recordCopiedTranscript,
} from "../transcript-components.js";

export type TranscriptOptOut = { transcribe?: false };
export type RenderSource = Pick<CaptionMediaSource, "artifactId" | "durationSeconds" | "fps">;

interface TranscriptKind {
  spec: SidecarAnalysisSpec;
  record: (artifactId: string, audioHash: string) => SidecarInput;
}

interface RenderedTranscriptInput {
  source: RenderSource;
  artifactId: string;
  videoPath: string;
  probe: ProbeResult;
  signal: AbortSignal;
}

const AUDIO_FILE = "original.mp3";
const DECLINED: TranscriptOptOut = { transcribe: false };
const TRANSCRIPT_KINDS: readonly TranscriptKind[] = [
  { spec: OPENAI_TRANSCRIPT, record: openAiTranscriptRecord },
  { spec: ELEVENLABS_TRANSCRIPT, record: (artifactId, audioHash) => elevenLabsTranscriptRecord({ artifactId, audioHash, options: DEFAULT_TRANSCRIPT_OPTIONS }) },
];

function sameTimeline(source: RenderSource, output: ProbeResult): boolean {
  return Math.abs(output.videoDuration - source.durationSeconds) <= 1 / source.fps;
}

async function currentKinds(engine: Engine, sourceId: string): Promise<TranscriptKind[]> {
  const audioHash = await fileObjectHash(engine, sourceId, AUDIO_FILE);
  if (!audioHash) return [];
  const kinds: TranscriptKind[] = [];
  for (const kind of TRANSCRIPT_KINDS) {
    if (await cachedSidecarAnalysis(engine, kind.spec, kind.record(sourceId, audioHash))) kinds.push(kind);
  }
  return kinds;
}

async function writeOutputAudio(engine: Engine, input: RenderedTranscriptInput): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "videobook-render-audio-"));
  try {
    const path = join(scratch, AUDIO_FILE);
    await extractMp3(input.videoPath, path, input.signal);
    const written = await engine.files.writeFromPath(input.artifactId, AUDIO_FILE, path);
    if (!written.ok) throw new Error(written.error.message);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const audioHash = await fileObjectHash(engine, input.artifactId, AUDIO_FILE);
  if (!audioHash) throw new Error(`${AUDIO_FILE} was not written.`);
  return audioHash;
}

async function copyTranscript(engine: Engine, kind: TranscriptKind, input: RenderedTranscriptInput, audioHash: string): Promise<void> {
  const copied = await engine.files.copy(input.source.artifactId, kind.spec.sidecar, input.artifactId, kind.spec.sidecar);
  if (!copied.ok) throw new Error(copied.error.message);
  await recordCopiedTranscript(engine, kind.spec, kind.record(input.artifactId, audioHash), input.source.artifactId);
}

async function copyCurrentTranscripts(engine: Engine, input: RenderedTranscriptInput): Promise<TranscriptOptOut> {
  const kinds = await currentKinds(engine, input.source.artifactId);
  if (kinds.length === 0) return DECLINED;
  const audioHash = await writeOutputAudio(engine, input);
  for (const kind of kinds) await copyTranscript(engine, kind, input, audioHash);
  return kinds.length === TRANSCRIPT_KINDS.length ? {} : DECLINED;
}

export async function adoptSourceTranscripts(engine: Engine, input: RenderedTranscriptInput): Promise<TranscriptOptOut> {
  if (!input.probe.hasAudio) return {};
  if (!sameTimeline(input.source, input.probe)) return DECLINED;
  try {
    return await copyCurrentTranscripts(engine, input);
  } catch (error) {
    input.signal.throwIfAborted();
    logger.warn("render-transcript-copy-failed", { artifactId: input.artifactId, error });
    return DECLINED;
  }
}
