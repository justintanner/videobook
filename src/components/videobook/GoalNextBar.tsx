import { ChevronRight } from 'lucide-react'
import type { GoalNextAction, GoalStepKey } from '@/videobook/goal-next'
import type { ShortView } from '@/videobook/goals'

type GenerateNext = Extract<GoalNextAction, { kind: 'generate' }>
export type GoalNextHandlers = {
  onGo: (step: GoalStepKey) => void
  onGenerate: (next: GenerateNext) => void
  onWindow: () => void
  onFinish: () => void
  onRetry: () => void
  onStop: () => void
  onPause: () => void
  onSave: () => void
  onRunRest: (() => void) | null
}
type Props = {
  next: GoalNextAction
  view: ShortView
  names: Record<GoalStepKey, string>
  disabled: boolean
  dirty: boolean
  canSave: boolean
  revising: string | null
  handlers: GoalNextHandlers
}
type Tone = 'next' | 'busy' | 'failed' | 'done' | 'quiet'

const LABELS: Record<GoalNextAction['kind'], string> = { busy: 'Working', retry: 'Failed', recipe: 'Next', generate: 'Next', window: 'Next', finish: 'Next', done: 'Done', stopped: 'Stopped' }

function failedNext(next: GoalNextAction): boolean {
  return next.kind === 'retry' || (next.kind === 'recipe' || next.kind === 'finish') && next.failed
}

function toneOf(next: GoalNextAction): Tone {
  if (failedNext(next)) return 'failed'
  if (next.kind === 'busy') return 'busy'
  if (next.kind === 'done') return 'done'
  return next.kind === 'stopped' ? 'quiet' : 'next'
}

function blockedReason(next: GoalNextAction): string | null {
  return next.kind === 'generate' || next.kind === 'window' || next.kind === 'finish' ? next.blocked : null
}

function NextActions({ next, here, names, disabled, dirty, handlers }: { next: GoalNextAction, here: boolean, names: Record<GoalStepKey, string>, disabled: boolean, dirty: boolean, handlers: GoalNextHandlers }) {
  const go = <button type="button" className="goal-panel-primary" onClick={() => handlers.onGo(next.step)}>Go to {names[next.step]}<ChevronRight size={13} aria-hidden="true" /></button>
  const blocked = disabled || Boolean(blockedReason(next))
  if (next.kind === 'busy') {
    return <>
      {next.pause && <button type="button" className="goal-panel-button" disabled={disabled} onClick={handlers.onPause}>Pause</button>}
      {next.stop && <button type="button" className="goal-panel-button" disabled={disabled} onClick={handlers.onStop}>{next.stop}</button>}
    </>
  }
  if (next.kind === 'retry') return <button type="button" className="goal-panel-primary" disabled={disabled} onClick={handlers.onRetry}>Retry</button>
  if (next.kind === 'stopped' || next.kind === 'recipe' && here) return null
  if (!here) return go
  if (next.kind === 'generate') return <button type="button" className="goal-panel-primary" disabled={blocked} onClick={() => handlers.onGenerate(next)}>{next.label} · {next.price}</button>
  if (next.kind === 'window') return <button type="button" className="goal-panel-primary" disabled={blocked} onClick={handlers.onWindow}>Use this window</button>
  if (next.kind === 'finish') return <button type="button" className="goal-panel-primary" disabled={blocked} onClick={handlers.onFinish}>Finish</button>
  return <button type="button" className="goal-panel-button" disabled={disabled || dirty} onClick={handlers.onFinish}>Finish again</button>
}

export function GoalNextBar({ next, view, names, disabled, dirty, canSave, revising, handlers }: Props) {
  if (revising) {
    return <div className="goal-panel-bar goal-next" data-tone="busy">
      <p className="goal-next-copy" role="status"><strong>Working</strong><span>Writing your feedback into {revising}, then generating…</span></p>
    </div>
  }
  const tone = toneOf(next)
  const detail = blockedReason(next) ?? next.detail
  const offerRest = handlers.onRunRest && (next.kind === 'generate' || next.kind === 'window' || next.kind === 'finish')
  return <div className="goal-panel-bar goal-next" data-tone={tone}>
    <p className="goal-next-copy" role={tone === 'failed' ? 'alert' : 'status'}>
      <strong>{failedNext(next) ? 'Failed' : LABELS[next.kind]}</strong>
      <span>{next.text}</span>
      {detail && <small>{detail}</small>}
    </p>
    <div className="goal-next-actions">
      {offerRest && <button type="button" className="goal-panel-button" disabled={disabled} onClick={handlers.onRunRest ?? undefined}>Run the rest…</button>}
      {dirty && <button type="button" className="goal-panel-button" disabled={disabled || !canSave} onClick={handlers.onSave}>Save</button>}
      <NextActions next={next} here={view === next.step} names={names} disabled={disabled} dirty={dirty} handlers={handlers} />
    </div>
  </div>
}
