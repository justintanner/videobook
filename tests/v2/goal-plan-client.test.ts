import { describe, expect, it } from 'vitest'
import { composerGoal, defaultShortTab, goalCanRetry, goalGenerationMarks, goalOutputEstimate, goalPlanSeconds, goalStatusLine, goalStillVersions, goalTileView, goalWake, LEGACY_GOAL_NOTE, shortEstimateText } from '../../src/videobook/goals'
import { LOWER_BOUND, legacyGoalFixture, legacyShortPlanFixture, shortGoalFixture, shortPlanFixture, shortStage, shortStep } from './goal-short-fixtures'

describe('legacy goal model', () => {
  it('keeps an earlier goal as a read-only tile that never wakes, marks cells or becomes the composer goal', () => {
    const legacy = legacyGoalFixture()
    expect(goalTileView(legacy, undefined)).toMatchObject({ title: 'The skateboard champion', note: LEGACY_GOAL_NOTE, chip: { label: 'Complete', tone: 'done' }, shotsLabel: '4 outputs', rows: [] })
    expect(goalTileView(legacy, undefined).thumbnails.map(thumbnail => thumbnail.label)).toEqual(['Frame', 'Storyboard'])
    expect(goalTileView(legacyGoalFixture({ title: null, status: 'failed', outputs: [] }), undefined)).toMatchObject({ title: 'Earlier goal', chip: { label: 'Earlier' }, shotsLabel: null })
    expect(goalStatusLine(legacy)).toMatchObject({ text: 'Earlier goal · complete', tone: 'quiet', busy: false })
    expect(goalCanRetry(legacyGoalFixture({ status: 'failed' }))).toBe(false)
    expect(goalWake(legacy, { ...legacy, status: 'failed' })).toBeNull()
    expect(goalGenerationMarks([legacy]).size).toBe(0)
    const current = shortGoalFixture()
    expect(composerGoal([legacyGoalFixture({ status: 'failed' }), shortGoalFixture({ status: 'cancelled' }), shortGoalFixture({ status: 'completed', dismissedAt: 'earlier' }), current])).toBe(current)
    expect(composerGoal([legacy, shortGoalFixture({ status: 'cancelled' })])).toBeNull()
  })
})

