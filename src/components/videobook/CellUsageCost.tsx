import { useBookUsage } from '@/videobook/useBookUsage'
import { UsageCostSummary } from './UsageCost'

type CallTool = (
  tool: string,
  args: Record<string, unknown>,
  options?: { background?: boolean },
) => Promise<unknown>

async function unavailable(): Promise<unknown> {
  throw new Error('Usage is unavailable')
}

/**
 * Cost of a notebook cell's provider calls, and of the run in flight when
 * one is given: the quoted estimate beside the actual, call by call.
 */
export function CellUsageCost({
  bookId,
  call,
  cellId,
  runId = null,
  collapsible = false,
}: {
  bookId: string
  call?: CallTool
  cellId: string | null
  runId?: string | null
  collapsible?: boolean
}) {
  const usage = useBookUsage({
    bookId,
    ready: Boolean(call) && Boolean(cellId || runId),
    call: call ?? unavailable,
    cellId,
    runId,
  })
  const run = runId && usage.snapshot?.run?.id === runId ? usage.snapshot.run : null
  const cell = cellId && usage.snapshot?.cell?.id === cellId ? usage.snapshot.cell : null
  const runIsCell = Boolean(run && cell && run.totals.count === cell.totals.count
    && run.calls.every((entry) => entry.cellId === cellId))
  if (!run && !cell) return null
  return (
    <div className="usage-cost-scopes">
      {run && <UsageCostSummary label="Run cost" totals={run.totals} calls={run.calls} collapsible={collapsible} />}
      {cell && !runIsCell && <UsageCostSummary label="Cell cost" totals={cell.totals} calls={run ? [] : cell.calls} collapsible={collapsible} />}
    </div>
  )
}
