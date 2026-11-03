import { X } from 'lucide-react'

export type ComposerStatusTone = 'error' | 'info'

export interface ComposerStatusAction {
  label: string
  onRun: () => void
}

export interface ComposerStatusLineProps {
  action?: ComposerStatusAction
  dismissLabel: string
  message: string
  onDismiss?: () => void
  tone: ComposerStatusTone
}

export function ComposerStatusLine({
  action,
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
      {action && (
        <button type="button" className="command-result-action" onClick={action.onRun}>
          {action.label}
        </button>
      )}
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
