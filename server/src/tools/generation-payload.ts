import type { ClipfirstFs } from "vc-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

type GenerationErrorOut = {
  message: string;
  failedAt?: string;
  failCode?: string;
  prompt?: string;
};

type GenerationPayloadResponse = {
  payload: unknown | null;
  meta: Record<string, unknown> | null;
  error: GenerationErrorOut | null;
  taskType: string | null;
};

export function generationPayloadDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generation_payload",
    description: "Read the persisted Kie request payload, task meta, and failure info for a single asset. Used by the /inbox hover inspector to show what was sent to the provider.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      asset_id: z.string().describe("Asset id (e.g. vid-something)"),
    },
    handler: async (args) => {
      const { project_slug, asset_id } = args as { project_slug: string; asset_id: string };

      const [payloadRes, taskRes, errorRes] = await Promise.all([
        fs.readMetadata<unknown>(asset_id, "generation-payload", project_slug),
        fs.pendingTasks.read(project_slug, asset_id),
        fs.generationErrors.read(project_slug, asset_id),
      ]);

      const task = taskRes.ok ? taskRes.value : null;
      const errorRecord = errorRes.ok ? errorRes.value : null;
      const error: GenerationErrorOut | null = errorRecord
        ? {
            message: errorRecord.message,
            failedAt: new Date(errorRecord.failedAt * 1000).toISOString(),
            ...(errorRecord.failCode !== undefined ? { failCode: errorRecord.failCode } : {}),
            ...(errorRecord.prompt !== undefined && errorRecord.prompt !== null ? { prompt: errorRecord.prompt } : {}),
          }
        : null;

      const response: GenerationPayloadResponse = {
        payload: payloadRes.ok ? payloadRes.value : null,
        meta: task ? task.meta : null,
        error,
        taskType: task ? task.taskType : null,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response) }],
      };
    },
  };
}
