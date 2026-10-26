import { seedanceEditFailure } from "../media/seedance-edit.js";
import { createKie, createXai, createAlibaba, createFal } from "../usage-providers.js";
import { describeFalError } from "../jobs/_fal-shared.js";
import { currentBookContext, withBookContext } from "../book-context.js";
import { settleFinishedUsage } from "../provider-usage.js";
import { legacyMediaForTaskType } from "../media/legacy-task-types.js";
import { parseModelId } from "../media/model-id.js";
import type { Engine, Artifact, ArtifactKind, ArtifactManifestFile } from "videobook-engine";
import { computeArtifactStatus, QUEUED_TASK_ID } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { KieError } from "@apicity/kie";
import type { KieTaskInfo, KieTaskInfoData } from "@apicity/kie";
import { XaiError } from "@apicity/xai";
import { AlibabaError } from "@apicity/alibaba";
import { FalError } from "@apicity/fal";
import { MachGenError } from "@apicity/machgen";
import type { MachGenTaskStatusResponse } from "@apicity/machgen";
import {
  EMPTY_TAG_SUMMARY,
  readAssetTagSummaries,
  type AssetTagSummary,
} from "../asset-tags.js";
import { logger } from "../logger.js";
import { queue } from "../queue.js";
import { getApiKey } from "../api-key.js";
import {
  findVideoFile,
  findAudioFile,
  RENDER_ORIENTATIONS as MEDIA_RENDER_ORIENTATIONS,
} from "videobook-engine";
import { readAndAssessDialog } from "../dialog-quality.js";
import {
  hasSpokenAudio,
  PLAIN_TRANSCRIPT_FILE,
  readAssetTranscriptSources,
  TIMED_TRANSCRIPT_FILE,
  type AssetTranscriptSources,
} from "../transcript-projection.js";
import {
  isAnalyzableVideo,
  readVideoAnalysisSummary,
  VIDEO_ANALYSIS_FILE,
  type VideoAnalysisSummary,
} from "../video-analysis-projection.js";
import { failPendingTaskAndLog } from "../jobs/task-failure.js";
import type { PendingTask } from "videobook-engine";
import { findUnprocessedUploads, processExternalUpload } from "../jobs/process-upload.js";
import { planVideoTranscriptJobs } from "../jobs/process-video.js";
import { providerEndpoints } from "../media/endpoints.js";
import { machgenProvider } from "../media/adapters/machgen.js";
import { MEDIA_TASK_TYPES } from "../media/adapters/types.js";
import type { ToolDef } from "./tool-def.js";
import { submitQueuedKieTask } from "../jobs/kie-paygate.js";
import {
  DEFAULT_KEYWORD_GRAPHICS_LINGER_SECONDS,
  DEFAULT_KEYWORD_GRAPHICS_MAX_COUNT,
} from "../remotion/keyword-graphics.js";
import type { VideoProxyAssessment } from "../video-proxy.js";
import { DEFAULT_TRANSCRIPT_OPTIONS, elevenLabsTranscriptKey } from "../transcript-components.js";
import {
  assetDuration,
  assetMediaUrls,
  assetStreamProfile,
  findAssetMediaFile,
  groupByArtifactId,
  indexByArtifactId,
  PARTIAL_DOWNLOAD_RE,
  scheduleMissingVideoPoster,
  servedVideoProxyFile,
} from "../asset-media-projection.js";

/** Upper bound on how long a pending task may sit without reaching success/fail
 *  before reconciliation ages it out. Guards against providers leaving jobs in an
 *  intermediate "waiting" state indefinitely. */
const PENDING_TASK_TIMEOUT_MS = 30 * 60 * 1000;

type AssetWorkProjection = {
  /** New 4-status enum from the assets materialized table. */
  status: "pending" | "working" | "ready" | "error";
  meta: {
    kind?: string | null;
    orientation?: "portrait" | "landscape" | "square" | null;
    queued?: boolean;
    progress?: number | null;
    error?: { message: string; code: string | null } | null;
    [k: string]: unknown;
  };
  ownerKind: "job" | "provider" | null;
  deadlineAt: number | null;
};

type ProjectAssetAnalysis = {
  source_duration_seconds: number;
  output_json: unknown | null;
  output_url: string | null;
  llm_exchanges: Array<{
    provider: string;
    model: string;
    stage: string;
    response_format: {
      type: string;
      name: string | null;
      strict: boolean;
    } | null;
  }>;
  shots: Array<{
    ordinal: number;
    label: string;
    start_seconds: number;
    end_seconds: number;
    duration_seconds: number;
  }>;
};

export type ProjectAsset = {
  id: string;
  artifact_id: string;
  /** Free-text display label, present only when the artifact has one. */
  label?: string;
  type: string;
  created_at: string;
  path: string;
  media_url: string | null;
  thumbnail_url: string | null;
  object_hash: string | null;
  status: string;
  /** New (cutover step 7): durable status from the assets table. UI should
   *  prefer assetWork.status + assetWork.meta when present; the legacy
   *  `status` string remains for back-compat with older clients. */
  assetWork: AssetWorkProjection | null;
  width: number | null;
  height: number | null;
  origin: string | null;
  prompt: string | null;
  renders: string[];
  duration: number | null;
  fps: number | null;
  audio_info: {
    codec: string;
    sample_rate_hz: number;
    channels: number;
    channel_layout: string;
    duration_seconds: number;
  } | null;
  analysis_info: ProjectAssetAnalysis | null;
  /** Engine-owned tag state: effective tags, provenance and the analysis
   *  that produced the automatic ones. Null for synthetic notebook rows,
   *  which are not artifacts and cannot be tagged. */
  tags: AssetTagSummary | null;
  /** Video/audio assets only: ElevenLabs and gpt-4o sources side by side, or
   *  null when neither sidecar exists. Compact summaries only — no raw JSON. */
  transcript: AssetTranscriptSources | null;
  /** Video assets only: compact vision analysis from `.original.analysis.json`,
   *  or null when the asset has not been analyzed yet. */
  vision_analysis: VideoAnalysisSummary | null;
  waveform: number[] | null;
  frame_dirs: Record<string, string[]>;
  archive_id: string | null;
  archived_at: string | null;
  /** Unix seconds when user first viewed this asset, or null if still unseen.
   *  Drives the sidebar's NEW badge. */
  seen_at: number | null;
  /** Character assets only: whether an ElevenLabs voice is assigned. Lets the
   *  client flag voiceless hosts before attempting a Clip Show plan. Null for
   *  non-character assets. */
  has_voice: boolean | null;
  /** Video/final assets only: a compact summary of the configured on-screen
   *  graphic overlay, read from `.render` metadata. Drives the OSG badge on
   *  clip cards and timeline slots. Null when no OSG is set. */
  osg: OsgSummary | null;
};

type OsgSummary = {
  assetId: string;
  position: string;
  size: string;
  scale: number;
  opacity: number;
  startSeconds: number | null;
  endSeconds: number | null;
};

function analysisInfoFromMetadata(
  metadata: Record<string, unknown> | null,
): ProjectAssetAnalysis | null {
  const value = metadata?.analysisInfo;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sourceDurationSeconds = record.sourceDurationSeconds;
  if (
    typeof sourceDurationSeconds !== "number"
    || !Number.isFinite(sourceDurationSeconds)
    || !Array.isArray(record.shots)
  ) {
    return null;
  }
  const shots = record.shots.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const shot = value as Record<string, unknown>;
    if (
      typeof shot.ordinal !== "number"
      || typeof shot.label !== "string"
      || typeof shot.startSeconds !== "number"
      || typeof shot.endSeconds !== "number"
      || typeof shot.durationSeconds !== "number"
    ) {
      return [];
    }
    return [{
      ordinal: shot.ordinal,
      label: shot.label,
      start_seconds: shot.startSeconds,
      end_seconds: shot.endSeconds,
      duration_seconds: shot.durationSeconds,
    }];
  });
  return {
    source_duration_seconds: sourceDurationSeconds,
    output_json: null,
    output_url: null,
    llm_exchanges: [],
    shots,
  };
}

