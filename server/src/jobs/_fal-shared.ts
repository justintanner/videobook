import { createFal } from "@apicity/fal";
import type { VideocityFs } from "videobook-engine";
import { type PendingTask } from "videobook-engine";
import { requireApiKey } from "../api-key.js";
export type FalTaskType = Extract<PendingTask["taskType"], `fal_${string}`>;

export type FalSubmitArgs = {
  fs: VideocityFs;
  projectSlug: string;
  assetId: string;
  assetDir: string;
  endpointId: string;
  input: Record<string, unknown>;
  taskType: FalTaskType;
  meta: Record<string, unknown>;
  /** Local job lease to hand off to the provider lease atomically. */
  expectedOwnerId: string;
};

export async function submitFalJob(args: FalSubmitArgs): Promise<string> {
  const apiKey = requireApiKey("FAL_API_KEY");

  const provider = createFal({ apiKey, timeout: 60_000 });

  await args.fs.writeMetadata(
    args.assetId,
    "generation-payload",
    { endpoint_id: args.endpointId, input: args.input },
    args.projectSlug,
  );

  const submit = await provider.post.v1.queue.submit({
    endpoint_id: args.endpointId,
    input: args.input,
  });

  const ptResult = await args.fs.pendingTasks.write(
    args.projectSlug,
    {
      taskId: submit.request_id,
      taskType: args.taskType,
      assetId: args.assetId,
      assetDir: args.assetDir,
      meta: {
        ...args.meta,
        falEndpointId: args.endpointId,
      },
    },
    args.expectedOwnerId,
  );
  if (!ptResult.ok) {
    throw new Error(`Failed to write pending-task for ${args.assetId}: ${ptResult.error.message}`);
  }
  if (ptResult.value === null) {
    throw new Error(
      `Lost local lease for ${args.assetId} during FAL submission; the asset's owner changed mid-flight`,
    );
  }

  return submit.request_id;
}
