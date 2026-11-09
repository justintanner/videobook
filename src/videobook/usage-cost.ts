import type { UsageEntry, UsageRollupTotals } from 'videobook-engine'
import { formatUsageCost, formatUsageTokens } from './book-usage'

export type UsageCallState = 'estimate' | 'awaiting-bill' | 'stated' | 'derived' | 'usage-only' | 'free' | 'not-billed' | 'unavailable'

export interface UsageCallFigures {
  state: UsageCallState
  label: string
  amount: string | null
  estimate: string | null
  note: string | null
}

export interface UsageTotalFigures {
  actual: string | null
  estimate: string | null
  partial: string | null
  pending: string | null
}

const FAL_HISTORICAL_ESTIMATE_SOURCE = 'fal-historical-average'

const STATE_LABELS: Record<UsageCallState, string> = {
  estimate: 'Estimate',
  'awaiting-bill': 'Awaiting bill',
  stated: 'Billed',
  derived: 'Calculated',
  'usage-only': 'Usage only',
  free: 'Free',
  'not-billed': 'Failed, not billed',
  unavailable: 'Unavailable',
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

function usageAmount(entry: UsageEntry): string | null {
  const tokens = (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0)
  if (entry.inputTokens !== null || entry.outputTokens !== null) return `${formatUsageTokens(tokens, true)} tokens`
  if (entry.units !== null && entry.unit) return `${formatUsageTokens(entry.units, true)} ${entry.unit}`
  return null
}

function awaitingFalBill(entry: UsageEntry): boolean {
  return entry.status === 'completed'
    && entry.actualBasis !== 'stated'
    && entry.actualBasis !== 'derived'
    && entry.actualBasis !== 'usage-only'
    && entry.warnings.some((warning) => warning.includes('omitted x-fal-billable-units'))
}

function callState(entry: UsageEntry): UsageCallState {
  if (entry.basis === 'free') return entry.status === 'failed' ? 'not-billed' : 'free'
  if (awaitingFalBill(entry)) return 'awaiting-bill'
  if (entry.status === 'pending') return 'estimate'
  if (entry.costUsd !== null && (entry.actualBasis === 'stated' || (entry.actualBasis === null && entry.basis === 'reported'))) return 'stated'
  if (entry.costUsd !== null && entry.basis === 'estimated'
    && (entry.actualBasis === 'derived' || (entry.actualBasis === null && (entry.inputTokens !== null || entry.outputTokens !== null)))) return 'derived'
  if (entry.actualBasis === 'usage-only') return 'usage-only'
  if (entry.estimateUsd !== null || (entry.costUsd !== null && entry.basis === 'estimated')) return 'estimate'
  return 'unavailable'
}

function reason(entry: UsageEntry, fallback: string): string {
  return entry.warnings.length > 0 ? entry.warnings.join(' ') : fallback
}

function callNote(state: UsageCallState, entry: UsageEntry): string | null {
  switch (state) {
    case 'free':
      return reason(entry, 'The provider charges nothing for this call')
    case 'not-billed':
      return reason(entry, 'The provider billed nothing for this failed call')
    case 'unavailable':
      return reason(entry, entry.status === 'uncertain' ? 'The provider outcome is unknown' : 'No price for this call')
    case 'usage-only':
      return [usageAmount(entry), 'no rate to price it'].filter(Boolean).join(', ')
    case 'awaiting-bill':
      return reason(entry, 'Awaiting fal\'s billed units')
    case 'estimate':
      if (entry.status === 'pending') {
        return entry.estimateSource === FAL_HISTORICAL_ESTIMATE_SOURCE
          ? 'Per-call average, not this request\'s price'
          : 'Waiting for the actual'
      }
      return entry.warnings.length > 0 ? entry.warnings.join(' ') : 'No billed or calculated figure'
    case 'stated':
      return entry.listUsd !== null && entry.costUsd !== null && Math.abs(entry.listUsd - entry.costUsd) >= 0.005
        ? `${formatUsageCost(entry.listUsd)} list price before credits`
        : 'As the provider billed it'
    case 'derived': {
      const priced = [usageAmount(entry), 'priced at the bundled rate'].filter(Boolean).join(', ')
      return entry.estimateSource === FAL_HISTORICAL_ESTIMATE_SOURCE
        ? `${priced}. est. is a per-call average, not this request's price`
        : priced
    }
  }
}

export function usageCallFigures(entry: UsageEntry): UsageCallFigures {
  const state = callState(entry)
  const quote = entry.estimateUsd ?? (state === 'estimate' && entry.basis === 'estimated' ? entry.costUsd : null)
  const amount = state === 'stated' ? formatUsageCost(entry.costUsd ?? 0)
    : state === 'derived' ? `~${formatUsageCost(entry.costUsd ?? 0)}`
      : state === 'free' || state === 'not-billed' ? formatUsageCost(0)
        : (state === 'estimate' || state === 'awaiting-bill') && quote !== null ? `~${formatUsageCost(quote)}` : null
  return {
    state,
    label: STATE_LABELS[state],
    amount,
    estimate: state !== 'estimate' && state !== 'awaiting-bill' && quote !== null ? formatUsageCost(quote) : null,
    note: callNote(state, entry),
  }
}

export function usageCallCountLabel(count: number): string {
  return plural(count, 'call')
}

export function usageNotBilledNote(calls: readonly UsageEntry[]): string | null {
  const failed = calls.filter((entry) => callState(entry) === 'not-billed')
  if (failed.length === 0) return null
  const reasons = [...new Set(failed.map((entry) => callNote('not-billed', entry)))]
  return `${plural(failed.length, 'call')} failed, not billed: ${reasons.join('; ')}`
}

function partialNote(totals: UsageRollupTotals): string | null {
  const settled = totals.count - totals.unsettled
  const parts = [
    totals.unsettled > 0 ? `${settled} of ${plural(totals.count, 'call')} settled` : null,
    totals.unpriced > 0 ? `${plural(totals.unpriced, 'call')} unpriced` : null,
  ].filter(Boolean)
  return parts.length > 0 ? `Partial: ${parts.join(', ')}` : null
}

export function usageTotalFigures(totals: UsageRollupTotals): UsageTotalFigures {
  const settledCount = totals.count - totals.unsettled
  return {
    actual: settledCount > 0 || totals.actualUsd > 0 ? `${totals.estimatedUsd > 0 ? '~' : ''}${formatUsageCost(totals.actualUsd)}` : null,
    estimate: totals.settledEstimateUsd > 0 ? formatUsageCost(totals.settledEstimateUsd) : null,
    partial: partialNote(totals),
    pending: totals.pendingCount > 0
      ? `${totals.pendingCount} in progress · ${formatUsageCost(totals.pendingEstimateUsd)} estimated, excluded from total`
      : null,
  }
}