async function analysisOutputProjection(
  engine: Engine,
  artifactId: string,
): Promise<{
  outputJson: unknown;
  llmExchanges: ProjectAssetAnalysis["llm_exchanges"];
} | null> {
  const read = await engine.files.read(artifactId, "analysis.json");
  if (!read.ok) return null;
  try {
    const outputJson = JSON.parse(read.value.toString()) as unknown;
    if (
      typeof outputJson !== "object"
      || outputJson === null
      || Array.isArray(outputJson)
    ) {
      return { outputJson, llmExchanges: [] };
    }
    const output = outputJson as Record<string, unknown>;
    const exchanges = Array.isArray(output.llmExchanges)
      ? output.llmExchanges.flatMap((value) => {
          if (
            typeof value !== "object"
            || value === null
            || Array.isArray(value)
          ) {
            return [];
          }
          const exchange = value as Record<string, unknown>;
          const input = typeof exchange.input === "object"
            && exchange.input !== null
            && !Array.isArray(exchange.input)
            ? exchange.input as Record<string, unknown>
            : null;
          const provider = typeof exchange.provider === "string"
            ? exchange.provider
            : null;
          const model = typeof exchange.model === "string"
            ? exchange.model
            : typeof input?.model === "string"
              ? input.model
              : null;
          const stage = typeof exchange.stage === "string"
            ? exchange.stage
            : null;
          const text = input
            && typeof input.text === "object"
            && input.text !== null
            && !Array.isArray(input.text)
            ? input.text as Record<string, unknown>
            : null;
          const format = text
            && typeof text.format === "object"
            && text.format !== null
            && !Array.isArray(text.format)
            ? text.format as Record<string, unknown>
            : null;
          const formatType = typeof format?.type === "string"
            ? format.type
            : null;
          const responseFormat = formatType
            ? {
                type: formatType,
                name: typeof format?.name === "string" ? format.name : null,
                strict: format?.strict === true,
              }
            : null;
          return provider && model && stage
            ? [{
                provider,
                model,
                stage,
                response_format: responseFormat,
              }]
            : [];
        })
      : [];
    const compactOutput = { ...output };
    delete compactOutput.llmExchanges;
    return {
      outputJson: compactOutput,
      llmExchanges: exchanges,
    };
  } catch {
    return null;
  }
}

/** Read the OSG overlay summary from the asset's render metadata. OSG is stored
 *  identically across orientations, so the first orientation that carries an
 *  osgAssetId wins. Returns null when no overlay is configured. */
async function readOsgSummary(
  engine: Engine,
  assetId: string,
): Promise<OsgSummary | null> {
  for (const orient of RENDER_ORIENTATIONS) {
    const meta = await engine.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orient}.render`);
    if (!meta.ok) continue;
    const osgAssetId = meta.value.osgAssetId;
    if (typeof osgAssetId !== "string" || !osgAssetId) continue;
    return {
      assetId: osgAssetId,
      position: typeof meta.value.osgPosition === "string" ? meta.value.osgPosition : "top-right",
      size: typeof meta.value.osgSize === "string" ? meta.value.osgSize : "medium",
      scale: typeof meta.value.osgScale === "number" ? meta.value.osgScale : 1,
      opacity: typeof meta.value.osgOpacity === "number" ? meta.value.osgOpacity : 1,
      startSeconds: typeof meta.value.osgStartSeconds === "number" ? meta.value.osgStartSeconds : null,
      endSeconds: typeof meta.value.osgEndSeconds === "number" ? meta.value.osgEndSeconds : null,
    };
  }
  return null;
}

type ArchiveMetadata = {
  archive_id?: unknown;
  archived_at?: unknown;
};

type ReconcileProjectWorkResult = {
  pending: Array<{ assetId: string; taskType: string; progress: number; state: string; prompt: string | null; startedAt: number | null }>;
  completed: Array<{ assetId: string; taskType: string; jobId: string }>;
  failed: Array<{ assetId: string; taskType: string; failMsg: string; failedAt: string; prompt: string | null }>;
  external_uploads: Array<{ assetId: string; mediaFilename: string }>;
  auto_transcribe: Array<{ assetId: string; jobId: string }>;
  auto_plain_transcript: Array<{ assetId: string; jobId: string }>;
};

function metaPrompt(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  const p = meta.prompt;
  return typeof p === "string" ? p : null;
}

function isVeoPendingTask(task: PendingTask): boolean {
  return typeof task.meta?.veoModel === "string";
}

function isKiePendingTask(task: PendingTask): boolean {
  if (isVeoPendingTask(task)) return false;
  const model = task.meta?.model;
  if (typeof model === "string" && model.includes(":") && parseModelId(model)?.provider !== "kie") return false;
  return task.taskType === "media_kie" || task.taskType === "isolate_vocals"
    || (legacyMediaForTaskType(task.taskType) !== null && !/^(?:xai|fal|alibaba)_/u.test(task.taskType));
}

function isQueuedKiePendingTask(task: PendingTask): boolean {
  return task.taskId === QUEUED_TASK_ID && isKiePendingTask(task);
}

/** failCode "500" is kie's transient internal error ("please try again
 *  later"). It's only worth leaving the task pending for a re-poll while the
 *  job is still in flight — once kie stamps a `completeTime`, the task record
 *  is final and re-polling the same taskId can never flip to success. Treating
 *  a completed 500 as transient strands the asset in "working" until the 30m
 *  reconciliation timeout (PENDING_TASK_TIMEOUT_MS) and buries the real failure message,
 *  so only a 500 with no completeTime is considered retryable. */
export function isTransientKieFailure(data: KieTaskInfoData): boolean {
  if (data.failCode !== "500") return false;
  return !(typeof data.completeTime === "number" && data.completeTime > 0);
}

function buildFrameDirs(
  directories: Record<string, string[]> | undefined,
  bookId: string,
  assetId: string,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!directories) return out;
  for (const [dir, fileList] of Object.entries(directories)) {
    if (!dir.endsWith("_frames")) continue;
    out[dir] = fileList
      .filter((f) => f.endsWith(".jpg"))
      .sort()
      .map((f) => `/files/${bookId}/${assetId}/${dir}/${f}`);
  }
  return out;
}

const WAVEFORM_SOURCE_RE = /^original\.(mp4|mov|mp3|wav|m4a|aac|ogg|flac)$/i;

async function readWaveformOrSchedule(
  engine: Engine,
  assetId: string,
  bookId: string,
  videoFilename: string | null,
): Promise<number[] | null> {
  if (!videoFilename || !WAVEFORM_SOURCE_RE.test(videoFilename)) {
    return null;
  }
  const existing = await engine.metadata.waveforms.read(assetId);
  if (existing.ok) {
    // Empty peaks are a negative-cache marker ("extracted, nothing usable"):
    // surface them as no-waveform so the UI is unchanged, but don't re-extract.
    return existing.value.peaks.length > 0 ? existing.value.peaks : null;
  }
  // Waveform extraction shells out to ffmpeg and can take several seconds for
  // long videos, so it must never run inline in list_assets / reconcile_project_work. Hand it to
  // the job queue (deduped per asset) and return no-waveform now; the UI fills
  // it in on a later poll once the background job has persisted the peaks.
  scheduleWaveformExtraction(bookId, assetId, videoFilename);
  return null;
}

function scheduleWaveformExtraction(
  bookId: string,
  assetId: string,
  videoFilename: string,
): void {
  const jobId = `extract-waveform-${bookId}-${assetId}`;
  void queue
    .enqueue(jobId, {
      type: "extract_waveform",
      bookId,
      waveformAssetId: assetId,
      videoFilename,
    })
    .catch((err) => {
      logger.error("waveform-enqueue-failed", { assetId, error: err });
    });
}


/** Media extensions whose duration can be recovered via ffprobe when metadata lacks it. */

export const RENDER_ORIENTATIONS = MEDIA_RENDER_ORIENTATIONS;

export async function readRenderSettings(
  engine: Engine, assetId: string, orientations: string[],
): Promise<Record<string, Record<string, unknown>>> {
  const result: Record<string, Record<string, unknown>> = {};
  await Promise.all(orientations.map(async (orient) => {
    const meta = await engine.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orient}.render`);
    if (meta.ok) result[orient] = meta.value;
  }));
  return result;
}

