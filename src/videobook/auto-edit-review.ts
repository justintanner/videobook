import { secondsToFrame, type PlanSegment, type SegmentSource } from '../../server/src/auto-edit/plan'
import {
  AUTO_EDIT_ANCHOR_LIMITS,
  CRASH_REPLAY,
  autoEditFrameLimits,
  type AutoEditAnchors,
  type AutoEditCue,
  type AutoEditSections,
} from '../../server/src/auto-edit/style'
import type { AutoEditSegmentRange } from './auto-edit-preview'

export type AutoEditAnchorKey =
  | 'keep.start'
  | 'keep.end'
  | 'hook.start'
  | 'hook.end'
  | 'moment.start'
  | 'moment.peak'
  | 'moment.end'
export type AutoEditFocusKey = 'start' | 'peak' | 'end'

export const AUTO_EDIT_KEEP_ANCHORS: readonly AutoEditAnchorKey[] = ['keep.start', 'keep.end']
export const AUTO_EDIT_HOOK_ANCHORS: readonly AutoEditAnchorKey[] = ['hook.start', 'hook.end']
export const AUTO_EDIT_MOMENT_ANCHORS: readonly AutoEditAnchorKey[] = ['moment.start', 'moment.peak', 'moment.end']
interface AutoEditAnchorInfo {
  label: string
  short: string
  focus: AutoEditFocusKey | null
}

export const AUTO_EDIT_ANCHOR_INFO: Readonly<Record<AutoEditAnchorKey, AutoEditAnchorInfo>> = {
  'keep.start': { label: 'Body start', short: 'start', focus: null },
  'keep.end': { label: 'Body end', short: 'end', focus: null },
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
  if (key === 'keep.start') return anchors.keep.start
  if (key === 'keep.end') return anchors.keep.end
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
  if (key === 'keep.start') {
    return { ...anchors, keep: { ...anchors.keep, start: Math.max(0, Math.min(anchors.moment.start, nextSeconds)) } }
  }
  if (key === 'keep.end') {
    return { ...anchors, keep: { ...anchors.keep, end: Math.min(durationSeconds, Math.max(anchors.moment.end, nextSeconds)) } }
  }
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
  if (key === 'keep.start') return 'The edit leaves out everything before it. It stays at or before the moment start, and a hook it passes moves inside.'
  if (key === 'keep.end') {
    return `The edit leaves out everything after it. It stays at or after the moment end, at least ${seconds(limits.minKeepSeconds)} s after Body start, and a hook it passes moves inside.`
  }
  if (key === 'hook.start' || key === 'hook.end') {
    return `The hook stays ${seconds(limits.minHookSeconds)}–${seconds(limits.maxHookSeconds)} s long.`
  }
  if (key === 'moment.start') return `Start sits ${startToPeak} before the peak.`
  if (key === 'moment.peak') return `Peak sits ${startToPeak} after the start and ${peakToEnd} before the end.`
  return `End sits ${peakToEnd} after the peak.`
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
  trim: { start: AutoEditAnchorKey; end: AutoEditAnchorKey } | null
  ranges: AutoEditSegmentRange[]
  sourceStartSeconds: number
  sourceEndSeconds: number
}

function trimEdges(role: PlanSegment['role'], ending: boolean, hasMomentEffects: boolean): AutoEditLaneItem['trim'] {
  switch (role) {
    case 'cold_open': return { start: 'hook.start', end: 'hook.end' }
    case 'replay': return { start: 'moment.start', end: 'moment.peak' }
    case 'push_in': return { start: 'moment.start', end: 'moment.end' }
    case 'crash': return { start: 'moment.peak', end: 'moment.end' }
    case 'body': return ending
      ? { start: 'moment.end', end: 'keep.end' }
      : { start: 'keep.start', end: hasMomentEffects ? 'moment.end' : 'keep.end' }
    case 'custom': return null
  }
}

