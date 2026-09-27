import { notebookCellRunObservation } from './notebook-cell-presentation'
import type { NotebookDocument } from 'videobook-engine'

export type ChatTurnStatus = 'sending' | 'working' | 'queued' | 'review' | 'completed' | 'failed' | 'cancelled'

export interface ChatWork {
  key: string
  label: string
  jobId?: number
  operationId?: string
  runId?: string
  cellId?: string
  artifactId?: string
  state: ChatTurnStatus
  detail?: string
}

export interface ChatTurn {
  id: number
  bookId: string
  notebookId: string | null
  text: string
  status: ChatTurnStatus
  reply: string
  executing: boolean
  work: readonly ChatWork[]
}

export interface ChatJob {
  id: number
  operationId: string
  state: string
  artifactId: string | null
  payload: Record<string, unknown> | null
  error: { message: string } | null
}

export interface ChatExecution {
  id: number
  visible?: boolean
  isCurrent: () => boolean
  isInScope: () => boolean
  working: () => void
  review: (open: boolean) => void
  accept: (tool: string, args: Record<string, unknown>, result: unknown) => void
  finish: (outcome: { ok: boolean; message: string; status?: 'cancelled' }) => void
}

export function presentChat(chat: ChatExecution | undefined, present: () => void): void {
  if (!chat || chat.isCurrent()) present()
}

export function reviewChat(chat: ChatExecution | undefined, open: boolean, present: () => void): void {
  if (chat && !chat.isCurrent()) return
  chat?.review(open)
  present()
}

export function chatTurnActive(turn: ChatTurn): boolean {
  return ['sending', 'working', 'queued', 'review'].includes(turn.status)
}

