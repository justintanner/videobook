import { useCallback, useEffect, useRef } from 'react'

export function useGenerationPreviewRefresh<Args extends unknown[]>(
  refresh: (...args: Args) => void,
  scope: string,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancel = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  useEffect(() => cancel, [cancel, scope])

  const schedule = useCallback((...args: Args) => {
    cancel()
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      refresh(...args)
    }, 350)
  }, [cancel, refresh])

  const run = useCallback((...args: Args) => {
    cancel()
    refresh(...args)
  }, [cancel, refresh])

  return { schedule, cancel, run }
}
