import type { UsageEntry, UsageRollupTotals } from 'videobook-engine'
import { usageCallCountLabel, usageCallFigures, usageTotalFigures } from '@/videobook/usage-cost'
import './UsageCost.css'

export function UsageCallRow({ entry }: { entry: UsageEntry }) {
  const figures = usageCallFigures(entry)
  return (
    <li className={`usage-cost-call usage-cost-call-${figures.state}`}>
      <span className="usage-cost-call-model">{entry.model}</span>
      <span className="usage-cost-call-figure">
        <span className="usage-cost-basis">{figures.label}</span>
        {figures.amount && <strong>{figures.amount}</strong>}
        {figures.estimate && <small>est. {figures.estimate}</small>}
      </span>
      {figures.note && <small className="usage-cost-call-note">{figures.note}</small>}
    </li>
  )
}

type CallListProps = {
  label: string
  calls: readonly UsageEntry[]
}

function UsageCallList({ label, calls }: CallListProps) {
  return (
    <ol className="usage-cost-calls" aria-label={`${label} by call`}>
      {calls.map((entry) => <UsageCallRow key={entry.id} entry={entry} />)}
    </ol>
  )
}

function UsageCallDisclosure({ label, calls }: CallListProps) {
  return (
    <details className="usage-cost-details">
      <summary>{usageCallCountLabel(calls.length)}</summary>
      <UsageCallList label={label} calls={calls} />
    </details>
  )
}

type SummaryProps = {
  label: string
  totals: UsageRollupTotals | null | undefined
  calls?: readonly UsageEntry[]
  collapsible?: boolean
}

export function UsageCostSummary({ label, totals, calls = [], collapsible = false }: SummaryProps) {
  if (!totals || totals.count === 0) return null
  const figures = usageTotalFigures(totals)
  const CallList = collapsible ? UsageCallDisclosure : UsageCallList
  return (
    <section className={collapsible ? 'usage-cost usage-cost-collapsible' : 'usage-cost'} aria-label={label}>
      <div className="usage-cost-total">
        <span className="usage-cost-label">{label}</span>
        {figures.actual
          ? <strong>{figures.actual}</strong>
          : <span className="usage-cost-waiting">No settled cost yet</span>}
        {figures.estimate && <span className="usage-cost-estimate">est. {figures.estimate}</span>}
      </div>
      {figures.partial && <p className="usage-cost-partial" role="status">{figures.partial}</p>}
      {figures.pending && <p className="usage-cost-pending">{figures.pending}</p>}
      {calls.length > 0 && <CallList label={label} calls={calls} />}
    </section>
  )
}
