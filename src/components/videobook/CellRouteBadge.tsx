import type { ReactNode } from 'react'
import {
  ArrowRight,
  AudioLines,
  Circle,
  Diamond,
  Flag,
  Play,
  Sparkle,
} from 'lucide-react'
import type { NotebookCellFamily } from '@/videobook/notebook-cell-types'
import type {
  NotebookRouteBadge,
  NotebookRouteSegment,
} from '@/videobook/notebook-route-tags'

type CellRouteDirection = 'incoming' | 'outgoing'

function RouteFamilyIcon({ family }: { family: NotebookCellFamily }) {
  if (family === 'gen') return <Sparkle fill="currentColor" strokeWidth={0} />
  if (family === 'video') return <Play fill="currentColor" strokeWidth={0} />
  if (family === 'image') return <Diamond fill="currentColor" strokeWidth={0} />
  if (family === 'audio') return <AudioLines strokeWidth={2.6} />
  if (family === 'goal') return <Flag fill="currentColor" strokeWidth={2} />
  return <Circle fill="currentColor" strokeWidth={0} />
}

function RouteLead({ segment }: { segment: NotebookRouteSegment }) {
  if (segment.slots.length === 0) return <RouteFamilyIcon family={segment.family} />
  return segment.slots.map((slot) => (
    <span key={slot} className="cell-route-slot">{slot}</span>
  ))
}

function RouteSegment({ direction, segment }: {
  direction: CellRouteDirection
  segment: NotebookRouteSegment
}) {
  return (
    <span className="cell-route-segment" data-family={segment.family}>
      {direction === 'incoming' && <RouteLead segment={segment} />}
      <span className="cell-route-address">{segment.address}</span>
    </span>
  )
}

export function CellRouteBadge({ direction, badge, detail = null, detailLabel = null }: {
  direction: CellRouteDirection
  badge: NotebookRouteBadge | null
  detail?: ReactNode
  detailLabel?: string | null
}) {
  if (!badge && !detail) return null
  const label = [badge?.label, detailLabel].filter(Boolean).join(' · ')
  return (
    <span
      className={`cell-route-badge cell-route-badge-${direction}`}
      data-tone={direction === 'incoming' ? badge?.tone : undefined}
    >
      <span className="sr-only">{label}</span>
      <span className="cell-route-badge-frame" aria-hidden="true">
        <span className="cell-route-badge-fill">
          {direction === 'outgoing' && <ArrowRight className="cell-route-arrow" strokeWidth={3} />}
          {badge?.segments.map((segment) => (
            <RouteSegment key={segment.address} direction={direction} segment={segment} />
          ))}
          {badge && badge.hidden > 0 && <span className="cell-route-more">+{badge.hidden}</span>}
          {detail && <span className="cell-route-detail">{detail}</span>}
        </span>
      </span>
    </span>
  )
}
