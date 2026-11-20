import type { NotebookCell, NotebookEdge, UsageRollupGroup, UsageRollupTotals } from 'videobook-engine'
import { notebookGridTag } from 'videobook-engine/notebook-grid'
import { formatUsageCost } from './book-usage'
import { generationModelLabel, type GenerationAttemptRecord } from './output-generation'
import { usageTotalFigures } from './usage-cost'

export type TakeCostState = 'billed' | 'estimate' | 'awaiting-bill' | 'none'

export type TakeCost = { amount: string | null; state: TakeCostState }

export type GenerationTake = {
  attemptId: string
  outputCellId: string | null
  address: string | null
  model: string | null
  modelTitle: string | null
  status: string
  thumbnailUrl: string | null
  current: boolean
  cost: TakeCost
}

export type TakesTotal = { billed: string; pending: string | null }

type TakesContext = {
  cells: readonly NotebookCell[]
  outputCellId: string
  outputArtifactId: string | null
  runs: readonly UsageRollupGroup[]
}

function approximate(usd: number): string | null {
  return usd > 0 ? `~${formatUsageCost(usd)}` : null
}

/** One run's cost: billed once every call settled, otherwise the quote. */
function takeCost(totals: UsageRollupTotals | null): TakeCost {
  if (!totals || totals.count === 0) return { amount: null, state: 'none' }
  if (totals.unsettled === 0) return { amount: usageTotalFigures(totals).actual, state: 'billed' }
  if (totals.pendingCount > 0) {
    return { amount: approximate(totals.actualUsd + totals.pendingEstimateUsd), state: 'estimate' }
  }
  return { amount: approximate(Math.max(totals.estimateUsd, totals.actualUsd)), state: 'awaiting-bill' }
}

/** The producer's settled spend and what its runs in flight are quoted at. */
export function takesTotal(totals: UsageRollupTotals | null): TakesTotal | null {
  if (!totals || totals.count === 0) return null
  return {
    billed: usageTotalFigures(totals).actual ?? formatUsageCost(0),
    pending: totals.pendingCount > 0 ? approximate(totals.pendingEstimateUsd) : null,
  }
}

function currentTakeId(
  attempts: readonly GenerationAttemptRecord[],
  outputCellId: string,
  outputArtifactId: string | null,
): string | null {
  const made = outputArtifactId
    ? attempts.find((attempt) => attempt.status === 'completed' && attempt.artifactId === outputArtifactId)
    : undefined
  return (made ?? attempts.find((attempt) => attempt.outputCellId === outputCellId))?.attemptId ?? null
}

function takeCell(attempt: GenerationAttemptRecord, cells: readonly NotebookCell[]): NotebookCell | null {
  if (attempt.outputCellId) return cells.find((cell) => cell.id === attempt.outputCellId) ?? null
  if (!attempt.artifactId) return null
  return cells.find((cell) => cell.outputArtifactId === attempt.artifactId) ?? null
}

/** Every recorded run of a producer, newest first, with the output it made. */
export function generationTakes(
  attempts: readonly GenerationAttemptRecord[],
  context: TakesContext,
): GenerationTake[] {
  const currentId = currentTakeId(attempts, context.outputCellId, context.outputArtifactId)
  const runs = new Map(context.runs.map((run) => [run.id, run]))
  return [...attempts]
    .sort((left, right) => right.startedAt - left.startedAt)
    .map((attempt) => {
      const cell = takeCell(attempt, context.cells)
      return {
        attemptId: attempt.attemptId,
        outputCellId: cell?.id ?? null,
        address: cell ? notebookGridTag(cell.slot) : null,
        model: generationModelLabel(attempt.model, attempt.provider),
        modelTitle: attempt.model,
        status: attempt.status,
        thumbnailUrl: attempt.thumbnailUrl,
        current: attempt.attemptId === currentId,
        cost: takeCost(attempt.runId ? runs.get(attempt.runId) ?? null : null),
      }
    })
}

function attemptStatusLabel(status: string, cost: TakeCost): string {
  if (status === 'failed') return 'Failed'
  if (status === 'dispatched') return 'Starting'
  if (status === 'awaiting_provider') return 'Generating'
  if (status !== 'completed') return status
  if (cost.state === 'billed') return 'Billed'
  return cost.state === 'none' ? 'Done' : 'Awaiting bill'
}

/** Status under a take's model, naming the take on screen. */
export function takeStatusText(take: GenerationTake, noun: 'clip' | 'image'): string {
  const label = attemptStatusLabel(take.status, take.cost)
  return take.current ? `This ${noun} · ${label.toLowerCase()}` : label
}

/** Changes when a producer gains an output or an output gets its media. */
export function producerOutputsSignature(
  producerId: string,
  cells: readonly NotebookCell[],
  edges: readonly NotebookEdge[],
): string {
  const artifacts = new Map(cells.map((cell) => [cell.id, cell.outputArtifactId ?? '']))
  return edges
    .filter((edge) => edge.source === producerId && (edge.targetInput === 'media' || edge.targetInput === 'output'))
    .map((edge) => `${edge.target}=${artifacts.get(edge.target) ?? ''}`)
    .sort()
    .join(',')
}
