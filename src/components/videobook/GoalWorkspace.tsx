import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Film, Flag, Plus, X } from 'lucide-react'
import type { GoalPlan } from '../../../server/src/goal-plan'
import type { GoalSnapshot } from '../../../server/src/tools/goal'
import { asGoal, asGoals, goalPlansEqual, goalStatusLabel } from '@/videobook/goals'
import { useNotebookAutoRefresh } from '@/videobook/useNotebookAutoRefresh'
import { restoreFocusElement } from '@/videobook/command-composer-focus'
import './GoalWorkspace.css'

type GoalWorkspaceProps = {
  bookId: string
  notebookId: string
  initialGoals: GoalSnapshot[]
  connected: boolean
  callGoal: (args: Record<string, unknown>) => Promise<unknown>
  returnFocus: HTMLElement | null
  onClose: () => void
  onStarted: () => void
  onPreview: (startFrame: number) => Promise<void>
}

type GoalPlanEditorProps = {
  goal: GoalSnapshot & { plan: GoalPlan }
  disabled: boolean
  onSave: (plan: GoalPlan) => Promise<void>
  onRun: () => Promise<void>
}

function GoalPlanEditor({ goal, disabled, onSave, onRun }: GoalPlanEditorProps) {
  const [draft, setDraft] = useState(() => ({ ...goal.plan, shots: goal.plan.shots.map(shot => ({ ...shot, editorId: crypto.randomUUID() })) }))
  const plan: GoalPlan = { ...draft, shots: draft.shots.map(({ editorId: _editorId, ...shot }) => shot) }
  const dirty = !goalPlansEqual(plan, goal.plan)
  const valid = Boolean(draft.title.trim() && draft.continuity.trim()) && draft.shots.every(shot =>
    shot.title.trim() && shot.prompt.trim() && Number.isInteger(shot.durationSeconds)
    && shot.durationSeconds >= 4 && shot.durationSeconds <= 30)
  const updateShot = (index: number, change: Partial<GoalPlan['shots'][number]>) => {
    setDraft(current => ({ ...current, shots: current.shots.map((shot, position) => position === index ? { ...shot, ...change } : shot) }))
  }
  return <>
    <div className="goal-plan-settings">
      <label>Video title<input value={draft.title} maxLength={120} disabled={disabled} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
      <label>Format<select value={draft.aspectRatio} disabled={disabled} onChange={event => setDraft({ ...draft, aspectRatio: event.target.value as GoalPlan['aspectRatio'] })}>
        <option value="16:9">Landscape · 16:9</option><option value="9:16">Portrait · 9:16</option><option value="1:1">Square · 1:1</option>
      </select></label>
    </div>
    <label className="goal-continuity">Characters and visual style<textarea aria-label="Characters and visual style" value={draft.continuity} maxLength={3000} rows={3} disabled={disabled} onChange={event => setDraft({ ...draft, continuity: event.target.value })} /></label>
    <ol className="goal-shots">
      {draft.shots.map((shot, index) => <li key={shot.editorId} className="goal-shot">
        <div className="goal-shot-heading"><span className="goal-shot-number">{String(index + 1).padStart(2, '0')}</span>
          <label>Shot {index + 1} title<input aria-label={`Shot ${index + 1} title`} value={shot.title} maxLength={120} disabled={disabled} onChange={event => updateShot(index, { title: event.target.value })} /></label>
          <label>Seconds<input type="number" min={4} max={30} step={1} aria-label={`Shot ${index + 1} seconds`} value={shot.durationSeconds} disabled={disabled} onChange={event => updateShot(index, { durationSeconds: Number(event.target.value) })} /></label>
        </div>
        <label>Shot {index + 1} prompt<textarea aria-label={`Shot ${index + 1} prompt`} value={shot.prompt} maxLength={6000} rows={5} disabled={disabled} onChange={event => updateShot(index, { prompt: event.target.value })} /></label>
        <button type="button" className="goal-text-button" disabled={disabled || draft.shots.length === 1} onClick={() => setDraft({ ...draft, shots: draft.shots.filter((_, position) => position !== index) })}>Remove shot {index + 1}</button>
      </li>)}
    </ol>
    <button type="button" className="goal-add" disabled={disabled || draft.shots.length >= 8} onClick={() => setDraft({ ...draft, shots: [...draft.shots, { editorId: crypto.randomUUID(), title: `Shot ${draft.shots.length + 1}`, prompt: '', durationSeconds: 10 }] })}><Plus size={16} /> Add shot</button>
    <div className="goal-run-bar">
      <div><strong>{draft.shots.length} clips · {draft.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0)}s planned</strong>
        <p>Seedance 2.5 · 720p with sound · Append to the current sequence</p>
        <p>{dirty ? 'Save changes to refresh the video estimate.' : goal.estimate.usd === null ? 'Video cost estimate unavailable.' : `Estimated video cost: $${goal.estimate.usd.toFixed(2)}`}</p>
      </div>
      {dirty ? <button type="button" className="goal-primary" disabled={disabled || !valid} onClick={() => void onSave(plan)}>Save plan</button>
        : <button type="button" className="goal-primary" disabled={disabled || !valid} onClick={() => void onRun()}>Run goal</button>}
    </div>
    {!valid && <p role="status">Give every shot a title and prompt, with a duration from 4 to 30 seconds.</p>}
  </>
}

