import { useRef, useState, type KeyboardEvent } from 'react'
import { Flag, Plus, X } from 'lucide-react'
import type { GoalPlan } from '../../../server/src/goal-plan'
import {
  formatGoalClock,
  goalPlanSeconds,
  goalPlansEqual,
  goalProgress,
  goalShotStateLabel,
  goalStatusLine,
  goalTileView,
  type GoalProgress,
  type GoalShotView,
  type GoalSnapshot,
} from '@/videobook/goals'
import { useElapsedSeconds } from '@/videobook/use-elapsed-seconds'
import { ComposerDockClose } from '@/components/videobook/ComposerDockClose'
import './GoalPanel.css'

type GoalAction = Record<string, unknown>

type GoalPanelProps = {
  goal: GoalSnapshot
  connected: boolean
  onAction: (args: GoalAction) => Promise<void>
  onPreview: (startFrame: number) => Promise<void>
  onSelectCell: (cellId: string) => void
}

type GoalPlanEditorProps = {
  goal: GoalSnapshot & { plan: GoalPlan }
  disabled: boolean
  onSave: (plan: GoalPlan) => void
  onRun: () => void
}

type DraftShot = GoalPlan['shots'][number] & { editorId: string }

type DraftPlan = Omit<GoalPlan, 'shots'> & { shots: DraftShot[] }

const MAX_SHOTS = 8

function draftFromPlan(plan: GoalPlan): DraftPlan {
  return { ...plan, shots: plan.shots.map((shot) => ({ ...shot, editorId: crypto.randomUUID() })) }
}

function planFromDraft(draft: DraftPlan): GoalPlan {
  return { ...draft, shots: draft.shots.map(({ editorId: _editorId, ...shot }) => shot) }
}

function draftIsValid(draft: GoalPlan): boolean {
  return Boolean(draft.title.trim() && draft.continuity.trim()) && draft.shots.every((shot) =>
    shot.title.trim() && shot.prompt.trim() && Number.isInteger(shot.durationSeconds)
    && shot.durationSeconds >= 4 && shot.durationSeconds <= 30)
}

function runWithShortcut(event: KeyboardEvent<HTMLElement>, primary: () => void) {
  if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return
  event.preventDefault()
  primary()
}

