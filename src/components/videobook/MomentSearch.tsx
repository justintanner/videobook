import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useState,
  type FormEvent,
} from 'react'
import { Film, Image, Pin, Search, Send } from 'lucide-react'
import type {
  SearchHit,
  SearchModality,
  SearchPage,
  SearchQuery,
} from 'videobook-engine'
import { ReverseSearchReference } from '@/components/videobook/ReverseSearchReference'
import {
  prepareExistingSearchReference,
  referenceKind,
  searchReferenceRange,
  uploadSearchReference,
  type ReverseSearchMode,
} from '@/videobook/search-reference'
import { useSearchReferenceLifecycle } from '@/videobook/useSearchReferenceLifecycle'

export interface MomentSearchAsset {
  artifactId: string
  id: string
  type: string
  mediaUrl: string | null
  thumbnailUrl: string | null
}

interface MomentSearchProps {
  bookId: string
  notebookId?: string
  activeSequenceRange: { startFrame: number; durationFrames: number } | null
  assets: MomentSearchAsset[]
  disabled: boolean
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>
  onNotice: (message: string) => void
  onNotebookChanged: () => Promise<void>
}

export interface MomentSearchHandle {
  searchSimilar: (asset: MomentSearchAsset) => void
}

type SearchMode = 'text' | ReverseSearchMode
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

const modes: Array<{ id: SearchMode; label: string; icon: typeof Search }> = [
  { id: 'text', label: 'Text', icon: Search },
  { id: 'image-reverse', label: 'Image reverse', icon: Image },
  { id: 'video-reverse', label: 'Vid reverse', icon: Film },
]

type LastSearchRequest = {
  query: SearchQuery
  tool: 'search_moments' | 'search_library_moments'
  referenceId?: string
  referenceRange?: { start_seconds: number; duration_seconds?: number }
}

