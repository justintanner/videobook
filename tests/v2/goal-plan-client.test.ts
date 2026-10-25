import { describe, expect, it } from 'vitest'
import { composerGoal, goalCanRetry, goalGenerationMarks, goalOutputEstimate, goalPlanFromInputs, goalPlansEqual, goalProgress, goalStatusLine, goalStillStale, goalStillVersions, goalStopLabel, goalTileView, goalWake, goalWakeKey, type GoalSnapshot } from '../../src/videobook/goals'
import type { GoalGenerationStage, GoalPlan } from '../../server/src/goal-plan'
import type { GoalPlanV3 } from '../../server/src/goal-plan-v3'
import { goalBriefStyle } from '../../server/src/goal-styles'

type Step = GoalSnapshot['steps'][number]
type Stage = NonNullable<GoalSnapshot['stages']['frame']>
const plan: GoalPlan = {
  style: { id: 'cinematic', options: {} },
  version: 2, title: 'Rainy commute', continuity: 'Two characters share a flooded street', aspectRatio: '9:16', imageModel: 'sunburst', imageResolution: '2K', videoResolution: '720p', frameContinuity: false,
  frame: { prompt: 'Both characters beside a bicycle under an umbrella' },
  shots: [0, 1, 2].map(index => ({ title: `Commute ${index + 1}`, storyboardPrompt: `Still frame ${index + 1}`, endingPrompt: null, videoPrompt: `Action ${index + 1}`, durationSeconds: 10 })),
}
const estimate = { frame: { usd: 0.2, warnings: [] }, still: { usd: 0.2, warnings: [] }, storyboards: { usd: 0.6, warnings: [] }, videos: { usd: 2.4, warnings: [] }, total: { usd: 3.2, warnings: [] } }
function goal(extra: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    kind: 'video-goal', assemblyStale: false, planVersion: 2, stage: 'frame', stages: {}, goalId: 'goal-1', bookId: 'book', notebookId: 'notebook', cellId: 'goal-tile', address: '@a3', requestId: 'request',
    brief: '@a1 @a2 ride through the rain, three 10s clips', characters: [], revision: 1, plan, estimate, status: 'review', error: null, chainId: null, planningJobId: null,
    clipIds: [], trackId: null, assembly: null, dismissedAt: null, createdAt: '2026-10-07T10:00:00Z', updatedAt: '2026-10-07T10:00:00Z', steps: [],
    finish: null, finalArtifactId: null, coldOpen: null, ...extra,
  }
}
function run(stage: GoalGenerationStage, statuses: Step['status'][]): Stage {
  const steps = statuses.map((status, index): Step => ({
    id: stage === 'frame' ? 'frame' : `${stage === 'storyboards' ? 'storyboard' : 'shot'}${index + 1}`, chainId: `${stage}-chain`, status,
    error: status === 'failed' ? 'Rejected' : null, artifactId: status === 'completed' ? `${stage}-asset-${index}` : null,
    cellId: ['completed', 'running', 'failed'].includes(status) ? `${stage}-producer-${index}` : null,
    address: ['completed', 'running', 'failed'].includes(status) ? `@c${index + 1}` : null,
    outputCellId: ['completed', 'running', 'failed'].includes(status) ? `${stage}-output-${index}` : null,
    startedAt: status === 'running' ? '2026-10-07T10:01:00Z' : null,
  }))
  return {
    chainId: `${stage}-chain`, revision: 1, approvedAt: '2026-10-07T10:00:00Z', previousChainIds: [], shotIndexes: statuses.map((_, index) => index), steps, allSteps: steps,
    outputs: steps.flatMap((step, index) => step.status === 'completed' ? [{ index, artifactId: step.artifactId!, cellId: step.outputCellId, producerCellId: step.cellId, address: `@d${index + 1}`, versions: [], stale: null }] : []),
  }
}
function running(stage: GoalGenerationStage, statuses: Step['status'][], extra: Partial<GoalSnapshot> = {}): GoalSnapshot {
  const current = run(stage, statuses)
  return goal({
    status: 'running', stage, chainId: current.chainId, steps: current.steps,
    stages: { ...(stage !== 'frame' ? { frame: run('frame', ['completed']) } : {}), ...(stage === 'videos' ? { storyboards: run('storyboards', ['completed', 'completed', 'completed']) } : {}), [stage]: current },
    ...extra,
  })
}

