import { describe, expect, it } from 'vitest'
import {
  composerGoal,
  goalGenerationMarks,
  goalPlansEqual,
  goalProgress,
  goalStatusLine,
  goalTileView,
  goalWake,
  type GoalSnapshot,
} from '../../src/videobook/goals'
import type { GoalPlan } from '../../server/src/goal-plan'

type StepStatus = GoalSnapshot['steps'][number]['status']

const plan: GoalPlan = {
  title: 'Rainy commute', continuity: 'Faraang in a khaki T-shirt on a flooded street', aspectRatio: '16:9',
  shots: [
    { title: 'Umbrella on the bike', prompt: 'He pedals under a red umbrella.', durationSeconds: 10 },
    { title: 'Wading the lane', prompt: 'He pushes the bike through knee-high water.', durationSeconds: 10 },
    { title: 'Arriving at the shop', prompt: 'He steps into a bright doorway.', durationSeconds: 10 },
  ],
}

function step(id: string, status: StepStatus, extra: Partial<GoalSnapshot['steps'][number]> = {}): GoalSnapshot['steps'][number] {
  return { id, status, error: null, artifactId: null, cellId: null, address: null, outputCellId: null, startedAt: null, ...extra }
}

function goal(extra: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    kind: 'video-goal', goalId: 'goal-1', bookId: 'book', notebookId: 'notebook', cellId: 'tile-1', address: '@a3',
    requestId: 'request', brief: 'Faraang bikes to work through the flooded soi, three 10s clips', revision: 1, plan,
    estimate: { usd: 2.4, warnings: [] }, status: 'review', error: null, chainId: null, planningJobId: null,
    clipIds: [], trackId: null, assembly: null, dismissedAt: null,
    createdAt: '2026-10-07T10:00:00.000Z', updatedAt: '2026-10-07T10:00:00.000Z', steps: [], ...extra,
  }
}

function running(statuses: StepStatus[], extra: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return goal({
    status: 'running', chainId: 'chain',
    steps: [...statuses.map((status, index) => step(`shot${index + 1}`, status, status === 'running'
      ? { cellId: `producer-${index + 1}`, address: `@c${index + 1}`, startedAt: '2026-10-07T10:01:00.000Z' }
      : status === 'completed' ? { cellId: `producer-${index + 1}`, address: `@c${index + 1}`, artifactId: `video-${index + 1}` } : {})),
    step('assemble', 'pending')],
    ...extra,
  })
}

describe('goal review persistence', () => {
  it('keeps a saved plan clean when storage reorders fields, but detects changed shots', () => {
    const draft: GoalPlan = {
      title: 'Skateboard dog', continuity: 'Terrier in a red helmet', aspectRatio: '16:9',
      shots: [{ title: 'Opening', prompt: 'The dog rides a skateboard.', durationSeconds: 10 }],
    }
    const stored: GoalPlan = {
      aspectRatio: '16:9', shots: [{ durationSeconds: 10, prompt: 'The dog rides a skateboard.', title: 'Opening' }],
      continuity: 'Terrier in a red helmet', title: 'Skateboard dog',
    }
    expect(goalPlansEqual(draft, stored)).toBe(true)
    expect(goalPlansEqual(draft, { ...stored, shots: [{ ...stored.shots[0]!, durationSeconds: 12 }] })).toBe(false)
    expect(goalPlansEqual(draft, { ...stored, shots: [...stored.shots, stored.shots[0]!] })).toBe(false)
  })
})

