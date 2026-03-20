import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, AssetEntry } from "clipfirst-fs";
import { z } from "zod";
import { join } from "node:path";
import { readdir, readFile, access } from "node:fs/promises";
import { kie } from "@nakedapi/kie";
import type { KieTaskInfo } from "@nakedapi/kie";
import { queue } from "../queue.js";
import { findVideoFile } from "../media-files.js";
import { findPendingTasks, readPendingTask } from "../jobs/pending-task.js";
import type { PendingKieTask } from "../jobs/pending-task.js";
import { findUnprocessedUploads, processExternalUpload } from "../jobs/process-upload.js";
import { readAndAssessDialog } from "../dialog-quality.js";
import { extractWaveform } from "../ffmpeg.js";
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

const RENDER_ORIENTATIONS = ["landscape", "portrait", "square"] as const;

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
      const [mediaFile, hasThumbnail, lockData, pendingTask, whitelisted, rendered, metadata, renders, waveform, frameDirs] = await Promise.all([
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
      ]);
      const media_url = mediaFile
        ? `/files/${project_slug}/${a.id}/${mediaFile}`
        : null;
      const isImage = a.type === "image";
      const thumbnail_url = hasThumbnail
        ? `/files/${project_slug}/${a.id}/original.jpg`
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
      } else if (mediaFile) {
        if (!whitelisted) {
          status = "unreviewed";
        } else if (rendered) {
          status = "ready";
        } else {
          status = "approved";
        }
      } else {
        status = "loading";
      }

      const meta = metadata.ok ? metadata.value : null;
      return {
        ...a,
        media_url,
        thumbnail_url,
        status,
        width: (meta?.width as number) ?? null,
        height: (meta?.height as number) ?? null,
        origin: (meta?.origin as string) ?? null,
        prompt: (meta?.prompt as string) ?? null,
        renders,
        duration: (meta?.duration as number) ?? null,
        waveform,
        frame_dirs: frameDirs,
      };
    }),
  );
}

export async function performSync(fs: ClipfirstFs, project_slug: string): Promise<SyncResult> {
  const result: SyncResult = {
    pending: [], completed: [], failed: [],
    external_uploads: [], auto_render: [],
  };

  // Single listAssets call, shared by all consumers
  const assets = await fs.listAssets(project_slug);

  // Read orientation from timeline config (needed by findAutoRenderActions)
  const timelineResult = await fs.readProjectMeta<{ render?: string }>("timeline", project_slug);
  const orientation = timelineResult.ok
    ? (Array.isArray(timelineResult.value.render) ? timelineResult.value.render[0] : timelineResult.value.render) ?? "landscape"
    : "landscape";

  // Run all three discovery steps in parallel
  const [uploads, tasks, renderActions] = await Promise.all([
    findUnprocessedUploads(fs, project_slug, assets),
    findPendingTasks(fs, project_slug, assets),
    findAutoRenderActions(fs, project_slug, assets, orientation),
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
    const jobId = `auto-render-${action.assetId}-${Date.now()}`;
    await queue.enqueue(jobId, {
      type: "render_project",
      projectSlug: project_slug,
      orientation,
      assets: [{
        assetId: action.assetId,
        assetDir: action.assetDir,
        videoPath: action.videoPath,
        videoFilename: action.videoFilename,
        hasElevenlabs: false,
      }],
      subtitlesEnabled: false,
      highlightStyle: "tikdance",
      position: "bottom",
      fontSize: "medium",
      textColor: "#F8FAFC",
      highlightColor: "#991B1B",
      audioFadeIn: 150,
      audioFadeOut: 100,
      audioVolume: 100,
      osgImagePath: null,
      osgPosition: "top-right",
      backgroundMode: "blur",
    });
    result.auto_render.push({ assetId: action.assetId, jobId });
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

type RenderAction = {
  assetId: string;
  assetDir: string;
  videoPath: string;
  videoFilename: string;
};

async function findAutoRenderActions(
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

      const dialogQuality = await readAndAssessDialog(fs, asset.id, projectSlug);

      if (dialogQuality.hasDialog) {
        // Has dialog — only render after transcription is done
        const hasElevenlabs = fileNames.has("elevenlabs.json");
        if (hasElevenlabs) {
          const videoFile = findVideoFile(files);
          if (videoFile && !await fs.isLocked(manifest.path)) {
            return {
              assetId: asset.id,
              assetDir: manifest.path,
              videoPath: join(manifest.path, videoFile.name),
              videoFilename: videoFile.name,
            };
          }
        }
        return null;
      } else {
        // No dialog — render directly (no subtitles)
        const videoFile = findVideoFile(files);
        if (videoFile && !await fs.isLocked(manifest.path)) {
          return {
            assetId: asset.id,
            assetDir: manifest.path,
            videoPath: join(manifest.path, videoFile.name),
            videoFilename: videoFile.name,
          };
        }
        return null;
      }
    })
  );
  return candidates.filter((c): c is RenderAction => c !== null);
}

export function registerSyncTool(server: McpServer, fs: ClipfirstFs): void {
  const def = syncDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
