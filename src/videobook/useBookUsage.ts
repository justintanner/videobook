import { useEffect, useEffectEvent, useState } from 'react'
import { parseBookUsage } from './book-usage'
import type { BookUsageSnapshot } from './book-usage'

type UsageOptions = {
  bookId: string
  ready: boolean
  call: (tool: string, args: Record<string, unknown>, options?: { background?: boolean }) => Promise<unknown>
  cellId?: string | null
  runId?: string | null
}

export function useBookUsage({ bookId, ready, call, cellId = null, runId = null }: UsageOptions) {
  const [snapshot, setSnapshot] = useState<{ bookId: string; data: BookUsageSnapshot } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const read = useEffectEvent(async (current: () => boolean) => {
    try {
      const scope = { ...(cellId ? { cell_id: cellId } : {}), ...(runId ? { run_id: runId } : {}) }
      const args = Object.keys(scope).length > 0 ? { book_id: bookId, scope } : { book_id: bookId }
      const data = parseBookUsage(await call('get_book_usage', args, { background: true }))
      if (!current()) return
      setSnapshot((previous) => previous?.bookId === bookId && JSON.stringify(previous.data) === JSON.stringify(data) ? previous : { bookId, data })
      setFailure(null)
    } catch {
      if (current()) setFailure(bookId)
    }
  })

  useEffect(() => {
    if (!ready || !bookId) return
    let active = true
    let pending = false
    let timer = 0
    const run = async () => {
      window.clearTimeout(timer)
      if (!active || pending || document.visibilityState === 'hidden') return
      pending = true
      try { await read(() => active) }
      finally {
        pending = false
        if (active) timer = window.setTimeout(run, 2_000)
      }
    }
    const refresh = () => { void run() }
    timer = window.setTimeout(refresh, 0)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      active = false
      window.clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [bookId, ready, refreshKey, cellId, runId])

  return {
    snapshot: snapshot?.bookId === bookId ? snapshot.data : null,
    stale: !ready || failure === bookId,
    retry: () => setRefreshKey((value) => value + 1),
  }
}
