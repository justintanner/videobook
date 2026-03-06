import { Queue, MemoryStorage, type Job } from "@platformatic/job-queue";

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

queue.execute(async (job: Job<JobPayload>) => {
  const payload = job.payload as { type: string };
  const handler = handlers.get(payload.type);
  if (!handler) throw new Error(`No handler for job type: ${payload.type}`);
  return handler(job.payload as Record<string, unknown>);
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
