import { Queue, MemoryStorage, type Job } from "@platformatic/job-queue";
import { fs as defaultFs } from "./fs.js";
import { failPendingTask } from "./jobs/pending-task.js";

type JobPayload = Record<string, unknown>;

const storage = new MemoryStorage();
export const queue = new Queue<JobPayload>({ storage, concurrency: 5 });

const handlers = new Map<string, (payload: Record<string, unknown>) => Promise<unknown>>();

export function registerJobHandler(
  type: string,
  handler: (payload: Record<string, unknown>) => Promise<unknown>,
): void {
  handlers.set(type, handler);
}

/** Extract the asset ID from a generation job payload (imgAssetId or vidAssetId). */
function extractAssetId(payload: Record<string, unknown>): string | null {
  return (payload.imgAssetId as string) ?? (payload.vidAssetId as string) ?? (payload.assetId as string) ?? null;
}

queue.execute(async (job: Job<JobPayload>) => {
  const payload = job.payload as { type: string };
  const handler = handlers.get(payload.type);
  if (!handler) throw new Error(`No handler for job type: ${payload.type}`);
  try {
    return await handler(job.payload as Record<string, unknown>);
  } catch (err) {
    console.error(`[queue] job ${payload.type} failed:`, err instanceof Error ? err.message : err);

    // Persist the failure and clear the queued pending task so the asset
    // doesn't stay stuck in "generating" state.
    const assetId = extractAssetId(job.payload);
    const projectSlug = job.payload.projectSlug as string | undefined;
    if (assetId && projectSlug) {
      await failPendingTask(defaultFs, assetId, projectSlug, {
        message: err instanceof Error ? err.message : String(err),
      }).catch(() => {});
      console.error(`[queue] cleared pending task for ${assetId} in ${projectSlug}`);
    }

    throw err;
  }
});

export async function waitForJob(jobId: string, timeoutMs = 300_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await queue.getStatus(jobId);
    if (!status) throw new Error(`Job ${jobId} not found`);
    if (status.state === "completed") return;
    if (status.state === "failed") {
      throw new Error(`Job ${jobId} failed: ${status.error?.message ?? "unknown"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Job ${jobId} timed out after ${timeoutMs}ms`);
}
