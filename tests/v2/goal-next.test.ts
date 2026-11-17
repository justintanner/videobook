import { describe, expect, it } from 'vitest'
import { goalRemixAnalysisSchema, remixAssemblyReviewKey, remixRules, type GoalRemixAnalysis } from '../../server/src/goal-remix-model'
import { goalShortPlanSchema } from '../../server/src/goal-short-plan'
import { goalNextAction, goalSteps } from '../../src/videobook/goal-next'
import { goalStatusLine, type ShortGoalSnapshot } from '../../src/videobook/goals'
import { remixPlanFixture, shortGoalFixture, shortPlanFixture, shortStage, shortStep } from './goal-short-fixtures'

function assemblyAnalysis(extra: { cleanup?: 'keep' | 'remove', source?: boolean } = {}): GoalRemixAnalysis {
  return goalRemixAnalysisSchema.parse({
    version: 1, brief: 'Keep the montage and insert the person for the last two seconds.', preferences: {},
    source: extra.source ? { artifactId: 'video-source', mediaHash: 'source-hash', durationSeconds: 14, fps: 24, width: 1080, height: 1920, hasAudio: true, cuts: [4, 9], sampleTimes: [1, 6, 12], observations: null, semanticStatus: 'missing', transcript: null, evidenceKey: 'evidence' } : null,
    intent: { structure: 'preserve-source', character: 'insert', audio: 'source', cleanup: extra.cleanup ?? 'keep', action: { start: 12, end: 14 }, actionDescription: 'Wave at the camera', noDialogue: true, origins: { action: 'brief' } },
    recipe: {
      targetSeconds: 14, sourceFrameSeconds: 12, keep: [{ start: 0, end: 12 }], change: [{ start: 12, end: 14 }], generatedSeconds: 2,
      assembly: { version: 1, fps: 24, width: 1080, height: 1920, totalFrames: 336, changeStartFrame: 288, changeEndFrame: 336, fit: 'contain' },
      reference: { start: 0, end: 14 }, preparedArtifactId: null, preparedMediaHash: null, cleanupRegions: [], cleanupConfirmed: extra.cleanup !== 'remove',
      cleanupMethod: 'fill', templateId: null, templateRevision: null, checkTimes: [11.9, 12.1, 13.9],
    },
    history: [], findings: [], analyzedAt: '2026-11-16T00:00:00Z',
  })
}

function assemblyGoal(analysis: GoalRemixAnalysis, extra: Partial<ShortGoalSnapshot> = {}): ShortGoalSnapshot {
  const plan = goalShortPlanSchema.parse({ ...remixPlanFixture(), rules: remixRules(analysis.intent), analysis })
  return shortGoalFixture({
    stage: 'videos',
    stages: {
      replacement: shortStage('replacement', [{ index: 0, artifactId: 'photo-insertion', versions: 2 }]),
      frame: shortStage('frame', [{ index: 0, artifactId: 'photo-setup' }]),
      videos: shortStage('videos', [{ index: 0, artifactId: 'clip-action' }]),
    },
    finish: { status: 'review', sourceArtifactId: 'clip-action', finalArtifactId: null, error: null },
    ...extra,
  }, plan)
}

