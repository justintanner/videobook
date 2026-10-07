import { useRef, useState, type KeyboardEvent } from 'react'
import { Flag, Plus, X } from 'lucide-react'
import type { GoalPlan } from '../../../server/src/goal-plan'
import type { AssetRecord } from '@/videobook/workspace-responses'
import { formatGoalClock, goalPlanSeconds, goalPlansEqual, goalProgress, goalShotStateLabel, goalStageLabel, goalStatusLine, goalTileView, isStagedGoalPlan, type GoalShotView, type GoalSnapshot } from '@/videobook/goals'
import { useElapsedSeconds } from '@/videobook/use-elapsed-seconds'
import { ComposerDockClose } from '@/components/videobook/ComposerDockClose'
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
type DraftShot = GoalPlan['shots'][number] & { editorId: string }
type DraftPlan = Omit<GoalPlan, 'shots'> & { shots: DraftShot[] }
type GoalReviewProps = Pick<GoalPanelProps, 'goal' | 'onSelectCell' | 'onPreviewCell' | 'resolveAsset'> & {
  plan: GoalPlan
  disabled: boolean
  onSave: (plan: GoalPlan) => void
  onApprove: (plan: GoalPlan) => void
  onRegenerate: (plan: GoalPlan, indexes?: number[]) => void
}

function runWithShortcut(event: KeyboardEvent<HTMLElement>, primary: () => void) {
  if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return
  event.preventDefault()
  primary()
}

function GoalMedia({ artifactId, cellId, label, resolveAsset, onOpen }: {
  artifactId: string
  cellId: string | null
  label: string
  resolveAsset: GoalPanelProps['resolveAsset']
  onOpen: (cellId: string) => void
}) {
  const asset = resolveAsset(artifactId)
  const url = asset?.thumbnailUrl ?? asset?.mediaUrl
  return (
    <button type="button" className="goal-media" disabled={!cellId} onClick={() => { if (cellId) onOpen(cellId) }} aria-label={`Open ${label}`}>
      {url ? <img src={url} alt={label} /> : <span className="goal-media-pending">Preview pending</span>}
      <span>{label}</span>
    </button>
  )
}