describe('short goal model', () => {
  const twoClips = shortPlanFixture([10, 10])
  const frameDone = () => shortGoalFixture({ stage: 'videos', stages: { frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a' }]) } })
  const firstClip = () => shortGoalFixture({ stage: 'videos', stages: { frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a' }]), videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a' }]) } })

  it('describes a short in every phase on its tile and status line', () => {
    const review = shortGoalFixture()
    expect(goalPlanSeconds(twoClips)).toBe(20)
    expect(goalStatusLine(review).text).toBe('Review frame · $0.21')
    expect(goalTileView(review, undefined)).toMatchObject({ title: 'Waiting for the bus', shotsLabel: '2 clips · 20s', aspectRatio: '9:16', chip: { label: 'Review' }, rows: [{ title: 'Frame' }] })
    expect(goalStatusLine(firstClip()).text).toBe('Review clip 2 of 2 · at least $0.60')
    expect(goalTileView(firstClip(), undefined).rows.map(row => [row.title, row.state])).toEqual([['Clip 1', 'done'], ['Clip 2', 'planned']])
    expect(goalTileView(frameDone(), undefined).note).toBe('Review clip 1 of 2 · at least $0.60')
    const stale = shortGoalFixture({ stage: 'videos', stages: { frame: shortStage('frame', [{ index: 0, artifactId: 'frame-b' }]), videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a', stale: 'The frame changed.' }]) } })
    expect(goalStatusLine(stale).text).toBe('Review clip 1 of 2 · at least $0.60')
    const clipStep = shortStep('clip2', 'running', 1)
    const running = shortGoalFixture({ status: 'running', stage: 'videos', chainId: clipStep.chainId, steps: [clipStep], stages: { frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a' }]), videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a' }], [clipStep]) } })
    expect(goalStatusLine(running, 12).text).toBe('Clip 2 of 2 · Generating 0:12')
    expect(goalStatusLine(shortGoalFixture({ status: 'running', stage: 'frame', steps: [shortStep('frame', 'running')], stages: { frame: shortStage('frame', [], [shortStep('frame', 'running')]) } })).text).toBe('Frame · Generating')
    const failedStep = shortStep('clip2', 'failed', 1)
    const failed = shortGoalFixture({ status: 'failed', stage: 'videos', chainId: failedStep.chainId, steps: [failedStep], stages: { frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a' }]), videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a' }], [failedStep]) } })
    expect(goalStatusLine(failed).text).toBe('Clip 2 failed')
    expect(goalCanRetry(failed)).toBe(true)
    const finishing = shortGoalFixture({ stage: 'videos', finish: { status: 'running', sourceArtifactId: 'clip-b', finalArtifactId: null, error: null } })
    expect(goalStatusLine(finishing).text).toBe('Burning the saved watermark')
    expect(goalTileView(finishing, undefined).chip.label).toBe('Finishing')
    const bothClips = { frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a' }]), videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a' }, { index: 1, artifactId: 'clip-b' }]) }
    expect(goalStatusLine(shortGoalFixture({ stage: 'videos', stages: bothClips, finish: { status: 'review', sourceArtifactId: 'clip-b', finalArtifactId: null, error: null } })).text).toBe('Review finish · 0:20')
    expect(goalStatusLine(shortGoalFixture({ status: 'completed', stage: 'videos', finish: { status: 'completed', sourceArtifactId: 'clip-b', finalArtifactId: 'final', error: null } })).text).toBe('Short ready · 0:20')
    const appended = shortGoalFixture({ stage: 'videos', stages: bothClips, finalArtifactId: 'final', finish: { status: 'completed', sourceArtifactId: 'clip-b', finalArtifactId: 'final', error: null } }, shortPlanFixture([10, 10, 5]))
    expect(goalStatusLine(appended).text).toBe('Review clip 3 of 3 · at least $0.60')
    expect(goalTileView(appended, undefined).note).toBe('Review clip 3 of 3 · at least $0.60')
    expect(goalTileView(shortGoalFixture({ status: 'planning', shortPlan: undefined }), 'Video goal')).toMatchObject({ planning: true, title: 'Planning your short' })
    expect(goalTileView(shortGoalFixture({ status: 'failed', shortPlan: undefined, error: 'OpenAI API error 500' }), undefined)).toMatchObject({ title: 'Short', note: 'Planning failed · open to retry' })
  })

  it('wakes the composer as the frame, each clip and the short become ready', () => {
    expect(goalWake(shortGoalFixture(), frameDone())?.from).toBe('Frame ready')
    expect(goalWake(frameDone(), firstClip())?.from).toBe('Clip 1 ready')
    const step = shortStep('clip2', 'running', 1)
    const frame = shortStage('frame', [{ index: 0, artifactId: 'frame-a' }])
    const generating = shortGoalFixture({ status: 'running', stage: 'videos', chainId: step.chainId, steps: [step], stages: { frame, videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a' }], [step]) } })
    const ready = shortGoalFixture({
      stage: 'videos', chainId: step.chainId, stages: { frame, videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a' }, { index: 1, artifactId: 'clip-b' }]) },
      finish: { status: 'review', sourceArtifactId: 'clip-b', finalArtifactId: null, error: null },
    })
    expect(goalWake(generating, ready)?.from).toBe('Clip 2 ready')
    const finishing = { ...ready, finish: { status: 'running' as const, sourceArtifactId: 'clip-b', finalArtifactId: null, error: null } }
    const finished = { ...ready, status: 'completed' as const, finalArtifactId: 'final', finish: { status: 'completed' as const, sourceArtifactId: 'clip-b', finalArtifactId: 'final', error: null } }
    expect(goalWake(finishing, finished)?.from).toBe('Short ready')
  })

  it('prices each clip on its own and reads H3 Max estimates as lower bounds', () => {
    const goal = firstClip()
    expect(goalOutputEstimate(goal, 'frame', 0)).toBe(0.21)
    expect(goalOutputEstimate(goal, 'videos', 1)).toBe(0.6)
    expect(goalStillVersions(goal, 'videos', 0)).toHaveLength(1)
    expect(shortEstimateText({ usd: 0.6, warnings: [LOWER_BOUND] })).toBe('at least $0.60')
    expect(shortEstimateText({ usd: 0.21, warnings: [] })).toBe('$0.21')
    expect(shortEstimateText({ usd: null, warnings: ['fal has no price without FAL_ADMIN_API_KEY'] })).toBe('estimate unavailable (fal has no price without FAL_ADMIN_API_KEY)')
  })

  it('labels clip outputs in the notebook by clip and version', () => {
    const clip = shortStep('clip1', 'completed')
    const goal = shortGoalFixture({ stage: 'videos', stages: { videos: { ...shortStage('videos', [{ index: 0, artifactId: 'clip1-asset' }], [clip]), allSteps: [clip] } } })
    expect(goalGenerationMarks([goal]).get('clip1-output')).toBe('Clip 1/2 · @b1')
  })

  it('opens a new short on Frame, a saved version 4 short on Character until its frame exists, then on the stage it reached', () => {
    expect(defaultShortTab(shortGoalFixture(), twoClips)).toBe('frame')
    const legacy = legacyShortPlanFixture()
    expect(defaultShortTab(shortGoalFixture({}, legacy), legacy)).toBe('character')
    expect(defaultShortTab(shortGoalFixture({ stages: { frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a' }]) } }, legacy), legacy)).toBe('frame')
    expect(defaultShortTab(shortGoalFixture({ status: 'running', stages: { frame: shortStage('frame', []) } }), twoClips)).toBe('frame')
    expect(defaultShortTab(shortGoalFixture({ stages: { frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a' }]) } }), twoClips)).toBe('frame')
    expect(defaultShortTab(firstClip(), twoClips)).toBe('video')
    const finished = shortGoalFixture({
      stage: 'videos',
      stages: { ...firstClip().stages, videos: shortStage('videos', [{ index: 0, artifactId: 'clip-a' }, { index: 1, artifactId: 'clip-b' }]) },
      finish: { status: 'review', sourceArtifactId: 'clip-b', finalArtifactId: null, error: null },
    })
    expect(defaultShortTab(finished, twoClips)).toBe('finish')
    expect(defaultShortTab(finished, shortPlanFixture([10, 10, 5]))).toBe('video')
  })
})

