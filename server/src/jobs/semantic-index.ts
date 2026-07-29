import { createHash } from "node:crypto";
import { join } from "node:path";
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
  withLocalLease,
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

export type SemanticIndexPayload = {
  type: "semantic_index";
  assetId: string;
  bookId: string;
};

export type SemanticIndexResult = {
  success: true;
  artifactId: string;
  observationCount: number;
  manifestId: string;
  generation: string;
  semanticVisual: "ready" | "deferred";
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
  fs: Engine,
  payload: SemanticIndexPayload,
  ctx: JobHandlerContext,
): Promise<SemanticIndexResult> {
  return withLocalLease(
    fs,
    payload.bookId,
    payload.assetId,
    ctx,
    "analyze",
    async () => withTransientStorageRetry(
      () => indexArtifact(fs, payload.assetId, {
        semanticVisual: true,
        signal: ctx.signal,
      }),
      ctx.signal,
    ),
    { waitForActiveMs: DOWNSTREAM_LEASE_WAIT_MS },
  );
}

export async function indexArtifact(
  fs: Engine,
  artifactId: string,
  options: { semanticVisual?: boolean; signal?: AbortSignal } = {},
): Promise<SemanticIndexResult> {
  const manifestResult = fs.temporalSearch.manifests.register(MANIFEST);
  if (!manifestResult.ok) throw new Error(manifestResult.error.message);
  const filesResult = await fs.files.manifest(artifactId);
  if (!filesResult.ok) throw new Error(filesResult.error.message);
  const streamsResult = fs.streams.list(artifactId);
  if (!streamsResult.ok) throw new Error(streamsResult.error.message);
  const files = filesResult.value.files;
  const streams = streamsResult.value;
  const source = primarySource(files, streams);
  if (!source) throw new Error(`No indexable source found for ${artifactId}`);
  const observations = await buildObservations(
    fs,
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
    const committed = fs.temporalSearch.commitBatch({
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
  const activated = fs.temporalSearch.activate(MANIFEST.manifestId, GENERATION);
  if (!activated.ok) throw new Error(activated.error.message);
  let semanticVisual: SemanticIndexResult["semanticVisual"] = "deferred";
  let semanticAudio: SemanticIndexResult["semanticAudio"] = streams.some(
    (stream) => stream.kind === "audio" && stream.objectHash === source.objectHash,
  ) ? "deferred" : "not-applicable";
  if (options.semanticVisual) {
    try {
      await indexClipArtifact(
        fs,
        artifactId,
        filesResult.value.path,
        source.name,
        source.objectHash,
        streams,
        options.signal,
      );
      semanticVisual = "ready";
    } catch (error) {
      await fs.logs.append("semantic-index-deferred", {
        artifactId,
        manifestId: LOCAL_CLIP_MANIFEST.manifestId,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
    if (semanticAudio !== "not-applicable") {
      try {
        await indexClapArtifact(
          fs,
          artifactId,
          filesResult.value.path,
          source.name,
          source.objectHash,
          streams,
          options.signal,
        );
        semanticAudio = "ready";
      } catch (error) {
        await fs.logs.append("semantic-index-deferred", {
          artifactId,
          manifestId: LOCAL_CLAP_MANIFEST.manifestId,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      }
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

export function registerSemanticIndexJob(fs: Engine): void {
  registerJobHandler("semantic_index", async (payload, ctx) =>
    runSemanticIndex(fs, payload as SemanticIndexPayload, ctx));
}

async function indexClipArtifact(
  fs: Engine,
  artifactId: string,
  artifactPath: string,
  sourcePath: string,
  objectHash: string,
  streams: ArtifactStream[],
  signal?: AbortSignal,
): Promise<void> {
  const provider = registerLocalClipSearchProvider(fs);
  const registered = fs.temporalSearch.manifests.register(LOCAL_CLIP_MANIFEST);
  if (!registered.ok) throw new Error(registered.error.message);
  await provider.prepare();
  const video = streams.find((stream) =>
    stream.kind === "video" && stream.objectHash === objectHash);
  const frames = video
    ? await sampledFrameNames(fs, artifactId)
    : [];
  const totalUnits = video ? frames.length : 1;
  await commitDeepBatches(
    fs,
    {
      artifactId,
      objectHash,
      manifestId: LOCAL_CLIP_MANIFEST.manifestId,
      generation: LOCAL_CLIP_MANIFEST.manifestId,
      phase: "visual",
      totalUnits,
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
            vector: [...await provider.embedImage(join(artifactPath, sourcePath))],
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
  const activated = fs.temporalSearch.activate(
    LOCAL_CLIP_MANIFEST.manifestId,
    LOCAL_CLIP_MANIFEST.manifestId,
  );
  if (!activated.ok) throw new Error(activated.error.message);
}

async function indexClapArtifact(
  fs: Engine,
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
  const provider = registerLocalClapSearchProvider(fs, FFMPEG);
  const registered = fs.temporalSearch.manifests.register(LOCAL_CLAP_MANIFEST);
  if (!registered.ok) throw new Error(registered.error.message);
  await provider.prepare();
  const windowTicks = Math.max(
    1,
    Math.round(10 * stream.timeBase.denominator / stream.timeBase.numerator),
  );
  const totalUnits = Math.ceil(stream.durationTicks / windowTicks);
  await commitDeepBatches(
    fs,
    {
      artifactId,
      objectHash,
      manifestId: LOCAL_CLAP_MANIFEST.manifestId,
      generation: LOCAL_CLAP_MANIFEST.manifestId,
      phase: "audio",
      totalUnits,
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
  const activated = fs.temporalSearch.activate(
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
        )],
        sourceHash: hashText(`${objectHash}:${startTick}:${durationTicks}`),
      }],
      fingerprints: [],
    });
  }
  return observations;
}

async function sampledFrameNames(
  fs: Engine,
  artifactId: string,
): Promise<string[]> {
  const listed = await fs.files.listSubdir(artifactId, "original_frames");
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
        vector: [...await provider.embedImage(join(artifactPath, framePath))],
        sourceHash: hashText(`${objectHash}:${framePath}`),
      }],
      fingerprints: [],
    });
  }
  return observations;
}

export type DeepBatchOptions = {
  artifactId: string;
  objectHash: string;
  manifestId: string;
  generation: string;
  phase: "visual" | "audio";
  totalUnits: number;
  signal?: AbortSignal;
};

export async function commitDeepBatches(
  fs: Engine,
  options: DeepBatchOptions,
  build: (start: number, end: number) => Promise<TemporalIndexObservation[]>,
): Promise<void> {
  const plan = fs.temporalSearch.plan(
    options.artifactId,
    options.objectHash,
    options.manifestId,
    options.generation,
  );
  if (!plan.ok) throw new Error(plan.error.message);
  const existing = plan.value.coverage.find((item) => item.phase === options.phase);
  if (existing?.state === "ready" && existing.indexedUnits >= options.totalUnits) return;
  let start = cursorIndex(existing?.nextCursor, existing?.indexedUnits, options.totalUnits);
  let coveredRanges = existing?.coveredRanges ?? [];
  if (options.totalUnits === 0) {
    const committed = fs.temporalSearch.commitBatch({
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
    const end = Math.min(options.totalUnits, start + DEEP_BATCH_SIZE);
    const observations = await build(start, end);
    coveredRanges = [
      ...coveredRanges,
      ...observations.flatMap((item) => item.range ? [item.range] : []),
    ];
    const complete = end >= options.totalUnits;
    const committed = fs.temporalSearch.commitBatch({
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
    start = end;
  }
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
  fs: Engine,
  artifactId: string,
  sourcePath: string,
  objectHash: string,
  streams: ArtifactStream[],
): Promise<TemporalIndexObservation[]> {
  const analysis = await readJson<AnalysisDocument>(fs, artifactId, ".original.analysis.json");
  const transcript = await readJson<{ text?: unknown }>(
    fs,
    artifactId,
    ".analysis.gpt4otrans.json",
  );
  const video = streams.find((stream) =>
    stream.kind === "video" && stream.objectHash === objectHash);
  const audio = streams.find((stream) =>
    stream.kind === "audio" && stream.objectHash === objectHash);
  const visual = video
    ? await videoObservations(fs, artifactId, objectHash, video, analysis)
    : audio
      ? []
      : [stillObservation(artifactId, sourcePath, objectHash, analysis)];
  const observations = [...visual];
  if (audio) observations.push(audioObservation(artifactId, objectHash, audio));
  const typedTranscripts = await fs.transcripts.list(artifactId);
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
  fs: Engine,
  artifactId: string,
  objectHash: string,
  stream: ArtifactStream,
  analysis: AnalysisDocument | null,
): Promise<TemporalIndexObservation[]> {
  const list = await fs.files.listSubdir(artifactId, "original_frames");
  const frameNames = list.ok
    ? list.value.filter((name) => name.endsWith(".jpg")).sort(numericFilename)
    : [];
  const scenes = analysisScenes(analysis);
  const manifest = await fs.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
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
  fs: Engine,
  artifactId: string,
  path: string,
): Promise<T | null> {
  const read = await fs.files.read(artifactId, path);
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
