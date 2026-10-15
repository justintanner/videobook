import { useRef, useState, type KeyboardEvent } from 'react'
import { Flag } from 'lucide-react'
import type { GoalPlan, GoalGenerationStage } from '../../../server/src/goal-plan'
import type { AssetRecord } from '@/videobook/workspace-responses'
import { formatGoalClock, goalCanRetry, goalOutputEstimate, goalPlansEqual, goalProgress, goalShotStateLabel, goalStageLabel, goalStatusLine, goalStopLabel, goalTileView, isStagedGoalPlan, planShots, type GoalShotView, type GoalSnapshot } from '@/videobook/goals'
import { useElapsedSeconds } from '@/videobook/use-elapsed-seconds'
import { ComposerDockClose } from '@/components/videobook/ComposerDockClose'
import { GoalReview } from './GoalReview'
import { GoalV3Review } from './GoalV3Review'
import { SimpleGoalReview } from './SimpleGoalReview'
import './GoalPanel.css'

type GoalAction = Record<string, unknown>
type GoalPanelProps = {
  goal: GoalSnapshot
  connected: boolean
  onAction: (args: GoalAction) => Promise<GoalSnapshot>
  onPreview: (startFrame: number) => Promise<void>
  onSelectCell: (cellId: string) => void
  onPreviewCell: (cellId: string) => void
  resolveAsset: (artifactId: string) => AssetRecord | null
}
function runWithShortcut(event: KeyboardEvent<HTMLElement>, primary: () => void) {
  if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return
  event.preventDefault()
  primary()
}

function GoalShotRow({ shot, onSelectCell }: { shot: GoalShotView, onSelectCell: (cellId: string) => void }) {
  const elapsed = useElapsedSeconds(shot.state === 'generating' ? shot.startedAt : null)
  const state = shot.state === 'generating' && elapsed !== null ? `Generating ${formatGoalClock(elapsed)}` : goalShotStateLabel(shot.state)
  return <li className="goal-progress-shot" data-state={shot.state}>
    <span className="goal-progress-number">{shot.number}</span><span className="goal-progress-title" title={shot.prompt}>{shot.title}</span>
    <span className="goal-progress-seconds">{shot.seconds > 0 ? `${shot.seconds}s` : 'Image'}</span>
    {shot.cellId && shot.address ? <button type="button" className="goal-progress-address" onClick={() => onSelectCell(shot.cellId!)}>{shot.address}</button> : <span aria-hidden="true">—</span>}
    <span className="goal-progress-state">{state}</span>{shot.error && <span className="goal-progress-error">{shot.error}</span>}
  </li>
}

function GoalStepper({ goal }: { goal: GoalSnapshot }) {
  const simple = isStagedGoalPlan(goal.plan) && goal.plan.storyboardLayout === 'six-panel'
  const current = simple ? goal.stage === 'frame' ? 0 : goal.stage === 'storyboards' ? 1 : 2 : goal.status === 'planning' ? 0 : goal.stage === 'frame' ? 1 : goal.stage === 'storyboards' ? 2 : goal.stage === 'videos' ? 3 : 4
  const labels = simple ? ['Scene', 'Storyboard', 'Video'] : ['Plan', 'Full frame', 'Storyboards', 'Videos', ...(planShots(goal.plan).length === 1 ? [] : ['Combine'])]
  return <ol className="goal-stepper" aria-label="Goal stages">{labels.map((label, index) => <li key={label} data-state={goal.status === 'completed' || index < current ? 'done' : index === current ? 'current' : 'pending'} aria-current={index === current ? 'step' : undefined}>{label}</li>)}</ol>
}

