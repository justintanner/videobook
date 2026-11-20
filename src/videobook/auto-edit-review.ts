import { secondsToFrame, type PlanSegment } from '../../server/src/auto-edit/plan'
import {
  AUTO_EDIT_ANCHOR_LIMITS,
  CRASH_REPLAY,
  type AutoEditAnchors,
  type AutoEditCue,
  type AutoEditSections,
} from '../../server/src/auto-edit/style'
import type { AutoEditSegmentRange } from './auto-edit-preview'

export type AutoEditAnchorKey = 'hook.start' | 'hook.end' | 'moment.start' | 'moment.peak' | 'moment.end'
export type AutoEditFocusKey = 'start' | 'peak' | 'end'

export const AUTO_EDIT_HOOK_ANCHORS: readonly AutoEditAnchorKey[] = ['hook.start', 'hook.end']
export const AUTO_EDIT_MOMENT_ANCHORS: readonly AutoEditAnchorKey[] = ['moment.start', 'moment.peak', 'moment.end']

interface AutoEditAnchorInfo {
  label: string
  short: string
  focus: AutoEditFocusKey | null
}

export const AUTO_EDIT_ANCHOR_INFO: Readonly<Record<AutoEditAnchorKey, AutoEditAnchorInfo>> = {
  'hook.start': { label: 'Hook start', short: 'start', focus: null },
  'hook.end': { label: 'Hook end', short: 'end', focus: null },
  'moment.start': { label: 'Moment start', short: 'start', focus: 'start' },
  'moment.peak': { label: 'Moment peak', short: 'peak', focus: 'peak' },
  'moment.end': { label: 'Moment end', short: 'end', focus: 'end' },
}

const DEFAULT_HOOK_SECONDS = 2.5
const MIN_BLOCK_FRACTION = 0.08
const MAX_MIN_BLOCK_SHARE = 0.6
const LABEL_CHARACTER_PX = 6.8
const LABEL_PADDING_PX = 18

function seconds(value: number): string {
  return value.toFixed(2)
}

export function autoEditAnchorSeconds(anchors: AutoEditAnchors, key: AutoEditAnchorKey): number {
  if (key === 'hook.start') return anchors.hook?.start ?? anchors.keep.start
  if (key === 'hook.end') return anchors.hook?.end ?? Math.min(anchors.keep.end, anchors.keep.start + DEFAULT_HOOK_SECONDS)
  if (key === 'moment.start') return anchors.moment.start
  if (key === 'moment.peak') return anchors.moment.peak
  return anchors.moment.end
}

export function autoEditWithAnchor(
  anchors: AutoEditAnchors,
  key: AutoEditAnchorKey,
  nextSeconds: number,
  durationSeconds: number,
): AutoEditAnchors {
  if (key === 'hook.start') {
    const end = anchors.hook?.end ?? Math.min(durationSeconds, nextSeconds + DEFAULT_HOOK_SECONDS)
    return { ...anchors, hook: { start: nextSeconds, end } }
  }
  if (key === 'hook.end') {
    const start = anchors.hook?.start ?? Math.max(0, nextSeconds - DEFAULT_HOOK_SECONDS)
    return { ...anchors, hook: { start, end: nextSeconds } }
  }
  if (key === 'moment.start') return { ...anchors, moment: { ...anchors.moment, start: nextSeconds } }
  if (key === 'moment.peak') return { ...anchors, moment: { ...anchors.moment, peak: nextSeconds } }
  return { ...anchors, moment: { ...anchors.moment, end: nextSeconds } }
}

export function autoEditAnchorRule(key: AutoEditAnchorKey): string {
  const limits = AUTO_EDIT_ANCHOR_LIMITS
  const startToPeak = `${seconds(limits.minStartToPeakSeconds)}–${seconds(limits.maxStartToPeakSeconds)} s`
  const peakToEnd = `${seconds(limits.minPeakToEndSeconds)}–${seconds(limits.maxPeakToEndSeconds)} s`
  if (key === 'hook.start' || key === 'hook.end') {
    return `The hook stays ${seconds(limits.minHookSeconds)}–${seconds(limits.maxHookSeconds)} s long.`
  }
  if (key === 'moment.start') return `Start sits ${startToPeak} before the peak.`
  if (key === 'moment.peak') return `Peak sits ${startToPeak} after the start and ${peakToEnd} before the end.`
  return `End sits ${peakToEnd} after the peak.`
}

function anchorKeysFor(segment: PlanSegment, anchors: AutoEditAnchors): readonly AutoEditAnchorKey[] {
  if (segment.role === 'cold_open') return anchors.hook ? AUTO_EDIT_HOOK_ANCHORS : []
  return AUTO_EDIT_MOMENT_ANCHORS
}

