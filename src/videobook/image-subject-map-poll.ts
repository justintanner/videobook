import { guardedAsyncResult } from './async-request-guard'
import type { ImageSubjectMap } from './image-subject-map'

export const IMAGE_SUBJECT_MAP_POLL_INTERVAL_MS = 3_000
export const IMAGE_SUBJECT_MAP_POLL_TIMEOUT_MS = 27 * 60_000

export type ImageSubjectMapPollResult =
  | { kind: 'terminal'; map: ImageSubjectMap }
  | { kind: 'timeout'; map: ImageSubjectMap }
  | { kind: 'error'; map: ImageSubjectMap; error: unknown }
  | { kind: 'stale' }

type ImageSubjectMapPollOptions = {
  initialMap: ImageSubjectMap
  read: () => Promise<ImageSubjectMap>
  publish: (map: ImageSubjectMap) => void
  isCurrent: () => boolean
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
  intervalMs?: number
  timeoutMs?: number
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function startedAtMilliseconds(startedAt: string | null, fallback: number): number {
  if (!startedAt) return fallback
  const value = Date.parse(startedAt)
  return Number.isFinite(value) ? value : fallback
}

export async function pollImageSubjectMap({
  initialMap,
  read,
  publish,
  isCurrent,
  now = Date.now,
  wait = waitFor,
  intervalMs = IMAGE_SUBJECT_MAP_POLL_INTERVAL_MS,
  timeoutMs = IMAGE_SUBJECT_MAP_POLL_TIMEOUT_MS,
}: ImageSubjectMapPollOptions): Promise<ImageSubjectMapPollResult> {
  if (!isCurrent()) return { kind: 'stale' }
  if (initialMap.status !== 'analyzing') {
    return { kind: 'terminal', map: initialMap }
  }
  let latest = initialMap
  const deadline = startedAtMilliseconds(initialMap.startedAt, now()) + timeoutMs
  while (isCurrent()) {
    const remaining = deadline - now()
    if (remaining <= 0) return { kind: 'timeout', map: latest }
    await wait(Math.min(intervalMs, remaining))
    if (!isCurrent()) return { kind: 'stale' }
    if (now() >= deadline) return { kind: 'timeout', map: latest }
    const response = await guardedAsyncResult(read, isCurrent)
    if (response.kind === 'stale') return response
    if (response.kind === 'error') {
      return { kind: 'error', map: latest, error: response.error }
    }
    latest = response.value
    publish(latest)
    if (latest.status !== 'analyzing') {
      return { kind: 'terminal', map: latest }
    }
  }
  return { kind: 'stale' }
}
