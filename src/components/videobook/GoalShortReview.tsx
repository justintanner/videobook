import { useState } from 'react'
import {
  formatShortSeconds, shortGenerationSegments, shortFinishTitleInput, shortFinishTitleIssue, shortRemixOf, SHORT_STORYBOARD_MODEL_TITLES, SHORT_WORD_CEILINGS, withShortFinishTitle, type GoalShortPlan, type ShortFinishTitle,
} from '../../../server/src/goal-short-plan'
import type { GoalGenerationStage } from '../../../server/src/goal-store'
import { remixAssemblyReviewKey, remixPromptFindings } from '../../../server/src/goal-remix-model'
import type { AssetRecord } from '@/videobook/workspace-responses'
import {
  goalCanRetry, goalNextSegment, goalPlanSeconds, goalStillStale, goalStillVersions, goalStoryboardClean, goalStoryboardEstimate, goalStoryboardRetry, shortEstimateText,
  type GoalSnapshot, type ShortGoalSnapshot, type ShortTab,
} from '@/videobook/goals'
import { GoalFinishTitle } from './GoalFinishTitle'
import { GoalPromptInput } from './GoalPromptInput'
import { GoalMedia } from './GoalStillCard'
import { GoalInitialAnalysis } from './GoalInitialAnalysis'
import { GoalSourcePreparation } from './GoalSourcePreparation'
import { GoalActionWindow } from './GoalActionWindow'

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
  titleOptions: readonly ShortFinishTitle[]
  onWriteTitle: () => Promise<unknown>
}

