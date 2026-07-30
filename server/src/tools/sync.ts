import type { Engine, Artifact, ArtifactManifestFile } from "videobook-engine";
import { computeArtifactStatus, QUEUED_TASK_ID } from "videobook-engine";
import { z } from "zod";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createKie, KieError } from "@apicity/kie";
import type { KieTaskInfo, KieTaskInfoData } from "@apicity/kie";
import { createXai, XaiError } from "@apicity/xai";
import { createAlibaba, AlibabaError } from "@apicity/alibaba";
import { createFal, FalError } from "@apicity/fal";
import { createGoogleFlow, GoogleFlowError } from "@apicity/googleflow";
import { describeGoogleFlowJobFailure, googleFlowFetch } from "../jobs/_google-flow.js";
import { queue } from "../queue.js";
import { getApiKey } from "../api-key.js";
import {
  findVideoFile,
  findAudioFile,
  findPrimaryMediaFile,
  RENDER_ORIENTATIONS as MEDIA_RENDER_ORIENTATIONS,
} from "videobook-engine";
import { readAndAssessDialog } from "../dialog-quality.js";
import { failPendingTaskAndLog } from "../jobs/task-failure.js";
import type { PendingTask } from "videobook-engine";
import { findUnprocessedUploads, processExternalUpload } from "../jobs/process-upload.js";
import { probeVideo } from "../ffmpeg.js";
import type { ToolDef } from "./tool-def.js";
import { submitQueuedKieTask } from "../jobs/kie-paygate.js";
import {
  DEFAULT_KEYWORD_GRAPHICS_LINGER_SECONDS,
  DEFAULT_KEYWORD_GRAPHICS_MAX_COUNT,
} from "../remotion/keyword-graphics.js";

/** Upper bound on how long a pending task may sit without reaching success/fail
 *  before sync ages it out. Guards against providers leaving jobs in an
 *  intermediate "waiting" state indefinitely. */
const PENDING_TASK_TIMEOUT_MS = 30 * 60 * 1000;

