import { useEffect, useRef, useState } from 'react'
import { SHORT_WORD_CEILINGS, type GoalShortPlan } from '../../../server/src/goal-short-plan'
import { coldOpenRangeError } from '../../../server/src/cold-open-model'
import type { AssetRecord } from '@/videobook/workspace-responses'
import type { ColdOpenReview } from '@/videobook/cold-open-review'
import { goalCanRetry, goalPlanSeconds, goalStillStale, goalStillVersions, shortEstimateText, type GoalSnapshot, type MainCharacterView, type ShortGoalSnapshot } from '@/videobook/goals'
import { ColdOpenBody } from './confirm/bodies/ColdOpenBody'
import { GoalPromptInput } from './GoalPromptInput'
import { GoalMedia } from './GoalStillCard'

type GoalAction = Record<string, unknown>
type ShortTab = 'character' | 'frame' | 'video' | 'finish'
type AssetResolver = (artifactId: string) => AssetRecord | null
type ShortReviewProps = {
  goal: ShortGoalSnapshot
  plan: GoalShortPlan
  disabled: boolean
  resolveAsset: AssetResolver
  onPreviewCell: (cellId: string) => void
  onRun: (work: () => Promise<unknown>) => void
  onAction: (args: GoalAction) => Promise<GoalSnapshot>
  onCharacter: (args: GoalAction) => Promise<MainCharacterView>
}

const TABS = [['character', 'Character'], ['frame', 'Frame'], ['video', 'Video'], ['finish', 'Finish']] as const
const NO_REFERENCE = 'Give the main character a reference image first: generate a character sheet or choose image cells in the Character tab.'
const SHEET_POLL_MS = 2_000
const SHEET_POLL_LIMIT = 150

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

function nextSegment(goal: ShortGoalSnapshot, plan: GoalShortPlan): number | null {
  const index = plan.segments.findIndex((_, position) => !goal.stages.videos?.outputs.some(output => output.index === position) || goalStillStale(goal, 'videos', position))
  return index < 0 ? null : index
}