export function GoalPanel({ goal, connected, onAction, onPreview, onSelectCell, onPreviewCell, resolveAsset }: GoalPanelProps) {
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const progress = goalProgress(goal)
  const line = goalStatusLine(goal)
  const view = goalTileView(goal, goal.plan, undefined)
  const v3Plan = goal.plan && 'version' in goal.plan && goal.plan.version === 3 ? goal.plan : null
  const disabled = pending || !connected
  const simpleReview = isStagedGoalPlan(goal.plan) && (goal.plan.storyboardLayout === 'six-panel' || goal.status === 'completed') && ['review', 'completed', 'failed', 'interrupted'].includes(goal.status)
  const perform = async (work: () => Promise<unknown>) => {
    if (!connected || pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally {
      pendingRef.current = false
      setPending(false)
    }
  }
  const act = (args: GoalAction) => { void perform(() => onAction({ ...args, goal_id: goal.goalId })) }
  const reviewAction = (action: 'approve' | 'regenerate' | 'revise' | 'update', plan: GoalPlan, stage?: GoalGenerationStage, index?: number, feedback?: string) => {
    void perform(async () => {
      const current = isStagedGoalPlan(goal.plan) && !goalPlansEqual(plan, goal.plan)
        ? await onAction({ action: 'update', goal_id: goal.goalId, revision: goal.revision, plan }) : goal
      if (action !== 'update') await onAction({ action, goal_id: goal.goalId, revision: current.revision, ...(stage ? { stage, index } : {}), ...(feedback ? { feedback } : {}) })
    })
  }
  const active = goal.status === 'planning' || goal.status === 'running'
  const finished = ['completed', 'failed', 'interrupted', 'cancelled'].includes(goal.status)
  const complete = goal.status === 'completed'
  const retry = goalCanRetry(goal)
  const retryEstimates = goal.steps.filter(step => step.id !== 'assemble' && step.status !== 'completed').map(step => goalOutputEstimate(goal, progress.stage, progress.stage === 'frame' ? 0 : Number(/\d+$/u.exec(step.id)?.[0]) - 1))
  const retryCost = goal.chainId === null || retryEstimates.some(usd => usd === null) ? ' · estimate unavailable' : ` · $${retryEstimates.reduce<number>((sum, usd) => sum + (usd ?? 0), 0).toFixed(2)}`
  const primaryLabel = complete ? goal.assembly ? 'Preview sequence' : 'Open clip' : retry ? `Retry ${goal.chainId === null ? 'planning' : progress.stage === 'frame' ? 'frame' : progress.stage}${retryCost}` : null
  const primary = () => {
    if (disabled) return
    if (complete && goal.assembly) {
      void perform(() => onPreview(goal.assembly!.startFrame))
      return
    }
    if (complete) {
      const cellId = goal.stages.videos?.outputs[0]?.cellId ?? goal.steps.find(step => step.outputCellId)?.outputCellId
      if (cellId) onPreviewCell(cellId)
      return
    }
    act({ action: 'retry' })
  }
  return <div className="composer-notebook-dock inspector goal-panel" data-tone={line.tone}>
    <header>
      <span className="inspector-cell-title goal-panel-title"><Flag size={14} className="goal-panel-flag" /><strong>GOAL</strong>{goal.address && <code className="inspector-cell-address">{goal.address}</code>}<span className="goal-panel-name" title={view.title}>{view.title}</span><span className="goal-tile-chip" data-tone={view.chip.tone}>{view.chip.label}</span></span>
      <div className="inspector-header-actions"><div className="inspector-generation-header-actions">
        {progress.phase === 'review' && <button type="button" disabled={disabled} onClick={() => act({ action: 'cancel' })}>{v3Plan && goal.finish?.status === 'running' ? 'Stop finishing' : 'Discard goal'}</button>}
        {active && <button type="button" disabled={disabled} onClick={() => act({ action: 'cancel' })}>{goalStopLabel(goal)}</button>}
        {finished && <button type="button" disabled={disabled || Boolean(goal.dismissedAt)} onClick={() => act({ action: 'dismiss' })}>Dismiss</button>}
      </div><ComposerDockClose /></div>
    </header>
    <div className="goal-panel-body">
      {goal.planVersion === 2 && !simpleReview && <GoalStepper goal={goal} />}
      {v3Plan && goal.status !== 'planning' && <GoalV3Review key={`${goal.goalId}:${goal.revision}`} goal={goal} plan={v3Plan} disabled={disabled} resolveAsset={resolveAsset} onPreviewCell={onPreviewCell} onRun={work => { void perform(work) }} onAction={args => onAction({ ...args, goal_id: goal.goalId })} />}
      {!connected && <p role="status" className="goal-panel-muted">Reconnecting. Your goal is saved; generation continues on the server.</p>}
      {error && <p role="alert" className="goal-panel-error">{error}</p>}
      {goal.error && (progress.phase === 'failed' || progress.phase === 'interrupted') && <p role="alert" className="goal-panel-error">{goal.error}</p>}
      {goal.combined?.error && <p role="alert" className="goal-panel-error">{goal.combined.error}</p>}
      {progress.phase === 'planning' && <div className="goal-panel-planning"><p className="goal-panel-brief">{goal.brief}</p><p className="goal-panel-muted">{view.styleLabel === 'Match source' ? 'Planning the scene, storyboard and video from your references…' : view.styleLabel ? `Planning ${view.styleLabel === 'IG Influencer' ? 'an' : 'a'} ${view.styleLabel} sequence…` : 'Planning the scene, storyboard and video from your reference images…'}</p><span className="goal-tile-placeholder" aria-hidden="true"><i /><i /><i /></span></div>}
      {simpleReview && isStagedGoalPlan(goal.plan) && <SimpleGoalReview key={`${goal.goalId}:${goal.revision}:${goal.stage}`} goal={goal} plan={goal.plan} disabled={disabled} resolveAsset={resolveAsset} onPreviewCell={onPreviewCell} onSave={plan => reviewAction('update', plan)} onApprove={plan => reviewAction('approve', plan)} onRegenerate={(plan, stage, index) => reviewAction('regenerate', plan, stage, index)} onRevise={(plan, stage, index, feedback) => reviewAction('revise', plan, stage, index, feedback)} onSelect={(stage, index, artifactId) => act({ action: 'select', revision: goal.revision, stage, index, artifact_id: artifactId })} />}
      {!simpleReview && progress.phase === 'review' && isStagedGoalPlan(goal.plan) && <GoalReview key={`${goal.goalId}:${goal.revision}:${goal.stage}`} goal={goal} plan={goal.plan} disabled={disabled} resolveAsset={resolveAsset} onSelectCell={onSelectCell} onPreviewCell={onPreviewCell} onSave={plan => reviewAction('update', plan)} onApprove={plan => reviewAction('approve', plan)} onRegenerate={(plan, stage, index) => reviewAction('regenerate', plan, stage, index)} onRevise={(plan, stage, index, feedback) => reviewAction('revise', plan, stage, index, feedback)} onSelect={(stage, index, artifactId) => act({ action: 'select', stage, index, artifact_id: artifactId })} />}
      {!v3Plan && progress.phase !== 'planning' && progress.phase !== 'review' && (!simpleReview || retry) && <div onKeyDown={event => runWithShortcut(event, primary)}>
        <div className="goal-progress-summary"><progress max={Math.max(1, progress.total)} value={complete ? progress.total : progress.done} aria-label="Completed stage outputs" /><span>{progress.done} of {progress.total} ready · {goalStageLabel(progress.stage)}</span></div>
        <ol className="goal-progress-list">{progress.shots.map(shot => <GoalShotRow key={shot.index} shot={shot} onSelectCell={onSelectCell} />)}</ol>
        <div className="goal-panel-bar"><div className="goal-panel-bar-copy"><span>{complete ? goal.assembly ? 'Clips were appended in order to the timeline.' : 'Your clip is ready in the notebook.' : goal.status === 'cancelled' ? 'Remaining work is stopped. Requests already submitted may still finish.' : 'Outputs appear in the notebook as they finish. You can collapse this panel.'}</span></div>{primaryLabel && <button type="button" className="goal-panel-primary" disabled={disabled} onClick={primary}>{primaryLabel}</button>}</div>
      </div>}
      {complete && goal.assemblyStale && <div className="goal-panel-bar"><span className="goal-panel-bar-copy">The timeline uses earlier video versions.</span><button type="button" className="goal-panel-button" disabled={disabled} onClick={() => act({ action: 'assemble' })}>Assemble selected versions</button></div>}
      {complete && goal.assembly && !goal.assemblyStale && goal.planVersion === 2 && <div className="goal-panel-bar">
        <span className="goal-panel-bar-copy">Create one video with all clips and their sound. Rendered locally.</span>
        {goal.combined?.status === 'completed'
          ? <button type="button" className="goal-panel-button" onClick={() => onPreviewCell(goal.combined!.cellId)}>Open combined video</button>
          : <button type="button" className="goal-panel-button" disabled={disabled || goal.combined?.status === 'running'} onClick={() => act({ action: 'combine' })}>{goal.combined?.status === 'running' ? 'Combining clips…' : goal.combined?.status === 'failed' ? 'Retry combining clips' : 'Combine into one video'}</button>}
      </div>}
    </div>
  </div>
}

export function GoalPanelPlaceholder() {
  return <div className="composer-notebook-dock inspector goal-panel"><header><span className="inspector-cell-title goal-panel-title"><Flag size={14} className="goal-panel-flag" /><strong>GOAL</strong></span><div className="inspector-header-actions"><ComposerDockClose /></div></header><div className="goal-panel-body"><p role="status" className="goal-panel-muted">Loading the goal…</p></div></div>
}
