import { compatibleReferenceFile } from './search-reference'

type SearchSubmitIntent =
  | { kind: 'url'; url: string }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }

/** Classify the search input: a lone http(s) URL imports, other text searches. */
export function detectSearchSubmitIntent(raw: string): SearchSubmitIntent {
  const trimmed = raw.trim()
  if (!trimmed) return { kind: 'empty' }
  if (/^https?:\/\/\S+$/i.test(trimmed)) return { kind: 'url', url: trimmed }
  return { kind: 'text', text: trimmed }
}

type DownloadWatchStep =
  | { kind: 'continue' }
  | { kind: 'ready' }
  | { kind: 'failed'; message: string }

/**
 * Decide whether the download job for a freshly imported artifact has settled,
 * from a raw `list_jobs` result. The artifact id is brand new, so any matching
 * job belongs to this import.
 */
export function downloadWatchStep(
  jobsValue: unknown,
  artifactId: string,
): DownloadWatchStep {
  if (!Array.isArray(jobsValue)) return { kind: 'continue' }
  for (const entry of jobsValue) {
    if (typeof entry !== 'object' || entry === null) continue
    const job = entry as Record<string, unknown>
    if (job.type !== 'download_video') continue
    if ((job.artifactId ?? job.artifact_id) !== artifactId) continue
    if (job.state === 'done') return { kind: 'ready' }
    if (job.state === 'failed' || job.state === 'aborted') {
      const error = job.error
      const message = typeof error === 'object' && error !== null
        && typeof (error as Record<string, unknown>).message === 'string'
        ? (error as Record<string, unknown>).message as string
        : 'Import failed'
      return { kind: 'failed', message }
    }
    return { kind: 'continue' }
  }
  return { kind: 'continue' }
}

/** The search-reference kind a file can act as, or null when it can't be one. */
export function searchReferenceKindForFile(file: File): 'image' | 'video' | null {
  if (compatibleReferenceFile(file, 'image')) return 'image'
  if (compatibleReferenceFile(file, 'video')) return 'video'
  return null
}

const importWatchIntervalMs = 2_000
const importWatchTimeoutMs = 10 * 60_000

type DownloadWatchOutcome =
  | { kind: 'ready' }
  | { kind: 'failed'; message: string }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }

/**
 * Poll `listJobs` until the download job for `artifactId` settles. The import
 * keeps running server-side after a timeout or cancellation.
 */
export async function watchDownloadJob(options: {
  artifactId: string
  listJobs: () => Promise<unknown>
  isCancelled: () => boolean
  intervalMs?: number
  timeoutMs?: number
}): Promise<DownloadWatchOutcome> {
  const intervalMs = options.intervalMs ?? importWatchIntervalMs
  const deadline = Date.now() + (options.timeoutMs ?? importWatchTimeoutMs)
  while (Date.now() < deadline) {
    await delay(intervalMs)
    if (options.isCancelled()) return { kind: 'cancelled' }
    const step = downloadWatchStep(await options.listJobs(), options.artifactId)
    if (options.isCancelled()) return { kind: 'cancelled' }
    if (step.kind !== 'continue') return step
  }
  return { kind: 'timeout' }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
