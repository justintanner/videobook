import { shortGenerationSegments, shortRemixOf, type GoalShortPlan } from '../../server/src/goal-short-plan'
import type { GoalRemixAnalysis } from '../../server/src/goal-remix-model'
import type { GoalGenerationStage } from '../../server/src/goal-store'
import {
  characterActionLabel, formatGoalClock, formatGoalSeconds, goalActionWindowReviewed, goalAssemblyClip, goalFrameName, goalNextSegment, goalPlanSeconds, goalProgress,
  goalRemixAnalysisOf, goalReviewTarget, goalRevisionLabel, goalSourceReady, goalStillVersions, goalStopLabel, goalStoryboardClean,
  goalStoryboardEstimate, shortEstimateText,
  type GoalReviewTarget, type ShortGoalSnapshot, type ShortView,
} from './goals'

export type GoalStepKey = Exclude<ShortView, 'history'>
type NextBase = { step: GoalStepKey, short: string, text: string, detail: string | null }
type GenerateNext = NextBase & {
  kind: 'generate', stage: GoalGenerationStage, index: number, action: 'approve' | 'regenerate', label: string, price: string, blocked: string | null
}
export type GoalNextAction =
  | NextBase & { kind: 'busy', stop: string | null, pause: boolean }
  | NextBase & { kind: 'retry' }
  | NextBase & { kind: 'recipe', failed: boolean }
  | GenerateNext
  | NextBase & { kind: 'window', blocked: string | null }
  | NextBase & { kind: 'finish', failed: boolean, blocked: string | null }
  | NextBase & { kind: 'done' }
  | NextBase & { kind: 'stopped' }
export type GoalNextInput = {
  goal: ShortGoalSnapshot
  plan: GoalShortPlan
  analysis?: GoalRemixAnalysis
  analysisError?: string | null
  promptIssue?: string | null
  dirty?: boolean
  actionReviewed?: boolean
  windowIssue?: string | null
  finishIssue?: string | null
}
export type GoalStepTone = 'done' | 'next' | 'busy' | 'failed' | 'stale' | 'waiting'
export type GoalStepView = { key: GoalStepKey, name: string, status: string, tone: GoalStepTone, artifactId: string | null }

const KEEP_GOING = 'You can close this panel. The goal keeps going.'
const STAGE_STEPS: Record<GoalGenerationStage | 'assembly', GoalStepKey> = { storyboards: 'storyboard', replacement: 'replacement', frame: 'frame', videos: 'video', assembly: 'video' }
const FINISH_PHASES = {
  assembly: 'Assembling the reviewed source and action.', audio: 'Applying the selected sound.', branding: 'Rendering the saved branding.',
  validation: 'Checking the finished video.', completed: 'Finished.',
}
const STRUCTURE_NAMES: Record<GoalRemixAnalysis['intent']['structure'], string> = { 'preserve-source': 'Keep shots', regenerate: 'Regenerate', 'single-take': 'One take' }

export function goalStepNames(plan: GoalShortPlan, analysis = goalRemixAnalysisOf(plan)): Record<GoalStepKey, string> {
  return { plan: 'Recipe', storyboard: 'Storyboard', character: 'Character', replacement: 'Character', frame: goalFrameName(plan, analysis), video: 'Video', finish: 'Finish' }
}

function goalStepKeys(plan: GoalShortPlan, hasStoryboard: boolean, analysis = goalRemixAnalysisOf(plan)): GoalStepKey[] {
  const stills: GoalStepKey[] = plan.version === 4 ? ['character', 'frame'] : shortRemixOf(plan) ? ['replacement', 'frame'] : hasStoryboard ? ['storyboard', 'frame'] : ['frame']
  return [...(analysis ? ['plan' as const] : []), ...stills, 'video', 'finish']
}

function formatRange(range: { start: number, end: number }): string {
  return `${formatGoalSeconds(range.start)}–${formatGoalSeconds(range.end)} s`
}

function runningText(goal: ShortGoalSnapshot, plan: GoalShortPlan, analysis: GoalRemixAnalysis | undefined): string {
  const revised = goalRevisionLabel(goal)
  if (revised) return `Revising the ${revised} with your feedback.`
  if (goal.status === 'planning') return 'Planning the short.'
  if (goal.stage === 'storyboards') return 'Removing the on-screen graphics from the storyboard.'
  if (goal.stage === 'replacement') return 'Applying the character edit to the source frame.'
  if (goal.stage === 'frame') return shortRemixOf(plan) ? analysis ? 'Setting up the action.' : 'Adding the twist to the reviewed replacement.' : 'Generating the frame.'
  const number = (goalProgress(goal).active?.index ?? 0) + 1
  return `Generating clip ${number} of ${shortGenerationSegments(plan).length}.`
}

