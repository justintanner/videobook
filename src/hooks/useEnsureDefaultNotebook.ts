import { useEffect, useRef } from 'react'
import type { UseMcpResult } from 'use-mcp/react'

interface UseEnsureDefaultNotebookProps {
  state: UseMcpResult['state']
  bookId: string | undefined
  assetList: unknown[] | undefined
  hasNotebook: boolean
  createNotebook: (name: string) => Promise<string | null>
}

export function useEnsureDefaultNotebook({
  state,
  bookId,
  assetList,
  hasNotebook,
  createNotebook,
}: UseEnsureDefaultNotebookProps) {
  const attemptedRef = useRef<Record<string, boolean>>({})

  useEffect(() => {
    if (state !== 'ready' || !bookId || assetList === undefined) return

    if (attemptedRef.current[bookId]) return
    attemptedRef.current[bookId] = true

    if (!hasNotebook) {
      void createNotebook('scratch')
    }
  }, [state, bookId, assetList, hasNotebook, createNotebook])
}
