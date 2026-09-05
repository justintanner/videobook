type PreparationJob = { bookId: string; jobId: number }

function preparationJobs(value: unknown): PreparationJob[] {
  if (typeof value !== 'object' || value === null) return []
  const jobs = (value as Record<string, unknown>).preparationJobs
  if (!Array.isArray(jobs)) return []
  return jobs.flatMap((job: unknown) => {
    if (typeof job !== 'object' || job === null) return []
    const entry = job as Record<string, unknown>
    return typeof entry.bookId === 'string' && typeof entry.jobId === 'number'
      && Number.isSafeInteger(entry.jobId) && entry.jobId > 0
      ? [{ bookId: entry.bookId, jobId: entry.jobId }]
      : []
  })
}

export async function searchWithPreparation(options: {
  search: () => Promise<unknown>
  listJobs: (bookId: string, jobIds: number[]) => Promise<unknown>
  onPreparing: (value: boolean) => void
  isCancelled: () => boolean
  intervalMs?: number
  timeoutMs?: number
}): Promise<unknown> {
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000)
  try {
    while (!options.isCancelled()) {
      const value = await options.search()
      let pending = preparationJobs(value)
      if (options.isCancelled()) return undefined
      if (pending.length === 0) return value
      options.onPreparing(true)
      while (pending.length > 0) {
        if (Date.now() >= deadline) throw new Error('Search preparation is still running. Try searching again shortly.')
        if (options.isCancelled()) return undefined
        const remaining: PreparationJob[] = []
        for (const bookId of new Set(pending.map((job) => job.bookId))) {
          const jobs = pending.filter((job) => job.bookId === bookId)
          const response = await options.listJobs(bookId, jobs.map((job) => job.jobId))
          if (!Array.isArray(response)) throw new Error('The server returned an invalid search preparation status')
          for (const job of jobs) {
            const status = response.find((entry: unknown) => typeof entry === 'object' && entry !== null
              && (entry as Record<string, unknown>).id === job.jobId) as Record<string, unknown> | undefined
            if (!status) throw new Error('Search preparation could not be found. Try searching again.')
            if (status.state === 'failed' || status.state === 'aborted') {
              const error = status.error as { message?: string } | undefined
              throw new Error(error?.message ?? 'Search preparation failed. Try searching again.')
            }
            if (status.state !== 'done') remaining.push(job)
          }
        }
        pending = remaining
        if (pending.length > 0) await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1_000))
      }
    }
    return undefined
  } finally {
    options.onPreparing(false)
  }
}
