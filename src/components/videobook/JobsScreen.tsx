import { useMemo, useState } from 'react'
import {
  Activity,
  Ban,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Square,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { NotebookCell } from 'videobook-engine'
import {
  buildJobsRows,
  countJobsBands,
  filterJobsBands,
  groupJobsRows,
  type JobsBand,
  type JobsCounts,
  type JobsFilter,
  type JobsRow,
  type JobsRowAction,
  type JobsRowTone,
  type JobsScreenJob,
  type JobsScreenPlan,
  type JobsScreenAsset,
} from '@/videobook/jobs-presentation'

const FINISHED_PREVIEW_COUNT = 10

type JobsPlanRevision = 'retry' | 'switch' | 'omit'

interface JobsScreenProps {
  bookName: string | null
  jobs: JobsScreenJob[]
  plans: JobsScreenPlan[]
  assets: JobsScreenAsset[]
  cells: NotebookCell[]
  now: number
  busy: boolean
  onRefresh: () => void
  onCancelJob: (jobId: number) => void
  onRetryJob: (jobId: number) => void
  onContinuePlan: (planId: string) => void
  onRevisePlan: (planId: string, action: JobsPlanRevision) => void
}

const TONE_ICONS: Record<JobsRowTone, LucideIcon> = {
  review: CircleAlert,
  failed: CircleX,
  running: LoaderCircle,
  queued: Clock,
  done: CircleCheck,
  cancelled: Ban,
  omitted: X,
}

const ACTION_LABELS: Record<JobsRowAction, string> = {
  continue: 'Continue',
  retry: 'Retry',
  switch: 'Switch model',
  omit: 'Omit',
  cancel: 'Cancel',
}

const ACTION_ICONS: Partial<Record<JobsRowAction, LucideIcon>> = {
  retry: RotateCcw,
  cancel: Square,
}

const PRIMARY_ACTIONS = new Set<JobsRowAction>(['continue', 'retry'])

const FILTERS: Array<{ id: JobsFilter; label: string; count: keyof JobsCounts | null }> = [
  { id: 'all', label: 'All', count: null },
  { id: 'attention', label: 'Attention', count: 'attention' },
  { id: 'active', label: 'Active', count: 'active' },
  { id: 'finished', label: 'Finished', count: 'finished' },
]

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString()
}

function JobsFilterButton({
  filter,
  active,
  count,
  onSelect,
}: {
  filter: (typeof FILTERS)[number]
  active: boolean
  count: number | null
  onSelect: (filter: JobsFilter) => void
}) {
  return (
    <button
      type="button"
      className="jobs-filter"
      aria-pressed={active}
      onClick={() => onSelect(filter.id)}
    >
      {filter.count && <span className={`jobs-filter-dot jobs-filter-dot-${filter.id}`} aria-hidden="true" />}
      {filter.label}
      {count !== null && <span className="jobs-filter-count">{count}</span>}
    </button>
  )
}

function JobsBandHeader({
  band,
  hidden,
  showAll,
  onToggleShowAll,
}: {
  band: JobsBand
  hidden: number
  showAll: boolean
  onToggleShowAll: () => void
}) {
  const hasFailures = band.rows.some((row) => row.tone === 'failed')
  const className = `jobs-band-header jobs-band-header-${band.id}${hasFailures ? ' jobs-band-has-failed' : ''}`
  return (
    <div className={className}>
      <span className="jobs-band-label">{band.label}</span>
      <span className="jobs-band-count">{band.rows.length}</span>
      <span className="jobs-band-rule" aria-hidden="true" />
      {(hidden > 0 || showAll) && band.rows.length > FINISHED_PREVIEW_COUNT && (
        <button type="button" className="jobs-band-more" onClick={onToggleShowAll}>
          {showAll
            ? `showing all ${band.rows.length} · Show fewer`
            : `showing ${band.rows.length - hidden} of ${band.rows.length} · Show all`}
        </button>
      )}
    </div>
  )
}

function JobsRowActions({
  row,
  busy,
  expanded,
  onAction,
  onToggleDetails,
}: {
  row: JobsRow
  busy: boolean
  expanded: boolean
  onAction: (row: JobsRow, action: JobsRowAction) => void
  onToggleDetails: (key: string) => void
}) {
  const hasDetails = row.tone === 'failed' && row.errorDetail !== null
  return (
    <div className="jobs-cell jobs-cell-actions">
      {row.actions.map((action) => {
        const Icon = ACTION_ICONS[action]
        return (
          <button
            key={action}
            type="button"
            className={PRIMARY_ACTIONS.has(action) ? 'jobs-action jobs-action-primary' : 'jobs-action'}
            disabled={busy}
            onClick={() => onAction(row, action)}
          >
            {Icon && <Icon size={12} aria-hidden="true" />}
            {ACTION_LABELS[action]}
          </button>
        )
      })}
      {hasDetails && (
        <button
          type="button"
          className="jobs-action"
          aria-expanded={expanded}
          onClick={() => onToggleDetails(row.key)}
        >
          Details
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      )}
      {row.actions.length === 0 && !hasDetails && row.duration && (
        <span className="jobs-duration">{row.duration}</span>
      )}
    </div>
  )
}

