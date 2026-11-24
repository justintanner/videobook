import type { ReactNode } from 'react'
import {
  notebookCellGenerationPhaseCount,
  type NotebookCellGenerationPhase,
} from '@/videobook/notebook-cell-presentation'
import { CellAnimatedBackground } from './CellAnimatedBackground'
import { useElapsedLabel } from './useElapsedLabel'

const phaseSteps = Array.from(
  { length: notebookCellGenerationPhaseCount },
  (_, index) => index + 1,
)

function phaseStepStatus(
  step: number,
  active: number,
): 'done' | 'active' | 'pending' {
  if (step < active) return 'done'
  return step === active ? 'active' : 'pending'
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
