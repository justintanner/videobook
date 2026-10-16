import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import {
  ExternalLink,
  Film,
  Image,
  Paperclip,
  Pin,
  Replace,
  Search,
  Send,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import type {
  SearchHit,
  SearchModality,
  SearchPage,
  SearchQuery,
} from 'videobook-engine'
import { BusyIndicator } from '@/components/videobook/BusyIndicator'
import {
  prepareExistingSearchReference,
  referenceKind,
  searchReferenceRange,
  uploadSearchReference,
  type ReverseSearchMode,
  type SearchReferenceDescriptor,
} from '@/videobook/search-reference'
import {
  detectSearchSubmitIntent,
  searchReferenceKindForFile,
  watchDownloadJob,
} from '@/videobook/import-then-search'
import type { LibraryScope } from '@/videobook/library-scope'
import { useSearchReferenceLifecycle } from '@/videobook/useSearchReferenceLifecycle'
import { searchWithPreparation } from '@/videobook/search-preparation'

interface MomentSearchAsset {
  artifactId: string
  id: string
  type: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  /** Set when the asset comes from another book in library scope. */
  owningBookId?: string
}

interface MomentSearchProps {
  bookId: string
  notebookId?: string
  assets: MomentSearchAsset[]
  disabled: boolean
  call: (tool: string, args: Record<string, unknown>, options?: { background?: boolean }) => Promise<unknown>
  onNotice: (message: string) => void
  onNotebookChanged: () => Promise<void>
  onLibraryChanged: () => Promise<void>
  importControls: ReactNode
  /** Shared with the Library grid so both sides of the screen agree. */
  scope: LibraryScope
  onScopeChange: (scope: LibraryScope) => void
}

export interface MomentSearchHandle {
  searchSimilar: (asset: MomentSearchAsset) => void
}

type PresentedSearchHit = SearchHit & {
  owningBookId?: string
  owningBookName?: string
  mediaUrl?: string | null
  thumbnailUrl?: string | null
}
type PresentedSearchPage = Omit<SearchPage, 'hits'> & {
  hits: PresentedSearchHit[]
}
type RangeOverride = {
  startSeconds: string
  endSeconds: string
}
type ReplaceTarget = {
  clipId: string
  trackKind: string
  timelineStartFrame: number
  durationFrames: number
  artifactId: string
}
type ReplacePreviewPayload = {
  confirmationRequired: true
  commandId: string
  baseRevision: string
  preview: {
    valid: boolean
    previewHash: string
    warnings: Array<{ message: string }>
    conflicts: Array<{ message: string }>
  }
}

type LastSearchRequest = {
  query: SearchQuery
  library: boolean
  referenceId?: string
  referenceRange?: { start_seconds: number; duration_seconds?: number }
}

export const MomentSearch = forwardRef<MomentSearchHandle, MomentSearchProps>(
function MomentSearch({
  bookId,
  notebookId,
  assets,
  disabled,
  call,
  onNotice,
  onNotebookChanged,
  onLibraryChanged,
  importControls,
  scope,
  onScopeChange,
}: MomentSearchProps, ref) {
  const searchReference = useSearchReferenceLifecycle()
  const {
    mode,
    reference,
    startSeconds,
    durationSeconds,
    preparing: preparingReference,
  } = searchReference.state
  const [text, setText] = useState('')
  const [modality, setModality] = useState<SearchModality>('auto')
  const [artifactKind, setArtifactKind] = useState('')
  const [minimumDuration, setMinimumDuration] = useState('')
  const [maximumDuration, setMaximumDuration] = useState('')
  const [orientation, setOrientation] = useState('')
  const [indexingState, setIndexingState] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [labels, setLabels] = useState('')
  const [createdAfter, setCreatedAfter] = useState('')
  const [createdBefore, setCreatedBefore] = useState('')
  const [page, setPage] = useState<PresentedSearchPage | null>(null)
  const [lastQuery, setLastQuery] = useState<SearchQuery | null>(null)
  const [lastSearchRequest, setLastSearchRequest] = useState<LastSearchRequest | null>(null)
  const [selectedHitIndex, setSelectedHitIndex] = useState(0)
  const [rangeOverrides, setRangeOverrides] = useState<Record<string, RangeOverride>>({})
  const [replaceHit, setReplaceHit] = useState<PresentedSearchHit | null>(null)
  const [replaceTargets, setReplaceTargets] = useState<ReplaceTarget[]>([])
  const [replaceTargetId, setReplaceTargetId] = useState('')
  const [replacePreview, setReplacePreview] = useState<ReplacePreviewPayload | null>(null)
  const [working, setWorking] = useState(false)
  const [preparingIndex, setPreparingIndex] = useState(false)
  const searchRunRef = useRef(0)
  useEffect(() => () => { searchRunRef.current++ }, [])
  const [importing, setImporting] = useState<{ url: string } | null>(null)
  const [barDragOver, setBarDragOver] = useState(false)
  const importRunRef = useRef(0)

  const executeSearch = async (
    nextReference = reference,
    nextMode = mode,
    nextStartSeconds = startSeconds,
    nextDurationSeconds = durationSeconds,
  ) => {
    const run = ++searchRunRef.current
    const isCancelled = () => run !== searchRunRef.current
      || (nextMode !== 'text' && searchReference.lifecycle.getState().reference !== nextReference)
    setWorking(true)
    try {
      const query: SearchQuery = {
        ...(nextMode === 'text' && text.trim() ? { text: text.trim() } : {}),
        modalities: nextMode === 'text'
          ? modality === 'auto' ? ['auto'] : [modality]
          : ['visual'],
        ...(artifactKind ? { artifactKinds: [artifactKind as SearchHit['artifactKind']] } : {}),
        ...(durationFilter(minimumDuration, maximumDuration)
          ? { durationMs: durationFilter(minimumDuration, maximumDuration)! }
          : {}),
        ...(orientation
          ? { orientations: [orientation as 'landscape' | 'portrait' | 'square'] }
          : {}),
        ...(indexingState
          ? { indexingStates: [
              indexingState as NonNullable<SearchQuery['indexingStates']>[number],
            ] }
          : {}),
        ...(sourceFilter ? { sourceArtifactIds: [sourceFilter] } : {}),
        ...(labelFilter(labels).length > 0 ? { labels: labelFilter(labels) } : {}),
        ...(dateTimestamp(createdAfter, false) !== undefined
          ? { createdAfter: dateTimestamp(createdAfter, false) }
          : {}),
        ...(dateTimestamp(createdBefore, true) !== undefined
          ? { createdBefore: dateTimestamp(createdBefore, true) }
          : {}),
        limit: 30,
      }
      if (nextMode === 'text' && !query.text) {
        throw new Error('Describe the moment you want to find')
      }
      if (nextMode !== 'text' && !nextReference) {
        throw new Error(`Choose a ${referenceKind(nextMode)} reference`)
      }
      const library = nextMode !== 'text' || scope === 'library'
      let referenceRange
      try {
        referenceRange = nextMode === 'video-reverse' && nextReference
          ? searchReferenceRange(
              nextStartSeconds,
              nextDurationSeconds,
              nextReference,
            )
          : undefined
      } catch (error) {
        throw new Error(searchReference.lifecycle.resetInvalidRange(error))
      }
      const request: LastSearchRequest = {
        query,
        library,
        ...(nextReference ? { referenceId: nextReference.referenceId } : {}),
        ...(referenceRange ? { referenceRange } : {}),
      }
      const value = await searchWithPreparation({
        search: () => call('search_moments', {
          book_id: bookId,
          ...(library ? { scope: 'library' } : {}),
          query,
          ...(request.referenceId ? { reference_id: request.referenceId } : {}),
          ...(request.referenceRange ? { reference_range: request.referenceRange } : {}),
        }),
        listJobs: (owningBookId, jobIds) => call('list_jobs', {
          book_id: owningBookId, job_ids: jobIds,
        }, { background: true }),
        onPreparing: (preparing) => {
          if (run === searchRunRef.current) setPreparingIndex(preparing)
        },
        isCancelled,
      })
      if (isCancelled()) return
      if (!isSearchPage(value)) throw new Error('The server returned an invalid search page')
      if (
        nextMode !== 'text'
        && searchReference.lifecycle.getState().reference !== nextReference
      ) return
      setPage(value)
      setLastQuery(query)
      setLastSearchRequest(request)
      setSelectedHitIndex(0)
      setRangeOverrides({})
      onNotice(`Found ${value.hits.length} moments · ${value.coverage.state}`)
    } catch (error) {
      if (!isCancelled()) onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      if (run === searchRunRef.current) setWorking(false)
    }
  }

  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const intent = detectSearchSubmitIntent(text)
    if (intent.kind === 'url') {
      void importThenSearch(intent.url)
      return
    }
    if (intent.kind === 'text') {
      if (reference) searchReference.lifecycle.changeMode('text')
      void executeSearch(null, 'text')
      return
    }
    if (reference) void executeSearch()
  }

  const importThenSearch = async (url: string) => {
    const run = ++importRunRef.current
    setImporting({ url })
    setText('')
    try {
      const value = await call('download_video', {
        book_id: bookId,
        url,
        export_videos: false,
      })
      const artifactId = importedArtifactId(value)
      if (!artifactId) {
        throw new Error('The server did not return an imported artifact')
      }
      onNotice('Importing URL — the search runs when the download finishes')
      const outcome = await watchDownloadJob({
        artifactId,
        listJobs: () => call('list_jobs', { book_id: bookId, limit: 200 }),
        isCancelled: () => importRunRef.current !== run,
      })
      if (outcome.kind === 'cancelled') return
      if (outcome.kind === 'failed') throw new Error(outcome.message)
      if (outcome.kind === 'timeout') {
        onNotice('Import is still running — it will appear in the library; check the Jobs screen and search again when it finishes')
        return
      }
      await onLibraryChanged()
      if (importRunRef.current !== run) return
      await prepareExistingReference('video-reverse', bookId, artifactId)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
      void onLibraryChanged().catch(() => undefined)
    } finally {
      if (importRunRef.current === run) setImporting(null)
    }
  }

  const cancelImportWait = () => {
    importRunRef.current += 1
    setImporting(null)
    onNotice('Stopped waiting — the import continues on the Jobs screen')
  }

  const prepareDroppedFile = async (file: File) => {
    const kind = searchReferenceKindForFile(file)
    if (!kind) return
    const dropMode: ReverseSearchMode = kind === 'image'
      ? 'image-reverse'
      : 'video-reverse'
    const result = await searchReference.lifecycle.prepare(
      dropMode,
      () => uploadSearchReference(file, bookId, kind),
    )
    if (result.status === 'error') {
      onNotice(result.error)
      return
    }
    if (result.status === 'stale') return
    await executeSearch(result.reference, result.mode, '0', '')
  }

  const prepareExistingReference = async (
    searchMode: ReverseSearchMode,
    sourceBookId: string,
    sourceArtifactId: string,
    previewUrl?: string | null,
    sourceRange?: { startSeconds: number; durationSeconds: number },
  ) => {
    const result = await searchReference.lifecycle.prepare(
      searchMode,
      () => prepareExistingSearchReference(call, {
        sourceBookId,
        sourceArtifactId,
        mode: searchMode,
        previewUrl,
        sourceRange,
      }),
    )
    if (result.status === 'error') {
      onNotice(result.error)
      return
    }
    if (result.status === 'stale') return
    await executeSearch(result.reference, result.mode, '0', '')
  }

  const loadMore = async () => {
    if (!lastSearchRequest || !page?.nextCursor) return
    const run = ++searchRunRef.current
    const isCancelled = () => run !== searchRunRef.current
    setWorking(true)
    try {
      const value = await searchWithPreparation({
        search: () => call('search_moments', {
          book_id: bookId,
          ...(lastSearchRequest.library ? { scope: 'library' } : {}),
          query: { ...lastSearchRequest.query, cursor: page.nextCursor },
          ...(lastSearchRequest.referenceId ? { reference_id: lastSearchRequest.referenceId } : {}),
          ...(lastSearchRequest.referenceRange ? { reference_range: lastSearchRequest.referenceRange } : {}),
        }),
        listJobs: (owningBookId, jobIds) => call('list_jobs', {
          book_id: owningBookId, job_ids: jobIds,
        }, { background: true }),
        onPreparing: (preparing) => {
          if (run === searchRunRef.current) setPreparingIndex(preparing)
        },
        isCancelled,
      })
      if (isCancelled()) return
      if (!isSearchPage(value)) throw new Error('The server returned an invalid search page')
      setPage({
        ...value,
        hits: [...page.hits, ...value.hits],
      })
      onNotice(`Loaded ${value.hits.length} more moments`)
    } catch (error) {
      if (!isCancelled()) onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      if (run === searchRunRef.current) setWorking(false)
    }
  }

  const pin = async (hit: PresentedSearchHit) => {
    if (hit.owningBookId && hit.owningBookId !== bookId) {
      onNotice(`Switch to ${hit.owningBookName ?? 'the owning book'} before pinning`)
      return
    }
    if (!notebookId || !page || !lastQuery) {
      onNotice('Open a notebook before pinning a moment')
      return
    }
    setWorking(true)
    try {
      await call('pin_search_moment', {
        book_id: bookId,
        notebook_id: notebookId,
        cell_label: `${hit.artifactLabel ?? hit.artifactId} selects`,
        query: lastQuery,
        hit,
      })
      await onNotebookChanged()
      onNotice(`Pinned ${(hit.artifactLabel ?? hit.artifactId)} to the notebook`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(false)
    }
  }

  const sendToSequence = async (hit: PresentedSearchHit) => {
    if (hit.owningBookId && hit.owningBookId !== bookId) {
      onNotice(`Switch to ${hit.owningBookName ?? 'the owning book'} before editing`)
      return
    }
    setWorking(true)
    try {
      const value = await call('send_search_moment_to_sequence', {
        book_id: bookId,
        hit,
      }) as { preview?: { valid?: boolean; conflicts?: unknown[] } }
      if (value.preview?.valid === false) {
        onNotice(`Could not add moment: ${value.preview.conflicts?.length ?? 0} conflicts`)
      } else {
        onNotice(`Added ${(hit.artifactLabel ?? hit.artifactId)} to the primary sequence`)
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(false)
    }
  }

  const startReplace = async (hit: PresentedSearchHit) => {
    if (hit.owningBookId && hit.owningBookId !== bookId) {
      onNotice(`Switch to ${hit.owningBookName ?? 'the owning book'} before editing`)
      return
    }
    setWorking(true)
    try {
      const value = await call('list_sequence_replace_targets', {
        book_id: bookId,
      }) as { targets?: ReplaceTarget[] }
      const expectedKind = hit.artifactKind === 'audio' ? 'audio' : 'video'
      const targets = Array.isArray(value.targets)
        ? value.targets.filter((target) => target.trackKind === expectedKind)
        : []
      if (targets.length === 0) {
        onNotice(`No ${expectedKind} clips are available to replace`)
        return
      }
      setReplaceHit(hit)
      setReplaceTargets(targets)
      setReplaceTargetId(targets[0]!.clipId)
      setReplacePreview(null)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(false)
    }
  }

  const previewReplace = async () => {
    if (!replaceHit || !replaceTargetId) return
    setWorking(true)
    try {
      const value = await call('replace_sequence_clip_with_search_moment', {
        book_id: bookId,
        hit: replaceHit,
        clip_id: replaceTargetId,
      }) as ReplacePreviewPayload
      setReplacePreview(value)
      onNotice(value.preview.valid
        ? 'Replacement preview ready for confirmation'
        : `Replacement has ${value.preview.conflicts.length} conflicts`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(false)
    }
  }

  const confirmReplace = async () => {
    if (!replaceHit || !replaceTargetId || !replacePreview) return
    setWorking(true)
    try {
      await call('replace_sequence_clip_with_search_moment', {
        book_id: bookId,
        hit: replaceHit,
        clip_id: replaceTargetId,
        command_id: replacePreview.commandId,
        base_revision: replacePreview.baseRevision,
        preview_hash: replacePreview.preview.previewHash,
      })
      setReplaceHit(null)
      setReplaceTargets([])
      setReplaceTargetId('')
      setReplacePreview(null)
      onNotice(`Replaced the selected clip with ${(replaceHit.artifactLabel ?? replaceHit.artifactId)}`)
    } catch (error) {
      setReplacePreview(null)
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(false)
    }
  }

  useImperativeHandle(ref, () => ({
    searchSimilar: (asset) => {
      const searchMode: ReverseSearchMode = asset.type === 'image'
        ? 'image-reverse'
        : 'video-reverse'
      void prepareExistingReference(
        searchMode,
        asset.owningBookId ?? bookId,
        asset.artifactId,
        searchMode === 'image-reverse'
          ? asset.thumbnailUrl ?? asset.mediaUrl
          : asset.mediaUrl,
      )
    },
  }))

  const referenceLocked = reference !== null || preparingReference
  const activeFilterCount = [
    artifactKind,
    minimumDuration,
    maximumDuration,
    orientation,
    indexingState,
    sourceFilter,
    labels,
    createdAfter,
    createdBefore,
  ].filter((value) => value.trim() !== '').length
  const clearFilters = () => {
    setArtifactKind('')
    setMinimumDuration('')
    setMaximumDuration('')
    setOrientation('')
    setIndexingState('')
    setSourceFilter('')
    setLabels('')
    setCreatedAfter('')
    setCreatedBefore('')
  }

  return (
    <section className="moment-search">
      <form className="moment-search-form" onSubmit={search}>
        <div className="moment-search-row">
          <span className="moment-search-page-icon" role="img" aria-label="Search">
            <Search size={18} />
          </span>
          <div
            className={barDragOver ? 'moment-search-bar drag-over' : 'moment-search-bar'}
            onDragOver={(event) => {
              if (!dragHasMediaFile(event.dataTransfer)) return
              event.preventDefault()
              setBarDragOver(true)
            }}
            onDragLeave={() => setBarDragOver(false)}
            onDrop={(event) => {
              setBarDragOver(false)
              const file = [...event.dataTransfer.files]
                .find((candidate) => searchReferenceKindForFile(candidate))
              if (!file) return
              event.preventDefault()
              event.stopPropagation()
              void prepareDroppedFile(file)
            }}
            onPaste={(event) => {
              const file = [...event.clipboardData.files]
                .find((candidate) => searchReferenceKindForFile(candidate))
              if (!file) return
              event.preventDefault()
              event.stopPropagation()
              void prepareDroppedFile(file)
            }}
          >
            {reference || preparingReference ? (
              <SearchReferenceChip
                reference={reference}
                preparing={preparingReference}
                disabled={disabled || working}
                startSeconds={startSeconds}
                durationSeconds={durationSeconds}
                onClear={() => searchReference.lifecycle.changeMode('text')}
                onStartSeconds={searchReference.lifecycle.setStartSeconds}
                onDurationSeconds={searchReference.lifecycle.setDurationSeconds}
              />
            ) : importing ? (
              <span className="moment-search-importing">
                <BusyIndicator size={14} />
                Importing URL…
                <button
                  type="button"
                  aria-label="Stop waiting for the import"
                  onClick={cancelImportWait}
                >
                  <X size={12} />
                </button>
              </span>
            ) : null}
            <input
              className="moment-search-query"
              value={text}
              onChange={(event) => setText(event.target.value)}
              aria-label="Search the library"
              aria-describedby="moment-search-example-help"
              disabled={disabled || importing !== null}
              placeholder={reference
                ? 'Type to switch back to text search, or press Search to re-run'
                : 'Search moments or paste a video URL'}
            />
            <span id="moment-search-example-help" className="sr-only">
              Attach an image or video to search by example. Files dropped in this field become search examples; files dropped on the page import into the library.
            </span>
            <label className="moment-search-attach" title="Search by example image or video">
              <Paperclip size={14} />
              <input
                type="file"
                accept="image/*,video/*"
                disabled={disabled || working || preparingReference || importing !== null}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) void prepareDroppedFile(file)
                }}
              />
            </label>
          </div>
          <button
            type="submit"
            className="moment-search-submit"
            disabled={
              disabled
              || working
              || preparingReference
              || importing !== null
              || (!text.trim() && !reference)
            }
          >
            <Search size={15} />{preparingIndex ? 'Preparing search…' : working ? 'Searching…' : 'Search'}
          </button>
        </div>
        <div className="moment-search-strip">
          <label className="moment-search-inline">
            Signal
            <select
              value={modality}
              disabled={referenceLocked}
              title={referenceLocked ? 'Reverse search uses the visual signal' : undefined}
              onChange={(event) => setModality(event.target.value as SearchModality)}
            >
              <option value="auto">Hybrid</option>
              <option value="visual">Visual</option>
              <option value="speech">Speech</option>
              <option value="ocr">OCR</option>
              <option value="audio">Audio</option>
              <option value="metadata">Metadata</option>
            </select>
          </label>
          <div className="moment-search-group" role="group" aria-label="Scope">
            <span className="moment-search-group-label">Scope</span>
            <div className={referenceLocked ? 'moment-search-segmented locked' : 'moment-search-segmented'}>
              <button
                type="button"
                aria-pressed={referenceLocked || scope === 'library'}
                disabled={referenceLocked}
                title={referenceLocked ? 'Reverse search always spans all books' : undefined}
                onClick={() => onScopeChange('library')}
              >
                All books
              </button>
              <button
                type="button"
                aria-pressed={!referenceLocked && scope === 'book'}
                disabled={referenceLocked}
                title={referenceLocked ? 'Reverse search always spans all books' : undefined}
                onClick={() => onScopeChange('book')}
              >
                This book
              </button>
            </div>
          </div>
          {referenceLocked && (
            <span className="moment-search-lock-hint">locked while searching by example</span>
          )}
          <details className="moment-search-filters">
            <summary>
              <SlidersHorizontal size={13} />
              Filters
              {activeFilterCount > 0 && (
                <span
                  className="moment-search-filter-count"
                  aria-label={`${activeFilterCount} active`}
                >
                  {activeFilterCount}
                </span>
              )}
            </summary>
            <div>
              <div className="moment-search-filter-fields">
                <label>
                  Media type
                  <select value={artifactKind} onChange={(event) => setArtifactKind(event.target.value)}>
                    <option value="">Any</option>
                    <option value="video">Video</option>
                    <option value="image">Image</option>
                    <option value="audio">Audio</option>
                  </select>
                </label>
                <label>
                  Min seconds
                  <input type="number" min="0" step="0.1" value={minimumDuration} onChange={(event) => setMinimumDuration(event.target.value)} />
                </label>
                <label>
                  Max seconds
                  <input type="number" min="0" step="0.1" value={maximumDuration} onChange={(event) => setMaximumDuration(event.target.value)} />
                </label>
                <label>
                  Orientation
                  <select value={orientation} onChange={(event) => setOrientation(event.target.value)}>
                    <option value="">Any</option>
                    <option value="landscape">Landscape</option>
                    <option value="portrait">Portrait</option>
                    <option value="square">Square</option>
                  </select>
                </label>
                <label>
                  Index state
                  <select value={indexingState} onChange={(event) => setIndexingState(event.target.value)}>
                    <option value="">Any</option>
                    <option value="ready">Ready</option>
                    <option value="partial">Partial</option>
                    <option value="stale">Stale</option>
                    <option value="failed">Failed</option>
                    <option value="not-indexed">Not indexed</option>
                  </select>
                </label>
                <label>
                  Source
                  <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
                    <option value="">Any source</option>
                    {assets.map((asset) => (
                      <option key={asset.artifactId} value={asset.artifactId}>{asset.id}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Labels
                  <input value={labels} onChange={(event) => setLabels(event.target.value)} placeholder="product, exterior" />
                </label>
                <label>
                  Created after
                  <input type="date" value={createdAfter} onChange={(event) => setCreatedAfter(event.target.value)} />
                </label>
                <label>
                  Created before
                  <input type="date" value={createdBefore} onChange={(event) => setCreatedBefore(event.target.value)} />
                </label>
              </div>
              <div className="moment-search-filter-foot">
                <span>
                  {activeFilterCount === 0 ? 'No filters set' : `${activeFilterCount} active`}
                  {' · applied when you search'}
                </span>
                <button type="button" disabled={activeFilterCount === 0} onClick={clearFilters}>
                  Clear all
                </button>
              </div>
            </div>
          </details>
          <span className="moment-search-strip-spacer" />
          {page && (
            <div className="search-coverage" data-state={page.coverage.state}>
              <strong>{page.coverage.state}</strong>
              <progress
                className="search-coverage-meter"
                aria-hidden="true"
                value={page.coverage.indexedArtifactCount}
                max={Math.max(page.coverage.totalArtifactCount, 1)}
              />
              <span
                title={page.coverage.partialResults
                  ? 'Partial results update as indexing finishes'
                  : undefined}
              >
                {page.coverage.indexedArtifactCount}/{page.coverage.totalArtifactCount} indexed
              </span>
            </div>
          )}
          {importControls && (
            <>
              <span className="moment-search-strip-divider" aria-hidden="true" />
              <div className="moment-search-import">
                <span className="moment-search-group-label">Import</span>
                <div>{importControls}</div>
              </div>
            </>
          )}
        </div>
      </form>
      {replaceHit && (
        <section className="moment-replace-panel" aria-label="Replace sequence clip">
          <header>
            <div>
              <span className="section-label">REPLACE CLIP</span>
              <strong>{(replaceHit.artifactLabel ?? replaceHit.artifactId)} · {formatMoment(replaceHit)}</strong>
            </div>
            <button
              type="button"
              onClick={() => {
                setReplaceHit(null)
                setReplacePreview(null)
              }}
            >
              Cancel
            </button>
          </header>
          <label>
            Explicit target
            <select
              value={replaceTargetId}
              onChange={(event) => {
                setReplaceTargetId(event.target.value)
                setReplacePreview(null)
              }}
            >
              {replaceTargets.map((target) => (
                <option key={target.clipId} value={target.clipId}>
                  {target.trackKind} · frame {target.timelineStartFrame} · {target.durationFrames}f
                </option>
              ))}
            </select>
          </label>
          {!replacePreview ? (
            <button type="button" disabled={working} onClick={() => void previewReplace()}>
              Preview replacement
            </button>
          ) : (
            <div className="moment-replace-confirm">
              <span>{replacePreview.preview.valid ? 'VALID PREVIEW' : 'CONFLICTS REQUIRE REVIEW'}</span>
              {replacePreview.preview.warnings.map((warning, index) => (
                <p key={`warning:${index}`}>{warning.message}</p>
              ))}
              {replacePreview.preview.conflicts.map((conflict, index) => (
                <p key={`conflict:${index}`}>{conflict.message}</p>
              ))}
              <button
                type="button"
                disabled={working || !replacePreview.preview.valid}
                onClick={() => void confirmReplace()}
              >
                Confirm replacement
              </button>
            </div>
          )}
        </section>
      )}
      <div
        className="moment-grid"
        tabIndex={page ? 0 : -1}
        aria-label="Search results. Use J and K to move, L to play or pause."
        onKeyDown={(event) => {
          if (!page || page.hits.length === 0) return
          if (event.key.toLowerCase() === 'j' || event.key.toLowerCase() === 'k') {
            event.preventDefault()
            const direction = event.key.toLowerCase() === 'j' ? 1 : -1
            const next = Math.min(
              page.hits.length - 1,
              Math.max(0, selectedHitIndex + direction),
            )
            setSelectedHitIndex(next)
            document.querySelector(`[data-moment-index="${next}"]`)
              ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
          }
          if (event.key.toLowerCase() === 'l') {
            event.preventDefault()
            const media = document
              .querySelector(`[data-moment-index="${selectedHitIndex}"]`)
              ?.querySelector('video, audio') as HTMLMediaElement | null
            if (media) {
              if (media.paused) void media.play()
              else media.pause()
            }
          }
        }}
      >
        {page?.hits.map((hit, index) => {
          const asset = assets.find((item) => item.artifactId === hit.artifactId)
          const mediaUrl = asset?.mediaUrl ?? hit.mediaUrl ?? null
          const thumbnailUrl = asset?.thumbnailUrl ?? hit.thumbnailUrl ?? null
          const rangeKey = locationKey(hit)
          const rangeOverride = rangeOverrides[rangeKey]
          const presentedHit = adjustedSearchHit(hit, rangeOverride)
          const selected = selectedHitIndex === index
          const videoKind = asset?.type === 'video'
            || hit.artifactKind === 'video'
            || hit.artifactKind === 'final'
          const audioKind = asset?.type === 'audio' || hit.artifactKind === 'audio'
          return (
            <article
              className={selected ? 'moment-card selected' : 'moment-card'}
              data-moment-index={index}
              key={`${hit.artifactId}:${rangeKey}:${index}`}
              onClick={() => setSelectedHitIndex(index)}
            >
              <div className="moment-card-media">
                {selected && mediaUrl && videoKind ? (
                  <video
                    src={momentMediaUrl(mediaUrl, presentedHit)}
                    poster={thumbnailUrl ?? undefined}
                    controls
                    playsInline
                    preload="metadata"
                  />
                ) : selected && mediaUrl && audioKind ? (
                  <audio
                    src={momentMediaUrl(mediaUrl, presentedHit)}
                    controls
                    preload="metadata"
                  />
                ) : thumbnailUrl ? (
                  <img
                    src={thumbnailUrl}
                    alt={hit.artifactLabel ?? hit.artifactId}
                    loading="lazy"
                  />
                ) : mediaUrl && videoKind ? (
                  <video
                    src={momentMediaUrl(mediaUrl, presentedHit)}
                    muted
                    playsInline
                    preload="metadata"
                  />
                ) : mediaUrl && !audioKind ? (
                  <img
                    src={mediaUrl}
                    alt={hit.artifactLabel ?? hit.artifactId}
                    loading="lazy"
                  />
                ) : (
                  <Film size={28} />
                )}
                <span>{formatMoment(presentedHit)}</span>
              </div>
              <div className="moment-card-body">
                <header>
                  <strong>
                    {hit.owningBookName ? `${hit.owningBookName} · ` : ''}
                    {(hit.artifactLabel ?? hit.artifactId)}
                  </strong>
                  <span>{Math.round(hit.score * 100)}%</span>
                </header>
                {selected && <p>{hit.excerpt ?? 'Matched indexed media signals.'}</p>}
                {selected && hit.location.kind === 'timed' && (
                  <div className="moment-range-adjust">
                    <label>
                      In
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={rangeOverride?.startSeconds ?? momentBounds(hit).start.toFixed(2)}
                        onChange={(event) => setRangeOverrides((current) => ({
                          ...current,
                          [rangeKey]: {
                            startSeconds: event.target.value,
                            endSeconds: current[rangeKey]?.endSeconds
                              ?? momentBounds(hit).end.toFixed(2),
                          },
                        }))}
                      />
                    </label>
                    <label>
                      Out
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={rangeOverride?.endSeconds ?? momentBounds(hit).end.toFixed(2)}
                        onChange={(event) => setRangeOverrides((current) => ({
                          ...current,
                          [rangeKey]: {
                            startSeconds: current[rangeKey]?.startSeconds
                              ?? momentBounds(hit).start.toFixed(2),
                            endSeconds: event.target.value,
                          },
                        }))}
                      />
                    </label>
                  </div>
                )}
                <div className="moment-card-foot">
                  <div className="reason-chips">
                    {hit.signals.map((signal, signalIndex) => (
                      <span
                        key={`${signal.kind}:${signal.rank}:${signalIndex}`}
                        title={signal.explanation ?? undefined}
                      >
                        {signal.kind}
                      </span>
                    ))}
                  </div>
                  <div className="moment-card-actions">
                    {mediaUrl && (
                      <a
                        href={momentMediaUrl(mediaUrl, presentedHit)}
                        target="_blank"
                        rel="noreferrer"
                        title="Open source"
                        aria-label="Open source"
                      >
                        <ExternalLink size={13} />
                      </a>
                    )}
                    {(hit.artifactKind === 'image'
                      || hit.artifactKind === 'video'
                      || hit.artifactKind === 'final') && (
                      <button
                        type="button"
                        title="Search for similar moments"
                        aria-label="Search for similar moments"
                        disabled={working || preparingReference}
                        onClick={() => {
                          const searchMode = hit.artifactKind === 'image'
                            ? 'image-reverse'
                            : 'video-reverse'
                          const bounds = hit.location.kind === 'timed'
                            ? momentBounds(presentedHit)
                            : null
                          void prepareExistingReference(
                            searchMode,
                            hit.owningBookId ?? bookId,
                            hit.artifactId,
                            searchMode === 'image-reverse'
                              ? thumbnailUrl ?? mediaUrl
                              : mediaUrl
                                ? momentMediaUrl(mediaUrl, presentedHit)
                                : null,
                            searchMode === 'video-reverse' && bounds
                              ? {
                                  startSeconds: bounds.start,
                                  durationSeconds: bounds.end - bounds.start,
                                }
                              : undefined,
                          )
                        }}
                      >
                        <Search size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      title="Pin to notebook"
                      aria-label="Pin to notebook"
                      disabled={working || !notebookId || (
                        hit.owningBookId !== undefined && hit.owningBookId !== bookId
                      )}
                      onClick={() => void pin(presentedHit)}
                    >
                      <Pin size={13} />
                    </button>
                    <button
                      type="button"
                      title="Insert into sequence"
                      aria-label="Insert into sequence"
                      disabled={working || (
                        hit.owningBookId !== undefined && hit.owningBookId !== bookId
                      )}
                      onClick={() => void sendToSequence(presentedHit)}
                    >
                      <Send size={13} />
                    </button>
                    <button
                      type="button"
                      title="Replace a sequence clip"
                      aria-label="Replace a sequence clip"
                      disabled={working || (
                        hit.owningBookId !== undefined && hit.owningBookId !== bookId
                      )}
                      onClick={() => void startReplace(presentedHit)}
                    >
                      <Replace size={13} />
                    </button>
                  </div>
                </div>
              </div>
            </article>
          )
        })}
        {page && page.hits.length === 0 && (
          <div className="empty-record">
            <Search size={25} />
            <strong>No matching moments</strong>
            <p>Try another description, signal, or reference range while indexing continues.</p>
          </div>
        )}
      </div>
      {page?.nextCursor && (
        <button
          type="button"
          className="load-more-moments"
          disabled={working}
          onClick={() => void loadMore()}
        >
          {working ? 'Loading…' : 'Load more moments'}
        </button>
      )}
    </section>
  )
})

interface SearchReferenceChipProps {
  reference: SearchReferenceDescriptor | null
  preparing: boolean
  disabled: boolean
  startSeconds: string
  durationSeconds: string
  onClear: () => void
  onStartSeconds: (value: string) => void
  onDurationSeconds: (value: string) => void
}

function SearchReferenceChip({
  reference,
  preparing,
  disabled,
  startSeconds,
  durationSeconds,
  onClear,
  onStartSeconds,
  onDurationSeconds,
}: SearchReferenceChipProps) {
  if (preparing) {
    return (
      <span className="moment-search-reference-chip">
        <BusyIndicator size={14} />
        Preparing reference…
      </span>
    )
  }
  if (!reference) return null
  const Icon = reference.kind === 'image' ? Image : Film
  return (
    <span className="moment-search-reference-chip">
      {reference.previewUrl ? (
        reference.kind === 'image' ? (
          <img src={reference.previewUrl} alt="" />
        ) : (
          <video src={reference.previewUrl} muted playsInline preload="metadata" />
        )
      ) : (
        <Icon size={14} />
      )}
      <strong>{reference.name}</strong>
      {reference.kind === 'video' && (
        <span className="moment-search-reference-range">
          <label>
            In
            <input
              type="number"
              min="0"
              step="0.1"
              value={startSeconds}
              disabled={disabled}
              onChange={(event) => onStartSeconds(event.target.value)}
            />
          </label>
          <label>
            For
            <input
              type="number"
              min="0.1"
              step="0.1"
              value={durationSeconds}
              placeholder="all"
              disabled={disabled}
              onChange={(event) => onDurationSeconds(event.target.value)}
            />
          </label>
          {reference.durationMs !== undefined && (
            <span>{(reference.durationMs / 1_000).toFixed(1)}s available</span>
          )}
        </span>
      )}
      <button
        type="button"
        aria-label="Clear search reference"
        disabled={disabled}
        onClick={onClear}
      >
        <X size={12} />
      </button>
    </span>
  )
}

function dragHasMediaFile(transfer: DataTransfer): boolean {
  return [...transfer.items].some((item) =>
    item.kind === 'file'
    && (item.type.startsWith('image/') || item.type.startsWith('video/')))
}

function importedArtifactId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = (value as Record<string, unknown>).artifact_id
  return typeof candidate === 'string' ? candidate : null
}

function isSearchPage(value: unknown): value is PresentedSearchPage {
  if (typeof value !== 'object' || value === null) return false
  const page = value as Record<string, unknown>
  return Array.isArray(page.hits)
    && typeof page.coverage === 'object'
    && page.coverage !== null
}

function formatMoment(hit: SearchHit): string {
  if (hit.location.kind !== 'timed') return hit.location.kind
  const start = ticksToSeconds(
    hit.location.range.startTick,
    hit.location.range.timeBase,
  )
  const end = ticksToSeconds(
    hit.location.range.startTick + hit.location.range.durationTicks,
    hit.location.range.timeBase,
  )
  return `${formatSeconds(start)}–${formatSeconds(end)}`
}

function ticksToSeconds(
  ticks: number,
  timeBase: { numerator: number; denominator: number },
): number {
  return ticks * timeBase.numerator / timeBase.denominator
}

function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds - minutes * 60
  return `${minutes}:${remainder.toFixed(1).padStart(4, '0')}`
}

function locationKey(hit: SearchHit): string {
  if (hit.location.kind === 'timed') {
    return `${hit.location.range.streamId}:${hit.location.range.startTick}`
  }
  return `${hit.location.sourcePath}:${hit.location.objectHash}`
}

function momentMediaUrl(mediaUrl: string, hit: SearchHit): string {
  if (hit.location.kind !== 'timed') return mediaUrl
  const start = ticksToSeconds(
    hit.location.range.startTick,
    hit.location.range.timeBase,
  )
  const end = ticksToSeconds(
    hit.location.range.startTick + hit.location.range.durationTicks,
    hit.location.range.timeBase,
  )
  return `${mediaUrl}#t=${start.toFixed(3)},${end.toFixed(3)}`
}

function momentBounds(hit: SearchHit): { start: number; end: number } {
  if (hit.location.kind !== 'timed') return { start: 0, end: 0 }
  const start = ticksToSeconds(
    hit.location.range.startTick,
    hit.location.range.timeBase,
  )
  return {
    start,
    end: ticksToSeconds(
      hit.location.range.startTick + hit.location.range.durationTicks,
      hit.location.range.timeBase,
    ),
  }
}

function adjustedSearchHit(
  hit: PresentedSearchHit,
  override: RangeOverride | undefined,
): PresentedSearchHit {
  if (!override || hit.location.kind !== 'timed') return hit
  const start = Number(override.startSeconds)
  const end = Number(override.endSeconds)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    return hit
  }
  const timeBase = hit.location.range.timeBase
  const startTick = Math.round(start * timeBase.denominator / timeBase.numerator)
  const endTick = Math.round(end * timeBase.denominator / timeBase.numerator)
  return {
    ...hit,
    location: {
      ...hit.location,
      range: {
        ...hit.location.range,
        startTick,
        durationTicks: Math.max(1, endTick - startTick),
      },
    },
    representativeTick: Math.max(
      startTick,
      Math.min(hit.representativeTick ?? startTick, endTick - 1),
    ),
  }
}

function durationFilter(
  minimum: string,
  maximum: string,
): { min?: number; max?: number } | null {
  const min = optionalNumber(minimum)
  const max = optionalNumber(maximum)
  if (min === undefined && max === undefined) return null
  return {
    ...(min === undefined ? {} : { min: min * 1_000 }),
    ...(max === undefined ? {} : { max: max * 1_000 }),
  }
}

function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function labelFilter(value: string): string[] {
  return value.split(',').map((label) => label.trim()).filter(Boolean)
}

function dateTimestamp(value: string, endOfDay: boolean): number | undefined {
  if (!value) return undefined
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`)
  const timestamp = date.getTime()
  return Number.isFinite(timestamp) ? timestamp : undefined
}
