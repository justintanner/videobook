import type { GoalSnapshot } from '../../server/src/tools/goal'
import type { GoalPlan } from '../../server/src/goal-plan'

export type { GoalSnapshot }

export type GoalShotState =
  | 'planned'
  | 'waiting'
  | 'submitting'
  | 'generating'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'stopped'

export type GoalPhase =
  | 'planning'
  | 'review'
  | 'shot'
  | 'assembling'
  | 'complete'
  | 'failed'
  | 'interrupted'
  | 'stopped'

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

export function goalPlansEqual(left: GoalPlan, right: GoalPlan): boolean {
  return left.title === right.title && left.continuity === right.continuity
    && left.aspectRatio === right.aspectRatio && left.shots.length === right.shots.length
    && left.shots.every((shot, index) => shot.title === right.shots[index]?.title
      && shot.prompt === right.shots[index]?.prompt && shot.durationSeconds === right.shots[index]?.durationSeconds)
}

export function asGoal(value: unknown): GoalSnapshot {
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'video-goal') {
    throw new Error('The server returned an invalid video goal')
  }
  return value as GoalSnapshot
}

export function asGoals(value: unknown): GoalSnapshot[] {
  if (!value || typeof value !== 'object' || !('goals' in value) || !Array.isArray(value.goals)) {
    throw new Error('The server returned an invalid goal list')
  }
  return value.goals.map(asGoal)
}

export function goalShotStateLabel(state: GoalShotState): string {
  const labels: Record<GoalShotState, string> = {
    planned: 'Planned', waiting: 'Waiting', submitting: 'Submitting', generating: 'Generating',
    done: 'Ready', failed: 'Failed', skipped: 'Not started', stopped: 'Stopped',
  }
  return labels[state]
}

export function formatGoalClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

export function goalPlanSeconds(plan: GoalPlan | null): number {
  return plan?.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0) ?? 0
}

function shotState(goal: GoalSnapshot, step: GoalStep | undefined): GoalShotState {
  if (!step) return goal.status === 'planning' || goal.status === 'review' ? 'planned' : 'waiting'
  if (step.status === 'completed') return 'done'
  if (step.status === 'running') return step.address ? 'generating' : 'submitting'
  if (step.status === 'failed' || step.status === 'interrupted') return 'failed'
  if (step.status === 'cancelled' || step.status === 'rejected') return 'stopped'
  if (step.status === 'skipped') return goal.status === 'cancelled' ? 'stopped' : 'skipped'
  return 'waiting'
}

function goalShots(goal: GoalSnapshot): GoalShotView[] {
  const steps = new Map(goal.steps.map((step) => [step.id, step]))
  return (goal.plan?.shots ?? []).map((shot, index) => {
    const step = steps.get(`shot${index + 1}`)
    return {
      index,
      number: String(index + 1).padStart(2, '0'),
      title: shot.title,
      prompt: shot.prompt,
      seconds: shot.durationSeconds,
      state: shotState(goal, step),
      startedAt: step?.startedAt ?? null,
      cellId: step?.cellId ?? null,
      address: step?.address ?? null,
      artifactId: step?.status === 'completed' ? step.artifactId : null,
      error: step?.error ?? null,
    }
  })
}

function goalPhase(goal: GoalSnapshot, shots: GoalShotView[]): GoalPhase {
  if (goal.status === 'planning') return 'planning'
  if (goal.status === 'review') return 'review'
  if (goal.status === 'cancelled') return 'stopped'
  if (goal.status === 'completed') return 'complete'
  if (goal.status === 'failed') return 'failed'
  if (goal.status === 'interrupted') return 'interrupted'
  return shots.every((shot) => shot.state === 'done') ? 'assembling' : 'shot'
}

export function goalProgress(goal: GoalSnapshot): GoalProgress {
  const shots = goalShots(goal)
  const phase = goalPhase(goal, shots)
  const active = shots.find((shot) => shot.state === 'failed')
    ?? shots.find((shot) => shot.state === 'submitting' || shot.state === 'generating')
    ?? (phase === 'shot' ? shots.find((shot) => shot.state !== 'done') ?? null : null)
  const failedStep = goal.steps.find((step) => step.status === 'failed' || step.status === 'interrupted')?.id ?? null
  return {
    phase,
    shots,
    done: shots.filter((shot) => shot.state === 'done').length,
    total: shots.length,
    active,
    failedStep,
  }
}

function estimateText(goal: GoalSnapshot): string {
  return goal.estimate.usd === null ? '' : ` · est. $${goal.estimate.usd.toFixed(2)}`
}

