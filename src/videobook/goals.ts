import type { GoalSnapshot, LegacyGoalSnapshot, ShortGoalSnapshot } from '../../server/src/tools/goal'
import type { GoalGenerationStage } from '../../server/src/goal-store'
import { shortStoryboardOf, type GoalShortPlan, type ShortFinishTitle } from '../../server/src/goal-short-plan'
import { lowerBoundCost } from './command-plan'
import { lowerBoundEstimate } from './provider-payload-preview'

export type { GoalSnapshot, LegacyGoalSnapshot, ShortGoalSnapshot }
export type ShortTab = 'storyboard' | 'character' | 'frame' | 'video' | 'finish'
export type GoalShotState = 'planned' | 'waiting' | 'submitting' | 'generating' | 'done' | 'failed' | 'skipped' | 'stopped'
export type GoalPhase = 'planning' | 'review' | 'storyboards' | 'frame' | 'videos' | 'complete' | 'failed' | 'interrupted' | 'stopped'
export type GoalShotView = {
  index: number
  number: string
  title: string
  prompt: string
  seconds: number
  state: GoalShotState
  startedAt: string | null
  cellId: string | null
  address: string | null
  artifactId: string | null
  error: string | null
}
export type GoalProgress = {
  phase: GoalPhase
  reviewStage: GoalGenerationStage | null
  stage: GoalGenerationStage
  shots: GoalShotView[]
  done: number
  total: number
  active: GoalShotView | null
}
export type GoalStatusTone = 'live' | 'review' | 'done' | 'attention' | 'quiet'
export type GoalStatusLine = {
  text: string
  short: string
  announce: string
  action: string | null
  tone: GoalStatusTone
  busy: boolean
}
export type GoalWake = {
  id: string
  from: string
  tone: 'live' | 'attention'
}
type GoalStep = ShortGoalSnapshot['steps'][number]
type GoalEstimate = { usd: number | null, warnings: readonly string[] }

export const LEGACY_GOAL_NOTE = 'Made by an earlier /goal. Its images and videos stay in the notebook.'

export function shortPlanOf(goal: GoalSnapshot | null | undefined): GoalShortPlan | null {
  return goal && !goal.legacy ? goal.shortPlan ?? null : null
}

export function goalStillVersions(goal: ShortGoalSnapshot, stage: GoalGenerationStage, index: number) {
  return goal.stages[stage]?.outputs.find(output => output.index === index)?.versions ?? []
}

export function goalStillStale(goal: ShortGoalSnapshot, stage: GoalGenerationStage, index: number): string | null {
  return goal.stages[stage]?.outputs.find(output => output.index === index)?.stale ?? null
}

export function goalNextSegment(goal: ShortGoalSnapshot, plan: GoalShortPlan): number | null {
  const index = plan.segments.findIndex((_, position) => !goal.stages.videos?.outputs.some(output => output.index === position) || goalStillStale(goal, 'videos', position))
  return index < 0 ? null : index
}

export function defaultShortTab(goal: ShortGoalSnapshot, plan: GoalShortPlan): ShortTab {
  if (goal.finish && goalNextSegment(goal, plan) === null) return 'finish'
  if (goal.stage === 'videos') return 'video'
  if (goal.stage === 'storyboards') return 'storyboard'
  return plan.version === 4 && !goal.stages.frame ? 'character' : 'frame'
}

export function goalStoryboardClean(goal: ShortGoalSnapshot): boolean {
  return (goal.storyboard?.frames ?? []).every(frame => frame.clean)
}

function goalStoryboardFailures(goal: ShortGoalSnapshot): number {
  return (goal.storyboard?.frames ?? []).filter(frame => frame.failure?.kind === 'failed').length
}

function storyboardFailureText(goal: ShortGoalSnapshot): string {
  return `Storyboard: ${goalStoryboardFailures(goal)} of ${goal.storyboard?.frames.length ?? 0} failed`
}

