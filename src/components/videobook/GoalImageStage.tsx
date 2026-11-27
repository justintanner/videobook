import type { ReactNode } from 'react'
import { formatShortSeconds, shortRemixOf, SHORT_WORD_CEILINGS } from '../../../server/src/goal-short-plan'
import { goalStoryboardClean, goalStoryboardReference, shortEstimateText } from '@/videobook/goals'
import { GoalPromptInput } from './GoalPromptInput'
import { GoalMedia } from './GoalStillCard'
import { AlwaysAdded, GoalChecks, GoalNotes, GoalVersions, REALISM_NOTE, type GoalStageContext } from './GoalStageParts'

type Props = {
  ctx: GoalStageContext
  characterReferences?: ReactNode
  stage: 'replacement' | 'frame'
  name: string
  title: string
  prompt: string
  feedback: string
  notes: readonly string[]
  isNext: boolean
  inputsReady: boolean
  editable: boolean
  onTitle: (value: string) => void
  onPrompt: (value: string) => void
  onFeedback: (value: string) => void
  onRegenerate: () => void
  onRevise: () => void
}
type Still = { artifactId: string, cellId: string | null, label: string }

function guidance(ctx: GoalStageContext, replacing: boolean, inputsReady: boolean): string | null {
  if (!shortRemixOf(ctx.plan)) return null
  if (replacing) return 'Describe who goes where. Use @image1, @image2 and the other reference labels to assign roles or combine views of the same character.'
  if (ctx.analysis) {
    return inputsReady ? 'Prepare the starting pose for the action. Keep the reviewed identity and surroundings.' : 'Review the character image before preparing the action.'
  }
  return inputsReady ? 'Add one funny, physically believable change to the reviewed replacement. Keep the same person and surroundings.' : 'Review the character replacement before adding the twist.'
}

function beforeStill(ctx: GoalStageContext, replacing: boolean): Still | null {
  const remix = shortRemixOf(ctx.plan)
  if (!remix) return null
  if (replacing) return { artifactId: remix.frame.artifactId, cellId: remix.frame.cellId, label: `Extracted source frame · ${formatShortSeconds(remix.frame.atSeconds)} s` }
  const replacement = ctx.goal.stages.replacement?.outputs[0]
  return replacement ? { artifactId: replacement.artifactId, cellId: replacement.cellId, label: 'Reviewed replacement' } : null
}

export function GoalImageStage({ ctx, characterReferences, stage, name, title, prompt, feedback, notes, isNext, inputsReady, editable, onTitle, onPrompt, onFeedback, onRegenerate, onRevise }: Props) {
  const { goal, plan, analysis } = ctx
  const replacing = stage === 'replacement'
  const remix = shortRemixOf(plan)
  const output = goal.stages[stage]?.outputs[0]
  const before = beforeStill(ctx, replacing)
  const storyboard = goal.storyboard
  const firstStoryboard = goalStoryboardReference(goal)
  const refNumber = (firstStoryboard?.index ?? 0) + 1
  const cleanFirst = firstStoryboard?.clean ?? null
  const frameImages = plan.version === 4 ? [...plan.character.references, ...plan.frame.references] : plan.sourceImages
  const price = shortEstimateText(replacing ? goal.estimate.replacement : goal.estimate.frame)
  const actionable = ctx.canGenerate && inputsReady
  const note = guidance(ctx, replacing, inputsReady)
  return <div className="goal-stage-columns" data-layout="still">
    <div className="goal-stage-media">
      <div className="goal-still-pair" data-pair={before ? '' : undefined}>
        {before && <GoalMedia artifactId={before.artifactId} cellId={before.cellId} label={before.label} resolveAsset={ctx.resolveAsset} onOpen={ctx.onPreviewCell} />}
        {output
          ? <GoalMedia artifactId={output.artifactId} cellId={output.cellId} label={name} resolveAsset={ctx.resolveAsset} onOpen={ctx.onPreviewCell} />
          : <span className="goal-media goal-media-pending">No {name.toLowerCase()} yet</span>}
      </div>
      {output?.stale && <p role="status" className="goal-panel-warning">{output.stale}</p>}
      {output && <GoalVersions ctx={ctx} stage={stage} index={0} label={name} />}
    </div>
    <div className="goal-stage-form">
      <GoalNotes notes={notes} />
      <label><span>Title</span><input aria-label="Short title" value={title} maxLength={120} disabled={!editable} onChange={event => onTitle(event.target.value)} /></label>
      <GoalPromptInput label={replacing ? 'Character directions' : `${name} prompt`} value={prompt} wordLimit={replacing ? undefined : SHORT_WORD_CEILINGS.frame} maxLength={2000} disabled={!editable} onChange={onPrompt} />
      {!replacing && <AlwaysAdded lines={[plan.rules.frame]} />}
      {note && <p className="goal-panel-muted">{note}</p>}
    </div>
    <aside className="goal-stage-side">
      {output && <div className="goal-retake">
        <label><span>Not right?</span><textarea aria-label={`${name} feedback`} value={feedback} maxLength={2000} rows={2} placeholder="Say what to change" disabled={!actionable} onChange={event => onFeedback(event.target.value)} /></label>
        <div className="goal-retake-actions">
          <button type="button" className="goal-panel-button" disabled={!actionable || !feedback.trim()} onClick={onRevise}>Revise · {price}</button>
          {!isNext && <button type="button" className="goal-panel-button" disabled={!actionable} onClick={onRegenerate}>New take · {price}</button>}
        </div>
      </div>}
      {output && <GoalChecks ctx={ctx} stage={stage} index={0} artifactId={output.artifactId} name={name.toLowerCase()} />}
      {output && !replacing && !analysis?.recipe.outputAssertions && <p className="goal-panel-muted">{REALISM_NOTE}</p>}
      {characterReferences ?? <div className="goal-reference-grid" role="group" aria-label={plan.version === 4 || storyboard ? 'Frame references' : 'Source images'}>
        {(!remix || replacing) && frameImages.map(ref => <GoalMedia key={ref.slot} artifactId={ref.artifactId} cellId={ref.cellId} label={`${ref.slot} · ${ref.address}`} resolveAsset={ctx.resolveAsset} onOpen={ctx.onPreviewCell} />)}
        {cleanFirst && <GoalMedia artifactId={cleanFirst.artifactId} cellId={cleanFirst.cellId} label={`@image${frameImages.length + 1} · storyboard ${refNumber}`} resolveAsset={ctx.resolveAsset} onOpen={ctx.onPreviewCell} />}
      </div>}
      {storyboard && !goalStoryboardClean(goal) && <p role="note" className="goal-panel-muted">Remove the on-screen graphics from the storyboard first: the frame is made from clean storyboard frame {refNumber}.</p>}
    </aside>
  </div>
}
