import type { MouseEvent as ReactMouseEvent } from 'react'
import { RotateCcw } from 'lucide-react'

export function CellFailedOverlay({
  error,
  slug,
  onRetry,
}: {
  error: string
  slug: string
  onRetry: () => void
}) {
  return (
    <div
      className="cell-state-overlay cell-state-overlay-failed"
      role="alert"
      aria-label={`@${slug} generation failed`}
      title={error}
    >
      <div className="cell-state-scanlines" aria-hidden="true" />
      <div className="cell-state-failed-wash" aria-hidden="true" />
      <div className="cell-state-overlay-body cell-state-failed-body">
        <strong>GENERATION FAILED</strong>
        <p className="cell-state-failed-message">{error}</p>
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
      </div>
    </div>
  )
}
