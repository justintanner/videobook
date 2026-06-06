import type { VideocityFs, AssetEntry, AssetManifestFile } from "vc-engine";
import { computeAssetStatus, QUEUED_TASK_ID } from "vc-engine";
import { z } from "zod";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createKie, KieError } from "@apicity/kie";
import type { KieTaskInfo, KieTaskInfoData } from "@apicity/kie";
import { createXai, XaiError } from "@apicity/xai";
import { createAlibaba, AlibabaError } from "@apicity/alibaba";
import { createFal, FalError } from "@apicity/fal";
import { queue } from "../queue.js";
import { getApiKey } from "../api-key.js";
import {
  findVideoFile,
  findAudioFile,
  findPrimaryMediaFile,
  RENDER_ORIENTATIONS as MEDIA_RENDER_ORIENTATIONS,
} from "vc-engine";
import { readAndAssessDialog } from "../dialog-quality.js";
import { failPendingTaskAndLog } from "../jobs/task-failure.js";
import type { PendingTask } from "vc-engine";
import { findUnprocessedUploads, processExternalUpload } from "../jobs/process-upload.js";
import { extractWaveform, probeVideo } from "../ffmpeg.js";
import type { ToolDef } from "./tool-def.js";
import { submitQueuedKieTask } from "../jobs/kie-paygate.js";

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

export type SyncAsset = {
  id: string;
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
  waveform: number[] | null;
  frame_dirs: Record<string, string[]>;
  /** Unix seconds when user first viewed this asset, or null if still unseen.
   *  Drives the sidebar's NEW badge. */
  seen_at: number | null;
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

function isKiePendingTask(task: PendingTask): boolean {
  return !task.taskType.startsWith("xai_") && !task.taskType.startsWith("fal_") && !task.taskType.startsWith("alibaba_");
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
  projectSlug: string,
  assetId: string,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!directories) return out;
  for (const [dir, fileList] of Object.entries(directories)) {
    if (!dir.endsWith("_frames")) continue;
    out[dir] = fileList
      .filter((f) => f.endsWith(".jpg"))
      .sort()
      .map((f) => `/files/${projectSlug}/${assetId}/${dir}/${f}`);
  }
  return out;
}

async function readOrExtractWaveform(
  fs: VideocityFs,
  assetId: string,
  projectSlug: string,
  assetDir: string,
  videoFilename: string | null,
): Promise<number[] | null> {
  const existing = await fs.readAudioWaveform(assetId, projectSlug);
  if (existing.ok) return existing.value.peaks;
  if (!videoFilename || !/^original\.(mp4|mov)$/i.test(videoFilename)) {
    return null;
  }
  try {
    const peaks = await extractWaveform(join(assetDir, videoFilename));
    if (peaks.length === 0) return null;
    const wavResult = await fs.writeAudioWaveform(assetId, peaks, projectSlug);
    if (!wavResult.ok) {
      // Persist failed but the in-memory peaks are still valid for this sync
      // response. Log so the next sync retries lazy regeneration cleanly.
      console.error(`[sync] writeAudioWaveform failed for ${assetId}: ${wavResult.error.message}`);
    }
    return peaks;
  } catch {
    return null;
  }
}

const PARTIAL_DOWNLOAD_RE = /\.(mp4|mov)\.part$/i;

export const RENDER_ORIENTATIONS = MEDIA_RENDER_ORIENTATIONS;

export async function readRenderSettings(
  fs: VideocityFs, assetId: string, projectSlug: string, orientations: string[],
): Promise<Record<string, Record<string, unknown>>> {
  const result: Record<string, Record<string, unknown>> = {};
  await Promise.all(orientations.map(async (orient) => {
    const meta = await fs.readMetadata<Record<string, unknown>>(assetId, `${orient}.render`, projectSlug);
    if (meta.ok) result[orient] = meta.value;
  }));
  return result;
}

