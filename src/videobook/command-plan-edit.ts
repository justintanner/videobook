import type { EditPreview } from 'videobook-engine'
import type { CommandPlan, EditCommandStage } from './command-plan'

export function editPreviewError(preview: EditPreview): string | null {
  if (preview.valid) return null
  const conflicts = preview.conflicts.map((conflict) => conflict.message)
  return conflicts.join(' · ') || 'The canonical edit preview is invalid'
}

export function requestFromEditStage(
  stages: CommandPlan['stages'],
): Record<string, unknown> | Record<string, unknown>[] {
  const stage = stages.find(
    (candidate): candidate is EditCommandStage => candidate.kind === 'edit',
  )
  const requests = stage?.intent.operations.map((operation) => {
    if (operation.kind === 'insert-clip') {
      return {
        kind: 'insert',
        mode: operation.mode,
        artifact_id: operation.placement.source.artifactId,
        track_id: operation.placement.trackId,
        timeline_start_frame: operation.placement.timelineStartFrame,
        duration_frames: operation.placement.durationFrames,
        ...(operation.placement.source.kind === 'timed'
          ? {
              source_start_tick: operation.placement.source.range.startTick,
              source_duration_ticks: operation.placement.source.range.durationTicks,
            }
          : {}),
      }
    }
    if (operation.kind === 'trim-clip') {
      return {
        kind: 'trim',
        clip_id: operation.clipId,
        timeline_start_frame: operation.timelineStartFrame,
        duration_frames: operation.durationFrames,
      }
    }
    if (operation.kind === 'set-clip-audio') {
      return {
        kind: 'volume',
        clip_id: operation.clipId,
        gain_db: operation.audio.gainDb,
        muted: operation.audio.muted,
        fade_in_frames: operation.audio.fadeInFrames,
        fade_out_frames: operation.audio.fadeOutFrames,
      }
    }
    if (operation.kind === 'move-clip') {
      return {
        kind: 'move',
        clip_id: operation.clipId,
        track_id: operation.trackId,
        timeline_start_frame: operation.timelineStartFrame,
      }
    }
    if (operation.kind === 'split-clip') {
      return {
        kind: 'split',
        clip_id: operation.clipId,
        split_frame: operation.splitFrame,
      }
    }
    if (operation.kind === 'set-clip-transform') {
      return {
        kind: 'transform',
        clip_id: operation.clipId,
        fit: operation.transform.fit,
        position_x: operation.transform.positionX,
        position_y: operation.transform.positionY,
        scale_x: operation.transform.scaleX,
        scale_y: operation.transform.scaleY,
        rotation_degrees: operation.transform.rotationDegrees,
        opacity: operation.transform.opacity,
        crop_top: operation.transform.cropTop,
        crop_right: operation.transform.cropRight,
        crop_bottom: operation.transform.cropBottom,
        crop_left: operation.transform.cropLeft,
      }
    }
    if (operation.kind === 'set-clip-speed') {
      return {
        kind: 'speed',
        clip_id: operation.clipId,
        numerator: operation.speed.numerator,
        denominator: operation.speed.denominator,
        reverse: operation.reverse,
        audio_policy: operation.audioPolicy,
      }
    }
    if (operation.kind === 'set-transition') {
      return {
        kind: 'transition',
        outgoing_clip_id: operation.outgoingClipId,
        incoming_clip_id: operation.incomingClipId,
        transition_kind: operation.transition?.kind ?? null,
        ...(operation.transition
          ? {
              duration_frames: operation.transition.durationFrames,
              alignment: operation.transition.alignment,
            }
          : {}),
      }
    }
    if (operation.kind === 'upsert-caption-cue') {
      return {
        kind: 'caption',
        cue_id: operation.cue.cueId,
        track_id: operation.cue.trackId,
        timeline_start_frame: operation.cue.timelineStartFrame,
        duration_frames: operation.cue.durationFrames,
        text: operation.cue.text,
        style_id: operation.cue.styleId,
        ...(operation.cue.speaker ? { speaker: operation.cue.speaker } : {}),
      }
    }
    throw new Error(`The edit cannot be replanned: ${operation.kind}`)
  }) ?? []
  if (requests.length === 0) throw new Error('The plan has no editable operation')
  return requests.length === 1 ? requests[0] : requests
}

