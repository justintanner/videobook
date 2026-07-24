import { useCallback, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { ArchiveRestore, CheckSquare, Loader2, Search, Square } from 'lucide-react'
import { CloseButton } from '@/components/ui/CloseButton'
import type { UseMcpResult } from 'use-mcp/react'
import { cn } from '@/lib/utils'

type ArchiveTag = {
  key: string
  label: string
  source?: string
}

type ArchiveResult = {
  archive_id: string
  sha256: string
  title: string | null
  topics: ArchiveTag[]
  people: ArchiveTag[]
  duration: number | null
  media: {
    key: string
    content_type: string
    size_bytes: number
    url: string | null
    expires_at: string | null
  }
  transcript_excerpt: string | null
}

export type ArchiveSearchResponse = {
  results: ArchiveResult[]
  total: number
  offset: number
  limit: number
  has_more: boolean
}

export type RestoreResponse = {
  status: string
  restored: Array<{ archive_id: string; asset_id: string; job_id: string }>
  skipped: Array<{ archive_id: string; asset_id: string; reason: string }>
}

type ArchiveBrowserProps = {
  bookId: string | undefined
  callTool: UseMcpResult['callTool']
  callState: UseMcpResult['state']
  initialResponse?: ArchiveSearchResponse | null
  initialError?: string | null
  initialLoading?: boolean
  initialQuery?: string
  onClose: () => void
  onRestoreComplete: (response: RestoreResponse) => void
}

const PAGE_SIZE = 20

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'unknown'
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit] ?? 'B'}`
}

function isVideoContent(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('video/')
}

function isAudioContent(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('audio/')
}

export function ArchiveBrowser({ bookId, callTool, callState, initialResponse, initialError, initialLoading = false, initialQuery = '', onClose, onRestoreComplete }: ArchiveBrowserProps) {
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState<ArchiveResult[]>(initialResponse?.results ?? [])
  const [total, setTotal] = useState(initialResponse?.total ?? 0)
  const [offset, setOffset] = useState(initialResponse?.offset ?? 0)
  const [limit, setLimit] = useState(initialResponse?.limit ?? PAGE_SIZE)
  const [hasMore, setHasMore] = useState(initialResponse?.has_more ?? false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [searched, setSearched] = useState(initialResponse != null || initialError != null)
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [notice, setNotice] = useState<string | null>(null)

  const selectedCount = selectedIds.size
  const visibleSelected = useMemo(
    () => results.length > 0 && results.every((result) => selectedIds.has(result.archive_id)),
    [results, selectedIds],
  )

  const toggleSelected = useCallback((archiveId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(archiveId)) {
        next.delete(archiveId)
      } else {
        next.add(archiveId)
      }
      return next
    })
  }, [])

  const loadPage = useCallback(async (nextOffset: number, searchQuery: string) => {
    if (callState !== 'ready') {
      setError('MCP is not ready')
      return
    }
    setLoading(true)
    setError(null)
    setNotice(null)
    setSelectedIds(new Set())
    try {
      const args: {
        query?: string
        limit: number
        offset: number
        sort: 'newest'
        include_transcript: boolean
        presign_media: boolean
      } = {
        limit: PAGE_SIZE,
        offset: nextOffset,
        sort: 'newest',
        include_transcript: false,
        presign_media: true,
      }
      const trimmed = searchQuery.trim()
      if (trimmed) args.query = trimmed
      const result = await callTool('search_archive', args)
      const content = result.content as Array<{ type: string; text: string }>
      if (result.isError) {
        setError(content[0]?.text ?? 'Archive search failed')
        setResults([])
        setTotal(0)
        setOffset(0)
        setHasMore(false)
        setSearched(true)
        return
      }
      const parsed = JSON.parse(content[0]?.text ?? '{"results":[],"total":0,"offset":0,"limit":20,"has_more":false}') as ArchiveSearchResponse
      setResults(parsed.results)
      setTotal(parsed.total)
      setOffset(parsed.offset)
      setLimit(parsed.limit)
      setHasMore(parsed.has_more)
      setSearched(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setResults([])
      setTotal(0)
      setOffset(0)
      setHasMore(false)
      setSearched(true)
    } finally {
      setLoading(false)
    }
  }, [callState, callTool])

  const handleSearch = useCallback(async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    await loadPage(0, query)
  }, [loadPage, query])

  const handlePreviousPage = useCallback(() => {
    void loadPage(Math.max(0, offset - limit), query)
  }, [limit, loadPage, offset, query])

  const handleNextPage = useCallback(() => {
    void loadPage(offset + limit, query)
  }, [limit, loadPage, offset, query])

  const handleSelectVisible = useCallback(() => {
    if (visibleSelected) {
      setSelectedIds(new Set())
      return
    }
    setSelectedIds(new Set(results.map((result) => result.archive_id)))
  }, [results, visibleSelected])

  const handleRestore = useCallback(async () => {
    if (!bookId) {
      setError('No current project')
      return
    }
    if (callState !== 'ready') {
      setError('MCP is not ready')
      return
    }
    const archiveIds = [...selectedIds]
    if (archiveIds.length === 0) return
    setRestoring(true)
    setError(null)
    setNotice(null)
    try {
      const result = await callTool('restore_archive_clips', {
        book_id: bookId,
        archive_ids: archiveIds,
        skip_existing: true,
      })
      const content = result.content as Array<{ type: string; text: string }>
      if (result.isError) {
        setError(content[0]?.text ?? 'Restore failed')
        return
      }
      const parsed = JSON.parse(content[0]?.text ?? '{"status":"noop","restored":[],"skipped":[]}') as RestoreResponse
      setNotice(`${parsed.restored.length} restoring, ${parsed.skipped.length} skipped`)
      setSelectedIds(new Set())
      onRestoreComplete(parsed)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRestoring(false)
    }
  }, [callState, callTool, onRestoreComplete, bookId, selectedIds])

  return (
    <div className="flex-1 min-h-0 overflow-hidden border border-border/60 bg-zinc-950/70">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
 <ArchiveRestore className=" size-4 shrink-0 text-amber-300" />
            <div className="min-w-0">
              <div className="font-mono text-[11px] font-bold uppercase tracking-widest text-amber-200">Archive</div>
            </div>
          </div>
          <CloseButton onClick={onClose} className="shrink-0" title="Close archive" aria-label="Close archive" />
        </div>

        <form onSubmit={handleSearch} className="flex shrink-0 items-center gap-2 border-b border-border/40 px-3 py-3">
          <div className="flex h-9 min-w-0 flex-1 items-center gap-2 border border-zinc-800 bg-black/40 px-2.5 focus-within:border-amber-400/50">
 <Search className=" size-4 shrink-0 text-zinc-600" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search title, topics, people, transcript"
              className="min-w-0 flex-1 bg-transparent font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
            />
          </div>
          <button
            type="submit"
            disabled={loading || initialLoading || restoring || callState !== 'ready'}
            className="flex h-9 items-center gap-2 border border-amber-400/40 bg-amber-500/10 px-3 font-mono text-xs font-bold uppercase tracking-widest text-amber-200 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
 {loading ? <Loader2 className=" size-3.5 animate-spin" /> : <Search className=" size-3.5" />}
            Search
          </button>
        </form>

        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/40 px-3 py-2">
          <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">
            {total} results
            {selectedCount > 0 ? ` / ${selectedCount} selected` : ''}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={offset === 0 || loading || initialLoading || restoring}
              onClick={handlePreviousPage}
              className="flex h-7 items-center border border-zinc-800 px-2 font-mono text-[10px] uppercase tracking-wider text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Prev
            </button>
            <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-600">
              {total === 0 ? '0-0' : `${offset + 1}-${Math.min(offset + results.length, total)}`}
            </div>
            <button
              type="button"
              disabled={!hasMore || loading || initialLoading || restoring}
              onClick={handleNextPage}
              className="flex h-7 items-center border border-zinc-800 px-2 font-mono text-[10px] uppercase tracking-wider text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next
            </button>
            <button
              type="button"
              disabled={results.length === 0 || initialLoading || restoring}
              onClick={handleSelectVisible}
              className="flex h-7 items-center gap-1.5 border border-zinc-800 px-2 font-mono text-[10px] uppercase tracking-wider text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
 {visibleSelected ? <CheckSquare className=" size-3.5" /> : <Square className=" size-3.5" />}
              {visibleSelected ? 'Clear' : 'Select visible'}
            </button>
          </div>
        </div>

        {error && (
          <div className="shrink-0 border-b border-red-500/30 bg-red-500/10 px-3 py-2 font-mono text-xs text-red-200">
            {error}
          </div>
        )}
        {notice && (
          <div className="shrink-0 border-b border-emerald-500/30 bg-emerald-500/10 px-3 py-2 font-mono text-xs text-emerald-200">
            {notice}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading || initialLoading ? (
            <div className="flex h-full items-center justify-center gap-2 font-mono text-sm text-zinc-500">
 <Loader2 className=" size-4 animate-spin" />
              {initialLoading ? 'Loading latest archived clips' : 'Searching archive'}
            </div>
          ) : results.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center font-mono text-sm text-zinc-600">
              {searched ? 'No archived clips found' : 'Search archived clips'}
            </div>
          ) : (
            <div className="grid gap-2">
              {results.map((result) => {
                const selected = selectedIds.has(result.archive_id)
                return (
                  <div
                    key={result.archive_id}
                    onClick={() => toggleSelected(result.archive_id)}
                    className={cn(
                      'grid cursor-pointer grid-cols-[8rem_minmax(0,1fr)] gap-3 border bg-black/30 p-2 transition-colors',
                      selected ? 'border-amber-400/60 bg-amber-500/10 hover:bg-amber-500/15' : 'border-zinc-800 hover:border-zinc-700 hover:bg-zinc-500/10',
                    )}
                  >
                    <div className="aspect-video overflow-hidden bg-black">
                      {result.media.url && isVideoContent(result.media.content_type) ? (
                        <video
                          src={result.media.url}
 className=" size-full object-contain"
                          controls
                          muted
                          preload="metadata"
                          onClick={(event) => event.stopPropagation()}
                        />
                      ) : result.media.url && isAudioContent(result.media.content_type) ? (
                        <div className="flex h-full items-center px-2">
                          <audio
                            src={result.media.url}
                            controls
                            preload="metadata"
                            className="w-full"
                            onClick={(event) => event.stopPropagation()}
                          />
                        </div>
                      ) : (
                        <div className="flex h-full items-center justify-center font-mono text-[10px] uppercase tracking-widest text-zinc-700">
                          No preview
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 flex flex-col gap-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex flex-col gap-1">
                          <div className="min-w-0 truncate text-sm font-semibold text-zinc-100">
                            {result.title || result.archive_id.slice(0, 12)}
                          </div>
                          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                            <span>{formatDuration(result.duration)}</span>
                            <span>{formatBytes(result.media.size_bytes)}</span>
                            <span>{result.media.content_type}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            toggleSelected(result.archive_id)
                          }}
 className="flex size-7 shrink-0 items-center justify-center text-amber-200"
                          title={selected ? 'Deselect clip' : 'Select clip'}
                        >
 {selected ? <CheckSquare className=" size-4" /> : <Square className=" size-4" />}
                        </button>
                      </div>

                      {(result.topics.length > 0 || result.people.length > 0) && (
                        <div className="flex flex-wrap gap-1.5">
                          {[...result.topics, ...result.people].slice(0, 8).map((tag) => (
                            <span
                              key={`${tag.key}-${tag.label}`}
                              className="border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
                            >
                              {tag.label}
                            </span>
                          ))}
                        </div>
                      )}

                      {result.transcript_excerpt && (
                        <p className="line-clamp-2 text-xs leading-5 text-zinc-500">
                          {result.transcript_excerpt}
                        </p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 px-3 py-3">
          <div className="font-mono text-[11px] text-zinc-500">
            Selected clips restore as new assets in the current project
          </div>
          <button
            type="button"
            disabled={selectedCount === 0 || initialLoading || restoring || !bookId || callState !== 'ready'}
            onClick={handleRestore}
            className="flex h-9 items-center gap-2 border border-emerald-400/40 bg-emerald-500/10 px-3 font-mono text-xs font-bold uppercase tracking-widest text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
 {restoring ? <Loader2 className=" size-3.5 animate-spin" /> : <ArchiveRestore className=" size-3.5" />}
            Restore {selectedCount > 0 ? selectedCount : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
