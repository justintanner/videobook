import { X } from 'lucide-react'

export type ComposerStatusTone = 'error' | 'info'

export interface ComposerStatusLineProps {
  dismissLabel: string
  message: string
  onDismiss?: () => void
  tone: ComposerStatusTone
}

export function ComposerStatusLine({
  dismissLabel,
  message,
  onDismiss,
  tone,
}: ComposerStatusLineProps) {
  const failed = tone === 'error'
  return (
    <div
      className={`chat-bubble chat-bubble-assistant chat-feedback command-result ${failed ? 'command-result-error' : 'command-result-ok'}`}
      role={failed ? 'alert' : 'status'}
      aria-live="polite"
    >
      <div className="chat-feedback-content">
        <span className="composer-history-kind">{failed ? 'ERROR' : 'STATUS'}</span>
        <span>{message}</span>
      </div>
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
