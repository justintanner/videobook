import { appendDiagnostic } from "../diagnostics.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ArtifactStream,
  Engine,
  IndexManifest,
  IndexPhase,
  SegmentTextObservation,
  TemporalIndexObservation,
  Transcript,
} from "videobook-engine";
import {
  LOCAL_CLAP_MANIFEST,
  LOCAL_CLIP_MANIFEST,
  type LocalClapTemporalProvider,
  type LocalClipTemporalProvider,
} from "videobook-engine";
import { FFMPEG } from "../ffmpeg.js";
import { registerJobHandler, type JobHandlerContext } from "../queue.js";
import {
  registerLocalClapSearchProvider,
  registerLocalClipSearchProvider,
} from "../local-search-models.js";
import {
  DOWNSTREAM_LEASE_WAIT_MS,
} from "./_lease.js";
import { withTransientStorageRetry } from "./_storage-retry.js";

const MANIFEST: IndexManifest = {
  manifestId: "videobook-progressive-local-v1",
  provider: "videobook",
  modelId: "sha256-content-projection",
  modelRevision: "1",
  license: "internal",
  embeddingSpace: "videobook-content-hash-32-v1",
  dimensions: 32,
  modalities: ["visual", "speech", "ocr", "audio", "metadata"],
  supportedLanguages: ["und"],
  preprocessingVersion: "1",
  extractorVersion: "1",
  createdAt: 1,
};

const GENERATION = "videobook-progressive-local-v1";
const DEEP_BATCH_SIZE = 4;
/**
 * VE-NFR-003: searchable coverage is committed at least once per 60 seconds
 * of analyzed source media. Deep model batches stop early when adding the
 * next unit would cover more than this much source time.
 */
export const MAX_BATCH_SOURCE_SECONDS = 60;
const ARTIFACT_IDLE_POLL_MS = 250;
const semanticIndexTails = new Map<string, Promise<void>>();
const PHASES: IndexPhase[] = [
  "probe",
  "segment",
  "transcript",
  "ocr",
  "visual",
  "audio",
  "lexical",
  "activate",
];

type SemanticIndexPayload = {
  type: "semantic_index";
  prepareVisualMedia?: boolean;
  visualOnly?: boolean;
  assetId: string;
  bookId: string;
};

type SemanticIndexResult = {
  success: true;
  artifactId: string;
  observationCount: number;
  manifestId: string;
  generation: string;
  semanticVisual: "ready" | "deferred" | "not-applicable";
  semanticAudio: "ready" | "deferred" | "not-applicable";
};

interface AnalysisScene {
  timestamp?: unknown;
  description?: unknown;
  tags?: unknown;
}

interface AnalysisDocument {
  summary?: unknown;
  scenes?: unknown;
  tags?: unknown;
  mood?: unknown;
  subjects?: unknown;
  actions?: unknown;
  setting?: unknown;
  textOnScreen?: unknown;
}

export async function runSemanticIndex(
  engine: Engine,
  payload: SemanticIndexPayload,
  ctx: JobHandlerContext,
): Promise<SemanticIndexResult> {
  ctx.markAssetFailureHandled();
  try {
    return await withSemanticIndexTurn(
      `${payload.bookId}:${payload.assetId}`,
      ctx.signal,
      async () => {
        await waitForArtifactIdle(engine, payload.assetId, ctx.signal);
        if (payload.prepareVisualMedia) {
          const artifact = engine.artifacts.get(payload.assetId);
          if (!artifact.ok) throw new Error(artifact.error.message);
          if (artifact.value.kind === "video" || artifact.value.kind === "final") {
            const { prepareSearchVideo } = await import("../search-index-media.js");
            await prepareSearchVideo(engine, payload.assetId, ctx.signal);
          }
        }
        try {
          return await withTransientStorageRetry(
            () => indexArtifact(engine, payload.assetId, {
              semanticVisual: true,
              semanticAudio: !payload.visualOnly,
              strictVisual: payload.visualOnly,
              signal: ctx.signal,
            }),
            ctx.signal,
          );
        } catch (error) {
          if (ctx.signal.aborted || payload.visualOnly || isTerminalIndexFailure(error)) throw error;
          return deferredSemanticIndex(engine, payload.assetId, error);
        }
      },
    );
  } catch (error) {
    if (ctx.signal.aborted || payload.visualOnly || isTerminalIndexFailure(error)) throw error;
    return deferredSemanticIndex(engine, payload.assetId, error);
  }
}

