import { fal } from "@apicity/fal";
import type { ClipfirstFs } from "clipfirst-engine";
import { type PendingTask } from "clipfirst-engine";
export type FalTaskType = Extract<PendingTask["taskType"], `fal_${string}`>;

export type FalSubmitArgs = {
  fs: ClipfirstFs;
  projectSlug: string;
  assetId: string;
  assetDir: string;
  endpointId: string;
  input: Record<string, unknown>;
  taskType: FalTaskType;
  meta: Record<string, unknown>;
};

export async function submitFalJob(args: FalSubmitArgs): Promise<string> {
  const apiKey = process.env.FAL_API_KEY;
  if (!apiKey) throw new Error("FAL_API_KEY environment variable is not set");

  const provider = fal({ apiKey, timeout: 60_000 });

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

  const ptResult = await args.fs.pendingTasks.write(args.projectSlug, {
    taskId: submit.request_id,
    taskType: args.taskType,
    assetId: args.assetId,
    assetDir: args.assetDir,
    meta: {
      ...args.meta,
      falEndpointId: args.endpointId,
    },
  });
  if (!ptResult.ok) {
    throw new Error(`Failed to write pending-task for ${args.assetId}: ${ptResult.error.message}`);
  }

  return submit.request_id;
}
