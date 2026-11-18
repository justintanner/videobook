import { useRef, useState } from 'react'
import { X } from 'lucide-react'
import {
  SOURCE_IMAGE_LIMIT, shortGenerationSegments, shortFinishTitleInput, shortFinishTitleIssue, shortRemixOf, withShortFinishTitle, type GoalShortPlan, type ShortFinishTitle,
} from '../../../server/src/goal-short-plan'
import type { GoalGenerationStage } from '../../../server/src/goal-store'
import { remixPromptFindings } from '../../../server/src/goal-remix-model'
import type { AssetRecord } from '@/videobook/workspace-responses'
import {
  goalActionWindowReviewed, goalAssemblyClip, goalNextSegment, goalPlanSeconds, goalSourceReady, goalStoryboardClean,
  type GoalSnapshot, type ShortGoalSnapshot, type ShortView,
} from '@/videobook/goals'
import { goalNextAction, goalStepNames, goalSteps } from '@/videobook/goal-next'
import { GoalMedia } from './GoalStillCard'
import { GoalRecipe } from './GoalRecipe'
import { GoalSourcePreparation } from './GoalSourcePreparation'
import { GoalTakeHistory } from './GoalTakeHistory'
import { GoalAutomation } from './GoalAutomation'
import { GoalStepStrip } from './GoalStepStrip'
import { GoalNextBar, type GoalNextHandlers } from './GoalNextBar'
import { GoalCharacterReferences, type CharacterInputs, type CharacterSource } from './GoalCharacterReferences'
import { GoalImageStage } from './GoalImageStage'
import { GoalVideoStage } from './GoalVideoStage'
import { GoalFinishStage } from './GoalFinishStage'
import { GoalStoryboardStage } from './GoalStoryboardStage'
import { GoalNotes, type GoalStageContext } from './GoalStageParts'

type GoalAction = Record<string, unknown>
type ShortReviewProps = {
  goal: ShortGoalSnapshot
  characterInputs?: CharacterInputs
  plan: GoalShortPlan
  view: ShortView
  disabled: boolean
  connected: boolean
  error: string | null
  resolveAsset: (artifactId: string) => AssetRecord | null
  onView: (view: ShortView) => void
  onDismissError: () => void
  onPreviewCell: (cellId: string) => void
  onRun: (work: () => Promise<unknown>) => void
  onAction: (args: GoalAction) => Promise<GoalSnapshot>
  titleOptions: readonly ShortFinishTitle[]
  onWriteTitle: () => Promise<unknown>
}

function shortSnapshot(goal: GoalSnapshot): ShortGoalSnapshot {
  if (goal.legacy) throw new Error('This goal was made by an earlier /goal. Start a new /goal.')
  return goal
}

function GoalAlerts({ connected, error, onDismiss }: { connected: boolean, error: string | null, onDismiss: () => void }) {
  if (connected && !error) return null
  return <div className="goal-alerts">
    {!connected && <p role="status" className="goal-panel-muted">Reconnecting. Your goal is saved; generation continues on the server.</p>}
    {error && <p role="alert" className="goal-panel-error"><span>{error}</span><button type="button" aria-label="Dismiss error" onClick={onDismiss}><X size={12} aria-hidden="true" /></button></p>}
  </div>
}

