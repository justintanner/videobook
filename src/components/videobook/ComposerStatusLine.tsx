import { X } from 'lucide-react'

export type ComposerStatusTone = 'error' | 'info'

export interface ComposerStatusLineProps {
  dismissLabel: string
  message: string
  onDismiss?: () => void
  tone: ComposerStatusTone
}

/* One line of status inside the composer dock — the app-level notice and the
   last execute outcome both read as this. The row is as wide as the words in
   it, so the dismiss control sits beside the sentence it clears instead of at
   the far edge of a dock that spans the window. */
export function ComposerStatusLine({
  dismissLabel,
  message,
  onDismiss,
  tone,
}: ComposerStatusLineProps) {
  const failed = tone === 'error'
  return (
    <div
      className={`command-result ${failed ? 'command-result-error' : 'command-result-ok'}`}
      role={failed ? 'alert' : 'status'}
      aria-live="polite"
    >
      <span className="composer-history-kind">{failed ? 'ERROR' : 'STATUS'}</span>
      <span>{message}</span>
      {onDismiss && (
        <button
          type="button"
          className="command-result-dismiss"
          aria-label={dismissLabel}
          onClick={onDismiss}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
