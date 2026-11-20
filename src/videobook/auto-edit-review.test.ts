import { describe, expect, it } from 'vitest'
import type { SegmentSource } from '../../server/src/auto-edit/plan'
import { buildAutoEditPlan, DEFAULT_AUTO_EDIT_SECTIONS, type AutoEditAnchors } from '../../server/src/auto-edit/style'
import { autoEditPlanDurationSeconds, buildAutoEditSegmentRanges } from './auto-edit-preview'
import {
  autoEditAnchorRule,
  autoEditAnchorsForSegment,
  autoEditBeats,
  autoEditConnectorClip,
  autoEditEditPercentAt,
  autoEditSegmentFacts,
  autoEditSegmentLengthText,
  autoEditSegmentsForAnchor,
  autoEditTicks,
  autoEditWithAnchor,
  buildAutoEditTimelineLayout,
} from './auto-edit-review'

const SOURCE: SegmentSource = {
  artifactId: '0195a000-0000-7000-8000-000000000002',
  sourceHash: 'hash-review',
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

describe('auto-edit review timeline', () => {
  const built = buildAutoEditPlan(SOURCE, ANCHORS, DEFAULT_AUTO_EDIT_SECTIONS)
  const ranges = buildAutoEditSegmentRanges(built.plan)
  const blocks = buildAutoEditTimelineLayout(ranges)
  const total = autoEditPlanDurationSeconds(built.plan)

  it('gives every segment room for its label and keeps the blocks end to end', () => {
    expect(blocks).toHaveLength(ranges.length)
    expect(blocks.reduce((sum, block) => sum + block.widthPercent, 0)).toBeCloseTo(100, 6)
    for (const [index, block] of blocks.entries()) {
      expect(block.widthPercent).toBeGreaterThan(7)
      if (index > 0) expect(block.leftPercent).toBeCloseTo(blocks[index - 1]!.leftPercent + blocks[index - 1]!.widthPercent, 6)
    }
    const replay = ranges.findIndex((range) => range.label === 'Replay')
    expect(blocks[replay]!.widthPercent).toBeGreaterThan(ranges[replay]!.widthPercent)
  })

  it('fits every label at the measured lane width and shares the rest by length', () => {
    const laneWidth = 600
    const fitted = buildAutoEditTimelineLayout(ranges, laneWidth)
    expect(fitted.reduce((sum, block) => sum + block.widthPercent, 0)).toBeCloseTo(100, 6)
    for (const [index, block] of fitted.entries()) {
      const range = ranges[index]!
      const characters = Math.max(range.label.length, autoEditSegmentLengthText(range).length)
      expect((block.widthPercent / 100) * laneWidth).toBeGreaterThanOrEqual(characters * 6.8 + 18 - 1e-6)
    }
    const bodies = ranges.flatMap((range, index) => (range.label === 'Body' ? [index] : []))
    expect(fitted[bodies[0]!]!.widthPercent).toBeGreaterThan(fitted[bodies[1]!]!.widthPercent)
    const tooNarrow = buildAutoEditTimelineLayout(ranges, 120)
    expect(tooNarrow.reduce((sum, block) => sum + block.widthPercent, 0)).toBeCloseTo(100, 6)
    expect(autoEditSegmentLengthText(ranges.find((range) => range.label === 'Crash')!)).toBe('1.40s · ½×')
  })

  it('maps edit time onto the stretched blocks', () => {
    expect(autoEditEditPercentAt(ranges, blocks, 0)).toBe(0)
    expect(autoEditEditPercentAt(ranges, blocks, total)).toBeCloseTo(100, 6)
    for (const [index, range] of ranges.entries()) {
      expect(autoEditEditPercentAt(ranges, blocks, range.outputStartSeconds)).toBeCloseTo(blocks[index]!.leftPercent, 6)
    }
    const crash = ranges.findIndex((range) => range.label === 'Crash')
    const middle = (ranges[crash]!.outputStartSeconds + ranges[crash]!.outputEndSeconds) / 2
    expect(autoEditEditPercentAt(ranges, blocks, middle)).toBeCloseTo(blocks[crash]!.leftPercent + blocks[crash]!.widthPercent / 2, 6)
  })

  it('joins a block to its source range', () => {
    const crash = ranges.findIndex((range) => range.label === 'Crash')
    const clip = autoEditConnectorClip(blocks[crash]!, ranges[crash]!, 10)
    expect(clip).toBe(
      `polygon(${blocks[crash]!.leftPercent.toFixed(3)}% 0, ${(blocks[crash]!.leftPercent + blocks[crash]!.widthPercent).toFixed(3)}% 0, 72.000% 100%, 65.000% 100%)`,
    )
  })

  it('links each marker to the segments it moves', () => {
    const labels = (key: Parameters<typeof autoEditSegmentsForAnchor>[2]) =>
      autoEditSegmentsForAnchor(ranges, built.anchors, key, SOURCE.fps).map((range) => range.label)
    expect(labels('hook.start')).toEqual(['Cold open'])
    expect(labels('moment.start')).toEqual(['Replay', 'Punch-in', 'Push-in'])
    expect(labels('moment.peak')).toEqual(['Replay', 'Punch-in', 'Crash'])
    expect(labels('moment.end')).toEqual(['Body', 'Push-in', 'Crash', 'Body'])
    const crash = ranges.find((range) => range.label === 'Crash')!
    expect(autoEditAnchorsForSegment(crash.segment, built.anchors, SOURCE.fps)).toEqual(['moment.peak', 'moment.end'])
    const noHook = { ...built.anchors, hook: null }
    const firstBody = ranges.find((range) => range.label === 'Body')!
    expect(autoEditAnchorsForSegment(firstBody.segment, noHook, SOURCE.fps)).toEqual(['moment.end'])
  })

  it('creates a hook when a hook marker moves on a draft without one', () => {
    const noHook = { ...ANCHORS, hook: null }
    expect(autoEditWithAnchor(noHook, 'hook.end', 4, 10).hook).toEqual({ start: 1.5, end: 4 })
    expect(autoEditWithAnchor(noHook, 'hook.start', 9, 10).hook).toEqual({ start: 9, end: 10 })
  })

  it('states what each beat adds and lists the sound cues', () => {
    const beats = autoEditBeats(built.anchors, DEFAULT_AUTO_EDIT_SECTIONS, built.cues)
    expect(beats.map((beat) => [beat.label, beat.amount])).toEqual([
      ['Cold open', '+2.00 s'],
      ['Replays', '+1.00 s'],
      ['Push-in', '+1.20 s'],
      ['Crash', '+1.40 s'],
      ['Sounds', '5 cues'],
    ])
    expect(beats[3]!.detail).toBe('6.50–7.20 s at half speed, crash look, pitch drop')
    expect(beats[4]!.detail).toBe('riser, impact ×2, glitch, power down')
    const quiet = autoEditBeats(built.anchors, { ...DEFAULT_AUTO_EDIT_SECTIONS, replays: false, pushIn: false, crash: false }, [])
    expect(quiet[4]!.detail).toBe('Nothing to cue without replays, push-in or crash')
  })

  it('describes a segment and the limits of a marker', () => {
    const crash = ranges.find((range) => range.label === 'Crash')!
    expect(autoEditSegmentFacts(crash.segment)).toBe('half speed, in-between frames · zoom 1× → 2.7× · crash look · sound pitched down')
    const punch = ranges.find((range) => range.label === 'Punch-in')!
    expect(autoEditSegmentFacts(punch.segment)).toBe('normal speed · held at 1.9× · source sound')
    expect(autoEditAnchorRule('moment.peak')).toBe('Peak sits 0.20–0.80 s after the start and 0.30–2.00 s before the end.')
    expect(autoEditAnchorRule('hook.end')).toBe('The hook stays 1.50–5.00 s long.')
  })

  it('spaces ruler ticks by the clip length', () => {
    expect(autoEditTicks(10).map((tick) => tick.label)).toEqual(['0 s', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
    expect(autoEditTicks(45).map((tick) => tick.seconds)).toEqual([0, 10, 20, 30, 40])
    expect(autoEditTicks(0)).toEqual([])
  })
})
