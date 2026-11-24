import type { NotebookCellType } from 'videobook-engine'
import type { PostView } from '../../server/src/posts/post-contract'
import {
  notebookCellClockLabel,
  notebookCellIsActiveStatus,
} from './notebook-cell-presentation'
import { postTileStatus } from './post-delivery-review'

export type CellStateFlagTone =
  | 'queued'
  | 'working'
  | 'attention'
  | 'failed'
  | 'done'
  | 'neutral'

export type CellStateFlag = {
  label: string
  tone: CellStateFlagTone
}

export type CellStateFlagInput = {
  kind: NotebookCellType
  status: string
  post?: PostView
  slotOperation?: 'attach' | 'upload' | null
  runningTakes?: number
  promptMissing?: boolean
}

const restingStatuses: ReadonlySet<string> = new Set(['', 'ready', 'completed'])

const postFlags: Readonly<Record<string, CellStateFlag>> = {
  uploading: { label: 'Uploading', tone: 'working' },
  scheduled: { label: 'Scheduled', tone: 'queued' },
  posting: { label: 'Posting', tone: 'working' },
  posted: { label: 'Posted', tone: 'done' },
  partially_posted: { label: 'Partly posted', tone: 'attention' },
  failed: { label: 'Failed', tone: 'failed' },
  needs_reconciliation: { label: 'Check post', tone: 'attention' },
  needs_link: { label: 'Needs link', tone: 'attention' },
}

function sentenceCase(label: string): string {
  const lower = label.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function waitingStatus(status: string): boolean {
  return status === 'queued' || status.startsWith('render-queued')
}

function activeStateFlag(kind: NotebookCellType, status: string): CellStateFlag {
  return {
    label: sentenceCase(notebookCellClockLabel(status, kind)),
    tone: waitingStatus(status) ? 'queued' : 'working',
  }
}

function postStateFlag(post: PostView): CellStateFlag | null {
  return postFlags[postTileStatus(post)] ?? null
}

export function cellStateFlag(input: CellStateFlagInput): CellStateFlag | null {
  if (input.post) return postStateFlag(input.post)
  if (input.slotOperation) {
    return {
      label: input.slotOperation === 'upload' ? 'Uploading' : 'Attaching',
      tone: 'working',
    }
  }
  if (input.status === 'error') return { label: 'Failed', tone: 'failed' }
  if (notebookCellIsActiveStatus(input.status)) {
    return activeStateFlag(input.kind, input.status)
  }
  if ((input.runningTakes ?? 0) > 0) return { label: 'Running', tone: 'working' }
  if (input.promptMissing) return { label: 'No prompt', tone: 'attention' }
  if (restingStatuses.has(input.status)) return null
  return { label: sentenceCase(input.status.replaceAll(/[-_]+/gu, ' ')), tone: 'neutral' }
}