export function chatTurnLabel(turn: ChatTurn, connected = true): string {
  if (!connected && chatTurnActive(turn) && turn.status !== 'review') return 'Reconnecting…'
  const labels: Record<ChatTurnStatus, string> = {
    sending: 'Sending', working: 'Working', queued: 'Queued', review: 'Awaiting review',
    completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
  }
  const completed = turn.work.filter(work => work.state === 'completed').length
  return turn.work.length > 1 && chatTurnActive(turn) && turn.status !== 'review'
    ? `${labels[turn.status]} · ${completed} of ${turn.work.length} complete`
    : labels[turn.status]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function workState(state: unknown): ChatTurnStatus {
  if (state === 'failed' || state === 'error') return 'failed'
  if (state === 'aborted' || state === 'cancelled') return 'cancelled'
  if (state === 'done' || state === 'completed' || state === 'ready') return 'completed'
  if (state === 'running' || state === 'completing' || state === 'processing') return 'working'
  return 'queued'
}

export function chatResultWork(tool: string, args: Record<string, unknown>, value: unknown): ChatWork[] {
  const result = record(value)
  if (!result) return []
  const jobId = result.job_id ?? result.jobId ?? result.retry_job_id
  const operationId = string(jobId) ?? string(result.operation_id ?? result.operationId)
  const runId = string(result.run_id ?? result.runId)
  const cellIds = Array.isArray(result.cell_ids) ? result.cell_ids : Array.isArray(args.cell_ids) ? args.cell_ids : []
  const cellId = string((tool === 'run_notebook_cell' ? result.output_cell_id : undefined)
    ?? result.cell_id ?? result.cellId ?? args.cell_id ?? (cellIds.length === 1 ? cellIds[0] : undefined))
  const artifactId = string(result.output_artifact_id ?? result.outputArtifactId ?? result.artifact_id ?? result.artifactId ?? result.asset_id ?? result.assetId)
  const label = tool.replaceAll('_', ' ').replace(/^./u, value => value.toUpperCase())
  const work: ChatWork[] = []
  if (typeof jobId === 'number' || operationId) {
    work.push({
      key: runId ? `run:${runId}` : `job:${jobId ?? operationId}`,
      label,
      ...(typeof jobId === 'number' ? { jobId } : {}),
      operationId, runId, cellId, artifactId,
      state: runId ? 'queued' : workState(result.status),
    })
  }
  if (Array.isArray(result.steps)) {
    for (const value of result.steps) {
      const step = record(value)
      if (!step || !Array.isArray(step.child_job_ids)) continue
      for (const id of step.child_job_ids) {
        if (typeof id !== 'number') continue
        work.push({ key: `job:${id}`, jobId: id, label: string(step.tool)?.replaceAll('_', ' ') ?? label, state: workState(step.status) })
      }
    }
  }
  return work
}

export function mergeChatWork(current: readonly ChatWork[], incoming: readonly ChatWork[]): readonly ChatWork[] {
  const merged = new Map(current.map(work => [work.key, work]))
  for (const work of incoming) {
    const previous = merged.get(work.key)
    merged.set(work.key, previous && ['completed', 'failed', 'cancelled'].includes(previous.state) ? previous : { ...previous, ...work })
  }
  return [...merged.values()]
}

export function settleChatTurn(turn: ChatTurn): ChatTurn {
  if (turn.status === 'sending' || turn.status === 'review' || turn.status === 'failed' || turn.status === 'cancelled') return turn
  if (!turn.work.length) return turn
  const failed = turn.work.find(work => work.state === 'failed')
  if (failed) return { ...turn, status: 'failed', reply: failed.detail ?? turn.reply }
  const active = turn.work.filter(work => work.state === 'queued' || work.state === 'working')
  if (active.length) return { ...turn, status: active.some(work => work.state === 'working') ? 'working' : 'queued' }
  if (turn.executing) return { ...turn, status: 'working' }
  const status = turn.work.some(work => work.state === 'cancelled') ? 'cancelled' : 'completed'
  return { ...turn, status, reply: turn.status === 'queued' || turn.status === 'working'
    ? status === 'completed' ? 'Work completed.' : 'Work cancelled.' : turn.reply }
}

export function observeChatWork(
  turn: ChatTurn,
  jobs: readonly ChatJob[],
  notebook?: NotebookDocument,
  assets: readonly { artifactId: string; status: string; mediaUrl: string | null }[] = [],
): ChatTurn {
  const work = turn.work.map(item => {
    if (['completed', 'failed', 'cancelled'].includes(item.state)) return item
    const related = jobs.filter(job => job.id === item.jobId || job.operationId === item.operationId
      || (item.runId && job.payload?.runId === item.runId))
    const failed = related.find(job => job.state === 'failed' || job.state === 'aborted')
    if (failed) return { ...item, state: workState(failed.state), detail: failed.error?.message }
    if (item.runId && notebook?.id === turn.notebookId) {
      const cellIds = item.cellId ? [item.cellId] : Object.entries(notebook.execution ?? {})
        .filter(([, value]) => record(value)?.runId === item.runId).map(([id]) => id)
      const observations = cellIds.map(cellId => notebookCellRunObservation(notebook, cellId, item.runId!))
      if (observations.length && observations.every(observation => observation.state === 'completed')) return { ...item, state: 'completed' as const }
      const error = observations.find(observation => observation.state === 'error')
      if (error) return { ...item, state: 'failed' as const, detail: error.error ?? undefined }
      return { ...item, state: related.some(job => job.state !== 'queued') ? 'working' as const : item.state }
    }
    const active = related.find(job => ['queued', 'running', 'completing'].includes(job.state))
    if (active) return { ...item, state: workState(active.state) }
    if (!related.length) return item
    if (item.runId) return { ...item, state: 'working' as const }
    const artifactId = item.artifactId ?? related.find(job => job.artifactId)?.artifactId
    const asset = assets.find(asset => asset.artifactId === artifactId)
    if (asset && asset.status !== 'ready') return { ...item, state: workState(asset.status) }
    if (artifactId && !asset) return { ...item, artifactId, state: 'working' as const }
    return { ...item, state: 'completed' as const }
  })
  return settleChatTurn({ ...turn, work })
}
