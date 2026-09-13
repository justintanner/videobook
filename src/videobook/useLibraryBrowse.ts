import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import type { LibraryBrowseStatus, LibraryScope, OwningBook } from './library-scope'

export type LibraryBrowsePage = {
  offset: number
  limit: number
  total: number
  hasMore: boolean
}

export type LibraryStatusCounts = {
  ready: number
  processing: number
  error: number
}

export type LibraryBrowseResult<Asset> = {
  assets: Asset[]
  receivedCount: number
  page: LibraryBrowsePage
  statusCounts: LibraryStatusCounts
  booksWithErrors: Array<{ bookId: string; message: string }>
}

export type LibraryBrowseState<Asset> = LibraryBrowseResult<Asset> & {
  key: string
  nextOffset: number
  loading: boolean
  loadingMore: boolean
  refreshing: boolean
  error: string | null
}

export type LibraryBrowseRequest = OwningBook & {
  scope: LibraryScope
  status: LibraryBrowseStatus
  offset: number
  limit: number
}

type BrowseAsset = { artifactId: string; owningBookId: string }

function emptyBrowse<Asset>(key: string, loading: boolean): LibraryBrowseState<Asset> {
  return {
    key,
    assets: [],
    receivedCount: 0,
    page: { offset: 0, limit: 100, total: 0, hasMore: false },
    statusCounts: { ready: 0, processing: 0, error: 0 },
    booksWithErrors: [],
    nextOffset: 0,
    loading,
    loadingMore: false,
    refreshing: false,
    error: null,
  }
}

export function useLibraryBrowse<Asset extends BrowseAsset>({
  active,
  ready,
  connectionError,
  bookId,
  bookName,
  scope,
  status,
  revision,
  loadPage,
}: {
  active: boolean
  ready: boolean
  connectionError: string | null
  bookId: string
  bookName: string
  scope: LibraryScope
  status: LibraryBrowseStatus
  revision: unknown
  loadPage: (request: LibraryBrowseRequest) => Promise<LibraryBrowseResult<Asset>>
}) {
  const key = `${scope}:${bookId}:${status}`
  const enabled = active && ready && Boolean(bookId)
  const [state, setState] = useState(() => emptyBrowse<Asset>('', false))
  const snapshotRef = useRef<LibraryBrowseState<Asset> | null>(null)
  const readPage = useEffectEvent(loadPage)
  const requestRef = useRef<((more: boolean) => void) | null>(null)
  const previousRevisionRef = useRef(revision)
  const refresh = useCallback(() => requestRef.current?.(false), [])
  const loadMore = useCallback(() => requestRef.current?.(true), [])

  useEffect(() => {
    if (!enabled) {
      if (!active) snapshotRef.current = null
      return
    }
    let current = true
    let pending = false
    let refreshRequested = false
    let timer = 0
    let snapshot = snapshotRef.current?.key === key
      ? snapshotRef.current
      : emptyBrowse<Asset>(key, true)
    snapshotRef.current = snapshot
    const limit = scope === 'library' ? 100 : 200

    const run = async (more: boolean) => {
      window.clearTimeout(timer)
      if (!current) return
      if (pending) {
        if (!more) refreshRequested = true
        return
      }
      if (document.visibilityState === 'hidden') return
      if (more && !snapshot.page.hasMore) return
      pending = true
      setState({
        ...snapshot,
        loading: snapshot.assets.length === 0,
        loadingMore: more,
        refreshing: !more && snapshot.assets.length > 0,
        error: null,
      })
      try {
        let offset = more ? snapshot.nextOffset : 0
        const target = more ? offset + 1 : Math.max(1, snapshot.nextOffset)
        const assets = new Map((more ? snapshot.assets : []).map((asset) => [
          `${asset.owningBookId}:${asset.artifactId}`,
          asset,
        ]))
        let result: LibraryBrowseResult<Asset>
        do {
          result = await readPage({
            owningBookId: bookId,
            owningBookName: bookName,
            scope,
            status,
            offset,
            limit,
          })
          if (!current) return
          for (const asset of result.assets) {
            assets.set(`${asset.owningBookId}:${asset.artifactId}`, asset)
          }
          const nextOffset = result.page.offset + result.receivedCount
          if (result.page.hasMore && nextOffset <= offset) {
            throw new Error('The library returned an empty page before the end. Try refreshing.')
          }
          offset = nextOffset
        } while (result.page.hasMore && offset < target)
        snapshot = {
          ...result,
          key,
          assets: [...assets.values()],
          nextOffset: offset,
          loading: false,
          loadingMore: false,
          refreshing: false,
          error: null,
        }
        snapshotRef.current = snapshot
        setState(snapshot)
      } catch (error) {
        if (!current) return
        snapshot = {
          ...snapshot,
          loading: false,
          loadingMore: false,
          refreshing: false,
          error: error instanceof Error ? error.message : String(error),
        }
        snapshotRef.current = snapshot
        setState(snapshot)
      } finally {
        pending = false
        if (current) {
          timer = window.setTimeout(() => void run(false), refreshRequested ? 0 : 5_000)
          refreshRequested = false
        }
      }
    }
    const request = (more: boolean) => { void run(more) }
    const wake = () => request(false)
    requestRef.current = request
    timer = window.setTimeout(wake, 0)
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      current = false
      window.clearTimeout(timer)
      requestRef.current = null
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [active, bookId, bookName, enabled, key, scope, status])

  useEffect(() => {
    if (previousRevisionRef.current === revision) return
    previousRevisionRef.current = revision
    refresh()
  }, [refresh, revision])

  const matching = active && state.key === key
    ? state
    : emptyBrowse<Asset>(key, active)
  const browse = connectionError
    ? { ...matching, loading: false, loadingMore: false, refreshing: false, error: connectionError }
    : matching
  return { browse, refresh, loadMore }
}