export function autoEditAnchorsForSegment(
  segment: PlanSegment,
  anchors: AutoEditAnchors,
  fps: number,
): AutoEditAnchorKey[] {
  return anchorKeysFor(segment, anchors).filter((key) => {
    const frame = secondsToFrame(autoEditAnchorSeconds(anchors, key), fps)
    return frame === segment.startFrame || frame === segment.endFrame
  })
}

export function autoEditSegmentLengthText(range: AutoEditSegmentRange): string {
  const speed = range.segment.speed
  const suffix = speed === 1 ? '' : Math.abs(speed - 0.5) < 1e-6 ? ' · ½×' : ` · ${speed}×`
  return `${range.outputDurationSeconds.toFixed(2)}s${suffix}`
}

function autoEditSegmentTone(range: AutoEditSegmentRange): string {
  if (range.label === 'Punch-in') return 'punch'
  if (range.segment.role === 'cold_open') return 'cold'
  if (range.segment.role === 'push_in') return 'push'
  return range.segment.role
}

interface AutoEditTimedSpan {
  outputFrames: number
  outputStartSeconds: number
  outputEndSeconds: number
  outputDurationSeconds: number
}

/* One block on the edit lane. Body pieces that a cut separates stay one block,
   "Body · 2 cuts", and the body after the moment's beats reads "Ending". */
export interface AutoEditLaneItem extends AutoEditTimedSpan {
  index: number
  key: string
  label: string
  tone: string
  lengthText: string
  ranges: AutoEditSegmentRange[]
  sourceStartSeconds: number
  sourceEndSeconds: number
}

function laneItemFrom(ranges: AutoEditSegmentRange[], label: string): AutoEditLaneItem {
  const first = ranges[0]!
  const last = ranges[ranges.length - 1]!
  const cuts = ranges.length - 1
  const outputDurationSeconds = last.outputEndSeconds - first.outputStartSeconds
  const lengthText = cuts > 0
    ? `${outputDurationSeconds.toFixed(2)}s · ${cuts} ${cuts === 1 ? 'cut' : 'cuts'}`
    : autoEditSegmentLengthText(first)
  return {
    index: first.index,
    key: first.segment.id,
    label,
    tone: autoEditSegmentTone(first),
    lengthText,
    ranges,
    outputFrames: ranges.reduce((sum, range) => sum + range.outputFrames, 0),
    outputStartSeconds: first.outputStartSeconds,
    outputEndSeconds: last.outputEndSeconds,
    outputDurationSeconds,
    sourceStartSeconds: Math.min(...ranges.map((range) => range.sourceStartSeconds)),
    sourceEndSeconds: Math.max(...ranges.map((range) => range.sourceEndSeconds)),
  }
}

export function buildAutoEditLaneItems(ranges: readonly AutoEditSegmentRange[]): AutoEditLaneItem[] {
  const groups: Array<{ ranges: AutoEditSegmentRange[]; label: string; body: boolean }> = []
  let afterBeats = false
  for (const range of ranges) {
    const body = range.segment.role === 'body'
    if (!body && range.segment.role !== 'cold_open') afterBeats = true
    const last = groups[groups.length - 1]
    if (body && last?.body) {
      last.ranges.push(range)
      continue
    }
    groups.push({ ranges: [range], body, label: body ? (afterBeats ? 'Ending' : 'Body') : range.label })
  }
  return groups.map((group) => laneItemFrom(group.ranges, group.label))
}

export function autoEditLaneItemAt(items: readonly AutoEditLaneItem[], rangeIndex: number): AutoEditLaneItem | null {
  return items.find((item) => item.ranges.some((range) => range.index === rangeIndex)) ?? null
}

export function autoEditAnchorsForItem(item: AutoEditLaneItem, anchors: AutoEditAnchors, fps: number): AutoEditAnchorKey[] {
  const keys = new Set(item.ranges.flatMap((range) => autoEditAnchorsForSegment(range.segment, anchors, fps)))
  return [...AUTO_EDIT_HOOK_ANCHORS, ...AUTO_EDIT_MOMENT_ANCHORS].filter((key) => keys.has(key))
}

export function autoEditItemsForAnchor(
  items: readonly AutoEditLaneItem[],
  anchors: AutoEditAnchors,
  key: AutoEditAnchorKey,
  fps: number,
): AutoEditLaneItem[] {
  return items.filter((item) => autoEditAnchorsForItem(item, anchors, fps).includes(key))
}