export function GoalWorkspace({ bookId, notebookId, initialGoals, connected, callGoal, returnFocus, onClose, onStarted, onPreview }: GoalWorkspaceProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [goals, setGoals] = useState(initialGoals)
  const [selectedId, setSelectedId] = useState(initialGoals[0]?.goalId ?? '')
  const [brief, setBrief] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const mutationRef = useRef(0)
  const pendingRef = useRef(false)
  const mountedRef = useRef(true)
  const selected = goals.find(goal => goal.goalId === selectedId)

  useEffect(() => {
    mountedRef.current = true
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => {
      mountedRef.current = false
      dialog?.close()
      restoreFocusElement(returnFocus)
    }
  }, [returnFocus])

  useNotebookAutoRefresh({
    bookId, notebookId, enabled: connected && !pending,
    refresh: async isCurrent => {
      const version = mutationRef.current
      try {
        const next = asGoals(await callGoal({ action: 'list' }))
        if (!isCurrent() || version !== mutationRef.current) return
        setGoals(current => JSON.stringify(current) === JSON.stringify(next) ? current : next)
        setRefreshError(null)
      } catch (cause) {
        if (isCurrent() && version === mutationRef.current) setRefreshError(cause instanceof Error ? cause.message : String(cause))
      }
    },
  })

  const mutate = async (args: Record<string, unknown>) => {
    if (!connected || pendingRef.current) return
    pendingRef.current = true
    mutationRef.current += 1
    setPending(true)
    setError(null)
    try {
      const goal = asGoal(await callGoal(args))
      if (!mountedRef.current) return
      setGoals(current => [goal, ...current.filter(entry => entry.goalId !== goal.goalId)])
      setSelectedId(goal.goalId)
      if (args.action === 'create') setBrief('')
      if (args.action === 'run') onStarted()
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      pendingRef.current = false
      if (mountedRef.current) setPending(false)
    }
  }
  const disabled = pending || !connected
  const active = selected && ['planning', 'review', 'running'].includes(selected.status)
  const completedShots = selected?.steps.filter(step => step.id !== 'assemble' && step.status === 'completed').length ?? 0
  return createPortal(<dialog ref={dialogRef} className="goal-workspace" aria-labelledby="goal-heading" onCancel={event => { event.preventDefault(); onClose() }}>
    <header className="goal-header"><div><Flag size={20} /><h1 id="goal-heading">Goal mode</h1></div><button type="button" aria-label="Close goal mode" onClick={onClose}><X size={20} /></button></header>
    <div className="goal-layout">
      <aside className="goal-sidebar">
        <form onSubmit={event => { event.preventDefault(); void mutate({ action: 'create', brief: brief.trim(), request_id: crypto.randomUUID() }) }}>
          <label>What do you want to make?<textarea aria-label="What do you want to make?" value={brief} maxLength={6000} rows={5} placeholder="A funny dog on a skateboard, multiple 10s clips" onChange={event => setBrief(event.target.value)} /></label>
          <button type="submit" className="goal-primary" disabled={disabled || !brief.trim()}>Plan video</button>
          <p>Defaults to three 10-second clips. Planning uses Astra and is billed separately. Review the shots before generating.</p>
        </form>
        <nav aria-label="Saved video goals">{goals.map(goal => <button type="button" key={goal.goalId} aria-current={selectedId === goal.goalId ? 'true' : undefined} onClick={() => setSelectedId(goal.goalId)}>
          <span>{goal.plan?.title ?? goal.brief}</span><small>{goalStatusLabel(goal.status)}</small>
        </button>)}</nav>
      </aside>
      <main className="goal-content">
        {!connected && <p role="status">Reconnecting. Your goal is saved; generation continues on the server.</p>}
        {error && <p role="alert" className="goal-error">{error}</p>}
        {refreshError && <p role="alert" className="goal-error">{refreshError}</p>}
        {!selected ? <div className="goal-empty"><Film size={36} /><h2>One idea. A complete sequence.</h2><p>Describe your video to build a shot plan. Edit the prompts, then run every clip and assemble them in order.</p></div> : <>
          <div className="goal-summary"><div><span className="goal-status" role="status">{goalStatusLabel(selected.status)}</span><h2>{selected.plan?.title ?? 'Building your shot plan'}</h2><p>{selected.brief}</p></div>
            {active && <button type="button" disabled={disabled} onClick={() => void mutate({ action: 'cancel', goal_id: selected.goalId })}>{selected.status === 'review' ? 'Discard goal' : 'Stop goal'}</button>}
          </div>
          {selected.error && <p role="alert" className="goal-error">{selected.error}</p>}
          {selected.status === 'planning' && <p className="goal-planning">Writing distinct shots, matching the characters and setting, and estimating the video cost…</p>}
          {selected.status === 'review' && selected.plan && <GoalPlanEditor key={`${selected.goalId}:${selected.revision}`} goal={{ ...selected, plan: selected.plan }} disabled={disabled}
            onSave={plan => mutate({ action: 'update', goal_id: selected.goalId, revision: selected.revision, plan })}
            onRun={() => mutate({ action: 'run', goal_id: selected.goalId, revision: selected.revision })} />}
          {selected.plan && selected.status !== 'review' && <>
            <div className="goal-progress"><progress max={selected.plan.shots.length} value={completedShots} aria-label="Completed shots" /><span>{completedShots} of {selected.plan.shots.length} shots ready</span></div>
            <ol className="goal-shots">{selected.plan.shots.map((shot, index) => {
              const step = selected.steps.find(entry => entry.id === `shot${index + 1}`)
              return <li key={`${selected.goalId}:shot${index + 1}`} className="goal-shot"><div className="goal-shot-heading"><span className="goal-shot-number">{String(index + 1).padStart(2, '0')}</span><h3>{shot.title}</h3><span>{shot.durationSeconds}s</span></div>
                <p>{shot.prompt}</p><strong>{goalStatusLabel(step?.status ?? 'pending')}</strong>
                {step?.error && <p className="goal-error">{step.error}</p>}
                {step?.status === 'completed' && step.artifactId && <video controls preload="metadata" aria-label={`Shot ${index + 1} video`} src={`/files/${encodeURIComponent(bookId)}/${encodeURIComponent(step.artifactId)}/original.mp4`} />}
              </li>
            })}</ol>
            {selected.status === 'running' && <p>Clips appear in the notebook as they finish. You can close this panel and reopen Goals at any time.</p>}
            {selected.status === 'cancelled' && <p>Remaining shots are stopped. Clips already submitted may still finish and remain in your library.</p>}
            {selected.assembly && <div className="goal-run-bar"><div><strong>Your sequence is ready</strong><p>Shots were appended in order. Preview or export from the timeline.</p></div><button type="button" className="goal-primary" disabled={disabled} onClick={() => void onPreview(selected.assembly!.startFrame).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))}>Preview sequence</button></div>}
            {!selected.assembly && selected.status !== 'running' && selected.status !== 'cancelled' && completedShots === selected.plan.shots.length && <button type="button" className="goal-primary" disabled={disabled} onClick={() => void mutate({ action: 'assemble', goal_id: selected.goalId })}>Assemble sequence</button>}
          </>}
        </>}
      </main>
    </div>
  </dialog>, document.body)
}
