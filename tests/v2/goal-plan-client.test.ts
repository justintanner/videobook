import { describe, expect, it } from 'vitest'
import { asGoalTitleOptions, composerGoal, defaultShortTab, goalCanRetry, goalGenerationMarks, goalOutputEstimate, goalPlanSeconds, goalStatusLine, goalStillVersions, goalTileView, goalWake, LEGACY_GOAL_NOTE, shortEstimateText } from '../../src/videobook/goals'
import { LOWER_BOUND, legacyGoalFixture, legacyShortPlanFixture, shortGoalFixture, shortPlanFixture, shortStage, shortStep, storyboardPlanFixture } from './goal-short-fixtures'

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

describe('burned title options', () => {
  it('reads the options of a title answer and refuses an answer without one', () => {
    const options = [{ headline: 'รอรถเมล์กลางฝน', secondary: 'Waiting for the bus in the rain' }, { headline: 'ฝนตกแต่รถเมล์ไม่มา', secondary: '' }]
    expect(asGoalTitleOptions({ goal_id: 'short-1', options: [...options, { headline: 3 }, null], model: 'gpt-6-astra' })).toEqual(options)
    expect(() => asGoalTitleOptions({ goal_id: 'short-1', options: [] })).toThrow('The server returned no title options')
    expect(() => asGoalTitleOptions(null)).toThrow('The server returned no title options')
    expect(shortEstimateText({ usd: 0.4194, warnings: ['Forecast: input tokens use chars/4.'] })).toBe('$0.42')
  })
})

describe('short goal model with a storyboard', () => {
  const plan = storyboardPlanFixture()
  const atStoryboard = (extra: Parameters<typeof shortGoalFixture>[0] = {}) => shortGoalFixture({ stage: 'storyboards', ...extra }, plan)
  const allClean = () => shortStage('storyboards', [0, 1, 2, 3].map(index => ({ index, artifactId: `clean-${index + 1}` })))
  const clean = () => shortGoalFixture({ stage: 'frame', stages: { storyboards: allClean() } }, plan)
  const runningBoard = () => {
    const done = shortStep('storyboard1', 'completed')
    const step = shortStep('storyboard2', 'running', 1)
    return atStoryboard({ status: 'running', chainId: step.chainId, steps: [done, step], stages: { storyboards: shortStage('storyboards', [{ index: 0, artifactId: 'clean-1' }], [done, step]) } })
  }

  it('opens on Storyboard, then on Frame once every storyboard frame is clean', () => {
    expect(defaultShortTab(atStoryboard(), plan)).toBe('storyboard')
    expect(defaultShortTab(runningBoard(), plan)).toBe('storyboard')
    expect(defaultShortTab(clean(), plan)).toBe('frame')
    expect(defaultShortTab(shortGoalFixture({ stage: 'videos', stages: { storyboards: allClean(), frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a' }]) } }, plan), plan)).toBe('video')
  })

  it('lists the storyboard step before the frame on the tile, with the next action and its estimate', () => {
    expect(goalStatusLine(atStoryboard()).text).toBe('Review storyboard · $0.84')
    expect(goalTileView(atStoryboard(), undefined)).toMatchObject({ note: 'Review storyboard · $0.84', chip: { label: 'Review' }, progressPercent: 0 })
    expect(goalTileView(atStoryboard(), undefined).rows.map(row => [row.number, row.title, row.state, row.detail])).toEqual([['01', 'Storyboard', 'planned', 'Planned'], ['02', 'Frame', 'planned', 'Planned']])
    expect(goalStatusLine(atStoryboard({ stages: { storyboards: shortStage('storyboards', [{ index: 0, artifactId: 'clean-1' }]) } })).text).toBe('Review storyboard · $0.63')
    expect(goalStatusLine(runningBoard(), 5).text).toBe('Storyboard 2 of 4 · Generating 0:05')
    expect(goalTileView(runningBoard(), undefined)).toMatchObject({ chip: { label: 'Storyboard' } })
    expect(goalTileView(runningBoard(), undefined).rows.map(row => [row.title, row.state, row.startedAt])).toEqual([['Storyboard', 'generating', '2026-11-12T00:01:00Z'], ['Frame', 'planned', null]])
    const failedStep = shortStep('storyboard3', 'failed', 2)
    const failed = atStoryboard({ status: 'failed', chainId: failedStep.chainId, steps: [failedStep], stages: { storyboards: shortStage('storyboards', [{ index: 0, artifactId: 'clean-1' }, { index: 1, artifactId: 'clean-2' }], [failedStep]) } })
    expect(goalStatusLine(failed).text).toBe('Storyboard 3 failed')
    expect(goalTileView(failed, undefined).rows[0]).toMatchObject({ title: 'Storyboard', state: 'failed' })
    expect(goalStatusLine(clean()).text).toBe('Review frame · $0.21')
    expect(goalTileView(clean(), undefined)).toMatchObject({ progressPercent: 25 })
    expect(goalTileView(clean(), undefined).rows.map(row => [row.title, row.state])).toEqual([['Storyboard', 'done'], ['Frame', 'planned']])
    const clips = shortGoalFixture({ stage: 'videos', stages: { storyboards: allClean(), frame: shortStage('frame', [{ index: 0, artifactId: 'frame-a' }]) } }, plan)
    expect(goalTileView(clips, undefined).rows.map(row => row.title)).toEqual(['Clip 1', 'Clip 2'])
    expect(goalTileView(clips, undefined).progressPercent).toBe(50)
  })

  it('wakes when the storyboard is approved and clean, and prices and marks each storyboard frame', () => {
    expect(goalWake(atStoryboard(), runningBoard())?.from).toBe('Storyboard approved')
    expect(goalWake(runningBoard(), clean())?.from).toBe('Storyboard clean')
    expect(goalOutputEstimate(atStoryboard(), 'storyboards', 1)).toBe(0.21)
    expect(goalStillVersions(clean(), 'storyboards', 2)).toHaveLength(1)
    const board = shortStep('storyboard1', 'completed')
    const marked = shortGoalFixture({ stage: 'frame', stages: { storyboards: { ...shortStage('storyboards', [{ index: 0, artifactId: 'storyboard1-asset' }], [board]), allSteps: [board] } } }, plan)
    expect(goalGenerationMarks([marked]).get('storyboard1-output')).toBe('Storyboard 1/4 · @b1')
  })
})
