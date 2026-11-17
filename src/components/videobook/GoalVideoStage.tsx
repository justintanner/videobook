import { useRef } from 'react'
import { shortRemixOf, SHORT_WORD_CEILINGS, type GoalShortPlan } from '../../../server/src/goal-short-plan'
import { goalAssemblyClip, goalStillStale, goalStillVersions, shortEstimateText } from '@/videobook/goals'
import { GoalActionWindow } from './GoalActionWindow'
import { GoalPromptInput } from './GoalPromptInput'
import { GoalMedia } from './GoalStillCard'
import { AlwaysAdded, GoalChecks, GoalVersions, REALISM_NOTE, type GoalStageContext } from './GoalStageParts'

type Segment = GoalShortPlan['segments'][number]
type ActionWindowDraft = { start: number, reviewed: boolean, onStart: (seconds: number) => void }
type BeatDraft = { prompt: string, seconds: number }
type Props = {
  ctx: GoalStageContext
  segments: readonly Segment[]
  beats: readonly string[]
  actionPrompt: string
  clipFeedback: Readonly<Record<number, string>>
  nextIndex: number | null
  running: boolean
  editable: boolean
  frameReady: boolean
  window: ActionWindowDraft | null
  beat: BeatDraft
  canAddBeat: boolean
  beatLimit: number
  onBeat: (index: number, value: string) => void
  onActionPrompt: (value: string) => void
  onClipFeedback: (index: number, value: string) => void
  onRegenerate: (index: number) => void
  onRevise: (index: number) => void
  onBeatDraft: (beat: BeatDraft) => void
  onAddBeat: () => void
}

function takeName(ctx: GoalStageContext, artifactId: string): string {
  const versions = goalStillVersions(ctx.goal, 'videos', 0)
  const position = versions.findIndex(version => version.artifactId === artifactId)
  return position >= 0 && versions.length > 1 ? `Take v${versions.length - position}` : 'This take'
}

function VideoReferences({ ctx }: { ctx: GoalStageContext }) {
  const remix = shortRemixOf(ctx.plan)
  if (!remix) return null
  const frame = ctx.goal.stages.frame?.outputs[0]
  const recipe = ctx.analysis?.recipe
  const reference = recipe?.referenceArtifactId ? ctx.resolveAsset(recipe.referenceArtifactId) : null
  return <div className="goal-reference-grid" role="group" aria-label="Video references">
    {recipe?.referenceArtifactId ? <div className="goal-prepared-preview">
      <video controls playsInline preload="metadata" src={reference?.mediaUrl ?? undefined} aria-label="Video generation reference" />
      <span>@video1 · {recipe.preparedArtifactId && ctx.analysis?.intent.cleanup !== 'keep' ? 'Prepared' : 'Source'} video reference</span>
    </div> : <GoalMedia artifactId={remix.video.artifactId} cellId={remix.video.cellId} label={`@video1 · Source video${remix.video.address ? ` · ${remix.video.address}` : ''}`} resolveAsset={ctx.resolveAsset} onOpen={ctx.onPreviewCell} />}
    {frame && <GoalMedia artifactId={frame.artifactId} cellId={frame.cellId} label={`@image1 · Reviewed ${ctx.analysis ? 'action setup' : 'twist'}`} resolveAsset={ctx.resolveAsset} onOpen={ctx.onPreviewCell} />}
  </div>
}

function ClipCard({ props, segment, index }: { props: Props, segment: Segment, index: number }) {
  const { ctx } = props
  const assembly = ctx.analysis?.recipe.assembly
  const output = ctx.goal.stages.videos?.outputs.find(clip => clip.index === index)
  const stale = goalStillStale(ctx.goal, 'videos', index)
  const state = stale ? 'Out of date' : output ? 'Ready' : props.running && ctx.goal.stage === 'videos' ? 'Waiting' : 'Not generated'
  const price = shortEstimateText(ctx.goal.estimate.segments?.[index])
  const note = props.clipFeedback[index] ?? ''
  return <li className="goal-short-segment" data-state={stale ? 'stale' : output ? 'done' : 'pending'}>
    <div className="goal-short-segment-head"><strong>Clip {index + 1}</strong><span>{segment.seconds}s</span><span>{state}</span><span>{price}</span></div>
    <GoalPromptInput label={assembly ? 'Changed action prompt' : `Beat ${index + 1}`} value={assembly ? props.actionPrompt : props.beats[index] ?? ''} wordLimit={SHORT_WORD_CEILINGS.beat}
      disabled={!props.editable} onChange={value => assembly ? props.onActionPrompt(value) : props.onBeat(index, value)} />
    {stale && <p role="status" className="goal-panel-warning">{stale}</p>}
    {output && <GoalVersions ctx={ctx} stage="videos" index={index} label={`Clip ${index + 1}`} />}
    {output && props.nextIndex !== index && <button type="button" className="goal-panel-button" disabled={!ctx.canGenerate} onClick={() => props.onRegenerate(index)}>Regenerate clip {index + 1} · {price}</button>}
    {output && <label><span>Revise clip {index + 1}</span><textarea aria-label={`Clip ${index + 1} feedback`} value={note} maxLength={2000} rows={2} placeholder="Say what to change" disabled={!ctx.canGenerate} onChange={event => props.onClipFeedback(index, event.target.value)} /></label>}
    {output && <button type="button" className="goal-panel-button" disabled={!ctx.canGenerate || !note.trim()} onClick={() => props.onRevise(index)}>Revise clip {index + 1} · {price}</button>}
    {output && <GoalChecks ctx={ctx} stage="videos" index={index} artifactId={output.artifactId} name={`clip ${index + 1}`} />}
  </li>
}

