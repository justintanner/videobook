import { notebookCellIsActiveStatus } from '@/videobook/notebook-cell-presentation'

function runningStatusLabel(status: string): string {
  if (status === 'queued') return 'Queued'
  if (status === 'completing') return 'Finishing'
  if (status === 'awaiting-output') return 'Awaiting output'
  return 'Running'
}

export function CellRunningOverlay({
  slug,
  status,
}: {
  slug: string
  status: string
}) {
  if (!notebookCellIsActiveStatus(status)) return null

  return (
    <div
      className="cell-running-overlay"
      data-running-status={status}
      role="status"
      aria-label={`@${slug} ${runningStatusLabel(status).toLowerCase()}`}
      aria-live="polite"
    >
      <span className="cell-running-indicator" aria-hidden="true" />
      <strong>{runningStatusLabel(status)}</strong>
    </div>
  )
}
