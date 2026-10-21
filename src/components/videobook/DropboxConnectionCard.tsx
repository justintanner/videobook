import { useState } from 'react'
import type { PostToolCall } from '@/videobook/use-post-actions'

export function DropboxConnectionCard({ call }: { call?: PostToolCall }) {
  const [status, setStatus] = useState<{ connected: boolean; pending: boolean; error?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const invoke = async (connect: boolean) => {
    if (!call) return
    const popup = connect ? window.open('about:blank', '_blank') : null
    setBusy(true)
    setError(null)
    try {
      if (connect) {
        const result = await call('connect_service', { service: 'dropbox' }) as { authorize_url: string }
        if (popup) popup.location.href = result.authorize_url
        else window.open(result.authorize_url, '_blank', 'noopener,noreferrer')
      }
      setStatus(await call('service_status', { service: 'dropbox' }) as { connected: boolean; pending: boolean; error?: string })
    } catch (cause) { popup?.close(); setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const detail = status?.connected ? 'Connected · offline access enabled'
    : status?.pending ? 'Approve access in Dropbox, then check the connection.' : 'Not connected'
  return <article className="settings-row settings-dropbox-connection" aria-label="Dropbox">
    <div className="settings-row-main">
      <div className="settings-row-copy">
        <strong>Dropbox</strong>
        <span className="settings-row-detail">{detail}</span>
      </div>
      <button type="button" className="settings-quiet" aria-label="Check Dropbox connection" disabled={busy || !call} onClick={() => void invoke(false)}>Check</button>
      <button type="button" aria-label={status?.connected ? 'Reconnect Dropbox' : 'Connect Dropbox'} disabled={busy || !call} onClick={() => void invoke(true)}>{status?.connected ? 'Reconnect' : 'Connect'}</button>
    </div>
    {(error || status?.error) && <p role="alert" className="settings-error">{error ?? status?.error}</p>}
  </article>
}
