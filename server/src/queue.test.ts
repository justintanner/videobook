import { describe, it, expect, afterEach } from "vitest";
import { Queue, MemoryStorage } from "@platformatic/job-queue";

describe("job queue", () => {
  let queue: Queue<Record<string, unknown>>;

  afterEach(async () => {
    await queue.stop();
  });

  it("starts, executes a job, and stops cleanly", async () => {
    const storage = new MemoryStorage();
    queue = new Queue<Record<string, unknown>>({ storage, concurrency: 5 });

    let executed = false;

    queue.execute(async (_job: { id: string; payload: Record<string, unknown>; attempts: number }) => {
      executed = true;
      return { done: true };
    });

    await queue.start();
    await queue.enqueueAndWait("test-job-1", { value: 42 });

    expect(executed).toBe(true);
  });
});
