import { Captions, ClipboardCopy, Download, Maximize2 } from 'lucide-react'
import type { MediaDockKind } from '@/videobook/media-dock'
import { useMediaFileActions, type MediaFileToolCall } from '@/videobook/use-media-file-actions'

type MediaDockFullscreenAction = {
  address: string
  onOpen: () => void
}

export type MediaDockTranscribeAction = {
  label: string
  running: boolean
  disabled: boolean
  onRun: () => void
}

function FullscreenAction({ address, onOpen }: MediaDockFullscreenAction) {
  const label = `Open @${address} fullscreen`
  return (
    <button
      type="button"
      className="inspector-media-file-action"
      aria-label={label}
      title={label}
      onClick={onOpen}
    >
      <Maximize2 size={13} aria-hidden="true" />
      <span>Fullscreen</span>
    </button>
  )
}

function TranscribeAction({ label, running, disabled, onRun }: MediaDockTranscribeAction) {
  return (
    <button
      type="button"
      className="inspector-media-file-action inspector-media-file-action-primary"
      aria-label={label}
      title={label}
      aria-busy={running}
      disabled={disabled}
      onClick={onRun}
    >
      <Captions size={13} aria-hidden="true" />
      <span>{running ? 'Transcribing…' : label}</span>
    </button>
  )
}

export function MediaDockActions({
  bookId,
  artifactId,
  kind,
  busy,
  call,
  fullscreen,
  transcribe,
}: {
  bookId: string
  artifactId: string
  kind: MediaDockKind
  busy: boolean
  call: MediaFileToolCall | undefined
  fullscreen?: MediaDockFullscreenAction
  transcribe?: MediaDockTranscribeAction
}) {
  const { state, available, run } = useMediaFileActions({ call, bookId, artifactId })
  const running = state.phase === 'running'
  const disabled = busy || !available || running

  return (
    <section className="inspector-media-file-actions" aria-label="Media actions">
      <div className="inspector-media-file-buttons">
        {fullscreen && <FullscreenAction {...fullscreen} />}
        <button
          type="button"
          className="inspector-media-file-action"
          disabled={disabled}
          aria-label={`Copy ${kind}`}
          aria-busy={running && state.action === 'copy'}
          title="Copy the original media file to the clipboard"
          onClick={() => void run('copy')}
        >
          <ClipboardCopy size={13} aria-hidden="true" />
          <span>{running && state.action === 'copy' ? 'Copying…' : 'Copy'}</span>
        </button>
        <button
          type="button"
          className="inspector-media-file-action"
          disabled={disabled}
          aria-label={`Download ${kind}`}
          aria-busy={running && state.action === 'download'}
          title="Save the original media file to Downloads"
          onClick={() => void run('download')}
        >
          <Download size={13} aria-hidden="true" />
          <span>{running && state.action === 'download' ? 'Downloading…' : 'Download'}</span>
        </button>
        {transcribe && <TranscribeAction {...transcribe} />}
      </div>
      {state.phase === 'done' && <p role="status">{state.message}</p>}
      {state.phase === 'failed' && (
        <p className="inspector-insight-error" role="alert">{state.message}</p>
      )}
    </section>
  )
}
