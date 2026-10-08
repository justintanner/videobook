import type { GoalSnapshot } from '../../server/src/tools/goal'
import type { GoalDisplayPlan, GoalGenerationStage, GoalPlan, GoalStillStage } from '../../server/src/goal-plan'

export type { GoalSnapshot }
export type GoalShotState = 'planned' | 'waiting' | 'submitting' | 'generating' | 'done' | 'failed' | 'skipped' | 'stopped'
export type GoalPhase = 'planning' | 'review' | 'frame' | 'storyboards' | 'videos' | 'assembling' | 'complete' | 'failed' | 'interrupted' | 'stopped'
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
  failedStep: string | null
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
type GoalStep = GoalSnapshot['steps'][number]

export function isStagedGoalPlan(plan: GoalDisplayPlan | null): plan is GoalPlan {
  return Boolean(plan && 'version' in plan && plan.version === 2)
}

export function goalPlansEqual(left: GoalPlan, right: GoalPlan): boolean {
  return left.title === right.title && left.continuity === right.continuity
    && left.aspectRatio === right.aspectRatio && left.imageModel === right.imageModel
    && left.imageResolution === right.imageResolution && left.videoResolution === right.videoResolution
    && Boolean(left.frameContinuity) === Boolean(right.frameContinuity)
    && left.frame.prompt === right.frame.prompt && left.shots.length === right.shots.length
    && left.shots.every((shot, index) => shot.title === right.shots[index]?.title
      && shot.storyboardPrompt === right.shots[index]?.storyboardPrompt
      && (shot.endingPrompt ?? null) === (right.shots[index]?.endingPrompt ?? null)
      && shot.videoPrompt === right.shots[index]?.videoPrompt && shot.durationSeconds === right.shots[index]?.durationSeconds)
}

export function goalStillVersions(goal: GoalSnapshot, stage: GoalStillStage, index: number) {
  return goal.stages[stage]?.outputs.find(output => output.index === index)?.versions ?? []
}

export function goalStillStale(goal: GoalSnapshot, stage: GoalStillStage, index: number): string | null {
  return goal.stages[stage]?.outputs.find(output => output.index === index)?.stale ?? null
}

function revisionAttempt(goal: GoalSnapshot) {
  return Object.values(goal.stages).flatMap(run => run.attempts ?? []).find(attempt => attempt.chainId === goal.chainId && attempt.feedback)
}

function revisionLabel(goal: GoalSnapshot): string | null {
  const attempt = revisionAttempt(goal)
  if (!attempt) return null
  if (attempt.stage === 'frame') return 'frame'
  const count = goal.plan?.shots.length ?? 1
  return `${attempt.index >= count ? 'ending frame' : 'storyboard'} ${attempt.index % count + 1}`
}

export function goalCanRetry(goal: GoalSnapshot): boolean {
  return goal.planVersion === 2 && (goal.status === 'failed' || goal.status === 'interrupted')
}

export function goalStopLabel(goal: GoalSnapshot): string {
  if (goal.status !== 'running' || !goal.resumeStage) return 'Stop goal'
  return revisionAttempt(goal) ? 'Stop revision' : 'Stop regeneration'
}

function stoppedStillLabel(previous: GoalSnapshot, before: GoalProgress, after: GoalProgress, current: GoalSnapshot): string | null {
  if (after.phase !== 'review' || !['frame', 'storyboards'].includes(before.phase)) return null
  if (!previous.chainId || !current.stages[before.stage]?.previousChainIds.includes(previous.chainId)) return null
  const revised = revisionLabel(previous)
  return `${revised ? `${revised[0]!.toUpperCase()}${revised.slice(1)} revision` : before.stage === 'frame' ? 'Frame generation' : 'Storyboard generation'} stopped`
}

export function asGoal(value: unknown): GoalSnapshot {
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'video-goal') throw new Error('The server returned an invalid video goal')
  return value as GoalSnapshot
}

export function asGoals(value: unknown): GoalSnapshot[] {
  if (!value || typeof value !== 'object' || !('goals' in value) || !Array.isArray(value.goals)) throw new Error('The server returned an invalid goal list')
  return value.goals.map(asGoal)
}