function JobsRowView({
  row,
  busy,
  expanded,
  onAction,
  onToggleDetails,
}: {
  row: JobsRow
  busy: boolean
  expanded: boolean
  onAction: (row: JobsRow, action: JobsRowAction) => void
  onToggleDetails: (key: string) => void
}) {
  const Icon = TONE_ICONS[row.tone]
  return (
    <article className={`jobs-row jobs-row-${row.tone}`}>
      <div className="jobs-cell jobs-cell-status">
        <Icon size={14} className={row.tone === 'running' ? 'jobs-spin' : undefined} aria-hidden="true" />
        {row.statusLabel}
      </div>
      <div className="jobs-cell jobs-cell-job">
        <span>{row.title}</span>
        {row.detail && <code>{row.detail}</code>}
      </div>
      <div className="jobs-cell jobs-cell-target">
        <code className={row.target.tag ? 'jobs-tag' : 'jobs-tag jobs-tag-book'}>{row.target.tag ?? 'BOOK'}</code>
        {row.target.label && <span>{row.target.label}</span>}
      </div>
      <div className="jobs-cell jobs-cell-summary">
        <div className="jobs-summary-line">
          {row.errorCode && <code className="jobs-error-code">{row.errorCode}</code>}
          <span className="jobs-summary-text">
            {row.summary}
            {row.note && <span className="jobs-summary-note"> · {row.note}</span>}
          </span>
        </div>
        {row.live && <div className="jobs-progress" aria-hidden="true"><span /></div>}
      </div>
      <div className="jobs-cell jobs-cell-attempt">{row.attempt}</div>
      <div className="jobs-cell jobs-cell-time">
        <time dateTime={new Date(row.timestamp).toISOString()}>{formatClock(row.timestamp)}</time>
      </div>
      <JobsRowActions
        row={row}
        busy={busy}
        expanded={expanded}
        onAction={onAction}
        onToggleDetails={onToggleDetails}
      />
      {expanded && row.errorDetail && (
        <div className="jobs-row-error">
          <span>Error</span>
          <pre>{row.errorDetail}</pre>
        </div>
      )}
    </article>
  )
}

function toggleKey(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(keys)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

export function JobsScreen({
  bookName,
  jobs,
  plans,
  assets,
  cells,
  now,
  busy,
  onRefresh,
  onCancelJob,
  onRetryJob,
  onContinuePlan,
  onRevisePlan,
}: JobsScreenProps) {
  const [filter, setFilter] = useState<JobsFilter>('all')
  const [showAllFinished, setShowAllFinished] = useState(false)
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set())

  const bands = useMemo(
    () => groupJobsRows(buildJobsRows({ jobs, plans, cells, assets, now })),
    [assets, cells, jobs, now, plans],
  )
  const counts = useMemo(() => countJobsBands(bands), [bands])
  const visibleBands = useMemo(() => filterJobsBands(bands, filter), [bands, filter])

  const handleAction = (row: JobsRow, action: JobsRowAction) => {
    if (row.source.kind === 'job') {
      if (action === 'cancel') onCancelJob(row.source.jobId)
      if (action === 'retry') onRetryJob(row.source.jobId)
      return
    }
    if (action === 'continue') onContinuePlan(row.source.planId)
    if (action === 'retry' || action === 'switch' || action === 'omit') onRevisePlan(row.source.planId, action)
  }

  const handleToggleDetails = (key: string) => {
    setExpandedKeys((keys) => toggleKey(keys, key))
  }

  return (
    <section className="workspace-screen jobs-screen">
      <header>
        <div className="jobs-header-title">
          <h1>Jobs</h1>
          <span className="jobs-header-meta">
            {bookName ?? 'No book selected'} · {counts.total} {counts.total === 1 ? 'job' : 'jobs'} · updated {formatClock(now)}
          </span>
          <div className="jobs-filters" aria-label="Filter jobs">
            {FILTERS.map((entry) => (
              <JobsFilterButton
                key={entry.id}
                filter={entry}
                active={filter === entry.id}
                count={entry.count ? counts[entry.count] : null}
                onSelect={setFilter}
              />
            ))}
          </div>
        </div>
        <button type="button" className="jobs-refresh" disabled={busy} onClick={onRefresh}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </header>

      {counts.total === 0 && (
        <div className="jobs-empty">
          <Activity size={16} aria-hidden="true" />
          <strong>No jobs recorded</strong>
          <span>Run a cell or a notebook to queue work.</span>
        </div>
      )}

      {counts.total > 0 && visibleBands.length === 0 && (
        <div className="jobs-empty">
          <span>No jobs match this filter.</span>
        </div>
      )}

      {visibleBands.length > 0 && (
        <div className="jobs-list">
          <div className="jobs-columns" aria-hidden="true">
            <span>Status</span>
            <span>Job</span>
            <span>Target</span>
            <span>Progress / result</span>
            <span className="jobs-columns-attempt">Try</span>
            <span>Enqueued</span>
            <span>Actions</span>
          </div>
          {visibleBands.map((band) => {
            const collapsed = band.id === 'finished' && !showAllFinished
            const rows = collapsed ? band.rows.slice(0, FINISHED_PREVIEW_COUNT) : band.rows
            return (
              <div className="jobs-band" key={band.id}>
                <JobsBandHeader
                  band={band}
                  hidden={band.rows.length - rows.length}
                  showAll={band.id === 'finished' && showAllFinished}
                  onToggleShowAll={() => setShowAllFinished((value) => !value)}
                />
                {rows.map((row) => (
                  <JobsRowView
                    key={row.key}
                    row={row}
                    busy={busy}
                    expanded={expandedKeys.has(row.key)}
                    onAction={handleAction}
                    onToggleDetails={handleToggleDetails}
                  />
                ))}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