export function autoEditCutsInItem(item: AutoEditLaneItem, anchors: AutoEditAnchors): number[] {
  if (item.ranges.length < 2) return []
  const tolerance = 1e-3
  return anchors.cuts.flatMap((cut, index) => (
    cut.start >= item.sourceStartSeconds - tolerance && cut.end <= item.sourceEndSeconds + tolerance ? [index] : []
  ))
}

export interface AutoEditTimelineBlock {
  index: number
  leftPercent: number
  widthPercent: number
}

function minimumShare(item: AutoEditLaneItem, laneWidthPx: number, count: number): number {
  if (laneWidthPx <= 0) return Math.min(MIN_BLOCK_FRACTION, MAX_MIN_BLOCK_SHARE / count)
  const characters = Math.max(item.label.length, item.lengthText.length)
  return (characters * LABEL_CHARACTER_PX + LABEL_PADDING_PX) / laneWidthPx
}

function fitShares(weights: readonly number[], minimums: readonly number[]): number[] {
  const minimumTotal = minimums.reduce((sum, value) => sum + value, 0)
  if (minimumTotal >= 1) return minimums.map((value) => value / minimumTotal)
  const pinned = weights.map(() => false)
  const shareOf = (index: number) => {
    const pinnedShare = minimums.reduce((sum, value, i) => sum + (pinned[i] ? value : 0), 0)
    const freeWeight = weights.reduce((sum, value, i) => sum + (pinned[i] ? 0 : value), 0)
    return freeWeight > 0 ? (weights[index]! / freeWeight) * (1 - pinnedShare) : 0
  }
  let changed = true
  while (changed) {
    changed = false
    for (let index = 0; index < weights.length; index += 1) {
      if (pinned[index] || shareOf(index) >= minimums[index]!) continue
      pinned[index] = true
      changed = true
    }
  }
  return weights.map((_, index) => (pinned[index] ? minimums[index]! : shareOf(index)))
}

/* Blocks in edit order, each wide enough for its label at the lane's width and
   the rest of the lane shared by length, so a 0.4 s replay still reads. */
export function buildAutoEditTimelineLayout(
  items: readonly AutoEditLaneItem[],
  laneWidthPx = 0,
): AutoEditTimelineBlock[] {
  const totalFrames = items.reduce((sum, item) => sum + item.outputFrames, 0)
  if (items.length === 0 || totalFrames <= 0) return []
  const shares = fitShares(
    items.map((item) => item.outputFrames / totalFrames),
    items.map((item) => minimumShare(item, laneWidthPx, items.length)),
  )
  let left = 0
  return items.map((item, index) => {
    const widthPercent = shares[index]! * 100
    const block = { index: item.index, leftPercent: left, widthPercent }
    left += widthPercent
    return block
  })
}

export function autoEditEditPercentAt(
  spans: readonly AutoEditTimedSpan[],
  blocks: readonly AutoEditTimelineBlock[],
  outputSeconds: number,
): number {
  if (spans.length === 0 || blocks.length === 0) return 0
  const found = spans.findIndex((span) => outputSeconds < span.outputEndSeconds)
  const position = found < 0 ? spans.length - 1 : found
  const span = spans[position]!
  const block = blocks[position]!
  const progress = span.outputDurationSeconds > 0
    ? Math.min(1, Math.max(0, (outputSeconds - span.outputStartSeconds) / span.outputDurationSeconds))
    : 0
  return block.leftPercent + progress * block.widthPercent
}

export function autoEditSourcePercent(secondsValue: number, durationSeconds: number): number {
  if (durationSeconds <= 0) return 0
  return Math.min(100, Math.max(0, (secondsValue / durationSeconds) * 100))
}

export function autoEditConnectorClip(
  block: AutoEditTimelineBlock,
  item: Pick<AutoEditLaneItem, 'sourceStartSeconds' | 'sourceEndSeconds'>,
  durationSeconds: number,
): string {
  const topLeft = block.leftPercent
  const topRight = block.leftPercent + block.widthPercent
  const bottomLeft = autoEditSourcePercent(item.sourceStartSeconds, durationSeconds)
  const bottomRight = autoEditSourcePercent(item.sourceEndSeconds, durationSeconds)
  return `polygon(${topLeft.toFixed(3)}% 0, ${topRight.toFixed(3)}% 0, ${bottomRight.toFixed(3)}% 100%, ${bottomLeft.toFixed(3)}% 100%)`
}

export interface AutoEditTick {
  seconds: number
  percent: number
  label: string
}