export function goalShotStateLabel(state: GoalShotState): string {
  return { planned: 'Planned', waiting: 'Waiting', submitting: 'Submitting', generating: 'Generating', done: 'Ready', failed: 'Failed', skipped: 'Not started', stopped: 'Stopped' }[state]
}

export function formatGoalClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function goalPlanSeconds(plan: GoalDisplayPlan | null): number {
  return plan?.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0) ?? 0
}

function shotState(goal: GoalSnapshot, step: GoalStep | undefined, completed: boolean): GoalShotState {
  if (!step) return completed ? 'done' : goal.status === 'planning' || goal.status === 'review' ? 'planned' : 'waiting'
  if (step.status === 'completed') return 'done'
  if (step.status === 'running') return step.address ? 'generating' : 'submitting'
  if (step.status === 'failed' || step.status === 'interrupted') return 'failed'
  if (step.status === 'cancelled' || step.status === 'rejected') return 'stopped'
  if (step.status === 'skipped') return goal.status === 'cancelled' ? 'stopped' : 'skipped'
  return 'waiting'
}

function plannedShots(plan: GoalDisplayPlan | null): GoalShotView[] {
  return (plan?.shots ?? []).map((shot, index) => ({
    index, number: String(index + 1).padStart(2, '0'), title: shot.title,
    prompt: 'videoPrompt' in shot ? shot.videoPrompt : shot.prompt,
    seconds: shot.durationSeconds, state: 'planned', startedAt: null, cellId: null, address: null, artifactId: null, error: null,
  }))
}

function goalShots(goal: GoalSnapshot, stage: GoalGenerationStage): GoalShotView[] {
  const plan = goal.plan
  const firstRows = stage === 'frame' && isStagedGoalPlan(plan)
    ? [{ index: 0, number: '01', title: 'Full frame', prompt: plan.frame.prompt, seconds: 0 }]
    : (plan?.shots ?? []).map((shot, index) => ({
        index, number: String(index + 1).padStart(2, '0'), title: shot.title,
        prompt: 'videoPrompt' in shot ? stage === 'storyboards' ? shot.storyboardPrompt : shot.videoPrompt : shot.prompt,
        seconds: stage === 'videos' ? shot.durationSeconds : 0,
      }))
  const rows = stage === 'storyboards' && isStagedGoalPlan(plan) && plan.frameContinuity
    ? [...firstRows, ...plan.shots.map((shot, index) => ({ index: index + plan.shots.length, number: `${String(index + 1).padStart(2, '0')} end`, title: `${shot.title} · Ending`, prompt: shot.endingPrompt ?? shot.videoPrompt, seconds: 0 }))]
    : firstRows
  const run = goal.stages[stage]
  const steps = new Map((run?.steps ?? (goal.planVersion === 1 ? goal.steps : [])).map(step => [step.id, step]))
  return rows.map(row => {
    const id = stage === 'frame' ? 'frame' : `${stage === 'storyboards' ? 'storyboard' : 'shot'}${row.index + 1}`
    const step = steps.get(id)
    const output = run?.outputs.find(item => item.index === row.index)
    return {
      ...row, state: shotState(goal, step, Boolean(output)), startedAt: step?.startedAt ?? null,
      cellId: step?.cellId ?? output?.cellId ?? null, address: step?.address ?? output?.address ?? null,
      artifactId: step?.status === 'completed' ? step.artifactId : output?.artifactId ?? null, error: step?.error ?? null,
    }
  })
}

function goalPhase(goal: GoalSnapshot, stage: GoalGenerationStage): GoalPhase {
  if (goal.status === 'cancelled') return 'stopped'
  if (goal.status === 'completed') return 'complete'
  if (goal.status !== 'running') return goal.status
  return goal.stage === 'assembly' || goal.steps.some(step => step.id === 'assemble' && step.status === 'running') ? 'assembling' : stage
}

