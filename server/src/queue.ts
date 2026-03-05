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