function isTerminalIndexFailure(error: unknown): boolean {
  if (!(error instanceof Error) || !("error" in error) || !error.error || typeof error.error !== "object" || !("code" in error.error)) return false;
  return ["CANCELLED", "TIMEOUT", "RESOURCE_EXHAUSTED", "MODEL_UNAVAILABLE", "MEDIA_MISSING", "FEATURE_UNAVAILABLE", "INVALID_INPUT", "INVALID_RANGE"].includes(String(error.error.code));
}

async function waitForArtifactIdle(
  engine: Engine,
  assetId: string,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    signal.throwIfAborted();
    const work = engine.jobs.artifactWork.read(assetId);
    if (!work.ok) throw new Error(work.error.message);
    if (!work.value || work.value.status === "ready") return;
    if (work.value.status === "error") {
      throw new Error(work.value.meta.error?.message ?? `Artifact ${assetId} is in error state`);
    }
    if (Date.now() - startedAt >= DOWNSTREAM_LEASE_WAIT_MS) {
      throw new Error(`Timed out waiting for active work on ${assetId}`);
    }
    await delay(ARTIFACT_IDLE_POLL_MS, undefined, { signal });
  }
}

async function withSemanticIndexTurn<T>(
  key: string,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  const previous = semanticIndexTails.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  semanticIndexTails.set(key, tail);
  try {
    await waitForTurn(previous, signal);
    return await run();
  } finally {
    release();
    void tail.then(() => {
      if (semanticIndexTails.get(key) === tail) semanticIndexTails.delete(key);
    });
  }
}

async function waitForTurn(
  previous: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  let rejectAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    await Promise.race([previous, aborted]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", rejectAbort);
  }
}

async function deferredSemanticIndex(
  engine: Engine,
  assetId: string,
  error: unknown,
): Promise<SemanticIndexResult> {
  await appendDiagnostic(engine, "semantic-index-deferred", {
    artifactId: assetId,
    stage: "index-progressive",
    error,
  }).catch(() => undefined);
  return {
    success: true,
    artifactId: assetId,
    observationCount: 0,
    manifestId: MANIFEST.manifestId,
    generation: GENERATION,
    semanticVisual: "deferred",
    semanticAudio: "deferred",
  };
}

type IndexArtifactOptions = { strictVisual?: boolean; semanticVisual?: boolean; semanticAudio?: boolean; signal?: AbortSignal };

export function indexArtifact(
  engine: Engine,
  artifactReference: string,
  options: IndexArtifactOptions = {},
): Promise<SemanticIndexResult> {
  return engine.withLocalMedia(() => indexLocalArtifact(engine, artifactReference, options));
}

