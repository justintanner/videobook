import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { join } from "node:path";
import { kie } from "@nakedapi/kie";
import type { KieTaskInfo } from "@nakedapi/kie";
import { queue } from "../queue.js";
import { findAudioFile, findVideoFile } from "../media-files.js";
import { findPendingTasks } from "../jobs/pending-task.js";
import type { PendingKieTask } from "../jobs/pending-task.js";
import { findUnprocessedUploads, processExternalUpload } from "../jobs/process-upload.js";
import type { ToolDef } from "./tool-def.js";

type SyncResult = {
  pending: Array<{ assetId: string; taskType: string; progress: number; state: string }>;
  completed: Array<{ assetId: string; taskType: string; jobId: string }>;
  failed: Array<{ assetId: string; taskType: string; failMsg: string }>;
  external_uploads: Array<{ assetId: string; mediaFilename: string }>;
  auto_transcribe: Array<{ assetId: string; jobId: string }>;
  auto_render: Array<{ assetId: string; jobId: string }>;
};

export function syncDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "sync",
    description: "Check all pending KIE tasks for a project, enqueue completion jobs for finished ones, and detect externally-placed files (via Finder/CLI) that need processing. Call periodically after triggering generation tools or adding files externally.",
    schema: {
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };

      const result: SyncResult = {
        pending: [], completed: [], failed: [],
        external_uploads: [], auto_transcribe: [], auto_render: [],
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

      // Auto-pipeline: advance whitelisted videos through transcription/render
      const actions = await findAutoPipelineActions(fs, project_slug);

      for (const action of actions.needsTranscribe) {
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

      for (const action of actions.needsRender) {
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

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
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

type TranscribeAction = {
  assetId: string;
  assetDir: string;
  audioPath: string;
  audioFilename: string;
};

type RenderAction = {
  assetId: string;
  assetDir: string;
  videoPath: string;
  videoFilename: string;
};

type AutoPipelineActions = {
  needsTranscribe: TranscribeAction[];
  needsRender: RenderAction[];
};

async function checkHasDialog(fs: ClipfirstFs, assetId: string, projectSlug: string): Promise<boolean> {
  const result = await fs.readFile(assetId, ".analysis.gpt4otrans.json", projectSlug);
  if (!result.ok) return false;
  try {
    const data = JSON.parse(result.value.toString()) as { text?: string };
    return typeof data.text === "string" && data.text.trim().length > 0;
  } catch {
    return false;
  }
}

async function findAutoPipelineActions(
  fs: ClipfirstFs,
  projectSlug: string,
): Promise<AutoPipelineActions> {
  const actions: AutoPipelineActions = { needsTranscribe: [], needsRender: [] };
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
    // Skip: already rendered
    if (!fileNames.has(".render.json")) {
      // Eligible for pipeline — determine path
    } else {
      continue;
    }

    const hasDialog = await checkHasDialog(fs, asset.id, projectSlug);

    if (hasDialog) {
      const hasElevenlabs = fileNames.has("elevenlabs.json");
      const hasKieTask = fileNames.has(".kie-task.json");

      if (!hasElevenlabs && !hasKieTask) {
        // Needs transcribe
        const audioFile = findAudioFile(files, asset.id);
        if (audioFile) {
          actions.needsTranscribe.push({
            assetId: asset.id,
            assetDir: manifest.path,
            audioPath: join(manifest.path, audioFile.name),
            audioFilename: audioFile.name,
          });
        }
      } else if (hasElevenlabs) {
        // Has transcription, needs render
        const videoFile = findVideoFile(files);
        if (videoFile && !await fs.isLocked(manifest.path)) {
          actions.needsRender.push({
            assetId: asset.id,
            assetDir: manifest.path,
            videoPath: join(manifest.path, videoFile.name),
            videoFilename: videoFile.name,
          });
        }
      }
      // hasKieTask && !hasElevenlabs => in progress, skip
    } else {
      // No dialog — render directly (no subtitles)
      const videoFile = findVideoFile(files);
      if (videoFile && !await fs.isLocked(manifest.path)) {
        actions.needsRender.push({
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