export function goalProgress(goal: GoalSnapshot): GoalProgress {
  const stage = goal.stage === 'assembly' ? 'videos' : goal.stage
  const shots = goalShots(goal, stage)
  const phase = goalPhase(goal, stage)
  const active = shots.find(shot => shot.state === 'failed')
    ?? shots.find(shot => shot.state === 'submitting' || shot.state === 'generating')
    ?? (['frame', 'storyboards', 'videos'].includes(phase) ? shots.find(shot => shot.state !== 'done') ?? null : null)
  return {
    phase, stage, reviewStage: phase === 'review' ? stage : null, shots,
    done: shots.filter(shot => shot.state === 'done').length, total: shots.length, active,
    failedStep: goal.steps.find(step => step.status === 'failed' || step.status === 'interrupted')?.id ?? null,
  }
}

export function goalStageLabel(stage: GoalGenerationStage): string {
  return { frame: 'Full frame', storyboards: 'Storyboards', videos: 'Videos' }[stage]
}

function estimateText(goal: GoalSnapshot, stage: GoalGenerationStage): string {
  const estimate = goal.estimate[stage]
  return estimate.usd === null ? '' : ` · est. $${estimate.usd.toFixed(2)}`
}

function failureText(progress: GoalProgress, word: string): string {
  if (progress.failedStep === null) return `Planning ${word}`
  if (progress.failedStep === 'assemble') return `Assembly ${word}`
  if (progress.stage === 'frame') return `Full frame ${word}`
  return `${progress.stage === 'storyboards' ? 'Storyboard' : 'Shot'} ${(progress.active?.index ?? 0) + 1} ${word}`
}

export function goalStatusLine(goal: GoalSnapshot, elapsedSeconds: number | null = null): GoalStatusLine {
  const progress = goalProgress(goal)
  let text = 'Stopped'
  let short = 'Stopped'
  let action: string | null = null
  let tone: GoalStatusTone = 'quiet'
  let busy = false
  if (progress.phase === 'planning') {
    text = short = 'Planning'
    tone = 'live'
    busy = true
  } else if (progress.phase === 'review') {
    text = progress.stage === 'frame' ? `Review plan${estimateText(goal, 'frame')}` : progress.stage === 'storyboards' ? 'Review full frame' : 'Review storyboards'
    short = action = 'Review'
    tone = 'review'
  } else if (['frame', 'storyboards', 'videos'].includes(progress.phase)) {
    const number = progress.active ? progress.active.index + 1 : progress.done + 1
    const activity = progress.active?.state === 'generating' ? `Generating${elapsedSeconds === null ? '' : ` ${formatGoalClock(elapsedSeconds)}`}` : 'Submitting'
    const revised = revisionLabel(goal)
    text = `${revised ? `Revising ${revised}` : progress.stage === 'frame' ? 'Full frame' : `${progress.stage === 'storyboards' ? 'Storyboard' : 'Shot'} ${number} of ${progress.total}`} · ${activity}`
    short = progress.stage === 'frame' ? 'Frame' : `${progress.stage === 'storyboards' ? 'SB ' : ''}${number}/${progress.total}`
    tone = 'live'
  } else if (progress.phase === 'assembling') {
    text = `Assembling ${progress.total} clips`
    short = 'Combining'
    tone = 'live'
    busy = true
  } else if (progress.phase === 'complete') {
    text = `Complete · ${formatGoalClock(goalPlanSeconds(goal.plan))}`
    short = 'Done'
    action = 'Preview'
    tone = 'done'
  } else if (progress.phase === 'failed' || progress.phase === 'interrupted') {
    text = failureText(progress, progress.phase === 'failed' ? 'failed' : 'interrupted')
    short = progress.phase === 'failed' ? 'Failed' : 'Interrupted'
    action = goal.planVersion === 1 ? null : 'Retry'
    tone = 'attention'
  }
  return { text, short, announce: `Goal: ${text}`, action, tone, busy }
}

export function goalWakeKey(goal: GoalSnapshot): string {
  const progress = goalProgress(goal)
  return `${goal.goalId}:${goal.chainId ?? ''}:${progress.phase}:${progress.stage}:${progress.done}:${progress.active?.index ?? -1}`
}

