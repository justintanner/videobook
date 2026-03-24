import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, AssetEntry } from "clipfirst-fs";
import { z } from "zod";
import { join } from "node:path";
import { readdir, readFile, access, stat } from "node:fs/promises";
import { kie } from "@nakedapi/kie";
import type { KieTaskInfo } from "@nakedapi/kie";
import { queue } from "../queue.js";
import { findVideoFile, findAudioFile } from "../media-files.js";
import { readAndAssessDialog } from "../dialog-quality.js";
import { findPendingTasks, readPendingTask } from "../jobs/pending-task.js";
import type { PendingKieTask } from "../jobs/pending-task.js";
import { findUnprocessedUploads, processExternalUpload } from "../jobs/process-upload.js";
import { extractWaveform, probeVideo } from "../ffmpeg.js";
import { writeFile } from "node:fs/promises";
import type { ToolDef } from "./tool-def.js";

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
  pending: Array<{ assetId: string; taskType: string; progress: number; state: string }>;
  completed: Array<{ assetId: string; taskType: string; jobId: string }>;
  failed: Array<{ assetId: string; taskType: string; failMsg: string }>;
  external_uploads: Array<{ assetId: string; mediaFilename: string }>;
  auto_render: Array<{ assetId: string; jobId: string }>;
  auto_transcribe: Array<{ assetId: string; jobId: string }>;
  auto_speech_to_text: Array<{ assetId: string; jobId: string }>;
};

async function findPrimaryMediaFile(assetDir: string): Promise<string | null> {
  try {
    const files = await readdir(assetDir);
    const video = files.find((f) => /^original\.(mp4|mov)$/i.test(f));
    if (video) return video;
    const image = files.find((f) => /^original\.(png|jpe?g|webp)$/i.test(f));
    if (image) return image;
    const audio = files.find((f) => /^original\.(mp3|wav)$/i.test(f));
    if (audio) return audio;
    return files.find((f) => /^original\.md$/i.test(f)) ?? null;
  } catch {
    return null;
  }
}

async function hasPartialDownload(assetDir: string): Promise<boolean> {
  try {
    const files = await readdir(assetDir);
    return files.some((f) => /\.(mp4|mov)\.part$/i.test(f));
  } catch {
    return false;
  }
}

async function findThumbnailFile(assetDir: string): Promise<boolean> {
  try {
    await access(join(assetDir, "original.jpg"));
    return true;
  } catch {
    return false;
  }
}

async function isWhitelisted(assetDir: string): Promise<boolean> {
  try {
    await access(join(assetDir, ".whitelisted_at"));
    return true;
  } catch {
    return false;
  }
}

async function readOrExtractWaveform(assetDir: string): Promise<number[] | null> {
  try {
    const data = await readFile(join(assetDir, "waveform.json"), "utf-8");
    return JSON.parse(data) as number[];
  } catch {
    // Backfill: extract waveform from original video if waveform.json doesn't exist
    try {
      const files = await readdir(assetDir);
      const video = files.find((f) => /^original\.(mp4|mov)$/i.test(f));
      if (!video) return null;
      const waveform = await extractWaveform(join(assetDir, video));
      if (waveform.length > 0) {
        await writeFile(join(assetDir, "waveform.json"), JSON.stringify(waveform));
        return waveform;
      }
    } catch { /* non-fatal */ }
    return null;
  }
}

async function findFrameDirectories(assetDir: string, projectSlug: string, assetId: string): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  try {
    const entries = await readdir(assetDir);
    const frameDirs = entries.filter((e) => e.endsWith("_frames"));
    for (const dir of frameDirs) {
      try {
        const files = await readdir(join(assetDir, dir));
        const jpgs = files.filter((f) => f.endsWith(".jpg")).sort();
        result[dir] = jpgs.map((f) => `/files/${projectSlug}/${assetId}/${dir}/${f}`);
      } catch {
        // skip unreadable dirs
      }
    }
  } catch {
    // no frame dirs
  }
  return result;
}

async function hasRenderMetadata(assetDir: string): Promise<boolean> {
  try {
    const files = await readdir(assetDir);
    return files.some((f) => /^\.(portrait|landscape|square)\.render\.json$/.test(f));
  } catch {
    return false;
  }
}

export const RENDER_ORIENTATIONS = ["landscape", "portrait", "square"] as const;

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

async function findRenderedOrientations(assetDir: string): Promise<string[]> {
  try {
    const files = await readdir(assetDir);
    const fileSet = new Set(files);
    return RENDER_ORIENTATIONS.filter((o) => fileSet.has(`${o}.mp4`));
  } catch {
    return [];
  }
}