function laneItemFrom(
  ranges: AutoEditSegmentRange[],
  anchors: AutoEditAnchors,
  afterBeats: boolean,
  hasMomentEffects: boolean,
): AutoEditLaneItem {
  const first = ranges[0]!
  const last = ranges[ranges.length - 1]!
  const body = first.segment.role === 'body'
  const ending = body && afterBeats
  const trim = trimEdges(first.segment.role, ending, hasMomentEffects)
  const cuts = ranges.length - 1
  const outputDurationSeconds = last.outputEndSeconds - first.outputStartSeconds
  const lengthText = cuts > 0
    ? `${outputDurationSeconds.toFixed(2)}s · ${cuts} ${cuts === 1 ? 'cut' : 'cuts'}`
    : autoEditSegmentLengthText(first)
  return {
    index: first.index,
    key: body ? (ending ? 'ending' : 'body') : first.segment.id,
    label: ending ? 'Ending' : first.label,
    trim,
    tone: autoEditSegmentTone(first),
    lengthText,
    ranges,
    outputFrames: ranges.reduce((sum, range) => sum + range.outputFrames, 0),
    outputStartSeconds: first.outputStartSeconds,
    outputEndSeconds: last.outputEndSeconds,
    outputDurationSeconds,
    sourceStartSeconds: trim ? autoEditAnchorSeconds(anchors, trim.start) : first.sourceStartSeconds,
    sourceEndSeconds: trim ? autoEditAnchorSeconds(anchors, trim.end) : last.sourceEndSeconds,
  }
}

export function buildAutoEditLaneItems(ranges: readonly AutoEditSegmentRange[], anchors: AutoEditAnchors): AutoEditLaneItem[] {
  const groups: Array<{ ranges: AutoEditSegmentRange[]; afterBeats: boolean; body: boolean }> = []
  let afterBeats = false
  for (const range of ranges) {
    const body = range.segment.role === 'body'
    if (!body && range.segment.role !== 'cold_open') afterBeats = true
    const last = groups[groups.length - 1]
    if (body && last?.body) {
      last.ranges.push(range)
      continue
    }
    groups.push({ ranges: [range], body, afterBeats })
  }
  return groups.map((group) => laneItemFrom(group.ranges, anchors, group.afterBeats, afterBeats))
}

export function autoEditItemsForAnchor(items: readonly AutoEditLaneItem[], key: AutoEditAnchorKey): AutoEditLaneItem[] {
  return items.filter((item) => item.trim?.start === key || item.trim?.end === key)
}

function autoEditTrimBounds(
  item: AutoEditLaneItem,
  key: AutoEditAnchorKey,
  anchors: AutoEditAnchors,
  source: Pick<SegmentSource, 'fps' | 'frames'>,
): { min: number; max: number } {
  const frame = (seconds: number) => secondsToFrame(seconds, source.fps)
  const { minBodyFrames, minKeepFrames, minLeadFrames, maxLeadFrames, minTailFrames, maxTailFrames, minHookFrames, maxHookFrames } = autoEditFrameLimits(source)
  const start = frame(anchors.moment.start)
  const peak = frame(anchors.moment.peak)
  const end = frame(anchors.moment.end)
  const keepStart = frame(anchors.keep.start)
  const keepEnd = frame(anchors.keep.end)
  const endingFrames = item.key === 'ending' ? minBodyFrames : 0
  const fixed = key === item.trim?.start ? item.trim.end : item.trim?.start
  let min = keepStart
  let max = keepEnd
  switch (key) {
    case 'keep.start':
      min = 0
      max = fixed === 'keep.end' ? keepEnd - minKeepFrames : Math.min(start, keepEnd - minKeepFrames)
      break
    case 'keep.end':
      min = fixed === 'keep.start' ? keepStart + minKeepFrames : Math.max(end + endingFrames, keepStart + minKeepFrames)
      max = source.frames
      break
    case 'hook.start': {
      const hookEnd = frame(autoEditAnchorSeconds(anchors, 'hook.end'))
      min = Math.max(keepStart, hookEnd - maxHookFrames, hookEnd > peak ? peak + 1 : 0)
      max = hookEnd - minHookFrames
      break
    }
    case 'hook.end': {
      const hookStart = frame(autoEditAnchorSeconds(anchors, 'hook.start'))
      min = hookStart + minHookFrames
      max = Math.min(hookStart + maxHookFrames, hookStart <= peak ? peak : keepEnd)
      break
    }
    case 'moment.start':
      min = Math.max(keepStart, fixed === 'moment.end' ? end - maxTailFrames - maxLeadFrames : peak - maxLeadFrames)
      max = fixed === 'moment.end' ? end - minTailFrames - minLeadFrames : peak - minLeadFrames
      break
    case 'moment.peak':
      min = fixed === 'moment.end' ? Math.max(keepStart + minLeadFrames, end - maxTailFrames) : start + minLeadFrames
      max = fixed === 'moment.end' ? end - minTailFrames : Math.min(keepEnd - minTailFrames, start + maxLeadFrames)
      break
    case 'moment.end':
      min = (fixed === 'moment.start' ? start : keepStart) + minLeadFrames + minTailFrames
      max = keepEnd - endingFrames
      if (fixed === 'moment.peak') {
        min = peak + minTailFrames
        max = Math.min(max, peak + maxTailFrames)
      } else if (fixed === 'moment.start') {
        max = Math.min(max, start + maxLeadFrames + maxTailFrames)
      }
      break
  }
  const current = frame(autoEditAnchorSeconds(anchors, key))
  return { min: Math.min(current, min) / source.fps, max: Math.max(current, max) / source.fps }
}

