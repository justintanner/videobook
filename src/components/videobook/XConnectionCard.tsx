import { Share2 } from 'lucide-react'
import {
  xConnectionPresentation,
  type XConnectionState,
} from '@/videobook/x-connection'

export function XConnectionCard({
  busy,
  connection,
  onConnect,
}: {
  busy: boolean
  connection: XConnectionState
  onConnect: () => void
}) {
  const presentation = xConnectionPresentation(connection.status, {
    connecting: connection.connecting,
  })
  const actionDisabled = busy
    || connection.connecting
    || presentation.actionLabel === null

  return (
    <article
      className={`provider-card x-connection-card x-connection-${presentation.tone}`}
      aria-label="X account"
    >
      <span className="provider-dot" aria-hidden="true" />
      <div>
        <strong>X account</strong>
        <p>{presentation.label} · {presentation.detail}</p>
        {connection.connecting && connection.authorizeUrl && (
          <p>
            <a href={connection.authorizeUrl} target="_blank" rel="noopener noreferrer">
              Open the X authorization page
            </a>
            {' '}if no browser tab appeared.
          </p>
        )}
        {connection.error && !connection.connecting && (
          <p className="x-connection-error" role="alert">{connection.error}</p>
        )}
      </div>
      <button type="button" disabled={actionDisabled} onClick={onConnect}>
        <Share2 size={13} aria-hidden="true" />
        {connection.connecting ? 'Waiting…' : presentation.actionLabel ?? 'Connect X'}
      </button>
    </article>
  )
}
