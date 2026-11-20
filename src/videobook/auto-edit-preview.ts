import type { SegmentLook } from '../../server/src/auto-edit/looks'
import {
  frameToSeconds,
  planOutputFrames,
  secondsToFrame,
  segmentOutputFrames,
  segmentOutputStartFrames,
  segmentZoomAt,
  type PlanSegment,
  type SegmentPlan,
  type SegmentZoomPoint,
} from '../../server/src/auto-edit/plan'
import type { AutoEditCue } from '../../server/src/auto-edit/style'

export interface AutoEditScheduleSample {
  segmentIndex: number
  segmentId: string
  segmentRole: PlanSegment['role']
  segmentLabel: string
  outputTime: number
  segmentElapsedSeconds: number
  segmentDurationSeconds: number
  sourceTime: number
  playbackRate: number
  zoom: SegmentZoomPoint
  look: SegmentLook
  lookHueTurns: number
  audio: PlanSegment['audio']
}

export interface AutoEditSegmentRange {
  index: number
  segment: PlanSegment
  label: string
  outputStartFrame: number
  outputEndFrame: number
  outputFrames: number
  outputStartSeconds: number
  outputEndSeconds: number
  outputDurationSeconds: number
  sourceStartSeconds: number
  sourceEndSeconds: number
  widthPercent: number
}

export function autoEditSegmentLabel(segment: Pick<PlanSegment, 'role' | 'zoom'>): string {
  if (segment.role === 'cold_open') return 'Cold open'
  if (segment.role === 'body') return 'Body'
  if (segment.role === 'replay') {
    const scale = segment.zoom ? Math.max(segment.zoom.from.scale, segment.zoom.to.scale) : 1
    return scale > 1.001 ? 'Punch-in' : 'Replay'
  }
  if (segment.role === 'push_in') return 'Push-in'
  if (segment.role === 'crash') return 'Crash'
  return 'Segment'
}

export function autoEditPlanDurationSeconds(plan: Pick<SegmentPlan, 'segments' | 'source'>): number {
  return planOutputFrames(plan) / plan.source.fps
}

export function buildAutoEditSegmentRanges(plan: Pick<SegmentPlan, 'segments' | 'source'>): AutoEditSegmentRange[] {
  const fps = plan.source.fps
  const startFrames = segmentOutputStartFrames(plan)
  const totalFrames = planOutputFrames(plan)
  return plan.segments.map((segment, index) => {
    const outputStartFrame = startFrames[index] ?? 0
    const outputFrames = segmentOutputFrames(segment)
    const outputEndFrame = outputStartFrame + outputFrames
    const outputStartSeconds = frameToSeconds(outputStartFrame, fps)
    const outputEndSeconds = frameToSeconds(outputEndFrame, fps)
    return {
      index,
      segment,
      label: autoEditSegmentLabel(segment),
      outputStartFrame,
      outputEndFrame,
      outputFrames,
      outputStartSeconds,
      outputEndSeconds,
      outputDurationSeconds: outputEndSeconds - outputStartSeconds,
      sourceStartSeconds: frameToSeconds(segment.startFrame, fps),
      sourceEndSeconds: frameToSeconds(segment.endFrame, fps),
      widthPercent: totalFrames > 0 ? (outputFrames / totalFrames) * 100 : 0,
    }
  })
}

