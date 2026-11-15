export const DEFAULT_QUEUE_POLL_INTERVAL_MS = 250;
export const DEFAULT_AWAIT_NOTEBOOK_OUTPUT_POLL_MS = 2_000;

const TEST_QUEUE_POLL_INTERVAL_MS = 50;
const TEST_AWAIT_NOTEBOOK_OUTPUT_POLL_MS = 50;

export function currentQueuePollIntervalMs(): number {
  return process.env.VITEST
    ? TEST_QUEUE_POLL_INTERVAL_MS
    : DEFAULT_QUEUE_POLL_INTERVAL_MS;
}

export function currentAwaitNotebookOutputPollMs(): number {
  return process.env.VITEST
    ? TEST_AWAIT_NOTEBOOK_OUTPUT_POLL_MS
    : DEFAULT_AWAIT_NOTEBOOK_OUTPUT_POLL_MS;
}
