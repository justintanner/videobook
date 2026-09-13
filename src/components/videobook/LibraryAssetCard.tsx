import {
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import {
  AudioWaveform,
  BookOpen,
  Ellipsis,
  Film,
  Image,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { AssetTagSummary } from '@/components/videobook/AssetTagSummary'
import type { AssetTags } from '@/videobook/asset-tags'
import {
  formatLibraryAssetDate,
  formatLibraryAssetDateTime,
  libraryAssetKindLabel,
  libraryAssetTitle,
} from '@/videobook/library-presentation'
import { formatMediaTime } from '@/videobook/notebook-cell-presentation'

export type LibraryAssetCardAsset = {
  artifactId: string
  id: string
  label: string
  type: string
  status: string
  createdAt: string
  prompt: string | null
  duration: number | null
  mediaUrl: string | null
  thumbnailUrl: string | null
  owningBookId: string
  owningBookName: string
  tags: AssetTags | null
}

export type LibraryAssetCardIngest = {
  state: string
  phases: Record<string, string>
}

export type LibraryAssetCardProps = {
  asset: LibraryAssetCardAsset
  layout: 'grid' | 'row'
  ownedHere: boolean
  showBook: boolean
  showRetry: boolean
  retryBusy: boolean
  ingestStatus?: LibraryAssetCardIngest
  busy: boolean
  onOpenBook: (bookId: string) => void
  onSearchSimilar: () => void
  onForget: () => void
  onRetry: () => void
}

function PreviewFallback({ type, duration }: { type: string; duration: number | null }) {
  const Icon = type === 'audio' ? AudioWaveform : type === 'image' ? Image : Film
  return (
    <span className="library-asset-fallback">
      <Icon size={28} />
      {duration !== null && <small>{formatMediaTime(duration)}</small>}
    </span>
  )
}

function LibraryAssetPreview({
  asset,
  title,
}: {
  asset: LibraryAssetCardAsset
  title: string
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const [mediaFailed, setMediaFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const video = asset.type === 'video' || asset.type === 'final'
  const imageUrl = asset.thumbnailUrl
    ?? (asset.type === 'image' ? asset.mediaUrl : null)
  const previewKey = `${asset.artifactId}:${imageUrl ?? ''}:${asset.mediaUrl ?? ''}`
  const [activePreviewKey, setActivePreviewKey] = useState(previewKey)
  if (activePreviewKey !== previewKey) {
    setActivePreviewKey(previewKey)
    setImageFailed(false)
    setMediaFailed(false)
    setPlaying(false)
  }

  useEffect(() => {
    if (playing) return
    videoRef.current?.pause()
    audioRef.current?.pause()
  }, [playing])

  const showImage = Boolean(imageUrl && !imageFailed)
  const canPlay = Boolean(asset.mediaUrl && (video || asset.type === 'audio') && !mediaFailed)

  return (
    <div className="library-asset-preview">
      {showImage && imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
        />
      ) : playing && canPlay && asset.mediaUrl && video ? (
        <video
          ref={videoRef}
          src={asset.mediaUrl}
          controls
          playsInline
          autoPlay
          preload="metadata"
          onError={() => {
            setMediaFailed(true)
            setPlaying(false)
          }}
        />
      ) : playing && canPlay && asset.mediaUrl && asset.type === 'audio' ? (
        <audio
          ref={audioRef}
          src={asset.mediaUrl}
          controls
          autoPlay
          preload="metadata"
          onError={() => {
            setMediaFailed(true)
            setPlaying(false)
          }}
        />
      ) : (
        <PreviewFallback type={asset.type} duration={asset.duration} />
      )}
      {canPlay && !playing && (
        <button
          type="button"
          className="library-asset-play"
          aria-label={`Play ${title}`}
          onClick={() => setPlaying(true)}
        >
          Play
        </button>
      )}
    </div>
  )
}

export function LibraryAssetCard({
  asset,
  layout,
  ownedHere,
  showBook,
  showRetry,
  retryBusy,
  ingestStatus,
  busy,
  onOpenBook,
  onSearchSimilar,
  onForget,
  onRetry,
}: LibraryAssetCardProps) {
  const title = libraryAssetTitle(asset)
  const date = formatLibraryAssetDate(asset.createdAt)
  const fullTimestamp = formatLibraryAssetDateTime(asset.createdAt)
  const similar = asset.type === 'image'
    || asset.type === 'video'
    || asset.type === 'final'
  const usable = asset.status === 'ready' && Boolean(asset.mediaUrl || asset.thumbnailUrl)
  const [menuOpen, setMenuOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuButtonRef = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()
  const compact = layout === 'row'

  useEffect(() => {
    if (!menuOpen) return
    const onPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        menuButtonRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const bookLabel = ownedHere
    ? `${asset.owningBookName} · this book`
    : asset.owningBookName

  return (
    <article
      className={asset.status === 'error'
        ? `record-card library-asset-card library-asset-card-${layout} library-asset-card-error`
        : `record-card library-asset-card library-asset-card-${layout}`}
    >
      {!compact && (
        <LibraryAssetPreview asset={asset} title={title} />
      )}
      <span
        className={asset.status === 'error'
          ? 'library-asset-status library-asset-status-error'
          : 'library-asset-status'}
      >
        {libraryAssetKindLabel(asset.type)} · {asset.status}
      </span>
      <AssetTagSummary tags={asset.tags} />
      <div className="library-asset-body">
        <div className="library-asset-copy">
          <strong title={asset.id}>{title}</strong>
          <small title={fullTimestamp || undefined}>
            {date}
            {asset.duration !== null ? ` · ${formatMediaTime(asset.duration)}` : ''}
          </small>
          {showBook && (
            <button
              type="button"
              className="library-asset-book"
              disabled={busy}
              title={`Show only ${asset.owningBookName}`}
              aria-label={bookLabel}
              onClick={() => onOpenBook(asset.owningBookId)}
            >
              <BookOpen size={11} />
              <span>{asset.owningBookName}</span>
              {ownedHere ? <em>this book</em> : null}
            </button>
          )}
        </div>
        <div className="library-asset-actions">
          {similar && usable && (
            <button
              type="button"
              className="library-asset-similar"
              disabled={busy}
              title="Search similar moments"
              aria-label={`Search moments similar to ${title}`}
              onClick={onSearchSimilar}
            >
              <Search size={13} />
            </button>
          )}
          {showRetry && (
            <button
              type="button"
              className="library-asset-retry"
              disabled={busy}
              onClick={onRetry}
            >
              <RefreshCw size={13} />
              {retryBusy ? 'Processing…' : 'Retry'}
            </button>
          )}
          {ownedHere && (
            <div className="library-asset-overflow" ref={menuRef}>
              <button
                ref={menuButtonRef}
                type="button"
                className="library-asset-overflow-trigger"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-controls={menuId}
                title="More actions"
                aria-label={`More actions for ${title}`}
                disabled={busy}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <Ellipsis size={13} />
              </button>
              {menuOpen && (
                <div className="library-asset-menu" role="menu" id={menuId}>
                  <button
                    type="button"
                    role="menuitem"
                    className="library-asset-forget"
                    disabled={busy}
                    onClick={() => {
                      setMenuOpen(false)
                      onForget()
                    }}
                  >
                    <Trash2 size={13} />
                    Forget
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {(asset.prompt || ingestStatus || compact) && (
        <div className="library-asset-details">
          <button
            type="button"
            className="library-asset-details-toggle"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {detailsOpen ? 'Hide details' : 'Details'}
          </button>
          {detailsOpen && (
            <div className="library-asset-details-body">
              <p title={asset.id}>{asset.id}</p>
              {fullTimestamp && <p>{fullTimestamp}</p>}
              {asset.prompt && <p>{asset.prompt}</p>}
              {ingestStatus && (
                <div className="library-asset-ingest">
                  <span className={`ingest-phase ingest-phase-${ingestStatus.state}`}>
                    ingest · {ingestStatus.state}
                  </span>
                  <div className="ingest-phase-grid">
                    {Object.entries(ingestStatus.phases).map(([phase, state]) => (
                      <span className={`ingest-phase ingest-phase-${state}`} key={phase}>
                        {phase} · {state}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  )
}