export function autoEditScheduleAt(plan: SegmentPlan, outputTimeSeconds: number): AutoEditScheduleSample | null {
  const ranges = buildAutoEditSegmentRanges(plan)
  if (ranges.length === 0) return null
  const fps = plan.source.fps
  const totalDuration = autoEditPlanDurationSeconds(plan)
  const outputTime = Math.min(totalDuration, Math.max(0, Number.isFinite(outputTimeSeconds) ? outputTimeSeconds : 0))
  const range = ranges.find((entry) => outputTime < entry.outputEndSeconds) ?? ranges[ranges.length - 1]!
  const segmentElapsedSeconds = Math.max(0, Math.min(range.outputDurationSeconds, outputTime - range.outputStartSeconds))
  const localOutputFrame = Math.min(Math.max(0, range.outputFrames - 1), segmentElapsedSeconds * fps)
  const sourceTime = Math.min(
    range.sourceEndSeconds,
    Math.max(range.sourceStartSeconds, range.sourceStartSeconds + segmentElapsedSeconds * range.segment.speed),
  )
  const zoom = segmentZoomAt(range.segment, localOutputFrame)
  const look = range.segment.look ?? 'none'
  const lookHueTurns = look === 'crash' ? 0.15 + 0.9 * segmentElapsedSeconds : 0
  return {
    segmentIndex: range.index,
    segmentId: range.segment.id,
    segmentRole: range.segment.role,
    segmentLabel: range.label,
    outputTime,
    segmentElapsedSeconds,
    segmentDurationSeconds: range.outputDurationSeconds,
    sourceTime,
    playbackRate: range.segment.speed,
    zoom,
    look,
    lookHueTurns,
    audio: range.segment.audio,
  }
}

export function autoEditLookFilter(
  look: SegmentLook,
  lookHueTurns: number,
  ids: { crash: string; rgbSplit: string },
): string {
  if (look === 'invert') return 'invert(1)'
  if (look === 'rgb_split') return `url(#${ids.rgbSplit})`
  if (look === 'crash') return `url(#${ids.crash}) hue-rotate(${(lookHueTurns * 360).toFixed(1)}deg)`
  return 'none'
}

export function autoEditZoomStyle(zoom: SegmentZoomPoint): { transform: string; transformOrigin: string } {
  const transformOrigin = `${(zoom.x * 100).toFixed(2)}% ${(zoom.y * 100).toFixed(2)}%`
  const transform = Math.abs(zoom.scale - 1) < 0.001 ? 'none' : `scale(${zoom.scale.toFixed(4)})`
  return { transform, transformOrigin }
}

export function autoEditInvertZoomPoint(
  screenPoint: { x: number; y: number },
  zoom: SegmentZoomPoint,
): { x: number; y: number } {
  const scale = zoom.scale > 1 ? zoom.scale : 1
  const clamp = (value: number) => Number(Math.max(0, Math.min(1, value)).toFixed(4))
  return {
    x: clamp(zoom.x + (screenPoint.x - zoom.x) / scale),
    y: clamp(zoom.y + (screenPoint.y - zoom.y) / scale),
  }
}

export function autoEditCuesBetween(
  cues: readonly AutoEditCue[],
  fromOutputSeconds: number,
  toOutputSeconds: number,
  leadSeconds = 0.03,
): Array<{ index: number; cue: AutoEditCue }> {
  const matched: Array<{ index: number; cue: AutoEditCue }> = []
  cues.forEach((cue, index) => {
    if (cue.startSeconds >= fromOutputSeconds - leadSeconds && cue.startSeconds <= toOutputSeconds + 1e-6) {
      matched.push({ index, cue })
    }
  })
  return matched
}

export function autoEditSnapSeconds(seconds: number, fps: number, durationSeconds: number): number {
  const maxFrames = Math.max(0, secondsToFrame(durationSeconds, fps))
  const frame = Math.max(0, Math.min(maxFrames, secondsToFrame(seconds, fps)))
  return frameToSeconds(frame, fps)
}

export function autoEditNudgeSeconds(
  currentSeconds: number,
  deltaFrames: number,
  fps: number,
  durationSeconds: number,
): number {
  const maxFrames = Math.max(0, secondsToFrame(durationSeconds, fps))
  const nextFrame = Math.max(0, Math.min(maxFrames, secondsToFrame(currentSeconds, fps) + deltaFrames))
  return frameToSeconds(nextFrame, fps)
}