const BASE_DEFAULTS: Record<string, unknown> = {
  subtitlesEnabled: false,
  subtitleLanguage: "original",
  position: "bottom",
  fontSize: "medium",
  audioFadeIn: 0,
  audioFadeOut: 0,
  audioVolume: 100,
  osgImagePath: null,
  osgAssetId: null,
  osgPosition: "top-right",
  osgSize: "medium",
  osgScale: 1,
  osgOpacity: 1,
  osgStartSeconds: null,
  osgEndSeconds: null,
  osgTailSeconds: null,
  keywordGraphicsEnabled: false,
  keywordGraphicsMaxCount: DEFAULT_KEYWORD_GRAPHICS_MAX_COUNT,
  keywordGraphicsLingerSeconds: DEFAULT_KEYWORD_GRAPHICS_LINGER_SECONDS,
  keywordGraphicsKeywords: null,
  backgroundMode: "blur",
  strokeWidth: 6,
  strokeColor: "#000000",
  shadowBlur: 6,
  shadowOpacity: 60,
};

const ORIENTATION_OVERRIDES: Record<string, Record<string, unknown>> = {
  portrait: {
    highlightStyle: "impact",
    textColor: "#FFFFFF",
    highlightColor: "#FFFF00",
  },
  landscape: {
    highlightStyle: "highlight",
    textColor: "#FFFFFF",
    highlightColor: "#991B1B",
  },
  square: {
    highlightStyle: "highlight",
    textColor: "#FFFFFF",
    highlightColor: "#991B1B",
  },
};