describe('goal next action', () => {
  it('asks for the retained action window on Video before Finish, then offers Finish', () => {
    const analysis = assemblyAnalysis()
    const goal = assemblyGoal(analysis)
    const next = goalNextAction({ goal, plan: goal.shortPlan! })
    expect(next).toMatchObject({ kind: 'window', step: 'video', short: 'Pick 2 s to keep' })
    expect(next.text).toBe('Choose which part of the take goes into the short, then use that window.')
    expect(next.detail).toBe('It fills 12–14 s of the short, after the source shots.')
    expect(goalStatusLine(goal).text).toBe('Pick the 2 s to keep')
    expect(goalSteps(goal, goal.shortPlan!, next).map(step => [step.name, step.tone, step.status])).toEqual([
      ['Recipe', 'done', 'Saved'],
      ['Character', 'done', 'Take v2 of 2'],
      ['Action setup', 'done', 'Ready'],
      ['Video', 'next', 'Pick 2 s to keep'],
      ['Finish', 'waiting', 'After Video'],
    ])
    const reviewed = assemblyGoal(analysis, { actionWindow: { artifactId: 'clip-action', mediaHash: 'clip-action-hash', recipeKey: remixAssemblyReviewKey(analysis), startFrame: 12, endFrame: 60, durationSeconds: 2, reviewedAt: '2026-11-16T00:00:00Z' } })
    const finish = goalNextAction({ goal: reviewed, plan: reviewed.shortPlan! })
    expect(finish).toMatchObject({ kind: 'finish', step: 'finish', blocked: null, detail: 'Free · runs on this computer.' })
    expect(goalStatusLine(reviewed).text).toBe('Ready to finish · 0:12')
    expect(goalSteps(reviewed, reviewed.shortPlan!, finish).find(step => step.key === 'video')).toMatchObject({ tone: 'done', status: 'Keeps 0.5–2.5 s' })
    expect(goalNextAction({ goal: reviewed, plan: reviewed.shortPlan!, dirty: true })).toMatchObject({ kind: 'finish', blocked: 'Save your changes first.', short: 'Save first' })
  })

  it('sends the user to the Recipe until the source graphics are prepared and reviewed', () => {
    const analysis = assemblyAnalysis({ cleanup: 'remove', source: true })
    const goal = assemblyGoal(analysis, { stage: 'replacement', stages: {}, finish: null })
    const next = goalNextAction({ goal, plan: goal.shortPlan! })
    expect(next).toMatchObject({ kind: 'recipe', step: 'plan', failed: false, short: 'Prepare the source' })
    expect(next.text).toBe('Prepare the source: mark the on-screen graphics to remove.')
    expect(goalStatusLine(goal).text).toBe('Prepare the source')
    const failed = goalNextAction({ goal: { ...goal, preparation: { status: 'failed', requestId: 'r', identity: 'i', jobId: null, artifactId: null, mediaHash: null, error: 'LaMa ran out of memory.' } }, plan: goal.shortPlan! })
    expect(failed).toMatchObject({ kind: 'recipe', failed: true, text: 'LaMa ran out of memory.' })
    expect(goalSteps(goal, goal.shortPlan!, failed)[0]).toMatchObject({ name: 'Recipe', tone: 'failed' })
  })

  it('names the failed step, keeps its error and offers Retry', () => {
    const failedStep = shortStep('clip2', 'failed', 1)
    const goal = shortGoalFixture({
      status: 'failed', stage: 'videos', error: 'Fal failed: Fal API error: 404: Request not found', chainId: failedStep.chainId, steps: [failedStep],
      stages: { frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a' }]), videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a' }], [failedStep]) },
    })
    const next = goalNextAction({ goal, plan: goal.shortPlan! })
    expect(next).toMatchObject({ kind: 'retry', step: 'video', text: 'Fal failed: Fal API error: 404: Request not found' })
    expect(goalSteps(goal, goal.shortPlan!, next).map(step => [step.name, step.tone])).toEqual([['Frame', 'done'], ['Video', 'failed'], ['Finish', 'waiting']])
  })

  it('reports a running step with its stop control and a blocked approval with its reason', () => {
    const step = shortStep('frame', 'running')
    const running = shortGoalFixture({ status: 'running', stage: 'frame', steps: [step], stages: { frame: shortStage('frame', [], [step]) } })
    expect(goalNextAction({ goal: running, plan: running.shortPlan! })).toMatchObject({ kind: 'busy', step: 'frame', stop: 'Stop goal', text: 'Generating the frame.' })
    const review = shortGoalFixture({}, shortPlanFixture([10]))
    expect(goalNextAction({ goal: review, plan: review.shortPlan! })).toMatchObject({ kind: 'generate', stage: 'frame', action: 'approve', label: 'Generate frame', price: '$0.21', blocked: null })
    expect(goalNextAction({ goal: review, plan: review.shortPlan!, promptIssue: 'Fill in the title and every prompt first.' })).toMatchObject({ blocked: 'Fill in the title and every prompt first.' })
    const discarded = goalNextAction({ goal: { ...review, status: 'cancelled' }, plan: review.shortPlan! })
    expect(discarded).toMatchObject({ kind: 'stopped' })
    expect(goalSteps(review, review.shortPlan!, discarded).every(step => step.tone !== 'next')).toBe(true)
  })
})
