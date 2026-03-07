import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { kie } from "@nakedapi/kie";
import type { KieTaskInfo } from "@nakedapi/kie";
import { queue } from "../queue.js";
import { findPendingTasks } from "../jobs/pending-task.js";
import type { PendingKieTask } from "../jobs/pending-task.js";
import type { ToolDef } from "./tool-def.js";

type SyncResult = {
  pending: Array<{ assetId: string; taskType: string; progress: number; state: string }>;
  completed: Array<{ assetId: string; taskType: string; jobId: string }>;
  failed: Array<{ assetId: string; taskType: string; failMsg: string }>;
};

export function syncDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "sync",
    description: "Check all pending KIE tasks for a project and enqueue completion jobs for finished ones. Call periodically after triggering generation tools.",
    schema: {
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const tasks = await findPendingTasks(fs, project_slug);

      if (tasks.length === 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ pending: [], completed: [], failed: [] }) }],
        };
      }

      const provider = kie({ apiKey: process.env.KIE_API_KEY, timeout: 30_000 });
      const result: SyncResult = { pending: [], completed: [], failed: [] };

      for (const task of tasks) {
        const taskInfo = await provider.getTask(task.taskId);
        await processSyncedTask(task, taskInfo, result);
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
