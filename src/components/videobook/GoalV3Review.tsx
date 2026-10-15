import { useState } from 'react'
import type { GoalPlanV3 } from '../../../server/src/goal-plan-v3'
import { LIGHTNING_SCENE_PROMPT_WORDS, LIGHTNING_VIDEO_PROMPT_WORDS } from '../../../server/src/lightning-defaults'
import { coldOpenRangeError } from '../../../server/src/cold-open-model'
import type { AssetRecord } from '@/videobook/workspace-responses'
import type { ColdOpenReview } from '@/videobook/cold-open-review'
import { goalCanRetry, goalStillVersions, type GoalSnapshot } from '@/videobook/goals'
import { ColdOpenBody } from './confirm/bodies/ColdOpenBody'
import { GoalPromptInput } from './GoalPromptInput'
import { GoalMedia } from './GoalStillCard'

type GoalAction = Record<string, unknown>
type StageTab = 'scene' | 'video' | 'finish'
type AssetResolver = (artifactId: string) => AssetRecord | null

function money(usd: number | null | undefined): string {
  return usd == null ? ' · estimate unavailable' : ` · $${usd.toFixed(2)}`
}

function promptOf(goal: GoalSnapshot, stage: 'frame' | 'videos'): string | null {
  const output = goal.stages[stage]?.outputs[0]
  if (!output) return null
  return output.versions.find(version => version.current)?.basePrompt
    ?? goal.stages[stage]?.attempts?.find(attempt => attempt.artifactId === output.artifactId)?.basePrompt
    ?? null
}

