import { OperationTimeoutError, withTimeout } from '@/lib/async-timeout'

export const RENDER_RECONCILIATION_TIMEOUT_MS = 10_000
export const RENDER_ENQUEUE_TIMEOUT_MS = 30_000

type RenderOutcome = {
  ok: boolean
  error?: string
}

type Reconciliation = 'not-needed' | 'refreshed' | 'unavailable' | 'timed-out'

type OptimisticRenderRequest = {
  optimisticStatus: string
  enqueue: () => Promise<RenderOutcome>
  refresh: () => Promise<unknown | null>
  setOverride: (status: string | null) => void
  timeoutMs?: number
  enqueueTimeoutMs?: number
}

export async function runOptimisticRenderRequest({
  optimisticStatus,
  enqueue,
  refresh,
  setOverride,
  timeoutMs = RENDER_RECONCILIATION_TIMEOUT_MS,
  enqueueTimeoutMs = RENDER_ENQUEUE_TIMEOUT_MS,
}: OptimisticRenderRequest): Promise<RenderOutcome & { reconciliation: Reconciliation }> {
  setOverride(optimisticStatus)

  let outcome: RenderOutcome
  try {
    outcome = await withTimeout(
      Promise.resolve().then(enqueue),
      enqueueTimeoutMs,
      'Render enqueue',
    )
  } catch (error) {
    setOverride(null)
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      reconciliation: 'not-needed',
    }
  }

  if (!outcome.ok) {
    setOverride(null)
    return { ...outcome, reconciliation: 'not-needed' }
  }

  let reconciliation: Reconciliation
  try {
    const refreshed = await withTimeout(
      Promise.resolve().then(refresh),
      timeoutMs,
      'Render status refresh',
    )
    reconciliation = refreshed === null ? 'unavailable' : 'refreshed'
  } catch (error) {
    reconciliation = error instanceof OperationTimeoutError ? 'timed-out' : 'unavailable'
  } finally {
    setOverride(null)
  }

  return { ...outcome, reconciliation }
}
