import type { VideocityFs } from "videobook-engine";
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
export function retryGenerationDef(fs: VideocityFs): ToolDef {
  return {
    name: "retry_generation",
    description:
      "Retry a failed generation by replaying its original request payload. Reads the persisted generation-request metadata for the asset, clears its error record, and re-enqueues the same job. Use this on a failed asset card to re-run the exact inputs without re-resolving references.",
    schema: {
      asset_id: z.string().describe("Asset ID of the failed generation to retry (vid-*, or @-prefixed)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as { asset_id: string; project_slug: string };
      const assetId = asset_id.replace(/^@/, "");

      const metaResult = await fs.readMetadata<Record<string, unknown>>(assetId, "generation-request", project_slug);
      if (!metaResult.ok || metaResult.value === null) {
        return error(`No generation-request metadata found for ${assetId} — cannot retry. Recover or regenerate instead.`);
      }
      const payload = metaResult.value;

      const type = typeof payload.type === "string" ? payload.type : "";
      if (!type.startsWith("generate_")) {
        return error(`Stored generation-request for ${assetId} is not a replayable generation (type: ${type || "unknown"})`);
      }

      // The embedded target asset id must match the asset being retried.
      const embeddedId = typeof payload.vidAssetId === "string" ? payload.vidAssetId
        : typeof payload.assetId === "string" ? payload.assetId
          : null;
      if (embeddedId !== assetId) {
        return error(`generation-request payload targets a different asset (${embeddedId ?? "none"}) than ${assetId}`);
      }

      // Refuse if an active task is already in flight for this asset.
      const taskResult = await fs.pendingTasks.read(project_slug, assetId);
      const activeTask = taskResult.ok ? taskResult.value : null;
      if (activeTask !== null) {
        return error(`${assetId} already has an active generation in progress (task ${activeTask.taskId})`);
      }

      const cleared = await fs.generationErrors.clear(project_slug, assetId);
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