const CURRENT_TABS = [['frame', 'Frame'], ['video', 'Video'], ['finish', 'Finish']] as const
const REMIX_TABS = [['replacement', 'Replace character'], ['frame', 'Twist'], ['video', 'Video'], ['finish', 'Finish']] as const
const INSERT_TABS = [['replacement', 'Insert character'], ['frame', 'Action setup'], ['video', 'Video'], ['finish', 'Finish']] as const
const STORYBOARD_TABS = [['storyboard', 'Storyboard'], ['frame', 'Frame'], ['video', 'Video'], ['finish', 'Finish']] as const
const LEGACY_TABS = [['character', 'Character'], ['frame', 'Frame'], ['video', 'Video'], ['finish', 'Finish']] as const
const STORYBOARD_FIRST = 'Remove the on-screen graphics from the storyboard first: the frame is made from clean storyboard frame 1.'
const RUNNING: Record<GoalGenerationStage, string> = {
  storyboards: 'Removing the on-screen graphics from the storyboard.',
  replacement: 'Replacing the character and clearing on-screen graphics.',
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

export function GoalShortReview({ goal, plan, view, disabled, resolveAsset, onView, onPreviewCell, onRun, onAction, titleOptions, onWriteTitle }: ShortReviewProps) {
  const remix = shortRemixOf(plan)
  const [analysis, setAnalysis] = useState(plan.version === 5 ? plan.analysis : undefined)
  const [title, setTitle] = useState(plan.title)
  const [burnedTitle, setBurnedTitle] = useState(plan.finish.title?.headline ?? '')
  const [englishLine, setEnglishLine] = useState(plan.finish.title?.secondary ?? '')
  const [framePrompt, setFramePrompt] = useState(plan.frame.prompt)
  const [replacementPrompt, setReplacementPrompt] = useState(remix?.replacement.prompt ?? '')
  const [beats, setBeats] = useState(() => plan.segments.map(segment => segment.prompt))
  const [feedback, setFeedback] = useState('')
  const [replacementFeedback, setReplacementFeedback] = useState('')
  const [clipFeedback, setClipFeedback] = useState<Record<number, string>>({})
  const [boardFeedback, setBoardFeedback] = useState<Record<number, string>>({})
  const [revising, setRevising] = useState<string | null>(null)
  const [beat, setBeat] = useState({ prompt: '', seconds: 5 })
  const nextTitle = title.trim()
  const nextFrame = framePrompt.trim()
  const nextSegments = plan.segments.map((segment, index) => ({ ...segment, prompt: (beats[index] ?? '').trim() }))
  const typedTitle = shortFinishTitleInput(burnedTitle, englishLine)
  const titleIssue = shortFinishTitleIssue(typedTitle)
  const edited: GoalShortPlan = plan.version === 4
    ? { ...plan, title: nextTitle, frame: { ...plan.frame, prompt: nextFrame }, segments: nextSegments }
    : { ...plan, title: nextTitle, ...(plan.remix ? { remix: { ...plan.remix, replacement: { ...plan.remix.replacement, prompt: replacementPrompt.trim() } } } : {}), frame: { ...plan.frame, prompt: nextFrame }, segments: nextSegments, ...(analysis ? { analysis } : {}) }
  const draft = withShortFinishTitle(edited, typedTitle)
  const generationSegments = shortGenerationSegments(draft)
  const assembly = analysis?.recipe.assembly
  const dirty = JSON.stringify(draft) !== JSON.stringify(plan)
  const promptsReady = Boolean(draft.title && draft.frame.prompt && (!remix || replacementPrompt.trim()) && draft.segments.every(segment => segment.prompt) && generationSegments.every(segment => segment.prompt)) && titleIssue === null
  const frameOutput = goal.stages.frame?.outputs[0]
  const replacementOutput = goal.stages.replacement?.outputs[0]
  const replacing = view === 'replacement'
  const imageStage = replacing ? 'replacement' : 'frame'
  const inserting = analysis?.intent.character === 'insert'
  const imageName = replacing ? inserting ? 'Insertion' : 'Replacement' : remix ? analysis ? 'Action setup' : 'Twist' : 'Frame'
  const imageOutput = replacing ? replacementOutput : frameOutput
  const imageFeedback = replacing ? replacementFeedback : feedback
  const imageEstimate = replacing ? goal.estimate.replacement : goal.estimate.frame
  const replacementReady = !remix || Boolean(replacementOutput && !replacementOutput.stale)
  const frameReady = Boolean(frameOutput && !frameOutput.stale) && replacementReady
  const clips = [...(goal.stages.videos?.outputs ?? [])].sort((left, right) => left.index - right.index)
  const currentClip = assembly ? clips.find(clip => clip.index === 0) ?? null : clips.at(-1) ?? null
  const next = goalNextSegment(goal, plan)
  const running = goal.status === 'running'
  const finishing = goal.finish?.status === 'running'
  const finishFailed = goal.finish?.status === 'failed'
  const analysisErrors = analysis ? [...analysis.findings.filter(finding => finding.severity === 'error' && !finding.code.startsWith('conflicting-')), ...remixPromptFindings(analysis, [nextFrame, replacementPrompt, ...nextSegments.map(segment => segment.prompt), ...Object.values(draft.rules)])] : []
  const sourceReady = !analysis?.source || analysis.recipe.cleanupConfirmed && Boolean(analysis.recipe.preparedArtifactId) && analysis.recipe.cleanupReviewedHash === analysis.recipe.preparedMediaHash
  const canGenerate = goal.status === 'review' && promptsReady && sourceReady && analysisErrors.length === 0 && !disabled && !running && !finishing
  const sourceId = next === null ? goal.finish?.sourceArtifactId ?? currentClip?.artifactId ?? null : null
  const sourceAsset = sourceId ? resolveAsset(sourceId) : null
  const clipAsset = currentClip ? resolveAsset(currentClip.artifactId) : null
  const finalAsset = goal.finalArtifactId ? resolveAsset(goal.finalArtifactId) : null
  const actionReviewed = !assembly || Boolean(analysis && goal.actionWindow && goal.actionWindow.artifactId === currentClip?.artifactId && goal.actionWindow.mediaHash === clipAsset?.objectHash && goal.actionWindow.recipeKey === remixAssemblyReviewKey(analysis))
  const canFinish = actionReviewed && Boolean(sourceId) && Boolean(sourceAsset?.mediaUrl) && (!remix || frameReady) && !dirty && !disabled && !running && !finishing && (goal.status === 'review' || goal.status === 'completed' || finishFailed)
  const totalSeconds = goalPlanSeconds(plan)
  const notes = goal.notes ?? []
  const beatLimit = Math.min(15, 60 - totalSeconds)
  const canAddBeat = !assembly && plan.segments.length < 4 && beatLimit >= 2
  const saved = async () => dirty ? shortSnapshot(await onAction({ action: 'update', revision: goal.revision, plan: draft })) : goal
  const revisingName = (stage: GoalGenerationStage, index: number) => ({ storyboards: `the clean-up of storyboard ${index + 1}`, replacement: 'the character replacement', frame: remix ? 'the twist' : 'the frame prompt', videos: `beat ${index + 1}` })[stage]
  const generate = (action: 'approve' | 'regenerate' | 'revise', stage: GoalGenerationStage, index = 0, note?: string, model?: string) => onRun(async () => {
    const current = await saved()
    if (note) setRevising(revisingName(stage, index))
    try {
      await onAction({ action, revision: current.revision, stage, index, ...(note ? { feedback: note } : {}), ...(model ? { model } : {}) })
    } finally {
      setRevising(null)
    }
    if (note && stage === 'frame') setFeedback('')
    if (note && stage === 'replacement') setReplacementFeedback('')
    if (note && stage === 'videos') setClipFeedback(current => ({ ...current, [index]: '' }))
    if (note && stage === 'storyboards') setBoardFeedback(current => ({ ...current, [index]: '' }))
  })
  const storyboard = goal.storyboard
  const storyboardClean = goalStoryboardClean(goal)
  const cleanFirst = storyboard?.frames[0]?.clean ?? null
  const tabs = plan.version === 4 ? LEGACY_TABS : remix ? inserting ? INSERT_TABS : REMIX_TABS : storyboard ? STORYBOARD_TABS : CURRENT_TABS
  const frameImages = plan.version === 4 ? [...plan.character.references, ...plan.frame.references] : plan.sourceImages
  const versions = (stage: GoalGenerationStage, index: number, label: string) => goalStillVersions(goal, stage, index).map((version, position, all) => {
    const asset = version.artifactId ? resolveAsset(version.artifactId) : null
    const name = `v${all.length - position}`
    return <button key={`${version.chainId}:${version.stepId}`} type="button" className="goal-version" aria-label={`${label} ${name}`} aria-pressed={version.current} disabled={disabled || !version.artifactId || version.status !== 'completed'} onClick={() => { if (version.artifactId) onRun(() => onAction({ action: 'select', revision: goal.revision, stage, index, artifact_id: version.artifactId })) }}>
      {(asset?.thumbnailUrl ?? asset?.mediaUrl) && <img src={asset.thumbnailUrl ?? asset.mediaUrl ?? ''} alt="" />}<span>{name}</span>
    </button>
  })
  return <div className="goal-editor goal-simple goal-short" data-review={view}>
    {analysis && <GoalInitialAnalysis analysis={analysis} estimate={goal.estimate.total} disabled={disabled || running || finishing} onChange={setAnalysis}
      onSaveDefaults={() => onRun(async () => { const current = await saved(); return onAction({ action: 'save_defaults', revision: current.revision }) })}
      onAnalyze={() => onRun(async () => { const current = await saved(); return onAction({ action: 'analyze', revision: current.revision }) })} />}
    {analysis && <GoalSourcePreparation analysis={analysis} preparation={goal.preparation} disabled={disabled || running || finishing || goal.status === 'cancelled'} resolveAsset={resolveAsset}
      onPrepare={preparation => onRun(async () => { const current = await saved(); return onAction({ action: 'prepare', revision: current.revision, preparation }) })}
      onReview={(artifactId, mediaHash) => onRun(async () => { const current = await saved(); return onAction({ action: 'review_source', revision: current.revision, artifact_id: artifactId, media_hash: mediaHash, confirmed: true }) })} />}
    <nav className="goal-stage-tabs" aria-label="Short stages">
      {tabs.map(([id, label]) => <button key={id} type="button" className="goal-panel-button" aria-pressed={view === id} onClick={() => onView(id)}>{label}</button>)}
    </nav>
    {remix && <p className="goal-panel-muted">{analysis ? 'Source analysis → character reference → action setup → video. The saved plan controls the entrance and action timing.' : 'One source frame → replace character → funny, realistic twist → video. Review each edit before continuing.'}</p>}
    <p className="goal-panel-muted">{generationSegments.length === 1 ? '1 generated clip' : `${generationSegments.length} clips`} · {totalSeconds}s · {plan.aspectRatio} · {storyboard ? `${SHORT_STORYBOARD_MODEL_TITLES[storyboard.model]} storyboard clean-up · ` : ''}GPT Image 2.6 frame · H3 Max video</p>
    {notes.length > 0 && <ul className="goal-short-notes" aria-label="Notes">{notes.map((note, index) => <li key={`${index}:${note}`}>{note}</li>)}</ul>}
    {running && <p role="status">{analysis && remix ? `Generating the ${goal.stage === 'replacement' ? 'character image' : goal.stage === 'frame' ? 'action setup' : 'video'}.` : remix && goal.stage === 'frame' ? 'Adding the twist to the reviewed replacement.' : RUNNING[goal.stage === 'assembly' ? 'videos' : goal.stage]}</p>}
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
        const failure = frame.failure
        const failed = failure?.kind === 'failed'
        const redo = Boolean(clean) || failed
        const retry = goalStoryboardRetry(goal, frame.index)
        const state = clean ? 'Clean' : failure ? failed ? 'Failed' : 'Not run' : running && goal.stage === 'storyboards' ? 'Cleaning' : 'Not cleaned'
        const price = shortEstimateText(frame.estimate ?? undefined)
        return <li key={frame.index} className="goal-short-segment" data-state={clean ? 'done' : failed ? 'failed' : 'pending'}>
          <div className="goal-short-segment-head"><strong>{name}</strong><span>{formatShortSeconds(frame.atSeconds)} s</span><span>{state}</span><span>{price}</span></div>
          <div className="goal-storyboard-pair">
            <GoalMedia artifactId={frame.raw.artifactId} cellId={frame.raw.cellId} label={`${name} before · ${frame.raw.address}`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />
            {clean
              ? <GoalMedia artifactId={clean.artifactId} cellId={clean.cellId} label={`${name} after${clean.address ? ` · ${clean.address}` : ''}`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />
              : <span className="goal-media goal-media-pending">{failed ? 'Clean-up failed' : failure ? 'Not run' : 'Not cleaned yet'}</span>}
          </div>
          {failure && <p role={failed ? 'alert' : undefined} className={failed ? 'goal-panel-warning' : 'goal-panel-muted'}>{failure.message}</p>}
          {clean && <div className="goal-versions" aria-label={`${name} versions`}>{versions('storyboards', frame.index, name)}</div>}
          {retry && <button type="button" className="goal-panel-button" disabled={!canGenerate} onClick={() => generate('regenerate', 'storyboards', frame.index, undefined, retry.other.model)}>Clean with {retry.other.title} · {shortEstimateText(retry.other.estimate)}</button>}
          {retry && <button type="button" className="goal-panel-button" disabled={!canGenerate} onClick={() => generate('regenerate', 'storyboards', frame.index, undefined, retry.same.model)}>Try again with {retry.same.title} · {shortEstimateText(retry.same.estimate)}</button>}
          {redo && !retry && <button type="button" className="goal-panel-button" disabled={!canGenerate} onClick={() => generate('regenerate', 'storyboards', frame.index)}>Regenerate storyboard {frame.index + 1} · {price}</button>}
          {redo && <label><span>Revise storyboard {frame.index + 1}</span><textarea aria-label={`${name} feedback`} value={boardFeedback[frame.index] ?? ''} maxLength={2000} rows={2} disabled={!canGenerate} onChange={event => setBoardFeedback(current => ({ ...current, [frame.index]: event.target.value }))} /></label>}
          {redo && <button type="button" className="goal-panel-button" disabled={!canGenerate || !boardFeedback[frame.index]?.trim()} onClick={() => generate('revise', 'storyboards', frame.index, boardFeedback[frame.index]?.trim())}>Revise storyboard {frame.index + 1} · {price}</button>}
        </li>
      })}</ol>
    </>}
    {(view === 'frame' || replacing && remix) && <>
      <div className="goal-reference-grid" aria-label={plan.version === 4 || storyboard ? 'Frame references' : 'Source images'}>
        {(!remix || replacing) && frameImages.map(ref => <GoalMedia key={ref.slot} artifactId={ref.artifactId} cellId={ref.cellId} label={`${ref.slot} · ${ref.address}`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />)}
        {remix && replacing && <GoalMedia artifactId={remix.frame.artifactId} cellId={remix.frame.cellId} label={`Extracted source frame · ${formatShortSeconds(remix.frame.atSeconds)} s`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />}
        {remix && !replacing && replacementOutput && <GoalMedia artifactId={replacementOutput.artifactId} cellId={replacementOutput.cellId} label="Reviewed replacement" resolveAsset={resolveAsset} onOpen={onPreviewCell} />}
        {cleanFirst && <GoalMedia artifactId={cleanFirst.artifactId} cellId={cleanFirst.cellId} label={`@image${frameImages.length + 1} · storyboard 1`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />}
      </div>
      {storyboard && !storyboardClean && <p role="note" className="goal-panel-muted">{STORYBOARD_FIRST}</p>}
      {remix && <p className="goal-panel-muted">{analysis ? replacing ? `${inserting ? 'Insert' : 'Replace'} the person while keeping the scene and physical props. The video performs the planned action.` : replacementReady ? 'Prepare the starting pose for the action. Keep the reviewed identity and surroundings.' : 'Review the character image before preparing the action.' : replacing ? 'Replace the main person and remove added text, stickers, credits and shade. Keep the scene and props for the next edit.' : replacementReady ? 'Add one funny, physically believable change to the reviewed replacement. Keep the same person and surroundings.' : 'Review the character replacement before adding the twist.'}</p>}
      {imageOutput && <GoalMedia artifactId={imageOutput.artifactId} cellId={imageOutput.cellId} label={imageName} resolveAsset={resolveAsset} onOpen={onPreviewCell} />}
      {imageOutput?.stale && <p role="status" className="goal-panel-warning">{imageOutput.stale}</p>}
      {imageOutput && <div className="goal-versions" aria-label={`${imageName} versions`}>{versions(imageStage, 0, imageName)}</div>}
      {imageOutput && !replacing && <RealismCheck name={imageName.toLowerCase()} check={imageOutput.realism} disabled={disabled} onCheck={() => onRun(() => onAction({ action: 'check', stage: 'frame', index: 0 }))} />}
      {imageOutput && !replacing && <p className="goal-panel-muted">{REALISM_NOTE}</p>}
      <label><span>Title</span><input aria-label="Short title" value={title} maxLength={120} disabled={disabled || finishing} onChange={event => setTitle(event.target.value)} /></label>
      <GoalPromptInput label={`${imageName} prompt`} value={replacing ? replacementPrompt : framePrompt} wordLimit={SHORT_WORD_CEILINGS.frame} disabled={disabled || finishing} onChange={replacing ? setReplacementPrompt : setFramePrompt} />
      {!replacing && <AlwaysAdded lines={[plan.rules.frame]} />}
      {imageOutput && <label><span>Revise the {imageName.toLowerCase()}</span><textarea aria-label={`${imageName} feedback`} value={imageFeedback} maxLength={2000} rows={2} disabled={disabled || !canGenerate} onChange={event => (replacing ? setReplacementFeedback : setFeedback)(event.target.value)} /></label>}
    </>}
    {view === 'video' && <>
      {remix && <>
        <div className="goal-reference-grid" aria-label="Video references">
          {analysis?.recipe.referenceArtifactId ? <div className="goal-prepared-preview">
            <video controls playsInline preload="metadata" src={resolveAsset(analysis.recipe.referenceArtifactId)?.mediaUrl ?? undefined} aria-label="Video generation reference" />
            <span>@video1 · {analysis.recipe.preparedArtifactId && analysis.intent.cleanup !== 'keep' ? 'Prepared' : 'Source'} video reference</span>
          </div> : <GoalMedia artifactId={remix.video.artifactId} cellId={remix.video.cellId} label={`@video1 · Source video${remix.video.address ? ` · ${remix.video.address}` : ''}`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />}
          {frameOutput && <GoalMedia artifactId={frameOutput.artifactId} cellId={frameOutput.cellId} label="@image1 · Reviewed twist" resolveAsset={resolveAsset} onOpen={onPreviewCell} />}
        </div>
        <p className="goal-panel-muted">Use the source video for movement and setting, and the reviewed twist for appearance. The beat controls when the character and twist appear.</p>
      </>}
      {!assembly && currentClip && clipAsset?.mediaUrl
        ? <video className="goal-video-preview" aria-label="Current clip" src={clipAsset.mediaUrl} poster={clipAsset.thumbnailUrl ?? undefined} controls preload="metadata" />
        : !assembly && currentClip && <GoalMedia artifactId={currentClip.artifactId} cellId={currentClip.cellId} label="Current clip" resolveAsset={resolveAsset} onOpen={onPreviewCell} />}
      <ol className="goal-short-segments" aria-label="Clips">{generationSegments.map((segment, index) => {
        const output = clips.find(clip => clip.index === index)
        const stale = goalStillStale(goal, 'videos', index)
        const state = stale ? 'Out of date' : output ? 'Ready' : running && goal.stage === 'videos' ? 'Waiting' : 'Not generated'
        return <li key={index} className="goal-short-segment" data-state={stale ? 'stale' : output ? 'done' : 'pending'}>
          <div className="goal-short-segment-head"><strong>Clip {index + 1}</strong><span>{segment.seconds}s</span><span>{state}</span><span>{shortEstimateText(goal.estimate.segments?.[index])}</span></div>
          <GoalPromptInput label={assembly ? 'Changed action prompt' : `Beat ${index + 1}`} value={assembly ? analysis?.intent.actionDescription ?? '' : beats[index] ?? ''} wordLimit={SHORT_WORD_CEILINGS.beat} disabled={disabled || finishing} onChange={value => assembly && analysis ? setAnalysis({ ...analysis, intent: { ...analysis.intent, actionDescription: value } }) : setBeats(current => current.map((item, position) => position === index ? value : item))} />
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
      {!frameOutput && <p className="goal-panel-muted">{remix ? 'Review the twist before making the video.' : 'Generate the frame before the clip.'}</p>}
      {assembly && <details><summary>Full-video context</summary>{plan.segments.map((segment, index) => <p key={index}>{segment.prompt}</p>)}</details>}
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
      {finishing && <p role="status">{assembly ? 'Assembling the reviewed source and action, then applying the saved finish.' : 'Burning the saved watermark onto the reviewed take.'}</p>}
      {finishFailed && <p role="alert">{goal.finish?.error ?? 'Finishing failed'}</p>}
      {goal.finalArtifactId && finalAsset?.mediaUrl && <video className="goal-video-preview" aria-label="Finished short" src={finalAsset.mediaUrl} poster={finalAsset.thumbnailUrl ?? undefined} controls preload="metadata" />}
      {!finishing && !goal.finalArtifactId && sourceAsset?.mediaUrl && <video className="goal-video-preview" aria-label="Reviewed take" src={sourceAsset.mediaUrl} poster={sourceAsset.thumbnailUrl ?? undefined} controls preload="metadata" />}
      <p className="goal-panel-muted">{assembly ? 'Finish keeps the source shots outside the changed interval and inserts the reviewed action window, then applies the selected sound and saved watermark.' : 'Finish keeps the reviewed take and burns the saved watermark.'}</p>
      {!finishing && sourceId && !sourceAsset?.mediaUrl && <p role="status">The short is not playable yet.</p>}
      <GoalFinishTitle
        headline={burnedTitle} secondary={englishLine} slots={goal.titleSlots} estimate={goal.estimate.title} options={titleOptions} issue={titleIssue}
        disabled={disabled || finishing} onHeadline={setBurnedTitle} onSecondary={setEnglishLine} onWrite={() => onRun(onWriteTitle)}
      />
    </>}
    {(view === 'video' || view === 'finish') && assembly && analysis && currentClip && clipAsset && <GoalActionWindow
      key={`${currentClip.artifactId}:${goal.actionWindow?.reviewedAt ?? ''}`} analysis={analysis} asset={clipAsset} window={goal.actionWindow ?? null} reviewed={actionReviewed}
      disabled={disabled || running || finishing || goal.status === 'cancelled'} onReview={startSeconds => onRun(async () => {
        const current = await saved()
        return onAction({ action: 'review_action', revision: current.revision, artifact_id: currentClip.artifactId, media_hash: clipAsset.objectHash, start_seconds: startSeconds, confirmed: true })
      })} />}
    <div className="goal-panel-bar">
      <div className="goal-panel-bar-copy"><span>{dirty ? 'Saving keeps the settings with this short.' : 'Each paid step needs its own approval.'}</span></div>
      {dirty && <button type="button" className="goal-panel-button" disabled={disabled || !promptsReady || finishing} onClick={() => onRun(() => onAction({ action: 'update', revision: goal.revision, plan: draft }))}>Save</button>}
      {view === 'storyboard' && goal.status === 'review' && goal.stage === 'storyboards' && <button type="button" className="goal-panel-primary" disabled={!canGenerate} onClick={() => generate('approve', 'storyboards')}>Remove on-screen graphics · {shortEstimateText(goalStoryboardEstimate(goal))}</button>}
      {(view === 'frame' || replacing) && goal.status === 'review' && imageOutput && imageFeedback.trim() && <button type="button" className="goal-panel-button" disabled={!canGenerate || !replacing && !replacementReady} onClick={() => generate('revise', imageStage, 0, imageFeedback.trim())}>Revise {imageName.toLowerCase()}</button>}
      {(view === 'frame' || replacing) && goal.status === 'review' && <button type="button" className="goal-panel-primary" disabled={!canGenerate || !storyboardClean || !replacing && !replacementReady} onClick={() => generate(imageOutput ? 'regenerate' : 'approve', imageStage)}>{imageOutput ? `Regenerate ${imageName.toLowerCase()}` : replacing ? inserting ? 'Insert character' : 'Replace character' : remix ? analysis ? 'Prepare action' : 'Add twist' : 'Generate frame'} · {shortEstimateText(imageEstimate)}</button>}
      {view === 'video' && goal.status === 'review' && next !== null && <button type="button" className="goal-panel-primary" disabled={!canGenerate || !frameOutput || Boolean(frameOutput.stale) || !replacementReady} onClick={() => generate('approve', 'videos', next)}>{next === 0 ? 'Generate clip' : `Continue · clip ${next + 1}`} · {shortEstimateText(goal.estimate.segments?.[next])}</button>}
      {view === 'finish' && !finishing && (goal.status === 'review' || goal.status === 'completed' || finishFailed) && <button type="button" className="goal-panel-primary" disabled={!canFinish} onClick={() => onRun(() => onAction({ action: 'finish' }))}>Finish</button>}
      {goalCanRetry(goal) && <button type="button" className="goal-panel-primary" disabled={disabled} onClick={() => onRun(() => onAction({ action: 'retry' }))}>Retry</button>}
    </div>
  </div>
}
