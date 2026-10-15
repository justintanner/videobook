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
        const result = await call('dropbox_connect_start', {}) as { authorize_url: string }
        if (popup) popup.location.href = result.authorize_url
        else window.open(result.authorize_url, '_blank', 'noopener,noreferrer')
      }
      setStatus(await call('dropbox_connect_status', {}) as { connected: boolean; pending: boolean; error?: string })
    } catch (cause) { popup?.close(); setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <article className="settings-dropbox-connection"><div className="settings-credential-copy"><strong>Dropbox delivery</strong><p>{status?.connected ? 'Connected · offline access enabled' : status?.pending ? 'Approve access in Dropbox, then check connection.' : 'Deliver private clip files and captions for manual posting.'}</p><small>App key: DROPBOX_CLIENT_ID · Redirect: http://127.0.0.1:8766/callback</small></div><button type="button" disabled={busy || !call} onClick={() => void invoke(true)}>{status?.connected ? 'Reconnect Dropbox' : 'Connect Dropbox'}</button><button type="button" disabled={busy || !call} onClick={() => void invoke(false)}>Check connection</button>{(error || status?.error) && <p role="alert" className="settings-error">{error ?? status?.error}</p>}</article>
}