export function goalStoryboardEstimate(goal: ShortGoalSnapshot): GoalEstimate {
  const frames = goal.storyboard?.frames ?? []
  const missing = frames.filter(frame => !frame.clean)
  const parts = missing.flatMap(frame => frame.estimate ? [frame.estimate] : [])
  if (missing.length === frames.length || parts.length !== missing.length) return goal.estimate.storyboards
  return {
    usd: parts.every(part => part.usd !== null) ? parts.reduce((sum, part) => sum + (part.usd ?? 0), 0) : null,
    warnings: [...new Set(parts.flatMap(part => part.warnings))],
  }
}

export function goalOutputEstimate(goal: ShortGoalSnapshot, stage: GoalGenerationStage, index: number): number | null {
  if (stage === 'videos') return goal.estimate.segments?.[index]?.usd ?? null
  if (stage === 'storyboards') return goal.estimate.storyboardFrames?.[index]?.usd ?? null
  return goal.estimate.frame.usd
}

function revisionAttempt(goal: ShortGoalSnapshot) {
  return Object.values(goal.stages).flatMap(run => run.attempts ?? []).find(attempt => attempt.chainId === goal.chainId && attempt.feedback)
}

function stillName(stage: GoalGenerationStage, index: number): string {
  if (stage === 'videos') return `clip ${index + 1}`
  return stage === 'storyboards' ? `storyboard frame ${index + 1}` : 'frame'
}

function revisionLabel(goal: ShortGoalSnapshot): string | null {
  const attempt = revisionAttempt(goal)
  return attempt ? stillName(attempt.stage, attempt.index) : null
}

function capitalized(text: string): string {
  return `${text[0]!.toUpperCase()}${text.slice(1)}`
}

export function goalCanRetry(goal: GoalSnapshot): boolean {
  return !goal.legacy && (goal.status === 'failed' || goal.status === 'interrupted')
}

export function goalStopLabel(goal: ShortGoalSnapshot): string {
  if (goal.status !== 'running' || !goal.resumeStage) return 'Stop goal'
  return revisionAttempt(goal) ? 'Stop revision' : 'Stop regeneration'
}

function stoppedStillLabel(previous: ShortGoalSnapshot, before: GoalProgress, after: GoalProgress, current: ShortGoalSnapshot): string | null {
  if (after.phase !== 'review' || (before.phase !== 'frame' && before.phase !== 'storyboards')) return null
  if (!previous.chainId || !current.stages[before.stage]?.previousChainIds.includes(previous.chainId)) return null
  const revised = revisionLabel(previous)
  if (revised) return `${capitalized(revised)} revision stopped`
  return before.phase === 'storyboards' ? 'Storyboard clean-up stopped' : 'Frame generation stopped'
}

export function asGoal(value: unknown): GoalSnapshot {
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'video-goal') throw new Error('The server returned an invalid video goal')
  return value as GoalSnapshot
}

export function asGoalTitleOptions(value: unknown): ShortFinishTitle[] {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const options = (Array.isArray(record.options) ? record.options : []).flatMap((option: unknown) => {
    const title = option && typeof option === 'object' ? option as Record<string, unknown> : {}
    return typeof title.headline === 'string' && typeof title.secondary === 'string' ? [{ headline: title.headline, secondary: title.secondary }] : []
  })
  if (options.length === 0) throw new Error('The server returned no title options')
  return options
}

export function asGoals(value: unknown): GoalSnapshot[] {
  if (!value || typeof value !== 'object' || !('goals' in value) || !Array.isArray(value.goals)) throw new Error('The server returned an invalid goal list')
  return value.goals.map(asGoal)
}

function goalShotStateLabel(state: GoalShotState): string {
  return { planned: 'Planned', waiting: 'Waiting', submitting: 'Submitting', generating: 'Generating', done: 'Ready', failed: 'Failed', skipped: 'Not started', stopped: 'Stopped' }[state]
}