export type AssetWorkProjection = {
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

export type SyncAnalysisInfo = {
  source_duration_seconds: number;
  output_json: unknown | null;
  output_url: string | null;
  llm_exchanges: Array<{
    provider: string;
    model: string;
    stage: string;
  }>;
  shots: Array<{
    ordinal: number;
    label: string;
    start_seconds: number;
    end_seconds: number;
    duration_seconds: number;
  }>;
};

export type SyncAsset = {
  id: string;
  artifact_id: string;
  type: string;
  created_at: string;
  path: string;
  media_url: string | null;
  thumbnail_url: string | null;
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
  audio_info: {
    codec: string;
    sample_rate_hz: number;
    channels: number;
    channel_layout: string;
    duration_seconds: number;
  } | null;
  analysis_info: SyncAnalysisInfo | null;
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

export type OsgSummary = {
  assetId: string;
  position: string;
  size: string;
  scale: number;
  startSeconds: number | null;
  endSeconds: number | null;
};

function analysisInfoFromMetadata(
  metadata: Record<string, unknown> | null,
): SyncAnalysisInfo | null {
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
  llmExchanges: SyncAnalysisInfo["llm_exchanges"];
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
          return provider && model && stage
            ? [{ provider, model, stage }]
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

function findAssetMediaFile(
  files: ArtifactManifestFile[],
  asset: Pick<Artifact, "kind" | "slug">,
): ArtifactManifestFile | null {
  return asset.kind === "audio"
    ? findAudioFile(files, asset.slug)
    : findPrimaryMediaFile(files, asset.slug);
}

/** Read the OSG overlay summary from the asset's render metadata. OSG is stored
 *  identically across orientations, so the first orientation that carries an
 *  osgAssetId wins. Returns null when no overlay is configured. */
export async function readOsgSummary(
  fs: Engine, assetId: string, _bookId: string,
): Promise<OsgSummary | null> {
  for (const orient of RENDER_ORIENTATIONS) {
    const meta = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orient}.render`);
    if (!meta.ok) continue;
    const osgAssetId = meta.value.osgAssetId;
    if (typeof osgAssetId !== "string" || !osgAssetId) continue;
    return {
      assetId: osgAssetId,
      position: typeof meta.value.osgPosition === "string" ? meta.value.osgPosition : "top-right",
      size: typeof meta.value.osgSize === "string" ? meta.value.osgSize : "medium",
      scale: typeof meta.value.osgScale === "number" ? meta.value.osgScale : 1,
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

export type SyncResult = {
  pending: Array<{ assetId: string; taskType: string; progress: number; state: string; prompt: string | null; startedAt: number | null }>;
  completed: Array<{ assetId: string; taskType: string; jobId: string }>;
  failed: Array<{ assetId: string; taskType: string; failMsg: string; failedAt: string; prompt: string | null }>;
  external_uploads: Array<{ assetId: string; mediaFilename: string }>;
  auto_render: Array<{ assetId: string; jobId: string }>;
  auto_transcribe: Array<{ assetId: string; jobId: string }>;
};

function metaPrompt(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  const p = meta.prompt;
  return typeof p === "string" ? p : null;
}

function isVeoPendingTask(task: PendingTask): boolean {
  return typeof task.meta?.veoModel === "string";
}

// Google Flow tasks ride shared taskTypes (the engine's TaskType union has no
// google literals), so the submit helper stamps meta.googleFlow instead.
function isGoogleFlowPendingTask(task: PendingTask): boolean {
  return task.meta?.googleFlow === true;
}

function isKiePendingTask(task: PendingTask): boolean {
  if (isVeoPendingTask(task)) return false;
  if (isGoogleFlowPendingTask(task)) return false;
  return !task.taskType.startsWith("xai_") && !task.taskType.startsWith("fal_") && !task.taskType.startsWith("alibaba_");
}

// A completed GET /google-flow/jobs/{jobId} carries the generated clips at
// response.media[].videoUrl (signed URLs, ~24h validity).
function googleFlowResultUrls(job: Record<string, unknown>): string[] {
  const response = job.response;
  if (!response || typeof response !== "object") return [];
  const media = (response as Record<string, unknown>).media;
  if (!Array.isArray(media)) return [];
  const urls: string[] = [];
  for (const entry of media) {
    if (!entry || typeof entry !== "object") continue;
    const url = (entry as Record<string, unknown>).videoUrl;
    if (typeof url === "string" && url !== "") urls.push(url);
  }
  return urls;
}

function isQueuedKiePendingTask(task: PendingTask): boolean {
  return task.taskId === QUEUED_TASK_ID && isKiePendingTask(task);
}

/** failCode "500" is kie's transient internal error ("please try again
 *  later"). It's only worth leaving the task pending for a re-poll while the
 *  job is still in flight — once kie stamps a `completeTime`, the task record
 *  is final and re-polling the same taskId can never flip to success. Treating
 *  a completed 500 as transient strands the asset in "working" until the 30m
 *  sync timeout (PENDING_TASK_TIMEOUT_MS) and buries the real failure message,
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

async function readWaveformOrSchedule(
  fs: Engine,
  assetId: string,
  bookId: string,
  videoFilename: string | null,
): Promise<number[] | null> {
  const existing = await fs.metadata.waveforms.read(assetId);
  if (existing.ok) {
    // Empty peaks are a negative-cache marker ("extracted, nothing usable"):
    // surface them as no-waveform so the UI is unchanged, but don't re-extract.
    return existing.value.peaks.length > 0 ? existing.value.peaks : null;
  }
  if (!videoFilename || !/^original\.(mp4|mov)$/i.test(videoFilename)) {
    return null;
  }
  // Waveform extraction shells out to ffmpeg and can take several seconds for
  // long videos, so it must never run inline in list_assets / sync. Hand it to
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
      console.error(
        `[sync] failed to enqueue waveform extraction for ${assetId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
}

const PARTIAL_DOWNLOAD_RE = /\.(mp4|mov)\.part$/i;

/** Media extensions whose duration can be recovered via ffprobe when metadata lacks it. */
const DURATION_PROBE_EXT_RE = /\.(mp4|mov|webm|mkv|mp3|wav|m4a|aac|ogg|flac)$/i;

export const RENDER_ORIENTATIONS = MEDIA_RENDER_ORIENTATIONS;

export async function readRenderSettings(
  fs: Engine, assetId: string, bookId: string, orientations: string[],
): Promise<Record<string, Record<string, unknown>>> {
  const result: Record<string, Record<string, unknown>> = {};
  await Promise.all(orientations.map(async (orient) => {
    const meta = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orient}.render`);
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
  osgScale: 1,
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
  fs: Engine, assetId: string, bookId: string, targetOrientation: string,
): Promise<Record<string, unknown>> {
  const defaults = { ...BASE_DEFAULTS, ...(ORIENTATION_OVERRIDES[targetOrientation] ?? ORIENTATION_OVERRIDES.landscape) };
  // Read every orientation's render metadata in parallel, then pick the
  // target's own metadata first or fall back to any other orientation.
  const tryOrder = [targetOrientation, ...RENDER_ORIENTATIONS.filter((o) => o !== targetOrientation)];
  const metas = await Promise.all(
    tryOrder.map((orient) =>
      fs.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orient}.render`),
    ),
  );
  for (const meta of metas) {
    if (meta.ok) return { ...defaults, ...meta.value };
  }
  const recs = await readAnalysisRecommendations(fs, assetId, bookId);
  return { ...defaults, ...recs };
}

const VALID_SUB_POSITIONS = new Set(["top", "middle", "bottom"]);
const VALID_OSG_POSITIONS = new Set(["top-left", "top-right", "bottom-left", "bottom-right"]);

async function readAnalysisRecommendations(
  fs: Engine, assetId: string, _bookId: string,
): Promise<Record<string, unknown>> {
  const result = await fs.files.read(assetId, ".original.analysis.json");
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

// Content fingerprint covering every file in the asset directory. Changes
// whenever any file is added, removed, resized, or rewritten, so every URL
// derived from an asset's filePath (including alternate-orientation renders
// like portrait.mp4 / landscape.mp4) invalidates together. Cheap: no file
// reads — just hashes the immutable manifest tuples.
function computeAssetFingerprint(files: ArtifactManifestFile[]): string {
  if (files.length === 0) return "";
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const hash = createHash("sha1");
  for (const f of sorted) {
    hash.update(f.name);
    hash.update("\0");
    hash.update(String(f.sizeBytes ?? 0));
    hash.update("\0");
    hash.update(f.objectHash);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

function renderedOrientationsFor(
  files: ArtifactManifestFile[],
  assetId: string,
): string[] {
  const fileSet = new Set(files.map((f) => f.name));
  if (assetId === "final") {
    return RENDER_ORIENTATIONS.filter((o) => fileSet.has(`timeline_${o}.mp4`));
  }
  return RENDER_ORIENTATIONS.filter((o) => fileSet.has(`${o}.mp4`));
}

export async function buildAssetList(fs: Engine, book_id: string, sort?: "newest" | "oldest"): Promise<SyncAsset[]> {
  const assets = fs.artifacts.list({ ...(sort ? { sort } : {}) });
  const assetRows = await Promise.all(
    assets.map(async (a): Promise<SyncAsset> => {
      const [manifestResult, lockData, pendingTask, generationError, metadata, archiveMetadata, assetWorkRow] = await Promise.all([
        fs.files.manifest(a.slug),
        fs.jobs.locks.get(a.path),
        fs.jobs.pending.read(a.slug),
        fs.jobs.failures.read(a.slug),
        fs.metadata.artifacts.read<Record<string, unknown>>(a.slug, "original"),
        fs.metadata.artifacts.read<ArchiveMetadata>(a.slug, "archive"),
        fs.jobs.artifactWork.read(a.slug),
      ]);

      // If the asset directory disappeared between listAssets and getManifest,
      // surface an empty-but-error placeholder rather than throwing.
      const files: ArtifactManifestFile[] = manifestResult.ok ? manifestResult.value.files : [];
      const directories = manifestResult.ok ? manifestResult.value.directories : undefined;

      const mediaFile = findAssetMediaFile(files, a);
      const fileNames = new Set(files.map((f) => f.name));
      const hasThumbnail = fileNames.has("original.jpg");
      const renders = renderedOrientationsFor(files, a.slug);
      const hasPartFile = files.some((f) => PARTIAL_DOWNLOAD_RE.test(f.name));
      const frameDirs = buildFrameDirs(directories, book_id, a.slug);
      const waveform = await readWaveformOrSchedule(
        fs,
        a.slug,
        book_id,
        mediaFile?.name ?? null,
      );

      // Cache-bust media URLs so browsers refetch after trim / re-encode / re-render.
      // For vid- and img- assets, use a content fingerprint covering the whole
      // asset directory: orientation re-renders (portrait/landscape/square.mp4)
      // touch alternate files but not original.mp4, so a primary-mtime cache
      // key would leave alternate-orientation URLs cached and stale.
      const useFingerprint = a.slug.startsWith("vid-") || a.slug.startsWith("img-");
      let cacheBust = '';
      if (useFingerprint) {
        const fp = computeAssetFingerprint(files);
        if (fp) cacheBust = `?v=${fp}`;
      } else {
        const mediaHash = mediaFile?.objectHash;
        if (mediaHash) cacheBust = `?v=${mediaHash.slice(0, 12)}`;
      }
      // Character assets: free-form folders have no original.* media. Project
      // the first image in the folder so sidebar thumbs and drag-drop keep working.
      let charImage = null;
      if (a.kind === "character") {
        charImage = files.find((f) => /\.(jpg|jpeg|png|webp|gif)$/i.test(f.name)) ?? null;
      }
      
      const proxyFile = a.kind === "video"
        ? files.find((file) => file.name === "proxy.mp4")
        : null;
      const media_url = charImage
        ? `/files/${book_id}/${a.slug}/${charImage.name}${cacheBust}`
        : proxyFile
        ? `/files/${book_id}/${a.slug}/${proxyFile.name}${cacheBust}`
        : mediaFile
        ? `/files/${book_id}/${a.slug}/${mediaFile.name}${cacheBust}`
        : null;
      const isImage = a.kind === "image";
      const thumbnail_url = charImage
        ? `/files/${book_id}/${a.slug}/${charImage.name}${cacheBust}`
        : hasThumbnail
        ? `/files/${book_id}/${a.slug}/original.jpg${cacheBust}`
        : isImage ? media_url : null;

      // Status derivation lives in videobook-engine (`computeArtifactStatus`). We pass
      // the asset-type-aware primary media name we already computed so the
      // engine doesn't have to redo media-type heuristics.
      const status = computeArtifactStatus({
        artifactSlug: a.slug,
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

      const meta = metadata.ok ? metadata.value : null;
      const archiveMeta = archiveMetadata.ok ? archiveMetadata.value : null;
      const analysisInfo = analysisInfoFromMetadata(meta);
      if (analysisInfo) {
        const output = await analysisOutputProjection(fs, a.slug);
        if (output) {
          analysisInfo.output_json = output.outputJson;
          analysisInfo.output_url =
            `/files/${book_id}/${a.slug}/analysis.json`;
          analysisInfo.llm_exchanges = output.llmExchanges;
        }
      }

      // Backfill duration if missing from metadata (video + audio; probeVideo
      // reads format.duration via ffprobe and works for both).
      let duration = (meta?.duration as number) ?? null;
      if (duration === null && mediaFile && DURATION_PROBE_EXT_RE.test(mediaFile.name)) {
        try {
          const probe = await probeVideo(join(a.path, mediaFile.name));
          if (Number.isFinite(probe.duration) && probe.duration > 0) {
            duration = probe.duration;
            // Persist so we don't re-probe next time
            if (metadata.ok) {
              await fs.metadata.artifacts.write(a.slug, "original", { ...metadata.value, duration });
            }
          }
        } catch { /* non-fatal */ }
      }
      const streams = fs.streams.list(a.artifactId);
      const audioStream = streams.ok
        ? streams.value.find((stream) => stream.kind === "audio" && stream.audio)
        : undefined;
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
        ? await readOsgSummary(fs, a.slug, book_id)
        : null;

      // Read script content from its canonical artifact file.
      let prompt = (meta?.prompt as string) ?? null;
      if (!prompt && a.kind === "script") {
        const md = await fs.files.read(a.slug, "original.md");
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
        id: a.slug,
        artifact_id: a.artifactId,
        type: a.kind,
        created_at: new Date(a.createdAt).toISOString(),
        path: a.path,
        media_url,
        thumbnail_url,
        status,
        assetWork,
        width: (meta?.width as number) ?? null,
        height: (meta?.height as number) ?? null,
        origin: (meta?.origin as string) ?? null,
        prompt,
        renders,
        duration,
        audio_info,
        analysis_info: analysisInfo,
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
  const notebookRows: SyncAsset[] = fs.notebooks
    .list()
    .map((notebook) => ({
      id: notebook.id,
      artifact_id: notebook.id,
      type: "notebook",
      created_at: notebook.createdAt,
      path: `notebook:${notebook.id}`,
      media_url: null,
      thumbnail_url: null,
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
      audio_info: null,
      analysis_info: null,
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

export async function performSync(fs: Engine, book_id: string): Promise<SyncResult> {
  const result: SyncResult = {
    pending: [], completed: [], failed: [],
    external_uploads: [], auto_render: [], auto_transcribe: [],
  };

  // Single listAssets call, shared by all consumers
  const assets = await fs.artifacts.list();

  // Run all discovery steps in parallel
  const [uploads, tasksRes, transcribeActions, failuresRes] = await Promise.all([
    findUnprocessedUploads(fs, book_id, assets),
    fs.jobs.pending.findAll(),
    findAutoTranscribeActions(fs, book_id, assets),
    fs.jobs.failures.findAll(),
  ]);
  const tasks: PendingTask[] = tasksRes.ok ? tasksRes.value : [];
  const persistedFailures = failuresRes.ok ? failuresRes.value : [];

  // Process external uploads
  for (const upload of uploads) {
    await processExternalUpload(fs, upload, book_id);
    result.external_uploads.push({ assetId: upload.assetId, mediaFilename: upload.mediaFilename });
  }

  // Age out any non-completing task older than PENDING_TASK_TIMEOUT_MS so it
  // stops showing as pending forever. Completing tasks are skipped because the
  // completion job is already dispatched; recoverAssetsTable handles that lane
  // on server restart by clearing the completing flag and refreshing owner_id.
  const nowMs = Date.now();
  const activeTasks: PendingTask[] = [];
  for (const originalTask of tasks) {
    let t = originalTask;
    if (isQueuedKiePendingTask(t)) {
      try {
        t = await submitQueuedKieTask(fs, book_id, t);
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Queued KIE submit failed";
        const prompt = metaPrompt(t.meta);
        result.failed.push({ assetId: t.artifactSlug, taskType: t.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        await failPendingTaskAndLog(fs, book_id, t.artifactSlug, t.taskId, { message: failMsg, prompt });
        continue;
      }
    }
    const ageMs = nowMs - t.createdAt;
    if (t.completing !== true && Number.isFinite(ageMs) && ageMs > PENDING_TASK_TIMEOUT_MS) {
      const ageMinutes = Math.round(ageMs / 60000);
      const failMsg = `Task timed out after ${ageMinutes}m without reaching success or fail state`;
      const prompt = metaPrompt(t.meta);
      result.failed.push({ assetId: t.artifactSlug, taskType: t.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
      await failPendingTaskAndLog(fs, book_id, t.artifactSlug, t.taskId, { message: failMsg, prompt });
    } else {
      activeTasks.push(t);
    }
  }

  // Completing tasks — sync already enqueued a completion job for these on a
  // prior poll. Skip polling + re-enqueueing so duplicate completion jobs
  // don't race on the asset-directory lock. Report as pending with state
  // "success" so the inbox tile shows the DOWNLOAD/PROCESS phase.
  const completingTasks = activeTasks.filter((t) => t.completing === true);
  for (const t of completingTasks) {
    result.pending.push({ assetId: t.artifactSlug, taskType: t.taskType, progress: 100, state: "success", prompt: metaPrompt(t.meta), startedAt: t.createdAt });
  }

  const pollableTasks = activeTasks.filter((t) => t.completing !== true);

  await Promise.all(
    pollableTasks.map(async (task) => {
      const ownerId = await fs.jobs.pending.getOwner(task.artifactSlug, task.taskId);
      if (ownerId) {
        await fs.jobs.artifactWork.renew(task.artifactSlug, ownerId, 30 * 60_000);
      }
    }),
  );

  // Poll KIE tasks (only if API key is set)
  const kieTasks = pollableTasks.filter(isKiePendingTask);
  const kieApiKey = getApiKey("KIE_API_KEY");
  if (kieApiKey && kieTasks.length > 0) {
    const provider = createKie({ apiKey: kieApiKey, timeout: 30_000 });

    await Promise.all(kieTasks.map(async (task) => {
      try {
        const taskInfo = await provider.get.api.v1.jobs.recordInfo(task.taskId);
        await processSyncedTask(fs, task, taskInfo, result, book_id);
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Poll failed";
        const prompt = metaPrompt(task.meta);
        result.failed.push({ assetId: task.artifactSlug, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof KieError) {
          // TS narrowing on `e` is unreliable here, use an explicit assertion.
          const kieErr = e as KieError;
          if (kieErr.status >= 400 && kieErr.status < 500) {
            await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: failMsg, prompt });
          }
        }
      }
    }));
  }

  // Poll KIE Veo tasks (separate namespace: kie.veo.get.api.v1.veo.recordInfo)
  const veoTasks = pollableTasks.filter(isVeoPendingTask);
  if (kieApiKey && veoTasks.length > 0) {
    const provider = createKie({ apiKey: kieApiKey, timeout: 30_000 });

    await Promise.all(veoTasks.map(async (task) => {
      const prompt = metaPrompt(task.meta);
      try {
        const recordInfo = await provider.veo.get.api.v1.veo.recordInfo(task.taskId);
        const data = recordInfo.data;
        // Veo successFlag: 0=submitted/pending, 1=success, 2=fail, 3=processing
        if (data?.successFlag === 1) {
          const urls = data.response?.resultUrls ?? [];
          if (urls.length === 0) {
            const failMsg = "Veo task succeeded but returned no resultUrls";
            result.failed.push({ assetId: task.artifactSlug, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
            await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: failMsg, prompt });
            return;
          }
          const assetDirResult = await fs.workspaces.resolveArtifact(task.artifactSlug);
          if (!assetDirResult.ok) {
            await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: `Asset not found: ${task.artifactSlug}`, prompt });
            return;
          }
          await fs.jobs.pending.markCompleting(task.artifactSlug);
          const jobId = `complete-veo-${task.artifactSlug}-${Date.now()}`;
          await queue.enqueue(jobId, {
            type: "complete_kie_task",
            taskId: task.taskId,
            taskType: task.taskType,
            assetId: task.artifactSlug,
            assetDir: assetDirResult.value,
            bookId: book_id,
            meta: task.meta,
            resultUrls: urls,
          } as unknown as Record<string, unknown>);
          result.completed.push({ assetId: task.artifactSlug, taskType: task.taskType, jobId });
        } else if (data?.successFlag === 2) {
          const failMsg = data.errorMessage ?? "Veo task failed";
          result.failed.push({ assetId: task.artifactSlug, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
          await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: failMsg, prompt });
        } else {
          result.pending.push({
            assetId: task.artifactSlug,
            taskType: task.taskType,
            progress: 0,
            state: data?.successFlag === 3 ? "processing" : "waiting",
            prompt,
            startedAt: task.createdAt,
          });
        }
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Veo poll failed";
        result.failed.push({ assetId: task.artifactSlug, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof KieError) {
          const kieErr = e as KieError;
          if (kieErr.status >= 400 && kieErr.status < 500) {
            await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: failMsg, prompt });
          }
        }
      }
    }));
  }

  // Poll Google Flow tasks (useapi.net async jobs; only if API key is set)
  const googleFlowTasks = pollableTasks.filter(isGoogleFlowPendingTask);
  const googleFlowKey = getApiKey("GOOGLE_FLOW_API_KEY");
  if (googleFlowKey && googleFlowTasks.length > 0) {
    const provider = createGoogleFlow({ apiKey: googleFlowKey, timeout: 30_000, fetch: googleFlowFetch });

    await Promise.all(googleFlowTasks.map(async (task) => {
      const prompt = metaPrompt(task.meta);
      try {
        const job = await provider.get.v1.jobs.retrieve({ jobId: task.taskId });
        const status = typeof job.status === "string" ? job.status : "";
        if (status === "completed") {
          const urls = googleFlowResultUrls(job);
          if (urls.length === 0) {
            const failMsg = "Google Flow job completed but returned no media URLs";
            await fs.metadata.artifacts.write(task.artifactSlug, "generation-error", job).catch(() => {});
            result.failed.push({ assetId: task.artifactSlug, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
            await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: failMsg, prompt });
            return;
          }
          const assetDirResult = await fs.workspaces.resolveArtifact(task.artifactSlug);
          if (!assetDirResult.ok) {
            await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: `Asset not found: ${task.artifactSlug}`, prompt });
            return;
          }
          await fs.jobs.pending.markCompleting(task.artifactSlug);
          const jobId = `complete-google-flow-${task.artifactSlug}-${Date.now()}`;
          await queue.enqueue(jobId, {
            type: "complete_kie_task",
            taskId: task.taskId,
            taskType: task.taskType,
            assetId: task.artifactSlug,
            assetDir: assetDirResult.value,
            bookId: book_id,
            meta: task.meta,
            resultUrls: urls,
          } as unknown as Record<string, unknown>);
          result.completed.push({ assetId: task.artifactSlug, taskType: task.taskType, jobId });
        } else if (status === "failed") {
          const { message: failMsg, failCode } = describeGoogleFlowJobFailure(job as Record<string, unknown>);
          await fs.metadata.artifacts.write(task.artifactSlug, "generation-error", job).catch(() => {});
          result.failed.push({ assetId: task.artifactSlug, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
          await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: failMsg, prompt, ...(failCode !== undefined ? { failCode } : {}) });
        } else {
          result.pending.push({
            assetId: task.artifactSlug,
            taskType: task.taskType,
            progress: 0,
            state: status === "started" ? "processing" : "waiting",
            prompt,
            startedAt: task.createdAt,
          });
        }
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Google Flow poll failed";
        result.failed.push({ assetId: task.artifactSlug, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof GoogleFlowError) {
          const googleErr = e as GoogleFlowError;
          // 4xx is permanent (bad/expired/foreign job id) except 429 rate limits.
          if (googleErr.status >= 400 && googleErr.status < 500 && googleErr.status !== 429) {
            await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: failMsg, prompt });
          }
        }
      }
    }));
  }

  // Poll xAI tasks (only if API key is set)
  const xaiTasks = pollableTasks.filter((t) => t.taskType.startsWith("xai_"));
  if (process.env.XAI_API_KEY && xaiTasks.length > 0) {
    const provider = createXai({ apiKey: process.env.XAI_API_KEY, timeout: 30_000 });

    await Promise.all(xaiTasks.map(async (task) => {
      const prompt = metaPrompt(task.meta);
      try {
        const videoResult = await provider.get.v1.videos(task.taskId);
        if (videoResult.status === "done" && videoResult.video?.url) {
          const assetDirResult = await fs.workspaces.resolveArtifact(task.artifactSlug);
          if (!assetDirResult.ok) {
            await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: `Asset not found: ${task.artifactSlug}`, prompt });
            return;
          }
          await fs.jobs.pending.markCompleting(task.artifactSlug);
          const jobId = `complete-xai-${task.artifactSlug}-${Date.now()}`;
          await queue.enqueue(jobId, {
            type: "complete_kie_task",
            taskId: task.taskId,
            taskType: task.taskType,
            assetId: task.artifactSlug,
            assetDir: assetDirResult.value,
            bookId: book_id,
            meta: task.meta,
            resultUrls: [videoResult.video.url],
          } as unknown as Record<string, unknown>);
          result.completed.push({ assetId: task.artifactSlug, taskType: task.taskType, jobId });
        } else if (videoResult.status === "failed" || videoResult.status === "expired") {
          const failMsg = `xAI task ${videoResult.status}`;
          result.failed.push({ assetId: task.artifactSlug, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
          await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: failMsg, prompt });
        } else {
          result.pending.push({
            assetId: task.artifactSlug,
            taskType: task.taskType,
            progress: videoResult.progress ?? 0,
            state: videoResult.status,
            prompt,
            startedAt: task.createdAt,
          });
        }
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Poll failed";
        result.failed.push({ assetId: task.artifactSlug, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof XaiError) {
          const xaiErr = e as XaiError;
          if (xaiErr.status >= 400 && xaiErr.status < 500) {
            await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: failMsg, prompt });
          }
        }
      }
    }));
  }

  // Poll Alibaba tasks (only if API key is set)
  const alibabaTasks = pollableTasks.filter((t) => t.taskType.startsWith("alibaba_"));
  if (process.env.DASHSCOPE_API_KEY && alibabaTasks.length > 0) {
    const provider = createAlibaba({ apiKey: process.env.DASHSCOPE_API_KEY, timeout: 30_000 });

    await Promise.all(alibabaTasks.map(async (task) => {
      const prompt = metaPrompt(task.meta);
      try {
        const taskStatus = await provider.get.api.v1.tasks(task.taskId);
        const status = taskStatus.output.task_status;

        if (status === "SUCCEEDED") {
          const assetDirResult = await fs.workspaces.resolveArtifact(task.artifactSlug);
          if (!assetDirResult.ok) {
            await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: `Asset not found: ${task.artifactSlug}`, prompt });
            return;
          }
          await fs.jobs.pending.markCompleting(task.artifactSlug);
          const jobId = `complete-alibaba-${task.artifactSlug}-${Date.now()}`;

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
            assetId: task.artifactSlug,
            assetDir: assetDirResult.value,
            bookId: book_id,
            meta: task.meta,
            resultUrls,
          } as unknown as Record<string, unknown>);
          result.completed.push({ assetId: task.artifactSlug, taskType: task.taskType, jobId });
        } else if (status === "FAILED" || status === "CANCELED") {
          const failMsg = taskStatus.output.message ?? `Alibaba task ${status}`;
          const code = taskStatus.output.code;
          result.failed.push({ assetId: task.artifactSlug, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
          await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, {
            message: failMsg,
            prompt,
            ...(code !== undefined ? { failCode: code } : {}),
          });
        } else {
          result.pending.push({
            assetId: task.artifactSlug,
            taskType: task.taskType,
            progress: 0,
            state: status.toLowerCase(),
            prompt,
            startedAt: task.createdAt,
          });
        }
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Poll failed";
        result.failed.push({ assetId: task.artifactSlug, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof AlibabaError) {
          const alibabaErr = e as AlibabaError;
          if (alibabaErr.status >= 400 && alibabaErr.status < 500) {
            await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: failMsg, prompt });
          }
        }
      }
    }));
  }

  // Poll FAL tasks (only if API key is set)
  const falTasks = pollableTasks.filter((t) => t.taskType.startsWith("fal_"));
  if (process.env.FAL_API_KEY && falTasks.length > 0) {
    const provider = createFal({ apiKey: process.env.FAL_API_KEY, timeout: 30_000 });

    // FAL's queue status/result endpoints live under the app namespace
    // (first 2 path segments). Hitting them with the full nested endpoint id
    // — e.g. `fal-ai/elevenlabs/speech-to-text/scribe-v2` — 405s. Strip back
    // to `fal-ai/elevenlabs` for polling.
    const falNamespace = (endpointId: string): string =>
      endpointId.split("/").slice(0, 2).join("/");

    await Promise.all(falTasks.map(async (task) => {
      const prompt = metaPrompt(task.meta);
      const endpointId = typeof task.meta?.falEndpointId === "string" ? task.meta.falEndpointId : null;
      if (!endpointId) {
        const failMsg = `FAL task missing falEndpointId in meta`;
        result.failed.push({ assetId: task.artifactSlug, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: failMsg, prompt });
        return;
      }
      const statusEndpointId = falNamespace(endpointId);
      try {
        const status = await provider.v1.queue.status({ endpoint_id: statusEndpointId, request_id: task.taskId });
        if (status.status === "COMPLETED") {
          if (status.error) {
            const failMsg = status.error;
            result.failed.push({ assetId: task.artifactSlug, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
            await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: failMsg, prompt });
            return;
          }
          const assetDirResult = await fs.workspaces.resolveArtifact(task.artifactSlug);
          if (!assetDirResult.ok) {
            await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: `Asset not found: ${task.artifactSlug}`, prompt });
            return;
          }
          const resultObject = await provider.v1.queue.result({ endpoint_id: statusEndpointId, request_id: task.taskId });
          // Mark the pending task as completing BEFORE enqueueing so any
          // overlapping sync poll skips it instead of enqueueing a duplicate.
          await fs.jobs.pending.markCompleting(task.artifactSlug);
          const jobId = `complete-fal-${task.artifactSlug}-${Date.now()}`;
          await queue.enqueue(jobId, {
            type: "complete_kie_task",
            taskId: task.taskId,
            taskType: task.taskType,
            assetId: task.artifactSlug,
            assetDir: assetDirResult.value,
            bookId: book_id,
            meta: task.meta,
            resultUrls: [],
            resultObject,
          } as unknown as Record<string, unknown>);
          result.completed.push({ assetId: task.artifactSlug, taskType: task.taskType, jobId });
        } else {
          result.pending.push({
            assetId: task.artifactSlug,
            taskType: task.taskType,
            progress: 0,
            state: status.status.toLowerCase(),
            prompt,
            startedAt: task.createdAt,
          });
        }
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Poll failed";
        result.failed.push({ assetId: task.artifactSlug, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof FalError) {
          const falErr = e as FalError;
          if (falErr.status >= 400 && falErr.status < 500) {
            await failPendingTaskAndLog(fs, book_id, task.artifactSlug, task.taskId, { message: failMsg, prompt });
          }
        }
      }
    }));
  }

  // Merge persisted runtime failures that weren't already
  // reported by this poll and don't have an active pending task (retry in progress).
  const reportedAssetIds = new Set(result.failed.map((f) => f.assetId));
  const pendingAssetIds = new Set(tasks.map((t) => t.artifactSlug));
  for (const failure of persistedFailures) {
    if (!reportedAssetIds.has(failure.artifactSlug) && !pendingAssetIds.has(failure.artifactSlug)) {
      const asset = assets.find(a => a.slug === failure.artifactSlug);
      if (asset) {
        const manifestResult = await fs.files.manifest(failure.artifactSlug);
        if (manifestResult.ok) {
          const files = manifestResult.value.files;
          let hasMedia = false;
          if (asset.kind === "character") {
             hasMedia = files.some(f => /\\.(jpg|jpeg|png|webp|gif)$/i.test(f.name));
          } else {
             hasMedia = findAssetMediaFile(files, asset) !== null;
          }
          if (hasMedia) {
             await fs.jobs.failures.clear(failure.artifactSlug);
             continue;
          }
        }
      }

      result.failed.push({
        assetId: failure.artifactSlug,
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
  // gpt-4o-mini speech-to-text fires eagerly from process_video on upload.
  // Sync only retries the ElevenLabs transcribe step (auto_transcribe), which
  // is gated on .original.analysis.json already existing — i.e. only kicks in
  // for assets the user has actually slotted.

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
    } as unknown as Record<string, unknown>);
    result.auto_transcribe.push({ assetId: action.assetId, jobId });
  }

  return result;
}

export function syncDef(fs: Engine): ToolDef {
  return {
    name: "reconcile_project_work",
    description: "Check all pending KIE tasks for a project, enqueue completion jobs for finished ones, and detect externally-placed files (via Finder/CLI) that need processing. Call periodically after triggering generation tools or adding files externally.",
    schema: {
      book_id: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { book_id } = args as { book_id: string };
      const syncResult = await performSync(fs, book_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(syncResult) }],
      };
    },
  };
}

async function processSyncedTask(
  fs: Engine,
  task: PendingTask,
  taskInfo: KieTaskInfo,
  result: SyncResult,
  bookId: string,
): Promise<void> {
  const data = taskInfo.data;
  const prompt = metaPrompt(task.meta);
  if (data?.state === "success") {
    const assetDirResult = await fs.workspaces.resolveArtifact(task.artifactSlug);
    if (!assetDirResult.ok) {
      await failPendingTaskAndLog(fs, bookId, task.artifactSlug, task.taskId, { message: `Asset not found: ${task.artifactSlug}`, prompt });
      return;
    }

    const jobId = `complete-${task.taskType}-${task.artifactSlug}-${Date.now()}`;

    const parsed = JSON.parse(data.resultJson ?? "{}") as {
      resultUrls?: string[];
      resultObject?: Record<string, unknown>;
    };

    // Mark the pending task as completing BEFORE enqueueing so any
    // overlapping sync poll skips it instead of enqueueing a duplicate.
    await fs.jobs.pending.markCompleting(task.artifactSlug);

    await queue.enqueue(jobId, {
      type: "complete_kie_task",
      taskId: task.taskId,
      taskType: task.taskType,
      assetId: task.artifactSlug,
      assetDir: assetDirResult.value,
      bookId,
      meta: task.meta,
      resultUrls: parsed.resultUrls ?? [],
      resultObject: parsed.resultObject,
    } as unknown as Record<string, unknown>);

    result.completed.push({ assetId: task.artifactSlug, taskType: task.taskType, jobId });
  } else if (data?.state === "fail") {
    const failMsg = data.failMsg ?? "unknown error";
    // A kie 500 is only retryable while the task is still in flight; once it
    // has terminally completed, surface the failure instead of stranding the
    // asset as "working" until the 30m sync timeout. See isTransientKieFailure.
    if (isTransientKieFailure(data)) {
      result.pending.push({
        assetId: task.artifactSlug,
        taskType: task.taskType,
        progress: data.progress ?? 0,
        state: data.state ?? "waiting",
        prompt,
        startedAt: task.createdAt,
      });
      return;
    }
    result.failed.push({
      assetId: task.artifactSlug,
      taskType: task.taskType,
      failMsg,
      failedAt: new Date().toISOString(),
      prompt,
    });
    await failPendingTaskAndLog(fs, bookId, task.artifactSlug, task.taskId, {
      message: failMsg,
      prompt,
      ...(data.failCode !== undefined ? { failCode: data.failCode } : {}),
    });
  } else {
    result.pending.push({
      assetId: task.artifactSlug,
      taskType: task.taskType,
      progress: data?.progress ?? 0,
      state: data?.state ?? "waiting",
      prompt,
      startedAt: task.createdAt,
    });
  }
}

export type RenderAction = {
  assetId: string;
  assetDir: string;
  videoPath: string;
  videoFilename: string;
  hasElevenlabs: boolean;
};

export async function findAutoRenderActions(
  fs: Engine,
  bookId: string,
  assets: Artifact[],
  orientation: string,
): Promise<RenderAction[]> {
  const candidates = await Promise.all(
    assets.filter((a) => a.slug.startsWith("vid-")).map(async (asset): Promise<RenderAction | null> => {
      const manifestResult = await fs.files.manifest(asset.slug);
      if (!manifestResult.ok) return null;

      const manifest = manifestResult.value;
      const files = manifest.files;
      const fileNames = new Set(files.map((f) => f.name));

      // Skip: already rendered for target orientation
      const renderMetadata = await fs.metadata.artifacts.read<Record<string, unknown>>(asset.artifactId, `${orientation}.render`
      );
      if (renderMetadata.ok && typeof renderMetadata.value.renderedAt === "string") return null;
      // Skip: process_video incomplete
      if (!fileNames.has(".original.analysis.json")) return null;

      // Skip if speech-to-text analysis not yet complete (unless video has no audio)
      if (!fileNames.has(".analysis.gpt4otrans.json")) {
        const meta = await fs.metadata.artifacts.read<{ hasAudio?: boolean }>(asset.slug, "original");
        if (meta.ok && meta.value.hasAudio) return null;
      }

      // For videos with dialog, wait for ElevenLabs transcription
      const dialogQuality = await readAndAssessDialog(fs, asset.slug, bookId);
      if (dialogQuality.hasDialog && !fileNames.has("elevenlabs.json")) return null;

      const videoFile = findVideoFile(files);
      if (videoFile && !await fs.jobs.locks.isLocked(manifest.path)) {
        return {
          assetId: asset.slug,
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
};

async function findAutoTranscribeActions(
  fs: Engine,
  bookId: string,
  assets: Artifact[],
): Promise<TranscribeAction[]> {
  if (!process.env.ELEVENLABS_API_KEY) return [];

  const candidates = await Promise.all(
    assets.filter((a) => a.slug.startsWith("vid-")).map(async (asset): Promise<TranscribeAction | null> => {
      const [manifestResult, locked, errorRow] = await Promise.all([
        fs.files.manifest(asset.slug),
        fs.jobs.locks.isLocked(asset.path),
        fs.jobs.failures.read(asset.slug),
      ]);
      if (!manifestResult.ok) return null;

      const manifest = manifestResult.value;
      const files = manifest.files;
      const fileNames = new Set(files.map((f) => f.name));

      // Must have completed analysis
      if (!fileNames.has(".original.analysis.json")) return null;
      // Skip if already transcribed
      if (fileNames.has("elevenlabs.json")) return null;
      // Skip if a prior transcription attempt failed — do not auto-retry.
      // User must manually clear the error to retry.
      if (errorRow.ok && errorRow.value !== null) return null;
      // Skip if locked
      if (locked) return null;

      // Must have real dialog
      const dialogQuality = await readAndAssessDialog(fs, asset.slug, bookId);
      if (!dialogQuality.hasDialog) return null;

      // Must have an audio file
      const audioFile = findAudioFile(files, asset.slug);
      if (!audioFile) return null;

      return {
        assetId: asset.slug,
        assetDir: manifest.path,
        audioPath: join(manifest.path, audioFile.name),
        audioFilename: audioFile.name,
      };
    })
  );
  return candidates.filter((c): c is TranscribeAction => c !== null);
}