export async function buildAssetList(fs: ClipfirstFs, project_slug: string, sort?: "newest" | "oldest"): Promise<SyncAsset[]> {
  const assets = await fs.listAssets(project_slug, { sort });
  return Promise.all(
    assets.map(async (a): Promise<SyncAsset> => {
      const [mediaFile, hasThumbnail, lockData, pendingTask, whitelisted, rendered, metadata, renders, waveform, frameDirs, hasPartFile] = await Promise.all([
        findPrimaryMediaFile(a.path),
        findThumbnailFile(a.path),
        fs.getLockData(a.path),
        readPendingTask(fs, a.id, project_slug),
        isWhitelisted(a.path),
        hasRenderMetadata(a.path),
        fs.readMetadata<Record<string, unknown>>(a.id, "original", project_slug),
        findRenderedOrientations(a.path),
        readOrExtractWaveform(a.path),
        findFrameDirectories(a.path, project_slug, a.id),
        hasPartialDownload(a.path),
      ]);
      // Cache-bust media URLs with file mtime so browsers refetch after trim/re-encode
      let mediaMtime = 0;
      if (mediaFile) {
        try { mediaMtime = (await stat(join(a.path, mediaFile))).mtimeMs; } catch { /* non-fatal */ }
      }
      const cacheBust = mediaMtime ? `?v=${Math.floor(mediaMtime)}` : '';
      const media_url = mediaFile
        ? `/files/${project_slug}/${a.id}/${mediaFile}${cacheBust}`
        : null;
      const isImage = a.type === "image";
      const thumbnail_url = hasThumbnail
        ? `/files/${project_slug}/${a.id}/original.jpg${cacheBust}`
        : isImage ? media_url : null;

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
      } else if (hasPartFile && a.id.startsWith("vid-") && (!mediaFile || /\.(jpe?g|png|webp)$/i.test(mediaFile))) {
        // Video asset with a .part file but no actual video = failed download
        // (original.jpg thumbnail may exist from OG image, but that's not a real media file for a video)
        status = "error";
      } else if (mediaFile) {
        if (!whitelisted) {
          status = "unreviewed";
        } else if (rendered) {
          status = "ready";
        } else {
          status = "approved";
        }
      } else if (hasPartFile) {
        status = "error";
      } else {
        status = "loading";
      }

      const meta = metadata.ok ? metadata.value : null;

      // Backfill duration if missing from metadata
      let duration = (meta?.duration as number) ?? null;
      if (duration === null && mediaFile && /\.(mp4|mov)$/i.test(mediaFile)) {
        try {
          const probe = await probeVideo(join(a.path, mediaFile));
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
        try { prompt = await readFile(join(a.path, "original.md"), "utf-8"); } catch { /* non-fatal */ }
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
    external_uploads: [], auto_render: [], auto_transcribe: [], auto_speech_to_text: [],
  };

  // Single listAssets call, shared by all consumers
  const assets = await fs.listAssets(project_slug);

  // Read orientation from timeline config (needed by findAutoRenderActions)
  const timelineResult = await fs.readProjectMeta<{ render?: string }>("timeline", project_slug);
  const orientation = timelineResult.ok
    ? (Array.isArray(timelineResult.value.render) ? timelineResult.value.render[0] : timelineResult.value.render) ?? "landscape"
    : "landscape";

  // Run all discovery steps in parallel
  const [uploads, tasks, renderActions, transcribeActions, sttActions] = await Promise.all([
    findUnprocessedUploads(fs, project_slug, assets),
    findPendingTasks(fs, project_slug, assets),
    findAutoRenderActions(fs, project_slug, assets, orientation),
    findAutoTranscribeActions(fs, project_slug, assets),
    findAutoSpeechToTextActions(fs, project_slug, assets),
  ]);

  // Process external uploads
  for (const upload of uploads) {
    await processExternalUpload(fs, upload, project_slug);
    result.external_uploads.push({ assetId: upload.assetId, mediaFilename: upload.mediaFilename });
  }

  // Poll KIE tasks (only if API key is set)
  if (process.env.KIE_API_KEY && tasks.length > 0) {
    const provider = kie({ apiKey: process.env.KIE_API_KEY, timeout: 30_000 });

    await Promise.all(tasks.map(async (task) => {
      const taskInfo = await provider.api.v1.jobs.recordInfo(task.taskId);
      await processSyncedTask(task, taskInfo, result);
    }));
  }

  // Auto-pipeline: advance whitelisted videos through render
  for (const action of renderActions) {
    const stored = await readStoredRenderDefaults(fs, action.assetId, project_slug, orientation);
    const jobId = `auto-render-${action.assetId}`;
    await queue.enqueue(jobId, {
      type: "render_project",
      projectSlug: project_slug,
      orientation,
      assets: [{
        assetId: action.assetId,
        assetDir: action.assetDir,
        videoPath: action.videoPath,
        videoFilename: action.videoFilename,
        hasElevenlabs: action.hasElevenlabs,
      }],
      subtitlesEnabled: action.hasElevenlabs ? (stored.subtitlesEnabled as boolean) : false,
      highlightStyle: stored.highlightStyle as string,
      position: stored.position as string,
      fontSize: stored.fontSize as string,
      textColor: stored.textColor as string,
      highlightColor: stored.highlightColor as string,
      audioFadeIn: stored.audioFadeIn as number,
      audioFadeOut: stored.audioFadeOut as number,
      audioVolume: stored.audioVolume as number,
      osgImagePath: (stored.osgImagePath as string | null) ?? null,
      osgPosition: stored.osgPosition as string,
      backgroundMode: stored.backgroundMode as string,
    });
    result.auto_render.push({ assetId: action.assetId, jobId });
  }

  // Auto-pipeline: retry missing speech-to-text (gpt4otrans) for whitelisted videos with audio
  for (const action of sttActions) {
    const jobId = `auto-stt-${action.assetId}`;
    await queue.enqueue(jobId, {
      type: "transcribe_video_audio",
      videoPath: action.videoPath,
      assetId: action.assetId,
      assetDir: action.assetDir,
      projectSlug: project_slug,
    } as unknown as Record<string, unknown>);
    result.auto_speech_to_text.push({ assetId: action.assetId, jobId });
  }

  // Auto-pipeline: advance whitelisted+analyzed videos through transcription
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
      projectSlug: project_slug,
      autoRender: true,
    } as unknown as Record<string, unknown>);
    result.auto_transcribe.push({ assetId: action.assetId, jobId });
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
  task: PendingKieTask,
  taskInfo: KieTaskInfo,
  result: SyncResult,
): Promise<void> {
  if (taskInfo.state === "success") {
    const jobId = `complete-${task.taskType}-${task.assetId}-${Date.now()}`;

    await queue.enqueue(jobId, {
      type: "complete_kie_task",
      taskId: task.taskId,
      taskType: task.taskType,
      assetId: task.assetId,
      assetDir: task.assetDir,
      projectSlug: task.projectSlug,
      meta: task.meta,
      resultUrls: taskInfo.result?.resultUrls ?? [],
      resultObject: taskInfo.result?.resultObject,
    } as unknown as Record<string, unknown>);

    result.completed.push({ assetId: task.assetId, taskType: task.taskType, jobId });
  } else if (taskInfo.state === "fail") {
    result.failed.push({
      assetId: task.assetId,
      taskType: task.taskType,
      failMsg: taskInfo.failMsg ?? "unknown error",
    });
  } else {
    result.pending.push({
      assetId: task.assetId,
      taskType: task.taskType,
      progress: taskInfo.progress,
      state: taskInfo.state,
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

      // Skip: not whitelisted
      if (!fileNames.has(".whitelisted_at")) return null;
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

      // Must be whitelisted
      if (!fileNames.has(".whitelisted_at")) return null;
      // Must have completed analysis
      if (!fileNames.has(".original.analysis.json")) return null;
      // Skip if already transcribed
      if (fileNames.has("elevenlabs.json")) return null;
      // Skip if transcription already in progress
      if (fileNames.has(".kie-task.json")) return null;
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

      // Must be whitelisted
      if (!fileNames.has(".whitelisted_at")) return null;
      // Must have completed analysis
      if (!fileNames.has(".original.analysis.json")) return null;
      // Skip if already has speech-to-text
      if (fileNames.has(".analysis.gpt4otrans.json")) return null;
      // Skip if locked
      if (await fs.isLocked(manifest.path)) return null;

      // Must have audio (check metadata)
      const meta = await fs.readMetadata<{ hasAudio?: boolean }>(asset.id, "original", projectSlug);
      if (!meta.ok || !meta.value.hasAudio) return null;

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

export function registerSyncTool(server: McpServer, fs: ClipfirstFs): void {
  const def = syncDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
