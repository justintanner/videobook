import { Check, Loader2, TriangleAlert } from 'lucide-react'
import type { DeliveryStatusPhase, DeliveryStep, DeliveryStatusView } from '@/videobook/post-delivery-review'

const BUSY_PHASES: ReadonlySet<DeliveryStatusPhase> = new Set(['copying', 'uploading'])
const SETTLED_PHASES: ReadonlySet<DeliveryStatusPhase> = new Set(['saved-before', 'on-phone'])

function PhaseMark({ phase }: { phase: DeliveryStatusPhase }) {
  if (phase === 'error') return <TriangleAlert size={14} aria-hidden="true" className="delivery-status-mark-error" />
  if (SETTLED_PHASES.has(phase)) {
    return (
      <span className="delivery-status-mark-done" aria-hidden="true">
        <Check size={13} strokeWidth={3} />
      </span>
    )
  }
  return <span className={`delivery-status-dot${BUSY_PHASES.has(phase) ? ' delivery-status-dot-busy' : ''}`} aria-hidden="true" />
}

function StepMark({ step }: { step: DeliveryStep }) {
  if (step.state === 'done') return <Check size={12} aria-hidden="true" />
  if (step.state === 'active') return <Loader2 size={12} aria-hidden="true" className="delivery-status-spin" />
  if (step.state === 'failed') return <TriangleAlert size={12} aria-hidden="true" />
  return <span className="delivery-status-step-dot" aria-hidden="true" />
}

export function DeliveryStatus({ view }: { view: DeliveryStatusView }) {
  const busy = BUSY_PHASES.has(view.phase)
  const done = view.steps.filter(step => step.state === 'done').length
  const showSteps = busy || view.phase === 'error'
  return (
    <section className={`delivery-status delivery-status-${view.phase}`} aria-label="iPhone delivery status" aria-busy={busy}>
      <div className="delivery-status-head" role="status">
        <PhaseMark phase={view.phase} />
        <strong>{view.headline}</strong>
        <span className="delivery-status-count">{done}/{view.steps.length}</span>
      </div>
      <div className="delivery-status-track" aria-hidden="true">
        {view.steps.map(step => <span key={step.label} className={`delivery-status-segment delivery-status-segment-${step.state}`} />)}
      </div>
      {showSteps && (
        <ol className="delivery-status-steps">
          {view.steps.map(step => (
            <li key={step.label} className={`delivery-status-step delivery-status-step-${step.state}`}>
              <StepMark step={step} />
              <span>{step.label}</span>
            </li>
          ))}
        </ol>
      )}
      {view.detail && <small className="delivery-status-detail">{view.detail}</small>}
    </section>
  )
}
