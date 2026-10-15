import { useRef, useState } from 'react'
import type { PostView } from '../../server/src/posts/post-contract'

export type PostToolCall = (tool: string, args: Record<string, unknown>, options?: { background?: boolean }) => Promise<unknown>

export function usePostActions(call: PostToolCall | undefined, bookId: string, refresh: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (tool: string, args: Record<string, unknown> = {}) => {
    if (!call || busy) return false
    setBusy(true)
    setError(null)
    try {
      await call(tool, { book_id: bookId, ...args })
      await refresh()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

export function usePostsPanel(call: PostToolCall, bookId: string) {
  const request = useRef(0)
  const [snapshot, setSnapshot] = useState<{ bookId: string; posts: PostView[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = async () => {
    const id = ++request.current
    setLoading(true)
    setError(null)
    setSnapshot({ bookId, posts: [] })
    try {
      const result = await call('list_posts', { book_id: bookId }) as { posts: PostView[] }
      if (request.current === id) setSnapshot({ bookId, posts: result.posts })
    } catch (cause) {
      if (request.current === id) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (request.current === id) setLoading(false) }
  }
  return { posts: snapshot?.bookId === bookId ? snapshot.posts : null, loading, error, open, close: () => { request.current += 1; setSnapshot(null) } }
}