export function GoalShortReview({ goal, plan, disabled, resolveAsset, onPreviewCell, onRun, onAction, onCharacter }: ShortReviewProps) {
  const [view, setView] = useState<ShortTab>(() => goal.finish && nextSegment(goal, plan) === null ? 'finish' : goal.stage === 'videos' ? 'video' : 'frame')
  const [title, setTitle] = useState(plan.title)
  const [framePrompt, setFramePrompt] = useState(plan.frame.prompt)
  const [beats, setBeats] = useState(() => plan.segments.map(segment => segment.prompt))
  const [feedback, setFeedback] = useState('')
  const [beat, setBeat] = useState({ prompt: '', seconds: 5 })
  const [character, setCharacter] = useState<MainCharacterView | null>(null)
  const [characterDraft, setCharacterDraft] = useState({ name: '', description: '', cells: '' })
  const polling = useRef<AbortController | null>(null)
  useEffect(() => () => polling.current?.abort(), [])
  const cold = goal.coldOpen
  const [range, setRange] = useState(() => ({ start: cold?.startSeconds ?? 0, end: cold?.endSeconds ?? 0, hash: cold?.sourceObjectHash ?? '' }))
  if (cold && cold.sourceObjectHash !== range.hash) setRange({ start: cold.startSeconds, end: cold.endSeconds, hash: cold.sourceObjectHash })
  const draft: GoalShortPlan = { ...plan, title: title.trim(), frame: { ...plan.frame, prompt: framePrompt.trim() }, segments: plan.segments.map((segment, index) => ({ ...segment, prompt: (beats[index] ?? '').trim() })) }
  const dirty = JSON.stringify(draft) !== JSON.stringify(plan)
  const promptsReady = Boolean(draft.title && draft.frame.prompt && draft.segments.every(segment => segment.prompt))
  const frameOutput = goal.stages.frame?.outputs[0]
  const clips = [...(goal.stages.videos?.outputs ?? [])].sort((left, right) => left.index - right.index)
  const currentClip = clips.at(-1) ?? null
  const next = nextSegment(goal, plan)
  const running = goal.status === 'running'
  const finishing = goal.finish?.status === 'running'
  const finishFailed = goal.finish?.status === 'failed'
  const hasReference = plan.character.references.length > 0 || (character?.references.length ?? goal.mainCharacterReferences ?? 0) > 0
  const canGenerate = goal.status === 'review' && promptsReady && !disabled && !running && !finishing
  const sourceId = next === null ? goal.finish?.sourceArtifactId ?? currentClip?.artifactId ?? null : null
  const sourceAsset = sourceId ? resolveAsset(sourceId) : null
  const clipAsset = currentClip ? resolveAsset(currentClip.artifactId) : null
  const duration = cold?.durationSeconds ?? sourceAsset?.duration ?? null
  const finalAsset = goal.finalArtifactId ? resolveAsset(goal.finalArtifactId) : null
  const shownStart = range.hash ? range.start : cold?.startSeconds ?? 0
  const shownEnd = range.hash ? range.end : cold?.endSeconds ?? (duration == null ? 0 : Math.min(duration, 2.3))
  const shownError = duration == null ? null : coldOpenRangeError(shownStart, shownEnd, duration)
  const canFinish = Boolean(sourceId) && duration != null && !shownError && !dirty && !disabled && !running && !finishing && (goal.status === 'review' || goal.status === 'completed' || finishFailed)
  const totalSeconds = goalPlanSeconds(plan)
  const beatLimit = Math.min(15, 60 - totalSeconds)
  const canAddBeat = plan.segments.length < 4 && beatLimit >= 2
  const saved = async () => dirty ? shortSnapshot(await onAction({ action: 'update', revision: goal.revision, plan: draft })) : goal
  const generate = (action: 'approve' | 'regenerate' | 'revise', stage: 'frame' | 'videos', index = 0, note?: string) => onRun(async () => {
    const current = await saved()
    await onAction({ action, revision: current.revision, stage, index, ...(note ? { feedback: note } : {}) })
    if (note) setFeedback('')
  })
  const remember = (next: MainCharacterView) => {
    setCharacter(next)
    setCharacterDraft(current => ({ name: current.name || next.character.name, description: current.description || next.character.description, cells: current.cells }))
    return next
  }
  const followSheet = async (first: MainCharacterView) => {
    polling.current?.abort()
    const controller = new AbortController()
    polling.current = controller
    let latest = first
    for (let round = 0; latest.sheet.pending && round < SHEET_POLL_LIMIT && !controller.signal.aborted; round += 1) {
      await new Promise(resolve => setTimeout(resolve, SHEET_POLL_MS))
      if (controller.signal.aborted) return
      latest = remember(await onCharacter({}))
    }
  }
  const characterAction = (args: GoalAction) => onRun(async () => {
    const result = remember(await onCharacter(args))
    if (result.sheet.pending) void followSheet(result)
  })
  const openTab = (tab: ShortTab) => {
    setView(tab)
    if (tab === 'character' && !character) characterAction({})
  }
  const versions = (stage: 'frame' | 'videos', index: number, label: string) => goalStillVersions(goal, stage, index).map((version, position, all) => {
    const asset = version.artifactId ? resolveAsset(version.artifactId) : null
    const name = `v${all.length - position}`
    return <button key={`${version.chainId}:${version.stepId}`} type="button" className="goal-version" aria-label={`${label} ${name}`} aria-pressed={version.current} disabled={disabled || !version.artifactId || version.status !== 'completed'} onClick={() => { if (version.artifactId) onRun(() => onAction({ action: 'select', revision: goal.revision, stage, index, artifact_id: version.artifactId })) }}>
      {(asset?.thumbnailUrl ?? asset?.mediaUrl) && <img src={asset.thumbnailUrl ?? asset.mediaUrl ?? ''} alt="" />}<span>{name}</span>
    </button>
  })
  const review: ColdOpenReview | null = sourceId && duration != null && sourceAsset?.mediaUrl ? {
    bookId: goal.bookId, notebookId: goal.notebookId, assetId: sourceId, label: plan.title, mediaUrl: sourceAsset.mediaUrl, requestId: goal.goalId,
    suggestion: {
      sourceArtifactId: sourceId, sourceObjectHash: cold?.sourceObjectHash ?? sourceAsset.objectHash ?? sourceId, durationSeconds: duration,
      fps: sourceAsset.fps && sourceAsset.fps > 0 ? sourceAsset.fps : 24, startSeconds: shownStart, endSeconds: shownEnd,
      reason: 'A 2.3 second highlight from the start of this short. Review the range before finishing. Analysis is free.', model: 'lightning',
    },
  } : null
  return <div className="goal-editor goal-simple goal-short" data-review={view}>
    <nav className="goal-stage-tabs" aria-label="Short stages">
      {TABS.map(([id, label]) => <button key={id} type="button" className="goal-panel-button" aria-pressed={view === id} onClick={() => openTab(id)}>{label}</button>)}
    </nav>
    <p className="goal-panel-muted">{plan.segments.length === 1 ? '1 clip' : `${plan.segments.length} clips`} · {totalSeconds}s · {plan.aspectRatio} · GPT Image 2.6 frame · H3 Max video</p>
    {running && <p role="status">{goal.stage === 'videos' ? 'Generating a clip.' : 'Generating the frame.'}</p>}
    {view === 'character' && <>
      <p className="goal-panel-muted">The main character belongs to this book and applies to new goals.</p>
      {!character && <p role="status">Loading the main character…</p>}
      {character && <>
        <div className="goal-reference-grid" aria-label="Character references">{character.references.map(reference => <GoalMedia key={reference.artifactId} artifactId={reference.artifactId} cellId={null} label={reference.address ?? reference.label ?? 'Reference'} resolveAsset={resolveAsset} onOpen={onPreviewCell} />)}</div>
        {character.references.length === 0 && <p className="goal-panel-muted">No reference image yet.</p>}
        <label><span>Name</span><input aria-label="Character name" value={characterDraft.name} maxLength={80} disabled={disabled} onChange={event => setCharacterDraft({ ...characterDraft, name: event.target.value })} /></label>
        <label><span>Description</span><textarea aria-label="Character description" value={characterDraft.description} maxLength={400} rows={2} disabled={disabled} onChange={event => setCharacterDraft({ ...characterDraft, description: event.target.value })} /></label>
        <label><span>Image cells</span><input aria-label="Character image cells" placeholder="@a1 @a2" value={characterDraft.cells} disabled={disabled} onChange={event => setCharacterDraft({ ...characterDraft, cells: event.target.value })} /></label>
        {character.sheet.pending && <p role="status">Making the character sheet…</p>}
        {character.sheet.lastError && <p role="alert">{character.sheet.lastError}</p>}
      </>}
    </>}
    {view === 'frame' && <>
      <div className="goal-reference-grid" aria-label="Frame references">{[...plan.character.references, ...plan.frame.references].map(ref => <GoalMedia key={ref.slot} artifactId={ref.artifactId} cellId={ref.cellId} label={`${ref.slot} · ${ref.address}`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />)}</div>
      {frameOutput && <GoalMedia artifactId={frameOutput.artifactId} cellId={frameOutput.cellId} label="Frame" resolveAsset={resolveAsset} onOpen={onPreviewCell} />}
      {frameOutput && <div className="goal-versions" aria-label="Frame versions">{versions('frame', 0, 'Frame')}</div>}
      <label><span>Title</span><input aria-label="Short title" value={title} maxLength={120} disabled={disabled || finishing} onChange={event => setTitle(event.target.value)} /></label>
      <GoalPromptInput label="Frame prompt" value={framePrompt} wordLimit={SHORT_WORD_CEILINGS.frame} disabled={disabled || finishing} onChange={setFramePrompt} />
      <AlwaysAdded lines={[plan.rules.frame]} />
      {frameOutput && <label><span>Revise the frame</span><textarea aria-label="Frame feedback" value={feedback} maxLength={300} rows={2} disabled={disabled || !canGenerate} onChange={event => setFeedback(event.target.value)} /></label>}
      {!hasReference && <p role="status" className="goal-panel-warning">{NO_REFERENCE}</p>}
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
        </li>
      })}</ol>
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
      {finishing && <p role="status">Rendering the cold open, then burning the saved watermark.</p>}
      {finishFailed && <p role="alert">{goal.finish?.error ?? 'Finishing failed'}</p>}
      {goal.finalArtifactId && finalAsset?.mediaUrl && <video className="goal-video-preview" aria-label="Finished short" src={finalAsset.mediaUrl} poster={finalAsset.thumbnailUrl ?? undefined} controls preload="metadata" />}
      {!finishing && review && <ColdOpenBody review={review} disabled={disabled || finishing} onChange={(start, end) => setRange({ start, end, hash: range.hash || cold?.sourceObjectHash || sourceId || '' })} />}
      {!finishing && sourceId && !review && <p role="status">The short is not playable yet.</p>}
    </>}
    <div className="goal-panel-bar">
      <div className="goal-panel-bar-copy"><span>{dirty ? 'Saving keeps the settings with this short.' : 'Each paid step needs its own approval.'}</span></div>
      {dirty && <button type="button" className="goal-panel-button" disabled={disabled || !promptsReady || finishing} onClick={() => onRun(() => onAction({ action: 'update', revision: goal.revision, plan: draft }))}>Save</button>}
      {view === 'character' && character && <>
        <button type="button" className="goal-panel-button" disabled={disabled || !characterDraft.name.trim() || !characterDraft.description.trim()} onClick={() => characterAction({ name: characterDraft.name.trim(), description: characterDraft.description.trim() })}>Save character</button>
        <button type="button" className="goal-panel-button" disabled={disabled || !characterDraft.cells.trim()} onClick={() => characterAction({ reference_ids: characterDraft.cells.trim().split(/[\s,]+/u) })}>Use these images</button>
        <button type="button" className="goal-panel-primary" disabled={disabled || Boolean(character.sheet.pending)} onClick={() => characterAction({ generate: true })}>Generate character sheet · {shortEstimateText(character.sheet.estimate)}</button>
      </>}
      {view === 'frame' && goal.status === 'review' && frameOutput && feedback.trim() && <button type="button" className="goal-panel-button" disabled={!canGenerate} onClick={() => generate('revise', 'frame', 0, feedback.trim())}>Revise frame</button>}
      {view === 'frame' && goal.status === 'review' && <button type="button" className="goal-panel-primary" disabled={!canGenerate || !hasReference} title={hasReference ? undefined : NO_REFERENCE} onClick={() => generate(frameOutput ? 'regenerate' : 'approve', 'frame')}>{frameOutput ? 'Regenerate frame' : 'Generate frame'} · {shortEstimateText(goal.estimate.frame)}</button>}
      {view === 'video' && goal.status === 'review' && next !== null && <button type="button" className="goal-panel-primary" disabled={!canGenerate || !frameOutput} onClick={() => generate('approve', 'videos', next)}>{next === 0 ? 'Generate clip' : `Continue · clip ${next + 1}`} · {shortEstimateText(goal.estimate.segments?.[next])}</button>}
      {view === 'finish' && !finishing && (goal.status === 'review' || goal.status === 'completed' || finishFailed) && <button type="button" className="goal-panel-primary" disabled={!canFinish} onClick={() => onRun(() => onAction({ action: 'finish', start_seconds: shownStart, end_seconds: shownEnd }))}>Finish</button>}
      {goalCanRetry(goal) && <button type="button" className="goal-panel-primary" disabled={disabled} onClick={() => onRun(() => onAction({ action: 'retry' }))}>Retry</button>}
    </div>
  </div>
}