async function indexLocalArtifact(
  engine: Engine,
  artifactReference: string,
  options: IndexArtifactOptions = {},
): Promise<SemanticIndexResult> {
  options.signal?.throwIfAborted();
  // Enqueue sites pass whatever reference they hold (often the slug), but
  // temporalSearch.commitBatch rejects anything except the canonical UUID.
  const artifactResult = engine.artifacts.get(artifactReference);
  if (!artifactResult.ok) throw new Error(artifactResult.error.message);
  const artifactId = artifactResult.value.artifactId;
  const manifestResult = engine.temporalSearch.manifests.register(MANIFEST);
  if (!manifestResult.ok) throw new Error(manifestResult.error.message);
  const filesResult = await engine.files.manifest(artifactId);
  if (!filesResult.ok) throw Object.assign(new Error(filesResult.error.message), { name: filesResult.error.code, error: filesResult.error });
  const streamsResult = engine.streams.list(artifactId);
  if (!streamsResult.ok) throw new Error(streamsResult.error.message);
  const files = filesResult.value.files;
  const streams = streamsResult.value.filter((stream) =>
    files.some((file) => file.name === stream.sourcePath && file.objectHash === stream.objectHash));
  const source = primarySource(files, streams);
  if (!source) throw new Error(`No indexable source found for ${artifactId}`);
  const observations = await buildObservations(
    engine,
    artifactId,
    source.name,
    source.objectHash,
    streams,
  );
  const coveredRanges = observations.flatMap((item) => item.range ? [item.range] : []);
  for (const phase of PHASES) {
    const phaseObservations = phase === "visual" || phase === "audio" || phase === "lexical"
      ? observations.filter((item) => observationPhase(item) === phase)
      : [];
    const committed = engine.temporalSearch.commitBatch({
      artifactId,
      objectHash: source.objectHash,
      manifestId: MANIFEST.manifestId,
      generation: GENERATION,
      phase,
      maxUnits: Math.max(1, phaseObservations.length),
      observations: phaseObservations,
      coveredRanges,
      totalUnits: phaseObservations.length,
      complete: true,
    });
    if (!committed.ok) throw new Error(committed.error.message);
  }
  const activated = engine.temporalSearch.activate(MANIFEST.manifestId, GENERATION);
  if (!activated.ok) throw new Error(activated.error.message);
  const prepared = await engine.temporalSearch.prepare({
    manifestId: MANIFEST.manifestId, generation: GENERATION,
    signal: options.signal, checkpoint: "periodic",
  });
  if (!prepared.ok) throw new Error(prepared.error.message);
  let semanticVisual: SemanticIndexResult["semanticVisual"] = artifactResult.value.kind === "image"
    || streams.some((stream) => stream.kind === "video" && stream.objectHash === source.objectHash)
    ? "deferred" : "not-applicable";
  let semanticAudio: SemanticIndexResult["semanticAudio"] = streams.some(
    (stream) => stream.kind === "audio" && stream.objectHash === source.objectHash,
  ) ? "deferred" : "not-applicable";
  if (options.semanticVisual && semanticVisual !== "not-applicable") {
    try {
      await indexClipArtifact(
        engine,
        artifactId,
        filesResult.value.path,
        source.name,
        source.objectHash,
        streams,
        options.signal,
      );
      semanticVisual = "ready";
    } catch (error) {
      if (options.strictVisual || options.signal?.aborted || isTerminalIndexFailure(error)) throw error;
      await appendDiagnostic(engine, "semantic-index-deferred", {
        artifactId,
        modality: "visual",
        error,
      }).catch(() => undefined);
    }
  }
  if (options.semanticVisual && options.semanticAudio !== false && semanticAudio !== "not-applicable") {
    try {
      await indexClapArtifact(
        engine,
        artifactId,
        filesResult.value.path,
        source.name,
        source.objectHash,
        streams,
        options.signal,
      );
      semanticAudio = "ready";
    } catch (error) {
      if (options.signal?.aborted || isTerminalIndexFailure(error)) throw error;
      await appendDiagnostic(engine, "semantic-index-deferred", {
        artifactId,
        modality: "audio",
        error,
      }).catch(() => undefined);
    }
  }
  return {
    success: true,
    artifactId,
    observationCount: observations.length,
    manifestId: MANIFEST.manifestId,
    generation: GENERATION,
    semanticVisual,
    semanticAudio,
  };
}

export function registerSemanticIndexJob(engine: Engine): void {
  registerJobHandler("semantic_index", async (payload, ctx) => engine.withLocalMedia(async () => {
    if (payload.migration === true) {
      const { prepareMigrationFrames } = await import("../migration-media.js");
      await prepareMigrationFrames(engine, String(payload.assetId), ctx.signal);
    }
    return runSemanticIndex(engine, payload as SemanticIndexPayload, ctx);
  }));
}

