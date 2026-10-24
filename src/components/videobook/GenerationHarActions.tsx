import { Download } from 'lucide-react'
import { useState, type MouseEvent } from 'react'
import type { GenerationHarStatus } from '@/videobook/generation-request-inspection'
import './GenerationHarActions.css'

export type DownloadGenerationHar = (generationId: string) => Promise<void>

type DownloadState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'failed'; message: string }

export function GenerationHarActions({
  generationId,
  status,
  captureOffHint = true,
  onDownload,
  onOpenSettings,
}: {
  generationId: string | null
  status: Pick<GenerationHarStatus, 'mode' | 'hasCapture'> | null | undefined
  captureOffHint?: boolean
  onDownload?: DownloadGenerationHar
  onOpenSettings?: () => void
}) {
  const [state, setState] = useState<DownloadState>({ phase: 'idle' })
  const canDownload = Boolean(status?.hasCapture && generationId && onDownload)
  const captureOff = captureOffHint && status?.mode === 'off'
  if (!canDownload && !captureOff) return null

  async function download() {
    if (!generationId || !onDownload || state.phase === 'running') return
    setState({ phase: 'running' })
    try {
      await onDownload(generationId)
      setState({ phase: 'idle' })
    } catch (error) {
      setState({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }

  function openSettings(event: MouseEvent<HTMLAnchorElement>) {
    if (!onOpenSettings) return
    event.preventDefault()
    onOpenSettings()
  }

  return (
    <span className="generation-har-actions">
      {canDownload && (
        <button
          type="button"
          aria-label="Download HAR"
          title="Download the scrubbed provider HAR capture"
          disabled={state.phase === 'running'}
          onClick={() => void download()}
        >
          <Download size={12} aria-hidden="true" />
          <span>HAR</span>
        </button>
      )}
      {captureOff && (
        <a
          href="/settings"
          title="Provider HAR capture is off. Turn it on in Settings, Diagnostics."
          onClick={openSettings}
        >
          Capture off
        </a>
      )}
      {state.phase === 'failed' && (
        <span className="generation-har-error" role="alert">{state.message}</span>
      )}
    </span>
  )
}
