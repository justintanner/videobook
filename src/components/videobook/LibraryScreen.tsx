import { useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, Library, RefreshCw } from 'lucide-react'
import { BusyIndicator } from './BusyIndicator'
import { LibraryAssetCard } from './LibraryAssetCard'
import type { LibraryAssetCardAsset, LibraryAssetCardIngest } from './LibraryAssetCard'
import {
  LIBRARY_BROWSE_STATUSES,
  libraryGridHeading,
} from '@/videobook/library-scope'
import type { LibraryBrowseStatus, LibraryScope } from '@/videobook/library-scope'
import type { LibraryBrowseState } from '@/videobook/useLibraryBrowse'
import {
  libraryCardLayout,
  libraryEmptyCopy,
  libraryLoadingCopy,
  libraryStatusLabel,
} from '@/videobook/library-presentation'

export function LibraryScreen<Asset extends LibraryAssetCardAsset>({
  children,
  bookId,
  bookCount,
  scope,
  status,
  browse,
  busy,
  ready,
  notice,
  processingArtifactId,
  ingestStatuses,
  onStatusChange,
  onImport,
  onRefresh,
  onLoadMore,
  onOpenBook,
  onSearchSimilar,
  onForget,
  onRetry,
}: {
  children: ReactNode
  bookId: string
  bookCount: number
  scope: LibraryScope
  status: LibraryBrowseStatus
  browse: LibraryBrowseState<Asset>
  busy: boolean
  ready: boolean
  notice: { tone: string; text: string } | null
  processingArtifactId: string | null
  ingestStatuses: ReadonlyMap<string, LibraryAssetCardIngest>
  onStatusChange: (status: LibraryBrowseStatus) => void
  onImport: (files: File[]) => void
  onRefresh: () => void
  onLoadMore: () => void
  onOpenBook: (bookId: string) => void
  onSearchSimilar: (asset: Asset) => void
  onForget: (asset: Asset) => void
  onRetry: (artifactId: string) => void
}) {
  const [selectedPreview, setSelectedPreview] = useState<string | null>(null)
  const layout = libraryCardLayout(status)
  const { assets, page, statusCounts, booksWithErrors, error, loading, loadingMore } = browse
  const totalCount = statusCounts.ready + statusCounts.processing + statusCounts.error
  const empty = libraryEmptyCopy(totalCount === 0 ? 'all' : status)
  const failed = Boolean(error || booksWithErrors.length)

  return (
    <section
      className="workspace-screen library-drop-zone"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return
        event.preventDefault()
        onImport([...event.dataTransfer.files])
      }}
      onPaste={(event) => {
        const files = [...event.clipboardData.files]
        if (files.length === 0) return
        event.preventDefault()
        onImport(files)
      }}
    >
      {children}
      <div className="library-heading-row">
        <div className="library-heading-copy">
          <span className="section-label">Media</span>
          <h2>
            {loading && assets.length === 0
              ? 'Loading media…'
              : libraryGridHeading({
                scope,
                status,
                shown: assets.length,
                total: page.total,
                bookCount,
                more: page.hasMore,
                booksFailed: booksWithErrors.length + (error ? 1 : 0),
              })}
          </h2>
          <span className="library-drop-hint">Drop or paste files on the page to import</span>
        </div>
        <div className="library-status-control" role="group" aria-label="Browse status">
          <span className="library-status-label">Status</span>
          {LIBRARY_BROWSE_STATUSES.map((option) => {
            const count = option === 'all' ? totalCount : statusCounts[option]
            return (
              <button
                type="button"
                key={option}
                disabled={!ready}
                aria-pressed={status === option}
                onClick={() => onStatusChange(option)}
              >
                {libraryStatusLabel(option)}
                {!failed && count > 0 ? ` ${count}` : ''}
              </button>
            )
          })}
        </div>
      </div>
      {notice && (
        <p
          className={notice.tone === 'error' ? 'library-scope-error' : 'library-scope-notice'}
          role={notice.tone === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}
      {failed && (
        <div className="library-load-error" role="alert">
          <p>{error ?? `${booksWithErrors.length} book${booksWithErrors.length === 1 ? '' : 's'} could not be listed.`}</p>
          <button type="button" disabled={!ready || loading || browse.refreshing} onClick={onRefresh}>
            <RefreshCw size={14} /> Retry loading
          </button>
        </div>
      )}
      {loading && assets.length === 0 ? (
        <div className="library-loading" role="status">
          <BusyIndicator size={24} />
          <strong>{libraryLoadingCopy(status, scope, false)}</strong>
        </div>
      ) : assets.length === 0 && !failed ? (
        <div className="library-empty">
          <Library size={25} />
          <strong>{empty.title}</strong>
          <p>{empty.body}</p>
          {status === 'ready' && totalCount > 0 && (
            <div className="library-empty-actions">
              <button type="button" onClick={() => onStatusChange('processing')}>View processing</button>
              <button type="button" onClick={() => onStatusChange('error')}>View errors</button>
            </div>
          )}
        </div>
      ) : (
        <div className={layout === 'row' ? 'library-status-list' : 'record-grid'}>
          {assets.map((asset) => {
            const ownedHere = asset.owningBookId === bookId
            const ingestStatus = ownedHere ? ingestStatuses.get(asset.artifactId) : undefined
            const showRetry = ownedHere && (status === 'error' || status === 'all')
              && (asset.status === 'error' || ingestStatus?.state === 'failed')
            const previewKey = `${browse.key}:${asset.owningBookId}:${asset.artifactId}:${asset.mediaUrl}`
            return (
              <LibraryAssetCard
                key={`${asset.owningBookId}:${asset.artifactId}`}
                asset={asset}
                layout={layout}
                ownedHere={ownedHere}
                showBook={scope === 'library'}
                showRetry={showRetry}
                retryBusy={processingArtifactId === asset.artifactId}
                ingestStatus={ingestStatus}
                busy={busy}
                previewActive={selectedPreview === previewKey}
                onPreview={() => setSelectedPreview(previewKey)}
                onOpenBook={onOpenBook}
                onSearchSimilar={() => onSearchSimilar(asset)}
                onForget={() => onForget(asset)}
                onRetry={() => onRetry(asset.artifactId)}
              />
            )
          })}
        </div>
      )}
      {page.hasMore && (
        <div className="library-scope-footer">
          <button type="button" disabled={!ready || busy || loading || loadingMore || browse.refreshing} onClick={onLoadMore}>
            {loadingMore ? <BusyIndicator size={14} /> : <ChevronDown size={14} />}
            {loadingMore ? 'Loading more…' : 'Load more'}
          </button>
        </div>
      )}
    </section>
  )
}
