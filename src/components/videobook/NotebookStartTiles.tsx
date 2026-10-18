import { useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties, FormEvent, ReactNode } from 'react'
import { ViewportPortal } from '@xyflow/react'
import { Download, Image, Library, Link2, Plus, Video } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { mediaFileAccept } from '@/videobook/notebook-media-drop'
import { notebookGrid, notebookGridPosition, notebookGridTag } from '@/videobook/notebook-grid'
import type { NotebookGridSlot } from '@/videobook/notebook-grid'

export type NotebookStartMediaKind = 'image' | 'video'

type StartTileKind = NotebookStartMediaKind | 'download' | 'library'

type NotebookStartTilesProps = {
  busy: boolean
  compact: boolean
  dimmed: boolean
  onUpload: (slot: NotebookGridSlot, file: File) => void
  onPick: (kind: NotebookStartMediaKind, slot: NotebookGridSlot) => void
  onDownload: (url: string, slot: NotebookGridSlot) => Promise<void>
  onBrowseLibrary: () => void
}

type StartMediaCopy = {
  title: string
  hint: string
  label: string
  icon: LucideIcon
}

const startSlots: Record<StartTileKind, NotebookGridSlot> = {
  image: { row: 0, column: 0 },
  video: { row: 0, column: 1 },
  download: { row: 0, column: 2 },
  library: { row: 0, column: 3 },
}

const mediaCopy: Record<NotebookStartMediaKind, StartMediaCopy> = {
  image: { title: 'Add a picture', hint: 'png · jpg · webp · heic', label: 'Image', icon: Image },
  video: { title: 'Add a video', hint: 'mp4 · mov · webm', label: 'Video', icon: Video },
}

function tileStyle(slot: NotebookGridSlot): CSSProperties {
  const position = notebookGridPosition(slot)
  return {
    width: notebookGrid.squareSize,
    height: notebookGrid.squareSize,
    transform: `translate(${position.x}px, ${position.y}px)`,
  }
}

const startTileStyles: Record<StartTileKind, CSSProperties> = {
  image: tileStyle(startSlots.image),
  video: tileStyle(startSlots.video),
  download: tileStyle(startSlots.download),
  library: tileStyle(startSlots.library),
}

const lastStartPosition = notebookGridPosition(startSlots.library)

const startTilesStyle: CSSProperties = {
  width: lastStartPosition.x + notebookGrid.squareSize,
  height: lastStartPosition.y + notebookGrid.squareSize,
}

type StartTileProps = {
  kind: StartTileKind
  title: string
  icon: LucideIcon
  children: ReactNode
}

function StartTile({ kind, title, icon: Icon, children }: StartTileProps) {
  const address = notebookGridTag(startSlots[kind])
  return (
    <section
      className={`notebook-start-tile notebook-start-tile-${kind}`}
      style={startTileStyles[kind]}
      aria-label={`${address} ${title}`}
      data-start-address={address}
    >
      <div className="notebook-start-tile-head">
        <span>{address}</span>
        <Icon aria-hidden="true" />
      </div>
      <strong>{title}</strong>
      {children}
    </section>
  )
}

type StartMediaTileProps = {
  kind: NotebookStartMediaKind
  busy: boolean
  onUpload: (slot: NotebookGridSlot, file: File) => void
  onPick: (kind: NotebookStartMediaKind, slot: NotebookGridSlot) => void
}

function StartMediaTile({ kind, busy, onUpload, onPick }: StartMediaTileProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const copy = mediaCopy[kind]
  const slot = startSlots[kind]

  const acceptFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) onUpload(slot, file)
  }

  return (
    <StartTile kind={kind} title={copy.title} icon={copy.icon}>
      <span className="notebook-start-tile-hint notebook-start-tile-hint-optional">{copy.hint}</span>
      <div className="notebook-start-tile-actions">
        <button
          type="button"
          className="notebook-start-tile-primary"
          aria-label={`Upload ${kind}`}
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          <Plus aria-hidden="true" />
          <span>{copy.label}</span>
        </button>
        <button
          type="button"
          className="notebook-start-tile-secondary"
          aria-label={`${copy.label} from library`}
          disabled={busy}
          onClick={() => onPick(kind, slot)}
        >
          From library
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={mediaFileAccept[kind]}
        hidden
        disabled={busy}
        onChange={acceptFile}
      />
    </StartTile>
  )
}

type StartDownloadTileProps = {
  busy: boolean
  onDownload: (url: string, slot: NotebookGridSlot) => Promise<void>
}

function StartDownloadTile({ busy, onDownload }: StartDownloadTileProps) {
  const [url, setUrl] = useState('')
  const [downloading, setDownloading] = useState(false)
  const trimmedUrl = url.trim()
  const disabled = busy || downloading

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (disabled || !trimmedUrl) return
    setDownloading(true)
    try {
      await onDownload(trimmedUrl, startSlots.download)
      setUrl('')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <StartTile kind="download" title="Download a clip" icon={Link2}>
      <form className="notebook-start-tile-form" noValidate onSubmit={(event) => void submit(event)}>
        <input
          type="url"
          inputMode="url"
          aria-label="Clip link"
          placeholder="Paste a link"
          value={url}
          disabled={disabled}
          onChange={(event) => setUrl(event.target.value)}
        />
        <button
          type="submit"
          className="notebook-start-tile-primary"
          disabled={disabled || !trimmedUrl}
        >
          <Download aria-hidden="true" />
          <span>{downloading ? 'Queuing…' : 'Download'}</span>
        </button>
      </form>
    </StartTile>
  )
}

type StartLibraryTileProps = {
  busy: boolean
  onBrowseLibrary: () => void
}

function StartLibraryTile({ busy, onBrowseLibrary }: StartLibraryTileProps) {
  return (
    <StartTile kind="library" title="Your library" icon={Library}>
      <span className="notebook-start-tile-hint">From every book</span>
      <div className="notebook-start-tile-actions">
        <button
          type="button"
          className="notebook-start-tile-secondary"
          aria-label="Browse library"
          disabled={busy}
          onClick={onBrowseLibrary}
        >
          Browse
        </button>
      </div>
    </StartTile>
  )
}

export function NotebookStartTiles({
  busy,
  compact,
  dimmed,
  onUpload,
  onPick,
  onDownload,
  onBrowseLibrary,
}: NotebookStartTilesProps) {
  return (
    <ViewportPortal>
      <div
        className="notebook-start-tiles nodrag nopan"
        style={startTilesStyle}
        role="group"
        aria-label="Start this notebook"
        data-compact={compact}
        data-dimmed={dimmed}
      >
        <StartMediaTile kind="image" busy={busy} onUpload={onUpload} onPick={onPick} />
        <StartMediaTile kind="video" busy={busy} onUpload={onUpload} onPick={onPick} />
        <StartDownloadTile busy={busy} onDownload={onDownload} />
        <StartLibraryTile busy={busy} onBrowseLibrary={onBrowseLibrary} />
      </div>
    </ViewportPortal>
  )
}