export function goalWake(previous: GoalSnapshot, current: GoalSnapshot): GoalWake | null {
  const id = goalWakeKey(current)
  if (previous.goalId !== current.goalId || goalWakeKey(previous) === id || current.status === 'cancelled') return null
  const before = goalProgress(previous)
  const after = goalProgress(current)
  let from = goalStatusLine(previous).text
  const revised = revisionLabel(current)
  const stopped = stoppedStillLabel(previous, before, after, current)
  if (after.phase === 'failed' || after.phase === 'interrupted') from = goalStatusLine(current).text
  else if (after.phase === 'complete') from = current.assembly ? 'Sequence assembled' : 'Clip ready'
  else if (before.phase === 'planning' && after.phase === 'review') from = 'Plan ready'
  else if (stopped) from = stopped
  else if (after.phase === 'review' && revised) from = `${revised[0]!.toUpperCase()}${revised.slice(1)} revised`
  else if (after.phase === 'review' && after.stage === 'storyboards') from = 'Full frame ready'
  else if (after.phase === 'review' && after.stage === 'videos') from = 'Storyboards ready'
  else if (before.phase === 'review') {
    from = revised ? `Revising ${revised}` : before.stage !== 'frame' && after.stage === 'frame' ? 'Frame regeneration started'
      : before.stage === 'videos' && after.stage === 'storyboards' ? 'Storyboard regeneration started'
        : after.stage === 'frame' ? 'Plan approved' : after.stage === 'storyboards' ? 'Frame approved' : 'Storyboards approved'
  }
  else if (before.phase === 'failed' || before.phase === 'interrupted') from = `Retrying ${goalStageLabel(after.stage).toLowerCase()}`
  else if (after.done > before.done) from = `${after.stage === 'storyboards' ? 'Storyboard' : 'Shot'} ${after.done} ready`
  return { id, from, tone: after.phase === 'failed' || after.phase === 'interrupted' ? 'attention' : 'live' }
}

export function composerGoal(goals: readonly GoalSnapshot[]): GoalSnapshot | null {
  return goals.find(goal => goal.status !== 'cancelled' && !goal.dismissedAt && goal.cellId) ?? null
}

