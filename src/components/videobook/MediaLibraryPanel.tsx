import { useRef, useState, type KeyboardEvent } from 'react'
import { Film, Image, Library, Plus, Search, Upload, X } from 'lucide-react'
import { AssetTagSummary } from '@/components/videobook/AssetTagSummary'
import { BusyIndicator } from '@/components/videobook/BusyIndicator'
import { MediaLibraryAssetPreview } from '@/components/videobook/MediaLibraryAssetPreview'
import { ReverseSearchReference } from '@/components/videobook/ReverseSearchReference'
import type { TagFilterTerm, TagSuggestion } from '@/videobook/asset-tag-editing'
import type { SearchReferenceDescriptor } from '@/videobook/search-reference'
import type { SearchReferenceMode } from '@/videobook/search-reference-lifecycle'
import type { LibraryBrowsePage } from '@/videobook/useLibraryBrowse'
import type { LibraryAssetRecord } from '@/videobook/workspace-responses'

export type MediaLibraryKind = 'audio' | 'image' | 'video'

export type MediaLibraryPanelState = {
  unindexedVisualAssets: number
  preparingIndex: boolean
  cellId: string
  query: string
  draftQuery: string
  assets: LibraryAssetRecord[]
  page: LibraryBrowsePage
  booksWithErrors: Array<{ bookId: string; message: string }>
  loading: boolean
  loadingMore: boolean
  error: string | null
  activeArtifactId: string | null
  tagFilters: TagFilterTerm[]
  tagSuggestions: TagSuggestion[]
  mode: SearchReferenceMode
  reference: SearchReferenceDescriptor | null
  referenceStartSeconds: string
  referenceDurationSeconds: string
  preparingReference: boolean
  uploading: boolean
}

type MediaLibraryPanelProps = {
  state: MediaLibraryPanelState
  kind: MediaLibraryKind
  accept: string
  targetBookId: string
  onClose: () => void
  onMode: (mode: SearchReferenceMode) => void
  onDraftQuery: (query: string) => void
  onSearch: () => void
  onLoadMore: () => void
  onAttach: (asset: LibraryAssetRecord) => void
  onUpload: (file: File) => void
  onReferenceFile: (file: File) => void
  onClearReference: () => void
  onReferenceStart: (value: string) => void
  onReferenceDuration: (value: string) => void
  onSimilar: (asset: LibraryAssetRecord) => void
  onRepairIndexes: () => void
  onToggleTagFilter: (term: TagFilterTerm) => void
  onClearTagFilters: () => void
  onTagQuery: (prefix: string) => void
}

const searchModes: Array<{ id: SearchReferenceMode; label: string; icon: typeof Search }> = [
  { id: 'text', label: 'Text', icon: Search },
  { id: 'image-reverse', label: 'Image reverse', icon: Image },
  { id: 'video-reverse', label: 'Vid reverse', icon: Film },
]

function kindNoun(kind: MediaLibraryKind): string {
  return kind === 'audio' ? 'audio' : `${kind}s`
}