export function formatGoalClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function goalPlanSeconds(plan: GoalShortPlan | null): number {
  return plan ? plan.segments.reduce((sum, segment) => sum + segment.seconds, 0) : 0
}

function shotState(goal: ShortGoalSnapshot, step: GoalStep | undefined, completed: boolean): GoalShotState {
  if (!step) return completed ? 'done' : goal.status === 'planning' || goal.status === 'review' ? 'planned' : 'waiting'
  if (step.status === 'completed') return 'done'
  if (step.status === 'running') return step.address ? 'generating' : 'submitting'
  if (step.status === 'failed' || step.status === 'interrupted') return 'failed'
  if (step.status === 'cancelled' || step.status === 'rejected') return 'stopped'
  if (step.status === 'skipped') return goal.status === 'cancelled' ? 'stopped' : 'skipped'
  return 'waiting'
}

function rowNumber(index: number): string {
  return String(index + 1).padStart(2, '0')
}

function shortRows(short: GoalShortPlan | null, stage: GoalGenerationStage) {
  if (!short) return []
  if (stage === 'storyboards') {
    return (shortStoryboardOf(short)?.frames ?? []).map(frame => ({ index: frame.index, number: rowNumber(frame.index), title: `Storyboard ${frame.index + 1}`, prompt: frame.prompt, seconds: 0 }))
  }
  return stage === 'frame'
    ? [{ index: 0, number: '01', title: 'Frame', prompt: short.frame.prompt, seconds: 0 }]
    : short.segments.map((segment, index) => ({ index, number: rowNumber(index), title: `Clip ${index + 1}`, prompt: segment.prompt, seconds: segment.seconds }))
}

function stageStepId(stage: GoalGenerationStage, index: number): string {
  if (stage === 'videos') return `clip${index + 1}`
  return stage === 'storyboards' ? `storyboard${index + 1}` : 'frame'
}

function goalShots(goal: ShortGoalSnapshot, stage: GoalGenerationStage): GoalShotView[] {
  const run = goal.stages[stage]
  const steps = new Map((run?.steps ?? []).map(step => [step.id, step]))
  return shortRows(shortPlanOf(goal), stage).map(row => {
    const step = steps.get(stageStepId(stage, row.index))
    const output = run?.outputs.find(item => item.index === row.index)
    const failure = !step && !output && stage === 'storyboards' ? goal.storyboard?.frames.find(frame => frame.index === row.index)?.failure ?? null : null
    return {
      ...row, state: failure ? failure.kind === 'failed' ? 'failed' : 'skipped' : shotState(goal, step, Boolean(output)), startedAt: step?.startedAt ?? null,
      cellId: step?.cellId ?? output?.cellId ?? null, address: step?.address ?? output?.address ?? null,
      artifactId: step?.status === 'completed' ? step.artifactId : output?.artifactId ?? null, error: step?.error ?? failure?.message ?? null,
    }
  })
}

function goalPhase(goal: ShortGoalSnapshot, stage: GoalGenerationStage): GoalPhase {
  if (goal.status === 'cancelled') return 'stopped'
  if (goal.status === 'completed') return 'complete'
  if (goal.status !== 'running') return goal.status
  return stage
}

export function goalProgress(goal: ShortGoalSnapshot): GoalProgress {
  const stage: GoalGenerationStage = goal.stage === 'storyboards' || goal.stage === 'frame' ? goal.stage : 'videos'
  const shots = goalShots(goal, stage)
  const phase = goalPhase(goal, stage)
  const active = shots.find(shot => shot.state === 'failed')
    ?? shots.find(shot => shot.state === 'submitting' || shot.state === 'generating')
    ?? (phase === 'frame' || phase === 'videos' ? shots.find(shot => shot.state !== 'done') ?? null : null)
  return {
    phase, stage, reviewStage: phase === 'review' ? stage : null, shots,
    done: shots.filter(shot => shot.state === 'done').length, total: shots.length, active,
  }
}

