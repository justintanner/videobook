import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { join } from "node:path";
import { readdir, access } from "node:fs/promises";
import { kie } from "@nakedapi/kie";
import type { KieTaskInfo } from "@nakedapi/kie";
import { queue } from "../queue.js";
import { findVideoFile } from "../media-files.js";
import { findPendingTasks } from "../jobs/pending-task.js";
import type { PendingKieTask } from "../jobs/pending-task.js";
import { findUnprocessedUploads, processExternalUpload } from "../jobs/process-upload.js";
import { readAndAssessDialog } from "../dialog-quality.js";
import type { ToolDef } from "./tool-def.js";

type SyncAsset = {
  id: string;
  type: string;
  created_at: string;
  path: string;
  media_url: string | null;
  thumbnail_url: string | null;
};

export type SyncResult = {
  pending: Array<{ assetId: string; taskType: string; progress: number; state: string }>;
  completed: Array<{ assetId: string; taskType: string; jobId: string }>;
  failed: Array<{ assetId: string; taskType: string; failMsg: string }>;
  external_uploads: Array<{ assetId: string; mediaFilename: string }>;
  auto_render: Array<{ assetId: string; jobId: string }>;
  assets: SyncAsset[];
};

async function findPrimaryMediaFile(assetDir: string): Promise<string | null> {
  try {
    const files = await readdir(assetDir);
    const video = files.find((f) => /^original\.(mp4|mov)$/i.test(f));
    if (video) return video;
    const image = files.find((f) => /^original\.(png|jpe?g|webp)$/i.test(f));
    if (image) return image;
    return files.find((f) => /^original\.(mp3|wav)$/i.test(f)) ?? null;
  } catch {
    return null;
  }
}

async function findThumbnailFile(assetDir: string): Promise<boolean> {
  try {
    await access(join(assetDir, "original_frames", "0.00.jpg"));
    return true;
  } catch {
    return false;
  }
}

export async function performSync(fs: ClipfirstFs, project_slug: string): Promise<SyncResult> {
  const result: SyncResult = {
    pending: [], completed: [], failed: [],
    external_uploads: [], auto_render: [], assets: [],
  };

  // Process external uploads (always runs, no API key needed)
  const uploads = await findUnprocessedUploads(fs, project_slug);
  for (const upload of uploads) {
    await processExternalUpload(fs, upload, project_slug);
    result.external_uploads.push({ assetId: upload.assetId, mediaFilename: upload.mediaFilename });
  }

  // Poll KIE tasks (only if API key is set)
  if (process.env.KIE_API_KEY) {
    const tasks = await findPendingTasks(fs, project_slug);

    if (tasks.length > 0) {
      const provider = kie({ apiKey: process.env.KIE_API_KEY, timeout: 30_000 });

      for (const task of tasks) {
        const taskInfo = await provider.getTask(task.taskId);
        await processSyncedTask(task, taskInfo, result);
      }
    }
  }

  // Auto-pipeline: advance whitelisted videos through render
  const renderActions = await findAutoRenderActions(fs, project_slug);

  for (const action of renderActions) {
    const jobId = `auto-render-${action.assetId}-${Date.now()}`;
    await queue.enqueue(jobId, {
      type: "render_video",
      assetId: action.assetId,
      assetDir: action.assetDir,
      videoPath: action.videoPath,
      videoFilename: action.videoFilename,
      projectSlug: project_slug,
      orientations: ["landscape"],
      subtitlesEnabled: false,
      highlightStyle: "tikdance",
      position: "bottom",
      fontSize: "medium",
      textColor: "#F8FAFC",
      highlightColor: "#991B1B",
      audioFadeIn: 150,
      audioFadeOut: 100,
      audioVolume: 100,
      hasElevenlabs: false,
      osgImagePath: null,
      osgPosition: "top-right",
    });
    result.auto_render.push({ assetId: action.assetId, jobId });
  }

  const rawAssets = await fs.listAssets(project_slug);
  result.assets = await Promise.all(
    rawAssets.map(async (a): Promise<SyncAsset> => {
      const mediaFile = await findPrimaryMediaFile(a.path);
      const media_url = mediaFile
        ? `/files/${project_slug}/${a.id}/${mediaFile}`
        : null;
      const hasThumbnail = await findThumbnailFile(a.path);
      const isImage = a.type === "image";
      const thumbnail_url = hasThumbnail
        ? `/files/${project_slug}/${a.id}/original_frames/0.00.jpg`
        : isImage ? media_url : null;
      return { ...a, media_url, thumbnail_url };
    }),
  );

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
): Promise<RenderAction[]> {
  const actions: RenderAction[] = [];
  const assets = await fs.listAssets(projectSlug);

  for (const asset of assets) {
    if (!asset.id.startsWith("vid-")) continue;

    const manifestResult = await fs.getManifest(asset.id, projectSlug);
    if (!manifestResult.ok) continue;

    const manifest = manifestResult.value;
    const files = manifest.files;
    const fileNames = new Set(files.map((f) => f.name));

    // Skip: not whitelisted
    if (!fileNames.has(".whitelisted_at")) continue;
    // Skip: process_video incomplete
    if (!fileNames.has(".original.analysis.json")) continue;

    const dialogQuality = await readAndAssessDialog(fs, asset.id, projectSlug);

    if (dialogQuality.hasDialog) {
      // Has dialog — only render after transcription is done
      const hasElevenlabs = fileNames.has("elevenlabs.json");
      if (hasElevenlabs) {
        const videoFile = findVideoFile(files);
        if (videoFile && !await fs.isLocked(manifest.path)) {
          actions.push({
            assetId: asset.id,
            assetDir: manifest.path,
            videoPath: join(manifest.path, videoFile.name),
            videoFilename: videoFile.name,
          });
        }
      }
      // No elevenlabs yet => whitelist tool handles transcription trigger, skip
    } else {
      // No dialog — render directly (no subtitles)
      const videoFile = findVideoFile(files);
      if (videoFile && !await fs.isLocked(manifest.path)) {
        actions.push({
          assetId: asset.id,
          assetDir: manifest.path,
          videoPath: join(manifest.path, videoFile.name),
          videoFilename: videoFile.name,
        });
      }
    }
  }

  return actions;
}

export function registerSyncTool(server: McpServer, fs: ClipfirstFs): void {
  const def = syncDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