export function goalGenerationMarks(goals: readonly GoalSnapshot[]): ReadonlyMap<string, string> {
  const marks = new Map<string, string>()
  for (const goal of goals) {
    if (goal.combined) marks.set(goal.combined.cellId, `Combined${goal.address ? ` · ${goal.address}` : ''}`)
    const total = goal.plan?.shots.length ?? 0
    const steps = goal.planVersion === 1 ? goal.steps : Object.values(goal.stages).flatMap(run => run.allSteps)
    for (const step of steps) {
      const match = /^(frame|storyboard|shot)(\d+)?$/.exec(step.id)
      if (!match) continue
      const number = Number(match[2])
      let label = match[1] === 'frame' ? 'Frame' : match[1] === 'storyboard' && number > total
        ? `End ${number - total}/${total}` : `${match[1] === 'storyboard' ? 'SB ' : ''}${match[2]}/${total}`
      const stage = match[1] === 'frame' ? 'frame' : match[1] === 'storyboard' ? 'storyboards' : null
      const attempts = stage ? goal.stages[stage]?.attempts?.filter(attempt => attempt.index === (stage === 'frame' ? 0 : number - 1)) ?? [] : []
      const version = attempts.findIndex(attempt => attempt.chainId === step.chainId && attempt.stepId === step.id)
      if (attempts.length > 1 && version >= 0) label = `${stage === 'frame' ? 'Frame' : number > total ? `End ${number - total}` : `SB ${number}`} v${version + 1}`
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
export type GoalTileThumbnail = {
  artifactId: string
  cellId: string | null
  label: string
}
export type GoalTileView = {
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
  frame: { label: 'Frame', tone: 'live' }, storyboards: { label: 'Storyboards', tone: 'live' }, videos: { label: 'Videos', tone: 'live' },
  assembling: { label: 'Combining', tone: 'live' }, complete: { label: 'Complete', tone: 'done' },
  failed: { label: 'Failed', tone: 'attention' }, interrupted: { label: 'Interrupted', tone: 'attention' }, stopped: { label: 'Stopped', tone: 'quiet' },
}

export function goalPlanFromInputs(inputs: Record<string, unknown> | undefined): GoalDisplayPlan | null {
  const plan = inputs?.plan
  if (!plan || typeof plan !== 'object') return null
  const record = plan as Record<string, unknown>
  return typeof record.title === 'string' && Array.isArray(record.shots) && record.shots.every(shot => shot && typeof shot === 'object'
    && typeof shot.title === 'string' && typeof shot.durationSeconds === 'number') ? plan as GoalDisplayPlan : null
}

function tileNote(goal: GoalSnapshot | null, progress: GoalProgress | null): string | null {
  if (!goal || !progress) return null
  if (progress.phase === 'failed' || progress.phase === 'interrupted') return `${goalStatusLine(goal).text}${goal.planVersion === 1 ? ' · start a new goal' : ' · open to retry'}`
  if (progress.phase === 'planning') return goal.brief || null
  if (progress.phase === 'review') return `${goalStatusLine(goal).text}${progress.stage === 'frame' ? '' : estimateText(goal, progress.stage)}`
  if (progress.phase === 'complete') return `${goal.assembly ? 'Added to the timeline' : 'Clip ready'} · ${formatGoalClock(goalPlanSeconds(goal.plan))}`
  return null
}

function overallProgress(goal: GoalSnapshot, progress: GoalProgress): number {
  if (goal.status === 'completed') return 100
  if (goal.planVersion === 1) return progress.total > 0 ? Math.round(progress.done / progress.total * 100) : 0
  const total = 1 + (isStagedGoalPlan(goal.plan) && goal.plan.frameContinuity ? 3 : 2) * (goal.plan?.shots.length ?? 0)
  const done = Object.values(goal.stages).reduce((sum, run) => sum + run.outputs.length, 0)
  return Math.round(done / total * 100)
}

export function goalTileView(goal: GoalSnapshot | null, fallbackPlan: GoalDisplayPlan | null, label: string | undefined): GoalTileView {
  const plan = goal?.plan ?? fallbackPlan
  const progress = goal ? goalProgress(goal) : null
  const phase = progress?.phase ?? null
  const shots = progress && progress.shots.length > 0 ? progress.shots : plannedShots(plan)
  const visible = shots.length > TILE_ROW_LIMIT ? shots.slice(0, TILE_ROW_LIMIT - 1) : shots
  const firstDuration = plan?.shots[0]?.durationSeconds ?? null
  const duration = plan?.shots.every(shot => shot.durationSeconds === firstDuration) ? firstDuration : null
  const thumbnails = goal ? [
    ...(goal.stages.frame?.outputs ?? []).map(output => ({ ...output, label: 'Full frame' })),
    ...(goal.stages.storyboards?.outputs ?? []).map(output => ({ ...output, label: output.index >= (plan?.shots.length ?? 0) ? `Ending ${output.index + 1 - (plan?.shots.length ?? 0)}` : `Storyboard ${output.index + 1}` })),
  ] : []
  return {
    title: plan?.title ?? (phase === 'planning' ? 'Building your shot plan' : label ?? 'Video goal'), planning: phase === 'planning',
    rows: visible.map(shot => ({
      key: `${shot.index}`, number: shot.number, title: shot.title, state: shot.state,
      detail: shot.state === 'generating' ? '' : shot.state === 'submitting' ? 'Queued'
        : shot.seconds > 0 && (shot.state === 'done' || shot.state === 'planned') ? shot.state === 'done' ? formatGoalClock(shot.seconds) : `${shot.seconds}s` : goalShotStateLabel(shot.state),
      startedAt: shot.state === 'generating' ? shot.startedAt : null,
    })),
    hiddenRows: shots.length - visible.length, note: tileNote(goal, progress), noteTone: phase ? tileChips[phase].tone : 'quiet',
    chip: phase ? tileChips[phase] : { label: 'Goal', tone: 'quiet' },
    progressPercent: goal && progress ? overallProgress(goal, progress) : 0,
    shotsLabel: plan ? duration === null ? `${plan.shots.length} clips` : `${plan.shots.length} × ${duration}s` : null,
    aspectRatio: plan?.aspectRatio ?? null, thumbnails,
  }
}
