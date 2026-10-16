import { useEffect, useState, type ReactNode } from 'react'
import {
  notebookCellGenerationPhaseCount,
  type NotebookCellGenerationPhase,
} from '@/videobook/notebook-cell-presentation'
import { CellAnimatedBackground } from './CellAnimatedBackground'

const TICK_MS = 1000

const phaseSteps = Array.from(
  { length: notebookCellGenerationPhaseCount },
  (_, index) => index + 1,
)

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`
  return `${minutes}:${pad(seconds)}`
}

function phaseStepStatus(
  step: number,
  active: number,
): 'done' | 'active' | 'pending' {
  if (step < active) return 'done'
  return step === active ? 'active' : 'pending'
}

function CellPhaseRail({ phase }: { phase: NotebookCellGenerationPhase }) {
  return (
    <div className="cell-state-phase">
      <div className="cell-state-phase-rail" aria-hidden="true">
        {phaseSteps.map((step) => (
          <span
            key={step}
            className="cell-state-phase-step"
            data-status={phaseStepStatus(step, phase.step)}
          />
        ))}
      </div>
      <div className="cell-state-phase-label">
        <span>{phase.label}</span>
        <span>{phase.step}/{notebookCellGenerationPhaseCount}</span>
      </div>
    </div>
  )
}

export function CellClockOverlay({
  icon,
  label,
  address,
  startedAt,
  variant,
  meta = null,
  phase = null,
}: {
  icon: ReactNode
  label: string
  address: string
  startedAt: number | null
  variant?: 'rise' | 'stream'
  meta?: string | null
  phase?: NotebookCellGenerationPhase | null
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
      aria-label={`@${address} ${label.toLowerCase()}`}
      aria-live="polite"
    >
      <CellAnimatedBackground variant={variant} />
      <div className="cell-state-overlay-body cell-state-clock-body">
        <div className="cell-state-clock-row">
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
        {meta && <span className="cell-state-meta" title={meta}>{meta}</span>}
        {phase && <CellPhaseRail phase={phase} />}
      </div>
    </div>
  )
}
