import { formatShortSeconds, SHORT_STORYBOARD_MODEL_TITLES } from '../../../server/src/goal-short-plan'
import { goalStoryboardRetry, shortEstimateText } from '@/videobook/goals'
import { GoalMedia } from './GoalStillCard'
import { GoalVersions, type GoalStageContext } from './GoalStageParts'

type Storyboard = NonNullable<GoalStageContext['goal']['storyboard']>
type Props = {
  ctx: GoalStageContext
  storyboard: Storyboard
  running: boolean
  feedback: Readonly<Record<number, string>>
  onFeedback: (index: number, value: string) => void
  onRegenerate: (index: number, model?: string) => void
  onRevise: (index: number) => void
}

function frameState(frame: Storyboard['frames'][number], cleaning: boolean): string {
  if (frame.clean) return 'Clean'
  if (frame.failure) return frame.failure.kind === 'failed' ? 'Failed' : 'Not run'
  return cleaning ? 'Cleaning' : 'Not cleaned'
}

function StoryboardFrame({ props, frame }: { props: Props, frame: Storyboard['frames'][number] }) {
  const { ctx } = props
  const name = `Storyboard ${frame.index + 1}`
  const failed = frame.failure?.kind === 'failed'
  const redo = Boolean(frame.clean) || failed
  const retry = goalStoryboardRetry(ctx.goal, frame.index)
  const price = shortEstimateText(frame.estimate ?? undefined)
  const note = props.feedback[frame.index] ?? ''
  return <li className="goal-short-segment" data-state={frame.clean ? 'done' : failed ? 'failed' : 'pending'}>
    <div className="goal-short-segment-head"><strong>{name}</strong><span>{formatShortSeconds(frame.atSeconds)} s</span><span>{frameState(frame, props.running && ctx.goal.stage === 'storyboards')}</span><span>{price}</span></div>
    <div className="goal-storyboard-pair">
      <GoalMedia artifactId={frame.raw.artifactId} cellId={frame.raw.cellId} label={`${name} before · ${frame.raw.address}`} resolveAsset={ctx.resolveAsset} onOpen={ctx.onPreviewCell} />
      {frame.clean
        ? <GoalMedia artifactId={frame.clean.artifactId} cellId={frame.clean.cellId} label={`${name} after${frame.clean.address ? ` · ${frame.clean.address}` : ''}`} resolveAsset={ctx.resolveAsset} onOpen={ctx.onPreviewCell} />
        : <span className="goal-media goal-media-pending">{failed ? 'Clean-up failed' : frame.failure ? 'Not run' : 'Not cleaned yet'}</span>}
    </div>
    {frame.failure && <p role={failed ? 'alert' : undefined} className={failed ? 'goal-panel-warning' : 'goal-panel-muted'}>{frame.failure.message}</p>}
    {frame.clean && <GoalVersions ctx={ctx} stage="storyboards" index={frame.index} label={name} />}
    {retry && <button type="button" className="goal-panel-button" disabled={!ctx.canGenerate} onClick={() => props.onRegenerate(frame.index, retry.other.model)}>Clean with {retry.other.title} · {shortEstimateText(retry.other.estimate)}</button>}
    {retry && <button type="button" className="goal-panel-button" disabled={!ctx.canGenerate} onClick={() => props.onRegenerate(frame.index, retry.same.model)}>Try again with {retry.same.title} · {shortEstimateText(retry.same.estimate)}</button>}
    {redo && !retry && <button type="button" className="goal-panel-button" disabled={!ctx.canGenerate} onClick={() => props.onRegenerate(frame.index)}>Regenerate storyboard {frame.index + 1} · {price}</button>}
    {redo && <label><span>Revise storyboard {frame.index + 1}</span><textarea aria-label={`${name} feedback`} value={note} maxLength={2000} rows={2} disabled={!ctx.canGenerate} onChange={event => props.onFeedback(frame.index, event.target.value)} /></label>}
    {redo && <button type="button" className="goal-panel-button" disabled={!ctx.canGenerate || !note.trim()} onClick={() => props.onRevise(frame.index)}>Revise storyboard {frame.index + 1} · {price}</button>}
  </li>
}

export function GoalStoryboardStage(props: Props) {
  const { storyboard } = props
  const count = storyboard.frames.length === 1 ? 'A frame' : `${storyboard.frames.length} frames`
  return <div className="goal-stage-wide">
    <p className="goal-panel-muted">{count} of {storyboard.video.label}{storyboard.video.address ? ` (${storyboard.video.address})` : ''}, in order. The clean-up removes what was drawn on top of the picture, such as captions, stickers, logos, credits and shade, and the frame is made from clean storyboard frame 1. Clean-up runs on {SHORT_STORYBOARD_MODEL_TITLES[storyboard.model]}.</p>
    <ol className="goal-short-segments" aria-label="Storyboard frames">{storyboard.frames.map(frame => <StoryboardFrame key={frame.index} props={props} frame={frame} />)}</ol>
  </div>
}