function statusLine(text: string, short: string, action: string | null, tone: GoalStatusTone, busy: boolean): GoalStatusLine {
  return { text, short, announce: `Goal: ${text}`, action, tone, busy }
}

export function shortEstimateText(estimate: { usd: number | null, warnings: readonly string[] } | undefined): string {
  if (!estimate || estimate.usd === null) return `estimate unavailable${estimate?.warnings[0] ? ` (${estimate.warnings[0]})` : ''}`
  const amount = `$${estimate.usd.toFixed(2)}`
  return lowerBoundEstimate(estimate.warnings) ? lowerBoundCost(amount) : amount
}

function legacyStatusLine(goal: LegacyGoalSnapshot): GoalStatusLine {
  const state = goal.status === 'completed' ? 'complete' : goal.status === 'cancelled' ? 'stopped' : 'read-only'
  return statusLine(`Earlier goal · ${state}`, 'Earlier', 'Open', 'quiet', false)
}

export function goalStatusLine(goal: GoalSnapshot, elapsedSeconds: number | null = null): GoalStatusLine {
  if (goal.legacy) return legacyStatusLine(goal)
  const short = shortPlanOf(goal)
  const progress = goalProgress(goal)
  const total = short?.segments.length ?? 0
  const finish = goal.finish
  if (progress.phase === 'planning') return statusLine('Planning', 'Planning', null, 'live', true)
  if (finish?.status === 'running') return statusLine('Burning the saved watermark', 'Finishing', null, 'live', true)
  if (finish?.status === 'failed') return statusLine('Finishing failed', 'Finishing failed', 'Finish', 'attention', false)
  if (progress.phase === 'review') {
    if (goal.stage === 'storyboards' && goalStoryboardFailures(goal) > 0) return statusLine(storyboardFailureText(goal), 'Review', 'Review', 'attention', false)
    if (goal.stage === 'storyboards') return statusLine(`Review storyboard · ${shortEstimateText(goalStoryboardEstimate(goal))}`, 'Review', 'Review', 'review', false)
    if (goal.stage !== 'videos') return statusLine(`Review frame · ${shortEstimateText(goal.estimate.frame)}`, 'Review', 'Review', 'review', false)
    const next = progress.shots.find(shot => shot.state !== 'done' || goalStillStale(goal, 'videos', shot.index))?.index
    if (next === undefined) return statusLine(`Review finish · ${formatGoalClock(goalPlanSeconds(short))}`, 'Review', 'Review', 'review', false)
    return statusLine(`Review clip ${next + 1} of ${total} · ${shortEstimateText(goal.estimate.segments?.[next])}`, 'Review', 'Review', 'review', false)
  }
  if (progress.phase === 'storyboards' || progress.phase === 'frame' || progress.phase === 'videos') {
    const activity = progress.active?.state === 'generating' ? `Generating${elapsedSeconds === null ? '' : ` ${formatGoalClock(elapsedSeconds)}`}` : 'Submitting'
    const revised = revisionLabel(goal)
    const number = (progress.active?.index ?? 0) + 1
    const name = progress.phase === 'frame' ? 'Frame' : progress.phase === 'storyboards' ? `Storyboard ${number} of ${progress.total}` : `Clip ${number} of ${total}`
    const compact = progress.phase === 'frame' ? 'Frame' : progress.phase === 'storyboards' ? 'Storyboard' : `${number}/${total}`
    return statusLine(`${revised ? `Revising ${revised}` : name} · ${activity}`, compact, null, 'live', true)
  }
  if (progress.phase === 'failed' || progress.phase === 'interrupted') {
    const word = progress.phase === 'failed' ? 'failed' : 'interrupted'
    const number = (progress.active?.index ?? 0) + 1
    const board = progress.phase === 'failed' && goalStoryboardFailures(goal) > 0 ? storyboardFailureText(goal) : `Storyboard ${number} ${word}`
    const text = !goal.chainId ? `Planning ${word}` : progress.stage === 'videos' ? `Clip ${number} ${word}` : progress.stage === 'storyboards' ? board : `Frame ${word}`
    return statusLine(text, progress.phase === 'failed' ? 'Failed' : 'Interrupted', 'Retry', 'attention', false)
  }
  if (progress.phase === 'complete') return statusLine(`Short ready · ${formatGoalClock(goalPlanSeconds(short))}`, 'Done', 'Preview', 'done', false)
  return statusLine('Stopped', 'Stopped', null, 'quiet', false)
}