function busyNext(goal: ShortGoalSnapshot, plan: GoalShortPlan, analysis: GoalRemixAnalysis | undefined): GoalNextAction | null {
  const automation = goal.automation?.status === 'running' ? goal.automation : null
  if (automation) {
    const stop = goal.status === 'running' ? goalStopLabel(goal) : null
    return { kind: 'busy', step: STAGE_STEPS[goal.stage], short: 'Running for you', text: `Running the recipe for you: ${automation.step}.`, detail: automation.reason, stop, pause: true }
  }
  if (goal.finish?.status === 'running') {
    return { kind: 'busy', step: 'finish', short: 'Finishing…', text: FINISH_PHASES[goal.finish.phase ?? 'branding'], detail: KEEP_GOING, stop: 'Stop finishing', pause: false }
  }
  if (goal.status === 'running' || goal.status === 'planning') {
    return { kind: 'busy', step: STAGE_STEPS[goal.stage], short: 'Generating…', text: runningText(goal, plan, analysis), detail: KEEP_GOING, stop: goalStopLabel(goal), pause: false }
  }
  const preparation = goal.preparation
  if (preparation?.status !== 'running') return null
  const progress = preparation.progress
  const text = progress ? `Preparing the source · ${progress.completedFrames}/${progress.totalFrames} frames · ${Math.round(progress.elapsedSeconds)}s` : 'Preparing the source references…'
  return { kind: 'busy', step: 'plan', short: 'Preparing…', text, detail: 'Removing the graphics runs on this computer and can take several minutes.', stop: null, pause: false }
}

function recipeNext(goal: ShortGoalSnapshot, plan: GoalShortPlan, input: GoalNextInput): GoalNextAction | null {
  const saved = goalRemixAnalysisOf(plan)
  const recipe = (failed: boolean, short: string, text: string, detail: string | null): GoalNextAction => ({ kind: 'recipe', step: 'plan', failed, short, text, detail })
  if (saved && !goalSourceReady(plan)) {
    const preparation = goal.preparation
    if (preparation?.status === 'failed') return recipe(true, 'Preparing failed', preparation.error ?? 'Preparing the source failed.', 'Change the regions or the method, then prepare it again.')
    if (saved.recipe.preparedArtifactId) return recipe(false, 'Check the clean copy', 'Watch the cleaned source, then press Use reviewed source.', 'Check that the graphics are gone and the fill looks right.')
    if (input.dirty && input.analysis?.intent.cleanup === 'keep') return recipe(false, 'Save the recipe', 'Save the recipe to keep the source graphics.', null)
    return recipe(false, 'Prepare the source', 'Prepare the source: mark the on-screen graphics to remove.', 'Nothing is generated until you review the cleaned source.')
  }
  return input.analysisError ? recipe(true, 'Fix the recipe', input.analysisError, 'Edit the recipe or a prompt to resolve it.') : null
}

function storyboardNext(goal: ShortGoalSnapshot, blocked: string | null): GenerateNext {
  const failures = (goal.storyboard?.frames ?? []).filter(frame => frame.failure?.kind === 'failed').length
  const text = failures > 0
    ? `${failures === 1 ? 'A storyboard frame' : `${failures} storyboard frames`} failed. Clean again, or use the other model on that frame below.`
    : 'Remove the captions, stickers and logos drawn over the storyboard frames.'
  return {
    kind: 'generate', step: 'storyboard', stage: 'storyboards', index: 0, action: 'approve', label: 'Remove on-screen graphics', price: shortEstimateText(goalStoryboardEstimate(goal)),
    short: failures > 0 ? `${failures} failed` : `Clean · ${shortEstimateText(goalStoryboardEstimate(goal))}`, text, detail: 'The frame is made from clean storyboard frame 1.',
    blocked: goal.stage === 'storyboards' ? blocked : 'Clean the remaining frames one at a time below.',
  }
}

function stillNext(goal: ShortGoalSnapshot, plan: GoalShortPlan, analysis: GoalRemixAnalysis | undefined, target: Extract<GoalReviewTarget, { kind: 'replacement' | 'frame' }>, blocked: string | null): GenerateNext {
  const remix = Boolean(shortRemixOf(plan))
  const insert = analysis?.intent.character === 'insert'
  const replacing = target.kind === 'replacement'
  const name = replacing ? insert ? 'insertion' : 'replacement' : goalFrameName(plan, analysis).toLowerCase()
  const fresh = replacing ? characterActionLabel(plan, analysis) : remix ? analysis ? 'Prepare action' : 'Add twist' : 'Generate frame'
  const text = replacing
    ? 'Place the characters in the source frame as described in your prompt.'
    : remix ? analysis ? 'Set up the starting pose for the action.' : 'Add one funny, believable change to the reviewed replacement.' : 'Generate the first frame from the prompt.'
  const detail = replacing ? analysis ? 'The scene and physical props stay as they are.' : 'Added text, stickers, credits and shade are removed too.' : remix ? 'Keep the cast and surroundings.' : null
  const price = shortEstimateText(replacing ? goal.estimate.replacement : goal.estimate.frame)
  return {
    kind: 'generate', step: replacing ? 'replacement' : 'frame', stage: target.kind, index: 0, action: target.stale ? 'regenerate' : 'approve',
    label: target.stale ? `Regenerate ${name}` : fresh, price, short: target.stale ? 'Out of date' : `Generate · ${price}`,
    text: target.stale ?? text, detail: target.stale ? null : detail, blocked,
  }
}

