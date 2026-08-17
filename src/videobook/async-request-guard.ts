export type GuardedAsyncResult<T> =
  | { kind: 'current'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'stale' }

export async function guardedAsyncResult<T>(
  request: () => Promise<T>,
  isCurrent: () => boolean,
): Promise<GuardedAsyncResult<T>> {
  if (!isCurrent()) return { kind: 'stale' }
  try {
    const value = await request()
    return isCurrent()
      ? { kind: 'current', value }
      : { kind: 'stale' }
  } catch (error) {
    return isCurrent()
      ? { kind: 'error', error }
      : { kind: 'stale' }
  }
}
