import { describe, expect, it } from 'vitest'
import { frameToSeconds, secondsToFrame, type SegmentSource } from '../../server/src/auto-edit/plan'
import { buildAutoEditPlan, DEFAULT_AUTO_EDIT_SECTIONS, type AutoEditAnchors } from '../../server/src/auto-edit/style'
import {
  autoEditCuesBetween,
  autoEditInvertZoomPoint,
  autoEditLookFilter,
  autoEditNudgeSeconds,
  autoEditPlanDurationSeconds,
  autoEditScheduleAt,
  autoEditSegmentLabel,
  autoEditZoomStyle,
  buildAutoEditSegmentRanges,
} from './auto-edit-preview'

const SOURCE: SegmentSource = {
  artifactId: '0195a000-0000-7000-8000-000000000001',
  sourceHash: 'hash-1',
  fps: 30,
  frames: 300,
  width: 1080,
  height: 1920,
  hasAudio: true,
}

const ANCHORS: AutoEditAnchors = {
  hook: { start: 1.5, end: 3.5 },
  moment: { start: 6.0, peak: 6.5, end: 7.2 },
  focus: {
    start: { x: 0.35, y: 0.4 },
    peak: { x: 0.65, y: 0.6 },
    end: { x: 0.55, y: 0.5 },
  },
  keep: { start: 0.5, end: 9.0 },
  cuts: [],
}

describe('auto-edit preview schedule', () => {
  const built = buildAutoEditPlan(SOURCE, ANCHORS, DEFAULT_AUTO_EDIT_SECTIONS)
  const ranges = buildAutoEditSegmentRanges(built.plan)

  it('names segments and sizes strip blocks by output frames', () => {
    expect(ranges.map((entry) => entry.label)).toEqual([
      'Cold open',
      'Body',
      'Replay',
      'Punch-in',
      'Push-in',
      'Crash',
      'Body',
    ])
    const totalPercent = ranges.reduce((sum, entry) => sum + entry.widthPercent, 0)
    expect(totalPercent).toBeCloseTo(100, 6)
    const crash = ranges.find((entry) => entry.segment.id === 'crash')!
    expect(crash.outputDurationSeconds).toBeCloseTo(1.4, 2)
  })

  it('computes source time, playbackRate, interpolated zoom, and looks at any output time', () => {
    const startSample = autoEditScheduleAt(built.plan, 0.5)!
    expect(startSample.segmentId).toBe('cold-open')
    expect(startSample.sourceTime).toBeCloseTo(2.0, 4)
    expect(startSample.playbackRate).toBe(1)
    expect(startSample.zoom.scale).toBe(1)
    expect(startSample.look).toBe('none')

    const body1 = ranges[1]!
    const bodySample = autoEditScheduleAt(built.plan, body1.outputStartSeconds + 0.25)!
    expect(bodySample.segmentId).toBe('body-1')
    expect(bodySample.sourceTime).toBeCloseTo(0.75, 4)

    const punchIn = ranges[3]!
    const punchSample = autoEditScheduleAt(built.plan, punchIn.outputStartSeconds + 0.1)!
    expect(punchSample.segmentLabel).toBe('Punch-in')
    expect(punchSample.zoom.scale).toBeCloseTo(1.9, 4)
    expect(punchSample.zoom.x).toBeCloseTo(0.35, 4)
    expect(punchSample.zoom.y).toBeCloseTo(0.4, 4)

    const crash = ranges[5]!
    const crashMid = autoEditScheduleAt(built.plan, crash.outputStartSeconds + crash.outputDurationSeconds / 2)!
    expect(crashMid.segmentLabel).toBe('Crash')
    expect(crashMid.playbackRate).toBe(0.5)
    expect(crashMid.sourceTime).toBeCloseTo(6.5 + (crash.outputDurationSeconds / 2) * 0.5, 2)
    expect(crashMid.look).toBe('crash')
    expect(crashMid.zoom.scale).toBeGreaterThan(2)
    expect(crashMid.zoom.scale).toBeLessThanOrEqual(2.7)
    expect(crashMid.lookHueTurns).toBeCloseTo(0.15 + 0.9 * (crash.outputDurationSeconds / 2), 4)

    const endSample = autoEditScheduleAt(built.plan, autoEditPlanDurationSeconds(built.plan) + 2)!
    expect(endSample.segmentId).toBe('body-2')
  })

  it('builds browser look filter strings and zoom transforms', () => {
    const ids = { crash: 'crash-id', rgbSplit: 'rgb-id' }
    expect(autoEditLookFilter('none', 0.4, ids)).toBe('none')
    expect(autoEditLookFilter('invert', 0.4, ids)).toBe('invert(1)')
    expect(autoEditLookFilter('rgb_split', 0.4, ids)).toBe('url(#rgb-id)')
    expect(autoEditLookFilter('crash', 1.0, ids)).toBe('url(#crash-id) hue-rotate(360.0deg)')
    expect(autoEditZoomStyle({ scale: 1, x: 0.5, y: 0.5 })).toEqual({
      transform: 'none',
      transformOrigin: '50.00% 50.00%',
    })
    expect(autoEditZoomStyle({ scale: 1.9, x: 0.35, y: 0.4 })).toEqual({
      transform: 'scale(1.9000)',
      transformOrigin: '35.00% 40.00%',
    })
    expect(autoEditInvertZoomPoint({ x: 0.5, y: 0.5 }, { scale: 2, x: 0.4, y: 0.6 })).toEqual({
      x: 0.45,
      y: 0.55,
    })
  })

  it('steps anchors by exact frame counts and finds cues in output windows', () => {
    const startFrame = 45
    const nudged = autoEditNudgeSeconds(frameToSeconds(startFrame, 30), 1, 30, 10)
    expect(secondsToFrame(nudged, 30)).toBe(46)
    expect(secondsToFrame(autoEditNudgeSeconds(nudged, -2, 30, 10), 30)).toBe(44)
    expect(autoEditSegmentLabel({ role: 'custom', zoom: undefined })).toBe('Segment')

    const replay1 = ranges[2]!
    const fired = autoEditCuesBetween(built.cues, replay1.outputStartSeconds - 0.5, replay1.outputStartSeconds + 0.1)
    expect(fired.some((entry) => entry.cue.sound === 'impact')).toBe(true)
  })
})
