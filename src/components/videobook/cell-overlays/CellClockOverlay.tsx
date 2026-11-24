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

function useElapsedLabel(startedAt: number | null): string {
  const [fallbackStart] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  return formatElapsed(Math.max(0, now - (startedAt ?? fallbackStart)))
}

function CellPhaseSteps({ phase }: { phase: NotebookCellGenerationPhase }) {
  return (
    <div className="cell-state-phase-rail" aria-hidden="true">
      {phaseSteps.map((step) => (
        <span
          key={step}
          className="cell-state-phase-step"
          data-status={phaseStepStatus(step, phase.step)}
        />
      ))}
    </div>
  )
}

function CellPhaseRail({ phase }: { phase: NotebookCellGenerationPhase }) {
  return (
    <div className="cell-state-phase">
      <CellPhaseSteps phase={phase} />
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
  phase = null,
  overPicture = false,
}: {
  icon: ReactNode
  label: string
  address: string
  startedAt: number | null
  variant?: 'rise' | 'stream'
  phase?: NotebookCellGenerationPhase | null
  overPicture?: boolean
}) {
  const elapsedLabel = useElapsedLabel(startedAt)

  return (
    <div
      className={`cell-state-overlay cell-state-overlay-clock${overPicture ? ' cell-state-overlay-over-picture' : ''}`}
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
          <span className="cell-state-timer" aria-hidden="true">
            {elapsedLabel}
          </span>
        </div>
        {phase && <CellPhaseRail phase={phase} />}
      </div>
    </div>
  )
}

export function CellClockDock({
  label,
  detail,
  address,
  startedAt,
  phase = null,
  waiting = false,
}: {
  label: string
  detail: string
  address: string
  startedAt: number | null
  phase?: NotebookCellGenerationPhase | null
  waiting?: boolean
}) {
  const elapsedLabel = useElapsedLabel(startedAt)

  return (
    <div
      className={`cell-state-dock cell-state-dock-clock${waiting ? ' cell-state-dock-waiting' : ''}`}
      role="status"
      aria-label={`@${address} ${label.toLowerCase()}`}
      aria-live="polite"
    >
      {phase
        ? <CellPhaseSteps phase={phase} />
        : <span className="cell-state-dock-bar" aria-hidden="true"><span /></span>}
      <span className="cell-state-dock-row">
        <span className="cell-state-dock-label">{detail}</span>
        <span className="cell-state-timer" aria-hidden="true">
          {elapsedLabel}
        </span>
      </span>
    </div>
  )
}
