import { buildGoalShortPlan, buildLegacyGoalShortPlan, type GoalShortPlan } from '../../server/src/goal-short-plan'
import type { LegacyGoalSnapshot, ShortGoalSnapshot } from '../../src/videobook/goals'

type Stage = NonNullable<ShortGoalSnapshot['stages']['frame']>
type Step = ShortGoalSnapshot['steps'][number]
type Output = Stage['outputs'][number]

export const LOWER_BOUND = 'MiniMax H3 Max is priced per requested second, so this estimate is a lower bound.'

function shortReference(index: number, label: string) {
  return {
    kind: 'image' as const, artifactId: `019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e0${index}`, cellId: `019a1f3e-5b10-7c2a-9d41-3f6b2a8c1e1${index}`,
    address: `@a${index}`, label, objectHash: String(index).repeat(64),
  }
}

export function shortPlanFixture(seconds: readonly number[] = [10, 10], references = [shortReference(1, 'Character sheet')]): GoalShortPlan {
  return buildGoalShortPlan({
    title: 'Waiting for the bus', aspectRatio: '9:16', sourceImages: references,
    framePrompt: 'A bus stop at dusk.', beats: seconds.map((_, index) => `Beat ${index + 1}.`), segmentSeconds: seconds,
  })
}

export function legacyShortPlanFixture(seconds: readonly number[] = [10, 10], references = [shortReference(1, 'Character sheet')]): GoalShortPlan {
  return buildLegacyGoalShortPlan({
    title: 'Waiting for the bus', aspectRatio: '9:16',
    character: { name: 'Main character', description: 'a man in a green shirt', references },
    framePrompt: 'A bus stop at dusk.', beats: seconds.map((_, index) => `Beat ${index + 1}.`), segmentSeconds: seconds, extraReferences: [],
  })
}

export function shortStep(id: string, status: Step['status'], index = 0): Step {
  const active = ['completed', 'running', 'failed'].includes(status)
  return {
    id, chainId: `${id}-chain`, status, error: status === 'failed' ? 'Rejected' : null, artifactId: status === 'completed' ? `${id}-asset` : null,
    cellId: active ? `${id}-producer` : null, address: active ? `@c${index + 1}` : null, outputCellId: active ? `${id}-output` : null,
    startedAt: status === 'running' ? '2026-11-12T00:01:00Z' : null,
  }
}

export function shortStage(stage: 'frame' | 'videos', outputs: readonly { index: number, artifactId: string, stale?: string | null, versions?: number, realism?: Output['realism'] }[], steps: Step[] = []): Stage {
  return {
    chainId: `${stage}-chain`, revision: 1, approvedAt: '2026-11-12T00:00:00Z', previousChainIds: [], shotIndexes: outputs.map(output => output.index),
    steps, allSteps: steps,
    outputs: outputs.map((output): Output => ({
      index: output.index, artifactId: output.artifactId, cellId: `${output.artifactId}-cell`, producerCellId: null, address: `@c${output.index + 1}`,
      stale: output.stale ?? null,
      realism: output.realism ?? null,
      versions: Array.from({ length: output.versions ?? 1 }, (_, version) => ({
        stage, index: output.index, chainId: `${stage}-chain-${version}`, stepId: stage === 'frame' ? 'frame' : `clip${output.index + 1}`,
        artifactId: version === 0 ? output.artifactId : `${output.artifactId}-v${version}`, cellId: `${output.artifactId}-cell`, basePrompt: 'Beat.',
        feedback: null, parentArtifactId: null, frameArtifactId: null, createdAt: '2026-11-12T00:00:00Z',
        address: `@c${output.index + 1}`, status: 'completed' as const, current: version === 0,
      })),
    })),
  }
}

export function shortGoalFixture(extra: Partial<ShortGoalSnapshot> = {}, short: GoalShortPlan = shortPlanFixture()): ShortGoalSnapshot {
  return {
    kind: 'video-goal', legacy: false, planVersion: short.version, stage: 'frame', stages: {}, goalId: 'short-1', bookId: 'book', notebookId: 'notebook',
    cellId: 'short-tile', address: '@b1', requestId: 'request', brief: 'he waits for a bus', revision: 2, shortPlan: short,
    estimate: {
      frame: { usd: 0.21, warnings: [] }, storyboards: { usd: 0, warnings: [] }, videos: { usd: 1.2, warnings: [LOWER_BOUND] },
      total: { usd: 1.41, warnings: [LOWER_BOUND] },
      segments: short.segments.map(() => ({ usd: 0.6, warnings: [LOWER_BOUND] })),
    },
    status: 'review', error: null, chainId: null, planningJobId: null, clipIds: [], trackId: null, assembly: null, dismissedAt: null,
    createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-12T00:00:00Z', steps: [], finish: null, finalArtifactId: null, coldOpen: null,
    ...extra,
    notes: extra.notes ?? [],
  }
}

export function legacyGoalFixture(extra: Partial<LegacyGoalSnapshot> = {}): LegacyGoalSnapshot {
  return {
    kind: 'video-goal', legacy: true, goalId: 'legacy-1', bookId: 'book', notebookId: 'notebook', cellId: 'legacy-tile', planVersion: 2,
    address: '@b2', title: 'The skateboard champion', brief: '@a1@a2 make a funny video of a dog on a skateboard', status: 'completed', error: null,
    outputs: [
      { stage: 'frame', artifactId: 'frame-old', cellId: 'frame-cell', address: '@c1' },
      { stage: 'storyboards', artifactId: 'board-old', cellId: 'board-cell', address: '@c2' },
      { stage: 'videos', artifactId: 'video-old', cellId: 'video-cell', address: '@d1' },
      { stage: 'videos', artifactId: 'video-gone', cellId: 'video-gone-cell', address: null },
    ],
    finalArtifactId: null, dismissedAt: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    ...extra,
  }
}