function relativeTime(iso: string | null, now: number): string | null {
  if (!iso) return null
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return null
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function sortLabel(state: MediaLibraryPanelState): string {
  if (state.mode !== 'text') return 'Most similar'
  return state.query.trim() ? 'Best match' : 'Recently used'
}

function canSearchSimilar(asset: LibraryAssetRecord): boolean {
  return asset.type === 'image' || asset.type === 'video' || asset.type === 'final'
}

function MediaLibraryCard({
  asset,
  state,
  targetBookId,
  busy,
  now,
  onAttach,
  onSimilar,
  onToggleTagFilter,
}: {
  asset: LibraryAssetRecord
  state: MediaLibraryPanelState
  targetBookId: string
  busy: boolean
  now: number
  onAttach: (asset: LibraryAssetRecord) => void
  onSimilar: (asset: LibraryAssetRecord) => void
  onToggleTagFilter: (term: TagFilterTerm) => void
}) {
  const active = state.activeArtifactId === asset.artifactId
  const label = asset.label.trim() || 'Untitled media'
  const used = relativeTime(asset.lastUsedAt, now)
  return (
    <article className="media-library-asset">
      <MediaLibraryAssetPreview asset={asset} />
      <span className="media-library-asset-copy">
        <strong>{label}</strong>
        <small>
          {asset.owningBookName}
          {asset.owningBookId === targetBookId ? ' · this book' : ' · copy'}
        </small>
      </span>
      {used && <span className="media-library-asset-used">Used {used}</span>}
      <AssetTagSummary
        tags={asset.tags}
        limit={2}
        onFilter={onToggleTagFilter}
        activeTerms={state.tagFilters}
      />
      {active && (
        <span className="media-library-asset-busy">
          <BusyIndicator size={16} />Attaching…
        </span>
      )}
      <span className="media-library-asset-actions">
        {canSearchSimilar(asset) && (
          <button
            type="button"
            className="media-library-asset-similar"
            disabled={busy}
            title="Find similar media"
            onClick={() => onSimilar(asset)}
          >
            <Search size={12} />Similar
          </button>
        )}
        <button
          type="button"
          className="media-library-asset-use"
          disabled={busy}
          aria-label={`Use ${label} from ${asset.owningBookName}`}
          title={`Use ${label}`}
          onClick={() => onAttach(asset)}
        />
      </span>
    </article>
  )
}

function MediaLibraryTagFilters({
  state,
  onToggleTagFilter,
  onClearTagFilters,
  onTagQuery,
}: Pick<MediaLibraryPanelProps, 'state' | 'onToggleTagFilter' | 'onClearTagFilters' | 'onTagQuery'>) {
  return (
    <div className="media-library-tag-filters">
      <label className="media-library-tag-input-label">
        <span className="sr-only">Filter by tag</span>
        <input
          className="media-library-tag-input"
          list="media-library-tag-suggestions"
          placeholder="Filter by tag"
          aria-label="Filter by tag"
          autoComplete="off"
          onChange={(event) => onTagQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            const typed = event.currentTarget.value.trim()
            if (!typed) return
            const match = state.tagSuggestions.find((suggestion) =>
              suggestion.label.toLowerCase() === typed.toLowerCase())
            if (!match) return
            onToggleTagFilter({ facet: match.facet, key: match.key, label: match.label })
            event.currentTarget.value = ''
          }}
        />
      </label>
      <datalist id="media-library-tag-suggestions">
        {state.tagSuggestions.map((suggestion) => (
          <option key={`${suggestion.facet}/${suggestion.key}`} value={suggestion.label}>
            {`${suggestion.facet} · ${suggestion.assets}`}
          </option>
        ))}
      </datalist>
      {state.tagFilters.map((term) => (
        <button
          type="button"
          key={`${term.facet}/${term.key}`}
          className="media-library-tag-filter"
          aria-label={`Remove tag filter ${term.label}`}
          onClick={() => onToggleTagFilter(term)}
        >
          {term.label}
          <X size={11} />
        </button>
      ))}
      {state.tagFilters.length > 0 && (
        <button type="button" className="media-library-tag-clear" onClick={onClearTagFilters}>
          Clear tags
        </button>
      )}
    </div>
  )
}

function MediaLibraryNotices({
  state,
  busy,
  onRepairIndexes,
}: Pick<MediaLibraryPanelProps, 'state' | 'onRepairIndexes'> & { busy: boolean }) {
  return (
    <>
      {state.error && <p className="media-library-error" role="alert">{state.error}</p>}
      {state.unindexedVisualAssets > 0 && (
        <div className="media-library-warning" role="status">
          {state.unindexedVisualAssets} media {state.unindexedVisualAssets === 1 ? 'asset is' : 'assets are'} missing from Similar search.
          {' '}
          <button type="button" disabled={busy || state.loading || state.preparingIndex} onClick={onRepairIndexes}>
            {state.preparingIndex ? 'Indexing…' : 'Index missing media'}
          </button>
        </div>
      )}
      {state.booksWithErrors.length > 0 && (
        <p className="media-library-warning" role="status">
          {state.booksWithErrors.length} book
          {state.booksWithErrors.length === 1 ? '' : 's'} could not be searched.
        </p>
      )}
    </>
  )
}

function MediaLibraryEmpty({ state, kind }: { state: MediaLibraryPanelState; kind: MediaLibraryKind }) {
  return (
    <div className="media-library-empty">
      <Library size={22} />
      <strong>No {kindNoun(kind)} found</strong>
      <span>
        {state.tagFilters.length > 0
          ? 'No media carries every selected tag. Clear a tag or try another search.'
          : 'Try another search, upload a file, or drop one onto the cell.'}
      </span>
    </div>
  )
}

