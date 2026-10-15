import { useState } from 'react'

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
