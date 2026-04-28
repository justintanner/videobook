import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, AssetEntry, AssetManifestFile } from "clipfirst-fs";
import { z } from "zod";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { kie, KieError } from "@apicity/kie";
import type { KieTaskInfo } from "@apicity/kie";
import { xai, XaiError } from "@apicity/xai";
import { alibaba, AlibabaError } from "@apicity/alibaba";
import { fal, FalError } from "@apicity/fal";
import { queue } from "../queue.js";
import {
  findVideoFile,
  findAudioFile,
  findPrimaryMediaFile,
  RENDER_ORIENTATIONS as MEDIA_RENDER_ORIENTATIONS,
} from "../media-files.js";
import { readAndAssessDialog } from "../dialog-quality.js";
import { findPendingTasks, findFailedAssets, readPendingTask, failPendingTask, markTaskCompleting, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { PendingKieTask } from "../jobs/pending-task.js";
import { findUnprocessedUploads, processExternalUpload } from "../jobs/process-upload.js";
import { extractWaveform, probeVideo } from "../ffmpeg.js";
import type { ToolDef } from "./tool-def.js";

/** Upper bound on how long a pending task may sit without reaching success/fail
 *  before sync ages it out. Guards against providers (observed with Kie's
 *  elevenlabs/speech-to-text endpoint) that leave jobs in an intermediate
 *  "waiting" state indefinitely. */
const PENDING_TASK_TIMEOUT_MS = 30 * 60 * 1000;

export type SyncAsset = {
  id: string;
  type: string;
  created_at: string;
  path: string;
  media_url: string | null;
  thumbnail_url: string | null;
  status: string;
  width: number | null;
  height: number | null;
  origin: string | null;
  prompt: string | null;
  renders: string[];
  duration: number | null;
  waveform: number[] | null;
  frame_dirs: Record<string, string[]>;
};

export type SyncResult = {
  pending: Array<{ assetId: string; taskType: string; progress: number; state: string; prompt: string | null }>;
  completed: Array<{ assetId: string; taskType: string; jobId: string }>;
  failed: Array<{ assetId: string; taskType: string; failMsg: string; failedAt: string; prompt: string | null }>;
  external_uploads: Array<{ assetId: string; mediaFilename: string }>;
  auto_render: Array<{ assetId: string; jobId: string }>;
  auto_transcribe: Array<{ assetId: string; jobId: string }>;
  auto_speech_to_text: Array<{ assetId: string; jobId: string }>;
  auto_analyze: Array<{ assetId: string; jobId: string }>;
};

function metaPrompt(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  const p = meta.prompt;
  return typeof p === "string" ? p : null;
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
  fs: ClipfirstFs,
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

const RENDER_METADATA_RE = /^\.(portrait|landscape|square)\.render\.json$/;
const PARTIAL_DOWNLOAD_RE = /\.(mp4|mov)\.part$/i;

export const RENDER_ORIENTATIONS = MEDIA_RENDER_ORIENTATIONS;

export async function readRenderSettings(
  fs: ClipfirstFs, assetId: string, projectSlug: string, orientations: string[],
): Promise<Record<string, Record<string, unknown>>> {
  const result: Record<string, Record<string, unknown>> = {};
  await Promise.all(orientations.map(async (orient) => {
    const meta = await fs.readMetadata<Record<string, unknown>>(assetId, `${orient}.render`, projectSlug);
    if (meta.ok) result[orient] = meta.value;
  }));
  return result;
}

const BASE_DEFAULTS: Record<string, unknown> = {
  subtitlesEnabled: false,
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
  fs: ClipfirstFs, assetId: string, projectSlug: string, targetOrientation: string,
): Promise<Record<string, unknown>> {
  const defaults = { ...BASE_DEFAULTS, ...(ORIENTATION_OVERRIDES[targetOrientation] ?? ORIENTATION_OVERRIDES.landscape) };
  // Try target orientation first, then fall back to any other orientation
  const tryOrder = [targetOrientation, ...RENDER_ORIENTATIONS.filter((o) => o !== targetOrientation)];
  for (const orient of tryOrder) {
    const meta = await fs.readMetadata<Record<string, unknown>>(assetId, `${orient}.render`, projectSlug);
    if (meta.ok) {
      const merged = { ...defaults, ...meta.value };
      // Migrate old "tikdance" → "impact"
      if (merged.highlightStyle === "tikdance") merged.highlightStyle = "impact";
      return merged;
    }
  }
  const recs = await readAnalysisRecommendations(fs, assetId, projectSlug);
  return { ...defaults, ...recs };
}

const VALID_SUB_POSITIONS = new Set(["top", "middle", "bottom"]);
const VALID_OSG_POSITIONS = new Set(["top-left", "top-right", "bottom-left", "bottom-right"]);

export async function readAnalysisRecommendations(
  fs: ClipfirstFs, assetId: string, projectSlug: string,
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

export async function buildAssetList(fs: ClipfirstFs, project_slug: string, sort?: "newest" | "oldest"): Promise<SyncAsset[]> {
  const assets = await fs.listAssets(project_slug, { sort });
  return Promise.all(
    assets.map(async (a): Promise<SyncAsset> => {
      const [manifestResult, lockData, pendingTask, metadata] = await Promise.all([
        fs.getManifest(a.id, project_slug, { includeDotfiles: true }),
        fs.getLockData(a.path),
        readPendingTask(fs, a.id, project_slug),
        fs.readMetadata<Record<string, unknown>>(a.id, "original", project_slug),
      ]);

      // If the asset directory disappeared between listAssets and getManifest,
      // surface an empty-but-error placeholder rather than throwing.
      const files: AssetManifestFile[] = manifestResult.ok ? manifestResult.value.files : [];
      const directories = manifestResult.ok ? manifestResult.value.directories : undefined;

      const mediaFile = findPrimaryMediaFile(files, a.id);
      const fileNames = new Set(files.map((f) => f.name));
      const hasThumbnail = fileNames.has("original.jpg");
      const rendered = files.some((f) => RENDER_METADATA_RE.test(f.name));
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

      // First matching rule wins. Derives the user-visible state from the
      // single source of truth on disk: lock state for transformation jobs,
      // .kie-task.json for external tasks, sidecar markers for the gpt-4o
      // pipeline (processing/analyzing), and pure file presence for the
      // terminal states (ready/error). No whitelist gate — every vid- shows
      // its full lifecycle in the sidebar from the moment it's created.
      const hasGenerationError = fileNames.has(".generation-error.json");
      const hasOriginalJson = files.some((f) => f.name === ".original.json");
      const hasAnalysisJson = files.some((f) => f.name === ".original.analysis.json");
      const hasProcessingMarker = fileNames.has(".processing.json");
      const hasAnalyzingMarker = fileNames.has(".analyzing.json");

      let status: string;
      const isLockActive = lockData && (Date.now() / 1000) < lockData.timeout_at;
      if (isLockActive) {
        status = (lockData.state as string) ?? "loading";
      } else if (pendingTask) {
        status = pendingTask.taskType === "transcribe"
          ? "transcribing"
          : pendingTask.taskType === "isolate_vocals"
            ? "isolating"
            : "generating";
      } else if (hasProcessingMarker) {
        status = "processing";
      } else if (hasAnalyzingMarker) {
        status = "analyzing";
      } else if (hasPartFile && a.id.startsWith("vid-") && (!mediaFile || /\.(jpe?g|png|webp)$/i.test(mediaFile.name))) {
        // Video asset with a .part file but no actual video = failed download
        // (original.jpg thumbnail may exist from OG image, but that's not a real media file for a video)
        status = "error";
      } else if (mediaFile) {
        if (hasGenerationError) {
          status = "error";
        } else if (a.id === "final") {
          status = "ready";
        } else if (a.id.startsWith("vid-") && !hasOriginalJson) {
          // Pipeline owes work — process_video hasn't written .original.json
          // yet (sidecar marker may not have appeared yet either, e.g. just
          // after upload before the runner picked up the job).
          status = "processing";
        } else if (a.id.startsWith("vid-") && !hasAnalysisJson) {
          // .original.json exists but analyze_video hasn't run.
          status = "analyzing";
        } else if (rendered) {
          status = "ready";
        } else {
          status = "ready";
        }
      } else if (hasPartFile) {
        status = "error";
      } else {
        // No media file and no pending task — orphaned asset from a failed generation
        status = "error";
      }

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

      // Read script content from original.md for script assets
      let prompt = (meta?.prompt as string) ?? null;
      if (!prompt && a.type === "script") {
        const md = await fs.readFile(a.id, "original.md", project_slug);
        if (md.ok) prompt = md.value.toString();
      }

      return {
        ...a,
        media_url,
        thumbnail_url,
        status,
        width: (meta?.width as number) ?? null,
        height: (meta?.height as number) ?? null,
        origin: (meta?.origin as string) ?? null,
        prompt,
        renders,
        duration,
        waveform,
        frame_dirs: frameDirs,
      };
    }),
  );
}

export async function performSync(fs: ClipfirstFs, project_slug: string): Promise<SyncResult> {
  const result: SyncResult = {
    pending: [], completed: [], failed: [],
    external_uploads: [], auto_render: [], auto_transcribe: [], auto_speech_to_text: [], auto_analyze: [],
  };

  // Single listAssets call, shared by all consumers
  const assets = await fs.listAssets(project_slug);

  // Run all discovery steps in parallel
  const [uploads, tasks, transcribeActions, sttActions, analyzeActions, persistedFailures] = await Promise.all([
    findUnprocessedUploads(fs, project_slug, assets),
    findPendingTasks(fs, project_slug, assets),
    findAutoTranscribeActions(fs, project_slug, assets),
    findAutoSpeechToTextActions(fs, project_slug, assets),
    findAutoAnalyzeActions(fs, project_slug, assets),
    findFailedAssets(fs, project_slug, assets),
  ]);

  // Process external uploads
  for (const upload of uploads) {
    await processExternalUpload(fs, upload, project_slug);
    result.external_uploads.push({ assetId: upload.assetId, mediaFilename: upload.mediaFilename });
  }

  // Age out any non-completing task older than PENDING_TASK_TIMEOUT_MS so it
  // stops showing as pending forever. Completing tasks are skipped because the
  // completion job is already dispatched; resetStaleCompletingTasks handles
  // that lane on server restart.
  const nowMs = Date.now();
  const activeTasks: PendingKieTask[] = [];
  for (const t of tasks) {
    const ageMs = nowMs - new Date(t.createdAt).getTime();
    if (t.completing !== true && Number.isFinite(ageMs) && ageMs > PENDING_TASK_TIMEOUT_MS) {
      const ageMinutes = Math.round(ageMs / 60000);
      const failMsg = `Task timed out after ${ageMinutes}m without reaching success or fail state`;
      const prompt = metaPrompt(t.meta);
      result.failed.push({ assetId: t.assetId, taskType: t.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
      await failPendingTask(fs, t.assetId, project_slug, { message: failMsg, prompt });
    } else {
      activeTasks.push(t);
    }
  }

  // Queued tasks (not yet submitted to provider) — report as pending, skip polling
  const queuedTasks = activeTasks.filter((t) => t.taskId === QUEUED_TASK_ID);
  for (const t of queuedTasks) {
    result.pending.push({ assetId: t.assetId, taskType: t.taskType, progress: 0, state: "queued", prompt: metaPrompt(t.meta) });
  }

  // Completing tasks — sync already enqueued a completion job for these on a
  // prior poll. Skip polling + re-enqueueing so duplicate completion jobs
  // don't race on the asset-directory lock. Report as pending with state
  // "success" so the inbox tile shows the DOWNLOAD/PROCESS phase.
  const completingTasks = activeTasks.filter((t) => t.taskId !== QUEUED_TASK_ID && t.completing === true);
  for (const t of completingTasks) {
    result.pending.push({ assetId: t.assetId, taskType: t.taskType, progress: 100, state: "success", prompt: metaPrompt(t.meta) });
  }

  const pollableTasks = activeTasks.filter((t) => t.taskId !== QUEUED_TASK_ID && t.completing !== true);

  // Poll KIE tasks (only if API key is set)
  const kieTasks = pollableTasks.filter((t) => !t.taskType.startsWith("xai_") && !t.taskType.startsWith("fal_") && !t.taskType.startsWith("alibaba_"));
  if (process.env.KIE_API_KEY && kieTasks.length > 0) {
    const provider = kie({ apiKey: process.env.KIE_API_KEY, timeout: 30_000 });

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
            await failPendingTask(fs, task.assetId, project_slug, { message: failMsg, prompt });
          }
        }
      }
    }));
  }

  // Poll xAI tasks (only if API key is set)
  const xaiTasks = pollableTasks.filter((t) => t.taskType.startsWith("xai_"));
  if (process.env.XAI_API_KEY && xaiTasks.length > 0) {
    const provider = xai({ apiKey: process.env.XAI_API_KEY, timeout: 30_000 });

    await Promise.all(xaiTasks.map(async (task) => {
      const prompt = metaPrompt(task.meta);
      try {
        const videoResult = await provider.get.v1.videos(task.taskId);
        if (videoResult.status === "done" && videoResult.video?.url) {
          const assetDirResult = await fs.resolveAssetDir(task.assetId, project_slug);
          if (!assetDirResult.ok) {
            await failPendingTask(fs, task.assetId, project_slug, { message: `Asset not found: ${task.assetId}`, prompt });
            return;
          }
          await markTaskCompleting(fs, task.assetId, project_slug, task);
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
          await failPendingTask(fs, task.assetId, project_slug, { message: failMsg, prompt });
        } else {
          result.pending.push({
            assetId: task.assetId,
            taskType: task.taskType,
            progress: videoResult.progress ?? 0,
            state: videoResult.status,
            prompt,
          });
        }
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Poll failed";
        result.failed.push({ assetId: task.assetId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof XaiError) {
          const xaiErr = e as XaiError;
          if (xaiErr.status >= 400 && xaiErr.status < 500) {
            await failPendingTask(fs, task.assetId, project_slug, { message: failMsg, prompt });
          }
        }
      }
    }));
  }

  // Poll Alibaba tasks (only if API key is set)
  const alibabaTasks = pollableTasks.filter((t) => t.taskType.startsWith("alibaba_"));
  if (process.env.DASHSCOPE_API_KEY && alibabaTasks.length > 0) {
    const provider = alibaba({ apiKey: process.env.DASHSCOPE_API_KEY, timeout: 30_000 });

    await Promise.all(alibabaTasks.map(async (task) => {
      const prompt = metaPrompt(task.meta);
      try {
        const taskStatus = await provider.get.api.v1.tasks(task.taskId);
        const status = taskStatus.output.task_status;

        if (status === "SUCCEEDED") {
          const assetDirResult = await fs.resolveAssetDir(task.assetId, project_slug);
          if (!assetDirResult.ok) {
            await failPendingTask(fs, task.assetId, project_slug, { message: `Asset not found: ${task.assetId}`, prompt });
            return;
          }
          await markTaskCompleting(fs, task.assetId, project_slug, task);
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
          await failPendingTask(fs, task.assetId, project_slug, {
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
          });
        }
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Poll failed";
        result.failed.push({ assetId: task.assetId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof AlibabaError) {
          const alibabaErr = e as AlibabaError;
          if (alibabaErr.status >= 400 && alibabaErr.status < 500) {
            await failPendingTask(fs, task.assetId, project_slug, { message: failMsg, prompt });
          }
        }
      }
    }));
  }

  // Poll FAL tasks (only if API key is set)
  const falTasks = pollableTasks.filter((t) => t.taskType.startsWith("fal_"));
  if (process.env.FAL_API_KEY && falTasks.length > 0) {
    const provider = fal({ apiKey: process.env.FAL_API_KEY, timeout: 30_000 });

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
        await failPendingTask(fs, task.assetId, project_slug, { message: failMsg, prompt });
        return;
      }
      const statusEndpointId = falNamespace(endpointId);
      try {
        const status = await provider.v1.queue.status({ endpoint_id: statusEndpointId, request_id: task.taskId });
        if (status.status === "COMPLETED") {
          if (status.error) {
            const failMsg = status.error;
            result.failed.push({ assetId: task.assetId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
            await failPendingTask(fs, task.assetId, project_slug, { message: failMsg, prompt });
            return;
          }
          const assetDirResult = await fs.resolveAssetDir(task.assetId, project_slug);
          if (!assetDirResult.ok) {
            await failPendingTask(fs, task.assetId, project_slug, { message: `Asset not found: ${task.assetId}`, prompt });
            return;
          }
          const resultObject = await provider.v1.queue.result({ endpoint_id: statusEndpointId, request_id: task.taskId });
          // Mark the pending task as completing BEFORE enqueueing so any
          // overlapping sync poll skips it instead of enqueueing a duplicate.
          await markTaskCompleting(fs, task.assetId, project_slug, task);
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
          });
        }
      } catch (e) {
        const failMsg = e instanceof Error ? e.message : "Poll failed";
        result.failed.push({ assetId: task.assetId, taskType: task.taskType, failMsg, failedAt: new Date().toISOString(), prompt });
        if (e instanceof FalError) {
          const falErr = e as FalError;
          if (falErr.status >= 400 && falErr.status < 500) {
            await failPendingTask(fs, task.assetId, project_slug, { message: failMsg, prompt });
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
      result.failed.push({ assetId: failure.assetId, taskType: "", failMsg: failure.failMsg, failedAt: failure.failedAt, prompt: failure.prompt });
    }
  }

  // Auto-render is intentionally NOT performed here. Renders only fire from
  // explicit /render, assign_slot, or post-transcribe completion (see
  // jobs/complete-kie-task.ts). Sync should never enqueue render_project.

  // Auto-pipeline: retry missing speech-to-text (gpt4otrans) for analyzed videos with audio
  for (const action of sttActions) {
    const jobId = `auto-stt-${action.assetId}-${Date.now()}`;
    await queue.enqueue(jobId, {
      type: "transcribe_video_audio",
      videoPath: action.videoPath,
      assetId: action.assetId,
      assetDir: action.assetDir,
      projectSlug: project_slug,
    } as unknown as Record<string, unknown>);
    result.auto_speech_to_text.push({ assetId: action.assetId, jobId });
  }

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
      autoRender: true,
    } as unknown as Record<string, unknown>);
    result.auto_transcribe.push({ assetId: action.assetId, jobId });
  }

  // Auto-pipeline: retry missing analysis for processed videos
  for (const action of analyzeActions) {
    const jobId = `auto-analyze-${action.assetId}-${Date.now()}`;
    await queue.enqueue(jobId, {
      type: "analyze_video",
      assetId: action.assetId,
      assetDir: action.assetDir,
      projectSlug: project_slug,
      hasTranscription: action.hasTranscription,
    });
    result.auto_analyze.push({ assetId: action.assetId, jobId });
  }

  return result;
}