function GoalPlanEditor({ goal, disabled, onSave, onRun }: GoalPlanEditorProps) {
  const [draft, setDraft] = useState(() => draftFromPlan(goal.plan))
  const plan = planFromDraft(draft)
  const dirty = !goalPlansEqual(plan, goal.plan)
  const valid = draftIsValid(plan)
  const seconds = goalPlanSeconds(plan)
  const updateShot = (index: number, change: Partial<GoalPlan['shots'][number]>) => {
    setDraft((current) => ({ ...current, shots: current.shots.map((shot, position) => position === index ? { ...shot, ...change } : shot) }))
  }
  const primary = () => {
    if (disabled || !valid) return
    if (dirty) onSave(plan)
    else onRun()
  }
  const estimate = dirty ? 'Save changes to refresh the video estimate.'
    : goal.estimate.usd === null ? 'Video cost estimate unavailable.'
      : `Estimated video cost: $${goal.estimate.usd.toFixed(2)}`
  return (
    <div className="goal-editor" onKeyDown={(event) => runWithShortcut(event, primary)}>
      <div className="goal-editor-columns">
        <div className="goal-editor-settings">
          <label>
            <span>Video title</span>
            <input value={draft.title} maxLength={120} disabled={disabled} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          </label>
          <label>
            <span>Format</span>
            <select value={draft.aspectRatio} disabled={disabled} onChange={(event) => setDraft({ ...draft, aspectRatio: event.target.value as GoalPlan['aspectRatio'] })}>
              <option value="16:9">Landscape · 16:9</option>
              <option value="9:16">Portrait · 9:16</option>
              <option value="1:1">Square · 1:1</option>
            </select>
          </label>
          <label>
            <span>Characters and visual style</span>
            <textarea value={draft.continuity} maxLength={3000} rows={6} disabled={disabled} onChange={(event) => setDraft({ ...draft, continuity: event.target.value })} />
          </label>
          <div className="goal-editor-brief">
            <span>Brief</span>
            <p>{goal.brief}</p>
          </div>
        </div>
        <div className="goal-editor-shots">
          <div className="goal-editor-shots-head">
            <span>Shots</span>
            <small>{draft.shots.length} clips · {seconds}s planned</small>
            <button
              type="button"
              className="goal-panel-button"
              disabled={disabled || draft.shots.length >= MAX_SHOTS}
              onClick={() => setDraft({ ...draft, shots: [...draft.shots, { editorId: crypto.randomUUID(), title: `Shot ${draft.shots.length + 1}`, prompt: '', durationSeconds: 10 }] })}
            >
              <Plus size={12} aria-hidden="true" />
              Add shot
            </button>
          </div>
          <ol className="goal-editor-shot-list">
            {draft.shots.map((shot, index) => (
              <li key={shot.editorId} className="goal-editor-shot">
                <div className="goal-editor-shot-head">
                  <span className="goal-editor-shot-number">{String(index + 1).padStart(2, '0')}</span>
                  <input aria-label={`Shot ${index + 1} title`} value={shot.title} maxLength={120} disabled={disabled} onChange={(event) => updateShot(index, { title: event.target.value })} />
                  <span className="goal-editor-seconds">
                    <input type="number" min={4} max={30} step={1} aria-label={`Shot ${index + 1} seconds`} value={shot.durationSeconds} disabled={disabled} onChange={(event) => updateShot(index, { durationSeconds: Number(event.target.value) })} />
                    <span aria-hidden="true">s</span>
                  </span>
                  <button
                    type="button"
                    className="goal-editor-remove"
                    aria-label={`Remove shot ${index + 1}`}
                    disabled={disabled || draft.shots.length === 1}
                    onClick={() => setDraft({ ...draft, shots: draft.shots.filter((_, position) => position !== index) })}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
                <textarea aria-label={`Shot ${index + 1} prompt`} value={shot.prompt} maxLength={6000} rows={2} disabled={disabled} onChange={(event) => updateShot(index, { prompt: event.target.value })} />
              </li>
            ))}
          </ol>
        </div>
      </div>
      <div className="goal-panel-bar">
        <div className="goal-panel-bar-copy">
          <strong>{draft.shots.length} clips · {seconds}s planned · Seedance 2.5 · 720p with sound · Append to the timeline</strong>
          <span>{estimate} · Running approves this whole plan once</span>
          {!valid && <span role="status" className="goal-panel-warning">Give every shot a title and prompt, with a duration from 4 to 30 seconds.</span>}
        </div>
        <button type="button" className="goal-panel-primary" disabled={disabled || !valid} title="⌘↵ runs from any field" onClick={primary}>
          {dirty ? 'Save plan' : 'Run goal'}
          <span aria-hidden="true">↵</span>
        </button>
      </div>
    </div>
  )
}

function GoalShotRow({ shot, onSelectCell }: { shot: GoalShotView; onSelectCell: (cellId: string) => void }) {
  const elapsed = useElapsedSeconds(shot.state === 'generating' ? shot.startedAt : null)
  const state = shot.state === 'generating' && elapsed !== null
    ? `Generating ${formatGoalClock(elapsed)}`
    : goalShotStateLabel(shot.state)
  const cellId = shot.cellId
  return (
    <li className="goal-progress-shot" data-state={shot.state}>
      <span className="goal-progress-number">{shot.number}</span>
      <span className="goal-progress-title" title={shot.prompt}>{shot.title}</span>
      <span className="goal-progress-seconds">{shot.seconds}s</span>
      {cellId && shot.address
        ? <button type="button" className="goal-progress-address" onClick={() => onSelectCell(cellId)}>{shot.address}</button>
        : <span className="goal-progress-address" aria-hidden="true">—</span>}
      <span className="goal-progress-state">{state}</span>
      {shot.error && <span className="goal-progress-error">{shot.error}</span>}
    </li>
  )
}

function progressNote(progress: GoalProgress): string | null {
  if (progress.phase === 'shot' || progress.phase === 'assembling') {
    return 'Clips appear in the notebook as they finish. Collapse this panel any time; the goal keeps running on the server.'
  }
  if (progress.phase === 'stopped') return 'Remaining shots are stopped. Clips already submitted may still finish and remain in your library.'
  if (progress.phase === 'complete') return 'Shots were appended in order. Preview or export from the timeline.'
  return null
}

function retryLabel(progress: GoalProgress): string {
  if (progress.failedStep === null) return 'Plan again'
  if (progress.failedStep === 'assemble') return 'Retry assembly'
  return `Retry shot ${(progress.active?.index ?? 0) + 1}`
}