async function indexClipArtifact(
  engine: Engine,
  artifactId: string,
  artifactPath: string,
  sourcePath: string,
  objectHash: string,
  streams: ArtifactStream[],
  signal?: AbortSignal,
): Promise<void> {
  const provider = registerLocalClipSearchProvider(engine);
  const registered = engine.temporalSearch.manifests.register(LOCAL_CLIP_MANIFEST);
  if (!registered.ok) throw new Error(registered.error.message);
  await provider.prepare({ signal });
  const video = streams.find((stream) =>
    stream.kind === "video" && stream.objectHash === objectHash);
  const frames = video
    ? await sampledFrameNames(engine, artifactId)
    : [];
  const totalUnits = video ? frames.length : 1;
  await commitDeepBatches(
    engine,
    {
      artifactId,
      objectHash,
      manifestId: LOCAL_CLIP_MANIFEST.manifestId,
      generation: LOCAL_CLIP_MANIFEST.manifestId,
      phase: "visual",
      totalUnits,
      ...(video ? { unitSourceSeconds: frameSourceSeconds(frames, video) } : {}),
      signal,
    },
    async (start, end) => {
      if (!video) {
        return [{
          artifactId,
          objectHash,
          sourcePath,
          kind: "frame" as const,
          segmentationVersion: "clip-still-v1",
          texts: [],
          embeddings: [{
            modality: "visual" as const,
            embeddingSpace: LOCAL_CLIP_MANIFEST.embeddingSpace,
            vector: [...await provider.embedImage(join(artifactPath, sourcePath), { signal })],
            sourceHash: objectHash,
          }],
          fingerprints: [],
        }];
      }
      return clipVideoObservationBatch(
        provider,
        artifactId,
        artifactPath,
        objectHash,
        video,
        frames,
        start,
        end,
        signal,
      );
    },
  );
  const activated = engine.temporalSearch.activate(
    LOCAL_CLIP_MANIFEST.manifestId,
    LOCAL_CLIP_MANIFEST.manifestId,
  );
  if (!activated.ok) throw new Error(activated.error.message);
}

async function indexClapArtifact(
  engine: Engine,
  artifactId: string,
  artifactPath: string,
  sourcePath: string,
  objectHash: string,
  streams: ArtifactStream[],
  signal?: AbortSignal,
): Promise<void> {
  const stream = streams.find((item) =>
    item.kind === "audio" && item.objectHash === objectHash);
  if (!stream) return;
  const provider = registerLocalClapSearchProvider(engine, FFMPEG);
  const registered = engine.temporalSearch.manifests.register(LOCAL_CLAP_MANIFEST);
  if (!registered.ok) throw new Error(registered.error.message);
  await provider.prepare({ signal });
  const windowTicks = Math.max(
    1,
    Math.round(10 * stream.timeBase.denominator / stream.timeBase.numerator),
  );
  const totalUnits = Math.ceil(stream.durationTicks / windowTicks);
  await commitDeepBatches(
    engine,
    {
      artifactId,
      objectHash,
      manifestId: LOCAL_CLAP_MANIFEST.manifestId,
      generation: LOCAL_CLAP_MANIFEST.manifestId,
      phase: "audio",
      totalUnits,
      unitSourceSeconds: (start, end) => ticksToSeconds(
        Math.min(end * windowTicks, stream.durationTicks) - start * windowTicks,
        stream,
      ),
      signal,
    },
    (start, end) => clapAudioObservationBatch(
      provider,
      artifactId,
      artifactPath,
      sourcePath,
      objectHash,
      stream,
      windowTicks,
      start,
      end,
      signal,
    ),
  );
  const activated = engine.temporalSearch.activate(
    LOCAL_CLAP_MANIFEST.manifestId,
    LOCAL_CLAP_MANIFEST.manifestId,
  );
  if (!activated.ok) throw new Error(activated.error.message);
}

async function clapAudioObservationBatch(
  provider: LocalClapTemporalProvider,
  artifactId: string,
  artifactPath: string,
  sourcePath: string,
  objectHash: string,
  stream: ArtifactStream,
  windowTicks: number,
  startIndex: number,
  endIndex: number,
  signal?: AbortSignal,
): Promise<TemporalIndexObservation[]> {
  const observations: TemporalIndexObservation[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    signal?.throwIfAborted();
    const startTick = index * windowTicks;
    const durationTicks = Math.min(windowTicks, stream.durationTicks - startTick);
    const startSeconds = startTick * stream.timeBase.numerator
      / stream.timeBase.denominator;
    const durationSeconds = durationTicks * stream.timeBase.numerator
      / stream.timeBase.denominator;
    observations.push({
      artifactId,
      objectHash,
      streamId: stream.streamId,
      range: {
        streamId: stream.streamId,
        objectHash,
        startTick,
        durationTicks,
        timeBase: stream.timeBase,
      },
      kind: "audio-event",
      representativeTick: startTick + Math.floor(durationTicks / 2),
      segmentationVersion: "clap-10s-windows-v1",
      texts: [],
      embeddings: [{
        modality: "audio",
        embeddingSpace: LOCAL_CLAP_MANIFEST.embeddingSpace,
        vector: [...await provider.embedAudio(
          join(artifactPath, sourcePath),
          startSeconds,
          durationSeconds,
          { signal },
        )],
        sourceHash: hashText(`${objectHash}:${startTick}:${durationTicks}`),
      }],
      fingerprints: [],
    });
  }
  return observations;
}