function tickStep(durationSeconds: number): number {
  if (durationSeconds <= 12) return 1
  if (durationSeconds <= 30) return 5
  if (durationSeconds <= 90) return 10
  return 30
}

export function autoEditTicks(durationSeconds: number): AutoEditTick[] {
  if (durationSeconds <= 0) return []
  const step = tickStep(durationSeconds)
  const ticks: AutoEditTick[] = []
  for (let value = 0; value <= durationSeconds + 1e-6; value += step) {
    ticks.push({ seconds: value, percent: autoEditSourcePercent(value, durationSeconds), label: value === 0 ? '0 s' : String(value) })
  }
  return ticks
}

export function autoEditSoundLabel(sound: string): string {
  return sound.replace(/_/g, ' ')
}

function autoEditCueSummary(cues: readonly AutoEditCue[]): string {
  const counts = new Map<string, number>()
  for (const cue of cues) counts.set(cue.sound, (counts.get(cue.sound) ?? 0) + 1)
  return [...counts.entries()]
    .map(([sound, count]) => (count > 1 ? `${autoEditSoundLabel(sound)} ×${count}` : autoEditSoundLabel(sound)))
    .join(', ')
}

export interface AutoEditBeat {
  key: keyof AutoEditSections
  label: string
  detail: string
  amount: string
}

function speedText(speed: number): string {
  if (Math.abs(speed - 0.5) < 1e-6) return 'half speed'
  return `${speed}× speed`
}

export function autoEditBeats(
  anchors: AutoEditAnchors,
  sections: AutoEditSections,
  cues: readonly AutoEditCue[],
): AutoEditBeat[] {
  const hookStart = autoEditAnchorSeconds(anchors, 'hook.start')
  const hookEnd = autoEditAnchorSeconds(anchors, 'hook.end')
  const { start, peak, end } = anchors.moment
  const style = CRASH_REPLAY
  const effects = sections.replays || sections.pushIn || sections.crash
  const soundsDetail = !effects
    ? 'Nothing to cue without replays, push-in or crash'
    : cues.length > 0
      ? autoEditCueSummary(cues)
      : 'Cues land on the replays and the crash'
  return [
    {
      key: 'coldOpen',
      label: 'Cold open',
      detail: `Opens on the hook, ${seconds(hookStart)}–${seconds(hookEnd)} s`,
      amount: `+${seconds(hookEnd - hookStart)} s`,
    },
    {
      key: 'replays',
      label: 'Replays',
      detail: `${seconds(start)}–${seconds(peak)} s twice; the second punched in ${style.replayZoomScale}×`,
      amount: `+${seconds(2 * (peak - start))} s`,
    },
    {
      key: 'pushIn',
      label: 'Push-in',
      detail: `${seconds(start)}–${seconds(end)} s again, zooming to ${style.pushInZoomScale}× on the subject`,
      amount: `+${seconds(end - start)} s`,
    },
    {
      key: 'crash',
      label: 'Crash',
      detail: `${seconds(peak)}–${seconds(end)} s at ${speedText(style.crashSpeed)}, crash look, pitch drop`,
      amount: `+${seconds((end - peak) / style.crashSpeed)} s`,
    },
    {
      key: 'sounds',
      label: 'Sounds',
      detail: soundsDetail,
      amount: sections.sounds ? `${cues.length} ${cues.length === 1 ? 'cue' : 'cues'}` : '0 cues',
    },
  ]
}

function zoomFact(segment: PlanSegment): string | null {
  if (!segment.zoom) return null
  const from = segment.zoom.from.scale
  const to = segment.zoom.to.scale
  if (Math.abs(from - to) < 1e-3) return `held at ${to}×`
  return `zoom ${from}× → ${to}×`
}

function motionFact(segment: PlanSegment): string {
  if (segment.speed === 1) return 'normal speed'
  const smoothing = segment.motion === 'flow' ? ', in-between frames' : segment.motion === 'blend' ? ', blended frames' : ''
  return `${speedText(segment.speed)}${smoothing}`
}

function lookFact(segment: PlanSegment): string | null {
  if (segment.look === 'crash') return 'crash look'
  if (segment.look === 'invert') return 'inverted'
  if (segment.look === 'rgb_split') return 'RGB split'
  return null
}

function audioFact(segment: PlanSegment): string {
  if (segment.audio === 'pitch') return 'sound pitched down'
  if (segment.audio === 'mute') return 'muted'
  return 'source sound'
}

export function autoEditSegmentFacts(segment: PlanSegment): string {
  return [motionFact(segment), zoomFact(segment), lookFact(segment), audioFact(segment)]
    .filter((fact): fact is string => fact !== null)
    .join(' · ')
}
