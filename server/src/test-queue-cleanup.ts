type QueueCleanup = (options: {
  budgetMs?: number;
  fileLabel?: string;
}) => Promise<void>;

export const testQueueCleanup: {
  waitForIdle?: QueueCleanup;
  drain?: QueueCleanup;
} = {};