async function sampledFrameNames(
  engine: Engine,
  artifactId: string,
): Promise<string[]> {
  const listed = await engine.files.listSubdir(artifactId, "original_frames");
  if (!listed.ok) throw new Error(listed.error.message);
  return listed.value
    .filter((name) => name.endsWith(".jpg"))
    .sort(numericFilename);
}

async function clipVideoObservationBatch(
  provider: LocalClipTemporalProvider,
  artifactId: string,
  artifactPath: string,
  objectHash: string,
  stream: ArtifactStream,
  frames: string[],
  startIndex: number,
  endIndex: number,
  signal?: AbortSignal,
): Promise<TemporalIndexObservation[]> {
  const observations: TemporalIndexObservation[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    signal?.throwIfAborted();
    const name = frames[index]!;
    const seconds = Number.parseFloat(name);
    const nextSeconds = Number.parseFloat(frames[index + 1] ?? "");
    const startTick = clampTick(secondsToTick(seconds, stream), stream);
    const nextTick = Number.isFinite(nextSeconds)
      ? clampTick(secondsToTick(nextSeconds, stream), stream)
      : stream.durationTicks;
    const framePath = `original_frames/${name}`;
    observations.push({
      artifactId,
      objectHash,
      streamId: stream.streamId,
      range: {
        streamId: stream.streamId,
        objectHash,
        startTick,
        durationTicks: Math.max(1, nextTick - startTick),
        timeBase: stream.timeBase,
      },
      kind: "frame",
      representativeTick: startTick,
      segmentationVersion: "clip-sampled-frames-v1",
      texts: [],
      embeddings: [{
        modality: "visual",
        embeddingSpace: LOCAL_CLIP_MANIFEST.embeddingSpace,
        vector: [...await provider.embedImage(join(artifactPath, framePath), { signal })],
        sourceHash: hashText(`${objectHash}:${framePath}`),
      }],
      fingerprints: [],
    });
  }
  return observations;
}

type DeepBatchOptions = {
  artifactId: string;
  objectHash: string;
  manifestId: string;
  generation: string;
  phase: "visual" | "audio";
  totalUnits: number;
  /**
   * Source seconds covered by units [start, end). When present, each batch
   * stops before covering more than MAX_BATCH_SOURCE_SECONDS; a single unit
   * is always committed on its own even when it alone spans more.
   */
  unitSourceSeconds?: (start: number, end: number) => number;
  signal?: AbortSignal;
};

export function deepBatchEnd(start: number, options: DeepBatchOptions): number {
  const limit = Math.min(options.totalUnits, start + DEEP_BATCH_SIZE);
  let end = Math.min(limit, start + 1);
  while (end < limit) {
    const covered = options.unitSourceSeconds?.(start, end + 1) ?? 0;
    if (Number.isFinite(covered) && covered > MAX_BATCH_SOURCE_SECONDS) break;
    end += 1;
  }
  return end;
}

function frameSourceSeconds(
  frames: string[],
  stream: ArtifactStream,
): (start: number, end: number) => number {
  const seconds = frames.map((name) => Number.parseFloat(name));
  const durationSeconds = ticksToSeconds(stream.durationTicks, stream);
  return (start, end) => {
    const from = seconds[start];
    const to = end < seconds.length ? seconds[end] : durationSeconds;
    return from === undefined || to === undefined ? 0 : to - from;
  };
}

function ticksToSeconds(ticks: number, stream: ArtifactStream): number {
  return ticks * stream.timeBase.numerator / stream.timeBase.denominator;
}

