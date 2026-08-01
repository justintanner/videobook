import type { MouseEvent as ReactMouseEvent } from 'react'
import { RotateCcw } from 'lucide-react'

export function CellFailedOverlay({
  error,
  label,
  slug,
  onRetry,
}: {
  error: string
  label: string
  slug: string
  onRetry?: () => void
}) {
  return (
    <div
      className="cell-state-overlay cell-state-overlay-failed"
      role="alert"
      aria-label={`@${slug} ${label.toLowerCase()}`}
      title={error}
    >
      <div className="cell-state-scanlines" aria-hidden="true" />
      <div className="cell-state-failed-wash" aria-hidden="true" />
      <div className="cell-state-overlay-body cell-state-failed-body">
        <strong>{label}</strong>
        <p className="cell-state-failed-message">{error}</p>
        {onRetry && (
          <button
            type="button"
            className="cell-state-retry nodrag"
            aria-label={`Retry @${slug}`}
            title="Retry generation"
            onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
              event.stopPropagation()
              onRetry()
            }}
          >
            <RotateCcw size={10} aria-hidden="true" />
            RETRY
          </button>
        )}
      </div>
    </div>
  )
}
