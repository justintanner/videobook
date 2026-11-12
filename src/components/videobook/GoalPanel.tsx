import { useRef, useState, type ReactNode } from 'react'
import { Flag } from 'lucide-react'
import type { AssetRecord } from '@/videobook/workspace-responses'
import { goalCanRetry, goalProgress, goalStatusLine, goalStopLabel, goalTileView, LEGACY_GOAL_NOTE, shortPlanOf, type GoalSnapshot, type LegacyGoalSnapshot, type MainCharacterView } from '@/videobook/goals'
import { ComposerDockClose } from '@/components/videobook/ComposerDockClose'
import { GoalShortReview } from './GoalShortReview'
import './GoalPanel.css'

type GoalAction = Record<string, unknown>
type GoalPanelProps = {
  goal: GoalSnapshot
  connected: boolean
  onAction: (args: GoalAction) => Promise<GoalSnapshot>
  onCharacter: (args: GoalAction) => Promise<MainCharacterView>
  onSelectCell: (cellId: string) => void
  onPreviewCell: (cellId: string) => void
  resolveAsset: (artifactId: string) => AssetRecord | null
}

const LEGACY_STAGE_NAMES: Record<string, string> = { frame: 'Frame', storyboards: 'Storyboard', videos: 'Video' }

function LegacyGoalSummary({ goal, onSelectCell, resolveAsset }: { goal: LegacyGoalSnapshot, onSelectCell: (cellId: string) => void, resolveAsset: (artifactId: string) => AssetRecord | null }) {
  const finalAsset = goal.finalArtifactId ? resolveAsset(goal.finalArtifactId) : null
  return <div className="goal-legacy">
    {goal.brief && <p className="goal-panel-brief">{goal.brief}</p>}
    <p className="goal-panel-muted">{LEGACY_GOAL_NOTE} Start a new /goal for a new short.</p>
    {goal.outputs.length > 0 && <ol className="goal-legacy-outputs" aria-label="Outputs">{goal.outputs.map(output => <li key={`${output.stage}:${output.artifactId}`}>
      <span>{LEGACY_STAGE_NAMES[output.stage] ?? output.stage}</span>
      {output.cellId && output.address
        ? <button type="button" className="goal-progress-address" onClick={() => onSelectCell(output.cellId!)}>{output.address}</button>
        : <span className="goal-panel-muted">Removed from the notebook</span>}
    </li>)}</ol>}
    {finalAsset?.mediaUrl && <video className="goal-video-preview" aria-label="Finished video" src={finalAsset.mediaUrl} poster={finalAsset.thumbnailUrl ?? undefined} controls preload="metadata" />}
  </div>
}

export function GoalPanel({ goal, connected, onAction, onCharacter, onSelectCell, onPreviewCell, resolveAsset }: GoalPanelProps) {
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const line = goalStatusLine(goal)
  const view = goalTileView(goal, undefined)
  const disabled = pending || !connected
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
  const header = (actions: ReactNode) => <header>
    <span className="inspector-cell-title goal-panel-title"><Flag size={14} className="goal-panel-flag" /><strong>GOAL</strong>{goal.address && <code className="inspector-cell-address">{goal.address}</code>}<span className="goal-panel-name" title={view.title}>{view.title}</span><span className="goal-tile-chip" data-tone={view.chip.tone}>{view.chip.label}</span></span>
    <div className="inspector-header-actions"><div className="inspector-generation-header-actions">{actions}</div><ComposerDockClose /></div>
  </header>
  if (goal.legacy) {
    return <div className="composer-notebook-dock inspector goal-panel" data-tone={line.tone}>
      {header(<button type="button" disabled={disabled || Boolean(goal.dismissedAt) || ['planning', 'review', 'running'].includes(goal.status)} onClick={() => act({ action: 'dismiss' })}>Dismiss</button>)}
      <div className="goal-panel-body">
        {!connected && <p role="status" className="goal-panel-muted">Reconnecting. The goal's images and videos stay in the notebook.</p>}
        {error && <p role="alert" className="goal-panel-error">{error}</p>}
        <LegacyGoalSummary goal={goal} onSelectCell={onSelectCell} resolveAsset={resolveAsset} />
      </div>
    </div>
  }
  const progress = goalProgress(goal)
  const shortPlan = shortPlanOf(goal)
  const active = goal.status === 'planning' || goal.status === 'running'
  const finished = ['completed', 'failed', 'interrupted', 'cancelled'].includes(goal.status)
  const retry = goalCanRetry(goal)
  return <div className="composer-notebook-dock inspector goal-panel" data-tone={line.tone}>
    {header(<>
      {progress.phase === 'review' && <button type="button" disabled={disabled} onClick={() => act({ action: 'cancel' })}>{goal.finish?.status === 'running' ? 'Stop finishing' : 'Discard goal'}</button>}
      {active && <button type="button" disabled={disabled} onClick={() => act({ action: 'cancel' })}>{goalStopLabel(goal)}</button>}
      {finished && <button type="button" disabled={disabled || Boolean(goal.dismissedAt)} onClick={() => act({ action: 'dismiss' })}>Dismiss</button>}
    </>)}
    <div className="goal-panel-body">
      {shortPlan && goal.status !== 'planning' && <GoalShortReview key={`${goal.goalId}:${goal.revision}`} goal={goal} plan={shortPlan} disabled={disabled} resolveAsset={resolveAsset} onPreviewCell={onPreviewCell} onRun={work => { void perform(work) }} onAction={args => onAction({ ...args, goal_id: goal.goalId })} onCharacter={onCharacter} />}
      {!connected && <p role="status" className="goal-panel-muted">Reconnecting. Your goal is saved; generation continues on the server.</p>}
      {error && <p role="alert" className="goal-panel-error">{error}</p>}
      {goal.error && (progress.phase === 'failed' || progress.phase === 'interrupted') && <p role="alert" className="goal-panel-error">{goal.error}</p>}
      {progress.phase === 'planning' && <div className="goal-panel-planning"><p className="goal-panel-brief">{goal.brief}</p><p className="goal-panel-muted">Planning the frame and the beats of your short…</p><span className="goal-tile-placeholder" aria-hidden="true"><i /><i /><i /></span></div>}
      {!shortPlan && progress.phase !== 'planning' && <div className="goal-panel-planning">
        <p className="goal-panel-brief">{goal.brief}</p>
        <div className="goal-panel-bar"><div className="goal-panel-bar-copy"><span>{retry ? 'Planning writes the frame and beat prompts again. Nothing is generated until you approve it.' : 'Planning stopped before the short had a plan.'}</span></div>{retry && <button type="button" className="goal-panel-primary" disabled={disabled} onClick={() => act({ action: 'retry' })}>Retry planning</button>}</div>
      </div>}
    </div>
  </div>
}

export function GoalPanelPlaceholder() {
  return <div className="composer-notebook-dock inspector goal-panel"><header><span className="inspector-cell-title goal-panel-title"><Flag size={14} className="goal-panel-flag" /><strong>GOAL</strong></span><div className="inspector-header-actions"><ComposerDockClose /></div></header><div className="goal-panel-body"><p role="status" className="goal-panel-muted">Loading the goal…</p></div></div>
}