function clipNext(goal: ShortGoalSnapshot, plan: GoalShortPlan, analysis: GoalRemixAnalysis | undefined, index: number, stale: string | null, blocked: string | null): GenerateNext {
  const total = shortGenerationSegments(plan).length
  const change = analysis?.recipe.assembly ? analysis.recipe.change[0] : undefined
  const fresh = change ? `Generate the action for ${formatRange(change)} of the short.`
    : index === 0 ? total === 1 ? 'Generate the clip from the frame.' : `Generate clip 1 of ${total} from the frame.` : `Continue the video with clip ${index + 1} of ${total}.`
  const price = shortEstimateText(goal.estimate.segments?.[index])
  return {
    kind: 'generate', step: 'video', stage: 'videos', index, action: 'approve', label: index === 0 ? 'Generate clip' : `Continue · clip ${index + 1}`, price,
    short: stale ? 'Out of date' : index === 0 ? `Generate · ${price}` : `Clip ${index + 1} · ${price}`, text: stale ?? fresh, detail: null, blocked,
  }
}

function windowNext(analysis: GoalRemixAnalysis | undefined, seconds: number, blocked: string | null): GoalNextAction {
  const change = analysis?.recipe.change[0]
  return {
    kind: 'window', step: 'video', short: `Pick ${formatGoalSeconds(seconds)} s to keep`, blocked,
    text: 'Choose which part of the take goes into the short, then use that window.',
    detail: change ? `It fills ${formatRange(change)} of the short, after the source shots.` : null,
  }
}

function finishNext(goal: ShortGoalSnapshot, analysis: GoalRemixAnalysis | undefined, input: GoalNextInput): GoalNextAction {
  const failed = goal.finish?.status === 'failed'
  const blocked = input.dirty ? 'Save your changes first.' : input.finishIssue ?? null
  const text = failed ? goal.finish?.error ?? 'Finishing failed.'
    : analysis?.recipe.assembly ? 'Put the short together: the source shots, your action, the sound and the watermark.' : 'Finish the short: burn the title and the saved watermark onto the reviewed take.'
  return { kind: 'finish', step: 'finish', failed, blocked, short: failed ? 'Failed' : blocked ? 'Save first' : 'Ready to finish', text, detail: failed ? 'Finish again to retry.' : 'Free · runs on this computer.' }
}

function reviewNext(goal: ShortGoalSnapshot, plan: GoalShortPlan, analysis: GoalRemixAnalysis | undefined, input: GoalNextInput): GoalNextAction {
  const target = goalReviewTarget(goal, plan, analysis, input.actionReviewed)
  const blocked = input.promptIssue ?? null
  if (target.kind === 'storyboard') return storyboardNext(goal, blocked)
  if (target.kind === 'replacement' || target.kind === 'frame') return stillNext(goal, plan, analysis, target, blocked)
  if (target.kind === 'clip') return clipNext(goal, plan, analysis, target.index, target.stale, blocked)
  if (target.kind === 'window') return windowNext(analysis, target.seconds, input.windowIssue ?? null)
  return finishNext(goal, analysis, input)
}

export function goalNextAction(input: GoalNextInput): GoalNextAction {
  const { goal, plan } = input
  const analysis = input.analysis ?? goalRemixAnalysisOf(plan)
  if (goal.status === 'cancelled') return { kind: 'stopped', step: 'finish', short: 'Discarded', text: 'This goal was discarded. Its images and videos stay in the notebook.', detail: null }
  const busy = busyNext(goal, plan, analysis)
  if (busy) return busy
  if (goal.status === 'failed' || goal.status === 'interrupted') {
    const word = goal.status === 'failed' ? 'failed' : 'was interrupted'
    return { kind: 'retry', step: STAGE_STEPS[goal.stage], short: 'Failed', text: goal.error ?? `This step ${word}.`, detail: 'Retry runs the same step again.' }
  }
  if (goal.finish?.status === 'failed') return finishNext(goal, analysis, input)
  if (goal.status === 'completed') {
    return { kind: 'done', step: 'finish', short: 'Finished', text: `Short ready · ${formatGoalClock(goalPlanSeconds(plan))}.`, detail: 'Change the title and finish again to make a new version.' }
  }
  return recipeNext(goal, plan, { ...input, analysis }) ?? reviewNext(goal, plan, analysis, input)
}

