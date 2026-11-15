import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { ZoomPlan, ZoomSoundCue } from '../../../server/src/zoom'
import { builtinSoundUrl } from '@/videobook/builtin-sound-preview'
import { graphicsFocusPoint } from '@/videobook/graphics-pointer'
import type { useVoicePreviewPlayer } from '@/videobook/voice-preview-player'
import type { WorkspaceActionContext } from '@/videobook/workspace-actions'
import { zoomPlayRange, zoomPreview, zoomPreviewStyle } from '@/videobook/zoom-preview'

type Media = NonNullable<WorkspaceActionContext['media']>[string]
type SoundPreview = ReturnType<typeof useVoicePreviewPlayer>
type Playback = { to: number; cues: Array<ZoomSoundCue & { id: string; fired: boolean }> }

const FOCUS_X = 'zooms.focus_x'
const FOCUS_Y = 'zooms.focus_y'
const CUE_LEAD_SECONDS = 0.05

function fraction(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5
}

function rounded(value: number): number {
  return Number(value.toFixed(3))
}

function eachFrame(video: HTMLVideoElement, callback: (seconds: number) => void): () => void {
  let cancelled = false
  let handle = 0
  const frame = typeof video.requestVideoFrameCallback === 'function'
  const arm = () => {
    if (cancelled) return
    if (frame) handle = video.requestVideoFrameCallback((_now, metadata) => { callback(metadata.mediaTime); arm() })
    else handle = requestAnimationFrame(() => { callback(video.currentTime); arm() })
  }
  callback(video.currentTime)
  arm()
  return () => {
    cancelled = true
    if (frame) video.cancelVideoFrameCallback(handle)
    else cancelAnimationFrame(handle)
  }
}

export function WorkspaceZoomPreview({ media, values, disabled, sounds, onChange }: {
  media: Media
  values: Record<string, unknown>
  disabled: boolean
  sounds: SoundPreview
  onChange: (patch: Record<string, unknown>) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const timeRef = useRef<HTMLInputElement>(null)
  const playback = useRef<Playback | null>(null)
  const [dragging, setDragging] = useState(false)
  const [loadedDuration, setLoadedDuration] = useState<number | null>(null)
  const duration = media.duration ?? loadedDuration
  const preview = zoomPreview(values, { duration, fps: media.fps })
  const focusX = fraction(values[FOCUS_X])
  const focusY = fraction(values[FOCUS_Y])
  const animationKey = preview.ok && !dragging ? JSON.stringify(preview.plan) : ''
  const play = sounds.toggle

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const plan = animationKey ? JSON.parse(animationKey) as ZoomPlan : null
    return eachFrame(video, (seconds) => {
      const style = plan ? zoomPreviewStyle(plan, seconds) : { transform: '', transformOrigin: '' }
      video.style.transform = style.transform
      video.style.transformOrigin = style.transformOrigin
      if (timeRef.current) timeRef.current.value = String(seconds)
      const run = playback.current
      if (!run) return
      for (const cue of run.cues) {
        if (cue.fired || seconds < cue.startSeconds) continue
        cue.fired = true
        play(cue.id, builtinSoundUrl(cue.sound))
      }
      if (seconds >= run.to) {
        playback.current = null
        video.pause()
      }
    })
  }, [animationKey, play])

  const moveFocus = (event: PointerEvent<HTMLDivElement>) => {
    const point = graphicsFocusPoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect())
    onChange({ [FOCUS_X]: rounded(point.x), [FOCUS_Y]: rounded(point.y) })
  }

  const playZoom = () => {
    const video = videoRef.current
    if (!video || !preview.ok) return
    const { from, to } = zoomPlayRange(preview.plan)
    playback.current = {
      to,
      cues: preview.cues.map((cue, index) => ({ ...cue, id: `zoom-cue:${index}`, fired: cue.startSeconds < from - CUE_LEAD_SECONDS })),
    }
    video.currentTime = from
    void video.play().catch(() => { playback.current = null })
  }

  const setTime = (name: 'zooms.start_seconds' | 'zooms.end_seconds') => {
    const video = videoRef.current
    if (video) onChange({ [name]: rounded(video.currentTime) })
  }

  const seek = (seconds: number) => {
    const video = videoRef.current
    if (!video) return
    playback.current = null
    video.pause()
    video.currentTime = seconds
  }

  if (!media.url) return <p>Preview unavailable for this media.</p>
  const ratio = media.width && media.height ? media.width / media.height : 16 / 9

  return <section className="workspace-zoom-preview" aria-label="Zoom preview">
    <div className="workspace-zoom-frame" role="group" aria-label="Zoom focus point"
      style={{ aspectRatio: ratio, width: `min(100%, calc(48vh * ${ratio}))` }}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
        moveFocus(event)
      }}
      onPointerMove={(event) => {
        if (!disabled && event.currentTarget.hasPointerCapture(event.pointerId)) moveFocus(event)
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        setDragging(false)
      }}
      onPointerCancel={() => setDragging(false)}>
      <video ref={videoRef} src={media.url} muted playsInline preload="metadata"
        onLoadedMetadata={(event) => setLoadedDuration(event.currentTarget.duration)} />
      <span className="workspace-zoom-focus" aria-hidden="true" style={{ left: `${focusX * 100}%`, top: `${focusY * 100}%` }} />
    </div>
    {!preview.ok && <p className="workspace-zoom-message" role="status">{preview.message}</p>}
    {duration && <label className="workspace-zoom-slider">Preview time
      <input ref={timeRef} type="range" min={0} max={duration} step={0.01} defaultValue={0} disabled={disabled} aria-label="Preview time"
        onChange={(event) => seek(Number(event.target.value))} />
    </label>}
    <div className="workspace-zoom-controls">
      <button type="button" disabled={disabled || !preview.ok} onClick={playZoom}>Play zoom</button>
      <button type="button" disabled={disabled} onClick={() => setTime('zooms.start_seconds')}>Set start</button>
      <button type="button" disabled={disabled} onClick={() => setTime('zooms.end_seconds')}>Set end</button>
    </div>
    <label className="workspace-zoom-slider">Horizontal zoom focus
      <input type="range" min={0} max={1} step={0.01} value={focusX} disabled={disabled} aria-label="Horizontal zoom focus"
        onChange={(event) => onChange({ [FOCUS_X]: Number(event.target.value) })} />
    </label>
    <label className="workspace-zoom-slider">Vertical zoom focus
      <input type="range" min={0} max={1} step={0.01} value={focusY} disabled={disabled} aria-label="Vertical zoom focus"
        onChange={(event) => onChange({ [FOCUS_Y]: Number(event.target.value) })} />
    </label>
    <p>Drag on the picture to choose the point to zoom toward. Play zoom plays from a second before the zoom to a second after it.</p>
  </section>
}