export const MomentSearch = forwardRef<MomentSearchHandle, MomentSearchProps>(
function MomentSearch({
  bookId,
  notebookId,
  activeSequenceRange,
  assets,
  disabled,
  call,
  onNotice,
  onNotebookChanged,
}: MomentSearchProps, ref) {
  const searchReference = useSearchReferenceLifecycle()
  const {
    mode,
    reference,
    startSeconds,
    durationSeconds,
    preparing: preparingReference,
  } = searchReference.state
  const [scope, setScope] = useState<'book' | 'library'>('book')
  const [text, setText] = useState('')
  const [modality, setModality] = useState<SearchModality>('auto')
  const [assetId, setAssetId] = useState('')
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

  const selectableAssets = useMemo(
    () => assets.filter((asset) => {
      if (mode === 'video-reverse') {
        return asset.type === 'video' || asset.type === 'final'
      }
      if (mode === 'image-reverse') return asset.type === 'image'
      return false
    }),
    [assets, mode],
  )

  const executeSearch = async (
    nextReference = reference,
    nextMode = mode,
    nextStartSeconds = startSeconds,
    nextDurationSeconds = durationSeconds,
  ) => {
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
      const tool = nextMode !== 'text' || scope === 'library'
        ? 'search_library_moments'
        : 'search_moments'
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
        tool,
        ...(nextReference ? { referenceId: nextReference.referenceId } : {}),
        ...(referenceRange ? { referenceRange } : {}),
      }
      const value = await call(tool, {
        ...(tool === 'search_moments' ? { book_id: bookId } : {}),
        query,
        ...(request.referenceId ? { reference_id: request.referenceId } : {}),
        ...(request.referenceRange ? { reference_range: request.referenceRange } : {}),
      })
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
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(false)
    }
  }

  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void executeSearch()
  }

  const prepareFileReference = async (file: File) => {
    if (mode === 'text') return
    const result = await searchReference.lifecycle.prepare(
      mode,
      () => uploadSearchReference(file, bookId, referenceKind(mode)),
    )
    if (result.status === 'error') {
      onNotice(result.error)
      return
    }
    if (result.status === 'stale') return
    setAssetId('')
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
    setAssetId(sourceArtifactId)
    await executeSearch(result.reference, result.mode, '0', '')
  }

  const loadMore = async () => {
    if (!lastSearchRequest || !page?.nextCursor) return
    setWorking(true)
    try {
      const value = await call(lastSearchRequest.tool, {
        ...(lastSearchRequest.tool === 'search_moments'
          ? { book_id: bookId }
          : {}),
        query: { ...lastSearchRequest.query, cursor: page.nextCursor },
        ...(lastSearchRequest.referenceId
          ? { reference_id: lastSearchRequest.referenceId }
          : {}),
        ...(lastSearchRequest.referenceRange
          ? { reference_range: lastSearchRequest.referenceRange }
          : {}),
      })
      if (!isSearchPage(value)) throw new Error('The server returned an invalid search page')
      setPage({
        ...value,
        hits: [...page.hits, ...value.hits],
      })
      onNotice(`Loaded ${value.hits.length} more moments`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(false)
    }
  }

  const suggestCoverage = async () => {
    if (!text.trim() || !activeSequenceRange) return
    setWorking(true)
    try {
      const value = await call('suggest_sequence_coverage', {
        book_id: bookId,
        text: text.trim(),
        timeline_start_frame: activeSequenceRange.startFrame,
        duration_frames: activeSequenceRange.durationFrames,
        limit: 10,
      }) as {
        hits?: PresentedSearchHit[]
        coverage?: PresentedSearchPage['coverage']
        generationFallback?: { offered?: boolean }
      }
      const hits = Array.isArray(value.hits) ? value.hits : []
      if (value.coverage) {
        setPage({
          hits,
          coverage: value.coverage,
        })
      }
      setSelectedHitIndex(0)
      onNotice(hits.length > 0
        ? `Ranked ${hits.length} existing moments for the selected range`
        : value.generationFallback?.offered
          ? 'No existing coverage found; generation can be considered after review'
          : 'No existing coverage found')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(false)
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
        bookId,
        asset.artifactId,
        searchMode === 'image-reverse'
          ? asset.thumbnailUrl ?? asset.mediaUrl
          : asset.mediaUrl,
      )
    },
  }))

  return (
    <section className="moment-search">
      <form className="moment-search-form" onSubmit={search}>
        <div className="moment-search-modes" role="tablist" aria-label="Search mode">
          {modes.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={mode === item.id}
                className={mode === item.id ? 'active' : ''}
                disabled={disabled || working || preparingReference}
                onClick={() => {
                  searchReference.lifecycle.changeMode(item.id)
                  setAssetId('')
                }}
              >
                <Icon size={14} />{item.label}
              </button>
            )
          })}
        </div>
        {mode === 'text' ? (
          <>
            <label className="moment-search-query">
              Find a moment
              <input
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="e.g. the red van crosses the yard at sunset"
              />
            </label>
            <label>
              Signal
              <select
                value={modality}
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
            <label>
              Scope
              <select
                value={scope}
                onChange={(event) =>
                  setScope(event.target.value as 'book' | 'library')}
              >
                <option value="book">Current book</option>
                <option value="library">All books</option>
              </select>
            </label>
          </>
        ) : (
          <ReverseSearchReference
            mode={mode}
            reference={reference}
            preparing={preparingReference}
            disabled={disabled || working}
            startSeconds={startSeconds}
            durationSeconds={durationSeconds}
            onFile={(file) => void prepareFileReference(file)}
            onClear={() => {
              searchReference.lifecycle.clearReference()
              setAssetId('')
            }}
            onStartSeconds={searchReference.lifecycle.setStartSeconds}
            onDurationSeconds={searchReference.lifecycle.setDurationSeconds}
          >
            <div className="reverse-search-existing">
              <label>
                Existing {referenceKind(mode)} asset
                <select
                  value={assetId}
                  disabled={disabled || preparingReference || working}
                  onChange={(event) => setAssetId(event.target.value)}
                >
                  <option value="">Choose from this book</option>
                  {selectableAssets.map((asset) => (
                    <option key={asset.artifactId} value={asset.artifactId}>
                      {asset.id}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={disabled || preparingReference || working || !assetId}
                onClick={() => {
                  const asset = selectableAssets.find((item) =>
                    item.artifactId === assetId)
                  if (!asset) return
                  void prepareExistingReference(
                    mode,
                    bookId,
                    asset.artifactId,
                    mode === 'image-reverse'
                      ? asset.thumbnailUrl ?? asset.mediaUrl
                      : asset.mediaUrl,
                  )
                }}
              >
                Use selected
              </button>
              <span>Reverse search always searches all books.</span>
            </div>
          </ReverseSearchReference>
        )}
        <details className="moment-search-filters">
          <summary>Filters</summary>
          <div>
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
        </details>
        <button
          type="submit"
          disabled={
            disabled
            || working
            || preparingReference
            || (mode === 'text' ? !text.trim() : !reference)
          }
        >
          <Search size={15} />{working ? 'Searching…' : 'Search moments'}
        </button>
        <button
          type="button"
          hidden={mode !== 'text'}
          disabled={disabled || working || !text.trim() || !activeSequenceRange}
          onClick={() => void suggestCoverage()}
        >
          Suggest coverage
        </button>
      </form>
      {page && (
        <div className="search-coverage">
          <strong>{page.coverage.state}</strong>
          <span>{page.coverage.indexedArtifactCount}/{page.coverage.totalArtifactCount} artifacts</span>
          {page.coverage.partialResults && <span>Partial results update as indexing finishes</span>}
        </div>
      )}
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
          return (
            <article
              className={selectedHitIndex === index ? 'moment-card selected' : 'moment-card'}
              data-moment-index={index}
              key={`${hit.artifactId}:${rangeKey}:${index}`}
              onClick={() => setSelectedHitIndex(index)}
            >
              <div className="moment-card-media">
                {mediaUrl && (asset?.type === 'video' || hit.artifactKind === 'video' || hit.artifactKind === 'final') ? (
                  <video
                    src={momentMediaUrl(mediaUrl, presentedHit)}
                    poster={thumbnailUrl ?? undefined}
                    controls
                    playsInline
                    preload="metadata"
                  />
                ) : mediaUrl && (asset?.type === 'audio' || hit.artifactKind === 'audio') ? (
                  <audio
                    src={momentMediaUrl(mediaUrl, presentedHit)}
                    controls
                    preload="metadata"
                  />
                ) : mediaUrl ? (
                  <img src={thumbnailUrl ?? mediaUrl} alt={(hit.artifactLabel ?? hit.artifactId)} />
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
                <p>{hit.excerpt ?? 'Matched indexed media signals.'}</p>
                <div className="reason-chips">
                  {hit.signals.map((signal, signalIndex) => (
                    <span key={`${signal.kind}:${signal.rank}:${signalIndex}`}>
                      {signal.kind}{signal.explanation ? ` · ${signal.explanation}` : ''}
                    </span>
                  ))}
                </div>
                {hit.location.kind === 'timed' && (
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
                <div className="moment-card-actions">
                  {mediaUrl && (
                    <a href={momentMediaUrl(mediaUrl, presentedHit)} target="_blank" rel="noreferrer">
                      Open source
                    </a>
                  )}
                  {(hit.artifactKind === 'image'
                    || hit.artifactKind === 'video'
                    || hit.artifactKind === 'final') && (
                    <button
                      type="button"
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
                      <Search size={13} />Similar
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={working || !notebookId || (
                      hit.owningBookId !== undefined && hit.owningBookId !== bookId
                    )}
                    onClick={() => void pin(presentedHit)}
                  >
                    <Pin size={13} />Pin
                  </button>
                  <button
                    type="button"
                    disabled={working || (
                      hit.owningBookId !== undefined && hit.owningBookId !== bookId
                    )}
                    onClick={() => void sendToSequence(presentedHit)}
                  >
                    <Send size={13} />Insert
                  </button>
                  <button
                    type="button"
                    disabled={working || (
                      hit.owningBookId !== undefined && hit.owningBookId !== bookId
                    )}
                    onClick={() => void startReplace(presentedHit)}
                  >
                    Replace…
                  </button>
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