export async function readStoredRenderDefaults(
  engine: Engine,
  assetId: string,
  targetOrientation: string,
): Promise<Record<string, unknown>> {
  const defaults = { ...BASE_DEFAULTS, ...(ORIENTATION_OVERRIDES[targetOrientation] ?? ORIENTATION_OVERRIDES.landscape) };
  // Read every orientation's render metadata in parallel, then pick the
  // target's own metadata first or fall back to any other orientation.
  const tryOrder = [targetOrientation, ...RENDER_ORIENTATIONS.filter((o) => o !== targetOrientation)];
  const metas = await Promise.all(
    tryOrder.map((orient) =>
      engine.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orient}.render`),
    ),
  );
  for (const meta of metas) {
    if (meta.ok) return { ...defaults, ...meta.value };
  }
  const recs = await readAnalysisRecommendations(engine, assetId);
  return { ...defaults, ...recs };
}

const VALID_SUB_POSITIONS = new Set(["top", "middle", "bottom"]);
const VALID_OSG_POSITIONS = new Set([
  "top-left", "top-center", "top-right",
  "middle-left", "middle-center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
]);

async function readAnalysisRecommendations(
  engine: Engine,
  assetId: string,
): Promise<Record<string, unknown>> {
  const result = await engine.files.read(assetId, ".original.analysis.json");
  if (!result.ok) return {};
  try {
    const raw = typeof result.value === "string"
      ? result.value
      : new TextDecoder().decode(result.value);
    const analysis = JSON.parse(raw) as Record<string, unknown>;
    const recs: Record<string, unknown> = {};

    const subPos = analysis.recommendedSubtitlePosition;
    if (typeof subPos === "string" && VALID_SUB_POSITIONS.has(subPos)) {
      recs.position = subPos;
    }

    const osgPos = analysis.recommendedOsgPosition;
    if (typeof osgPos === "string" && VALID_OSG_POSITIONS.has(osgPos)) {
      recs.osgPosition = osgPos;
    }

    return recs;
  } catch {
    return {};
  }
}

function renderedOrientationsFor(
  files: ArtifactManifestFile[],
  kind: ArtifactKind,
): string[] {
  const fileSet = new Set(files.map((f) => f.name));
  if (kind === "final") {
    return RENDER_ORIENTATIONS.filter((o) => fileSet.has(`timeline_${o}.mp4`));
  }
  return RENDER_ORIENTATIONS.filter((o) => fileSet.has(`${o}.mp4`));
}

export async function buildAssetList(engine: Engine, book_id: string, sort?: "newest" | "oldest"): Promise<ProjectAsset[]> {
  const assets = engine.artifacts.list({ ...(sort ? { sort } : {}) });
  const pendingAll = engine.jobs.pending.findAll();
  const failuresAll = engine.jobs.failures.findAll();
  const workAll = engine.jobs.artifactWork.list();
  const streamsAll = engine.streams.list();
  const pendingByArtifact = indexByArtifactId(pendingAll.ok ? pendingAll.value : []);
  const failuresByArtifact = indexByArtifactId(failuresAll.ok ? failuresAll.value : []);
  const workByArtifact = indexByArtifactId(workAll.ok ? workAll.value : []);
  const streamsByArtifact = groupByArtifactId(streamsAll.ok ? streamsAll.value : []);
  const tagsByArtifact = readAssetTagSummaries(
    engine,
    assets.map((asset) => asset.artifactId),
  );
  const assetRows = await Promise.all(
    assets.map(async (a): Promise<ProjectAsset> => {
      const [manifestResult, metadata, archiveMetadata, proxyMetadata] = await Promise.all([
        engine.files.manifest(a.artifactId, { includeDotfiles: true }),
        engine.metadata.artifacts.read<Record<string, unknown>>(a.artifactId, "original"),
        engine.metadata.artifacts.read<ArchiveMetadata>(a.artifactId, "archive"),
        a.kind === "video"
          ? engine.metadata.artifacts.read<VideoProxyAssessment>(a.artifactId, "proxy")
          : Promise.resolve({
              ok: false as const,
              error: { code: "NOT_FOUND" as const, message: "not a video" },
            }),
      ]);
      const lockData = engine.jobs.locks.get(a.path);
      const pendingTask = {
        ok: true as const,
        value: pendingByArtifact.get(a.artifactId) ?? null,
      };
      const generationError = {
        ok: true as const,
        value: failuresByArtifact.get(a.artifactId) ?? null,
      };
      const assetWorkRow = {
        ok: true as const,
        value: workByArtifact.get(a.artifactId) ?? null,
      };

      // If the asset directory disappeared between listAssets and getManifest,
      // surface an empty-but-error placeholder rather than throwing.
      const files: ArtifactManifestFile[] = manifestResult.ok ? manifestResult.value.files : [];
      const directories = manifestResult.ok ? manifestResult.value.directories : undefined;

      const mediaFile = findAssetMediaFile(files, a);
      const meta = metadata.ok ? metadata.value : null;
      const streams = streamsByArtifact.get(a.artifactId) ?? [];
      const profile = assetStreamProfile(streams, meta);
      const { audioStream, frameRate } = profile;
      const fileNames = new Set(files.map((f) => f.name));
      const renders = renderedOrientationsFor(files, a.kind);
      const hasPartFile = files.some((f) => PARTIAL_DOWNLOAD_RE.test(f.name));
      const frameDirs = buildFrameDirs(directories, book_id, a.artifactId);
      // Spoken-media assets: ship the transcript so the inspector can show a
      // copiable transcript (and offer Transcribe when there is none) without a
      // second round trip. One small sidecar read per eligible asset; word-timed
      // transcripts resolve from the object-hash memo on repeat listings.
      const hasTranscriptSidecar = files.some((file) =>
        file.name === TIMED_TRANSCRIPT_FILE || file.name === PLAIN_TRANSCRIPT_FILE);
      const [transcript, vision_analysis] = await Promise.all([
        hasSpokenAudio(a.kind) && hasTranscriptSidecar
          ? readAssetTranscriptSources(engine, a.artifactId, files)
          : Promise.resolve(null),
        isAnalyzableVideo(a.kind) && fileNames.has(VIDEO_ANALYSIS_FILE)
          ? readVideoAnalysisSummary(engine, a.artifactId)
          : Promise.resolve(null),
      ]);
      const waveform = await readWaveformOrSchedule(
        engine,
        a.artifactId,
        book_id,
        mediaFile?.name ?? null,
      );

      const proxyFile = servedVideoProxyFile({
        bookId: book_id,
        artifact: a,
        files,
        mediaFile,
        proxyMetadata,
        work: assetWorkRow.value,
        sourceProfile: profile.sourceProfile,
      });
      const { media_url, thumbnail_url } = assetMediaUrls({
        bookId: book_id,
        artifact: a,
        files,
        mediaFile,
        proxyFile,
      });

      // Status derivation lives in videobook-engine (`computeArtifactStatus`). We pass
      // the asset-type-aware primary media name we already computed so the
      // engine doesn't have to redo media-type heuristics.
      const status = computeArtifactStatus({
        kind: a.kind,
        fileNames,
        primaryMediaName: mediaFile?.name ?? null,
        hasOriginalMetadata: metadata.ok,
        hasPartFile,
        lockData,
        pendingTask: pendingTask.ok ? pendingTask.value : null,
        generationError: generationError.ok ? generationError.value : null,
        artifactRow:
          assetWorkRow.ok && assetWorkRow.value
            ? {
                status: assetWorkRow.value.status,
                meta: assetWorkRow.value.meta,
                deadlineAt: assetWorkRow.value.deadlineAt,
              }
            : null,
      });

      await scheduleMissingVideoPoster(engine, {
        bookId: book_id,
        artifact: a,
        files,
        mediaFile,
        status,
      });

      const archiveMeta = archiveMetadata.ok ? archiveMetadata.value : null;
      const analysisInfo = analysisInfoFromMetadata(meta);
      if (analysisInfo && fileNames.has("analysis.json")) {
        const output = await analysisOutputProjection(engine, a.artifactId);
        if (output) {
          analysisInfo.output_json = output.outputJson;
          analysisInfo.output_url =
            `/files/${book_id}/${a.artifactId}/analysis.json`;
          analysisInfo.llm_exchanges = output.llmExchanges;
        }
      }

      const duration = assetDuration({
        bookId: book_id,
        artifactId: a.artifactId,
        meta,
        mediaFile,
        profile,
      });
      const audio_info = audioStream?.audio
        ? {
            codec: audioStream.codec,
            sample_rate_hz: audioStream.audio.sampleRateHz,
            channels: audioStream.audio.channels,
            channel_layout: audioStream.audio.channelLayout,
            duration_seconds:
              audioStream.durationTicks
              * audioStream.timeBase.numerator
              / audioStream.timeBase.denominator,
          }
        : null;

      // Character assets: surface whether an ElevenLabs voice is assigned, so the
      // client can flag voiceless hosts before a Clip Show plan is attempted.
      const has_voice: boolean | null = null;

      // Video/final assets: surface the configured OSG overlay so the client can
      // render its badge on clip cards and timeline slots without a per-asset
      // settings fetch. Bounded to one metadata read per OSG-eligible asset.
      const osg = (a.kind === "video" || a.kind === "final")
        ? await readOsgSummary(engine, a.artifactId)
        : null;

      // Read script content from its canonical artifact file.
      let prompt = (meta?.prompt as string) ?? null;
      if (!prompt && a.kind === "script" && fileNames.has("original.md")) {
        const md = await engine.files.read(a.artifactId, "original.md");
        if (md.ok) prompt = md.value.toString();
      }

      const assetWork: AssetWorkProjection | null =
        assetWorkRow.ok && assetWorkRow.value
          ? {
              status: assetWorkRow.value.status,
              meta: assetWorkRow.value.meta as AssetWorkProjection["meta"],
              ownerKind: assetWorkRow.value.ownerKind,
              deadlineAt: assetWorkRow.value.deadlineAt,
            }
          : null;

      return {
        id: a.artifactId,
        artifact_id: a.artifactId,
        ...(a.label ? { label: a.label } : {}),
        type: a.kind,
        created_at: new Date(a.createdAt).toISOString(),
        path: a.path,
        media_url,
        thumbnail_url,
        object_hash: mediaFile?.objectHash ?? null,
        status,
        assetWork,
        width: (meta?.width as number) ?? null,
        height: (meta?.height as number) ?? null,
        origin: (meta?.origin as string) ?? null,
        prompt,
        renders,
        duration,
        fps: (() => {
          const metadataFps = Number(meta?.fps);
          if (Number.isFinite(metadataFps) && metadataFps > 0) return metadataFps;
          if (frameRate && frameRate.denominator > 0) {
            const streamFps = frameRate.numerator / frameRate.denominator;
            return Number.isFinite(streamFps) && streamFps > 0 ? streamFps : null;
          }
          return null;
        })(),
        audio_info,
        analysis_info: analysisInfo,
        tags: tagsByArtifact.get(a.artifactId) ?? EMPTY_TAG_SUMMARY,
        transcript,
        vision_analysis,
        waveform,
        frame_dirs: frameDirs,
        archive_id: typeof archiveMeta?.archive_id === "string" ? archiveMeta.archive_id : null,
        archived_at: typeof archiveMeta?.archived_at === "string" ? archiveMeta.archived_at : null,
        seen_at: assetWorkRow.ok && assetWorkRow.value ? assetWorkRow.value.seenAt : null,
        has_voice,
        osg,
      };
    }),
  );
  const notebookRows: ProjectAsset[] = engine.notebooks
    .list()
    .map((notebook) => ({
      id: notebook.id,
      artifact_id: notebook.id,
      label: notebook.name,
      type: "notebook",
      created_at: notebook.createdAt,
      path: `notebook:${notebook.id}`,
      media_url: null,
      thumbnail_url: null,
      object_hash: null,
      status: "ready",
      assetWork: null,
      width: null,
      height: null,
      origin: "notebook",
      prompt:
        typeof notebook.description === "string"
          ? notebook.description
          : notebook.name,
      renders: [],
      duration: null,
      fps: null,
      audio_info: null,
      analysis_info: null,
      tags: null,
      transcript: null,
      vision_analysis: null,
      waveform: null,
      frame_dirs: {},
      archive_id: null,
      archived_at: null,
      seen_at: null,
      has_voice: null,
      osg: null,
    }));
  const direction = sort === "oldest" ? 1 : -1;
  return [...assetRows, ...notebookRows].sort(
    (left, right) =>
      direction *
      (Date.parse(left.created_at) - Date.parse(right.created_at)),
  );
}

type ProviderPollResult = {
  pending: ReconcileProjectWorkResult["pending"];
  completed: ReconcileProjectWorkResult["completed"];
  failed: ReconcileProjectWorkResult["failed"];
};

type PollPendingProviderTasksOptions = {
  /** Override age-out timeout (default PENDING_TASK_TIMEOUT_MS). Injectable for tests. */
  timeoutMs?: number;
  /** Override "now" for deterministic age-out in tests. */
  nowMs?: number;
  /** Abort in-flight provider polls without mutating remaining durable tasks. */
  signal?: AbortSignal;
  /** Point KIE recordInfo at a local server. Production polls use the provider default. */
  kieBaseURL?: string;
  /** Point FAL queue status/result at a local server. Production polls use the provider default. */
  falQueueBaseURL?: string;
  machgenBaseURL?: string;
};

const MACHGEN_RETRYABLE_STATUSES = new Set([408, 429, 499]);

function machgenPollFailureIsFinal(error: unknown): boolean {
  if (!(error instanceof MachGenError)) return false;
  const status = (error as MachGenError).status;
  return status >= 400 && status < 500 && !MACHGEN_RETRYABLE_STATUSES.has(status);
}

async function processMachGenTaskStatus(
  engine: Engine,
  task: PendingTask,
  status: MachGenTaskStatusResponse,
  result: ProviderPollResult,
  bookId: string,
): Promise<void> {
  const prompt = metaPrompt(task.meta);
  if (status.status === "FAILED") {
    const failMsg = status.error_msg || "MachGen task failed";
    result.failed.push({ assetId: task.artifactId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
    await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: failMsg, prompt });
    return;
  }
  if (status.status !== "COMPLETED") {
    result.pending.push({
      assetId: task.artifactId,
      taskType: task.taskType,
      progress: 0,
      state: status.status.toLowerCase(),
      prompt,
      startedAt: task.createdAt,
    });
    return;
  }
  const assetDirResult = await engine.workspaces.resolveArtifact(task.artifactId);
  if (!assetDirResult.ok) {
    await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: `Asset not found: ${task.artifactId}`, prompt });
    return;
  }
  await engine.jobs.pending.markCompleting(task.artifactId);
  const jobId = `complete-machgen-${task.artifactId}-${Date.now()}`;
  const video = status.task_output?.video;
  await queue.enqueue(jobId, {
    type: "complete_kie_task",
    taskId: task.taskId,
    taskType: task.taskType,
    assetId: task.artifactId,
    assetDir: assetDirResult.value,
    bookId,
    meta: task.meta,
    resultUrls: typeof video === "string" && video ? [video] : [],
  } as unknown as Record<string, unknown>);
  result.completed.push({ assetId: task.artifactId, taskType: task.taskType, jobId });
}

function withProviderTaskContext<T>(engine: Engine, bookId: string, task: PendingTask, operation: () => Promise<T>): Promise<T> {
  return withBookContext({ bookId, engine, operation: "poll_pending_provider_tasks", artifactId: task.artifactId,
    providerTaskId: task.taskId, attemptId: typeof task.meta.attemptId === "string" ? task.meta.attemptId : task.artifactId,
    runId: typeof task.meta.runId === "string" ? task.meta.runId : undefined,
    model: typeof task.meta.model === "string" ? task.meta.model : undefined }, operation);
}

async function pollMachGenTasks(
  engine: Engine,
  tasks: readonly PendingTask[],
  result: ProviderPollResult,
  bookId: string,
  baseURL: string | undefined,
): Promise<void> {
  const machgenTasks = tasks.filter((task) => task.taskType === MEDIA_TASK_TYPES.machgen);
  if (!getApiKey("MACHGEN_API_KEY") || machgenTasks.length === 0) return;
  const provider = machgenProvider(30_000, baseURL);
  await Promise.all(machgenTasks.map(async (task) => withProviderTaskContext(engine, bookId, task, async () => {
    try {
      await processMachGenTaskStatus(engine, task, await provider.api.v0.tasks(task.taskId), result, bookId);
    } catch (error) {
      const failMsg = error instanceof Error ? error.message : "Poll failed";
      const prompt = metaPrompt(task.meta);
      result.failed.push({ assetId: task.artifactId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
      if (machgenPollFailureIsFinal(error)) await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: failMsg, prompt });
    }
  })));
}

/**
 * Poll provider-pending tasks: submit queued KIE rows, age out stale tasks,
 * and poll kie/veo/xai/alibaba/fal/machgen recordInfo lanes that mark
 * completing + enqueue complete_kie_task. Does NOT process external uploads,
 * auto-render, or auto-transcribe.
 */
export async function pollPendingProviderTasks(
  engine: Engine,
  book_id: string,
  options: PollPendingProviderTasksOptions = {},
): Promise<ProviderPollResult> {
  if (currentBookContext()?.operation !== "poll_pending_provider_tasks") {
    return withBookContext(
      { bookId: book_id, engine, operation: "poll_pending_provider_tasks" },
      () => pollPendingProviderTasks(engine, book_id, options),
    );
  }
  await settleFinishedUsage(engine);
  const result: ProviderPollResult = {
    pending: [],
    completed: [],
    failed: [],
  };

  if (options.signal?.aborted) return result;

  const tasksRes = await engine.jobs.pending.findAll();
  const tasks: PendingTask[] = tasksRes.ok ? tasksRes.value : [];
  if (tasks.length === 0) return result;
  const kieBaseURL = options.kieBaseURL ?? providerEndpoints().kieBaseURL;
  const falQueueBaseURL = options.falQueueBaseURL ?? providerEndpoints().falQueueBaseURL;

  // Age out any non-completing task older than timeout so it
  // stops showing as pending forever. Completing tasks are skipped because the
  // completion job is already dispatched; recoverAssetsTable handles that lane
  // on server restart by clearing the completing flag and refreshing owner_id.
  const timeoutMs = options.timeoutMs ?? PENDING_TASK_TIMEOUT_MS;
  const nowMs = options.nowMs ?? Date.now();
  const activeTasks: PendingTask[] = [];
  const expiredTasks: PendingTask[] = [];
  for (const originalTask of tasks) {
    let t = originalTask;
    if (isQueuedKiePendingTask(t)) {
      try {
        t = await withBookContext(
          { bookId: book_id, engine, operation: "submit_queued_kie_task", artifactId: t.artifactId },
          () => submitQueuedKieTask(engine, t),
        );
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Queued KIE submit failed";
        const prompt = metaPrompt(t.meta);
        result.failed.push({ assetId: t.artifactId, taskType: t.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        await failPendingTaskAndLog(engine, t.artifactId, t.taskId, { message: failMsg, prompt });
        continue;
      }
    }
    const ageMs = nowMs - t.createdAt;
    if (t.completing !== true && Number.isFinite(ageMs) && ageMs > timeoutMs) {
      expiredTasks.push(t);
    }
    activeTasks.push(t);
  }

  // Completing tasks — reconciliation already enqueued a completion job for these on a
  // prior poll. Skip polling + re-enqueueing so duplicate completion jobs
  // don't race on the asset-directory lock. Report as pending with state
  // "success" so the inbox tile shows the DOWNLOAD/PROCESS phase.
  const completingTasks = activeTasks.filter((t) => t.completing === true);
  for (const t of completingTasks) {
    result.pending.push({ assetId: t.artifactId, taskType: t.taskType, progress: 100, state: "success", prompt: metaPrompt(t.meta), startedAt: t.createdAt });
  }

  const pollableTasks = activeTasks.filter((t) => t.completing !== true);
  if (options.signal?.aborted) return result;

  await Promise.all(
    pollableTasks.map(async (task) => {
      const ownerId = await engine.jobs.pending.getOwner(task.artifactId, task.taskId);
      if (ownerId) {
        await engine.jobs.artifactWork.renew(task.artifactId, ownerId, 30 * 60_000);
      }
    }),
  );

  // Poll KIE tasks (only if API key is set)
  const kieTasks = pollableTasks.filter(isKiePendingTask);
  const kieApiKey = getApiKey("KIE_API_KEY");
  if (kieApiKey && kieTasks.length > 0) {
    const provider = createKie({
      apiKey: kieApiKey,
      timeout: 30_000,
      ...(kieBaseURL ? { baseURL: kieBaseURL } : {}),
    });

    await Promise.all(kieTasks.map(async (task) => withProviderTaskContext(engine, book_id, task, async () => {
      try {
        const taskInfo = await provider.get.api.v1.jobs.recordInfo(task.taskId);
        await processKieTaskResult(engine, task, taskInfo, result, book_id);
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Poll failed";
        const prompt = metaPrompt(task.meta);
        result.failed.push({ assetId: task.artifactId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof KieError) {
          // TS narrowing on `e` is unreliable here, use an explicit assertion.
          const kieErr = e as KieError;
          if (kieErr.status >= 400 && kieErr.status < 500) {
            await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: failMsg, prompt });
          }
        }
      }
    })));
  }

  // Poll KIE Veo tasks (separate namespace: kie.veo.get.api.v1.veo.recordInfo)
  const veoTasks = pollableTasks.filter(isVeoPendingTask);
  if (kieApiKey && veoTasks.length > 0) {
    const provider = createKie({
      apiKey: kieApiKey,
      timeout: 30_000,
      ...(kieBaseURL ? { baseURL: kieBaseURL } : {}),
    });

    await Promise.all(veoTasks.map(async (task) => withProviderTaskContext(engine, book_id, task, async () => {
      const prompt = metaPrompt(task.meta);
      try {
        const recordInfo = await provider.veo.get.api.v1.veo.recordInfo(task.taskId);
        const data = recordInfo.data;
        // Veo successFlag: 0=generating, 1=success, 2=task creation failed, 3=generation failed
        if (data?.successFlag === 1) {
          const urls = data.response?.resultUrls ?? [];
          if (urls.length === 0) {
            const failMsg = "Veo task succeeded but returned no resultUrls";
            result.failed.push({ assetId: task.artifactId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
            await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: failMsg, prompt });
            return;
          }
          const assetDirResult = await engine.workspaces.resolveArtifact(task.artifactId);
          if (!assetDirResult.ok) {
            await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: `Asset not found: ${task.artifactId}`, prompt });
            return;
          }
          await engine.jobs.pending.markCompleting(task.artifactId);
          const jobId = `complete-veo-${task.artifactId}-${Date.now()}`;
          await queue.enqueue(jobId, {
            type: "complete_kie_task",
            taskId: task.taskId,
            taskType: task.taskType,
            assetId: task.artifactId,
            assetDir: assetDirResult.value,
            bookId: book_id,
            meta: task.meta,
            resultUrls: urls,
          } as unknown as Record<string, unknown>);
          result.completed.push({ assetId: task.artifactId, taskType: task.taskType, jobId });
        } else if (data?.successFlag === 2 || data?.successFlag === 3) {
          const failMsg = data.errorMessage ?? "Veo task failed";
          result.failed.push({ assetId: task.artifactId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
          await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: failMsg, prompt });
        } else {
          result.pending.push({
            assetId: task.artifactId,
            taskType: task.taskType,
            progress: 0,
            state: "waiting",
            prompt,
            startedAt: task.createdAt,
          });
        }
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Veo poll failed";
        result.failed.push({ assetId: task.artifactId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof KieError) {
          const kieErr = e as KieError;
          if (kieErr.status >= 400 && kieErr.status < 500) {
            await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: failMsg, prompt });
          }
        }
      }
    })));
  }

  // Poll xAI tasks (only if API key is set)
  const xaiTasks = pollableTasks.filter((t) => t.taskType.startsWith("xai_"));
  if (process.env.XAI_API_KEY && xaiTasks.length > 0) {
    const provider = createXai({ apiKey: process.env.XAI_API_KEY, timeout: 30_000 });

    await Promise.all(xaiTasks.map(async (task) => withProviderTaskContext(engine, book_id, task, async () => {
      const prompt = metaPrompt(task.meta);
      try {
        const videoResult = await provider.get.v1.videos(task.taskId);
        if (videoResult.status === "done" && videoResult.video?.url) {
          const assetDirResult = await engine.workspaces.resolveArtifact(task.artifactId);
          if (!assetDirResult.ok) {
            await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: `Asset not found: ${task.artifactId}`, prompt });
            return;
          }
          await engine.jobs.pending.markCompleting(task.artifactId);
          const jobId = `complete-xai-${task.artifactId}-${Date.now()}`;
          await queue.enqueue(jobId, {
            type: "complete_kie_task",
            taskId: task.taskId,
            taskType: task.taskType,
            assetId: task.artifactId,
            assetDir: assetDirResult.value,
            bookId: book_id,
            meta: task.meta,
            resultUrls: [videoResult.video.url],
          } as unknown as Record<string, unknown>);
          result.completed.push({ assetId: task.artifactId, taskType: task.taskType, jobId });
        } else if (videoResult.status === "failed" || videoResult.status === "expired") {
          const failMsg = `xAI task ${videoResult.status}`;
          result.failed.push({ assetId: task.artifactId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
          await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: failMsg, prompt });
        } else {
          result.pending.push({
            assetId: task.artifactId,
            taskType: task.taskType,
            progress: videoResult.progress ?? 0,
            state: videoResult.status,
            prompt,
            startedAt: task.createdAt,
          });
        }
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Poll failed";
        result.failed.push({ assetId: task.artifactId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof XaiError) {
          const xaiErr = e as XaiError;
          if (xaiErr.status >= 400 && xaiErr.status < 500) {
            await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: failMsg, prompt });
          }
        }
      }
    })));
  }

  // Poll Alibaba tasks (only if API key is set)
  const alibabaTasks = pollableTasks.filter((t) => t.taskType.startsWith("alibaba_"));
  if (process.env.DASHSCOPE_API_KEY && alibabaTasks.length > 0) {
    const provider = createAlibaba({ apiKey: process.env.DASHSCOPE_API_KEY, timeout: 30_000 });

    await Promise.all(alibabaTasks.map(async (task) => withProviderTaskContext(engine, book_id, task, async () => {
      const prompt = metaPrompt(task.meta);
      try {
        const taskStatus = await provider.get.api.v1.tasks(task.taskId);
        const status = taskStatus.output.task_status;

        if (status === "SUCCEEDED") {
          const assetDirResult = await engine.workspaces.resolveArtifact(task.artifactId);
          if (!assetDirResult.ok) {
            await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: `Asset not found: ${task.artifactId}`, prompt });
            return;
          }
          await engine.jobs.pending.markCompleting(task.artifactId);
          const jobId = `complete-alibaba-${task.artifactId}-${Date.now()}`;

          // Video result has video_url, image result has choices with image URLs
          const resultUrls: string[] = [];
          if (taskStatus.output.video_url) {
            resultUrls.push(taskStatus.output.video_url);
          }
          if (taskStatus.output.choices) {
            for (const choice of taskStatus.output.choices) {
              for (const content of choice.message.content) {
                if (content.type === "image" && content.image) {
                  resultUrls.push(content.image);
                }
              }
            }
          }

          await queue.enqueue(jobId, {
            type: "complete_kie_task",
            taskId: task.taskId,
            taskType: task.taskType,
            assetId: task.artifactId,
            assetDir: assetDirResult.value,
            bookId: book_id,
            meta: task.meta,
            resultUrls,
          } as unknown as Record<string, unknown>);
          result.completed.push({ assetId: task.artifactId, taskType: task.taskType, jobId });
        } else if (status === "FAILED" || status === "CANCELED") {
          const failMsg = taskStatus.output.message ?? `Alibaba task ${status}`;
          const code = taskStatus.output.code;
          result.failed.push({ assetId: task.artifactId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
          await failPendingTaskAndLog(engine, task.artifactId, task.taskId, {
            message: failMsg,
            prompt,
            ...(code !== undefined ? { failCode: code } : {}),
          });
        } else {
          result.pending.push({
            assetId: task.artifactId,
            taskType: task.taskType,
            progress: 0,
            state: status.toLowerCase(),
            prompt,
            startedAt: task.createdAt,
          });
        }
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Poll failed";
        result.failed.push({ assetId: task.artifactId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof AlibabaError) {
          const alibabaErr = e as AlibabaError;
          if (alibabaErr.status >= 400 && alibabaErr.status < 500) {
            await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: failMsg, prompt });
          }
        }
      }
    })));
  }

  // Poll FAL tasks (only if API key is set)
  const falTasks = pollableTasks.filter((t) => t.taskType.startsWith("fal_"));
  if (process.env.FAL_API_KEY && falTasks.length > 0) {
    const provider = createFal({ apiKey: process.env.FAL_API_KEY, timeout: 30_000, ...(falQueueBaseURL ? { queueBaseURL: falQueueBaseURL } : {}) });

    // FAL's queue status/result endpoints live under the app namespace
    // (first 2 path segments). Hitting them with the full nested endpoint id
    // — e.g. `fal-ai/elevenlabs/speech-to-text/scribe-v2` — 405s. Strip back
    // to `fal-ai/elevenlabs` for polling.
    const falNamespace = (endpointId: string): string =>
      endpointId.split("/").slice(0, 2).join("/");

    await Promise.all(falTasks.map(async (task) => withProviderTaskContext(engine, book_id, task, async () => {
      const prompt = metaPrompt(task.meta);
      const endpointId = typeof task.meta?.falEndpointId === "string" ? task.meta.falEndpointId : null;
      if (!endpointId) {
        const failMsg = `FAL task missing falEndpointId in meta`;
        result.failed.push({ assetId: task.artifactId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: failMsg, prompt });
        return;
      }
      const statusEndpointId = falNamespace(endpointId);
      try {
        const status = await provider.v1.queue.status({ endpoint_id: statusEndpointId, request_id: task.taskId });
        if (status.status === "COMPLETED") {
          if (status.error) {
            const failMsg = status.error;
            result.failed.push({ assetId: task.artifactId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
            await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: failMsg, prompt });
            return;
          }
          const assetDirResult = await engine.workspaces.resolveArtifact(task.artifactId);
          if (!assetDirResult.ok) {
            await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: `Asset not found: ${task.artifactId}`, prompt });
            return;
          }
          const resultObject = await provider.v1.queue.result({ endpoint_id: statusEndpointId, request_id: task.taskId });
          // Mark the pending task as completing BEFORE enqueueing so any
          // overlapping reconciliation poll skips it instead of enqueueing a duplicate.
          await engine.jobs.pending.markCompleting(task.artifactId);
          const jobId = `complete-fal-${task.artifactId}-${Date.now()}`;
          await queue.enqueue(jobId, {
            type: "complete_kie_task",
            taskId: task.taskId,
            taskType: task.taskType,
            assetId: task.artifactId,
            assetDir: assetDirResult.value,
            bookId: book_id,
            meta: task.meta,
            resultUrls: [],
            resultObject,
          } as unknown as Record<string, unknown>);
          result.completed.push({ assetId: task.artifactId, taskType: task.taskType, jobId });
        } else {
          result.pending.push({
            assetId: task.artifactId,
            taskType: task.taskType,
            progress: 0,
            state: status.status.toLowerCase(),
            prompt,
            startedAt: task.createdAt,
          });
        }
      } catch (e) {
        const failMsg = describeFalError(e);
        result.failed.push({ assetId: task.artifactId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof FalError) {
          const falErr = e as FalError;
          if (falErr.status >= 400 && falErr.status < 500) {
            await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: failMsg, prompt });
          }
        }
      }
    })));
  }

  await pollMachGenTasks(engine, pollableTasks, result, book_id, options.machgenBaseURL ?? providerEndpoints().machgenBaseURL);

  for (const task of expiredTasks) {
    if (options.signal?.aborted) break;
    const current = engine.jobs.pending.read(task.artifactId);
    if (!current.ok || !current.value || current.value.taskId !== task.taskId
      || current.value.completing) continue;
    const ageMinutes = Math.round((nowMs - task.createdAt) / 60_000);
    const failMsg = `Task timed out after ${ageMinutes}m without reaching success or fail state`;
    const prompt = metaPrompt(task.meta);
    result.pending = result.pending.filter((entry) => entry.assetId !== task.artifactId);
    result.failed = result.failed.filter((entry) => entry.assetId !== task.artifactId);
    result.failed.push({ assetId: task.artifactId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
    await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: failMsg, prompt });
  }
  return result;
}

export async function reconcileProjectWork(
  engine: Engine,
  book_id: string,
): Promise<ReconcileProjectWorkResult> {
  const result: ReconcileProjectWorkResult = {
    pending: [], completed: [], failed: [],
    external_uploads: [], auto_transcribe: [], auto_plain_transcript: [],
  };

  // Single listAssets call, shared by all consumers
  const assets = await engine.artifacts.list();

  // Run discovery steps in parallel with provider polling
  const [uploads, providerResult, transcribeActions, plainTranscriptActions, failuresRes] = await Promise.all([
    findUnprocessedUploads(engine, assets),
    pollPendingProviderTasks(engine, book_id),
    findAutoTranscribeActions(engine, assets),
    findAutoPlainTranscriptActions(engine, assets),
    engine.jobs.failures.findAll(),
  ]);
  const persistedFailures = failuresRes.ok ? failuresRes.value : [];

  // Process external uploads
  for (const upload of uploads) {
    await processExternalUpload(engine, upload, book_id);
    result.external_uploads.push({ assetId: upload.assetId, mediaFilename: upload.mediaFilename });
  }

  result.pending.push(...providerResult.pending);
  result.completed.push(...providerResult.completed);
  result.failed.push(...providerResult.failed);

  const tasksRes = await engine.jobs.pending.findAll();
  const tasks: PendingTask[] = tasksRes.ok ? tasksRes.value : [];

  // Merge persisted runtime failures that weren't already
  // reported by this poll and don't have an active pending task (retry in progress).
  const reportedAssetIds = new Set(result.failed.map((f) => f.assetId));
  const pendingAssetIds = new Set(tasks.map((t) => t.artifactId));
  for (const failure of persistedFailures) {
    if (!reportedAssetIds.has(failure.artifactId) && !pendingAssetIds.has(failure.artifactId)) {
      const asset = assets.find(a => a.artifactId === failure.artifactId);
      if (asset) {
        const manifestResult = await engine.files.manifest(failure.artifactId);
        if (manifestResult.ok) {
          const files = manifestResult.value.files;
          let hasMedia = false;
          if (asset.kind === "character") {
             hasMedia = files.some(f => /\\.(jpg|jpeg|png|webp|gif)$/i.test(f.name));
          } else {
             hasMedia = findAssetMediaFile(files, asset) !== null;
          }
          if (hasMedia) {
             await engine.jobs.failures.clear(failure.artifactId);
             continue;
          }
        }
      }

      result.failed.push({
        assetId: failure.artifactId,
        taskType: "",
        failMsg: failure.message,
        failedAt: new Date(failure.failedAt).toISOString(),
        prompt: failure.prompt ?? null,
      });
    }
  }

  // Auto-render and auto-analyze are intentionally NOT performed here.
  // Renders fire from explicit /render or assign_slot (lazy on slot drop).
  // Gemini analysis fires from assign_slot (lazy on slot drop) and
  // OpenAI plain speech-to-text fires eagerly from process_video on upload,
  // with a revision-scoped backfill here for processed videos that missed
  // .analysis.gpt4otrans.json. Reconciliation still retries ElevenLabs
  // (auto_transcribe) only after .original.analysis.json exists.

  // Auto-pipeline: advance analyzed videos through transcription. Stable
  // dedupe key, shared with analyze-video's auto-transcribe trigger: racing
  // enqueues collapse onto one queued job instead of transcribing twice.
  for (const action of transcribeActions) {
    const jobId = `auto-transcribe-${action.assetId}`;
    await queue.enqueue(jobId, {
      type: "transcribe",
      audioPath: action.audioPath,
      audioFilename: action.audioFilename,
      tagAudioEvents: true,
      diarize: true,
      assetId: action.assetId,
      assetDir: action.assetDir,
      bookId: book_id,
      componentKey: elevenLabsTranscriptKey(action.audioHash, DEFAULT_TRANSCRIPT_OPTIONS),
    } as unknown as Record<string, unknown>);
    result.auto_transcribe.push({ assetId: action.assetId, jobId });
  }

  for (const action of plainTranscriptActions) {
    const planned = planVideoTranscriptJobs({
      skipDownstreamJobs: false,
      hasAudio: true,
      assetId: action.assetId,
      assetDir: action.assetDir,
      bookId: book_id,
      videoFilename: action.videoFilename,
      identity: action.revision,
      audioHash: action.audioHash,
      hasOpenAiKey: true,
      hasElevenLabsKey: false,
    });
    for (const job of planned) {
      await queue.enqueue(job.jobId, job.payload as unknown as Record<string, unknown>);
      result.auto_plain_transcript.push({ assetId: action.assetId, jobId: job.jobId });
    }
  }

  return result;
}

export function reconcileProjectWorkDef(engine: Engine): ToolDef {
  return {
    name: "reconcile_project_work",
    description: "Finish pending provider tasks for this book and pick up files added outside the app (Finder or CLI) that need processing.",
    schema: {
      book_id: z.string().describe("Book id"),
    },
    handler: async (args) => {
      const { book_id } = args as { book_id: string };
      const reconcileResult = await reconcileProjectWork(engine, book_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(reconcileResult) }],
      };
    },
  };
}

async function processKieTaskResult(
  engine: Engine,
  task: PendingTask,
  taskInfo: KieTaskInfo,
  result: ProviderPollResult,
  bookId: string,
): Promise<void> {
  const data = taskInfo.data;
  const prompt = metaPrompt(task.meta);
  if (data?.state === "success") {
    const assetDirResult = await engine.workspaces.resolveArtifact(task.artifactId);
    if (!assetDirResult.ok) {
      await failPendingTaskAndLog(engine, task.artifactId, task.taskId, { message: `Asset not found: ${task.artifactId}`, prompt });
      return;
    }

    const jobId = `complete-${task.taskType}-${task.artifactId}-${Date.now()}`;

    const parsed = JSON.parse(data.resultJson ?? "{}") as {
      resultUrls?: string[];
      resultObject?: Record<string, unknown>;
    };

    // Mark the pending task as completing BEFORE enqueueing so any
    // overlapping reconciliation poll skips it instead of enqueueing a duplicate.
    await engine.jobs.pending.markCompleting(task.artifactId);

    await queue.enqueue(jobId, {
      type: "complete_kie_task",
      taskId: task.taskId,
      taskType: task.taskType,
      assetId: task.artifactId,
      assetDir: assetDirResult.value,
      bookId,
      meta: task.meta,
      resultUrls: parsed.resultUrls ?? [],
      resultObject: parsed.resultObject,
    } as unknown as Record<string, unknown>);

    result.completed.push({ assetId: task.artifactId, taskType: task.taskType, jobId });
  } else if (data?.state === "fail") {
    const failMsg = seedanceEditFailure(task.meta?.model, data.failMsg ?? "unknown error");
    // A kie 500 is only retryable while the task is still in flight; once it
    // has terminally completed, surface the failure instead of stranding the
    // asset as "working" until the 30m reconciliation timeout. See isTransientKieFailure.
    if (isTransientKieFailure(data)) {
      result.pending.push({
        assetId: task.artifactId,
        taskType: task.taskType,
        progress: data.progress ?? 0,
        state: data.state ?? "waiting",
        prompt,
        startedAt: task.createdAt,
      });
      return;
    }
    result.failed.push({
      assetId: task.artifactId,
      taskType: task.taskType,
      failMsg,
      failedAt: new Date().toISOString(),
      prompt,
    });
    await failPendingTaskAndLog(engine, task.artifactId, task.taskId, {
      message: failMsg,
      prompt,
      ...(data.failCode !== undefined ? { failCode: data.failCode } : {}),
    });
  } else {
    result.pending.push({
      assetId: task.artifactId,
      taskType: task.taskType,
      progress: data?.progress ?? 0,
      state: data?.state ?? "waiting",
      prompt,
      startedAt: task.createdAt,
    });
  }
}

type RenderAction = {
  assetId: string;
  assetDir: string;
  videoPath: string;
  videoFilename: string;
  hasElevenlabs: boolean;
};

export async function findEligibleRenderActions(
  engine: Engine,
  assets: Artifact[],
  orientation: string,
): Promise<RenderAction[]> {
  const candidates = await Promise.all(
    assets.filter((a) => a.kind === "video").map(async (asset): Promise<RenderAction | null> => {
      const manifestResult = await engine.files.manifest(asset.artifactId);
      if (!manifestResult.ok) return null;

      const manifest = manifestResult.value;
      const files = manifest.files;
      const fileNames = new Set(files.map((f) => f.name));
      const [analysis, transcription] = await Promise.all([
        engine.files.read(asset.artifactId, ".original.analysis.json"),
        engine.files.read(asset.artifactId, ".analysis.gpt4otrans.json"),
      ]);

      // Skip: already rendered for target orientation
      const renderMetadata = await engine.metadata.artifacts.read<Record<string, unknown>>(asset.artifactId, `${orientation}.render`
      );
      if (renderMetadata.ok && typeof renderMetadata.value.renderedAt === "string") return null;
      // Skip: process_video incomplete
      if (!analysis.ok) return null;

      // Skip if speech-to-text analysis not yet complete (unless video has no audio)
      if (!transcription.ok) {
        const meta = await engine.metadata.artifacts.read<{ hasAudio?: boolean }>(asset.artifactId, "original");
        if (meta.ok && meta.value.hasAudio) return null;
      }

      // For videos with dialog, wait for ElevenLabs transcription
      const dialogQuality = await readAndAssessDialog(engine, asset.artifactId);
      if (dialogQuality.hasDialog && !fileNames.has("elevenlabs.json")) return null;

      const videoFile = findVideoFile(files);
      if (videoFile && !await engine.jobs.locks.isLocked(manifest.path)) {
        return {
          assetId: asset.artifactId,
          assetDir: manifest.path,
          videoPath: join(manifest.path, videoFile.name),
          videoFilename: videoFile.name,
          hasElevenlabs: fileNames.has("elevenlabs.json"),
        };
      }
      return null;
    })
  );
  return candidates.filter((c): c is RenderAction => c !== null);
}

type TranscribeAction = {
  assetId: string;
  assetDir: string;
  audioPath: string;
  audioFilename: string;
  audioHash: string;
};

async function findAutoTranscribeActions(
  engine: Engine,
  assets: Artifact[],
): Promise<TranscribeAction[]> {
  if (!process.env.ELEVENLABS_API_KEY) return [];

  const candidates = await Promise.all(
    assets.filter((a) => a.kind === "video").map(async (asset): Promise<TranscribeAction | null> => {
      const [manifestResult, locked, errorRow] = await Promise.all([
        engine.files.manifest(asset.artifactId),
        engine.jobs.locks.isLocked(asset.path),
        engine.jobs.failures.read(asset.artifactId),
      ]);
      if (!manifestResult.ok) return null;

      const manifest = manifestResult.value;
      const files = manifest.files;
      const fileNames = new Set(files.map((f) => f.name));

      // Must have completed analysis
      if (!(await engine.files.read(asset.artifactId, ".original.analysis.json")).ok) return null;
      // Skip if already transcribed
      if (fileNames.has("elevenlabs.json")) return null;
      // Skip if a prior transcription attempt failed — do not auto-retry.
      // User must manually clear the error to retry.
      if (errorRow.ok && errorRow.value !== null) return null;
      // Skip if locked
      if (locked) return null;

      // Must have real dialog
      const dialogQuality = await readAndAssessDialog(engine, asset.artifactId);
      if (!dialogQuality.hasDialog) return null;

      // Must have an audio file
      const audioFile = findAudioFile(files, asset.kind);
      if (!audioFile) return null;

      return {
        assetId: asset.artifactId,
        assetDir: manifest.path,
        audioPath: join(manifest.path, audioFile.name),
        audioFilename: audioFile.name,
        audioHash: audioFile.objectHash,
      };
    })
  );
  return candidates.filter((c): c is TranscribeAction => c !== null);
}

type PlainTranscriptAction = {
  assetId: string;
  assetDir: string;
  videoFilename: string;
  revision: string;
  audioHash: string;
};

async function findAutoPlainTranscriptActions(
  engine: Engine,
  assets: Artifact[],
): Promise<PlainTranscriptAction[]> {
  if (!process.env.OPENAI_API_KEY) return [];

  const candidates = await Promise.all(
    assets.filter((a) => a.kind === "video").map(async (asset): Promise<PlainTranscriptAction | null> => {
      const [manifestResult, locked, errorRow, originalMeta] = await Promise.all([
        engine.files.manifest(asset.artifactId),
        engine.jobs.locks.isLocked(asset.path),
        engine.jobs.failures.read(asset.artifactId),
        engine.metadata.artifacts.read<{ hasAudio?: boolean }>(asset.artifactId, "original"),
      ]);
      if (!manifestResult.ok) return null;
      if (!originalMeta.ok) return null;
      if (originalMeta.value.hasAudio === false) return null;
      if (errorRow.ok && errorRow.value !== null) return null;
      if (locked) return null;

      const manifest = manifestResult.value;
      const files = manifest.files;
      if ((await engine.files.read(asset.artifactId, ".analysis.gpt4otrans.json")).ok) {
        return null;
      }

      const audioFile = findAudioFile(files, asset.kind);
      if (!audioFile) return null;
      const videoFile = files.find((file) => file.name === "original.mp4")
        ?? findVideoFile(files);
      if (!videoFile) return null;

      const revision = videoFile.objectHash;
      const existing = engine.jobs.queue.list({
        type: "transcribe_video_audio",
        artifactId: asset.artifactId,
      });
      if (existing.some((job) => job.payload.mediaRevision === revision)) return null;

      return {
        assetId: asset.artifactId,
        assetDir: manifest.path,
        videoFilename: videoFile.name,
        revision,
        audioHash: audioFile.objectHash,
      };
    })
  );
  return candidates.filter((c): c is PlainTranscriptAction => c !== null);
}