export async function commitDeepBatches(
  engine: Engine,
  options: DeepBatchOptions,
  build: (start: number, end: number) => Promise<TemporalIndexObservation[]>,
): Promise<void> {
  const plan = engine.temporalSearch.plan(
    options.artifactId,
    options.objectHash,
    options.manifestId,
    options.generation,
  );
  if (!plan.ok) throw new Error(plan.error.message);
  const existing = plan.value.coverage.find((item) => item.phase === options.phase);
  if (existing?.state === "ready" && existing.indexedUnits >= options.totalUnits) {
    await prepareDeepBatch(engine, options);
    return;
  }
  let start = cursorIndex(existing?.nextCursor, existing?.indexedUnits, options.totalUnits);
  let coveredRanges = existing?.coveredRanges ?? [];
  if (options.totalUnits === 0) {
    const committed = engine.temporalSearch.commitBatch({
      artifactId: options.artifactId,
      objectHash: options.objectHash,
      manifestId: options.manifestId,
      generation: options.generation,
      phase: options.phase,
      cursor: "0",
      maxUnits: 1,
      observations: [],
      coveredRanges,
      totalUnits: 0,
      complete: true,
    });
    if (!committed.ok) throw new Error(committed.error.message);
    return;
  }
  while (start < options.totalUnits) {
    options.signal?.throwIfAborted();
    const end = deepBatchEnd(start, options);
    const observations = await build(start, end);
    options.signal?.throwIfAborted();
    coveredRanges = [
      ...coveredRanges,
      ...observations.flatMap((item) => item.range ? [item.range] : []),
    ];
    const complete = end >= options.totalUnits;
    const committed = engine.temporalSearch.commitBatch({
      artifactId: options.artifactId,
      objectHash: options.objectHash,
      manifestId: options.manifestId,
      generation: options.generation,
      phase: options.phase,
      cursor: String(start),
      maxUnits: DEEP_BATCH_SIZE,
      observations,
      coveredRanges,
      totalUnits: options.totalUnits,
      ...(complete ? {} : { nextCursor: String(end) }),
      complete,
    });
    if (!committed.ok) throw new Error(committed.error.message);
    await prepareDeepBatch(engine, options);
    start = end;
  }
}

async function prepareDeepBatch(engine: Engine, options: DeepBatchOptions): Promise<void> {
  const activated = engine.temporalSearch.activate(options.manifestId, options.generation);
  if (!activated.ok) throw new Error(activated.error.message);
  const prepared = await engine.temporalSearch.prepare({
    manifestId: options.manifestId,
    generation: options.generation,
    signal: options.signal,
    checkpoint: "periodic",
  });
  if (!prepared.ok) throw new Error(prepared.error.message);
}

function cursorIndex(
  cursor: string | undefined,
  indexedUnits: number | undefined,
  totalUnits: number,
): number {
  const parsed = cursor === undefined ? Number.NaN : Number(cursor);
  const candidate = Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : indexedUnits ?? 0;
  return Math.min(totalUnits, Math.max(0, candidate));
}

async function buildObservations(
  engine: Engine,
  artifactId: string,
  sourcePath: string,
  objectHash: string,
  streams: ArtifactStream[],
): Promise<TemporalIndexObservation[]> {
  const analysis = await readJson<AnalysisDocument>(engine, artifactId, ".original.analysis.json");
  const transcript = await readJson<{ text?: unknown }>(
    engine,
    artifactId,
    ".analysis.gpt4otrans.json",
  );
  const video = streams.find((stream) =>
    stream.kind === "video" && stream.objectHash === objectHash);
  const audio = streams.find((stream) =>
    stream.kind === "audio" && stream.objectHash === objectHash);
  const visual = video
    ? await videoObservations(engine, artifactId, objectHash, video, analysis)
    : audio
      ? []
      : [stillObservation(artifactId, sourcePath, objectHash, analysis)];
  const observations = [...visual];
  if (audio) observations.push(audioObservation(artifactId, objectHash, audio));
  const typedTranscripts = await engine.transcripts.list(artifactId);
  const typedTranscript = typedTranscripts.ok
    ? typedTranscripts.value.at(-1)
    : undefined;
  const typedObservations = typedTranscript && audio
    ? transcriptObservations(typedTranscript, audio, objectHash)
    : [];
  observations.push(...typedObservations);
  const transcriptText = typedObservations.length === 0
    ? stringValue(transcript?.text)
    : null;
  if (transcriptText && audio) {
    observations.push({
      artifactId,
      objectHash,
      streamId: audio.streamId,
      range: fullRange(audio),
      kind: "speech",
      representativeTick: Math.floor(audio.durationTicks / 2),
      segmentationVersion: "transcript-whole-v1",
      texts: [{
        kind: "transcript",
        language: "und",
        text: transcriptText,
        provenance: { sourcePath: ".analysis.gpt4otrans.json" },
      }],
      embeddings: [],
      fingerprints: [],
    });
  }
  return observations;
}

