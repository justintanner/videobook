type RepairJob = { bookId: string; jobId: number }
type RepairSummary = { indexed: number; failed: number; failures: Array<{ message: string }> }

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid search indexing response')
  return value as Record<string, unknown>
}

export async function repairSearchIndexes(options: {
  start: () => Promise<unknown>
  listJobs: (bookId: string, jobIds: number[]) => Promise<unknown>
  isCancelled: () => boolean
  intervalMs?: number
  timeoutMs?: number
}): Promise<RepairSummary | undefined> {
  const response = record(await options.start())
  if (!Array.isArray(response.jobs)) throw new Error('Invalid search indexing jobs')
  let pending = response.jobs.map((value: unknown): RepairJob => {
    const job = record(value)
    if (typeof job.bookId !== 'string' || typeof job.jobId !== 'number' || !Number.isSafeInteger(job.jobId) || job.jobId <= 0) {
      throw new Error('Invalid search indexing job')
    }
    return { bookId: job.bookId, jobId: job.jobId }
  })
  const summary: RepairSummary = { indexed: 0, failed: 0, failures: [] }
  const deadline = Date.now() + (options.timeoutMs ?? 20 * 60_000)
  while (pending.length > 0) {
    if (options.isCancelled()) return undefined
    if (Date.now() >= deadline) throw new Error('Indexing is still running. Reopen the Library to check coverage.')
    const remaining: RepairJob[] = []
    for (const bookId of new Set(pending.map((job) => job.bookId))) {
      if (options.isCancelled()) return undefined
      const jobs = pending.filter((job) => job.bookId === bookId)
      const statuses = await options.listJobs(bookId, jobs.map((job) => job.jobId))
      if (!Array.isArray(statuses)) throw new Error('Invalid search indexing status')
      for (const job of jobs) {
        const status = statuses.map(record).find((entry) => entry.id === job.jobId)
        if (!status) throw new Error('Indexing job could not be found. Reopen the Library to retry.')
        if (status.state === 'done') {
          const result = record(status.result)
          if (typeof result.indexed !== 'number' || typeof result.failed !== 'number' || !Array.isArray(result.failures)) {
            throw new Error('Invalid search indexing result')
          }
          summary.indexed += result.indexed
          summary.failed += result.failed
          for (const failure of result.failures) {
            const message = record(failure).message
            if (typeof message === 'string' && summary.failures.length < 20) summary.failures.push({ message })
          }
        } else if (status.state === 'failed' || status.state === 'aborted') {
          summary.failed += 1
          const error = status.error ? record(status.error).message : undefined
          if (summary.failures.length < 20) summary.failures.push({ message: typeof error === 'string' ? error : 'Search indexing failed' })
        } else remaining.push(job)
      }
    }
    pending = remaining
    if (pending.length > 0) await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1_000))
  }
  return options.isCancelled() ? undefined : summary
}
