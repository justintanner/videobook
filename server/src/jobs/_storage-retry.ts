import { setTimeout as delay } from "node:timers/promises";

const RETRY_DELAYS_MS = [50, 200, 800, 2_000] as const;

export function isTransientStorageConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /commit conflict: another connection committed/i.test(message);
}

export async function withTransientStorageRetry<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      const retryDelay = RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined || !isTransientStorageConflict(error)) {
        throw error;
      }
      await delay(
        retryDelay,
        undefined,
        signal ? { signal } : undefined,
      );
    }
  }
}
