import type { ShortFinishTitle } from '../../../server/src/goal-short-plan'
import { formatGoalSeconds } from '@/videobook/goals'
import type { AssetRecord } from '@/videobook/workspace-responses'
import { GoalFinishTitle } from './GoalFinishTitle'
import { GoalChecks, type GoalStageContext } from './GoalStageParts'

type Props = {
  ctx: GoalStageContext
  finishing: boolean
  finishFailed: boolean
  sourceId: string | null
  headline: string
  secondary: string
  titleIssue: string | null
  titleOptions: readonly ShortFinishTitle[]
  windowStart: number | null
  onHeadline: (value: string) => void
  onSecondary: (value: string) => void
  onWriteTitle: () => void
  onChangeWindow: () => void
}

function FinishPreview({ ctx, finishing, finishFailed, sourceId }: Pick<Props, 'ctx' | 'finishing' | 'finishFailed' | 'sourceId'>) {
  const { goal, resolveAsset } = ctx
  const asset = (artifactId: string | null | undefined): AssetRecord | null => artifactId ? resolveAsset(artifactId) : null
  const working = asset(goal.finish?.workingArtifactId)
  const final = asset(goal.finalArtifactId)
  const source = asset(sourceId)
  return <>
    {finishFailed && working?.mediaUrl && <video className="goal-video-preview" aria-label="Unfinished local render" src={working.mediaUrl} controls preload="metadata" />}
    {goal.finalArtifactId && final?.mediaUrl && <video className="goal-video-preview" aria-label="Finished short" src={final.mediaUrl} poster={final.thumbnailUrl ?? undefined} controls preload="metadata" />}
    {!finishing && !goal.finalArtifactId && source?.mediaUrl && <video className="goal-video-preview" aria-label="Reviewed take" src={source.mediaUrl} poster={source.thumbnailUrl ?? undefined} controls preload="metadata" />}
    {!finishing && sourceId && !source?.mediaUrl && <p role="status">The short is not playable yet.</p>}
    {!sourceId && <span className="goal-media goal-media-pending">Generate every clip before finishing the short.</span>}
  </>
}

const SOUND_STEPS = {
  source: 'Play the original audio', generated: 'Use the generated sound', mix: 'Mix the original and generated sound', mute: 'Mute the sound',
}

function finishSteps(ctx: GoalStageContext, windowStart: number | null): string[] {
  const analysis = ctx.analysis
  const assembly = analysis?.recipe.assembly
  if (!analysis || !assembly) return ['Keep the reviewed take', 'Burn the title, if any, and the saved watermark']
  const change = analysis.recipe.change[0]
  const length = (assembly.changeEndFrame - assembly.changeStartFrame) / assembly.fps
  const take = windowStart === null ? 'your reviewed action' : `the take from ${formatGoalSeconds(windowStart)}–${formatGoalSeconds(windowStart + length)} s`
  return [
    `Keep the source shots${change ? ` outside ${formatGoalSeconds(change.start)}–${formatGoalSeconds(change.end)} s` : ''}`,
    `Cut to ${take}`,
    SOUND_STEPS[analysis.intent.audio],
    analysis.preferences.branding ? 'Burn the title, if any, and the saved branding' : 'Leave the branding off',
    'Check the frame count, length and playback',
  ]
}

export function GoalFinishStage(props: Props) {
  const { ctx, finishing, windowStart } = props
  const assembly = ctx.analysis?.recipe.assembly
  return <div className="goal-stage-columns" data-layout="finish">
    <div className="goal-stage-media"><FinishPreview ctx={ctx} finishing={finishing} finishFailed={props.finishFailed} sourceId={props.sourceId} /></div>
    <div className="goal-stage-form">
      <GoalFinishTitle headline={props.headline} secondary={props.secondary} slots={ctx.goal.titleSlots} estimate={ctx.goal.estimate.title} options={props.titleOptions} issue={props.titleIssue}
        disabled={ctx.disabled || finishing} onHeadline={props.onHeadline} onSecondary={props.onSecondary} onWrite={props.onWriteTitle} />
    </div>
    <aside className="goal-stage-side">
      <section className="goal-finish-plan" aria-label="What Finish does">
        <h3>Finish will</h3>
        <ol>{finishSteps(ctx, windowStart).map(step => <li key={step}>{step}</li>)}</ol>
        <p className="goal-panel-muted">Free · runs on this computer.</p>
        {assembly && <button type="button" className="goal-link-button" onClick={props.onChangeWindow}>Change the action window</button>}
      </section>
      {ctx.goal.finalArtifactId && <GoalChecks ctx={ctx} stage="finish" index={0} artifactId={ctx.goal.finalArtifactId} name="finished short" />}
    </aside>
  </div>
}
