import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { RotateCcw, Trash2, Wrench } from 'lucide-react'
import type { GenerationIdentity } from '@/videobook/output-generation'
import { CellGeneratorIdentity } from './CellGeneratorIdentity'

export type DownloadRetry = 'standard' | 'chrome'

function keepPressOnButton(event: ReactPointerEvent<HTMLButtonElement>) {
  event.stopPropagation()
}

export function CellFailedOverlay({
  error,
  label,
  address,
  meta = null,
  onRepair,
  onRetry,
  downloadRetry,
  onDelete,
  disabled = false,
}: {
  error: string
  label: string
  address: string
  meta?: GenerationIdentity | null
  onRepair?: () => void
  onRetry?: () => void
  downloadRetry?: DownloadRetry
  onDelete?: () => void
  disabled?: boolean
}) {
  const act = (action: () => void) =>
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      action()
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
        <p className="cell-state-failed-message">{downloadRetry ? error.split('\n', 1)[0] : error}</p>
        {meta && <CellGeneratorIdentity identity={meta} className="cell-state-meta" />}
        {(onRepair || onRetry || onDelete) && (
          <div className="cell-state-actions">
            {onRetry && (
              <button
                type="button"
                className="cell-state-action cell-state-retry nodrag"
                aria-label={downloadRetry === 'chrome' ? `Retry @${address} with Chrome` : `Retry @${address}`}
                title={downloadRetry === 'chrome' ? 'Retry the download with the dedicated Chrome profile'
                  : downloadRetry ? 'Retry the download in this cell' : 'Delete this failed output and generate again with the saved settings'}
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
        )}
      </div>
    </div>
  )
}
