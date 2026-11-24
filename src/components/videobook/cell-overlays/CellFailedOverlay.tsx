import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { RotateCcw, Trash2, Wrench } from 'lucide-react'

export type DownloadRetry = 'standard' | 'chrome'

type CellFailedActionsProps = {
  address: string
  onRepair?: () => void
  onRetry?: () => void
  downloadRetry?: DownloadRetry
  onDelete?: () => void
  disabled: boolean
}

function keepPressOnButton(event: ReactPointerEvent<HTMLButtonElement>) {
  event.stopPropagation()
}

function act(action: () => void) {
  return (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    action()
  }
}

function retryTitle(downloadRetry: DownloadRetry | undefined): string {
  if (downloadRetry === 'chrome') return 'Retry the download with the dedicated Chrome profile'
  if (downloadRetry) return 'Retry the download in this cell'
  return 'Delete this failed output and generate again with the saved settings'
}

function CellFailedActions({
  address,
  onRepair,
  onRetry,
  downloadRetry,
  onDelete,
  disabled,
}: CellFailedActionsProps) {
  if (!onRepair && !onRetry && !onDelete) return null
  return (
    <div className="cell-state-actions">
      {onRetry && (
        <button
          type="button"
          className="cell-state-action cell-state-retry nodrag"
          aria-label={downloadRetry === 'chrome' ? `Retry @${address} with Chrome` : `Retry @${address}`}
          title={retryTitle(downloadRetry)}
          disabled={disabled}
          onPointerDown={keepPressOnButton}
          onClick={act(onRetry)}
        >
          <RotateCcw size={10} aria-hidden="true" />
          {downloadRetry === 'chrome' ? 'USE CHROME' : 'RETRY'}
        </button>
      )}
      {onRepair && (
        <button
          type="button"
          className="cell-state-action cell-state-repair nodrag"
          aria-label={`Repair @${address} in chat`}
          title="Send this failure to chat for a corrected re-run"
          onPointerDown={keepPressOnButton}
          onClick={act(onRepair)}
        >
          <Wrench size={10} aria-hidden="true" />
          REPAIR
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          className="cell-state-action cell-state-delete nodrag"
          aria-label={`Delete @${address}`}
          title="Delete this cell now"
          onPointerDown={keepPressOnButton}
          onClick={act(onDelete)}
        >
          <Trash2 size={10} aria-hidden="true" />
          DELETE
        </button>
      )}
    </div>
  )
}

export function CellFailedOverlay({
  error,
  label,
  address,
  onRepair,
  onRetry,
  downloadRetry,
  onDelete,
  disabled = false,
  docked = false,
}: {
  error: string
  label: string
  address: string
  onRepair?: () => void
  onRetry?: () => void
  downloadRetry?: DownloadRetry
  onDelete?: () => void
  disabled?: boolean
  docked?: boolean
}) {
  const message = downloadRetry ? error.split('\n', 1)[0] : error
  const actions = (
    <CellFailedActions
      address={address}
      onRepair={onRepair}
      onRetry={onRetry}
      downloadRetry={downloadRetry}
      onDelete={onDelete}
      disabled={disabled}
    />
  )

  if (docked) {
    return (
      <div
        className="cell-state-dock cell-state-dock-failed"
        role="alert"
        aria-label={`@${address} ${label.toLowerCase()}`}
        title={error}
      >
        <strong>{label}</strong>
        <p className="cell-state-failed-message">{message}</p>
        {actions}
      </div>
    )
  }

  return (
    <div
      className="cell-state-overlay cell-state-overlay-failed"
      role="alert"
      aria-label={`@${address} ${label.toLowerCase()}`}
      title={error}
    >
      <div className="cell-state-scanlines" aria-hidden="true" />
      <div className="cell-state-failed-wash" aria-hidden="true" />
      <div className="cell-state-overlay-body cell-state-failed-body">
        <strong>{label}</strong>
        <p className="cell-state-failed-message">{message}</p>
        {actions}
      </div>
    </div>
  )
}
