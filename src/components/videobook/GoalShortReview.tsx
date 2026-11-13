import { useState } from 'react'
import { formatShortSeconds, SHORT_WORD_CEILINGS, type GoalShortPlan } from '../../../server/src/goal-short-plan'
import type { GoalGenerationStage } from '../../../server/src/goal-store'
import type { AssetRecord } from '@/videobook/workspace-responses'
import {
  goalCanRetry, goalNextSegment, goalPlanSeconds, goalStillStale, goalStillVersions, goalStoryboardClean, goalStoryboardEstimate, shortEstimateText,
  type GoalSnapshot, type ShortGoalSnapshot, type ShortTab,
} from '@/videobook/goals'
import { GoalPromptInput } from './GoalPromptInput'
import { GoalMedia } from './GoalStillCard'

type GoalAction = Record<string, unknown>
type AssetResolver = (artifactId: string) => AssetRecord | null
type ShortReviewProps = {
  goal: ShortGoalSnapshot
  plan: GoalShortPlan
  view: ShortTab
  disabled: boolean
  resolveAsset: AssetResolver
  onView: (tab: ShortTab) => void
  onPreviewCell: (cellId: string) => void
  onRun: (work: () => Promise<unknown>) => void
  onAction: (args: GoalAction) => Promise<GoalSnapshot>
}

const CURRENT_TABS = [['frame', 'Frame'], ['video', 'Video'], ['finish', 'Finish']] as const
const STORYBOARD_TABS = [['storyboard', 'Storyboard'], ['frame', 'Frame'], ['video', 'Video'], ['finish', 'Finish']] as const
const LEGACY_TABS = [['character', 'Character'], ['frame', 'Frame'], ['video', 'Video'], ['finish', 'Finish']] as const
const STORYBOARD_FIRST = 'Remove the on-screen graphics from the storyboard first: the frame is made from clean storyboard frame 1.'
const RUNNING: Record<GoalGenerationStage, string> = {
  storyboards: 'Removing the on-screen graphics from the storyboard.',
  frame: 'Generating the frame.',
  videos: 'Generating a clip.',
}

type RealismView = NonNullable<NonNullable<ShortGoalSnapshot['stages']['frame']>['outputs'][number]['realism']>
const REALISM_NOTE = 'The check for AI tells is billed like planning and never blocks a step.'

function RealismCheck({ name, check, disabled, onCheck }: { name: string, check: RealismView | null, disabled: boolean, onCheck: () => void }) {
  const running = check?.status === 'running'
  const findings = [...(check?.findings ?? [])].sort((left, right) => left.severity === right.severity ? 0 : left.severity === 'warn' ? -1 : 1)
  return <div className="goal-realism">
    <button type="button" className="goal-panel-button" disabled={disabled || running} onClick={onCheck}>{running ? 'Checking for AI tells…' : check?.status === 'completed' ? 'Check again for AI tells' : 'Check for AI tells'}</button>
    {running && <p role="status" className="goal-panel-muted">Looking at the {name} for AI tells…</p>}
    {check?.status === 'failed' && <p role="alert" className="goal-panel-warning">{check.error ?? 'The check for AI tells failed. Run it again.'}</p>}
    {check?.status === 'completed' && (findings.length === 0
      ? <p className="goal-panel-muted">No AI tells found in the {name}.</p>
      : <ul className="goal-realism-findings" aria-label={`AI tells in the ${name}`}>{findings.map((finding, index) => <li key={`${finding.severity}:${index}`} data-severity={finding.severity}><strong>{finding.severity === 'warn' ? 'Warn' : 'Note'}</strong> <span>{finding.text}</span></li>)}</ul>)}
  </div>
}

function AlwaysAdded({ lines }: { lines: readonly string[] }) {
  return <div className="goal-short-rules" aria-label="Always added">
    <span>Always added</span>
    {lines.map(line => <p key={line}>{line}</p>)}
  </div>
}

function shortSnapshot(goal: GoalSnapshot): ShortGoalSnapshot {
  if (goal.legacy) throw new Error('This goal was made by an earlier /goal. Start a new /goal.')
  return goal
}

