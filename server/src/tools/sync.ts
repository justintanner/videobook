import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { kie } from "@nakedapi/kie";
import type { KieTaskInfo } from "@nakedapi/kie";
import { queue } from "../queue.js";
import { findPendingTasks } from "../jobs/pending-task.js";
import type { PendingKieTask } from "../jobs/pending-task.js";
import { findUnprocessedUploads, processExternalUpload } from "../jobs/process-upload.js";
import type { ToolDef } from "./tool-def.js";

type SyncResult = {
  pending: Array<{ assetId: string; taskType: string; progress: number; state: string }>;
  completed: Array<{ assetId: string; taskType: string; jobId: string }>;
  failed: Array<{ assetId: string; taskType: string; failMsg: string }>;
  external_uploads: Array<{ assetId: string; mediaFilename: string }>;
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

      const result: SyncResult = { pending: [], completed: [], failed: [], external_uploads: [] };

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

export function registerSyncTool(server: McpServer, fs: ClipfirstFs): void {
  const def = syncDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