function shotLine(progress: GoalProgress, elapsedSeconds: number | null): GoalStatusLine {
  const active = progress.active
  const number = active ? active.index + 1 : progress.done + 1
  const generating = active?.state === 'generating'
  const activity = generating
    ? `Generating${elapsedSeconds === null ? '' : ` ${formatGoalClock(elapsedSeconds)}`}`
    : 'Submitting'
  return {
    text: `Shot ${number} of ${progress.total} · ${activity}`,
    short: `${number}/${progress.total}`,
    announce: `Goal: shot ${number} of ${progress.total} ${generating ? 'generating' : 'submitting'}`,
    action: null,
    tone: 'live',
    busy: false,
  }
}

function failureText(progress: GoalProgress, word: string): string {
  if (progress.failedStep === null) return `Planning ${word}`
  if (progress.failedStep === 'assemble') return `Assembly ${word}`
  return `Shot ${(progress.active?.index ?? 0) + 1} ${word}`
}

export function goalStatusLine(goal: GoalSnapshot, elapsedSeconds: number | null = null): GoalStatusLine {
  const progress = goalProgress(goal)
  if (progress.phase === 'planning') {
    return { text: 'Planning shots', short: 'Planning', announce: 'Goal: planning shots', action: null, tone: 'live', busy: true }
  }
  if (progress.phase === 'review') {
    return {
      text: `Ready for review${estimateText(goal)}`, short: 'Review', announce: 'Goal: shot plan ready for review',
      action: 'Review', tone: 'review', busy: false,
    }
  }
  if (progress.phase === 'shot') return shotLine(progress, elapsedSeconds)
  if (progress.phase === 'assembling') {
    return {
      text: `Assembling ${progress.total} clips`, short: 'Assembling', announce: `Goal: assembling ${progress.total} clips`,
      action: null, tone: 'live', busy: true,
    }
  }
  if (progress.phase === 'complete') {
    return {
      text: `Complete · ${formatGoalClock(goalPlanSeconds(goal.plan))}`, short: 'Done', announce: 'Goal complete',
      action: 'Preview', tone: 'done', busy: false,
    }
  }
  if (progress.phase === 'failed' || progress.phase === 'interrupted') {
    const word = progress.phase === 'failed' ? 'failed' : 'interrupted'
    const text = failureText(progress, word)
    return { text, short: progress.phase === 'failed' ? 'Failed' : 'Interrupted', announce: `Goal: ${text.toLowerCase()}`, action: 'Retry', tone: 'attention', busy: false }
  }
  return { text: 'Stopped', short: 'Stopped', announce: 'Goal stopped', action: null, tone: 'quiet', busy: false }
}

export function goalWakeKey(goal: GoalSnapshot): string {
  const progress = goalProgress(goal)
  return `${goal.goalId}:${progress.phase}:${progress.done}:${progress.active?.index ?? -1}`
}

function wakeLabel(previous: GoalProgress, current: GoalProgress, previousGoal: GoalSnapshot): string {
  if (previous.phase === 'planning' && current.phase === 'review') return 'Shot plan ready'
  if (previous.phase === 'review') return 'Plan approved'
  if (current.phase === 'complete') return 'Sequence assembled'
  if (current.done > previous.done) return `Shot ${current.done} ready`
  return goalStatusLine(previousGoal).text
}

export function goalWake(previous: GoalSnapshot, current: GoalSnapshot): GoalWake | null {
  const id = goalWakeKey(current)
  if (previous.goalId !== current.goalId || goalWakeKey(previous) === id) return null
  const after = goalProgress(current)
  if (after.phase === 'stopped') return null
  return {
    id,
    from: wakeLabel(goalProgress(previous), after, previous),
    tone: after.phase === 'failed' || after.phase === 'interrupted' ? 'attention' : 'live',
  }
}

export function composerGoal(goals: readonly GoalSnapshot[]): GoalSnapshot | null {
  return goals.find((goal) => goal.status !== 'cancelled' && !goal.dismissedAt && goal.cellId) ?? null
}