export function goalWakeKey(goal: ShortGoalSnapshot): string {
  const progress = goalProgress(goal)
  return `${goal.goalId}:${goal.chainId ?? ''}:${progress.phase}:${progress.stage}:${progress.done}:${progress.active?.index ?? -1}`
}

export function goalWake(previous: GoalSnapshot, current: GoalSnapshot): GoalWake | null {
  if (previous.legacy || current.legacy) return null
  const id = goalWakeKey(current)
  if (previous.goalId !== current.goalId || goalWakeKey(previous) === id || current.status === 'cancelled') return null
  const before = goalProgress(previous)
  const after = goalProgress(current)
  let from = goalStatusLine(previous).text
  const revised = revisionLabel(current)
  const stopped = stoppedStillLabel(previous, before, after, current)
  const boardFailed = after.phase === 'review' && before.phase === 'storyboards' && goalStoryboardFailures(current) > 0
  if (after.phase === 'failed' || after.phase === 'interrupted') from = goalStatusLine(current).text
  else if (after.phase === 'complete') from = 'Short ready'
  else if (before.phase === 'planning' && after.phase === 'review') from = 'Plan ready'
  else if (stopped) from = stopped
  else if (boardFailed) from = storyboardFailureText(current)
  else if (after.phase === 'review' && revised) from = `${capitalized(revised)} revised`
  else if (after.phase === 'review' && before.stage === 'storyboards') from = 'Storyboard clean'
  else if (after.phase === 'review' && after.stage === 'videos' && before.stage === 'frame') from = 'Frame ready'
  else if (after.phase === 'review' && after.stage === 'videos') from = `Clip ${Math.max(1, after.done)} ready`
  else if (before.phase === 'review') from = revised ? `Revising ${revised}` : { storyboards: 'Storyboard approved', frame: 'Frame approved', videos: 'Clip approved' }[after.stage]
  else if (before.phase === 'failed' || before.phase === 'interrupted') from = `Retrying the ${{ storyboards: 'storyboard', frame: 'frame', videos: 'clip' }[after.stage]}`
  return { id, from, tone: after.phase === 'failed' || after.phase === 'interrupted' || boardFailed ? 'attention' : 'live' }
}

export function composerGoal(goals: readonly GoalSnapshot[]): ShortGoalSnapshot | null {
  return goals.find((goal): goal is ShortGoalSnapshot => !goal.legacy && goal.status !== 'cancelled' && !goal.dismissedAt && Boolean(goal.cellId)) ?? null
}

export function goalGenerationMarks(goals: readonly GoalSnapshot[]): ReadonlyMap<string, string> {
  const marks = new Map<string, string>()
  for (const goal of goals) {
    if (goal.legacy) continue
    const plan = shortPlanOf(goal)
    const segments = plan?.segments.length ?? 1
    const boards = shortStoryboardOf(plan)?.frames.length ?? 1
    for (const step of Object.values(goal.stages).flatMap(run => run.allSteps)) {
      const clip = /^clip(\d+)$/.exec(step.id)
      const board = /^storyboard(\d+)$/.exec(step.id)
      const stage = clip ? 'videos' : board ? 'storyboards' : step.id === 'frame' ? 'frame' : null
      if (!stage) continue
      const numbered = clip ?? board
      const attempts = goal.stages[stage]?.attempts?.filter(attempt => attempt.index === (numbered ? Number(numbered[1]) - 1 : 0)) ?? []
      const version = attempts.findIndex(attempt => attempt.chainId === step.chainId && attempt.stepId === step.id)
      const name = clip ? `Clip ${clip[1]}` : board ? `Storyboard ${board[1]}` : 'Frame'
      const label = attempts.length > 1 && version >= 0 ? `${name} v${version + 1}`
        : clip ? `${name}/${segments}` : board ? `${name}/${boards}` : name
      for (const id of [step.cellId, step.outputCellId]) if (id) marks.set(id, `${label}${goal.address ? ` · ${goal.address}` : ''}`)
    }
  }
  return marks
}

