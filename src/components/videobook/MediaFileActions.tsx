import { ClipboardCopy, Download } from 'lucide-react'
import type { MediaDockKind } from '@/videobook/media-dock'
import { useMediaFileActions, type MediaFileToolCall } from '@/videobook/use-media-file-actions'

export function MediaFileActions({
  bookId,
  artifactId,
  kind,
  busy,
  call,
}: {
  bookId: string
  artifactId: string
  kind: MediaDockKind
  busy: boolean
  call: MediaFileToolCall | undefined
}) {
  const { state, available, run } = useMediaFileActions({ call, bookId, artifactId })
  const running = state.phase === 'running'
  const disabled = busy || !available || running

  return (
    <section className="inspector-media-file-actions" aria-label="Media file actions">
      <div className="inspector-media-file-buttons">
        <button
          type="button"
          className="inspector-generation-action"
          disabled={disabled}
          aria-busy={running && state.action === 'copy'}
          title="Copy the original media file to the clipboard"
          onClick={() => void run('copy')}
        >
          <ClipboardCopy size={13} aria-hidden="true" />
          {running && state.action === 'copy' ? 'Copying…' : `Copy ${kind}`}
        </button>
        <button
          type="button"
          className="inspector-generation-action"
          disabled={disabled}
          aria-busy={running && state.action === 'download'}
          title="Save the original media file to Downloads"
          onClick={() => void run('download')}
        >
          <Download size={13} aria-hidden="true" />
          {running && state.action === 'download' ? 'Downloading…' : `Download ${kind}`}
        </button>
      </div>
      {state.phase === 'done' && <p role="status">{state.message}</p>}
      {state.phase === 'failed' && (
        <p className="inspector-insight-error" role="alert">{state.message}</p>
      )}
    </section>
  )
}
