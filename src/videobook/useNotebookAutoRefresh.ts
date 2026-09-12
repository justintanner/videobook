import { useEffect, useEffectEvent } from 'react'

type NotebookAutoRefreshOptions = {
  bookId: string
  notebookId: string | null
  enabled: boolean
  refresh: (isCurrent: () => boolean) => Promise<void>
}

export function useNotebookAutoRefresh({
  bookId,
  notebookId,
  enabled,
  refresh,
}: NotebookAutoRefreshOptions) {
  const refreshSnapshot = useEffectEvent(refresh)

  useEffect(() => {
    if (!enabled || !bookId || !notebookId) return
    let active = true
    let pending = false
    let requested = false
    let timer = 0

    const run = async () => {
      window.clearTimeout(timer)
      if (!active || document.visibilityState === 'hidden') return
      if (pending) {
        requested = true
        return
      }
      pending = true
      try {
        await refreshSnapshot(() => active)
      } catch {
        requested = false
      } finally {
        pending = false
        if (active) timer = window.setTimeout(run, requested ? 0 : 2_000)
        requested = false
      }
    }
    const request = () => { void run() }
    timer = window.setTimeout(run, 0)
    window.addEventListener('focus', request)
    document.addEventListener('visibilitychange', request)
    return () => {
      active = false
      window.clearTimeout(timer)
      window.removeEventListener('focus', request)
      document.removeEventListener('visibilitychange', request)
    }
  }, [bookId, enabled, notebookId])
}
