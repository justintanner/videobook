import { useState } from 'react'
import type { GoalGenerationStage, GoalPlan } from '../../../server/src/goal-plan'
import { GOAL_STYLE_IDS, goalStyle, goalStylesEqual, resolveGoalStyleOptions } from '../../../server/src/goal-styles'
import type { AssetRecord } from '@/videobook/workspace-responses'
import { goalPlansEqual, goalStillStale, type GoalSnapshot } from '@/videobook/goals'
import { GoalPromptInput } from './GoalPromptInput'
import { GoalMedia, GoalStillCard } from './GoalStillCard'

const stages = [{ id: 'frame', label: 'Scene' }, { id: 'storyboards', label: 'Storyboard' }, { id: 'videos', label: 'Video' }] as const
type DraftShot = GoalPlan['shots'][number] & { editorId: string }

export function SimpleGoalReview({ goal, plan: saved, disabled, onSave, onApprove, onRegenerate, onRevise, onSelect, resolveAsset, onPreviewCell }: {
  goal: GoalSnapshot
  plan: GoalPlan
  disabled: boolean
  onSave: (plan: GoalPlan) => void
  onApprove: (plan: GoalPlan) => void
  onRegenerate: (plan: GoalPlan, stage: GoalGenerationStage, index: number) => void
  onRevise: (plan: GoalPlan, stage: GoalGenerationStage, index: number, feedback: string) => void
  onSelect: (stage: GoalGenerationStage, index: number, artifactId: string) => void
  resolveAsset: (artifactId: string) => AssetRecord | null
  onPreviewCell: (cellId: string) => void
}) {
  const [draft, setDraft] = useState<GoalPlan>(() => saved)
  const [shots, setShots] = useState<DraftShot[]>(() => saved.shots.map(shot => ({ ...shot, editorId: crypto.randomUUID() })))
  const [view, setView] = useState<GoalGenerationStage>(() => goal.status === 'completed' || goal.stages.videos?.outputs.length ? 'videos' : goal.stage === 'videos' ? 'storyboards' : 'frame')
  const plan: GoalPlan = { ...draft, shots: shots.map(({ editorId: _editorId, ...shot }) => shot) }
  const dirty = !goalPlansEqual(plan, saved)
  const initial = !goal.stages.frame?.outputs.length
  const valid = Boolean(plan.title.trim() && plan.continuity.trim() && plan.frame.prompt.trim()) && shots.every(shot => shot.title.trim() && shot.storyboardPrompt.trim() && shot.videoPrompt.trim() && Number.isInteger(shot.durationSeconds) && shot.durationSeconds >= 4 && shot.durationSeconds <= 30)
  const visualChanged = draft.aspectRatio !== saved.aspectRatio || draft.imageModel !== saved.imageModel || draft.imageResolution !== saved.imageResolution || !goalStylesEqual(draft.style, saved.style)
  const priceChanged = draft.imageModel !== saved.imageModel || draft.imageResolution !== saved.imageResolution || draft.videoResolution !== saved.videoResolution || draft.frameContinuity !== saved.frameContinuity || shots.length !== saved.shots.length || shots.some((shot, index) => shot.durationSeconds !== saved.shots[index]?.durationSeconds)
  const frameStale = !initial && (Boolean(goalStillStale(goal, 'frame', 0)) || visualChanged || draft.frame.prompt !== saved.frame.prompt || draft.continuity !== saved.continuity || JSON.stringify(draft.referenceRoles) !== JSON.stringify(saved.referenceRoles))
  const boardStale = shots.some((shot, index) => goalStillStale(goal, 'storyboards', index) || shot.storyboardPrompt !== saved.shots[index]?.storyboardPrompt || shot.durationSeconds !== saved.shots[index]?.durationSeconds || shot.title !== saved.shots[index]?.title || saved.storyboardLayout !== 'six-panel' && shot.videoPrompt !== saved.shots[index]?.videoPrompt || draft.frameContinuity && (goalStillStale(goal, 'storyboards', index + shots.length) || (shot.endingPrompt ?? shot.videoPrompt) !== (saved.shots[index]?.endingPrompt ?? saved.shots[index]?.videoPrompt)))
  const next = goal.stage === 'assembly' ? 'videos' : goal.stage
  const canApprove = goal.status === 'review' && valid && !disabled && !priceChanged && (next === 'frame' || !frameStale) && (next !== 'videos' || !boardStale)
  const estimate = goal.estimate[next]
  const cost = estimate.usd === null ? ' · estimate unavailable' : ` · $${estimate.usd.toFixed(2)}`
  const labels = { frame: 'Generate scene', storyboards: `Use scene · Generate storyboard${shots.length > 1 ? 's' : ''}`, videos: `Use storyboard${shots.length > 1 ? 's' : ''} · Generate video${shots.length > 1 ? 's' : ''}` }
  const updateShot = (index: number, change: Partial<GoalPlan['shots'][number]>) => setShots(current => current.map((shot, position) => position === index ? { ...shot, ...change } : shot))
  const prompt = (stage: GoalGenerationStage, index: number) => stage === 'frame' ? draft.frame.prompt : stage === 'storyboards' && index >= shots.length ? shots[index % shots.length]!.endingPrompt ?? '' : stage === 'storyboards' ? shots[index]!.storyboardPrompt : shots[index]!.videoPrompt
  const changePrompt = (stage: GoalGenerationStage, index: number, value: string) => stage === 'frame' ? setDraft({ ...draft, frame: { prompt: value } }) : updateShot(index % shots.length, stage === 'videos' ? { videoPrompt: value } : index >= shots.length ? { endingPrompt: value || null } : { storyboardPrompt: value })
  const card = (stage: GoalGenerationStage, index: number) => <GoalStillCard key={`${stage}:${shots[index % shots.length]?.editorId ?? 'scene'}:${index >= shots.length}`} goal={goal} stage={stage} index={index} prompt={prompt(stage, index)} disabled={disabled} canGenerate={valid && !priceChanged && (stage === 'frame' || !frameStale) && (stage !== 'videos' || !boardStale)} resolveAsset={resolveAsset} onOpen={onPreviewCell} onPromptChange={value => changePrompt(stage, index, value)} onRegenerate={() => onRegenerate(plan, stage, index)} onRevise={feedback => onRevise(plan, stage, index, feedback)} onSelect={artifactId => onSelect(stage, index, artifactId)} />
  const style = goalStyle(draft.style.id)
  return <div className="goal-editor goal-simple" data-review={view} onKeyDown={event => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (canApprove) onApprove(plan)
  }}>
    <nav className="goal-stage-tabs" aria-label="Goal stages">{stages.map(stage => <button key={stage.id} type="button" className="goal-panel-button" aria-pressed={view === stage.id} onClick={() => setView(stage.id)}>{stage.label}{goal.stages[stage.id]?.outputs.length ? goal.stages[stage.id]?.outputs.some(output => output.stale) ? ' · Needs refresh' : ' ✓' : ''}</button>)}</nav>
    <p className="goal-panel-muted">{shots.length === 1 ? `${shots[0]!.durationSeconds}s video` : `${shots.length} clips`} · {plan.aspectRatio} · Seedance 2.5</p>
    {view === 'frame' && (initial ? <>
      <div className="goal-reference-grid" aria-label="Reference images">{goal.characters.map((reference, index) => <div key={reference.cellId}>
        <GoalMedia artifactId={reference.artifactId} cellId={reference.cellId} label={`Reference ${index + 1} · ${reference.address}`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />
        <label><span>Role</span><select aria-label={`Reference ${index + 1} role`} value={draft.referenceRoles?.[index] ?? 'reference'} disabled={disabled} onChange={event => setDraft({ ...draft, referenceRoles: goal.characters.map((_, position) => position === index ? event.target.value as NonNullable<GoalPlan['referenceRoles']>[number] : draft.referenceRoles?.[position] ?? 'reference') })}><option value="scene">Scene screenshot</option><option value="character">Character</option><option value="prop">Prop</option><option value="reference">Reference</option></select></label>
      </div>)}</div>
      <GoalPromptInput label="Scene prompt" value={draft.frame.prompt} budget="frame" disabled={disabled} onChange={value => changePrompt('frame', 0, value)} />
    </> : card('frame', 0))}
    {view !== 'frame' && <div className="goal-simple-outputs">{shots.map((shot, index) => <div key={shot.editorId}>
      {shots.length > 1 && <p className="goal-panel-muted">{shot.title}</p>}
      {goal.stages[view]?.outputs.some(output => output.index === index) ? card(view, index) : <GoalPromptInput label={view === 'storyboards' ? 'Storyboard prompt' : 'Video directions'} name={`Shot ${index + 1} ${view === 'storyboards' ? 'storyboard' : 'video'} prompt`} value={prompt(view, index)} budget={view === 'storyboards' ? 'storyboard' : 'video'} wordLimit={view === 'storyboards' && plan.storyboardLayout === 'six-panel' ? 48 : undefined} disabled={disabled} onChange={value => changePrompt(view, index, value)} />}
      {view === 'storyboards' && plan.frameContinuity && card(view, index + shots.length)}
    </div>)}</div>}
    {view === 'storyboards' && <p className="goal-panel-muted">{plan.storyboardLayout === 'six-panel' ? 'Six beats · 2 columns × 3 rows' : 'Four beats · 2 × 2'} · timestamps and camera notes below each picture.</p>}
    <details className="goal-disclosure goal-advanced"><summary>Advanced</summary><div className="goal-editor-settings">
      <label><span>Title</span><input aria-label="Video title" value={draft.title} disabled={disabled} maxLength={120} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
      <div className="goal-advanced-options">
        <label><span>Style</span><select aria-label="Style" value={draft.style.id} disabled={disabled} onChange={event => { const id = event.target.value as GoalPlan['style']['id']; setDraft({ ...draft, style: { id, options: resolveGoalStyleOptions(id) } }) }}>{GOAL_STYLE_IDS.map(id => <option key={id} value={id}>{goalStyle(id).label}</option>)}</select></label>
        <label><span>Format</span><select aria-label="Format" value={draft.aspectRatio} disabled={disabled} onChange={event => setDraft({ ...draft, aspectRatio: event.target.value as GoalPlan['aspectRatio'] })}><option value="9:16">Portrait · 9:16</option><option value="16:9">Landscape · 16:9</option><option value="1:1">Square · 1:1</option></select></label>
        <label><span>Image model</span><select aria-label="Image model" value={draft.imageModel} disabled={disabled} onChange={event => setDraft({ ...draft, imageModel: event.target.value as GoalPlan['imageModel'] })}><option value="nano-banana-2-1">Nano Banana 2.1</option><option value="sunburst">GPT Image 2.5 Sunburst</option><option value="flare">GPT Image 2.5 Flare</option></select></label>
        <label><span>Image resolution</span><select aria-label="Image resolution" value={draft.imageResolution} disabled={disabled} onChange={event => setDraft({ ...draft, imageResolution: event.target.value as GoalPlan['imageResolution'] })}><option value="1K">1K</option><option value="2K">2K</option></select></label>
        <label><span>Video resolution</span><select aria-label="Video resolution" value={draft.videoResolution} disabled={disabled} onChange={event => setDraft({ ...draft, videoResolution: event.target.value as GoalPlan['videoResolution'] })}><option value="480p">480p</option><option value="720p">720p</option></select></label>
        <label><span>Ending frames</span><select aria-label="Ending frames" value={draft.frameContinuity ? 'on' : 'off'} disabled={disabled || !initial} onChange={event => setDraft({ ...draft, frameContinuity: event.target.value === 'on' })}><option value="off">Off</option><option value="on">Add ending references</option></select></label>
      </div>
      {style.options.map(option => <label key={option.key}><span>{option.label}</span><select aria-label={option.label} value={draft.style.options[option.key]} disabled={disabled} onChange={event => { const options = { ...draft.style.options, [option.key]: event.target.value }; if (option.key === 'delivery') delete options.camera; setDraft({ ...draft, style: { id: style.id, options: resolveGoalStyleOptions(style.id, options) } }) }}>{option.choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>)}
      <GoalPromptInput label="Continuity" value={draft.continuity} budget="continuity" disabled={disabled} onChange={continuity => setDraft({ ...draft, continuity })} />
      {shots.map((shot, index) => <div key={shot.editorId} className="goal-editor-settings">
        <label><span>Clip {index + 1} duration</span><input type="number" aria-label={`Shot ${index + 1} seconds`} min={4} max={30} value={shot.durationSeconds} disabled={disabled} onChange={event => updateShot(index, { durationSeconds: Number(event.target.value) })} /></label>
        <GoalPromptInput label={`Clip ${index + 1} storyboard`} value={shot.storyboardPrompt} budget="storyboard" wordLimit={plan.storyboardLayout === 'six-panel' ? 48 : undefined} disabled={disabled} onChange={storyboardPrompt => updateShot(index, { storyboardPrompt })} />
        <GoalPromptInput label={`Clip ${index + 1} motion and sound`} value={shot.videoPrompt} budget="video" disabled={disabled} onChange={videoPrompt => updateShot(index, { videoPrompt })} />
        {initial && shots.length > 1 && <button type="button" className="goal-panel-button" disabled={disabled} onClick={() => setShots(shots.filter(item => item.editorId !== shot.editorId))}>Remove clip {index + 1}</button>}
      </div>)}
      {initial && <button type="button" className="goal-panel-button" disabled={disabled || shots.length >= 8} onClick={() => setShots([...shots, { ...shots.at(-1)!, title: `Clip ${shots.length + 1}`, editorId: crypto.randomUUID() }])}>Add clip</button>}
    </div></details>
    <div className="goal-panel-bar">
      <div className="goal-panel-bar-copy"><span>{dirty ? 'Changes will be saved before generation.' : goal.status === 'completed' ? 'Choose any stage to revise it. Earlier versions stay available.' : 'Approves this stage only.'}</span>
        {!valid && <span className="goal-panel-warning">Complete the prompts and choose a whole duration from 4 to 30 seconds.</span>}
        {priceChanged && <span className="goal-panel-warning">Save the plan to refresh cost estimates before generating.</span>}
        {frameStale ? <span role="status" className="goal-panel-warning">Refresh the scene before continuing.</span> : boardStale && <span role="status" className="goal-panel-warning">Refresh the changed storyboard before generating video.</span>}
        {goal.status === 'review' && estimate.warnings.map(warning => <span key={warning}>{warning}</span>)}
      </div>
      {dirty && <button type="button" className="goal-panel-button" disabled={disabled || !valid} onClick={() => onSave(plan)}>Save plan</button>}
      {goal.status === 'review' && <button type="button" className="goal-panel-primary" disabled={!canApprove} onClick={() => onApprove(plan)}>{labels[next]}{cost}</button>}
    </div>
  </div>
}