export function GoalV3Review({ goal, plan, disabled, resolveAsset, onPreviewCell, onRun, onAction }: {
  goal: GoalSnapshot
  plan: GoalPlanV3
  disabled: boolean
  resolveAsset: AssetResolver
  onPreviewCell: (cellId: string) => void
  onRun: (work: () => Promise<unknown>) => void
  onAction: (args: GoalAction) => Promise<GoalSnapshot>
}) {
  const [view, setView] = useState<StageTab>(() => goal.finish ? 'finish' : goal.stage === 'videos' ? 'video' : 'scene')
  const [title, setTitle] = useState(plan.title)
  const [scenePrompt, setScenePrompt] = useState(plan.scene.prompt)
  const [videoPrompt, setVideoPrompt] = useState(plan.video.prompt)
  const cold = goal.coldOpen
  const [range, setRange] = useState(() => ({
    start: cold?.startSeconds ?? 0,
    end: cold?.endSeconds ?? 0,
    hash: cold?.sourceObjectHash ?? '',
  }))
  if (cold && cold.sourceObjectHash !== range.hash) {
    setRange({ start: cold.startSeconds, end: cold.endSeconds, hash: cold.sourceObjectHash })
  }
  const draftTitle = title.trim()
  const draftScene = scenePrompt.trim()
  const draftVideo = videoPrompt.trim()
  const dirty = draftTitle !== plan.title || draftScene !== plan.scene.prompt || draftVideo !== plan.video.prompt
  const promptsReady = Boolean(draftTitle && draftScene && draftVideo)
  const sceneBase = promptOf(goal, 'frame')
  const sceneOutput = goal.stages.frame?.outputs[0]
  const videoOutput = goal.stages.videos?.outputs[0]
  const sceneChanged = Boolean(sceneOutput) && (draftScene !== plan.scene.prompt || (sceneBase !== null && sceneBase !== plan.scene.prompt))
  const videoChanged = draftVideo !== plan.video.prompt
  const runningGeneration = goal.status === 'running'
  const finishing = goal.finish?.status === 'running'
  const finishFailed = goal.finish?.status === 'failed'
  const sourceId = goal.finish?.sourceArtifactId ?? videoOutput?.artifactId ?? null
  const sourceAsset = sourceId ? resolveAsset(sourceId) : null
  const duration = cold?.durationSeconds ?? sourceAsset?.duration ?? null
  const analysis = cold?.analysisUsd ?? 0
  const finalAsset = goal.finalArtifactId ? resolveAsset(goal.finalArtifactId) : null
  const playable = Boolean(goal.finalArtifactId && finalAsset?.mediaUrl)
  const draft = { ...plan, title: draftTitle, scene: { ...plan.scene, prompt: draftScene }, video: { ...plan.video, prompt: draftVideo } }
  const shownStart = range.hash ? range.start : (cold?.startSeconds ?? 0)
  const shownEnd = range.hash ? range.end : (cold?.endSeconds ?? (duration == null ? 0 : Math.min(duration, 2.3)))
  const shownError = duration == null ? null : coldOpenRangeError(shownStart, shownEnd, duration)
  const sceneCost = money(goal.estimate.frame.usd)
  const videoCost = money(goal.estimate.videos.usd)
  const canGenerateScene = goal.status === 'review' && promptsReady && !disabled && !runningGeneration && !finishing
  const canGenerateVideo = canGenerateScene && !sceneChanged && Boolean(sceneOutput)
  const canFinish = Boolean(sourceId) && duration != null && !shownError && !dirty && !sceneChanged && !disabled && !runningGeneration && !finishing && (goal.status === 'review' || goal.status === 'completed' || finishFailed)
  const run = (action: 'approve' | 'regenerate', stage: 'frame' | 'videos') => {
    onRun(async () => {
      const next = dirty ? await onAction({ action: 'update', revision: goal.revision, plan: draft }) : goal
      await onAction({ action, revision: next.revision, stage, index: 0 })
    })
  }
  const suggestion = sourceId && duration != null && sourceAsset?.mediaUrl ? {
    sourceArtifactId: sourceId,
    sourceObjectHash: cold?.sourceObjectHash ?? sourceAsset.objectHash ?? sourceId,
    durationSeconds: duration,
    fps: sourceAsset.fps && sourceAsset.fps > 0 ? sourceAsset.fps : 24,
    startSeconds: shownStart,
    endSeconds: shownEnd,
    reason: 'A 2.3 second highlight from the start of this video. Review the range before finishing. Analysis is free.',
    model: 'lightning',
  } : null
  const review: ColdOpenReview | null = suggestion && sourceId && sourceAsset?.mediaUrl ? {
    bookId: goal.bookId,
    notebookId: goal.notebookId,
    assetId: sourceId,
    label: plan.title,
    mediaUrl: sourceAsset.mediaUrl,
    requestId: goal.goalId,
    suggestion,
  } : null
  const versions = (stage: 'frame' | 'videos', label: string) => goalStillVersions(goal, stage, 0).map((version, position, all) => {
    const asset = version.artifactId ? resolveAsset(version.artifactId) : null
    const name = `v${all.length - position}`
    return <button key={`${version.chainId}:${version.stepId}`} type="button" className="goal-version" aria-label={`${label} ${name}`} aria-pressed={version.current} disabled={disabled || !version.artifactId || version.status !== 'completed'} onClick={() => { if (version.artifactId) onRun(() => onAction({ action: 'select', revision: goal.revision, stage, index: 0, artifact_id: version.artifactId })) }}>
      {(asset?.thumbnailUrl ?? asset?.mediaUrl) && <img src={asset.thumbnailUrl ?? asset.mediaUrl ?? ''} alt="" />}<span>{name}</span>
    </button>
  })
  return <div className="goal-editor goal-simple" data-review={view}>
    <nav className="goal-stage-tabs" aria-label="Goal stages">
      {([['scene', 'Scene'], ['video', 'Video'], ['finish', 'Finish']] as const).map(([id, label]) => <button key={id} type="button" className="goal-panel-button" aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}
    </nav>
    <p className="goal-panel-muted">{plan.video.durationSeconds}s video · {plan.aspectRatio} · Seedance 2.5</p>
    {runningGeneration && <p role="status">{goal.stage === 'videos' ? 'Generating the video.' : 'Generating the scene.'}</p>}
    {view === 'scene' && <>
      <div className="goal-reference-grid" aria-label="Scene references">{plan.scene.imageRefs.map(ref => <GoalMedia key={ref.slot} artifactId={ref.artifactId} cellId={ref.cellId} label={`${ref.slot} · ${ref.address}`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />)}</div>
      {sceneOutput && <GoalMedia artifactId={sceneOutput.artifactId} cellId={sceneOutput.cellId} label="Approved scene" resolveAsset={resolveAsset} onOpen={onPreviewCell} />}
      {sceneOutput && <div className="goal-versions" aria-label="Scene versions">{versions('frame', 'Scene')}</div>}
      <label><span>Title</span><input aria-label="Video title" value={title} maxLength={120} disabled={disabled || finishing} onChange={event => setTitle(event.target.value)} /></label>
      <GoalPromptInput label="Scene prompt" value={scenePrompt} budget="frame" wordLimit={LIGHTNING_SCENE_PROMPT_WORDS} disabled={disabled || finishing} onChange={setScenePrompt} />
    </>}
    {view === 'video' && <>
      <div className="goal-reference-grid" aria-label="Video references">{[...plan.video.imageRefs, ...plan.video.videoRefs].map(ref => <GoalMedia key={ref.slot} artifactId={ref.artifactId} cellId={ref.cellId} label={`${ref.slot} · ${ref.address}`} resolveAsset={resolveAsset} onOpen={onPreviewCell} />)}</div>
      {sceneOutput && <GoalMedia artifactId={sceneOutput.artifactId} cellId={sceneOutput.cellId} label="Approved scene" resolveAsset={resolveAsset} onOpen={onPreviewCell} />}
      {videoOutput && sourceAsset?.mediaUrl && videoOutput.artifactId === sourceId
        ? <video className="goal-video-preview" aria-label="Approved video" src={sourceAsset.mediaUrl} poster={sourceAsset.thumbnailUrl ?? undefined} controls preload="metadata" />
        : videoOutput && <GoalMedia artifactId={videoOutput.artifactId} cellId={videoOutput.cellId} label="Approved video" resolveAsset={resolveAsset} onOpen={onPreviewCell} />}
      {videoOutput && <div className="goal-versions" aria-label="Video versions">{versions('videos', 'Video')}</div>}
      <GoalPromptInput label="Video prompt" value={videoPrompt} budget="video" wordLimit={LIGHTNING_VIDEO_PROMPT_WORDS} disabled={disabled || finishing} onChange={setVideoPrompt} />
      {!sceneOutput && <p className="goal-panel-muted">Generate the scene before the video.</p>}
      {sceneChanged && <p role="status" className="goal-panel-warning">Refresh the scene before continuing.</p>}
    </>}
    {view === 'finish' && <>
      <p>Finishing analysis · ${analysis.toFixed(2)}</p>
      {!sourceId && <p className="goal-panel-muted">Approve the video before finishing it.</p>}
      {finishing && <p role="status">Rendering the cold open, then burning the saved watermark.</p>}
      {finishFailed && <p role="alert">{goal.finish?.error ?? 'Finishing failed'}</p>}
      {playable && finalAsset?.mediaUrl && <video className="goal-video-preview" aria-label="Finished video" src={finalAsset.mediaUrl} poster={finalAsset.thumbnailUrl ?? undefined} controls preload="metadata" />}
      {goal.finalArtifactId && !playable && !finishing && <p role="status">The finished video is not playable yet.</p>}
      {!finishing && review && <ColdOpenBody review={review} disabled={disabled || finishing} onChange={(start, end) => setRange({ start, end, hash: range.hash || cold?.sourceObjectHash || sourceId || '' })} />}
      {!finishing && sourceId && !review && <p role="status">The video is not playable yet.</p>}
      {(dirty && (goal.finish || videoOutput)) && <p className="goal-panel-warning">Saving a prompt clears the cold open.</p>}
      {videoChanged && <p className="goal-panel-muted">Save the video prompt before finishing.</p>}
    </>}
    <div className="goal-panel-bar">
      <div className="goal-panel-bar-copy"><span>{dirty ? 'Saving a prompt clears the cold open. Settings stay with this goal.' : finishing ? 'The cold open renders first, then the saved watermark is burned onto a copy.' : 'Approves this step only.'}</span></div>
      {dirty && <button type="button" className="goal-panel-button" disabled={disabled || !promptsReady || finishing} onClick={() => onRun(() => onAction({ action: 'update', revision: goal.revision, plan: draft }))}>Save</button>}
      {view === 'scene' && goal.status === 'review' && <button type="button" className="goal-panel-primary" disabled={!canGenerateScene} onClick={() => run(sceneOutput ? 'regenerate' : 'approve', 'frame')}>{sceneOutput ? 'Regenerate scene' : 'Generate scene'}{sceneCost}</button>}
      {view === 'video' && goal.status === 'review' && <button type="button" className="goal-panel-primary" disabled={!canGenerateVideo} onClick={() => run(videoOutput ? 'regenerate' : 'approve', 'videos')}>{videoOutput ? 'Regenerate video' : 'Generate video'}{videoCost}</button>}
      {view === 'finish' && !finishing && (goal.status === 'review' || goal.status === 'completed' || finishFailed) && <button type="button" className="goal-panel-primary" disabled={!canFinish} onClick={() => onRun(() => onAction({ action: 'finish', start_seconds: shownStart, end_seconds: shownEnd }))}>Finish</button>}
      {goalCanRetry(goal) && <button type="button" className="goal-panel-primary" disabled={disabled} onClick={() => onRun(() => onAction({ action: 'retry' }))}>Retry</button>}
    </div>
  </div>
}
