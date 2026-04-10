import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import type { PendingKieTask } from "../jobs/pending-task.js";

type GenerationError = {
  message: string;
  failedAt?: string;
  failCode?: string;
  prompt?: string;
};

type GenerationPayloadResponse = {
  payload: unknown | null;
  meta: Record<string, unknown> | null;
  error: GenerationError | null;
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
        fs.readMetadata<PendingKieTask>(asset_id, "kie-task", project_slug),
        fs.readMetadata<GenerationError>(asset_id, "generation-error", project_slug),
      ]);

      const response: GenerationPayloadResponse = {
        payload: payloadRes.ok ? payloadRes.value : null,
        meta: taskRes.ok ? taskRes.value.meta : null,
        error: errorRes.ok ? errorRes.value : null,
        taskType: taskRes.ok ? taskRes.value.taskType : null,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response) }],
      };
    },
  };
}
