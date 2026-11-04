import { useRef, useState } from 'react'
import type { NotebookDocument } from 'videobook-engine'
import type { MediaLibraryKind, MediaLibraryPanelState } from '@/components/videobook/MediaLibraryPanel'
import type { MediaSlotState } from '@/components/videobook/notebook-canvas-context'
import {
  sameTagFilter,
  tagFilterArgs,
  toggleTagFilter,
  type TagFilterTerm,
  type TagSuggestion,
} from './asset-tag-editing'
import { captureDismissedComposerFocus } from './command-composer-focus'
import type { LibraryBrowsePage as LibrarySearchPage } from './library-browse'
import type { NotebookGridSlot } from './notebook-grid'
import { passiveMediaKind } from './notebook-media-drop'
import {
  prepareExistingSearchReference,
  referenceKind,
  searchReferenceRange,
  uploadSearchReference,
  type ReverseSearchMode,
  type SearchReferenceDescriptor,
} from './search-reference'
import type { SearchReferenceLifecycleState, SearchReferenceMode } from './search-reference-lifecycle'
import { repairSearchIndexes } from './search-index-repair'
import { searchWithPreparation } from './search-preparation'
import { useSearchReferenceLifecycle } from './useSearchReferenceLifecycle'
import { asNumber, asString, recordValue } from './value-decoders'
import { asLibrarySearchResult, type LibraryAssetRecord } from './workspace-responses'

type MediaLibrarySearchOptions = {
  bookId: string
  notebook: NotebookDocument | null
  ready: boolean
  call: (
    tool: string,
    args: Record<string, unknown>,
    options?: { background?: boolean },
  ) => Promise<unknown>
  mediaSlotStates: Record<string, MediaSlotState>
  setNotice: (message: string, tone?: 'info' | 'error') => void
}

type MediaSearchMode = SearchReferenceMode

type MediaLibraryPickerState = {
  unindexedVisualAssets: number
  preparingIndex: boolean
  bookId: string
  notebookId: string
  cellId: string | null
  slot?: NotebookGridSlot
  query: string
  draftQuery: string
  assets: LibraryAssetRecord[]
  page: LibrarySearchPage
  booksWithErrors: Array<{ bookId: string; message: string }>
  loading: boolean
  loadingMore: boolean
  error: string | null
  activeArtifactId: string | null
  /** Exact tag terms narrowing this search; changing them resets paging. */
  tagFilters: TagFilterTerm[]
  tagSuggestions: TagSuggestion[]
}

type MediaLibrarySearchCriteria = {
  mode: MediaSearchMode
  reference: SearchReferenceDescriptor | null
  referenceStartSeconds: string
  referenceDurationSeconds: string
}

function mediaLibrarySearchCriteria(
  state: SearchReferenceLifecycleState,
): MediaLibrarySearchCriteria {
  return {
    mode: state.mode,
    reference: state.reference,
    referenceStartSeconds: state.startSeconds,
    referenceDurationSeconds: state.durationSeconds,
  }
}

const emptyLibraryPage: LibrarySearchPage = {
  offset: 0,
  limit: 24,
  total: 0,
  hasMore: false,
}

function mediaLibraryKinds(kind: MediaLibraryKind): string[] {
  if (kind === 'all') return ['audio', 'image', 'video', 'final']
  return kind === 'video' ? ['video', 'final'] : [kind]
}

export function isCompatibleLibraryAsset(
  kind: MediaLibraryKind,
  assetType: string,
): boolean {
  return mediaLibraryKinds(kind).includes(assetType)
}

