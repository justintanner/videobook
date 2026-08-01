import { useEffect, useState, type ReactNode } from 'react'
import { CellAnimatedBackground } from './CellAnimatedBackground'

const TICK_MS = 250

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`
  return `${minutes}:${pad(seconds)}`
}

export function CellClockOverlay({
  icon,
  label,
  slug,
  startedAt,
  variant,
}: {
  icon: ReactNode
  label: string
  slug: string
  startedAt: number | null
  variant?: 'rise' | 'stream'
}) {
  const [fallbackStart] = useState(() => Date.now())
  const effectiveStart = startedAt ?? fallbackStart
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  const elapsedLabel = formatElapsed(Math.max(0, now - effectiveStart))

  return (
    <div
      className="cell-state-overlay cell-state-overlay-clock"
      role="status"
      aria-label={`@${slug} ${label.toLowerCase()}`}
      aria-live="polite"
    >
      <CellAnimatedBackground variant={variant} />
      <div className="cell-state-overlay-body">
        <span className="cell-state-overlay-icon" aria-hidden="true">
          {icon}
        </span>
        <div className="cell-state-overlay-copy">
          <strong>{label}</strong>
          <span className="cell-state-timer" aria-hidden="true">
            {elapsedLabel}
          </span>
        </div>
      </div>
    </div>
  )
}