export type GoalTileRow = {
  key: string
  number: string
  title: string
  state: GoalShotState
  detail: string
  startedAt: string | null
}
type GoalTileThumbnail = {
  artifactId: string
  cellId: string | null
  label: string
}
type GoalTileView = {
  title: string
  planning: boolean
  rows: GoalTileRow[]
  hiddenRows: number
  note: string | null
  noteTone: GoalStatusTone
  chip: { label: string, tone: GoalStatusTone }
  progressPercent: number
  shotsLabel: string | null
  aspectRatio: string | null
  thumbnails: GoalTileThumbnail[]
}
const TILE_ROW_LIMIT = 5
const tileChips: Record<GoalPhase, { label: string, tone: GoalStatusTone }> = {
  planning: { label: 'Planning', tone: 'live' }, review: { label: 'Review', tone: 'review' },
  storyboards: { label: 'Storyboard', tone: 'live' }, frame: { label: 'Frame', tone: 'live' }, videos: { label: 'Videos', tone: 'live' },
  complete: { label: 'Complete', tone: 'done' },
  failed: { label: 'Failed', tone: 'attention' }, interrupted: { label: 'Interrupted', tone: 'attention' }, stopped: { label: 'Stopped', tone: 'quiet' },
}

function tileNote(goal: ShortGoalSnapshot, progress: GoalProgress): string | null {
  if (progress.phase === 'failed' || progress.phase === 'interrupted') return `${goalStatusLine(goal).text} · open to retry`
  if (progress.phase === 'planning') return goal.brief || null
  if (progress.phase === 'review') return goalStatusLine(goal).text
  if (progress.phase === 'complete') return `Short ready · ${formatGoalClock(goalPlanSeconds(shortPlanOf(goal)))}`
  return null
}

function overallProgress(goal: ShortGoalSnapshot): number {
  if (goal.status === 'completed') return 100
  const short = shortPlanOf(goal)
  if (!short) return 0
  const storyboard = goal.storyboard ? 1 : 0
  const done = (storyboard && goalStoryboardClean(goal) ? 1 : 0) + (goal.stages.frame?.outputs.length ? 1 : 0) + (goal.stages.videos?.outputs.length ?? 0)
  return Math.round(done / (storyboard + 1 + short.segments.length) * 100)
}

const STORYBOARD_STATE_ORDER: readonly GoalShotState[] = ['failed', 'generating', 'submitting', 'stopped', 'waiting', 'skipped', 'planned']

function storyboardRowState(goal: ShortGoalSnapshot, progress: GoalProgress): Pick<GoalShotView, 'state' | 'startedAt'> {
  if (progress.stage !== 'storyboards') return { state: goalStoryboardClean(goal) ? 'done' : 'planned', startedAt: null }
  const shots = progress.shots
  const state = shots.length > 0 && shots.every(shot => shot.state === 'done') ? 'done' : STORYBOARD_STATE_ORDER.find(candidate => shots.some(shot => shot.state === candidate)) ?? 'planned'
  return { state, startedAt: shots.find(shot => shot.state === state)?.startedAt ?? null }
}

