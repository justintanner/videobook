import type { ReactNode } from 'react'
import type { NotebookCellType } from 'videobook-engine'
import {
  isNotebookMediaCellType,
  notebookCellStateFromStatus,
} from '@/videobook/notebook-cell-presentation'
import { CellClockOverlay } from './CellClockOverlay'
import { CellFailedOverlay } from './CellFailedOverlay'

export function CellStateOverlay({
  kind,
  slug,
  status,
  statusStartedAt,
  statusError,
  icon,
  onRetry,
}: {
  kind: NotebookCellType
  slug: string
  status: string
  statusStartedAt?: string
  statusError?: string
  icon: ReactNode
  onRetry?: () => void
}) {
  const presentation = notebookCellStateFromStatus(kind, status, {
    error: statusError ?? null,
    startedAt: statusStartedAt ?? null,
  })

  if (presentation.overlay === 'clock' && presentation.label) {
    return (
      <CellClockOverlay
        icon={icon}
        label={presentation.label}
        slug={slug}
        startedAt={presentation.startedAt}
        variant={status === 'downloading' ? 'stream' : 'rise'}
      />
    )
  }

  if (presentation.overlay === 'failed' && presentation.error) {
    return (
      <CellFailedOverlay
        error={presentation.error}
        label={isNotebookMediaCellType(kind) ? 'MEDIA FAILED' : 'GENERATION FAILED'}
        slug={slug}
        onRetry={onRetry}
      />
    )
  }

  return null
}
