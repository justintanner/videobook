import type { Engine } from "videobook-engine";
import { z } from "zod";
import { captureKeys, generationHarStatus, type GenerationHarStatus } from "../generation-har.js";
import { readHarSettings } from "../har-settings.js";
import { logger } from "../logger.js";
import { readProviderTaskStatus } from "../provider-task-status.js";
import type { ProviderTaskStatus } from "../provider-status-link.js";
import type { ToolDef } from "./tool-def.js";

type GenerationErrorOut = {
  message: string;
  failedAt?: string;
  failCode?: string;
  prompt?: string;
};

type GenerationTaskOut = {
  taskId: string;
  submittedAt: string;
  completing: boolean;
};

type GenerationPayloadResponse = {
  payload: unknown | null;
  meta: Record<string, unknown> | null;
  error: GenerationErrorOut | null;
  taskType: string | null;
  task: GenerationTaskOut | null;
  providerTask: ProviderTaskStatus | null;
  har: GenerationHarStatus | null;
};

async function inspectionHar(engine: Engine, assetId: string): Promise<GenerationHarStatus | null> {
  try {
    const { mode } = await readHarSettings();
    return await generationHarStatus(await captureKeys(engine, [assetId]), mode);
  } catch (error) {
    logger.warn("har-capture-failed", { error });
    return null;
  }
}

export function generationPayloadDef(engine: Engine): ToolDef {
  return {
    name: "inspect_generation_request",
    description: "Read the persisted provider request payload, task details, status-page information, failure info and HAR capture status for a single asset. Used by the generating-cell inspector to show what was sent to the provider.",
    schema: {
      book_id: z.string().describe("Book id"),
      asset_id: z.string().describe("Artifact id"),
    },
    handler: async (args) => {
      const { book_id: _book_id, asset_id } = args as { book_id: string; asset_id: string };

      const [payloadRes, taskRes, errorRes, providerTask, har] = await Promise.all([
        engine.metadata.artifacts.read<unknown>(asset_id, "generation-payload"),
        engine.jobs.pending.read(asset_id),
        engine.jobs.failures.read(asset_id),
        readProviderTaskStatus(engine, asset_id),
        inspectionHar(engine, asset_id),
      ]);

      const task = taskRes.ok ? taskRes.value : null;
      const errorRecord = errorRes.ok ? errorRes.value : null;
      const error: GenerationErrorOut | null = errorRecord
        ? {
            message: errorRecord.message,
            failedAt: new Date(errorRecord.failedAt).toISOString(),
            ...(errorRecord.failCode !== undefined ? { failCode: errorRecord.failCode } : {}),
            ...(errorRecord.prompt !== undefined && errorRecord.prompt !== null ? { prompt: errorRecord.prompt } : {}),
          }
        : null;

      const response: GenerationPayloadResponse = {
        payload: payloadRes.ok ? payloadRes.value : null,
        meta: task ? task.meta : null,
        error,
        taskType: task ? task.taskType : null,
        providerTask,
        har,
        task: task
          ? {
              taskId: task.taskId,
              submittedAt: new Date(task.createdAt).toISOString(),
              completing: task.completing,
            }
          : null,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response) }],
      };
    },
  };
}
