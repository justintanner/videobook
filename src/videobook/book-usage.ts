import type { UsageEntry, UsageSummary, UsageTotals } from 'videobook-engine'

export type BookUsageSnapshot = UsageSummary & { recent: UsageEntry[]; incomplete: boolean }

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const exact = new Intl.NumberFormat('en-US')

export const usageActivityLabels: Record<UsageEntry['activity'], string> = {
  images: 'Images', video: 'Video', audio: 'Audio', chat: 'Chat', voice: 'Voice', analysis: 'Analysis & transcription',
}

export function formatUsageTokens(tokens: number, full = false): string {
  return (full ? exact : compact).format(tokens)
}

export function formatUsageCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function usageCostLabel(totals: UsageTotals): string {
  const usd = totals.reportedUsd + totals.estimatedUsd
  if (usd === 0 && totals.unpriced > 0) return '— cost'
  return `${totals.estimatedUsd > 0 ? '~' : ''}${formatUsageCost(usd)}`
}

export function parseBookUsage(value: unknown): BookUsageSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Usage is unavailable')
  const snapshot = value as Partial<BookUsageSnapshot>
  if (typeof snapshot.trackedSince !== 'number' || !snapshot.totals || !Array.isArray(snapshot.groups) || !Array.isArray(snapshot.recent)) throw new Error('Usage is unavailable')
  return snapshot as BookUsageSnapshot
}