function transcriptObservations(
  transcript: Transcript,
  stream: ArtifactStream,
  objectHash: string,
): TemporalIndexObservation[] {
  return transcript.segments.flatMap((segment) => {
    if (
      segment.range.streamId !== stream.streamId
      || segment.range.objectHash !== objectHash
      || !segment.text.trim()
    ) return [];
    return [{
      artifactId: transcript.artifactId,
      objectHash,
      streamId: stream.streamId,
      range: segment.range,
      kind: segment.kind === "speech" ? "speech" as const : "audio-event" as const,
      representativeTick: segment.range.startTick
        + Math.floor(segment.range.durationTicks / 2),
      segmentationVersion: `typed-transcript-${transcript.revision}`,
      texts: [{
        kind: "transcript" as const,
        language: transcript.language,
        text: segment.text,
        ...(segment.confidence === undefined
          ? {}
          : { confidence: segment.confidence }),
        provenance: {
          transcriptId: transcript.transcriptId,
          transcriptRevision: transcript.revision,
          segmentId: segment.segmentId,
          segmentKind: segment.kind,
          ...(segment.speaker ? { speaker: segment.speaker } : {}),
        },
      }],
      embeddings: [],
      fingerprints: [],
    }];
  });
}

async function videoObservations(
  engine: Engine,
  artifactId: string,
  objectHash: string,
  stream: ArtifactStream,
  analysis: AnalysisDocument | null,
): Promise<TemporalIndexObservation[]> {
  const list = await engine.files.listSubdir(artifactId, "original_frames");
  const frameNames = list.ok
    ? list.value.filter((name) => name.endsWith(".jpg")).sort(numericFilename)
    : [];
  const scenes = analysisScenes(analysis);
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw Object.assign(new Error(manifest.error.message), { name: manifest.error.code, error: manifest.error });
  const frameFiles = new Map(
    manifest.value.files.map((file) => [file.name, file]),
  );
  if (frameNames.length === 0) {
    return [{
      artifactId,
      objectHash,
      streamId: stream.streamId,
      range: fullRange(stream),
      kind: "window",
      representativeTick: Math.floor(stream.durationTicks / 2),
      segmentationVersion: "whole-video-v1",
      texts: analysisTexts(analysis),
      embeddings: [embedding("visual", objectHash)],
      fingerprints: [fingerprint(objectHash)],
    }];
  }
  const observations: TemporalIndexObservation[] = [];
  for (let index = 0; index < frameNames.length; index += 1) {
    const name = frameNames[index]!;
    const seconds = Number.parseFloat(name);
    const nextSeconds = Number.parseFloat(frameNames[index + 1] ?? "");
    const startTick = clampTick(secondsToTick(seconds, stream), stream);
    const nextTick = Number.isFinite(nextSeconds)
      ? clampTick(secondsToTick(nextSeconds, stream), stream)
      : stream.durationTicks;
    const durationTicks = Math.max(1, nextTick - startTick);
    const framePath = `original_frames/${name}`;
    const frameFile = frameFiles.get(framePath);
    const frameHash = frameFile?.objectHash ?? hashText(`${objectHash}:${framePath}`);
    const nearbyScene = scenes
      .filter((scene) => scene.timestamp <= seconds)
      .at(-1);
    observations.push({
      artifactId,
      objectHash,
      streamId: stream.streamId,
      range: {
        streamId: stream.streamId,
        objectHash,
        startTick,
        durationTicks,
        timeBase: stream.timeBase,
      },
      kind: "frame",
      representativeTick: startTick,
      segmentationVersion: "sampled-frames-v1",
      texts: [
        ...(nearbyScene ? sceneTexts(nearbyScene) : []),
        ...(index === 0 ? analysisTexts(analysis) : []),
      ],
      embeddings: [embedding("visual", frameHash)],
      fingerprints: [fingerprint(frameHash)],
    });
  }
  return observations;
}

function stillObservation(
  artifactId: string,
  sourcePath: string,
  objectHash: string,
  analysis: AnalysisDocument | null,
): TemporalIndexObservation {
  return {
    artifactId,
    objectHash,
    sourcePath,
    kind: "frame",
    segmentationVersion: "still-v1",
    texts: analysisTexts(analysis),
    embeddings: [embedding("visual", objectHash)],
    fingerprints: [fingerprint(objectHash)],
  };
}