export function goalGenerationMarks(goals: readonly GoalSnapshot[]): ReadonlyMap<string, string> {
  const marks = new Map<string, string>()
  for (const goal of goals) {
    const total = goal.plan?.shots.length ?? 0
    for (const step of goal.steps) {
      const match = /^shot(\d+)$/.exec(step.id)
      if (!match || !step.cellId) continue
      marks.set(step.cellId, `${match[1]}/${total}${goal.address ? ` · ${goal.address}` : ''}`)
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

export type GoalTileView = {
  title: string
  planning: boolean
  rows: GoalTileRow[]
  hiddenRows: number
  note: string | null
  noteTone: GoalStatusTone
  chip: { label: string; tone: GoalStatusTone }
  progressPercent: number
  shotsLabel: string | null
  aspectRatio: string | null
}

const TILE_ROW_LIMIT = 5

const tileChips: Record<GoalPhase, { label: string; tone: GoalStatusTone }> = {
  planning: { label: 'Planning', tone: 'live' },
  review: { label: 'Review', tone: 'review' },
  shot: { label: 'Generating', tone: 'live' },
  assembling: { label: 'Assembling', tone: 'live' },
  complete: { label: 'Complete', tone: 'done' },
  failed: { label: 'Failed', tone: 'attention' },
  interrupted: { label: 'Interrupted', tone: 'attention' },
  stopped: { label: 'Stopped', tone: 'quiet' },
}

function isShotList(value: unknown): value is GoalPlan['shots'] {
  return Array.isArray(value) && value.every((shot) => shot && typeof shot === 'object'
    && typeof (shot as Record<string, unknown>).title === 'string'
    && typeof (shot as Record<string, unknown>).durationSeconds === 'number')
}

export function goalPlanFromInputs(inputs: Record<string, unknown> | undefined): GoalPlan | null {
  const plan = inputs?.plan
  if (!plan || typeof plan !== 'object') return null
  const record = plan as Record<string, unknown>
  return typeof record.title === 'string' && isShotList(record.shots) ? plan as GoalPlan : null
}

function tileRowDetail(shot: GoalShotView): string {
  if (shot.state === 'planned' || shot.state === 'done') return shot.state === 'done' ? formatGoalClock(shot.seconds) : `${shot.seconds}s`
  if (shot.state === 'submitting') return 'Queued'
  if (shot.state === 'generating') return ''
  return goalShotStateLabel(shot.state)
}

function plannedShots(plan: GoalPlan | null): GoalShotView[] {
  return (plan?.shots ?? []).map((shot, index) => ({
    index, number: String(index + 1).padStart(2, '0'), title: shot.title, prompt: shot.prompt,
    seconds: shot.durationSeconds, state: 'planned', startedAt: null, cellId: null, address: null,
    artifactId: null, error: null,
  }))
}

function tileNote(goal: GoalSnapshot | null, phase: GoalPhase | null, plan: GoalPlan | null): string | null {
  if (!goal || !phase) return null
  if (phase === 'failed' || phase === 'interrupted') return `${goalStatusLine(goal).text} · open to retry`
  if (phase === 'planning') return goal.brief || null
  if (phase === 'review') return goal.estimate.usd === null ? 'Open to review the shots' : `est. $${goal.estimate.usd.toFixed(2)} · run approves the whole plan`
  if (phase === 'complete') return `Added to the timeline · ${formatGoalClock(goalPlanSeconds(plan))}`
  return null
}

function sharedDuration(plan: GoalPlan): number | null {
  const first = plan.shots[0]?.durationSeconds ?? null
  return plan.shots.every((shot) => shot.durationSeconds === first) ? first : null
}

export function goalTileView(goal: GoalSnapshot | null, fallbackPlan: GoalPlan | null, label: string | undefined): GoalTileView {
  const plan = goal?.plan ?? fallbackPlan
  const progress = goal ? goalProgress(goal) : null
  const phase = progress?.phase ?? null
  const shots = progress && progress.shots.length > 0 ? progress.shots : plannedShots(plan)
  const visible = shots.length > TILE_ROW_LIMIT ? shots.slice(0, TILE_ROW_LIMIT - 1) : shots
  const duration = plan ? sharedDuration(plan) : null
  const finished = phase === 'assembling' || phase === 'complete'
  const total = progress?.total ?? 0
  const done = progress?.done ?? 0
  return {
    title: plan?.title ?? (phase === 'planning' ? 'Building your shot plan' : label ?? 'Video goal'),
    planning: phase === 'planning',
    rows: visible.map((shot) => ({
      key: `${shot.index}`,
      number: shot.number,
      title: shot.title,
      state: shot.state,
      detail: tileRowDetail(shot),
      startedAt: shot.state === 'generating' ? shot.startedAt : null,
    })),
    hiddenRows: shots.length - visible.length,
    note: tileNote(goal, phase, plan),
    noteTone: phase ? tileChips[phase].tone : 'quiet',
    chip: phase ? tileChips[phase] : { label: 'Goal', tone: 'quiet' },
    progressPercent: finished ? 100 : total > 0 ? Math.round((done / total) * 100) : 0,
    shotsLabel: plan ? duration === null ? `${plan.shots.length} clips` : `${plan.shots.length} × ${duration}s` : null,
    aspectRatio: plan?.aspectRatio ?? null,
  }
}