export interface AutoEditTrimEdge {
  side: 'start' | 'end'
  key: AutoEditAnchorKey
  seconds: number
  min: number
  max: number
  linked: string[]
}

export function autoEditTrimEdges(
  item: AutoEditLaneItem,
  items: readonly AutoEditLaneItem[],
  anchors: AutoEditAnchors,
  source: Pick<SegmentSource, 'fps' | 'frames'>,
): AutoEditTrimEdge[] {
  const trim = item.trim
  if (!trim) return []
  return (['start', 'end'] as const).map((side) => {
    const key = trim[side]
    return {
      side,
      key,
      seconds: autoEditAnchorSeconds(anchors, key),
      ...autoEditTrimBounds(item, key, anchors, source),
      linked: autoEditItemsForAnchor(items, key).filter((other) => other !== item).map((other) => other.label),
    }
  })
}

export function autoEditTrimClip(
  item: AutoEditLaneItem,
  edge: AutoEditTrimEdge,
  seconds: number,
  anchors: AutoEditAnchors,
  source: Pick<SegmentSource, 'fps' | 'frames'>,
): AutoEditAnchors {
  const frame = (value: number) => secondsToFrame(value, source.fps)
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  const time = clamp(frame(seconds), frame(edge.min), frame(edge.max)) / source.fps
  if (item.trim?.start === 'keep.start' && item.trim.end === 'keep.end') {
    return { ...anchors, keep: { ...anchors.keep, [edge.side]: time } }
  }
  const next = autoEditWithAnchor(anchors, edge.key, time, source.frames / source.fps)
  if (!item.trim || !edge.key.startsWith('moment.')) return next

  const { minLeadFrames, maxLeadFrames, minTailFrames, maxTailFrames } = autoEditFrameLimits(source)
  const keepStart = frame(next.keep.start)
  const keepEnd = frame(next.keep.end)
  const start = frame(next.moment.start)
  const end = frame(next.moment.end)
  const fixStart = item.trim.start === 'moment.start'
  const fixEnd = item.trim.end === 'moment.end' || item.trim.start === 'moment.end'
  const peak = clamp(
    frame(next.moment.peak),
    Math.max(keepStart + minLeadFrames, fixStart ? start + minLeadFrames : 0, fixEnd ? end - maxTailFrames : 0),
    Math.min(keepEnd - minTailFrames, fixStart ? start + maxLeadFrames : keepEnd, fixEnd ? end - minTailFrames : keepEnd),
  )
  return {
    ...next,
    moment: {
      start: clamp(start, Math.max(keepStart, peak - maxLeadFrames), peak - minLeadFrames) / source.fps,
      peak: peak / source.fps,
      end: clamp(end, peak + minTailFrames, Math.min(keepEnd, peak + maxTailFrames)) / source.fps,
    },
  }
}

export function autoEditCutsInItem(item: AutoEditLaneItem, anchors: AutoEditAnchors): number[] {
  if (item.ranges[0]?.segment.role !== 'body') return []
  return anchors.cuts.flatMap((cut, index) => cut.start >= item.sourceStartSeconds && cut.end <= item.sourceEndSeconds ? [index] : [])
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