const BASE_DEFAULTS: Record<string, unknown> = {
  subtitlesEnabled: true,
  position: "bottom",
  fontSize: "medium",
  audioFadeIn: 150,
  audioFadeOut: 100,
  audioVolume: 100,
  osgImagePath: null,
  osgAssetId: null,
  osgPosition: "top-right",
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
  fs: VideocityFs, assetId: string, projectSlug: string, targetOrientation: string,
): Promise<Record<string, unknown>> {
  const defaults = { ...BASE_DEFAULTS, ...(ORIENTATION_OVERRIDES[targetOrientation] ?? ORIENTATION_OVERRIDES.landscape) };
  // Read every orientation's render metadata in parallel, then pick the
  // target's own metadata first or fall back to any other orientation.
  const tryOrder = [targetOrientation, ...RENDER_ORIENTATIONS.filter((o) => o !== targetOrientation)];
  const metas = await Promise.all(
    tryOrder.map((orient) =>
      fs.readMetadata<Record<string, unknown>>(assetId, `${orient}.render`, projectSlug),
    ),
  );
  for (const meta of metas) {
    if (meta.ok) return { ...defaults, ...meta.value };
  }
  const recs = await readAnalysisRecommendations(fs, assetId, projectSlug);
  return { ...defaults, ...recs };
}

const VALID_SUB_POSITIONS = new Set(["top", "middle", "bottom"]);
const VALID_OSG_POSITIONS = new Set(["top-left", "top-right", "bottom-left", "bottom-right"]);

async function readAnalysisRecommendations(
  fs: VideocityFs, assetId: string, projectSlug: string,
): Promise<Record<string, unknown>> {
  const result = await fs.readFile(assetId, ".original.analysis.json", projectSlug);
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

    const burned = analysis.burnedInSubtitles as { detected?: boolean } | null;
    recs.subtitlesEnabled = !(burned && burned.detected === true);

    return recs;
  } catch {
    return {};
  }
}