describe('goal status in the chat input', () => {
  it('names each part of the goal on one short line', () => {
    expect(goalStatusLine(goal({ status: 'planning', plan: null, revision: 0 }))).toMatchObject({ text: 'Planning shots', short: 'Planning', busy: true })
    expect(goalStatusLine(goal())).toMatchObject({ text: 'Ready for review · est. $2.40', short: 'Review', action: 'Review', tone: 'review' })
    expect(goalStatusLine(running(['completed', 'pending', 'pending']))).toMatchObject({ text: 'Shot 2 of 3 · Submitting', short: '2/3' })
    expect(goalStatusLine(running(['completed', 'running', 'pending']), 134).text).toBe('Shot 2 of 3 · Generating 2:14')
    expect(goalStatusLine(running(['completed', 'completed', 'completed']))).toMatchObject({ text: 'Assembling 3 clips', busy: true })
    expect(goalStatusLine(running(['completed', 'completed', 'completed'], {
      status: 'completed', assembly: { sequenceId: 'sequence', startFrame: 0, durationFrames: 720 },
    }))).toMatchObject({ text: 'Complete · 0:30', action: 'Preview', tone: 'done' })
    expect(goalStatusLine(running(['completed', 'failed', 'skipped'], { status: 'failed' }))).toMatchObject({ text: 'Shot 2 failed', action: 'Retry', tone: 'attention' })
    expect(goalStatusLine(goal({ status: 'failed', plan: null, error: 'No key' }))).toMatchObject({ text: 'Planning failed', action: 'Retry' })
  })

  it('tracks shot states, including shots that never started after a failure', () => {
    const progress = goalProgress(running(['completed', 'failed', 'skipped'], { status: 'failed' }))
    expect(progress.shots.map((shot) => shot.state)).toEqual(['done', 'failed', 'skipped'])
    expect(progress.active?.index).toBe(1)
    expect(progress.failedStep).toBe('shot2')
    expect(goalProgress(running(['running', 'pending', 'pending'])).shots[0]).toMatchObject({ state: 'generating', address: '@c1' })
    expect(goalProgress(goal({ status: 'running', chainId: 'chain', steps: [step('shot1', 'running')] })).shots[0]!.state).toBe('submitting')
  })

  it('wakes up only when the goal moves to its next part', () => {
    expect(goalWake(goal({ status: 'planning', plan: null }), goal())).toMatchObject({ from: 'Shot plan ready', tone: 'live' })
    expect(goalWake(goal(), running(['pending', 'pending', 'pending']))).toMatchObject({ from: 'Plan approved' })
    expect(goalWake(running(['running', 'pending', 'pending']), running(['completed', 'running', 'pending']))).toMatchObject({ from: 'Shot 1 ready', tone: 'live' })
    expect(goalWake(running(['completed', 'completed', 'running']), running(['completed', 'completed', 'completed'], {
      status: 'completed', assembly: { sequenceId: 'sequence', startFrame: 0, durationFrames: 720 },
    }))).toMatchObject({ from: 'Sequence assembled' })
    expect(goalWake(running(['completed', 'running', 'pending']), running(['completed', 'failed', 'skipped'], { status: 'failed' }))).toMatchObject({ tone: 'attention' })
    expect(goalWake(running(['completed', 'running', 'pending']), running(['completed', 'running', 'pending']))).toBeNull()
    expect(goalWake(running(['running', 'pending', 'pending']), running(['running', 'pending', 'pending'], { status: 'cancelled' }))).toBeNull()
    expect(goalWake(goal(), goal({ goalId: 'goal-2' }))).toBeNull()
  })

  it('shows the newest goal that is neither stopped nor dismissed', () => {
    const newest = goal({ goalId: 'newest', status: 'cancelled' })
    const dismissed = goal({ goalId: 'dismissed', status: 'completed', dismissedAt: '2026-10-07T11:00:00.000Z' })
    const current = goal({ goalId: 'current' })
    expect(composerGoal([newest, dismissed, current])?.goalId).toBe('current')
    expect(composerGoal([newest, dismissed])).toBeNull()
  })
})

describe('goal tile', () => {
  it('lists the plan with live shot states and a progress bar', () => {
    const view = goalTileView(running(['completed', 'running', 'pending']), null, undefined)
    expect(view).toMatchObject({ title: 'Rainy commute', shotsLabel: '3 × 10s', aspectRatio: '16:9', chip: { label: 'Generating', tone: 'live' }, progressPercent: 33 })
    expect(view.rows.map((row) => [row.number, row.state, row.detail])).toEqual([['01', 'done', '0:10'], ['02', 'generating', ''], ['03', 'waiting', 'Waiting']])
    expect(view.rows[1]!.startedAt).toBe('2026-10-07T10:01:00.000Z')
    expect(goalTileView(goal(), null, undefined)).toMatchObject({ note: 'est. $2.40 · run approves the whole plan', chip: { label: 'Review' } })
    expect(goalTileView(goal({ status: 'planning', plan: null }), null, undefined)).toMatchObject({ title: 'Building your shot plan', planning: true, note: goal().brief })
  })

  it('renders a saved plan before the goal list loads and folds long plans', () => {
    const long: GoalPlan = { ...plan, shots: Array.from({ length: 8 }, (_, index) => ({ title: `Shot ${index + 1}`, prompt: 'Action', durationSeconds: index === 0 ? 12 : 10 })) }
    const view = goalTileView(null, long, 'Long goal')
    expect(view).toMatchObject({ title: 'Rainy commute', shotsLabel: '8 clips', hiddenRows: 4, chip: { label: 'Goal', tone: 'quiet' } })
    expect(view.rows).toHaveLength(4)
    expect(view.rows[0]).toMatchObject({ state: 'planned', detail: '12s' })
  })

  it('marks the generation tiles that belong to a goal', () => {
    expect([...goalGenerationMarks([running(['completed', 'running', 'pending'])])]).toEqual([
      ['producer-1', '1/3 · @a3'],
      ['producer-2', '2/3 · @a3'],
    ])
  })
})