export function goalNextStep(goal: ShortGoalSnapshot, plan: GoalShortPlan): GoalStepKey {
  return goalNextAction({ goal, plan }).step
}

function takeStatus(goal: ShortGoalSnapshot, stage: GoalGenerationStage): string {
  const versions = goalStillVersions(goal, stage, 0)
  const position = versions.findIndex(version => version.current)
  return versions.length > 1 && position >= 0 ? `Take v${versions.length - position} of ${versions.length}` : 'Ready'
}

function windowStatus(goal: ShortGoalSnapshot, analysis: GoalRemixAnalysis): string {
  const fps = analysis.recipe.assembly?.fps
  const window = goal.actionWindow
  return window && fps ? `Keeps ${formatRange({ start: window.startFrame / fps, end: window.endFrame / fps })}` : 'Ready'
}

function stepDone(goal: ShortGoalSnapshot, plan: GoalShortPlan, analysis: GoalRemixAnalysis | undefined, key: GoalStepKey): string | null {
  const ready = (stage: 'replacement' | 'frame') => {
    const output = goal.stages[stage]?.outputs[0]
    return output && !output.stale ? takeStatus(goal, stage) : null
  }
  if (key === 'plan') {
    if (!analysis || !goalSourceReady(plan)) return null
    return analysis.source ? `${STRUCTURE_NAMES[analysis.intent.structure]} · ${analysis.intent.character}` : 'Saved'
  }
  if (key === 'storyboard') return goalStoryboardClean(goal) ? 'Frames clean' : null
  if (key === 'character') return plan.version === 4 ? plan.character.name || 'Saved' : 'Saved'
  if (key === 'replacement' || key === 'frame') return ready(key)
  if (key === 'video') {
    if (goalNextSegment(goal, plan) !== null) return null
    if (!analysis?.recipe.assembly) return `${shortGenerationSegments(plan).length === 1 ? 'Clip' : 'Clips'} ready`
    return goalActionWindowReviewed(goal, analysis) ? windowStatus(goal, analysis) : null
  }
  return goal.finalArtifactId && goal.finish?.status !== 'failed' ? 'Finished' : null
}

function stepStale(goal: ShortGoalSnapshot, key: GoalStepKey): boolean {
  if (key === 'replacement' || key === 'frame') return Boolean(goal.stages[key]?.outputs[0]?.stale)
  return key === 'video' && Boolean(goal.stages.videos?.outputs.some(output => output.stale))
}

function nextTone(next: GoalNextAction): GoalStepTone {
  if (next.kind === 'busy') return 'busy'
  if (next.kind === 'retry' || (next.kind === 'recipe' || next.kind === 'finish') && next.failed) return 'failed'
  return next.kind === 'done' ? 'done' : 'next'
}

function stepArtifact(goal: ShortGoalSnapshot, plan: GoalShortPlan, analysis: GoalRemixAnalysis | undefined, key: GoalStepKey): string | null {
  if (key === 'plan') return analysis?.source?.artifactId ?? shortRemixOf(plan)?.video.artifactId ?? null
  if (key === 'storyboard') {
    const first = goal.storyboard?.frames[0]
    return first ? first.clean?.artifactId ?? first.raw.artifactId : null
  }
  if (key === 'character') return plan.version === 4 ? plan.character.references[0]?.artifactId ?? null : null
  if (key === 'replacement' || key === 'frame') return goal.stages[key]?.outputs[0]?.artifactId ?? null
  if (key === 'video') {
    const clips = goal.stages.videos?.outputs ?? []
    const clip = analysis?.recipe.assembly ? goalAssemblyClip(goal) : [...clips].sort((left, right) => left.index - right.index).at(-1)
    return clip?.artifactId ?? null
  }
  return goal.finalArtifactId
}

export function goalSteps(goal: ShortGoalSnapshot, plan: GoalShortPlan, next: GoalNextAction, analysis = goalRemixAnalysisOf(plan)): GoalStepView[] {
  const keys = goalStepKeys(plan, Boolean(goal.storyboard), analysis)
  const names = goalStepNames(plan, analysis)
  return keys.map((key, position) => {
    const base = { key, name: names[key], artifactId: stepArtifact(goal, plan, analysis, key) }
    if (next.step === key && next.kind !== 'stopped') return { ...base, status: next.short, tone: nextTone(next) }
    const done = stepDone(goal, plan, analysis, key)
    if (done) return { ...base, status: done, tone: 'done' as const }
    if (stepStale(goal, key)) return { ...base, status: 'Out of date', tone: 'stale' as const }
    const previous = keys[position - 1]
    return { ...base, status: previous ? `After ${names[previous]}` : 'Waiting', tone: 'waiting' as const }
  })
}