function AddBeat({ props }: { props: Props }) {
  const { beat, beatLimit } = props
  const locked = props.ctx.disabled || props.running
  const valid = Boolean(beat.prompt.trim()) && beat.seconds >= 2 && beat.seconds <= beatLimit && Number.isInteger(beat.seconds)
  return <fieldset className="goal-short-add">
    <legend>Add a beat</legend>
    <GoalPromptInput label="New beat" value={beat.prompt} wordLimit={SHORT_WORD_CEILINGS.beat} disabled={locked} onChange={prompt => props.onBeatDraft({ ...beat, prompt })} />
    <label><span>Seconds</span><input aria-label="New beat seconds" type="number" min={2} max={beatLimit} value={beat.seconds} disabled={locked} onChange={event => props.onBeatDraft({ ...beat, seconds: Number(event.target.value) })} /></label>
    <button type="button" className="goal-panel-button" disabled={locked || !valid} onClick={props.onAddBeat}>Add beat</button>
  </fieldset>
}

export function GoalVideoStage(props: Props) {
  const { ctx, window } = props
  const player = useRef<HTMLVideoElement>(null)
  const stopAt = useRef<number | null>(null)
  const assembly = ctx.analysis?.recipe.assembly
  const clips = [...(ctx.goal.stages.videos?.outputs ?? [])].sort((left, right) => left.index - right.index)
  const current = assembly ? goalAssemblyClip(ctx.goal) : clips.at(-1) ?? null
  const asset = current ? ctx.resolveAsset(current.artifactId) : null
  const remix = shortRemixOf(ctx.plan)
  const play = (start: number, end: number) => {
    const video = player.current
    if (!video) return
    video.currentTime = start
    stopAt.current = end
    void video.play().catch(() => undefined)
  }
  const label = assembly ? 'Generated action for review' : 'Current clip'
  return <div className="goal-stage-columns" data-layout="video">
    <div className="goal-stage-media">
      {current && asset?.mediaUrl
        ? <video ref={player} className="goal-video-preview" aria-label={label} src={asset.mediaUrl} poster={asset.thumbnailUrl ?? undefined} controls playsInline preload="metadata"
          onTimeUpdate={event => { if (stopAt.current !== null && event.currentTarget.currentTime >= stopAt.current) { event.currentTarget.pause(); stopAt.current = null } }} />
        : current ? <GoalMedia artifactId={current.artifactId} cellId={current.cellId} label={label} resolveAsset={ctx.resolveAsset} onOpen={ctx.onPreviewCell} />
          : <span className="goal-media goal-media-pending">No clip yet</span>}
    </div>
    <div className="goal-stage-form">
      {assembly && ctx.analysis && current && window && <GoalActionWindow analysis={ctx.analysis} take={takeName(ctx, current.artifactId)} duration={asset?.duration ?? null}
        start={window.start} reviewed={window.reviewed} disabled={ctx.disabled} onStart={window.onStart} onPlay={play} />}
      <ol className="goal-short-segments" aria-label="Clips">{props.segments.map((segment, index) => <ClipCard key={index} props={props} segment={segment} index={index} />)}</ol>
      {props.canAddBeat && <AddBeat props={props} />}
      <AlwaysAdded lines={[ctx.plan.rules.video, ctx.plan.rules.silence]} />
    </div>
    <aside className="goal-stage-side">
      <VideoReferences ctx={ctx} />
      {remix && <p className="goal-panel-muted">Use the source video for movement and setting, and the reviewed {ctx.analysis ? 'action setup' : 'twist'} for appearance. The beat controls when the character appears.</p>}
      {!props.frameReady && <p className="goal-panel-muted">{remix ? `Review the ${ctx.analysis ? 'action setup' : 'twist'} before making the video.` : 'Generate the frame before the clip.'}</p>}
      {clips.length > 0 && !ctx.analysis?.recipe.outputAssertions && <p className="goal-panel-muted">{REALISM_NOTE}</p>}
      {assembly && <details><summary>Full-video context</summary>{ctx.plan.segments.map((segment, index) => <p key={index}>{segment.prompt}</p>)}</details>}
    </aside>
  </div>
}