// Content fingerprint covering every file in the asset directory. Changes
// whenever any file is added, removed, resized, or rewritten, so every URL
// derived from an asset's filePath (including alternate-orientation renders
// like portrait.mp4 / landscape.mp4) invalidates together. Cheap: no file
// reads — just hashes (name, size, mtime) tuples.
function computeAssetFingerprint(files: AssetManifestFile[]): string {
  if (files.length === 0) return "";
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const hash = createHash("sha1");
  for (const f of sorted) {
    hash.update(f.name);
    hash.update("\0");
    hash.update(String(f.size_bytes ?? 0));
    hash.update("\0");
    hash.update(String(f.mtimeMs ?? 0));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

function renderedOrientationsFor(
  files: AssetManifestFile[],
  assetId: string,
): string[] {
  const fileSet = new Set(files.map((f) => f.name));
  if (assetId === "final") {
    return RENDER_ORIENTATIONS.filter((o) => fileSet.has(`timeline_${o}.mp4`));
  }
  return RENDER_ORIENTATIONS.filter((o) => fileSet.has(`${o}.mp4`));
}

export async function buildAssetList(fs: VideocityFs, project_slug: string, sort?: "newest" | "oldest"): Promise<SyncAsset[]> {
  const assets = await fs.listAssets(project_slug, { sort });
  return Promise.all(
    assets.map(async (a): Promise<SyncAsset> => {
      const [manifestResult, lockData, pendingTask, generationError, metadata, assetWorkRow] = await Promise.all([
        fs.getManifest(a.id, project_slug, { includeDotfiles: true }),
        fs.getLockData(a.path),
        fs.pendingTasks.read(project_slug, a.id),
        fs.generationErrors.read(project_slug, a.id),
        fs.readMetadata<Record<string, unknown>>(a.id, "original", project_slug),
        fs.assetWork.read(project_slug, a.id),
      ]);

      // If the asset directory disappeared between listAssets and getManifest,
      // surface an empty-but-error placeholder rather than throwing.
      const files: AssetManifestFile[] = manifestResult.ok ? manifestResult.value.files : [];
      const directories = manifestResult.ok ? manifestResult.value.directories : undefined;

      const mediaFile = findPrimaryMediaFile(files, a.id);
      const fileNames = new Set(files.map((f) => f.name));
      const hasThumbnail = fileNames.has("original.jpg");
      const renders = renderedOrientationsFor(files, a.id);
      const hasPartFile = files.some((f) => PARTIAL_DOWNLOAD_RE.test(f.name));
      const frameDirs = buildFrameDirs(directories, project_slug, a.id);
      const waveform = await readOrExtractWaveform(
        fs,
        a.id,
        project_slug,
        a.path,
        mediaFile?.name ?? null,
      );

      // Cache-bust media URLs so browsers refetch after trim / re-encode / re-render.
      // For vid- and img- assets, use a content fingerprint covering the whole
      // asset directory: orientation re-renders (portrait/landscape/square.mp4)
      // touch alternate files but not original.mp4, so a primary-mtime cache
      // key would leave alternate-orientation URLs cached and stale.
      const useFingerprint = a.id.startsWith("vid-") || a.id.startsWith("img-");
      let cacheBust = '';
      if (useFingerprint) {
        const fp = computeAssetFingerprint(files);
        if (fp) cacheBust = `?v=${fp}`;
      } else {
        const mediaMtime = mediaFile?.mtimeMs ?? 0;
        if (mediaMtime) cacheBust = `?v=${Math.floor(mediaMtime)}`;
      }
      const media_url = mediaFile
        ? `/files/${project_slug}/${a.id}/${mediaFile.name}${cacheBust}`
        : null;
      const isImage = a.type === "image";
      const thumbnail_url = hasThumbnail
        ? `/files/${project_slug}/${a.id}/original.jpg${cacheBust}`
        : isImage ? media_url : null;

      // Status derivation lives in vc-engine (`computeAssetStatus`). We pass
      // the asset-type-aware primary media name we already computed so the
      // engine doesn't have to redo media-type heuristics.
      const status = computeAssetStatus({
        assetId: a.id,
        fileNames,
        primaryMediaName: mediaFile?.name ?? null,
        hasPartFile,
        lockData,
        pendingTask: pendingTask.ok ? pendingTask.value : null,
        generationError: generationError.ok ? generationError.value : null,
        assetRow:
          assetWorkRow.ok && assetWorkRow.value
            ? {
                status: assetWorkRow.value.status,
                meta: assetWorkRow.value.meta,
              }
            : null,
      });

      const meta = metadata.ok ? metadata.value : null;

      // Backfill duration if missing from metadata
      let duration = (meta?.duration as number) ?? null;
      if (duration === null && mediaFile && /\.(mp4|mov)$/i.test(mediaFile.name)) {
        try {
          const probe = await probeVideo(join(a.path, mediaFile.name));
          duration = probe.duration;
          // Persist so we don't re-probe next time
          if (metadata.ok) {
            await fs.writeMetadata(a.id, "original", { ...metadata.value, duration }, project_slug);
          }
        } catch { /* non-fatal */ }
      }

      // Read markdown content for script (original.md) and plan (index.md) assets
      let prompt = (meta?.prompt as string) ?? null;
      if (!prompt && a.type === "script") {
        const md = await fs.readFile(a.id, "original.md", project_slug);
        if (md.ok) prompt = md.value.toString();
      }
      if (!prompt && a.type === "plan") {
        const md = await fs.readFile(a.id, "index.md", project_slug);
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
        ...a,
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
        waveform,
        frame_dirs: frameDirs,
        seen_at: assetWorkRow.ok && assetWorkRow.value ? assetWorkRow.value.seenAt : null,
      };
    }),
  );
}

export async function performSync(fs: VideocityFs, project_slug: string): Promise<SyncResult> {
  const result: SyncResult = {
    pending: [], completed: [], failed: [],
    external_uploads: [], auto_render: [], auto_transcribe: [],
  };

  // Single listAssets call, shared by all consumers
  const assets = await fs.listAssets(project_slug);

  // Run all discovery steps in parallel
  const [uploads, tasksRes, transcribeActions, failuresRes] = await Promise.all([
    findUnprocessedUploads(fs, project_slug, assets),
    fs.pendingTasks.findAll(project_slug),
    findAutoTranscribeActions(fs, project_slug, assets),
    fs.generationErrors.findAll(project_slug),
  ]);
  const tasks: PendingTask[] = tasksRes.ok ? tasksRes.value : [];
  const persistedFailures = failuresRes.ok ? failuresRes.value : [];

  // Process external uploads
  for (const upload of uploads) {
    await processExternalUpload(fs, upload, project_slug);
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
        t = await submitQueuedKieTask(fs, project_slug, t);
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Queued KIE submit failed";
        const prompt = metaPrompt(t.meta);
        result.failed.push({ assetId: t.assetId, taskType: t.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        await failPendingTaskAndLog(fs, project_slug, t.assetId, t.taskId, { message: failMsg, prompt });
        continue;
      }
    }
    const ageMs = nowMs - t.createdAt * 1000;
    if (t.completing !== true && Number.isFinite(ageMs) && ageMs > PENDING_TASK_TIMEOUT_MS) {
      const ageMinutes = Math.round(ageMs / 60000);
      const failMsg = `Task timed out after ${ageMinutes}m without reaching success or fail state`;
      const prompt = metaPrompt(t.meta);
      result.failed.push({ assetId: t.assetId, taskType: t.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
      await failPendingTaskAndLog(fs, project_slug, t.assetId, t.taskId, { message: failMsg, prompt });
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
    result.pending.push({ assetId: t.assetId, taskType: t.taskType, progress: 100, state: "success", prompt: metaPrompt(t.meta), startedAt: Math.round(t.createdAt * 1000) });
  }

  const pollableTasks = activeTasks.filter((t) => t.completing !== true);

  await Promise.all(
    pollableTasks.map(async (task) => {
      const ownerId = await fs.pendingTasks.getOwner(project_slug, task.assetId, task.taskId);
      if (ownerId) {
        await fs.assetWork.renew(project_slug, task.assetId, ownerId, 30 * 60_000);
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
        await processSyncedTask(fs, task, taskInfo, result, project_slug);
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Poll failed";
        const prompt = metaPrompt(task.meta);
        result.failed.push({ assetId: task.assetId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof KieError) {
          // TS narrowing on `e` is unreliable here, use an explicit assertion.
          const kieErr = e as KieError;
          if (kieErr.status >= 400 && kieErr.status < 500) {
            await failPendingTaskAndLog(fs, project_slug, task.assetId, task.taskId, { message: failMsg, prompt });
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
          const assetDirResult = await fs.resolveAssetDir(task.assetId, project_slug);
          if (!assetDirResult.ok) {
            await failPendingTaskAndLog(fs, project_slug, task.assetId, task.taskId, { message: `Asset not found: ${task.assetId}`, prompt });
            return;
          }
          await fs.pendingTasks.markCompleting(project_slug, task.assetId);
          const jobId = `complete-xai-${task.assetId}-${Date.now()}`;
          await queue.enqueue(jobId, {
            type: "complete_kie_task",
            taskId: task.taskId,
            taskType: task.taskType,
            assetId: task.assetId,
            assetDir: assetDirResult.value,
            projectSlug: project_slug,
            meta: task.meta,
            resultUrls: [videoResult.video.url],
          } as unknown as Record<string, unknown>);
          result.completed.push({ assetId: task.assetId, taskType: task.taskType, jobId });
        } else if (videoResult.status === "failed" || videoResult.status === "expired") {
          const failMsg = `xAI task ${videoResult.status}`;
          result.failed.push({ assetId: task.assetId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
          await failPendingTaskAndLog(fs, project_slug, task.assetId, task.taskId, { message: failMsg, prompt });
        } else {
          result.pending.push({
            assetId: task.assetId,
            taskType: task.taskType,
            progress: videoResult.progress ?? 0,
            state: videoResult.status,
            prompt,
            startedAt: Math.round(task.createdAt * 1000),
          });
        }
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Poll failed";
        result.failed.push({ assetId: task.assetId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof XaiError) {
          const xaiErr = e as XaiError;
          if (xaiErr.status >= 400 && xaiErr.status < 500) {
            await failPendingTaskAndLog(fs, project_slug, task.assetId, task.taskId, { message: failMsg, prompt });
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
          const assetDirResult = await fs.resolveAssetDir(task.assetId, project_slug);
          if (!assetDirResult.ok) {
            await failPendingTaskAndLog(fs, project_slug, task.assetId, task.taskId, { message: `Asset not found: ${task.assetId}`, prompt });
            return;
          }
          await fs.pendingTasks.markCompleting(project_slug, task.assetId);
          const jobId = `complete-alibaba-${task.assetId}-${Date.now()}`;

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
            assetId: task.assetId,
            assetDir: assetDirResult.value,
            projectSlug: project_slug,
            meta: task.meta,
            resultUrls,
          } as unknown as Record<string, unknown>);
          result.completed.push({ assetId: task.assetId, taskType: task.taskType, jobId });
        } else if (status === "FAILED" || status === "CANCELED") {
          const failMsg = taskStatus.output.message ?? `Alibaba task ${status}`;
          const code = taskStatus.output.code;
          result.failed.push({ assetId: task.assetId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
          await failPendingTaskAndLog(fs, project_slug, task.assetId, task.taskId, {
            message: failMsg,
            prompt,
            ...(code !== undefined ? { failCode: code } : {}),
          });
        } else {
          result.pending.push({
            assetId: task.assetId,
            taskType: task.taskType,
            progress: 0,
            state: status.toLowerCase(),
            prompt,
            startedAt: Math.round(task.createdAt * 1000),
          });
        }
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Poll failed";
        result.failed.push({ assetId: task.assetId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof AlibabaError) {
          const alibabaErr = e as AlibabaError;
          if (alibabaErr.status >= 400 && alibabaErr.status < 500) {
            await failPendingTaskAndLog(fs, project_slug, task.assetId, task.taskId, { message: failMsg, prompt });
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
        result.failed.push({ assetId: task.assetId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        await failPendingTaskAndLog(fs, project_slug, task.assetId, task.taskId, { message: failMsg, prompt });
        return;
      }
      const statusEndpointId = falNamespace(endpointId);
      try {
        const status = await provider.v1.queue.status({ endpoint_id: statusEndpointId, request_id: task.taskId });
        if (status.status === "COMPLETED") {
          if (status.error) {
            const failMsg = status.error;
            result.failed.push({ assetId: task.assetId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
            await failPendingTaskAndLog(fs, project_slug, task.assetId, task.taskId, { message: failMsg, prompt });
            return;
          }
          const assetDirResult = await fs.resolveAssetDir(task.assetId, project_slug);
          if (!assetDirResult.ok) {
            await failPendingTaskAndLog(fs, project_slug, task.assetId, task.taskId, { message: `Asset not found: ${task.assetId}`, prompt });
            return;
          }
          const resultObject = await provider.v1.queue.result({ endpoint_id: statusEndpointId, request_id: task.taskId });
          // Mark the pending task as completing BEFORE enqueueing so any
          // overlapping sync poll skips it instead of enqueueing a duplicate.
          await fs.pendingTasks.markCompleting(project_slug, task.assetId);
          const jobId = `complete-fal-${task.assetId}-${Date.now()}`;
          await queue.enqueue(jobId, {
            type: "complete_kie_task",
            taskId: task.taskId,
            taskType: task.taskType,
            assetId: task.assetId,
            assetDir: assetDirResult.value,
            projectSlug: project_slug,
            meta: task.meta,
            resultUrls: [],
            resultObject,
          } as unknown as Record<string, unknown>);
          result.completed.push({ assetId: task.assetId, taskType: task.taskType, jobId });
        } else {
          result.pending.push({
            assetId: task.assetId,
            taskType: task.taskType,
            progress: 0,
            state: status.status.toLowerCase(),
            prompt,
            startedAt: Math.round(task.createdAt * 1000),
          });
        }
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Poll failed";
        result.failed.push({ assetId: task.assetId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof FalError) {
          const falErr = e as FalError;
          if (falErr.status >= 400 && falErr.status < 500) {
            await failPendingTaskAndLog(fs, project_slug, task.assetId, task.taskId, { message: failMsg, prompt });
          }
        }
      }
    }));
  }

  // Merge persisted failures (.generation-error.json) that weren't already
  // reported by this poll and don't have an active pending task (retry in progress).
  const reportedAssetIds = new Set(result.failed.map((f) => f.assetId));
  const pendingAssetIds = new Set(tasks.map((t) => t.assetId));
  for (const failure of persistedFailures) {
    if (!reportedAssetIds.has(failure.assetId) && !pendingAssetIds.has(failure.assetId)) {
      result.failed.push({
        assetId: failure.assetId,
        taskType: "",
        failMsg: failure.message,
        failedAt: new Date(failure.failedAt * 1000).toISOString(),
        prompt: failure.prompt ?? null,
      });
    }
  }

  // Auto-render and auto-analyze are intentionally NOT performed here.
  // Renders fire from explicit /render or assign_slot (lazy on slot drop).
  // gpt-5.4 analysis fires from assign_slot (lazy on slot drop) and
  // gpt-4o-mini speech-to-text fires eagerly from process_video on upload.
  // Sync only retries the ElevenLabs transcribe step (auto_transcribe), which
  // is gated on .original.analysis.json already existing — i.e. only kicks in
  // for assets the user has actually slotted.

  // Auto-pipeline: advance analyzed videos through transcription
  for (const action of transcribeActions) {
    const jobId = `auto-transcribe-${action.assetId}-${Date.now()}`;
    await queue.enqueue(jobId, {
      type: "transcribe",
      audioPath: action.audioPath,
      audioFilename: action.audioFilename,
      tagAudioEvents: true,
      diarize: true,
      assetId: action.assetId,
      assetDir: action.assetDir,
      projectSlug: project_slug,
    } as unknown as Record<string, unknown>);
    result.auto_transcribe.push({ assetId: action.assetId, jobId });
  }

  return result;
}

export function syncDef(fs: VideocityFs): ToolDef {
  return {
    name: "sync",
    description: "Check all pending KIE tasks for a project, enqueue completion jobs for finished ones, and detect externally-placed files (via Finder/CLI) that need processing. Call periodically after triggering generation tools or adding files externally.",
    schema: {
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };
      const syncResult = await performSync(fs, project_slug);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(syncResult) }],
      };
    },
  };
}

async function processSyncedTask(
  fs: VideocityFs,
  task: PendingTask,
  taskInfo: KieTaskInfo,
  result: SyncResult,
  projectSlug: string,
): Promise<void> {
  const data = taskInfo.data;
  const prompt = metaPrompt(task.meta);
  if (data?.state === "success") {
    const assetDirResult = await fs.resolveAssetDir(task.assetId, projectSlug);
    if (!assetDirResult.ok) {
      await failPendingTaskAndLog(fs, projectSlug, task.assetId, task.taskId, { message: `Asset not found: ${task.assetId}`, prompt });
      return;
    }

    const jobId = `complete-${task.taskType}-${task.assetId}-${Date.now()}`;

    const parsed = JSON.parse(data.resultJson ?? "{}") as {
      resultUrls?: string[];
      resultObject?: Record<string, unknown>;
    };

    // Mark the pending task as completing BEFORE enqueueing so any
    // overlapping sync poll skips it instead of enqueueing a duplicate.
    await fs.pendingTasks.markCompleting(projectSlug, task.assetId);

    await queue.enqueue(jobId, {
      type: "complete_kie_task",
      taskId: task.taskId,
      taskType: task.taskType,
      assetId: task.assetId,
      assetDir: assetDirResult.value,
      projectSlug,
      meta: task.meta,
      resultUrls: parsed.resultUrls ?? [],
      resultObject: parsed.resultObject,
    } as unknown as Record<string, unknown>);

    result.completed.push({ assetId: task.assetId, taskType: task.taskType, jobId });
  } else if (data?.state === "fail") {
    const failMsg = data.failMsg ?? "unknown error";
    // A kie 500 is only retryable while the task is still in flight; once it
    // has terminally completed, surface the failure instead of stranding the
    // asset as "working" until the 30m sync timeout. See isTransientKieFailure.
    if (isTransientKieFailure(data)) {
      result.pending.push({
        assetId: task.assetId,
        taskType: task.taskType,
        progress: data.progress,
        state: data.state,
        prompt,
        startedAt: Math.round(task.createdAt * 1000),
      });
      return;
    }
    result.failed.push({
      assetId: task.assetId,
      taskType: task.taskType,
      failMsg,
      failedAt: new Date().toISOString(),
      prompt,
    });
    await failPendingTaskAndLog(fs, projectSlug, task.assetId, task.taskId, {
      message: failMsg,
      prompt,
      ...(data.failCode !== undefined ? { failCode: data.failCode } : {}),
    });
  } else {
    result.pending.push({
      assetId: task.assetId,
      taskType: task.taskType,
      progress: data?.progress,
      state: data?.state,
      prompt,
      startedAt: Math.round(task.createdAt * 1000),
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
  fs: VideocityFs,
  projectSlug: string,
  assets: AssetEntry[],
  orientation: string,
): Promise<RenderAction[]> {
  const candidates = await Promise.all(
    assets.filter((a) => a.id.startsWith("vid-")).map(async (asset): Promise<RenderAction | null> => {
      const manifestResult = await fs.getManifest(asset.id, projectSlug, { includeDotfiles: true });
      if (!manifestResult.ok) return null;

      const manifest = manifestResult.value;
      const files = manifest.files;
      const fileNames = new Set(files.map((f) => f.name));

      // Skip: already rendered for target orientation
      if (fileNames.has(`.${orientation}.render.json`)) return null;
      // Skip: process_video incomplete
      if (!fileNames.has(".original.analysis.json")) return null;

      // Skip if speech-to-text analysis not yet complete (unless video has no audio)
      if (!fileNames.has(".analysis.gpt4otrans.json")) {
        const meta = await fs.readMetadata<{ hasAudio?: boolean }>(asset.id, "original", projectSlug);
        if (meta.ok && meta.value.hasAudio) return null;
      }

      // Skip if a KIE task is in flight on this asset (its completion will
      // auto-render). The transcribe job auto-renders directly after writing
      // elevenlabs.json so it does not need its own sidecar to gate this.
      if (fileNames.has(".kie-task.json")) return null;

      // For videos with dialog, wait for ElevenLabs transcription
      const dialogQuality = await readAndAssessDialog(fs, asset.id, projectSlug);
      if (dialogQuality.hasDialog && !fileNames.has("elevenlabs.json")) return null;

      const videoFile = findVideoFile(files);
      if (videoFile && !await fs.isLocked(manifest.path)) {
        return {
          assetId: asset.id,
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
  fs: VideocityFs,
  projectSlug: string,
  assets: AssetEntry[],
): Promise<TranscribeAction[]> {
  if (!process.env.ELEVENLABS_API_KEY) return [];

  const candidates = await Promise.all(
    assets.filter((a) => a.id.startsWith("vid-")).map(async (asset): Promise<TranscribeAction | null> => {
      const [manifestResult, locked, errorRow] = await Promise.all([
        fs.getManifest(asset.id, projectSlug, { includeDotfiles: true }),
        fs.isLocked(asset.path),
        fs.generationErrors.read(projectSlug, asset.id),
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
      const dialogQuality = await readAndAssessDialog(fs, asset.id, projectSlug);
      if (!dialogQuality.hasDialog) return null;

      // Must have an audio file
      const audioFile = findAudioFile(files, asset.id);
      if (!audioFile) return null;

      return {
        assetId: asset.id,
        assetDir: manifest.path,
        audioPath: join(manifest.path, audioFile.name),
        audioFilename: audioFile.name,
      };
    })
  );
  return candidates.filter((c): c is TranscribeAction => c !== null);
}
