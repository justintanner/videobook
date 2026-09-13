import {
  useEffect,
  useId,
  useLayoutEffect,
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
  errorMessage: string | null
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

type LibraryAssetCardProps = {
  asset: LibraryAssetCardAsset
  layout: 'grid' | 'row'
  ownedHere: boolean
  showBook: boolean
  showRetry: boolean
  retryBusy: boolean
  ingestStatus?: LibraryAssetCardIngest
  busy: boolean
  previewActive: boolean
  onPreview: () => void
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
  active,
  onPlay,
}: {
  asset: LibraryAssetCardAsset
  title: string
  active: boolean
  onPlay: () => void
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const [mediaFailed, setMediaFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const video = asset.type === 'video' || asset.type === 'final'
  const imageUrl = asset.thumbnailUrl
    ?? (asset.type === 'image' ? asset.mediaUrl : null)
  useEffect(() => {
    const media = videoRef.current ?? audioRef.current
    return () => media?.pause()
  }, [active])

  const showImage = Boolean(imageUrl && !imageFailed)
  const canPlay = Boolean(asset.mediaUrl && (video || asset.type === 'audio') && !mediaFailed)

  return (
    <div className="library-asset-preview">
      {active && canPlay && asset.mediaUrl && video ? (
        <video
          ref={videoRef}
          src={asset.mediaUrl}
          poster={showImage ? imageUrl ?? undefined : undefined}
          aria-label={title}
          controls
          playsInline
          autoPlay
          preload="metadata"
          onError={() => {
            setMediaFailed(true)
          }}
        />
      ) : active && canPlay && asset.mediaUrl && asset.type === 'audio' ? (
        <audio
          ref={audioRef}
          src={asset.mediaUrl}
          aria-label={title}
          controls
          autoPlay
          preload="metadata"
          onError={() => {
            setMediaFailed(true)
          }}
        />
      ) : showImage && imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <PreviewFallback type={asset.type} duration={asset.duration} />
      )}
      {canPlay && !active && (
        <button
          type="button"
          className="library-asset-play"
          aria-label={`Play ${title}`}
          onClick={onPlay}
        >
          Play
        </button>
      )}
      {asset.type === 'image' && asset.mediaUrl && (
        <a
          className="library-asset-play"
          href={asset.mediaUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${title}`}
        >
          Open image
        </a>
      )}
      {mediaFailed && <span className="library-preview-error" role="status">Preview unavailable</span>}
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
  previewActive,
  onPreview,
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
  const menuItemRef = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()
  const detailsId = useId()
  const compact = layout === 'row'

  useLayoutEffect(() => {
    if (menuOpen) menuItemRef.current?.focus()
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    const onPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onFocus = (event: FocusEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('focusin', onFocus)
    }
  }, [menuOpen])

  const bookLabel = ownedHere
    ? `${asset.owningBookName} · this book`
    : asset.owningBookName

  return (
    <article
      className={(asset.status === 'error'
        ? `record-card library-asset-card library-asset-card-${layout} library-asset-card-error`
        : `record-card library-asset-card library-asset-card-${layout}`)
        + (menuOpen ? ' library-asset-menu-open' : '')}
    >
      {!compact && (
        <LibraryAssetPreview
          key={`${asset.owningBookId}:${asset.artifactId}:${asset.thumbnailUrl}:${asset.mediaUrl}`}
          asset={asset}
          title={title}
          active={previewActive}
          onPlay={onPreview}
        />
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
          <strong title={title}>{title}</strong>
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
              disabled={busy || retryBusy}
              onClick={onRetry}
            >
              <RefreshCw size={13} />
              {retryBusy ? 'Processing…' : 'Retry'}
            </button>
          )}
          {ownedHere && (
            <div
              className="library-asset-overflow"
              ref={menuRef}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && menuOpen) {
                  event.preventDefault()
                  event.stopPropagation()
                  setMenuOpen(false)
                  menuButtonRef.current?.focus()
                }
                if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault()
                  setMenuOpen(true)
                  menuItemRef.current?.focus()
                }
              }}
            >
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
                    ref={menuItemRef}
                    type="button"
                    role="menuitem"
                    className="library-asset-forget"
                    disabled={busy}
                    onClick={() => {
                      setMenuOpen(false)
                      menuButtonRef.current?.focus()
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
      <div className="library-asset-details">
        <button
          type="button"
          className="library-asset-details-toggle"
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {detailsOpen ? 'Hide details' : 'Details'}
        </button>
        {detailsOpen && (
          <div className="library-asset-details-body" id={detailsId}>
            <p>{asset.artifactId}</p>
            {fullTimestamp && <p>{fullTimestamp}</p>}
            {asset.errorMessage && <p>{asset.errorMessage}</p>}
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
    </article>
  )
}