describe('staged goal model', () => {
  it('prices video revisions by clip duration and includes optional ending images in still costs', () => {
    const varied = goal({ plan: { ...plan, frameContinuity: true, shots: plan.shots.map((shot, index) => ({ ...shot, durationSeconds: [5, 10, 15][index]! })) } })
    expect(goalOutputEstimate(varied, 'frame', 0)).toBe(0.2)
    expect(goalOutputEstimate(varied, 'storyboards', 4)).toBeCloseTo(0.1)
    expect([0, 1, 2].map(index => goalOutputEstimate(varied, 'videos', index))).toEqual([0.4, 0.8, 1.2])
    expect(goalOutputEstimate(goal({ estimate: { ...estimate, videos: { usd: null, warnings: ['Pricing unavailable'] } } }), 'videos', 0)).toBeNull()
  })

  it('compares every editable field by value and tolerates reordered storage keys', () => {
    const reordered = JSON.parse(JSON.stringify(plan, Object.keys(plan).reverse())) as GoalPlan
    expect(goalPlansEqual(plan, { ...reordered, style: structuredClone(plan.style), frame: { prompt: plan.frame.prompt }, shots: structuredClone(plan.shots) })).toBe(true)
    for (const changed of [
      { ...plan, frame: { prompt: 'Changed' } }, { ...plan, imageResolution: '1K' as const }, { ...plan, videoResolution: '480p' as const }, { ...plan, imageModel: 'flare' as const },
      { ...plan, shots: plan.shots.map((shot, index) => index ? shot : { ...shot, storyboardPrompt: 'Changed' }) },
      { ...plan, shots: plan.shots.map((shot, index) => index ? shot : { ...shot, videoPrompt: 'Changed' }) },
      { ...plan, frameContinuity: true },
      { ...plan, shots: plan.shots.map((shot, index) => index ? shot : { ...shot, endingPrompt: 'Changed ending' }) },
    ]) expect(goalPlansEqual(plan, changed)).toBe(false)
  })

  it('compares style and option values and labels current, pending, fallback and legacy plans', () => {
    const style = goalBriefStyle('IG influencer GRWM')
    const styled = { ...plan, style }
    expect(goalPlansEqual(plan, styled)).toBe(false)
    expect(goalPlansEqual(styled, { ...styled, style: { ...style, options: Object.fromEntries(Object.entries(style.options).reverse()) } })).toBe(true)
    expect(goalPlansEqual(styled, { ...styled, style: { ...style, options: { ...style.options, light: 'golden-hour' } } })).toBe(false)
    expect(goalTileView(goal({ plan: styled }), null, undefined).styleLabel).toBe('IG Influencer')
    expect(goalTileView(null, styled, undefined).styleLabel).toBe('IG Influencer')
    expect(goalTileView(goal({ plan: null, status: 'planning', requestedStyle: style }), null, undefined).styleLabel).toBe('IG Influencer')
    const { style: _style, ...oldPlan } = plan
    expect(goalTileView(null, oldPlan as GoalPlan, undefined).styleLabel).toBe('Cinematic')
    expect(goalTileView(null, { title: 'Old', continuity: 'Old', aspectRatio: '9:16', shots: [] }, undefined).styleLabel).toBeNull()
  })

  it('names the plan, frame, storyboard, video and assembly reviews and progress', () => {
    expect(goalStatusLine(goal({ status: 'planning', plan: null }))).toMatchObject({ text: 'Planning', busy: true })
    expect(goalStatusLine(goal())).toMatchObject({ text: 'Review plan · est. $0.20', action: 'Review' })
    expect(goalStatusLine(running('frame', ['running']), 42)).toMatchObject({ text: 'Full frame · Generating 0:42', short: 'Frame' })
    expect(goalStatusLine(goal({ stage: 'storyboards' })).text).toBe('Review full frame')
    expect(goalStatusLine(running('storyboards', ['completed', 'running', 'pending']))).toMatchObject({ text: 'Storyboard 2 of 3 · Generating', short: 'SB 2/3' })
    expect(goalStatusLine(goal({ stage: 'videos' })).text).toBe('Review storyboards')
    expect(goalStatusLine(running('videos', ['completed', 'running', 'pending']), 134)).toMatchObject({ text: 'Shot 2 of 3 · Generating 2:14', short: '2/3' })
    expect(goalStatusLine(running('videos', ['completed', 'completed', 'completed'], { stage: 'assembly' }))).toMatchObject({ text: 'Assembling 3 clips', busy: true })
    expect(goalStatusLine(goal({ status: 'completed' }))).toMatchObject({ text: 'Complete · 0:30', action: 'Preview' })
  })

  it('reports stage failures, interruption, stopping and legacy recovery', () => {
    expect(goalStatusLine(running('frame', ['failed'], { status: 'failed' }))).toMatchObject({ text: 'Full frame failed', action: 'Retry' })
    expect(goalStatusLine(running('storyboards', ['completed', 'failed', 'skipped'], { status: 'failed' })).text).toBe('Storyboard 2 failed')
    expect(goalStatusLine(running('videos', ['completed', 'interrupted', 'skipped'], { status: 'interrupted' })).text).toBe('Shot 2 interrupted')
    expect(goalProgress(running('storyboards', ['completed', 'failed', 'skipped'], { status: 'failed' })).shots.map(shot => shot.state)).toEqual(['done', 'failed', 'skipped'])
    expect(goalStatusLine(goal({ status: 'failed', plan: null })).text).toBe('Planning failed')
    expect(goalStatusLine(goal({ status: 'failed', planVersion: 1 })).action).toBeNull()
    expect(goalStatusLine(goal({ status: 'cancelled' })).text).toBe('Stopped')
  })

  it('names scene, video and finish reviews for a scene and video goal', () => {
    const ref = { kind: 'image' as const, artifactId: 'image-1', cellId: 'cell-1', address: '@a1', label: 'Skater', objectHash: 'hash-1', slot: '@image1' }
    const modern: GoalPlanV3 = {
      version: 3, title: 'Morning market', aspectRatio: '16:9',
      scene: { prompt: 'Skate past the fruit stalls', tool: 'generate_image', model: 'kie:nano-banana-2-1', aspectRatio: '16:9', resolution: '4K', outputFormat: 'jpg', imageRefs: [ref] },
      video: { prompt: 'The skater rolls through the stalls', tool: 'generate_video', model: 'kie:bytedance/seedance-2-5', aspectRatio: '16:9', resolution: '1080p', durationSeconds: 13, generateAudio: true, outputFormat: 'mp4', imageRefs: [ref], videoRefs: [] },
      references: [ref], sampledFrames: [],
      finish: { suggestedColdOpenSeconds: 2.3, watermark: { platform: 'tiktok', handle: 'jtbkk', profileUrl: 'https://www.tiktok.com/@jtbkk', mode: 'burn', handleEndSeconds: 3, qrLeadSeconds: 2.3, handleOpacity: 0.28, qrOpacity: 0.37, fadeSeconds: 0.3 } },
    }
    const scene = goal({ planVersion: 3, plan: modern, estimate: { ...estimate, frame: { usd: 0.04, warnings: [] }, videos: { usd: 1.2, warnings: [] } } })
    expect(goalStatusLine(scene).text).toBe('Review scene · est. $0.04')
    expect(goalStatusLine({ ...scene, stage: 'videos' }).text).toBe('Review video · est. $1.20')
    const finish = { status: 'review' as const, sourceArtifactId: 'video-1', finalArtifactId: null, error: null }
    const coldOpen = { startSeconds: 0, endSeconds: 2.3, durationSeconds: 13, sourceObjectHash: 'video-hash', analysisUsd: 0 as const }
    expect(goalStatusLine({ ...scene, stage: 'videos', finish, coldOpen }).text).toBe('Review finish · analysis $0.00')
    expect(goalStatusLine({ ...scene, stage: 'videos', finish: { ...finish, status: 'running' }, coldOpen })).toMatchObject({ text: 'Finishing the cold open and watermark', short: 'Finishing', tone: 'live', busy: true })
    expect(goalStatusLine({ ...scene, stage: 'videos', finish: { ...finish, status: 'failed', error: 'Watermark failed' }, coldOpen }).text).toBe('Finishing failed')
    expect(goalTileView({ ...scene, finish: { ...finish, status: 'running' } }, null, undefined).chip).toEqual({ label: 'Finishing', tone: 'live' })
    expect(goalCanRetry({ ...scene, status: 'failed', chainId: 'scene-chain' })).toBe(true)
    expect(goalCanRetry(scene)).toBe(false)
    expect(goalCanRetry(goal({ planVersion: 1, status: 'failed' }))).toBe(false)
    const sceneStep: Step = { id: 'scene', chainId: 'scene-chain', status: 'running', error: null, artifactId: null, cellId: 'producer', address: '@c1', outputCellId: null, startedAt: '2026-10-07T10:01:00Z' }
    const runningScene = goal({
      ...scene, status: 'running', chainId: 'scene-chain', steps: [sceneStep],
      stages: { frame: { chainId: 'scene-chain', revision: 1, approvedAt: '2026-10-07T10:00:00Z', previousChainIds: [], shotIndexes: [0], steps: [sceneStep], allSteps: [sceneStep], outputs: [] } },
    })
    expect(goalStatusLine(runningScene, 12).text).toBe('Scene · Generating 0:12')
    const videoStep: Step = { id: 'video', chainId: 'video-chain', status: 'running', error: null, artifactId: null, cellId: null, address: null, outputCellId: null, startedAt: '2026-10-07T10:01:00Z' }
    const revised = goal({
      ...scene, status: 'running', stage: 'videos', chainId: 'video-chain', steps: [videoStep],
      stages: { videos: { chainId: 'video-chain', revision: 1, approvedAt: '2026-10-07T10:00:00Z', previousChainIds: [], shotIndexes: [0], steps: [videoStep], allSteps: [videoStep], outputs: [], attempts: [{ stage: 'videos', index: 0, chainId: 'video-chain', stepId: 'video', artifactId: null, cellId: null, basePrompt: modern.video.prompt, feedback: 'Closer', parentArtifactId: null, frameArtifactId: null, createdAt: '2026-10-07T10:00:00Z' }] } },
    })
    expect(goalStatusLine(revised).text).toBe('Revising video · Submitting')
  })

  it('wakes only on stage and item progress, without waking on clocks or unchanged polls', () => {
    const frame = running('frame', ['running'])
    const boards = running('storyboards', ['running', 'pending', 'pending'])
    expect(goalWake(goal({ status: 'planning', plan: null }), goal())?.from).toBe('Plan ready')
    expect(goalWake(goal(), frame)?.from).toBe('Plan approved')
    expect(goalWake(frame, goal({ stage: 'storyboards' }))?.from).toBe('Full frame ready')
    expect(goalWake(goal({ stage: 'storyboards' }), boards)?.from).toBe('Frame approved')
    expect(goalWake(boards, goal({ stage: 'videos' }))?.from).toBe('Storyboards ready')
    expect(goalWake(goal({ stage: 'videos' }), running('videos', ['running', 'pending', 'pending']))?.from).toBe('Storyboards approved')
    expect(goalWake(running('videos', ['completed', 'running', 'pending']), running('videos', ['completed', 'completed', 'running']))?.from).toBe('Shot 2 ready')
    expect(goalWake(frame, { ...frame, updatedAt: 'later' })).toBeNull()
    expect(goalWakeKey(frame)).toBe(goalWakeKey({ ...frame, updatedAt: 'later' }))
    expect(goalWake(frame, { ...frame, status: 'cancelled' })).toBeNull()
    expect(goalWake(frame, { ...frame, goalId: 'different' })).toBeNull()
    expect(goalWake(running('videos', ['completed', 'completed', 'running']), goal({ status: 'completed', assembly: { sequenceId: 'sequence', startFrame: 0, durationFrames: 900 } }))?.from).toBe('Sequence assembled')
  })

  it('marks both the producer and output tiles for every stage', () => {
    const marks = goalGenerationMarks([running('videos', ['completed', 'running', 'pending'])])
    expect(marks.get('frame-producer-0')).toBe('Frame · @a3')
    expect(marks.get('frame-output-0')).toBe('Frame · @a3')
    expect(marks.get('storyboards-output-1')).toBe('SB 2/3 · @a3')
    expect(marks.get('videos-producer-1')).toBe('2/3 · @a3')
  })

  it('includes ending frames in progress, thumbnails and goal marks', () => {
    const paired = running('storyboards', ['completed', 'completed', 'completed', 'completed', 'running', 'pending'], { plan: { ...plan, frameContinuity: true } })
    const progress = goalProgress(paired)
    expect(progress).toMatchObject({ done: 4, total: 6 })
    expect(progress.shots[4]).toMatchObject({ title: 'Commute 2 · Ending', state: 'generating' })
    const view = goalTileView(paired, null, undefined)
    expect(view.progressPercent).toBe(50)
    expect(view.thumbnails[4]?.label).toBe('Ending 1')
    expect(goalGenerationMarks([paired]).get('storyboards-producer-4')).toBe('End 2/3 · @a3')
  })

  it('shows stage rows, thumbnails and whole-goal progress without flickering state', () => {
    expect(goalTileView(goal({ status: 'planning', plan: null }), null, undefined)).toMatchObject({ planning: true, title: 'Building your shot plan', note: goal().brief, progressPercent: 0 })
    expect(goalTileView(running('frame', ['running']), null, undefined)).toMatchObject({ chip: { label: 'Frame' }, progressPercent: 0 })
    const view = goalTileView(running('videos', ['completed', 'running', 'pending']), null, undefined)
    expect(view).toMatchObject({ title: plan.title, shotsLabel: '3 × 10s', chip: { label: 'Videos' }, progressPercent: 71 })
    expect(view.thumbnails).toHaveLength(4)
    expect(view.rows[1]).toMatchObject({ state: 'generating', detail: '', startedAt: '2026-10-07T10:01:00Z' })
    expect(goalTileView(goal(), null, undefined).note).toBe('Review plan · est. $0.20')
  })

  it('folds long plans and renders both saved plan versions before snapshots load', () => {
    const long = { ...plan, shots: Array.from({ length: 8 }, (_, index) => ({ ...plan.shots[0]!, title: `Shot ${index + 1}`, durationSeconds: index ? 10 : 12 })) }
    const view = goalTileView(null, long, 'Fallback')
    expect(view.rows).toHaveLength(4)
    expect(view).toMatchObject({ shotsLabel: '8 clips', hiddenRows: 4 })
    const legacy = { title: plan.title, continuity: plan.continuity, aspectRatio: plan.aspectRatio, shots: plan.shots.map(shot => ({ title: shot.title, prompt: shot.videoPrompt, durationSeconds: shot.durationSeconds })) }
    expect(goalPlanFromInputs({ plan })).toEqual(plan)
    expect(goalPlanFromInputs({ plan: legacy })).toEqual(legacy)
    expect(goalTileView(null, legacy, 'Fallback').rows[0]?.title).toBe('Commute 1')
    expect(goalPlanFromInputs({ plan: { title: 'Broken', shots: [{}] } })).toBeNull()
  })

  it('chooses the newest visible goal and ignores stopped or dismissed ones', () => {
    const current = goal()
    expect(composerGoal([goal({ status: 'cancelled' }), goal({ status: 'completed', dismissedAt: 'earlier' }), current])).toBe(current)
    expect(composerGoal([goal({ status: 'cancelled' })])).toBeNull()
  })

  it('reports still versions, stale selections, revision progress and completion wakes', () => {
    const current = running('storyboards', ['completed', 'running', 'pending'])
    const stage = current.stages.storyboards!
    const original = { stage: 'storyboards' as const, index: 1, chainId: 'older-chain', stepId: 'storyboard2', artifactId: 'old-board', cellId: 'old-cell', basePrompt: plan.shots[1]!.storyboardPrompt, feedback: null, parentArtifactId: null, frameArtifactId: 'frame-asset-0', createdAt: '2026-10-07T10:00:00Z' }
    const revised = { ...original, chainId: stage.chainId, artifactId: null, cellId: null, feedback: 'Move them closer', parentArtifactId: original.artifactId }
    stage.attempts = [original, revised]
    stage.outputs.push({ index: 1, artifactId: original.artifactId, cellId: original.cellId, producerCellId: 'old-producer', address: '@d2', stale: 'Storyboard 2 was made from an older full frame.', versions: [
      { ...revised, current: false, status: 'running', address: null }, { ...original, current: true, status: 'completed', address: '@d2' },
    ] })
    expect(goalStillVersions(current, 'storyboards', 1).map(version => version.current)).toEqual([false, true])
    expect(goalStillVersions(current, 'frame', 9)).toEqual([])
    expect(goalStillStale(current, 'storyboards', 1)).toContain('older full frame')
    expect(goalStillStale(current, 'frame', 0)).toBeNull()
    expect(goalStatusLine(current, 12).text).toBe('Revising storyboard 2 · Generating 0:12')
    expect(goalWake(goal({ stage: 'videos' }), current)?.from).toBe('Revising storyboard 2')
    expect(goalWake(current, { ...current, status: 'review', stage: 'videos' })?.from).toBe('Storyboard 2 revised')
    expect(goalGenerationMarks([current]).get('storyboards-producer-1')).toBe('SB 2 v2 · @a3')
    expect(goalCanRetry({ ...current, status: 'cancelled' })).toBe(false)
    expect(goalStatusLine({ ...current, status: 'cancelled' }).action).toBeNull()
    expect(goalStopLabel(current)).toBe('Stop goal')
    expect(goalStopLabel({ ...current, resumeStage: 'videos' })).toBe('Stop revision')
    expect(goalStopLabel({ ...current, resumeStage: 'videos', stages: { ...current.stages, storyboards: { ...stage, attempts: [original] } } })).toBe('Stop regeneration')
    const stoppedRun = { ...stage, chainId: 'older-chain', previousChainIds: ['storyboards-chain'] }
    expect(goalWake(current, { ...current, status: 'review', stage: 'videos', chainId: 'older-chain', stages: { ...current.stages, storyboards: stoppedRun } })?.from).toBe('Storyboard 2 revision stopped')
    const frame = running('frame', ['running'])
    frame.stages.frame!.attempts = [{ ...revised, stage: 'frame', index: 0, stepId: 'frame', chainId: frame.chainId! }]
    expect(goalStatusLine(frame, 12).text).toBe('Revising frame · Generating 0:12')
    expect(goalWake(frame, { ...frame, status: 'review', stage: 'storyboards' })?.from).toBe('Frame revised')
  })
})