function storyboardTileShots(goal: ShortGoalSnapshot, progress: GoalProgress, short: GoalShortPlan): GoalShotView[] | null {
  if (!goal.storyboard || progress.stage === 'videos') return null
  const blank = { prompt: '', seconds: 0, cellId: null, address: null, artifactId: null, error: null }
  const frame = progress.stage === 'frame' ? progress.shots[0] : undefined
  return [
    { ...blank, index: 0, number: '01', title: 'Storyboard', ...storyboardRowState(goal, progress) },
    { ...blank, prompt: short.frame.prompt, ...frame, index: 1, number: '02', title: 'Frame', state: frame?.state ?? 'planned', startedAt: frame?.startedAt ?? null },
  ]
}

function legacyTileView(goal: LegacyGoalSnapshot): GoalTileView {
  const complete = goal.status === 'completed'
  return {
    title: goal.title ?? 'Earlier goal', planning: false, rows: [], hiddenRows: 0,
    note: LEGACY_GOAL_NOTE, noteTone: 'quiet',
    chip: complete ? { label: 'Complete', tone: 'done' } : { label: 'Earlier', tone: 'quiet' },
    progressPercent: complete ? 100 : 0,
    shotsLabel: goal.outputs.length > 0 ? `${goal.outputs.length} output${goal.outputs.length === 1 ? '' : 's'}` : null,
    aspectRatio: null,
    thumbnails: goal.outputs.filter(output => output.stage !== 'videos').slice(0, 3).map(output => ({ artifactId: output.artifactId, cellId: output.cellId, label: output.stage === 'frame' ? 'Frame' : 'Storyboard' })),
  }
}

export function goalTileView(goal: GoalSnapshot | null, label: string | undefined): GoalTileView {
  if (goal?.legacy) return legacyTileView(goal)
  const short = shortPlanOf(goal)
  if (!goal || !short) {
    const planning = goal?.status === 'planning'
    return {
      title: planning ? 'Planning your short' : goal ? 'Short' : label ?? 'Short', planning,
      rows: [], hiddenRows: 0, note: goal ? planning ? goal.brief || null : tileNote(goal, goalProgress(goal)) : null,
      noteTone: goal ? tileChips[goalProgress(goal).phase].tone : 'quiet',
      chip: goal ? tileChips[goalProgress(goal).phase] : { label: 'Goal', tone: 'quiet' },
      progressPercent: 0, shotsLabel: null, aspectRatio: null, thumbnails: [],
    }
  }
  const progress = goalProgress(goal)
  const shots = storyboardTileShots(goal, progress, short) ?? progress.shots
  const visible = shots.length > TILE_ROW_LIMIT ? shots.slice(0, TILE_ROW_LIMIT - 1) : shots
  const seconds = goalPlanSeconds(short)
  return {
    title: short.title, planning: progress.phase === 'planning',
    rows: visible.map(shot => ({
      key: `${progress.stage}:${shot.index}`, number: shot.number, title: shot.title, state: shot.state,
      detail: shot.state === 'generating' ? '' : shot.state === 'submitting' ? 'Queued'
        : shot.seconds > 0 && (shot.state === 'done' || shot.state === 'planned') ? shot.state === 'done' ? formatGoalClock(shot.seconds) : `${shot.seconds}s` : goalShotStateLabel(shot.state),
      startedAt: shot.state === 'generating' ? shot.startedAt : null,
    })),
    hiddenRows: shots.length - visible.length, note: tileNote(goal, progress),
    noteTone: progress.phase === 'review' && goal.stage === 'storyboards' && goalStoryboardFailures(goal) > 0 ? 'attention' : tileChips[progress.phase].tone,
    chip: goal.finish?.status === 'running' ? { label: 'Finishing', tone: 'live' } : tileChips[progress.phase],
    progressPercent: overallProgress(goal),
    shotsLabel: short.segments.length === 1 ? `1 × ${seconds}s` : `${short.segments.length} clips · ${seconds}s`,
    aspectRatio: short.aspectRatio,
    thumbnails: (goal.stages.frame?.outputs ?? []).map(output => ({ artifactId: output.artifactId, cellId: output.cellId, label: 'Frame' })),
  }
}
