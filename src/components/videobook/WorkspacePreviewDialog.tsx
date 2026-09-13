import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { Sequence } from 'videobook-engine'
import type { CanonicalPlaybackAsset } from '@/remotion/CanonicalSequenceComposition'
import { CanonicalSequencePlayer } from './CanonicalSequencePlayer'
import type { CanonicalSequencePlayerHandle } from './CanonicalSequencePlayer'
import { captureDismissedComposerFocus } from '@/videobook/command-composer-focus'

export type WorkspaceMediaPreview = {
  label: string
  assetId: string
  type: string
  url: string | null
  thumbnailUrl?: string | null
  files: { name: string; url: string }[]
  initialFile?: string
  opener: HTMLElement | null
}

type Props = {
  media?: WorkspaceMediaPreview
  sequence?: Sequence
  assets: CanonicalPlaybackAsset[]
  opener: HTMLElement | null
  initialFrame?: number
  onActions: () => void
  onClose: () => void
}

export function WorkspacePreviewDialog({ media, sequence, assets, opener, initialFrame = 0, onActions, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const playerRef = useRef<CanonicalSequencePlayerHandle>(null)
  const [filename, setFilename] = useState(media?.initialFile ?? '')
  const file = media?.files.find((entry) => entry.name === filename)
  const url = file?.url ?? media?.url
  const type = file ? /\.(?:mp4|webm|mov)$/iu.test(file.name) ? 'video' : /\.(?:wav|mp3|m4a|weba|ogg)$/iu.test(file.name) ? 'audio' : /\.(?:png|jpg|jpeg|webp|gif)$/iu.test(file.name) ? 'image' : 'file' : media?.type
  const close = () => { const restore = captureDismissedComposerFocus(opener); onClose(); restore() }

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    playerRef.current?.seekTo(initialFrame)
    return () => dialog?.close()
  }, [initialFrame])

  return createPortal(<dialog ref={dialogRef} className="workspace-actions-dialog workspace-preview-dialog" aria-label={media?.label ?? 'Sequence preview'}
    onCancel={(event) => { event.preventDefault(); close() }}>
    <header><h2>{media?.label ?? 'Sequence preview'}</h2><button type="button" aria-label="Close preview" onClick={close}><X size={18} /></button></header>
    <div className="workspace-preview-content">
      {media && <label>Version or file<select value={filename} onChange={(event) => setFilename(event.target.value)}>
        <option value="">Current media</option>{media.files.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
      </select></label>}
      {sequence && <CanonicalSequencePlayer ref={playerRef} sequence={sequence} assets={assets} editingEnabled={false} onFrameUpdate={() => undefined} onKeyboardAction={() => undefined} />}
      {media && !url && <p role="status">This media has no playable file yet. Check its processing status in Jobs.</p>}
      {url && type === 'image' && <img src={url} alt={media?.label ?? 'Media preview'} />}
      {url && (type === 'video' || type === 'final') && <video src={url} poster={media?.thumbnailUrl ?? undefined} controls playsInline preload="metadata" />}
      {url && type === 'audio' && <audio src={url} controls preload="metadata" />}
      {url && <a href={url} target="_blank" rel="noreferrer">Open current file</a>}
      <button type="button" onClick={onActions}>More actions</button>
    </div>
  </dialog>, document.body)
}