export function GoalPanel({ goal, connected, onAction, onPreview, onSelectCell }: GoalPanelProps) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pendingRef = useRef(false)
  const progress = goalProgress(goal)
  const line = goalStatusLine(goal)
  const view = goalTileView(goal, goal.plan, undefined)
  const disabled = pending || !connected
  const perform = async (work: () => Promise<void>) => {
    if (!connected || pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    try {
      await work()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }
  const act = (args: GoalAction) => { void perform(() => onAction({ ...args, goal_id: goal.goalId })) }
  const active = progress.phase === 'planning' || progress.phase === 'shot' || progress.phase === 'assembling'
  const finished = progress.phase === 'complete' || progress.phase === 'failed' || progress.phase === 'interrupted' || progress.phase === 'stopped'
  const primaryLabel = progress.phase === 'complete' && goal.assembly ? 'Preview sequence'
    : progress.phase === 'failed' || progress.phase === 'interrupted' ? retryLabel(progress)
      : null
  const runPrimary = () => {
    const assembly = goal.assembly
    if (progress.phase === 'complete' && assembly) {
      void perform(() => onPreview(assembly.startFrame))
      return
    }
    act({ action: 'retry' })
  }
  const note = progressNote(progress)

  return (
    <div className="composer-notebook-dock inspector goal-panel" data-tone={line.tone}>
      <header>
        <span className="inspector-cell-title goal-panel-title">
          <Flag size={14} className="goal-panel-flag" />
          <strong>GOAL</strong>
          {goal.address && <code className="inspector-cell-address">{goal.address}</code>}
          <span className="goal-panel-name" title={view.title}>{view.title}</span>
          <span className="goal-tile-chip" data-tone={view.chip.tone}>{view.chip.label}</span>
        </span>
        <div className="inspector-header-actions">
          <div className="inspector-generation-header-actions">
            {progress.phase === 'review' && (
              <button type="button" disabled={disabled} onClick={() => act({ action: 'cancel' })}>Discard goal</button>
            )}
            {active && (
              <button type="button" disabled={disabled} onClick={() => act({ action: 'cancel' })}>Stop goal</button>
            )}
            {finished && (
              <button type="button" disabled={disabled || Boolean(goal.dismissedAt)} onClick={() => act({ action: 'dismiss' })}>Dismiss</button>
            )}
          </div>
          <ComposerDockClose />
        </div>
      </header>
      <div className="goal-panel-body">
        {!connected && <p role="status" className="goal-panel-muted">Reconnecting. Your goal is saved; generation continues on the server.</p>}
        {error && <p role="alert" className="goal-panel-error">{error}</p>}
        {goal.error && (progress.phase === 'failed' || progress.phase === 'interrupted')
          && (progress.failedStep === null || progress.failedStep === 'assemble') && (
          <p role="alert" className="goal-panel-error">{goal.error}</p>
        )}
        {progress.phase === 'planning' && (
          <div className="goal-panel-planning">
            <p className="goal-panel-brief">{goal.brief}</p>
            <p className="goal-panel-muted">Writing distinct shots, matching the characters and setting, and estimating the video cost…</p>
            <span className="goal-tile-shimmer" aria-hidden="true"><i /><i /><i /></span>
          </div>
        )}
        {progress.phase === 'review' && goal.plan && (
          <GoalPlanEditor
            key={`${goal.goalId}:${goal.revision}`}
            goal={{ ...goal, plan: goal.plan }}
            disabled={disabled}
            onSave={(plan) => act({ action: 'update', revision: goal.revision, plan })}
            onRun={() => act({ action: 'run', revision: goal.revision })}
          />
        )}
        {progress.phase !== 'planning' && progress.phase !== 'review' && (
          <>
            <div className="goal-progress-summary">
              <progress max={Math.max(1, progress.total)} value={progress.phase === 'complete' ? progress.total : progress.done} aria-label="Completed shots" />
              <span>{progress.done} of {progress.total} shots ready</span>
            </div>
            <ol className="goal-progress-list">
              {progress.shots.map((shot) => <GoalShotRow key={shot.index} shot={shot} onSelectCell={onSelectCell} />)}
            </ol>
            {(note || primaryLabel) && (
              <div className="goal-panel-bar">
                <div className="goal-panel-bar-copy">{note && <span>{note}</span>}</div>
                {primaryLabel && (
                  <button type="button" className="goal-panel-primary" disabled={disabled} onClick={runPrimary}>{primaryLabel}</button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export function GoalPanelPlaceholder() {
  return (
    <div className="composer-notebook-dock inspector goal-panel">
      <header>
        <span className="inspector-cell-title goal-panel-title">
          <Flag size={14} className="goal-panel-flag" />
          <strong>GOAL</strong>
        </span>
        <div className="inspector-header-actions">
          <ComposerDockClose />
        </div>
      </header>
      <div className="goal-panel-body">
        <p role="status" className="goal-panel-muted">Loading the goal…</p>
      </div>
    </div>
  )
}
