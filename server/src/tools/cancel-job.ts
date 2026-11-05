import type { Engine } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import { toolError } from "./_shared.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function cancelJobDef(engine: Engine): ToolDef {
  return {
    name: "cancel_job",
    description: "Cancel a queued or running persistent job by job_id. For a leftover provider task after local jobs have finished, pass asset_id and its expected_task_id to cancel local tracking and retain media; this does not cancel the request at the provider.",
    scope: "book",
    schema: {
      book_id: z.string().uuid(),
      job_id: z.number().int().positive().optional(),
      asset_id: z.string().uuid().optional(),
      expected_task_id: z.string().min(1).max(500).optional(),
      reason: z.string().min(1).max(500).optional(),
    },
    handler: async (args) => {
      const reason = typeof args.reason === "string" ? args.reason : "Cancelled by user";
      if (typeof args.job_id === "number") {
        if (args.asset_id !== undefined || args.expected_task_id !== undefined) {
          return toolError("Pass either job_id or asset_id with expected_task_id");
        }
        const job = engine.jobs.queue.get(args.job_id);
        if (!job) return toolError(`Job ${args.job_id} was not found`);
        if (!await engine.jobs.queue.abort(args.job_id, reason)) return toolError(`Job ${job.id} is already ${job.state}`);
        return json(engine.jobs.queue.get(job.id));
      }
      const assetId = args.asset_id;
      const expectedTaskId = args.expected_task_id;
      if (typeof assetId !== "string" || typeof expectedTaskId !== "string") {
        return toolError("Pass either job_id or asset_id with expected_task_id");
      }
      return queue.maintenance(async () => {
        const pending = engine.jobs.pending.read(assetId);
        if (!pending.ok) return toolError(pending.error.message);
        if (!pending.value || pending.value.taskId !== expectedTaskId) return toolError("No matching pending provider task; inspect the request again");
        if (engine.jobs.queue.count({ states: ["queued", "running", "completing"] }) > 0) {
          return toolError("Cancel active local jobs by job_id before cancelling a leftover provider task");
        }
        const work = engine.jobs.artifactWork.read(assetId);
        if (!work.ok) return toolError(work.error.message);
        if (work.value?.deadlineAt != null && work.value.deadlineAt > Date.now()) {
          return toolError("The asset still has a live work lease");
        }
        const cancelled = await engine.jobs.pending.fail(assetId, expectedTaskId, { message: reason, failCode: "cancelled" });
        if (!cancelled.ok) return toolError(cancelled.error.message);
        if (!cancelled.value) return toolError("The pending provider task changed; inspect the request again");
        return json({ asset_id: assetId, task_id: expectedTaskId, state: "aborted", provider_cancelled: false });
      });
    },
  };
}
