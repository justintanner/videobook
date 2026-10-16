import type { Engine } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

/** Replay a failed generation using its persisted `generation-request` payload.
 *  Clears the error row (reverting the asset to claimable `pending`) and
 *  re-enqueues the exact job, so the queue's generate_* handoff re-claims the
 *  SAME asset. Safe because generationErrors.clear is CAS-revertible. */
export function retryGenerationDef(engine: Engine): ToolDef {
  return {
    name: "retry_generation",
    description:
      "Re-run a failed generation with its original request payload and inputs, clearing the asset's error first.",
    schema: {
      asset_id: z.string().describe("Asset ID of the failed generation to retry (vid-*, or @-prefixed)"),
      book_id: z.string().describe("Book id"),
    },
    handler: async (args) => {
      const { asset_id, book_id: _book_id } = args as { asset_id: string; book_id: string };
      const assetId = asset_id.replace(/^@/, "");

      const metaResult = await engine.metadata.artifacts.read<Record<string, unknown>>(assetId, "generation-request");
      if (!metaResult.ok || metaResult.value === null) {
        return error(`No generation-request metadata found for ${assetId} — cannot retry. Recover or regenerate instead.`);
      }
      const payload = metaResult.value;

      const type = typeof payload.type === "string" ? payload.type : "";
      if (type !== "generate_media") {
        return error(`Stored generation-request for ${assetId} is not a replayable generation (type: ${type || "unknown"}); regenerate it with generate_image, generate_video or generate_audio`);
      }

      const embeddedId = typeof payload.assetId === "string" ? payload.assetId : null;
      if (embeddedId !== assetId) {
        return error(`generation-request payload targets a different asset (${embeddedId ?? "none"}) than ${assetId}`);
      }

      // Refuse if an active task is already in flight for this asset.
      const taskResult = await engine.jobs.pending.read(assetId);
      const activeTask = taskResult.ok ? taskResult.value : null;
      if (activeTask !== null) {
        return error(`${assetId} already has an active generation in progress (task ${activeTask.taskId})`);
      }

      const cleared = await engine.jobs.failures.clear(assetId);
      if (!cleared.ok) {
        return error(`Failed to clear error for ${assetId}: ${cleared.error.message}`);
      }

      const jobId = `retry-${assetId}-${Date.now()}`;
      await queue.enqueue(jobId, payload);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id: assetId, retried: true, job_id: jobId }),
        }],
      };
    },
  };
}
