import { useEffect, useEffectEvent, useState } from 'react'
import type { SpliceMatchScores } from '../../server/src/splice-match'

type ToolCall = (
  tool: string,
  args: Record<string, unknown>,
  options?: { background?: boolean },
) => Promise<unknown>

export type SplicePreviewMatch = SpliceMatchScores & {
  secondDuration: number
  window: number
}

type SplicePreviewTarget = {
  bookId: string
  firstAssetId: string
  secondAssetId: string
}

type SplicePreviewState = {
  key: string
  match: SplicePreviewMatch | null
  error: string | null
}

export const SPLICE_PREVIEW_WINDOW_SECONDS = 10

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function parseSplicePreview(response: unknown): SplicePreviewMatch | null {
  if (!response || typeof response !== 'object') return null
  const record = response as Record<string, unknown>
  const fps = finiteNumber(record.fps)
  const firstDuration = finiteNumber(record.first_duration)
  const secondDuration = finiteNumber(record.second_duration)
  const window = finiteNumber(record.window)
  const windowStartFrame = finiteNumber(record.window_start_frame)
  if (
    !fps || !firstDuration || !secondDuration || !window
    || windowStartFrame === null || !Array.isArray(record.scores)
  ) return null
  const scores = record.scores.filter((score): score is number =>
    finiteNumber(score) !== null)
  if (scores.length === 0) return null
  return { fps, firstDuration, secondDuration, window, windowStartFrame, scores }
}

function targetKey(target: SplicePreviewTarget | null): string {
  return target
    ? `${target.bookId}/${target.firstAssetId}/${target.secondAssetId}`
    : ''
}

export function useSplicePreview({
  call,
  target,
}: {
  call: ToolCall | null
  target: SplicePreviewTarget | null
}) {
  const key = targetKey(target)
  const [state, setState] = useState<SplicePreviewState | null>(null)
  const [attempt, setAttempt] = useState(0)
  const read = useEffectEvent(async (current: () => boolean) => {
    if (!call || !target) return
    try {
      const match = parseSplicePreview(await call('preview_splice', {
        book_id: target.bookId,
        first_asset_id: target.firstAssetId,
        second_asset_id: target.secondAssetId,
        window: SPLICE_PREVIEW_WINDOW_SECONDS,
      }, { background: true }))
      if (!current()) return
      setState({
        key,
        match,
        error: match ? null : 'The splice preview returned no frame scores',
      })
    } catch (cause) {
      if (!current()) return
      setState({
        key,
        match: null,
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }
  })

  const ready = Boolean(call)
  useEffect(() => {
    if (!ready || !key) return
    let active = true
    const timer = window.setTimeout(() => {
      void read(() => active)
    }, 0)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [ready, key, attempt])

  const current = state?.key === key ? state : null
  return {
    match: current?.match ?? null,
    error: current?.error ?? null,
    loading: Boolean(key && ready && !current),
    retry: () => {
      setState(null)
      setAttempt((value) => value + 1)
    },
  }
}
