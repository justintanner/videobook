import { useMemo, useState, type FormEvent } from 'react'
import { Film, Image, Pin, Search, Send, Volume2 } from 'lucide-react'
import type {
  ArtifactStream,
  SearchHit,
  SearchModality,
  SearchPage,
  SearchQuery,
  SearchReference,
} from 'videobook-engine'

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
  canAttachToTranscript: boolean
  activeSequenceRange: { startFrame: number; durationFrames: number } | null
  assets: MomentSearchAsset[]
  disabled: boolean
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>
  onNotice: (message: string) => void
  onNotebookChanged: () => Promise<void>
}

type SearchMode = 'text' | 'image' | 'frame' | 'video' | 'audio'
type PresentedSearchHit = SearchHit & {
  owningBookId?: string
  owningBookSlug?: string
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
  { id: 'text', label: 'Describe', icon: Search },
  { id: 'image', label: 'Image', icon: Image },
  { id: 'frame', label: 'Frame', icon: Film },
  { id: 'video', label: 'Video', icon: Film },
  { id: 'audio', label: 'Audio', icon: Volume2 },
]

export function MomentSearch({
  bookId,
  notebookId,
  canAttachToTranscript,
  activeSequenceRange,
  assets,
  disabled,
  call,
  onNotice,
  onNotebookChanged,
}: MomentSearchProps) {
  const [mode, setMode] = useState<SearchMode>('text')
  const [scope, setScope] = useState<'book' | 'library'>('book')
  const [text, setText] = useState('')
  const [modality, setModality] = useState<SearchModality>('auto')
  const [assetId, setAssetId] = useState('')
  const [startSeconds, setStartSeconds] = useState('0')
  const [durationSeconds, setDurationSeconds] = useState('5')
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
  const [selectedHitIndex, setSelectedHitIndex] = useState(0)
  const [rangeOverrides, setRangeOverrides] = useState<Record<string, RangeOverride>>({})
  const [replaceHit, setReplaceHit] = useState<PresentedSearchHit | null>(null)
  const [replaceTargets, setReplaceTargets] = useState<ReplaceTarget[]>([])
  const [replaceTargetId, setReplaceTargetId] = useState('')
  const [replacePreview, setReplacePreview] = useState<ReplacePreviewPayload | null>(null)
  const [working, setWorking] = useState(false)

  const selectableAssets = useMemo(
    () => assets.filter((asset) => {
      if (mode === 'audio') return asset.type === 'audio' || asset.type === 'video'
      if (mode === 'video' || mode === 'frame') return asset.type === 'video'
      if (mode === 'image') return asset.type === 'image'
      return false
    }),
    [assets, mode],
  )

  const search = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setWorking(true)
    try {
      const reference = mode === 'text'
        ? undefined
        : await referenceFor(mode, assetId, startSeconds, durationSeconds, bookId, call)
      const query: SearchQuery = {
        ...(text.trim() ? { text: text.trim() } : {}),
        ...(reference ? { reference } : {}),
        modalities: modality === 'auto' ? ['auto'] : [modality],
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
      if (!query.text && !query.reference) {
        throw new Error('Describe a moment or choose reference media')
      }
      const value = scope === 'library'
        ? await call('search_library_moments', { query })
        : await call('search_moments', { book_id: bookId, query })
      if (!isSearchPage(value)) throw new Error('The server returned an invalid search page')
      setPage(value)
      setLastQuery(query)
      setSelectedHitIndex(0)
      setRangeOverrides({})
      onNotice(`Found ${value.hits.length} moments · ${value.coverage.state}`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(false)
    }
  }

  const loadMore = async () => {
    if (!lastQuery || !page?.nextCursor) return
    setWorking(true)
    try {
      const value = await call('search_moments', {
        book_id: bookId,
        query: { ...lastQuery, cursor: page.nextCursor },
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
      onNotice(`Switch to ${hit.owningBookSlug ?? 'the owning book'} before pinning`)
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
        title: text.trim() || `${hit.artifactSlug} selects`,
        query: lastQuery,
        hit,
      })
      await onNotebookChanged()
      onNotice(`Pinned ${hit.artifactSlug} to the notebook`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(false)
    }
  }

  const sendToSequence = async (hit: PresentedSearchHit) => {
    if (hit.owningBookId && hit.owningBookId !== bookId) {
      onNotice(`Switch to ${hit.owningBookSlug ?? 'the owning book'} before editing`)
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
        onNotice(`Added ${hit.artifactSlug} to the primary sequence`)
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(false)
    }
  }

  const attachToTranscript = async (hit: PresentedSearchHit) => {
    if (hit.owningBookId && hit.owningBookId !== bookId) {
      onNotice(`Switch to ${hit.owningBookSlug ?? 'the owning book'} before editing`)
      return
    }
    if (!notebookId || !lastQuery) {
      onNotice('Select a timed transcript range before attaching a visual')
      return
    }
    setWorking(true)
    try {
      await call('attach_search_moment_to_notebook_selection', {
        book_id: bookId,
        notebook_id: notebookId,
        query: lastQuery,
        hit,
      })
      await onNotebookChanged()
      onNotice(`Covered the selected transcript range with ${hit.artifactSlug}`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(false)
    }
  }

  const startReplace = async (hit: PresentedSearchHit) => {
    if (hit.owningBookId && hit.owningBookId !== bookId) {
      onNotice(`Switch to ${hit.owningBookSlug ?? 'the owning book'} before editing`)
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
      onNotice(`Replaced the selected clip with ${replaceHit.artifactSlug}`)
    } catch (error) {
      setReplacePreview(null)
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(false)
    }
  }

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
                onClick={() => {
                  setMode(item.id)
                  setAssetId('')
                }}
              >
                <Icon size={14} />{item.label}
              </button>
            )
          })}
        </div>
        <label className="moment-search-query">
          Find a moment
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={mode === 'text'
              ? 'e.g. the red van crosses the yard at sunset'
              : 'Optional text to refine the reference'}
          />
        </label>
        {mode !== 'text' && (
          <label>
            Reference
            <select value={assetId} onChange={(event) => setAssetId(event.target.value)}>
              <option value="">Choose {mode} source</option>
              {selectableAssets.map((asset) => (
                <option key={asset.artifactId} value={asset.artifactId}>{asset.id}</option>
              ))}
            </select>
          </label>
        )}
        {(mode === 'frame' || mode === 'video' || mode === 'audio') && (
          <>
            <label>
              Start seconds
              <input
                type="number"
                min="0"
                step="0.1"
                value={startSeconds}
                onChange={(event) => setStartSeconds(event.target.value)}
              />
            </label>
            {mode !== 'frame' && (
              <label>
                Duration seconds
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={durationSeconds}
                  onChange={(event) => setDurationSeconds(event.target.value)}
                />
              </label>
            )}
          </>
        )}
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
          <select value={scope} onChange={(event) => setScope(event.target.value as 'book' | 'library')}>
            <option value="book">Current book</option>
            <option value="library">All books</option>
          </select>
        </label>
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
          disabled={disabled || working || (mode !== 'text' && !assetId)}
        >
          <Search size={15} />{working ? 'Searching…' : 'Search moments'}
        </button>
        <button
          type="button"
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
              <strong>{replaceHit.artifactSlug} · {formatMoment(replaceHit)}</strong>
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
                {asset?.mediaUrl && asset.type === 'video' ? (
                  <video
                    src={momentMediaUrl(asset.mediaUrl, presentedHit)}
                    poster={asset.thumbnailUrl ?? undefined}
                    controls
                    playsInline
                    preload="metadata"
                  />
                ) : asset?.mediaUrl && asset.type === 'audio' ? (
                  <audio
                    src={momentMediaUrl(asset.mediaUrl, presentedHit)}
                    controls
                    preload="metadata"
                  />
                ) : asset?.mediaUrl ? (
                  <img src={asset.thumbnailUrl ?? asset.mediaUrl} alt={hit.artifactSlug} />
                ) : (
                  <Film size={28} />
                )}
                <span>{formatMoment(presentedHit)}</span>
              </div>
              <div className="moment-card-body">
                <header>
                  <strong>
                    {hit.owningBookSlug ? `${hit.owningBookSlug} · ` : ''}
                    {hit.artifactSlug}
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
                  {asset?.mediaUrl && (
                    <a href={momentMediaUrl(asset.mediaUrl, presentedHit)} target="_blank" rel="noreferrer">
                      Open source
                    </a>
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
                    disabled={
                      working
                      || !notebookId
                      || !canAttachToTranscript
                      || hit.artifactKind === 'audio'
                      || (
                        hit.owningBookId !== undefined
                        && hit.owningBookId !== bookId
                      )
                    }
                    onClick={() => void attachToTranscript(presentedHit)}
                  >
                    Cover selection
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
}

async function referenceFor(
  mode: Exclude<SearchMode, 'text'>,
  artifactId: string,
  startValue: string,
  durationValue: string,
  bookId: string,
  call: MomentSearchProps['call'],
): Promise<SearchReference> {
  if (!artifactId) throw new Error('Choose reference media')
  if (mode === 'image') return { kind: 'image', artifact: artifactId }
  const value = await call('list_media_streams', {
    book_id: bookId,
    artifact_id: artifactId,
  })
  if (!Array.isArray(value)) throw new Error('The server returned invalid media streams')
  const streams = value as ArtifactStream[]
  const kind = mode === 'audio' ? 'audio' : 'video'
  const stream = streams.find((item) => item.kind === kind)
  if (!stream) throw new Error(`The selected source has no ${kind} stream`)
  const startSeconds = requiredNumber(startValue, 'Start time', 0)
  const startTick = secondsToTicks(startSeconds, stream)
  if (mode === 'frame') {
    return {
      kind: 'frame',
      source: {
        streamId: stream.streamId,
        objectHash: stream.objectHash,
        tick: startTick,
        timeBase: stream.timeBase,
      },
    }
  }
  const durationSeconds = requiredNumber(durationValue, 'Duration', 0.001)
  return {
    kind: mode,
    range: {
      streamId: stream.streamId,
      objectHash: stream.objectHash,
      startTick,
      durationTicks: Math.max(1, secondsToTicks(durationSeconds, stream)),
      timeBase: stream.timeBase,
    },
  }
}

function requiredNumber(value: string, label: string, minimum: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${label} must be at least ${minimum}`)
  }
  return parsed
}

function secondsToTicks(seconds: number, stream: ArtifactStream): number {
  return Math.round(
    seconds * stream.timeBase.denominator / stream.timeBase.numerator,
  )
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
