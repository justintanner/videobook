import { useEffect, useId, useRef } from 'react'
import type { UsageEntry } from 'videobook-engine'
import type { BookUsageSnapshot } from '@/videobook/book-usage'
import { formatUsageCost, formatUsageTokens, usageActivityLabels, usageCostLabel } from '@/videobook/book-usage'
import './BookUsageCounter.css'

type Props = {
  bookName: string
  enabled: boolean
  snapshot: BookUsageSnapshot | null
  stale: boolean
  onRetry: () => void
}

function entryCost(entry: UsageEntry): string {
  if (entry.costUsd === null || (entry.status !== 'completed' && entry.basis !== 'reported' && entry.inputTokens === null && entry.outputTokens === null)) return 'Unpriced'
  return `${entry.basis === 'estimated' ? '~' : ''}${formatUsageCost(entry.costUsd)}`
}

function useUsagePopover() {
  const id = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = () => {
    if (!buttonRef.current || !panelRef.current) return
    const bounds = buttonRef.current.getBoundingClientRect()
    const top = Math.min(bounds.bottom + 8, window.innerHeight - 100)
    panelRef.current.style.top = `${top}px`
    panelRef.current.style.maxHeight = `${Math.max(80, window.innerHeight - top - 12)}px`
  }
  useEffect(() => {
    window.addEventListener('resize', position)
    return () => window.removeEventListener('resize', position)
  }, [])
  return { id, buttonRef, panelRef, position }
}

export function BookUsageCounter({ bookName, enabled, snapshot, stale, onRetry }: Props) {
  const { id, buttonRef, panelRef, position } = useUsagePopover()
  const totals = snapshot?.totals
  const tokens = totals ? formatUsageTokens(totals.inputTokens + totals.outputTokens) : '—'
  const cost = totals ? usageCostLabel(totals) : '— cost'
  const partial = !!totals && (totals.unpriced > 0 || totals.missingTokens > 0 || snapshot?.incomplete)
  const activities = [...new Set(snapshot?.groups.map((group) => group.activity) ?? [])]
  return (
    <div className="book-usage" data-composer-focus="preserve">
      <button ref={buttonRef} type="button" className="book-usage-trigger" popoverTarget={id} disabled={!enabled}
        aria-label={`Book usage: ${tokens} tokens, ${cost}${stale ? ', stale' : partial ? ', incomplete' : ''}`}
        title="Tokens and cost for this book">
        <span>{tokens}<small> tokens</small></span>
        <span className="book-usage-divider" aria-hidden="true">·</span>
        <span>{cost}</span>
        {(stale || partial) && <span className="book-usage-indicator" aria-hidden="true" />}
      </button>
      <div ref={panelRef} id={id} popover="auto" role="dialog" aria-label="Book usage" className="book-usage-popover" onToggle={position}>
        <header><div><h2>Book usage</h2><p>{bookName}</p></div><button type="button" popoverTarget={id} popoverTargetAction="hide" aria-label="Close book usage">×</button></header>
        {stale && <p className="book-usage-notice">Usage may be out of date. <button type="button" onClick={onRetry}>Retry</button></p>}
        {!snapshot ? <p className="book-usage-empty">{stale ? 'Usage is unavailable.' : 'Loading usage…'}</p> : <>
          <div className="book-usage-totals">
            <div><small>Reported tokens</small><strong>{formatUsageTokens(snapshot.totals.inputTokens + snapshot.totals.outputTokens, true)}</strong></div>
            <div><small>Known cost · USD</small><strong>{usageCostLabel(snapshot.totals)}</strong></div>
          </div>
          <dl className="book-usage-facts">
            <div><dt>Input / output</dt><dd>{formatUsageTokens(snapshot.totals.inputTokens, true)} / {formatUsageTokens(snapshot.totals.outputTokens, true)}</dd></div>
            <div><dt>Cached input <small>(included)</small></dt><dd>{formatUsageTokens(snapshot.totals.cachedTokens, true)}</dd></div>
            <div><dt>Reported charges</dt><dd>{formatUsageCost(snapshot.totals.reportedUsd)}</dd></div>
            <div><dt>Estimated charges</dt><dd>{formatUsageCost(snapshot.totals.estimatedUsd)}</dd></div>
          </dl>
          {partial && <p className="book-usage-notice">{snapshot.totals.unpriced > 0 && `${snapshot.totals.unpriced} ${snapshot.totals.unpriced === 1 ? 'request has an unavailable price' : 'requests have unavailable prices'}. `}{snapshot.totals.missingTokens > 0 && `${snapshot.totals.missingTokens} ${snapshot.totals.missingTokens === 1 ? 'request has' : 'requests have'} missing token counts. `}{snapshot.incomplete && 'Some usage could not be recorded.'}</p>}
          {snapshot.totals.pendingCount > 0 && <p className="book-usage-pending">{snapshot.totals.pendingCount} in progress · {formatUsageCost(snapshot.totals.pendingUsd)} estimated, excluded from total</p>}
          <section aria-label="Usage by activity" className="book-usage-breakdown">
            {activities.map((activity) => {
              const groups = snapshot.groups.filter((group) => group.activity === activity)
              const usd = groups.reduce((sum, group) => sum + group.reportedUsd + group.estimatedUsd, 0)
              const unpriced = groups.reduce((sum, group) => sum + group.unpriced, 0)
              const estimated = groups.some((group) => group.estimatedUsd > 0)
              return <details key={activity}><summary><span>{usageActivityLabels[activity]}</span><span>{usd === 0 && unpriced ? 'Unpriced' : `${estimated ? '~' : ''}${formatUsageCost(usd)}`}</span></summary>
                {groups.map((group) => <div key={`${group.provider}:${group.model}`} className="book-usage-model"><div><strong>{group.model}</strong><small>{group.provider} · {group.count} requests · {formatUsageTokens(group.inputTokens + group.outputTokens)} tokens</small></div><span>{usageCostLabel(group)}</span></div>)}
              </details>
            })}
          </section>
          {snapshot.recent.length > 0 ? <section className="book-usage-recent" aria-label="Recent usage"><h3>Recent usage</h3>{snapshot.recent.map((entry) => <div key={entry.id}><div><strong>{entry.model}</strong><small>{usageActivityLabels[entry.activity]} · {entry.status} · {new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{entry.units !== null && entry.unit && ` · ${formatUsageTokens(entry.units)} ${entry.unit}`}</small></div><span>{entry.status === 'pending' ? 'Pending' : entryCost(entry)}</span></div>)}</section> : <p className="book-usage-empty">New AI activity will appear here.</p>}
          <footer>Tracked since {new Date(snapshot.trackedSince).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.<br />Estimates use recorded provider rates. Earlier usage is not included.</footer>
        </>}
      </div>
    </div>
  )
}