export function MediaLibraryPanel(props: MediaLibraryPanelProps) {
  const {
    state,
    kind,
    accept,
    targetBookId,
    onClose,
    onMode,
    onDraftQuery,
    onSearch,
    onLoadMore,
    onAttach,
    onUpload,
    onSimilar,
    onToggleTagFilter,
  } = props
  const uploadRef = useRef<HTMLInputElement>(null)
  const busy = state.activeArtifactId !== null || state.preparingReference || state.uploading
  const [now] = useState(() => Date.now())
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || busy || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }

  return (
    <section
      className="media-library-panel"
      aria-label={`Choose ${kind} media`}
      onKeyDown={handleKeyDown}
    >
      <div className="media-library-toolbar">
        {state.mode === 'text' ? (
          <form
            className="media-library-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault()
              if (!busy) onSearch()
            }}
          >
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={state.draftQuery}
              aria-label="Search library"
              placeholder={`Search ${kindNoun(kind)} in every book`}
              autoFocus
              disabled={busy}
              onChange={(event) => onDraftQuery(event.target.value)}
            />
          </form>
        ) : (
          <span className="media-library-search media-library-search-reverse">
            <Search size={14} aria-hidden="true" />Reverse search across every book
          </span>
        )}
        {kind !== 'audio' && (
          <div className="media-library-modes" role="tablist" aria-label="Search mode">
            {searchModes.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={state.mode === item.id}
                  className={state.mode === item.id ? 'active' : ''}
                  disabled={busy}
                  onClick={() => onMode(item.id)}
                >
                  <Icon size={13} />{item.label}
                </button>
              )
            })}
          </div>
        )}
        <MediaLibraryTagFilters {...props} />
        <button
          type="button"
          className="media-library-upload"
          disabled={busy}
          onClick={() => uploadRef.current?.click()}
        >
          {state.uploading ? <BusyIndicator size={13} /> : <Upload size={13} />}
          {state.uploading ? 'Uploading…' : 'Upload'}
        </button>
        <input
          ref={uploadRef}
          className="media-library-upload-input"
          type="file"
          accept={accept}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) onUpload(file)
          }}
        />
      </div>
      {state.mode !== 'text' && (
        <div className="media-library-search-panel">
          <ReverseSearchReference
            mode={state.mode}
            reference={state.reference}
            preparing={state.preparingReference}
            disabled={state.activeArtifactId !== null}
            startSeconds={state.referenceStartSeconds}
            durationSeconds={state.referenceDurationSeconds}
            onFile={props.onReferenceFile}
            onClear={props.onClearReference}
            onStartSeconds={props.onReferenceStart}
            onDurationSeconds={props.onReferenceDuration}
          >
            <p className="media-library-similar-hint">
              Or choose Similar on any result below.
            </p>
          </ReverseSearchReference>
          {state.reference && (
            <button
              type="button"
              className="media-library-reverse-submit"
              disabled={busy || state.loading}
              onClick={onSearch}
            >
              <Search size={14} />Search similar media
            </button>
          )}
        </div>
      )}
      <div className="media-library-results" aria-busy={state.loading || state.loadingMore}>
        <MediaLibraryNotices state={state} busy={busy} onRepairIndexes={props.onRepairIndexes} />
        {state.loading && state.assets.length === 0 ? (
          <div className="media-library-loading">
            <BusyIndicator size={22} />{state.preparingIndex ? 'Preparing search…' : 'Loading recent media…'}
          </div>
        ) : state.assets.length === 0 ? (
          <MediaLibraryEmpty state={state} kind={kind} />
        ) : (
          <div className="media-library-grid">
            {state.assets.map((asset) => (
              <MediaLibraryCard
                key={`${asset.owningBookId}:${asset.artifactId}`}
                asset={asset}
                state={state}
                targetBookId={targetBookId}
                busy={busy}
                now={now}
                onAttach={onAttach}
                onSimilar={onSimilar}
                onToggleTagFilter={onToggleTagFilter}
              />
            ))}
          </div>
        )}
      </div>
      <footer className="media-library-footer">
        <span>
          <strong>{sortLabel(state)}</strong>
          {' · '}{state.assets.length} of {state.page.total} {kindNoun(kind)}
        </span>
        {state.page.hasMore && (
          <button type="button" disabled={busy || state.loadingMore} onClick={onLoadMore}>
            {state.loadingMore ? <BusyIndicator size={13} /> : <Plus size={13} />}
            {state.preparingIndex ? 'Preparing search…' : state.loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </footer>
    </section>
  )
}
