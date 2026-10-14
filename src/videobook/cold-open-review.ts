import type { ColdOpenSuggestion } from '../../server/src/cold-open-model'
import { coldOpenRangeError } from '../../server/src/cold-open-model'

export type ColdOpenReview = {
  bookId: string
  notebookId: string
  assetId: string
  label: string
  mediaUrl: string
  requestId: string
  suggestion: ColdOpenSuggestion | null
}

type ColdOpenCall = (tool: string, args: Record<string, unknown>, options?: { background?: boolean }) => Promise<unknown>

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cold-open response')
  return value as Record<string, unknown>
}

function suggestionFrom(value: unknown): ColdOpenSuggestion {
  const item = record(value)
  if (typeof item.sourceArtifactId !== 'string' || typeof item.sourceObjectHash !== 'string'
    || typeof item.durationSeconds !== 'number' || typeof item.fps !== 'number'
    || typeof item.startSeconds !== 'number' || typeof item.endSeconds !== 'number'
    || typeof item.reason !== 'string' || typeof item.model !== 'string'
    || coldOpenRangeError(item.startSeconds, item.endSeconds, item.durationSeconds)) {
    throw new Error('The server returned an invalid cold-open selection')
  }
  return item as unknown as ColdOpenSuggestion
}

async function completedJob(call: ColdOpenCall, bookId: string, jobId: unknown, isCurrent: () => boolean): Promise<Record<string, unknown>> {
  if (typeof jobId !== 'number') throw new Error('The server did not return a cold-open job ID')
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (!isCurrent()) throw new Error('Workspace changed. Reopen the cold-open review.')
    const value = await call('list_jobs', { book_id: bookId, job_ids: [jobId] }, { background: true })
    if (!Array.isArray(value) || !value.length) throw new Error('The cold-open job could not be found')
    const job = record(value[0])
    if (job.state === 'done') return record(job.result)
    if (job.state === 'failed' || job.state === 'aborted') throw new Error(String(record(job.error ?? {}).message ?? 'Cold-open job cancelled'))
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('The cold open is still processing. Check Jobs, then retry to reconnect.')
}

export async function prepareColdOpenReview(call: ColdOpenCall, review: ColdOpenReview, isCurrent: () => boolean): Promise<ColdOpenReview> {
  const response = record(await call('prepare_cold_open', {
    book_id: review.bookId, notebook_id: review.notebookId, asset_id: review.assetId,
  }))
  const result = response.status === 'ready' ? response : await completedJob(call, review.bookId, response.job_id, isCurrent)
  const suggestion = suggestionFrom(result.suggestion)
  if (!isCurrent() || suggestion.sourceArtifactId !== review.assetId) throw new Error('Workspace changed. Reopen the cold-open review.')
  return { ...review, suggestion }
}

export async function renderColdOpenReview(call: ColdOpenCall, review: ColdOpenReview, isCurrent: () => boolean): Promise<{ cellId: string; address: string }> {
  const selection = review.suggestion
  if (!selection) throw new Error('Find a highlight first')
  const error = coldOpenRangeError(selection.startSeconds, selection.endSeconds, selection.durationSeconds)
  if (error) throw new Error(error)
  const response = record(await call('edit_cold_open', {
    book_id: review.bookId, notebook_id: review.notebookId, asset_id: review.assetId,
    source_object_hash: selection.sourceObjectHash, start_time: selection.startSeconds, end_time: selection.endSeconds,
    request_id: review.requestId,
  }))
  const result = await completedJob(call, review.bookId, response.job_id, isCurrent)
  if (!isCurrent()) throw new Error('Workspace changed. The copy is available in its original notebook.')
  if (typeof result.cell_id !== 'string' || typeof result.address !== 'string') throw new Error('The cold-open copy has no notebook cell')
  return { cellId: result.cell_id, address: result.address }
}