function audioObservation(
  artifactId: string,
  objectHash: string,
  stream: ArtifactStream,
): TemporalIndexObservation {
  return {
    artifactId,
    objectHash,
    streamId: stream.streamId,
    range: fullRange(stream),
    kind: "audio-event",
    representativeTick: Math.floor(stream.durationTicks / 2),
    segmentationVersion: "whole-audio-v1",
    texts: [],
    embeddings: [embedding("audio", objectHash)],
    fingerprints: [fingerprint(objectHash)],
  };
}

function observationPhase(
  observation: TemporalIndexObservation,
): "visual" | "audio" | "lexical" {
  if (observation.texts.length > 0 && observation.embeddings.length === 0) return "lexical";
  return observation.kind === "audio-event" ? "audio" : "visual";
}

function embedding(
  modality: "visual" | "audio",
  sourceHash: string,
): TemporalIndexObservation["embeddings"][number] {
  const bytes = Buffer.from(hashText(sourceHash), "hex");
  const values = [...bytes].map((value) => value / 127.5 - 1);
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return {
    modality,
    embeddingSpace: MANIFEST.embeddingSpace,
    vector: values.map((value) => value / magnitude),
    sourceHash,
  };
}

function fingerprint(value: string): TemporalIndexObservation["fingerprints"][number] {
  return {
    kind: "sha256",
    value,
    extractorVersion: MANIFEST.extractorVersion,
  };
}

function fullRange(stream: ArtifactStream) {
  return {
    streamId: stream.streamId,
    objectHash: stream.objectHash,
    startTick: 0,
    durationTicks: stream.durationTicks,
    timeBase: stream.timeBase,
  };
}

function secondsToTick(seconds: number, stream: ArtifactStream): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(seconds * stream.timeBase.denominator / stream.timeBase.numerator);
}

function clampTick(tick: number, stream: ArtifactStream): number {
  return Math.min(Math.max(0, tick), Math.max(0, stream.durationTicks - 1));
}

function analysisTexts(analysis: AnalysisDocument | null): SegmentTextObservation[] {
  if (!analysis) return [];
  const fields = [
    analysis.summary,
    analysis.mood,
    analysis.setting,
    analysis.tags,
    analysis.subjects,
    analysis.actions,
  ];
  const description = fields.flatMap(strings).join(" ").trim();
  const ocr = strings(analysis.textOnScreen).join(" ").trim();
  return [
    ...(description ? [{ kind: "description" as const, language: "und", text: description }] : []),
    ...(ocr ? [{ kind: "ocr" as const, language: "und", text: ocr }] : []),
  ];
}

function analysisScenes(analysis: AnalysisDocument | null) {
  if (!analysis || !Array.isArray(analysis.scenes)) return [];
  return analysis.scenes.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const scene = value as AnalysisScene;
    const timestamp = Number(scene.timestamp);
    const description = stringValue(scene.description);
    if (!Number.isFinite(timestamp) || timestamp < 0 || !description) return [];
    return [{ timestamp, description, tags: strings(scene.tags) }];
  }).sort((left, right) => left.timestamp - right.timestamp);
}

function sceneTexts(scene: ReturnType<typeof analysisScenes>[number]): SegmentTextObservation[] {
  return [{
    kind: "description",
    language: "und",
    text: [scene.description, ...scene.tags].join(" "),
  }];
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(strings);
  const item = stringValue(value);
  return item ? [item] : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function readJson<T>(
  engine: Engine,
  artifactId: string,
  path: string,
): Promise<T | null> {
  const read = await engine.files.read(artifactId, path);
  if (!read.ok) return null;
  try {
    return JSON.parse(
      typeof read.value === "string"
        ? read.value
        : new TextDecoder().decode(read.value),
    ) as T;
  } catch {
    return null;
  }
}

function primarySource(
  files: Array<{ name: string; objectHash: string }>,
  streams: ArtifactStream[],
): { name: string; objectHash: string } | null {
  const stream = streams.find((item) => item.kind === "video") ?? streams[0];
  if (stream) return { name: stream.sourcePath, objectHash: stream.objectHash };
  return files.find((file) => /^original\.(?:jpe?g|png|webp|gif|svg)$/i.test(file.name))
    ?? null;
}

function numericFilename(left: string, right: string): number {
  return Number.parseFloat(left) - Number.parseFloat(right) || left.localeCompare(right);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
