import { useId } from 'react'
import { Check, CircleAlert, LoaderCircle, RotateCcw } from 'lucide-react'
import type { GoalStepKey, GoalStepTone, GoalStepView } from '@/videobook/goal-next'
import type { ShortView } from '@/videobook/goals'
import type { AssetRecord } from '@/videobook/workspace-responses'

type Props = {
  steps: readonly GoalStepView[]
  view: ShortView
  resolveAsset: (artifactId: string) => AssetRecord | null
  onView: (view: GoalStepKey) => void
}

function thumbnailUrl(asset: AssetRecord | null): string | null {
  if (!asset) return null
  return asset.type === 'video' ? asset.thumbnailUrl ?? null : asset.thumbnailUrl ?? asset.mediaUrl ?? null
}

function StepMark({ tone }: { tone: GoalStepTone }) {
  if (tone === 'done') return <Check size={11} strokeWidth={3} aria-hidden="true" />
  if (tone === 'failed') return <CircleAlert size={11} aria-hidden="true" />
  if (tone === 'stale') return <RotateCcw size={11} aria-hidden="true" />
  if (tone === 'busy') return <LoaderCircle size={11} className="goal-step-spin" aria-hidden="true" />
  return <i className="goal-step-dot" aria-hidden="true" />
}

export function GoalStepStrip({ steps, view, resolveAsset, onView }: Props) {
  const id = useId()
  return <nav className="goal-steps" aria-label="Goal steps">
    <ol>{steps.map(step => {
      const url = step.artifactId ? thumbnailUrl(resolveAsset(step.artifactId)) : null
      const statusId = `${id}${step.key}`
      return <li key={step.key}>
        <button type="button" className="goal-step" data-tone={step.tone} aria-current={view === step.key ? 'step' : undefined}
          aria-label={step.name} aria-describedby={statusId} onClick={() => onView(step.key)}>
          <span className="goal-step-thumb" aria-hidden="true">{url && <img src={url} alt="" />}</span>
          <span className="goal-step-text">
            <span className="goal-step-name">{step.name}</span>
            <span className="goal-step-status" id={statusId}><StepMark tone={step.tone} /><span>{step.status}</span></span>
          </span>
        </button>
      </li>
    })}</ol>
  </nav>
}
