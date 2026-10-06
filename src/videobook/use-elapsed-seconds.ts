import { useEffect, useState } from 'react'

/** Seconds since `startedAt`, ticking once a second while mounted. */
export function useElapsedSeconds(startedAt: string | null): number | null {
  const [elapsed, setElapsed] = useState<number | null>(null)
  useEffect(() => {
    if (!startedAt) return
    const start = Date.parse(startedAt)
    if (!Number.isFinite(start)) return
    const compute = () =>
      setElapsed(Math.max(0, Math.round((Date.now() - start) / 1000)))
    // Async first sample: setState inside the effect body would cascade.
    const first = window.setTimeout(compute, 0)
    const timer = window.setInterval(compute, 1000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [startedAt])
  return startedAt ? elapsed : null
}