function GoalReview({ goal, plan: saved, disabled, onSave, onApprove, onRegenerate, resolveAsset, onSelectCell, onPreviewCell }: GoalReviewProps) {
  const [draft, setDraft] = useState<DraftPlan>(() => ({ ...saved, shots: saved.shots.map(shot => ({ ...shot, editorId: crypto.randomUUID() })) }))
  const plan: GoalPlan = { ...draft, shots: draft.shots.map(({ editorId: _editorId, ...shot }) => shot) }
  const dirty = !goalPlansEqual(plan, saved)
  const valid = Boolean(plan.title.trim() && plan.continuity.trim() && plan.frame.prompt.trim()) && plan.shots.every(shot =>
    shot.title.trim() && shot.storyboardPrompt.trim() && shot.videoPrompt.trim() && Number.isInteger(shot.durationSeconds) && shot.durationSeconds >= 4 && shot.durationSeconds <= 30)
  const stage = goal.stage === 'assembly' ? 'videos' : goal.stage
  const initial = stage === 'frame'
  const stageEstimate = goal.estimate[stage]
  const primaryLabel = initial ? 'Generate full frame' : stage === 'storyboards' ? 'Approve frame · Generate storyboards' : 'Approve storyboards · Generate videos'
  const primary = () => { if (!disabled && valid) onApprove(plan) }
  const updateShot = (index: number, change: Partial<GoalPlan['shots'][number]>) => setDraft(current => ({ ...current, shots: current.shots.map((shot, position) => position === index ? { ...shot, ...change } : shot) }))
  const frame = goal.stages.frame?.outputs[0]
  return (
    <div className="goal-editor" onKeyDown={event => runWithShortcut(event, primary)}>
      <div className="goal-characters" aria-label="Character images">
        {goal.characters.map(character => <GoalMedia key={character.cellId} artifactId={character.artifactId} cellId={character.cellId} label={`${character.address} · ${character.label}`} resolveAsset={resolveAsset} onOpen={onSelectCell} />)}
      </div>
      <div className="goal-editor-columns">
        <div className="goal-editor-settings">
          <label><span>Video title</span><input value={draft.title} maxLength={120} disabled={disabled} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
          <label><span>Format</span><select value={draft.aspectRatio} disabled={disabled || !initial} onChange={event => setDraft({ ...draft, aspectRatio: event.target.value as GoalPlan['aspectRatio'] })}>
            <option value="16:9">Landscape · 16:9</option><option value="9:16">Portrait · 9:16</option><option value="1:1">Square · 1:1</option>
          </select></label>
          <label><span>Image model</span><select value={draft.imageModel} disabled={disabled || !initial} onChange={event => setDraft({ ...draft, imageModel: event.target.value as GoalPlan['imageModel'] })}>
            <option value="sunburst">GPT Image 2.5 Sunburst</option><option value="flare">GPT Image 2.5 Flare</option>
          </select></label>
          <label><span>Image resolution</span><select value={draft.imageResolution} disabled={disabled || !initial} onChange={event => setDraft({ ...draft, imageResolution: event.target.value as GoalPlan['imageResolution'] })}>
            <option value="1K">1K</option><option value="2K">2K</option>
          </select></label>
          <label><span>Video resolution</span><select value={draft.videoResolution} disabled={disabled} onChange={event => setDraft({ ...draft, videoResolution: event.target.value as GoalPlan['videoResolution'] })}>
            <option value="480p">480p</option><option value="720p">720p</option>
          </select></label>
          <label><span>Ending storyboards</span><select aria-label="Ending storyboards" value={draft.frameContinuity ? 'on' : 'off'} disabled={disabled || !initial} onChange={event => setDraft({ ...draft, frameContinuity: event.target.value === 'on' })}>
            <option value="off">Off · Starting frames only</option><option value="on">On · Review starting and ending frames</option>
          </select></label>
          {draft.frameContinuity && <p className="goal-panel-muted">Adds {draft.shots.length} ending images to the storyboard cost. Each video uses its approved starting and ending frames.</p>}
          <label><span>Characters and visual style</span><textarea aria-label="Characters and visual style" value={draft.continuity} maxLength={3000} rows={4} disabled={disabled || !initial} onChange={event => setDraft({ ...draft, continuity: event.target.value })} /></label>
          {stage !== 'videos' && <>
            {frame && <GoalMedia artifactId={frame.artifactId} cellId={frame.cellId} label="Full frame" resolveAsset={resolveAsset} onOpen={onPreviewCell} />}
            <label><span>Full frame prompt</span><textarea aria-label="Full frame prompt" value={draft.frame.prompt} maxLength={6000} rows={4} disabled={disabled} onChange={event => setDraft({ ...draft, frame: { prompt: event.target.value } })} /></label>
            {frame && <button type="button" className="goal-panel-button" disabled={disabled || !valid} onClick={() => onRegenerate(plan)}>Regenerate frame{goal.estimate.frame.usd === null ? '' : ` · $${goal.estimate.frame.usd.toFixed(2)}`}</button>}
          </>}
          <div className="goal-editor-brief"><span>Brief</span><p>{goal.brief}</p></div>
        </div>
        <div className="goal-editor-shots">
          <div className="goal-editor-shots-head"><span>Shots</span><small>{draft.shots.length} clips · {goalPlanSeconds(plan)}s planned</small>
            {initial && <button type="button" className="goal-panel-button" disabled={disabled || draft.shots.length >= 8} onClick={() => setDraft({ ...draft, shots: [...draft.shots, { editorId: crypto.randomUUID(), title: `Shot ${draft.shots.length + 1}`, storyboardPrompt: '', endingPrompt: null, videoPrompt: '', durationSeconds: 10 }] })}><Plus size={12} aria-hidden="true" />Add shot</button>}
          </div>
          <ol className="goal-editor-shot-list">
            {draft.shots.map((shot, index) => {
              const storyboard = goal.stages.storyboards?.outputs.find(output => output.index === index)
              const ending = plan.frameContinuity ? goal.stages.storyboards?.outputs.find(output => output.index === index + plan.shots.length) : null
              return <li key={shot.editorId} className="goal-editor-shot">
                <div className="goal-editor-shot-head">
                  <span className="goal-editor-shot-number">{String(index + 1).padStart(2, '0')}</span>
                  <input aria-label={`Shot ${index + 1} title`} value={shot.title} maxLength={120} disabled={disabled} onChange={event => updateShot(index, { title: event.target.value })} />
                  <span className="goal-editor-seconds"><input type="number" min={4} max={30} step={1} aria-label={`Shot ${index + 1} seconds`} value={shot.durationSeconds} disabled={disabled} onChange={event => updateShot(index, { durationSeconds: Number(event.target.value) })} /><span aria-hidden="true">s</span></span>
                  {initial && <button type="button" className="goal-editor-remove" aria-label={`Remove shot ${index + 1}`} disabled={disabled || draft.shots.length === 1} onClick={() => setDraft({ ...draft, shots: draft.shots.filter((_, position) => position !== index) })}><X size={14} aria-hidden="true" /></button>}
                </div>
                {storyboard && <GoalMedia artifactId={storyboard.artifactId} cellId={storyboard.cellId} label={`Storyboard ${index + 1}${storyboard.address ? ` · ${storyboard.address}` : ''}`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />}
                <label><span>Storyboard prompt</span><textarea aria-label={`Shot ${index + 1} storyboard prompt`} value={shot.storyboardPrompt} maxLength={6000} rows={3} disabled={disabled} onChange={event => updateShot(index, { storyboardPrompt: event.target.value })} /></label>
                {ending && <GoalMedia artifactId={ending.artifactId} cellId={ending.cellId} label={`Ending storyboard ${index + 1}${ending.address ? ` · ${ending.address}` : ''}`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />}
                {plan.frameContinuity && <label><span>Ending storyboard prompt</span><textarea aria-label={`Shot ${index + 1} ending storyboard prompt`} value={shot.endingPrompt ?? ''} placeholder="Use the final moment from the video prompt, or describe an ending pose" maxLength={6000} rows={3} disabled={disabled} onChange={event => updateShot(index, { endingPrompt: event.target.value.trim() ? event.target.value : null })} /></label>}
                {storyboard && <button type="button" className="goal-panel-button" disabled={disabled || !valid} onClick={() => onRegenerate(plan, [index])}>Regenerate {plan.frameContinuity ? 'storyboard pair' : 'storyboard'} {index + 1}{goal.estimate.storyboards.usd === null ? '' : ` · $${(goal.estimate.storyboards.usd / plan.shots.length).toFixed(2)}`}</button>}
                <label><span>Video prompt</span><textarea aria-label={`Shot ${index + 1} video prompt`} value={shot.videoPrompt} maxLength={6000} rows={3} disabled={disabled} onChange={event => updateShot(index, { videoPrompt: event.target.value })} /></label>
              </li>
            })}
          </ol>
        </div>
      </div>
      <div className="goal-panel-bar">
        <div className="goal-panel-bar-copy">
          <strong>{goalStageLabel(stage)}{stageEstimate.usd === null ? ' · estimate unavailable' : ` · estimated $${stageEstimate.usd.toFixed(2)}`}</strong>
          <span>{dirty ? 'Changes will be saved before generation. Save plan to refresh the estimate.' : 'Approves this stage only. Review its results before the next stage.'}</span>
          {stageEstimate.warnings.map(warning => <span key={warning}>{warning}</span>)}
          {!valid && <span role="status" className="goal-panel-warning">Complete all prompts and give each shot a whole duration from 4 to 30 seconds.</span>}
        </div>
        {dirty && <button type="button" className="goal-panel-button" disabled={disabled || !valid} onClick={() => onSave(plan)}>Save plan</button>}
        <button type="button" className="goal-panel-primary" disabled={disabled || !valid} title="⌘↵ approves this stage" onClick={primary}>{primaryLabel}<span aria-hidden="true">↵</span></button>
      </div>
    </div>
  )
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
  const current = goal.status === 'planning' ? 0 : goal.stage === 'frame' ? 1 : goal.stage === 'storyboards' ? 2 : goal.stage === 'videos' ? 3 : 4
  const labels = ['Plan', 'Full frame', 'Storyboards', 'Videos', ...(goal.plan?.shots.length === 1 ? [] : ['Combine'])]
  return <ol className="goal-stepper" aria-label="Goal stages">{labels.map((label, index) => <li key={label} data-state={goal.status === 'completed' || index < current ? 'done' : index === current ? 'current' : 'pending'} aria-current={index === current ? 'step' : undefined}>{label}</li>)}</ol>
}

export function GoalPanel({ goal, connected, onAction, onPreview, onSelectCell, onPreviewCell, resolveAsset }: GoalPanelProps) {
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const progress = goalProgress(goal)
  const line = goalStatusLine(goal)
  const view = goalTileView(goal, goal.plan, undefined)
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
  const reviewAction = (action: 'approve' | 'regenerate' | 'update', plan: GoalPlan, indexes?: number[]) => {
    void perform(async () => {
      const current = isStagedGoalPlan(goal.plan) && !goalPlansEqual(plan, goal.plan)
        ? await onAction({ action: 'update', goal_id: goal.goalId, revision: goal.revision, plan }) : goal
      if (action !== 'update') await onAction({ action, goal_id: goal.goalId, revision: current.revision, ...(indexes ? { shot_indexes: indexes } : {}) })
    })
  }
  const active = goal.status === 'planning' || goal.status === 'running'
  const finished = ['completed', 'failed', 'interrupted', 'cancelled'].includes(goal.status)
  const complete = goal.status === 'completed'
  const retry = (goal.status === 'failed' || goal.status === 'interrupted') && goal.planVersion === 2
  const primaryLabel = complete ? goal.assembly ? 'Preview sequence' : 'Open clip' : retry ? `Retry ${progress.failedStep === null ? 'planning' : progress.stage === 'frame' ? 'frame' : progress.stage}` : null
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
        {progress.phase === 'review' && <button type="button" disabled={disabled} onClick={() => act({ action: 'cancel' })}>Discard goal</button>}
        {active && <button type="button" disabled={disabled} onClick={() => act({ action: 'cancel' })}>Stop goal</button>}
        {finished && <button type="button" disabled={disabled || Boolean(goal.dismissedAt)} onClick={() => act({ action: 'dismiss' })}>Dismiss</button>}
      </div><ComposerDockClose /></div>
    </header>
    <div className="goal-panel-body">
      {goal.planVersion === 2 && <GoalStepper goal={goal} />}
      {!connected && <p role="status" className="goal-panel-muted">Reconnecting. Your goal is saved; generation continues on the server.</p>}
      {error && <p role="alert" className="goal-panel-error">{error}</p>}
      {goal.error && (progress.phase === 'failed' || progress.phase === 'interrupted') && <p role="alert" className="goal-panel-error">{goal.error}</p>}
      {goal.combined?.error && <p role="alert" className="goal-panel-error">{goal.combined.error}</p>}
      {progress.phase === 'planning' && <div className="goal-panel-planning"><p className="goal-panel-brief">{goal.brief}</p><p className="goal-panel-muted">Planning the full frame, storyboards and videos with your character images…</p><span className="goal-tile-placeholder" aria-hidden="true"><i /><i /><i /></span></div>}
      {progress.phase === 'review' && isStagedGoalPlan(goal.plan) && <GoalReview key={`${goal.goalId}:${goal.revision}:${goal.stage}`} goal={goal} plan={goal.plan} disabled={disabled} resolveAsset={resolveAsset} onSelectCell={onSelectCell} onPreviewCell={onPreviewCell} onSave={plan => reviewAction('update', plan)} onApprove={plan => reviewAction('approve', plan)} onRegenerate={(plan, indexes) => reviewAction('regenerate', plan, indexes)} />}
      {progress.phase !== 'planning' && progress.phase !== 'review' && <div onKeyDown={event => runWithShortcut(event, primary)}>
        <div className="goal-progress-summary"><progress max={Math.max(1, progress.total)} value={complete ? progress.total : progress.done} aria-label="Completed stage outputs" /><span>{progress.done} of {progress.total} ready · {goalStageLabel(progress.stage)}</span></div>
        <ol className="goal-progress-list">{progress.shots.map(shot => <GoalShotRow key={shot.index} shot={shot} onSelectCell={onSelectCell} />)}</ol>
        <div className="goal-panel-bar"><div className="goal-panel-bar-copy"><span>{complete ? goal.assembly ? 'Clips were appended in order to the timeline.' : 'Your clip is ready in the notebook.' : goal.status === 'cancelled' ? 'Remaining work is stopped. Requests already submitted may still finish.' : 'Outputs appear in the notebook as they finish. You can collapse this panel.'}</span></div>{primaryLabel && <button type="button" className="goal-panel-primary" disabled={disabled} onClick={primary}>{primaryLabel}</button>}</div>
      </div>}
      {complete && goal.assembly && goal.planVersion === 2 && <div className="goal-panel-bar">
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
