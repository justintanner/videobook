import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { GoalPlan, GoalStillStage } from '../../../server/src/goal-plan'
import { GOAL_STYLE_IDS, goalStyle, goalStyleFragment, resolveGoalStyleOptions } from '../../../server/src/goal-styles'
import type { AssetRecord } from '@/videobook/workspace-responses'
import { goalPlanSeconds, goalPlansEqual, goalStillStale, type GoalSnapshot } from '@/videobook/goals'
import { GoalPromptInput } from './GoalPromptInput'
import { GoalMedia, GoalStillCard } from './GoalStillCard'

type DraftShot = GoalPlan['shots'][number] & { editorId: string }
type DraftPlan = Omit<GoalPlan, 'shots'> & { shots: DraftShot[] }
const formats = [{ value: '9:16', label: 'Portrait · 9:16' }, { value: '16:9', label: 'Landscape · 16:9' }, { value: '1:1', label: 'Square · 1:1' }] as const

export function GoalReview({ goal, plan: saved, disabled, onSave, onApprove, onRegenerate, onRevise, onSelect, resolveAsset, onSelectCell, onPreviewCell }: {
  goal: GoalSnapshot
  plan: GoalPlan
  disabled: boolean
  onSave: (plan: GoalPlan) => void
  onApprove: (plan: GoalPlan) => void
  onRegenerate: (plan: GoalPlan, stage: GoalStillStage, index: number) => void
  onRevise: (plan: GoalPlan, stage: GoalStillStage, index: number, feedback: string) => void
  onSelect: (stage: GoalStillStage, index: number, artifactId: string) => void
  resolveAsset: (artifactId: string) => AssetRecord | null
  onSelectCell: (cellId: string) => void
  onPreviewCell: (cellId: string) => void
}) {
  const [draft, setDraft] = useState<DraftPlan>(() => ({ ...saved, shots: saved.shots.map(shot => ({ ...shot, editorId: crypto.randomUUID() })) }))
  const plan: GoalPlan = { ...draft, shots: draft.shots.map(({ editorId: _editorId, ...shot }) => shot) }
  const dirty = !goalPlansEqual(plan, saved)
  const valid = Boolean(plan.title.trim() && plan.continuity.trim() && plan.frame.prompt.trim()) && plan.shots.every(shot =>
    shot.title.trim() && shot.storyboardPrompt.trim() && shot.videoPrompt.trim() && Number.isInteger(shot.durationSeconds) && shot.durationSeconds >= 4 && shot.durationSeconds <= 30)
  const stage = goal.stage === 'assembly' ? 'videos' : goal.stage
  const initial = stage === 'frame'
  const style = goalStyle(draft.style.id)
  const styleAnchors = goalStyleFragment(draft.style, 'frame')
  const staleFrame = !initial && (Boolean(goalStillStale(goal, 'frame', 0)) || draft.frame.prompt !== saved.frame.prompt)
  const staleBoards = stage === 'videos' && draft.shots.some((shot, index) =>
    goalStillStale(goal, 'storyboards', index) || shot.storyboardPrompt !== saved.shots[index]?.storyboardPrompt
    || shot.videoPrompt !== saved.shots[index]?.videoPrompt || shot.durationSeconds !== saved.shots[index]?.durationSeconds || shot.title !== saved.shots[index]?.title
    || draft.frameContinuity && (goalStillStale(goal, 'storyboards', index + draft.shots.length) || (shot.endingPrompt ?? shot.videoPrompt) !== (saved.shots[index]?.endingPrompt ?? saved.shots[index]?.videoPrompt)))
  const canApprove = !disabled && valid && !staleFrame && !staleBoards
  const estimate = goal.estimate[stage]
  const primaryLabel = `${initial ? 'Generate frame' : stage === 'storyboards' ? 'Use this frame · Generate storyboards' : 'Use these storyboards · Generate videos'}${estimate.usd === null ? '' : ` · $${estimate.usd.toFixed(2)}`}`
  const primary = () => { if (canApprove) onApprove(plan) }
  const updateShot = (index: number, change: Partial<GoalPlan['shots'][number]>) => setDraft(current => ({ ...current, shots: current.shots.map((shot, position) => position === index ? { ...shot, ...change } : shot) }))
  const stillCard = (target: GoalStillStage, index: number) => {
    const ending = target === 'storyboards' && index >= plan.shots.length
    const shotIndex = index % plan.shots.length
    const prompt = target === 'frame' ? draft.frame.prompt : ending ? draft.shots[shotIndex]!.endingPrompt ?? '' : draft.shots[shotIndex]!.storyboardPrompt
    return <GoalStillCard key={`${target}:${index}`} goal={goal} stage={target} index={index} prompt={prompt} disabled={disabled} canGenerate={valid} resolveAsset={resolveAsset} onOpen={onPreviewCell}
      onPromptChange={value => target === 'frame' ? setDraft({ ...draft, frame: { prompt: value } }) : updateShot(shotIndex, ending ? { endingPrompt: value.trim() ? value : null } : { storyboardPrompt: value })}
      onRegenerate={() => onRegenerate(plan, target, index)} onRevise={feedback => onRevise(plan, target, index, feedback)} onSelect={artifactId => onSelect(target, index, artifactId)} />
  }
  const heading = <div className="goal-plan-heading">
    <label><span className="sr-only">Video title</span><input value={draft.title} maxLength={120} disabled={disabled} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
    <div className="goal-formats" role="radiogroup" aria-label="Format">{formats.map(format => <button type="button" key={format.value} role="radio" aria-checked={draft.aspectRatio === format.value} className="goal-panel-button" disabled={disabled || !initial} onClick={() => setDraft({ ...draft, aspectRatio: format.value })}>{format.label}</button>)}</div>
    <div className="goal-formats goal-styles" role="radiogroup" aria-label="Style">{GOAL_STYLE_IDS.map(id => <button type="button" key={id} role="radio" aria-checked={draft.style.id === id} className="goal-panel-button" disabled={disabled || !initial} title={goalStyle(id).summary} onClick={() => setDraft({ ...draft, style: { id, options: resolveGoalStyleOptions(id) } })}>{goalStyle(id).label}</button>)}</div>
    {style.options.length > 0 && <div className="goal-style-options">{style.options.map(option => <label key={option.key}><span>{option.label}</span><select aria-label={option.label} value={draft.style.options[option.key]} disabled={disabled || !initial} onChange={event => {
      const options = { ...draft.style.options, [option.key]: event.target.value }
      if (option.key === 'delivery') delete options.camera
      setDraft({ ...draft, style: { id: style.id, options: resolveGoalStyleOptions(style.id, options) } })
    }}>{option.choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>)}</div>}
  </div>
  const advanced = <details className="goal-disclosure goal-advanced">
    <summary>Advanced</summary>
    <div className="goal-editor-settings">
      {stage === 'videos' && heading}
      <div className="goal-characters" aria-label="Character images">{goal.characters.map(character => <GoalMedia key={character.cellId} artifactId={character.artifactId} cellId={character.cellId} label={`${character.address} · ${character.label}`} resolveAsset={resolveAsset} onOpen={onSelectCell} />)}</div>
      <div className="goal-advanced-options">
        <label><span>Image model</span><select aria-label="Image model" value={draft.imageModel} disabled={disabled || !initial} onChange={event => setDraft({ ...draft, imageModel: event.target.value as GoalPlan['imageModel'] })}><option value="sunburst">GPT Image 2.5 Sunburst</option><option value="flare">GPT Image 2.5 Flare</option></select></label>
        <label><span>Image resolution</span><select aria-label="Image resolution" value={draft.imageResolution} disabled={disabled || !initial} onChange={event => setDraft({ ...draft, imageResolution: event.target.value as GoalPlan['imageResolution'] })}><option value="1K">1K</option><option value="2K">2K</option></select></label>
        <label><span>Video resolution</span><select aria-label="Video resolution" value={draft.videoResolution} disabled={disabled} onChange={event => setDraft({ ...draft, videoResolution: event.target.value as GoalPlan['videoResolution'] })}><option value="480p">480p</option><option value="720p">720p</option></select></label>
        <label><span>Ending frames</span><select aria-label="Ending frames" value={draft.frameContinuity ? 'on' : 'off'} disabled={disabled || !initial} onChange={event => setDraft({ ...draft, frameContinuity: event.target.value === 'on' })}><option value="off">Off · Storyboards only</option><option value="on">On · Add ending references</option></select></label>
      </div>
      {draft.frameContinuity && <p className="goal-panel-muted">Adds {draft.shots.length} ending images to guide the final poses alongside each storyboard.</p>}
      {styleAnchors && <p className="goal-panel-muted goal-style-anchors"><strong>Style anchors</strong> {styleAnchors}</p>}
      <GoalPromptInput label="Characters and visual style" value={draft.continuity} budget="continuity" maxLength={3000} disabled={disabled || !initial} onChange={continuity => setDraft({ ...draft, continuity })} />
      {initial && <GoalPromptInput label="Full frame prompt" value={draft.frame.prompt} budget="frame" disabled={disabled} onChange={prompt => setDraft({ ...draft, frame: { prompt } })} />}
      {initial && draft.frameContinuity && draft.shots.map((shot, index) => <GoalPromptInput key={shot.editorId} label={`Shot ${index + 1} ending frame prompt`} value={shot.endingPrompt ?? ''} placeholder="Final moment from the video prompt" budget="ending" disabled={disabled} onChange={endingPrompt => updateShot(index, { endingPrompt: endingPrompt.trim() ? endingPrompt : null })} />)}
    </div>
  </details>
  const shots = <div className="goal-editor-shots">
    <div className="goal-editor-shots-head"><span>Shots</span><small>{draft.shots.length} clips · {goalPlanSeconds(plan)}s planned</small>
      {initial && <button type="button" className="goal-panel-button" disabled={disabled || draft.shots.length >= 8} onClick={() => setDraft({ ...draft, shots: [...draft.shots, { editorId: crypto.randomUUID(), title: `Shot ${draft.shots.length + 1}`, storyboardPrompt: '', endingPrompt: null, videoPrompt: '', durationSeconds: 10 }] })}><Plus size={12} aria-hidden="true" />Add shot</button>}
    </div>
    <ol className="goal-editor-shot-list">
      {draft.shots.map((shot, index) => <li key={shot.editorId} className="goal-editor-shot">
        <div className="goal-editor-shot-head">
          <span className="goal-editor-shot-number">{String(index + 1).padStart(2, '0')}</span>
          <input aria-label={`Shot ${index + 1} title`} value={shot.title} maxLength={120} disabled={disabled} onChange={event => updateShot(index, { title: event.target.value })} />
          <span className="goal-editor-seconds"><input type="number" min={4} max={30} step={1} aria-label={`Shot ${index + 1} seconds`} value={shot.durationSeconds} disabled={disabled} onChange={event => updateShot(index, { durationSeconds: Number(event.target.value) })} /><span aria-hidden="true">s</span></span>
          {initial && <button type="button" className="goal-editor-remove" aria-label={`Remove shot ${index + 1}`} disabled={disabled || draft.shots.length === 1} onClick={() => setDraft({ ...draft, shots: draft.shots.filter((_, position) => position !== index) })}><X size={14} aria-hidden="true" /></button>}
        </div>
        {stage === 'videos' ? stillCard('storyboards', index) : <GoalPromptInput label="Storyboard prompt" name={`Shot ${index + 1} storyboard prompt`} value={shot.storyboardPrompt} budget="storyboard" disabled={disabled} onChange={storyboardPrompt => updateShot(index, { storyboardPrompt })} />}
        {stage === 'videos' && plan.frameContinuity && stillCard('storyboards', index + plan.shots.length)}
        <GoalPromptInput label="Video prompt" name={`Shot ${index + 1} video prompt`} value={shot.videoPrompt} budget="video" disabled={disabled} onChange={videoPrompt => updateShot(index, { videoPrompt })} />
      </li>)}
    </ol>
  </div>
  return <div className="goal-editor" data-review={stage} onKeyDown={event => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return
    event.preventDefault()
    primary()
  }}>
    {initial ? <>{heading}{shots}<div className="goal-plan-extras">{advanced}<p className="goal-panel-muted goal-brief-line">{goal.brief}</p></div></>
      : stage === 'storyboards' ? <>{stillCard('frame', 0)}<details className="goal-disclosure"><summary>Plan</summary>{heading}{shots}{advanced}</details></>
        : <>{shots}<details className="goal-disclosure"><summary>Back to frame</summary>{stillCard('frame', 0)}</details>{advanced}</>}
    <div className="goal-panel-bar">
      <div className="goal-panel-bar-copy">
        <span>{dirty ? 'Changes will be saved before generation.' : 'Approves this stage only.'}</span>
        {estimate.warnings.map(warning => <span key={warning}>{warning}</span>)}
        {!valid && <span role="status" className="goal-panel-warning">Complete all prompts and give each shot a whole duration from 4 to 30 seconds.</span>}
        {(staleFrame || staleBoards) && <span role="status" className="goal-panel-warning">Regenerate or revise the changed stills before continuing.</span>}
      </div>
      {dirty && <button type="button" className="goal-panel-button" disabled={disabled || !valid} onClick={() => onSave(plan)}>Save plan</button>}
      <button type="button" className="goal-panel-primary" disabled={!canApprove} title="⌘↵ approves this stage" onClick={primary}>{primaryLabel}<span aria-hidden="true">↵</span></button>
    </div>
  </div>
}