export function GoalShortReview({ goal, characterInputs, plan, view, disabled, connected, error, resolveAsset, onView, onDismissError, onPreviewCell, onRun, onAction, titleOptions, onWriteTitle }: ShortReviewProps) {
  const remix = shortRemixOf(plan)
  const automationNode = useRef<HTMLDivElement>(null)
  const [analysis, setAnalysis] = useState(plan.version === 5 ? plan.analysis : undefined)
  const [title, setTitle] = useState(plan.title)
  const [burnedTitle, setBurnedTitle] = useState(plan.finish.title?.headline ?? '')
  const [englishLine, setEnglishLine] = useState(plan.finish.title?.secondary ?? '')
  const [framePrompt, setFramePrompt] = useState(plan.frame.prompt)
  const [replacementPrompt, setReplacementPrompt] = useState(remix?.replacement.prompt ?? '')
  const [characters, setCharacters] = useState<CharacterSource[]>(plan.version === 5 ? plan.sourceImages : [])
  const sourceImages = characters.flatMap((source, index) => {
    const matches = (image: CharacterSource) => image.cellId === source.cellId && image.artifactId === source.artifactId
    const image = (plan.version === 5 ? plan.sourceImages.find(matches) : null) ?? characterInputs?.images.find(matches)
    return image ? [{ ...image, slot: `@image${index + 1}` }] : []
  })
  const addCharacter = (source: CharacterSource) => setCharacters(current =>
    current.length >= SOURCE_IMAGE_LIMIT || current.some(image => image.artifactId === source.artifactId) ? current : [...current, source])
  const removeCharacter = (index: number) => {
    setCharacters(current => current.filter((_, position) => position !== index))
    setReplacementPrompt(current => current.replace(/(@image|\bimage\s+)(\d+)\b/giu, (match, prefix: string, number: string) => {
      const slot = Number(number)
      if (slot === index + 1) return '[removed image]'
      return slot > index + 1 ? `${prefix}${slot - 1}` : match
    }))
  }
  const [beats, setBeats] = useState(() => plan.segments.map(segment => segment.prompt))
  const [feedback, setFeedback] = useState('')
  const [replacementFeedback, setReplacementFeedback] = useState('')
  const [clipFeedback, setClipFeedback] = useState<Record<number, string>>({})
  const [boardFeedback, setBoardFeedback] = useState<Record<number, string>>({})
  const [revising, setRevising] = useState<string | null>(null)
  const [beat, setBeat] = useState({ prompt: '', seconds: 5 })
  const [windowStart, setWindowStart] = useState<number | null>(null)
  const nextTitle = title.trim()
  const nextFrame = framePrompt.trim()
  const nextSegments = plan.segments.map((segment, index) => ({ ...segment, prompt: (beats[index] ?? '').trim() }))
  const typedTitle = shortFinishTitleInput(burnedTitle, englishLine)
  const titleIssue = shortFinishTitleIssue(typedTitle)
  const edited: GoalShortPlan = plan.version === 4
    ? { ...plan, title: nextTitle, frame: { ...plan.frame, prompt: nextFrame }, segments: nextSegments }
    : { ...plan, sourceImages, title: nextTitle, ...(plan.remix ? { remix: { ...plan.remix, replacement: { ...plan.remix.replacement, prompt: replacementPrompt.trim() } } } : {}), frame: { ...plan.frame, prompt: nextFrame }, segments: nextSegments, ...(analysis ? { analysis } : {}) }
  const draft = withShortFinishTitle(edited, typedTitle)
  const generationSegments = shortGenerationSegments(draft)
  const assembly = analysis?.recipe.assembly
  const dirty = JSON.stringify(draft) !== JSON.stringify(plan)
  const characterIssue = remix && characters.length !== sourceImages.length ? 'Waiting for the character images to load.' : remix && replacementPrompt.includes('[removed image]') ? 'Edit the prompt where a character image was removed.' : null
  const promptsReady = !characterIssue && Boolean(draft.title && draft.frame.prompt && (!remix || replacementPrompt.trim()) && draft.segments.every(segment => segment.prompt) && generationSegments.every(segment => segment.prompt)) && titleIssue === null
  const replacementOutput = goal.stages.replacement?.outputs[0]
  const frameOutput = goal.stages.frame?.outputs[0]
  const replacing = view === 'replacement'
  const inserting = analysis?.intent.character === 'insert'
  const replacementReady = !remix || Boolean(replacementOutput && !replacementOutput.stale)
  const frameReady = Boolean(frameOutput && !frameOutput.stale) && replacementReady
  const clips = [...(goal.stages.videos?.outputs ?? [])].sort((left, right) => left.index - right.index)
  const currentClip = assembly ? goalAssemblyClip(goal) : clips.at(-1) ?? null
  const running = goal.status === 'running'
  const finishing = goal.finish?.status === 'running'
  const analysisErrors = analysis ? [...analysis.findings.filter(finding => finding.severity === 'error' && !finding.code.startsWith('conflicting-')), ...remixPromptFindings(analysis, [nextFrame, replacementPrompt, ...nextSegments.map(segment => segment.prompt), ...Object.values(draft.rules)])] : []
  const canGenerate = goal.status === 'review' && promptsReady && goalSourceReady(plan) && analysisErrors.length === 0 && !disabled && !running && !finishing
  const sourceId = goalNextSegment(goal, plan) === null ? goal.finish?.sourceArtifactId ?? currentClip?.artifactId ?? null : null
  const sourceAsset = sourceId ? resolveAsset(sourceId) : null
  const clipAsset = currentClip ? resolveAsset(currentClip.artifactId) : null
  const fps = assembly?.fps ?? 1
  const savedStart = goal.actionWindow && currentClip && goal.actionWindow.artifactId === currentClip.artifactId ? goal.actionWindow.startFrame / fps : 0
  const start = windowStart ?? savedStart
  const startFrame = Math.round(start * fps)
  const windowEnd = assembly ? startFrame / fps + (assembly.changeEndFrame - assembly.changeStartFrame) / fps : 0
  const actionReviewed = !assembly || Boolean(analysis && goalActionWindowReviewed(goal, analysis, clipAsset?.objectHash ?? null))
  const windowAccepted = !assembly || actionReviewed && goal.actionWindow?.startFrame === startFrame
  const windowIssue = !clipAsset?.objectHash ? 'The take is still loading.'
    : clipAsset.duration !== null && windowEnd > clipAsset.duration + 0.0001 ? 'This window runs past the end of the take. Choose an earlier start.'
      : start < 0 ? 'Choose a start of 0 s or later.' : null
  const finishIssue = !sourceId ? 'Generate every clip first.' : !sourceAsset?.mediaUrl ? 'The take is still loading.' : !windowAccepted ? 'Use an action window first.' : null
  const next = goalNextAction({
    goal, plan: draft, analysis, analysisError: analysisErrors[0]?.text ?? null, promptIssue: promptsReady ? null : characterIssue ?? titleIssue ?? 'Fill in the title and every prompt first.',
    dirty, actionReviewed: windowAccepted, windowIssue, finishIssue,
  })
  const names = goalStepNames(plan, analysis)
  const steps = goalSteps(goal, plan, next, analysis)
  const totalSeconds = goalPlanSeconds(plan)
  const notes = goal.notes ?? []
  const beatLimit = Math.min(15, 60 - totalSeconds)
  const canAddBeat = !assembly && plan.segments.length < 4 && beatLimit >= 2
  const history = goal.generationHistory ?? []
  const automationOffered = Boolean(analysis && (analysis.preferences.autoContinue || goal.automation)) && goal.automation?.status !== 'running'
  const saved = async () => dirty ? shortSnapshot(await onAction({ action: 'update', revision: goal.revision, plan: draft })) : goal
  const savedThen = (args: (revision: number) => GoalAction) => onRun(async () => { const current = await saved(); return onAction(args(current.revision)) })
  const revisingName = (stage: GoalGenerationStage, index: number) => ({ storyboards: `the clean-up of storyboard ${index + 1}`, replacement: 'the character replacement', frame: remix ? analysis ? 'the action setup' : 'the twist' : 'the frame prompt', videos: `beat ${index + 1}` })[stage]
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
  const ctx: GoalStageContext = {
    goal, plan, analysis, disabled, canGenerate, resolveAsset, onPreviewCell,
    checksLocked: disabled || running || finishing || dirty || goal.status === 'cancelled',
    onSelect: (stage, index, artifactId) => onRun(() => onAction({ action: 'select', revision: goal.revision, stage, index, artifact_id: artifactId })),
    onCheckOutput: (stage, index, semantic) => onRun(() => onAction({ action: 'check_output', revision: goal.revision, stage, index, semantic })),
    onCheckRealism: (stage, index) => onRun(() => onAction({ action: 'check', stage, index })),
  }
  const reviewWindow = () => {
    const hash = clipAsset?.objectHash
    if (!currentClip || !hash) return
    savedThen(revision => ({ action: 'review_action', revision, artifact_id: currentClip.artifactId, media_hash: hash, start_seconds: startFrame / fps, confirmed: true }))
  }
  const handlers: GoalNextHandlers = {
    onGo: step => onView(step),
    onGenerate: action => generate(action.action, action.stage, action.index),
    onWindow: reviewWindow,
    onFinish: () => onRun(() => onAction({ action: 'finish' })),
    onRetry: () => onRun(() => onAction({ action: 'retry' })),
    onStop: () => onRun(() => onAction({ action: 'cancel' })),
    onPause: () => onRun(() => onAction({ action: 'pause_auto' })),
    onSave: () => onRun(() => onAction({ action: 'update', revision: goal.revision, plan: draft })),
    onRunRest: automationOffered ? () => {
      onView('plan')
      requestAnimationFrame(() => automationNode.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
    } : null,
  }
  const addBeat = () => onRun(async () => {
    const current = await saved()
    await onAction({ action: 'update', revision: current.revision, plan: { ...draft, segments: [...draft.segments, { prompt: beat.prompt.trim(), seconds: beat.seconds }] } })
    setBeat({ prompt: '', seconds: 5 })
  })
  const imageStage = replacing ? 'replacement' : 'frame'
  const imageName = replacing ? inserting ? 'Insertion' : 'Replacement' : names.frame
  const imageFeedback = replacing ? replacementFeedback : feedback
  return <div className="goal-editor goal-short" data-view={view}>
    <GoalStepStrip steps={steps} view={view} resolveAsset={resolveAsset} onView={onView} />
    <div className="goal-stage">
      {view === 'plan' && analysis && <div className="goal-stage-wide goal-recipe-view">
        <GoalNotes notes={notes} />
        <GoalRecipe analysis={analysis} estimate={goal.estimate.total} qualityEstimate={goal.estimate.quality} disabled={disabled || running || finishing} resolveAsset={resolveAsset} onChange={setAnalysis}
          onSaveDefaults={() => savedThen(revision => ({ action: 'save_defaults', revision }))}
          onAnalyze={() => savedThen(revision => ({ action: 'analyze', revision }))}
          onRefreshFinish={() => savedThen(revision => ({ action: 'refresh_finish', revision }))} />
        <GoalSourcePreparation analysis={analysis} preparation={goal.preparation} disabled={disabled || running || finishing || goal.status === 'cancelled'} resolveAsset={resolveAsset}
          onPrepare={preparation => savedThen(revision => ({ action: 'prepare', revision, preparation }))}
          onReview={(artifactId, mediaHash) => savedThen(revision => ({ action: 'review_source', revision, artifact_id: artifactId, media_hash: mediaHash, confirmed: true }))} />
        {(analysis.preferences.autoContinue || goal.automation) && <div ref={automationNode}><GoalAutomation goal={goal} analysis={analysis} disabled={disabled}
          onPause={() => onRun(() => onAction({ action: 'pause_auto' }))}
          onStart={args => savedThen(revision => ({ action: 'auto_continue', revision, ...args }))} /></div>}
      </div>}
      {view === 'history' && <div className="goal-stage-wide">
        <GoalTakeHistory entries={history} revision={goal.revision} disabled={disabled || running || finishing || goal.status === 'cancelled'} resolveAsset={resolveAsset}
          onAdopt={entry => savedThen(revision => ({ action: 'adopt', revision, stage: entry.stage, index: entry.index, artifact_id: entry.artifactId, media_hash: entry.mediaHash, confirmed: true }))} />
      </div>}
      {view === 'character' && plan.version === 4 && <div className="goal-stage-wide">
        <p className="goal-panel-muted">This short was saved with a character. The name, description and pictures stay as they were.</p>
        <div className="goal-reference-grid" role="group" aria-label="Character references">{plan.character.references.map(reference => <GoalMedia key={reference.slot} artifactId={reference.artifactId} cellId={reference.cellId} label={`${reference.slot} · ${reference.address}`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />)}</div>
        {plan.character.references.length === 0 && <p className="goal-panel-muted">No reference image was saved with this short.</p>}
        <p aria-label="Character name">{plan.character.name}</p>
        <p aria-label="Character description">{plan.character.description}</p>
      </div>}
      {view === 'storyboard' && goal.storyboard && <GoalStoryboardStage ctx={ctx} storyboard={goal.storyboard} running={running} feedback={boardFeedback}
        onFeedback={(index, value) => setBoardFeedback(current => ({ ...current, [index]: value }))}
        onRegenerate={(index, model) => generate('regenerate', 'storyboards', index, undefined, model)}
        onRevise={index => generate('revise', 'storyboards', index, boardFeedback[index]?.trim())} />}
      {(view === 'frame' || replacing && remix) && <GoalImageStage ctx={ctx} stage={imageStage} name={imageName} title={title} prompt={replacing ? replacementPrompt : framePrompt} feedback={imageFeedback}
        characterReferences={replacing && characterInputs ? <GoalCharacterReferences ctx={ctx} inputs={characterInputs} selected={characters} onAdd={addCharacter} onRemove={removeCharacter}
          disabled={disabled || running || finishing || goal.status === 'cancelled'} onRun={onRun} /> : undefined}
        notes={notes} isNext={next.kind === 'generate' && next.stage === imageStage} inputsReady={replacing || replacementReady && goalStoryboardClean(goal)} editable={!disabled && !finishing}
        onTitle={setTitle} onPrompt={replacing ? setReplacementPrompt : setFramePrompt} onFeedback={replacing ? setReplacementFeedback : setFeedback}
        onRegenerate={() => generate('regenerate', imageStage)} onRevise={() => generate('revise', imageStage, 0, imageFeedback.trim())} />}
      {view === 'video' && <GoalVideoStage ctx={ctx} segments={generationSegments} beats={beats} actionPrompt={analysis?.intent.actionDescription ?? ''} clipFeedback={clipFeedback}
        nextIndex={next.kind === 'generate' && next.stage === 'videos' ? next.index : null} running={running} editable={!disabled && !finishing} frameReady={frameReady}
        window={assembly && currentClip ? { start, reviewed: windowAccepted && actionReviewed, onStart: setWindowStart } : null}
        beat={beat} canAddBeat={canAddBeat} beatLimit={beatLimit}
        onBeat={(index, value) => setBeats(current => current.map((item, position) => position === index ? value : item))}
        onActionPrompt={value => { if (analysis) setAnalysis({ ...analysis, intent: { ...analysis.intent, actionDescription: value } }) }}
        onClipFeedback={(index, value) => setClipFeedback(current => ({ ...current, [index]: value }))}
        onRegenerate={index => generate('regenerate', 'videos', index)} onRevise={index => generate('revise', 'videos', index, clipFeedback[index]?.trim())}
        onBeatDraft={setBeat} onAddBeat={addBeat} />}
      {view === 'finish' && <GoalFinishStage ctx={ctx} finishing={finishing} finishFailed={goal.finish?.status === 'failed'} sourceId={sourceId} headline={burnedTitle} secondary={englishLine}
        titleIssue={titleIssue} titleOptions={titleOptions} windowStart={assembly && goal.actionWindow ? goal.actionWindow.startFrame / fps : null}
        onHeadline={setBurnedTitle} onSecondary={setEnglishLine} onWriteTitle={() => onRun(onWriteTitle)} onChangeWindow={() => onView('video')} />}
    </div>
    <GoalAlerts connected={connected} error={error} onDismiss={onDismissError} />
    <GoalNextBar next={next} view={view} names={names} disabled={disabled} dirty={dirty} canSave={promptsReady && !finishing} revising={revising} handlers={handlers} />
  </div>
}
