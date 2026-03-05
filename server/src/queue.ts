import { Queue, MemoryStorage } from "@platformatic/job-queue";

const storage = new MemoryStorage();
export const queue = new Queue({ storage, concurrency: 5 });