export function syncDef(fs: ClipfirstFs): ToolDef {
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
  fs: ClipfirstFs,
  task: PendingKieTask,
  taskInfo: KieTaskInfo,
  result: SyncResult,
  projectSlug: string,
): Promise<void> {
  const data = taskInfo.data;
  const prompt = metaPrompt(task.meta);
  if (data?.state === "success") {
    const assetDirResult = await fs.resolveAssetDir(task.assetId, projectSlug);
    if (!assetDirResult.ok) {
      await failPendingTask(fs, task.assetId, projectSlug, { message: `Asset not found: ${task.assetId}`, prompt });
      return;
    }

    const jobId = `complete-${task.taskType}-${task.assetId}-${Date.now()}`;

    const parsed = JSON.parse(data.resultJson ?? "{}") as {
      resultUrls?: string[];
      resultObject?: Record<string, unknown>;
    };

    // Mark the pending task as completing BEFORE enqueueing so any
    // overlapping sync poll skips it instead of enqueueing a duplicate.
    await markTaskCompleting(fs, task.assetId, projectSlug, task);

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
    result.failed.push({
      assetId: task.assetId,
      taskType: task.taskType,
      failMsg,
      failedAt: new Date().toISOString(),
      prompt,
    });
    await failPendingTask(fs, task.assetId, projectSlug, {
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
  fs: ClipfirstFs,
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

      // Skip if transcription is in progress (completeTranscribe will auto-render)
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
  fs: ClipfirstFs,
  projectSlug: string,
  assets: AssetEntry[],
): Promise<TranscribeAction[]> {
  if (!process.env.KIE_API_KEY) return [];

  const candidates = await Promise.all(
    assets.filter((a) => a.id.startsWith("vid-")).map(async (asset): Promise<TranscribeAction | null> => {
      const manifestResult = await fs.getManifest(asset.id, projectSlug, { includeDotfiles: true });
      if (!manifestResult.ok) return null;

      const manifest = manifestResult.value;
      const files = manifest.files;
      const fileNames = new Set(files.map((f) => f.name));

      // Must have completed analysis
      if (!fileNames.has(".original.analysis.json")) return null;
      // Skip if already transcribed
      if (fileNames.has("elevenlabs.json")) return null;
      // Skip if transcription already in progress
      if (fileNames.has(".kie-task.json")) return null;
      // Skip if a prior transcription attempt failed — do not auto-retry.
      // User must manually clear the error to retry.
      if (fileNames.has(".generation-error.json")) return null;
      // Skip if locked
      if (await fs.isLocked(manifest.path)) return null;

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

type SpeechToTextAction = {
  assetId: string;
  assetDir: string;
  videoPath: string;
};

async function findAutoSpeechToTextActions(
  fs: ClipfirstFs,
  projectSlug: string,
  assets: AssetEntry[],
): Promise<SpeechToTextAction[]> {
  if (!process.env.OPENAI_API_KEY) return [];

  const candidates = await Promise.all(
    assets.filter((a) => a.id.startsWith("vid-")).map(async (asset): Promise<SpeechToTextAction | null> => {
      const manifestResult = await fs.getManifest(asset.id, projectSlug, { includeDotfiles: true });
      if (!manifestResult.ok) return null;

      const manifest = manifestResult.value;
      const files = manifest.files;
      const fileNames = new Set(files.map((f) => f.name));

      // Must have completed analysis
      if (!fileNames.has(".original.analysis.json")) return null;
      // Skip if already has speech-to-text
      if (fileNames.has(".analysis.gpt4otrans.json")) return null;
      // Skip if locked
      if (await fs.isLocked(manifest.path)) return null;

      // Must have audio (check metadata)
      const meta = await fs.readMetadata<{ hasAudio?: boolean }>(asset.id, "original", projectSlug);
      if (!meta.ok || !meta.value.hasAudio) return null;

      // Skip if process_video hasn't yet written original.mp3 — analyze_video can
      // write .original.analysis.json from frames alone, so the analysis sidecar
      // doesn't imply mp3 extraction is finished.
      if (!fileNames.has("original.mp3")) return null;

      // Must have a video file (needed to extract audio)
      const videoFile = findVideoFile(files);
      if (!videoFile) return null;

      return {
        assetId: asset.id,
        assetDir: manifest.path,
        videoPath: join(manifest.path, videoFile.name),
      };
    })
  );
  return candidates.filter((c): c is SpeechToTextAction => c !== null);
}

type AnalyzeAction = {
  assetId: string;
  assetDir: string;
  hasTranscription: boolean;
};

async function findAutoAnalyzeActions(
  fs: ClipfirstFs,
  projectSlug: string,
  assets: AssetEntry[],
): Promise<AnalyzeAction[]> {
  // Need at least one API provider for analysis
  if (!process.env.OPENAI_API_KEY && !process.env.KIE_API_KEY) return [];

  const candidates = await Promise.all(
    assets.filter((a) => a.id.startsWith("vid-")).map(async (asset): Promise<AnalyzeAction | null> => {
      const manifest = await fs.getManifest(asset.id, projectSlug, { includeDotfiles: true });
      if (!manifest.ok) return null;
      const fileNames = new Set(manifest.value.files.map((f) => f.name));

      // Skip: already has analysis
      if (fileNames.has(".original.analysis.json")) return null;
      // Skip: process_video hasn't completed (no metadata = no frames)
      if (!fileNames.has(".original.json")) return null;
      // Skip: locked
      if (await fs.isLocked(manifest.value.path)) return null;

      return {
        assetId: asset.id,
        assetDir: manifest.value.path,
        hasTranscription: fileNames.has(".analysis.gpt4otrans.json"),
      };
    })
  );
  return candidates.filter((c): c is AnalyzeAction => c !== null);
}

export function registerSyncTool(server: McpServer, fs: ClipfirstFs): void {
  const def = syncDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