export function useMediaLibrarySearch({
  bookId,
  notebook,
  ready,
  call,
  mediaSlotStates,
  setNotice,
}: MediaLibrarySearchOptions) {
  const [mediaLibraryPicker, setMediaLibraryPicker] = useState<MediaLibraryPickerState | null>(null)
  const mediaLibraryReference = useSearchReferenceLifecycle()
  const mediaLibraryRequestRef = useRef(0)
  const mediaLibraryOpenerRef = useRef<HTMLElement | null>(null)

  const mediaLibraryCell = mediaLibraryPicker
    ? notebook?.cells.find((cell) => cell.id === mediaLibraryPicker.cellId)
    : undefined
  const mediaLibraryKind: MediaLibraryKind | null = mediaLibraryCell
    ? passiveMediaKind(mediaLibraryCell.type)
    : mediaLibraryPicker?.cellId === null ? 'all' : null
  const mediaLibraryPanelState: MediaLibraryPanelState | null = mediaLibraryPicker
    ? {
        ...mediaLibraryPicker,
        uploading: mediaLibraryPicker.cellId !== null && mediaSlotStates[mediaLibraryPicker.cellId]?.operation === 'upload',
        mode: mediaLibraryReference.state.mode,
        reference: mediaLibraryReference.state.reference,
        referenceStartSeconds: mediaLibraryReference.state.startSeconds,
        referenceDurationSeconds: mediaLibraryReference.state.durationSeconds,
        preparingReference: mediaLibraryReference.state.preparing,
        error: mediaLibraryReference.state.error ?? mediaLibraryPicker.error,
      }
    : null

  const closeMediaLibrary = () => {
    const restoreFocus = captureDismissedComposerFocus(mediaLibraryOpenerRef.current)
    mediaLibraryRequestRef.current += 1
    mediaLibraryReference.lifecycle.close()
    setMediaLibraryPicker(null)
    mediaLibraryOpenerRef.current = null
    restoreFocus()
  }

  const loadMediaLibrary = async (
    cellId: string | null,
    query: string,
    offset: number,
    append: boolean,
    criteria?: MediaLibrarySearchCriteria,
    tagFilters?: readonly TagFilterTerm[],
    knownKind?: MediaLibraryKind,
  ) => {
    const cell = notebook?.cells.find((candidate) => candidate.id === cellId)
    const kind = knownKind ?? (cellId === null ? 'all' : cell && passiveMediaKind(cell.type))
    if (!kind) return
    const activeCriteria = criteria
      ?? (mediaLibraryPicker?.cellId === cellId
        ? mediaLibrarySearchCriteria(mediaLibraryReference.state)
        : {
            mode: 'text' as const,
            reference: null,
            referenceStartSeconds: '0',
            referenceDurationSeconds: '',
          })
    // Terms come in with the call rather than being read from state: a chip
    // click sets state and searches in the same tick, and state has not
    // updated yet.
    const activeTagFilters = tagFilters
      ?? (mediaLibraryPicker?.cellId === cellId
        ? mediaLibraryPicker.tagFilters
        : [])
    const requestId = mediaLibraryRequestRef.current + 1
    mediaLibraryRequestRef.current = requestId
    setMediaLibraryPicker((current) => {
      if (!current || current.cellId !== cellId) return current
      return {
        ...current,
        query,
        tagFilters: [...activeTagFilters],
        assets: append ? current.assets : [],
        page: append ? current.page : emptyLibraryPage,
        booksWithErrors: append ? current.booksWithErrors : [],
        preparingIndex: false,
        loading: !append,
        loadingMore: append,
        error: null,
      }
    })
    try {
      let referenceRange
      try {
        referenceRange = activeCriteria.mode === 'video-reverse'
          && activeCriteria.reference
          ? searchReferenceRange(
              activeCriteria.referenceStartSeconds,
              activeCriteria.referenceDurationSeconds,
              activeCriteria.reference,
            )
          : undefined
      } catch (error) {
        const message = mediaLibraryReference.lifecycle.getState().reference
          === activeCriteria.reference
          ? mediaLibraryReference.lifecycle.resetInvalidRange(error)
          : error instanceof Error ? error.message : String(error)
        throw new Error(message)
      }
      const isCancelled = () => mediaLibraryRequestRef.current !== requestId
      const response = await searchWithPreparation({
        search: () => call('search_library_assets', {
          ...(activeCriteria.mode === 'text' && query.trim()
            ? { query: query.trim() }
            : {}),
          ...(activeCriteria.mode !== 'text' && activeCriteria.reference
            ? { reference_id: activeCriteria.reference.referenceId }
            : {}),
          ...(referenceRange
            ? { reference_range: referenceRange }
            : {}),
          kinds: kind === 'all' ? ['audio', 'image', 'video'] : [kind],
          ...tagFilterArgs(activeTagFilters),
          limit: emptyLibraryPage.limit,
          offset,
        }),
        listJobs: (owningBookId, jobIds) => call('list_jobs', {
          book_id: owningBookId, job_ids: jobIds,
        }, { background: true }),
        onPreparing: (preparingIndex) => {
          if (isCancelled()) return
          setMediaLibraryPicker((current) => current && current.cellId === cellId
            ? { ...current, preparingIndex }
            : current)
        },
        isCancelled,
      })
      if (isCancelled()) return
      const result = asLibrarySearchResult(response)
      setMediaLibraryPicker((current) => {
        if (!current || current.cellId !== cellId) return current
        const compatible = result.assets.filter((asset) =>
          isCompatibleLibraryAsset(kind, asset.type))
        const combined = append ? [...current.assets, ...compatible] : compatible
        const unique = new Map(combined.map((asset) => [
          `${asset.owningBookId}:${asset.artifactId}`,
          asset,
        ]))
        return {
          ...current,
          assets: [...unique.values()],
          page: result.page,
          booksWithErrors: result.booksWithErrors,
          unindexedVisualAssets: result.unindexedVisualAssets,
          loading: false,
          loadingMore: false,
        }
      })
    } catch (error) {
      if (mediaLibraryRequestRef.current !== requestId) return
      const message = error instanceof Error ? error.message : String(error)
      setMediaLibraryPicker((current) =>
        current && current.cellId === cellId
          ? {
              ...current,
              loading: false,
              loadingMore: false,
              error: message,
            }
          : current)
      setNotice(message, 'error')
    }
  }

  const openMediaLibraryPicker = (
    cellId: string | null,
    currentNotebook: NotebookDocument,
    slot: NotebookGridSlot | undefined,
    kind: MediaLibraryKind,
  ) => {
    mediaLibraryOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    mediaLibraryReference.lifecycle.close()
    setMediaLibraryPicker({
      unindexedVisualAssets: 0,
      preparingIndex: false,
      bookId,
      notebookId: currentNotebook.id,
      cellId,
      slot,
      query: '',
      draftQuery: '',
      assets: [],
      page: emptyLibraryPage,
      booksWithErrors: [],
      loading: true,
      loadingMore: false,
      error: null,
      activeArtifactId: null,
      tagFilters: [],
      tagSuggestions: [],
    })
    void loadMediaLibrary(cellId, '', 0, false, {
      mode: 'text',
      reference: null,
      referenceStartSeconds: '0',
      referenceDurationSeconds: '',
    }, [], kind)
  }

  const updateMediaLibraryDraft = (query: string) => {
    setMediaLibraryPicker((current) => current ? { ...current, draftQuery: query } : current)
  }
  const changeMediaLibraryMode = (mode: MediaSearchMode) => {
    if (!mediaLibraryPicker || mediaLibraryReference.state.mode === mode) return
    const cellId = mediaLibraryPicker.cellId
    mediaLibraryRequestRef.current += 1
    mediaLibraryReference.lifecycle.changeMode(mode)
    setMediaLibraryPicker((current) => current && current.cellId === cellId
      ? {
          ...current,
          page: mode === 'text'
            ? current.page
            : {
                ...emptyLibraryPage,
                total: current.assets.length,
              },
          error: null,
          loading: false,
          loadingMore: false,
          preparingIndex: false,
        }
      : current)
    if (mode === 'text') {
      void loadMediaLibrary(
        cellId,
        mediaLibraryPicker.draftQuery,
        0,
        false,
        {
          mode,
          reference: null,
          referenceStartSeconds: '0',
          referenceDurationSeconds: '',
        },
      )
    }
  }
  const prepareMediaLibraryFile = async (file: File) => {
    if (!mediaLibraryPicker || mediaLibraryReference.state.mode === 'text' || !bookId) return
    const picker = mediaLibraryPicker
    mediaLibraryRequestRef.current += 1
    const mode = mediaLibraryReference.state.mode
    setMediaLibraryPicker((current) => current && current.cellId === picker.cellId
      ? { ...current, error: null, loading: false, loadingMore: false, preparingIndex: false }
      : current)
    const result = await mediaLibraryReference.lifecycle.prepare(
      mode,
      () => uploadSearchReference(file, bookId, referenceKind(mode)),
    )
    if (result.status === 'error') {
      setNotice(result.error, 'error')
      return
    }
    if (result.status === 'stale') return
    await loadMediaLibrary(picker.cellId, '', 0, false, {
      mode: result.mode,
      reference: result.reference,
      referenceStartSeconds: '0',
      referenceDurationSeconds: '',
    })
  }
  const prepareMediaLibrarySimilar = async (asset: LibraryAssetRecord) => {
    if (!mediaLibraryPicker) return
    const picker = mediaLibraryPicker
    mediaLibraryRequestRef.current += 1
    const mode: ReverseSearchMode = asset.type === 'image'
      ? 'image-reverse'
      : 'video-reverse'
    setMediaLibraryPicker((current) => current && current.cellId === picker.cellId
      ? {
          ...current,
          error: null,
          loading: false,
          loadingMore: false,
          preparingIndex: false,
        }
      : current)
    const result = await mediaLibraryReference.lifecycle.prepare(
      mode,
      () => prepareExistingSearchReference(call, {
        sourceBookId: asset.owningBookId,
        sourceArtifactId: asset.artifactId,
        mode,
        previewUrl: mode === 'image-reverse'
          ? asset.thumbnailUrl ?? asset.mediaUrl
          : asset.mediaUrl,
      }),
    )
    if (result.status === 'error') {
      setNotice(result.error, 'error')
      return
    }
    if (result.status === 'stale') return
    await loadMediaLibrary(picker.cellId, '', 0, false, {
      mode: result.mode,
      reference: result.reference,
      referenceStartSeconds: '0',
      referenceDurationSeconds: '',
    })
  }
  const clearMediaLibraryReference = () => {
    if (!mediaLibraryPicker) return
    mediaLibraryRequestRef.current += 1
    mediaLibraryReference.lifecycle.clearReference()
    setMediaLibraryPicker((current) => current ? { ...current, error: null, loading: false, loadingMore: false, preparingIndex: false } : current)
  }
  const repairMediaLibraryIndexes = async () => {
    if (!mediaLibraryPicker || !mediaLibraryKind || mediaLibraryKind === 'audio') return
    const picker = mediaLibraryPicker
    const requestId = ++mediaLibraryRequestRef.current
    setMediaLibraryPicker((current) => current ? { ...current, preparingIndex: true, error: null } : current)
    try {
      const result = await repairSearchIndexes({
        start: () => call('repair_library_search_indexes', { kinds: mediaLibraryKind === 'all' ? ['image', 'video'] : [mediaLibraryKind] }),
        listJobs: (bookId, jobIds) => call('list_jobs', { book_id: bookId, job_ids: jobIds }),
        isCancelled: () => mediaLibraryRequestRef.current !== requestId,
      })
      if (mediaLibraryRequestRef.current !== requestId) return
      const reloadId = mediaLibraryRequestRef.current + 1
      await loadMediaLibrary(picker.cellId, picker.query, 0, false)
      if (mediaLibraryRequestRef.current !== reloadId) return
      const failed = asNumber(result?.failed) ?? 0
      if (failed > 0) {
        const failures = Array.isArray(result?.failures) ? result.failures : []
        const detail = asString(recordValue(failures[0])?.message)
        const message = `Some media could not be indexed.${detail ? ` ${detail}` : ''}`
        setMediaLibraryPicker((current) => current ? { ...current, error: message } : current)
        setNotice(message, 'error')
      } else {
        setNotice(`Indexed ${asNumber(result?.indexed) ?? 0} media assets for Similar search`)
      }
    } catch (error) {
      if (mediaLibraryRequestRef.current !== requestId) return
      const message = error instanceof Error ? error.message : String(error)
      setMediaLibraryPicker((current) => current ? { ...current, preparingIndex: false, error: message } : current)
      setNotice(message, 'error')
    }
  }
  const searchMediaLibrary = () => {
    if (!mediaLibraryPicker) return
    mediaLibraryReference.lifecycle.clearError()
    void loadMediaLibrary(
      mediaLibraryPicker.cellId,
      mediaLibraryPicker.draftQuery,
      0,
      false,
    )
  }
  const loadMoreMediaLibrary = () => {
    if (!mediaLibraryPicker) return
    void loadMediaLibrary(
      mediaLibraryPicker.cellId,
      mediaLibraryPicker.query,
      mediaLibraryPicker.page.offset + mediaLibraryPicker.page.limit,
      true,
    )
  }

  /**
   * Applying or lifting a tag term re-runs the search from the first page:
   * an offset into the previous result set means nothing once the filter that
   * produced it has changed.
   */
  const toggleMediaLibraryTagFilter = (term: TagFilterTerm) => {
    if (!mediaLibraryPicker) return
    const next = toggleTagFilter(mediaLibraryPicker.tagFilters, term)
    if (sameTagFilter(next, mediaLibraryPicker.tagFilters)) return
    void loadMediaLibrary(
      mediaLibraryPicker.cellId,
      mediaLibraryPicker.query,
      0,
      false,
      undefined,
      next,
    )
  }

  const clearMediaLibraryTagFilters = () => {
    if (!mediaLibraryPicker || mediaLibraryPicker.tagFilters.length === 0) return
    void loadMediaLibrary(
      mediaLibraryPicker.cellId,
      mediaLibraryPicker.query,
      0,
      false,
      undefined,
      [],
    )
  }

  const loadMediaLibraryTagSuggestions = async (prefix: string) => {
    if (!mediaLibraryPicker || !ready) return
    const cellId = mediaLibraryPicker.cellId
    try {
      const response = await call('suggest_asset_tags', {
        book_id: bookId,
        ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
        limit: 20,
      }, { background: true }) as { suggestions?: unknown }
      const suggestions = Array.isArray(response?.suggestions)
        ? response.suggestions.flatMap((entry) => {
            const row = entry as Record<string, unknown>
            return typeof row.facet === 'string'
              && typeof row.key === 'string'
              && typeof row.label === 'string'
              ? [{
                  facet: row.facet as TagFilterTerm['facet'],
                  key: row.key,
                  label: row.label,
                  assets: Number(row.assets) || 0,
                }]
              : []
          })
        : []
      setMediaLibraryPicker((current) => current && current.cellId === cellId
        ? { ...current, tagSuggestions: suggestions }
        : current)
    } catch {
      // Autocomplete never blocks a search someone can still type by hand.
    }
  }

  return {
    mediaLibraryPicker,
    setMediaLibraryPicker,
    mediaLibraryReference,
    mediaLibraryRequestRef,
    mediaLibraryKind,
    mediaLibraryPanelState,
    closeMediaLibrary,
    openMediaLibraryPicker,
    updateMediaLibraryDraft,
    changeMediaLibraryMode,
    prepareMediaLibraryFile,
    prepareMediaLibrarySimilar,
    clearMediaLibraryReference,
    repairMediaLibraryIndexes,
    searchMediaLibrary,
    loadMoreMediaLibrary,
    toggleMediaLibraryTagFilter,
    clearMediaLibraryTagFilters,
    loadMediaLibraryTagSuggestions,
  }
}
