import { createZoomPlan, zoomScaleAt, zoomSoundCues, type ZoomInput, type ZoomPlan, type ZoomSoundCue } from '../../server/src/zoom'

const FALLBACK_FPS = 30
const PLAY_MARGIN_SECONDS = 1

export type ZoomPreview =
  | { ok: true; plan: ZoomPlan; cues: ZoomSoundCue[] }
  | { ok: false; message: string }

type ZoomClip = { duration: number | null | undefined; fps: number | null | undefined }

function zoomEntry(values: Readonly<Record<string, unknown>>): ZoomInput | null {
  const entries = values.zooms
  const entry: unknown = Array.isArray(entries) ? entries[0] : undefined
  if (!entry || typeof entry !== 'object') return null
  return typeof (entry as ZoomInput).start_seconds === 'number' ? entry as ZoomInput : null
}

export function zoomPreview(values: Readonly<Record<string, unknown>>, clip: ZoomClip): ZoomPreview {
  const zoom = zoomEntry(values)
  if (!zoom) return { ok: false, message: 'Set a start time to preview the zoom.' }
  if (!clip.duration) return { ok: false, message: 'Loading the clip…' }
  try {
    const plan = createZoomPlan({ sourceDuration: clip.duration, sourceFps: clip.fps || FALLBACK_FPS, zooms: [zoom] })
    return { ok: true, plan, cues: zoomSoundCues(plan, [zoom]) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export function zoomPreviewStyle(plan: ZoomPlan, seconds: number): { transform: string; transformOrigin: string } {
  const zoom = plan.zooms[0]!
  return { transform: `scale(${zoomScaleAt(plan, seconds)})`, transformOrigin: `${zoom.focusX * 100}% ${zoom.focusY * 100}%` }
}

export function zoomPlayRange(plan: ZoomPlan): { from: number; to: number } {
  const zoom = plan.zooms[0]!
  return {
    from: Math.max(0, zoom.startSeconds - PLAY_MARGIN_SECONDS),
    to: Math.min(plan.sourceDuration, (zoom.endSeconds ?? plan.sourceDuration) + PLAY_MARGIN_SECONDS),
  }
}
