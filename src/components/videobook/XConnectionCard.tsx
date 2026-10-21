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
      className={`settings-row x-connection-card x-connection-${presentation.tone}`}
      aria-label="X account"
    >
      <div className="settings-row-main">
        <div className="settings-row-copy">
          <strong>X</strong>
          <span className="settings-row-detail">{presentation.label} · {presentation.detail}</span>
        </div>
        <button type="button" disabled={actionDisabled} onClick={onConnect}>
          {connection.connecting ? 'Waiting…' : presentation.actionLabel ?? 'Connect X'}
        </button>
      </div>
      {connection.connecting && connection.authorizeUrl && (
        <p className="settings-note">
          <a href={connection.authorizeUrl} target="_blank" rel="noopener noreferrer">
            Open the X authorization page
          </a>
          {' '}if no browser tab appeared.
        </p>
      )}
      {connection.error && !connection.connecting && (
        <p className="settings-error x-connection-error" role="alert">{connection.error}</p>
      )}
    </article>
  )
}
