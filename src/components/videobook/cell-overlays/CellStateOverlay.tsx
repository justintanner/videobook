import type { ReactNode } from 'react'
import type { NotebookCellType } from 'videobook-engine'
import { isGenerationCreditError } from '../../../../server/src/generation-credit-error'
import { isNotebookMediaPresentationCellType } from '@/videobook/notebook-cell-types'
import {
  notebookCellGenerationPhase,
  notebookCellStateFromStatus,
} from '@/videobook/notebook-cell-presentation'
import { CellClockDock, CellClockOverlay } from './CellClockOverlay'
import { CellFailedOverlay, type DownloadRetry } from './CellFailedOverlay'

function failureLabel(
  kind: NotebookCellType,
  downloadRetry: DownloadRetry | undefined,
  generation: boolean,
): string {
  if (downloadRetry) return 'DOWNLOAD FAILED'
  return isNotebookMediaPresentationCellType(kind) && !generation ? 'MEDIA FAILED' : 'GENERATION FAILED'
}

export function CellStateOverlay({
  kind,
  address,
  status,
  statusStartedAt,
  statusError,
  icon,
  generation = false,
  onRepair,
  onRetry,
  downloadRetry,
  onDelete,
  disabled,
  docked = false,
  overPicture = false,
}: {
  kind: NotebookCellType
  address: string
  status: string
  statusStartedAt?: string
  statusError?: string
  icon: ReactNode
  generation?: boolean
  onRepair?: () => void
  onRetry?: () => void
  downloadRetry?: DownloadRetry
  onDelete?: () => void
  disabled?: boolean
  docked?: boolean
  overPicture?: boolean
}) {
  const presentation = notebookCellStateFromStatus(kind, status, {
    error: statusError ?? null,
    startedAt: statusStartedAt ?? null,
  })

  if (presentation.overlay === 'clock' && presentation.label) {
    const phase = generation ? notebookCellGenerationPhase(status) : null
    if (docked) {
      return (
        <CellClockDock
          label={presentation.label}
          detail={phase?.label ?? presentation.label}
          address={address}
          startedAt={presentation.startedAt}
          phase={phase}
          waiting={presentation.tone === 'queued'}
        />
      )
    }
    return (
      <CellClockOverlay
        icon={icon}
        label={presentation.label}
        address={address}
        startedAt={presentation.startedAt}
        variant={status === 'downloading' ? 'stream' : 'rise'}
        phase={phase}
        overPicture={overPicture}
      />
    )
  }

  if (presentation.overlay === 'failed' && presentation.error) {
    const creditFailure = isGenerationCreditError(presentation.error)
    return (
      <CellFailedOverlay
        error={presentation.error}
        label={failureLabel(kind, downloadRetry, generation)}
        address={address}
        onRepair={creditFailure ? undefined : onRepair}
        onRetry={downloadRetry || creditFailure ? onRetry : undefined}
        downloadRetry={downloadRetry}
        onDelete={onDelete}
        disabled={disabled}
        docked={docked}
      />
    )
  }

  return null
}