export function GoalShortReview({ goal, plan, view, disabled, resolveAsset, onView, onPreviewCell, onRun, onAction }: ShortReviewProps) {
  const [title, setTitle] = useState(plan.title)
  const [framePrompt, setFramePrompt] = useState(plan.frame.prompt)
  const [beats, setBeats] = useState(() => plan.segments.map(segment => segment.prompt))
  const [feedback, setFeedback] = useState('')
  const [clipFeedback, setClipFeedback] = useState<Record<number, string>>({})
  const [boardFeedback, setBoardFeedback] = useState<Record<number, string>>({})
  const [revising, setRevising] = useState<string | null>(null)
  const [beat, setBeat] = useState({ prompt: '', seconds: 5 })
  const nextTitle = title.trim()
  const nextFrame = framePrompt.trim()
  const nextSegments = plan.segments.map((segment, index) => ({ ...segment, prompt: (beats[index] ?? '').trim() }))
  const draft: GoalShortPlan = plan.version === 4
    ? { ...plan, title: nextTitle, frame: { ...plan.frame, prompt: nextFrame }, segments: nextSegments }
    : { ...plan, title: nextTitle, frame: { ...plan.frame, prompt: nextFrame }, segments: nextSegments }
  const dirty = JSON.stringify(draft) !== JSON.stringify(plan)
  const promptsReady = Boolean(draft.title && draft.frame.prompt && draft.segments.every(segment => segment.prompt))
  const frameOutput = goal.stages.frame?.outputs[0]
  const clips = [...(goal.stages.videos?.outputs ?? [])].sort((left, right) => left.index - right.index)
  const currentClip = clips.at(-1) ?? null
  const next = goalNextSegment(goal, plan)
  const running = goal.status === 'running'
  const finishing = goal.finish?.status === 'running'
  const finishFailed = goal.finish?.status === 'failed'
  const canGenerate = goal.status === 'review' && promptsReady && !disabled && !running && !finishing
  const sourceId = next === null ? goal.finish?.sourceArtifactId ?? currentClip?.artifactId ?? null : null
  const sourceAsset = sourceId ? resolveAsset(sourceId) : null
  const clipAsset = currentClip ? resolveAsset(currentClip.artifactId) : null
  const finalAsset = goal.finalArtifactId ? resolveAsset(goal.finalArtifactId) : null
  const canFinish = Boolean(sourceId) && Boolean(sourceAsset?.mediaUrl) && !dirty && !disabled && !running && !finishing && (goal.status === 'review' || goal.status === 'completed' || finishFailed)
  const totalSeconds = goalPlanSeconds(plan)
  const notes = goal.notes ?? []
  const beatLimit = Math.min(15, 60 - totalSeconds)
  const canAddBeat = plan.segments.length < 4 && beatLimit >= 2
  const saved = async () => dirty ? shortSnapshot(await onAction({ action: 'update', revision: goal.revision, plan: draft })) : goal
  const revisingName = (stage: GoalGenerationStage, index: number) => ({ storyboards: `the clean-up of storyboard ${index + 1}`, frame: 'the frame prompt', videos: `beat ${index + 1}` })[stage]
  const generate = (action: 'approve' | 'regenerate' | 'revise', stage: GoalGenerationStage, index = 0, note?: string) => onRun(async () => {
    const current = await saved()
    if (note) setRevising(revisingName(stage, index))
    try {
      await onAction({ action, revision: current.revision, stage, index, ...(note ? { feedback: note } : {}) })
    } finally {
      setRevising(null)
    }
    if (note && stage === 'frame') setFeedback('')
    if (note && stage === 'videos') setClipFeedback(current => ({ ...current, [index]: '' }))
    if (note && stage === 'storyboards') setBoardFeedback(current => ({ ...current, [index]: '' }))
  })
  const storyboard = goal.storyboard
  const storyboardClean = goalStoryboardClean(goal)
  const cleanFirst = storyboard?.frames[0]?.clean ?? null
  const tabs = plan.version === 4 ? LEGACY_TABS : storyboard ? STORYBOARD_TABS : CURRENT_TABS
  const frameImages = plan.version === 4 ? [...plan.character.references, ...plan.frame.references] : plan.sourceImages
  const versions = (stage: GoalGenerationStage, index: number, label: string) => goalStillVersions(goal, stage, index).map((version, position, all) => {
    const asset = version.artifactId ? resolveAsset(version.artifactId) : null
    const name = `v${all.length - position}`
    return <button key={`${version.chainId}:${version.stepId}`} type="button" className="goal-version" aria-label={`${label} ${name}`} aria-pressed={version.current} disabled={disabled || !version.artifactId || version.status !== 'completed'} onClick={() => { if (version.artifactId) onRun(() => onAction({ action: 'select', revision: goal.revision, stage, index, artifact_id: version.artifactId })) }}>
      {(asset?.thumbnailUrl ?? asset?.mediaUrl) && <img src={asset.thumbnailUrl ?? asset.mediaUrl ?? ''} alt="" />}<span>{name}</span>
    </button>
  })
  return <div className="goal-editor goal-simple goal-short" data-review={view}>
    <nav className="goal-stage-tabs" aria-label="Short stages">
      {tabs.map(([id, label]) => <button key={id} type="button" className="goal-panel-button" aria-pressed={view === id} onClick={() => onView(id)}>{label}</button>)}
    </nav>
    <p className="goal-panel-muted">{plan.segments.length === 1 ? '1 clip' : `${plan.segments.length} clips`} · {totalSeconds}s · {plan.aspectRatio} · {storyboard ? 'Nano Banana 2.1 storyboard clean-up · ' : ''}GPT Image 2.6 frame · H3 Max video</p>
    {notes.length > 0 && <ul className="goal-short-notes" aria-label="Notes">{notes.map((note, index) => <li key={`${index}:${note}`}>{note}</li>)}</ul>}
    {running && <p role="status">{RUNNING[goal.stage === 'storyboards' || goal.stage === 'frame' ? goal.stage : 'videos']}</p>}
    {revising && <p role="status">Writing your feedback into {revising}, then generating…</p>}
    {view === 'character' && plan.version === 4 && <>
      <p className="goal-panel-muted">This short was saved with a character. The name, description and pictures stay as they were.</p>
      <div className="goal-reference-grid" aria-label="Character references">{plan.character.references.map(reference => <GoalMedia key={reference.slot} artifactId={reference.artifactId} cellId={reference.cellId} label={`${reference.slot} · ${reference.address}`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />)}</div>
      {plan.character.references.length === 0 && <p className="goal-panel-muted">No reference image was saved with this short.</p>}
      <p aria-label="Character name">{plan.character.name}</p>
      <p aria-label="Character description">{plan.character.description}</p>
    </>}
    {view === 'storyboard' && storyboard && <>
      <p className="goal-panel-muted">{storyboard.frames.length === 1 ? 'A frame' : `${storyboard.frames.length} frames`} of {storyboard.video.label}{storyboard.video.address ? ` (${storyboard.video.address})` : ''}, in order. The clean-up removes what was drawn on top of the picture, such as captions, stickers, logos, credits and shade, and the frame is made from clean storyboard frame 1.</p>
      <ol className="goal-short-segments" aria-label="Storyboard frames">{storyboard.frames.map(frame => {
        const name = `Storyboard ${frame.index + 1}`
        const clean = frame.clean
        const state = clean ? 'Clean' : running && goal.stage === 'storyboards' ? 'Cleaning' : 'Not cleaned'
        const price = shortEstimateText(frame.estimate ?? undefined)
        return <li key={frame.index} className="goal-short-segment" data-state={clean ? 'done' : 'pending'}>
          <div className="goal-short-segment-head"><strong>{name}</strong><span>{formatShortSeconds(frame.atSeconds)} s</span><span>{state}</span><span>{price}</span></div>
          <div className="goal-storyboard-pair">
            <GoalMedia artifactId={frame.raw.artifactId} cellId={frame.raw.cellId} label={`${name} before · ${frame.raw.address}`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />
            {clean
              ? <GoalMedia artifactId={clean.artifactId} cellId={clean.cellId} label={`${name} after${clean.address ? ` · ${clean.address}` : ''}`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />
              : <span className="goal-media goal-media-pending">Not cleaned yet</span>}
          </div>
          {clean && <div className="goal-versions" aria-label={`${name} versions`}>{versions('storyboards', frame.index, name)}</div>}
          {clean && <button type="button" className="goal-panel-button" disabled={!canGenerate} onClick={() => generate('regenerate', 'storyboards', frame.index)}>Regenerate storyboard {frame.index + 1} · {price}</button>}
          {clean && <label><span>Revise storyboard {frame.index + 1}</span><textarea aria-label={`${name} feedback`} value={boardFeedback[frame.index] ?? ''} maxLength={2000} rows={2} disabled={!canGenerate} onChange={event => setBoardFeedback(current => ({ ...current, [frame.index]: event.target.value }))} /></label>}
          {clean && <button type="button" className="goal-panel-button" disabled={!canGenerate || !boardFeedback[frame.index]?.trim()} onClick={() => generate('revise', 'storyboards', frame.index, boardFeedback[frame.index]?.trim())}>Revise storyboard {frame.index + 1} · {price}</button>}
        </li>
      })}</ol>
    </>}
    {view === 'frame' && <>
      <div className="goal-reference-grid" aria-label={plan.version === 4 || storyboard ? 'Frame references' : 'Source images'}>
        {frameImages.map(ref => <GoalMedia key={ref.slot} artifactId={ref.artifactId} cellId={ref.cellId} label={`${ref.slot} · ${ref.address}`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />)}
        {cleanFirst && <GoalMedia artifactId={cleanFirst.artifactId} cellId={cleanFirst.cellId} label={`@image${frameImages.length + 1} · storyboard 1`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />}
      </div>
      {storyboard && !storyboardClean && <p role="note" className="goal-panel-muted">{STORYBOARD_FIRST}</p>}
      {frameOutput && <GoalMedia artifactId={frameOutput.artifactId} cellId={frameOutput.cellId} label="Frame" resolveAsset={resolveAsset} onOpen={onPreviewCell} />}
      {frameOutput?.stale && <p role="status" className="goal-panel-warning">{frameOutput.stale}</p>}
      {frameOutput && <div className="goal-versions" aria-label="Frame versions">{versions('frame', 0, 'Frame')}</div>}
      {frameOutput && <RealismCheck name="frame" check={frameOutput.realism} disabled={disabled} onCheck={() => onRun(() => onAction({ action: 'check', stage: 'frame', index: 0 }))} />}
      {frameOutput && <p className="goal-panel-muted">{REALISM_NOTE}</p>}
      <label><span>Title</span><input aria-label="Short title" value={title} maxLength={120} disabled={disabled || finishing} onChange={event => setTitle(event.target.value)} /></label>
      <GoalPromptInput label="Frame prompt" value={framePrompt} wordLimit={SHORT_WORD_CEILINGS.frame} disabled={disabled || finishing} onChange={setFramePrompt} />
      <AlwaysAdded lines={[plan.rules.frame]} />
      {frameOutput && <label><span>Revise the frame</span><textarea aria-label="Frame feedback" value={feedback} maxLength={2000} rows={2} disabled={disabled || !canGenerate} onChange={event => setFeedback(event.target.value)} /></label>}
    </>}
    {view === 'video' && <>
      {currentClip && clipAsset?.mediaUrl
        ? <video className="goal-video-preview" aria-label="Current clip" src={clipAsset.mediaUrl} poster={clipAsset.thumbnailUrl ?? undefined} controls preload="metadata" />
        : currentClip && <GoalMedia artifactId={currentClip.artifactId} cellId={currentClip.cellId} label="Current clip" resolveAsset={resolveAsset} onOpen={onPreviewCell} />}
      <ol className="goal-short-segments" aria-label="Clips">{plan.segments.map((segment, index) => {
        const output = clips.find(clip => clip.index === index)
        const stale = goalStillStale(goal, 'videos', index)
        const state = stale ? 'Out of date' : output ? 'Ready' : running && goal.stage === 'videos' ? 'Waiting' : 'Not generated'
        return <li key={index} className="goal-short-segment" data-state={stale ? 'stale' : output ? 'done' : 'pending'}>
          <div className="goal-short-segment-head"><strong>Clip {index + 1}</strong><span>{segment.seconds}s</span><span>{state}</span><span>{shortEstimateText(goal.estimate.segments?.[index])}</span></div>
          <GoalPromptInput label={`Beat ${index + 1}`} value={beats[index] ?? ''} wordLimit={SHORT_WORD_CEILINGS.beat} disabled={disabled || finishing} onChange={value => setBeats(current => current.map((item, position) => position === index ? value : item))} />
          {stale && <p role="status" className="goal-panel-warning">{stale}</p>}
          {output && <div className="goal-versions" aria-label={`Clip ${index + 1} versions`}>{versions('videos', index, `Clip ${index + 1}`)}</div>}
          {output && <button type="button" className="goal-panel-button" disabled={!canGenerate} onClick={() => generate('regenerate', 'videos', index)}>Regenerate clip {index + 1}</button>}
          {output && <label><span>Revise clip {index + 1}</span><textarea aria-label={`Clip ${index + 1} feedback`} value={clipFeedback[index] ?? ''} maxLength={2000} rows={2} disabled={!canGenerate} onChange={event => setClipFeedback(current => ({ ...current, [index]: event.target.value }))} /></label>}
          {output && <button type="button" className="goal-panel-button" disabled={!canGenerate || !clipFeedback[index]?.trim()} onClick={() => generate('revise', 'videos', index, clipFeedback[index]?.trim())}>Revise clip {index + 1} · {shortEstimateText(goal.estimate.segments?.[index])}</button>}
          {output && <RealismCheck name={`clip ${index + 1}`} check={output.realism} disabled={disabled} onCheck={() => onRun(() => onAction({ action: 'check', stage: 'videos', index }))} />}
        </li>
      })}</ol>
      {clips.length > 0 && <p className="goal-panel-muted">{REALISM_NOTE}</p>}
      <AlwaysAdded lines={[plan.rules.video, plan.rules.silence]} />
      {!frameOutput && <p className="goal-panel-muted">Generate the frame before the clip.</p>}
      {canAddBeat && <fieldset className="goal-short-add">
        <legend>Add a beat</legend>
        <GoalPromptInput label="New beat" value={beat.prompt} wordLimit={SHORT_WORD_CEILINGS.beat} disabled={disabled || running} onChange={prompt => setBeat({ ...beat, prompt })} />
        <label><span>Seconds</span><input aria-label="New beat seconds" type="number" min={2} max={beatLimit} value={beat.seconds} disabled={disabled || running} onChange={event => setBeat({ ...beat, seconds: Number(event.target.value) })} /></label>
        <button type="button" className="goal-panel-button" disabled={disabled || running || !beat.prompt.trim() || beat.seconds < 2 || beat.seconds > beatLimit || !Number.isInteger(beat.seconds)} onClick={() => onRun(async () => {
          const current = await saved()
          await onAction({ action: 'update', revision: current.revision, plan: { ...draft, segments: [...draft.segments, { prompt: beat.prompt.trim(), seconds: beat.seconds }] } })
          setBeat({ prompt: '', seconds: 5 })
        })}>Add beat</button>
      </fieldset>}
    </>}
    {view === 'finish' && <>
      {!sourceId && <p className="goal-panel-muted">Generate every clip before finishing the short.</p>}
      {finishing && <p role="status">Burning the saved watermark onto the reviewed take.</p>}
      {finishFailed && <p role="alert">{goal.finish?.error ?? 'Finishing failed'}</p>}
      {goal.finalArtifactId && finalAsset?.mediaUrl && <video className="goal-video-preview" aria-label="Finished short" src={finalAsset.mediaUrl} poster={finalAsset.thumbnailUrl ?? undefined} controls preload="metadata" />}
      {!finishing && !goal.finalArtifactId && sourceAsset?.mediaUrl && <video className="goal-video-preview" aria-label="Reviewed take" src={sourceAsset.mediaUrl} poster={sourceAsset.thumbnailUrl ?? undefined} controls preload="metadata" />}
      <p className="goal-panel-muted">Finish keeps the reviewed take and burns the saved watermark.</p>
      {!finishing && sourceId && !sourceAsset?.mediaUrl && <p role="status">The short is not playable yet.</p>}
    </>}
    <div className="goal-panel-bar">
      <div className="goal-panel-bar-copy"><span>{dirty ? 'Saving keeps the settings with this short.' : 'Each paid step needs its own approval.'}</span></div>
      {dirty && <button type="button" className="goal-panel-button" disabled={disabled || !promptsReady || finishing} onClick={() => onRun(() => onAction({ action: 'update', revision: goal.revision, plan: draft }))}>Save</button>}
      {view === 'storyboard' && goal.status === 'review' && goal.stage === 'storyboards' && <button type="button" className="goal-panel-primary" disabled={!canGenerate} onClick={() => generate('approve', 'storyboards')}>Remove on-screen graphics · {shortEstimateText(goalStoryboardEstimate(goal))}</button>}
      {view === 'frame' && goal.status === 'review' && frameOutput && feedback.trim() && <button type="button" className="goal-panel-button" disabled={!canGenerate} onClick={() => generate('revise', 'frame', 0, feedback.trim())}>Revise frame</button>}
      {view === 'frame' && goal.status === 'review' && <button type="button" className="goal-panel-primary" disabled={!canGenerate || !storyboardClean} onClick={() => generate(frameOutput ? 'regenerate' : 'approve', 'frame')}>{frameOutput ? 'Regenerate frame' : 'Generate frame'} · {shortEstimateText(goal.estimate.frame)}</button>}
      {view === 'video' && goal.status === 'review' && next !== null && <button type="button" className="goal-panel-primary" disabled={!canGenerate || !frameOutput} onClick={() => generate('approve', 'videos', next)}>{next === 0 ? 'Generate clip' : `Continue · clip ${next + 1}`} · {shortEstimateText(goal.estimate.segments?.[next])}</button>}
      {view === 'finish' && !finishing && (goal.status === 'review' || goal.status === 'completed' || finishFailed) && <button type="button" className="goal-panel-primary" disabled={!canFinish} onClick={() => onRun(() => onAction({ action: 'finish' }))}>Finish</button>}
      {goalCanRetry(goal) && <button type="button" className="goal-panel-primary" disabled={disabled} onClick={() => onRun(() => onAction({ action: 'retry' }))}>Retry</button>}
    </div>
  </div>
}
