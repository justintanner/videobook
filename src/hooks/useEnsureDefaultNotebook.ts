import { useEffect, useRef } from 'react'
import type { UseMcpResult } from 'use-mcp/react'

interface UseEnsureDefaultNotebookProps {
  state: UseMcpResult['state']
  projectSlug: string | undefined
  assetList: unknown[] | undefined
  hasNotebook: boolean
  createNotebook: (name: string) => Promise<string | null>
}

export function useEnsureDefaultNotebook({
  state,
  projectSlug,
  assetList,
  hasNotebook,
  createNotebook,
}: UseEnsureDefaultNotebookProps) {
  const attemptedRef = useRef<Record<string, boolean>>({})

  useEffect(() => {
    if (state !== 'ready' || !projectSlug || assetList === undefined) return

    if (attemptedRef.current[projectSlug]) return
    attemptedRef.current[projectSlug] = true

    if (!hasNotebook) {
      void createNotebook('scratch')
    }
  }, [state, projectSlug, assetList, hasNotebook, createNotebook])
}
