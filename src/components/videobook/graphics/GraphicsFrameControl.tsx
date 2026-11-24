import { useRef, type PointerEvent } from 'react'
import type { GraphicsFraming } from '../../../../server/src/graphics/frame'
import { graphicsFocusPoint } from '@/videobook/graphics-pointer'

const ASPECTS: readonly GraphicsFraming['aspect'][] = ['original', '9:16', '1:1', '4:5', '16:9']
const FITS: readonly GraphicsFraming['fit'][] = ['crop', 'blur']
const FIT_LABELS: Record<GraphicsFraming['fit'], string> = { crop: 'Crop', blur: 'Blur' }

function Segments<T extends string>({ label, value, options, labels, onChange }: {
  label: string
  value: T
  options: readonly T[]
  labels: (option: T) => string
  onChange: (value: T) => void
}) {
  return (
    <div className="graphics-frame-segments" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option} type="button" aria-pressed={option === value} onClick={() => onChange(option)}>{labels(option)}</button>
      ))}
    </div>
  )
}

export function GraphicsFrameControl({ frame, source, mediaUrl, disabled, subtitleAspect, onChange }: {
  frame: GraphicsFraming
  source: { width: number; height: number }
  mediaUrl: string
  disabled: boolean
  subtitleAspect?: string
  onChange: (frame: GraphicsFraming, coalesce?: string | null) => void
}) {
  const drag = useRef(0)
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const focus = graphicsFocusPoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect())
    onChange({ ...frame, focus }, `frame-focus:${drag.current}`)
  }
  return (
    <fieldset className="graphics-frame-control" disabled={disabled}>
      <legend className="graphics-section-label">Frame</legend>
      {subtitleAspect && <p className="graphics-muted">Using the subtitle draft’s {subtitleAspect} frame and background. Turn off “With subtitles” to choose another frame.</p>}
      <Segments label="Frame aspect" value={frame.aspect} options={ASPECTS} labels={(aspect) => (aspect === 'original' ? 'Original' : aspect)} onChange={(aspect) => onChange({ ...frame, aspect })} />
      {frame.aspect !== 'original' && <Segments label="Frame fit" value={frame.fit} options={FITS} labels={(fit) => FIT_LABELS[fit]} onChange={(fit) => onChange({ ...frame, fit })} />}
      {frame.aspect !== 'original' && frame.fit === 'crop' && <>
        <p className="graphics-muted">Drag the focus point to choose what stays in the frame.</p>
        <div className="graphics-focus-map" role="group" aria-label="Crop focus point" style={{ aspectRatio: `${source.width}/${source.height}`, position: 'relative', maxWidth: 240, overflow: 'hidden', touchAction: 'none' }}
          onPointerDown={(event) => { if (disabled) return; drag.current += 1; event.currentTarget.setPointerCapture(event.pointerId); move(event) }}
          onPointerMove={move}
          onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}>
          <video src={mediaUrl} muted preload="metadata" style={{ width: '100%', display: 'block', pointerEvents: 'none' }} />
          <span aria-hidden="true" style={{ position: 'absolute', left: `${frame.focus.x * 100}%`, top: `${frame.focus.y * 100}%`, transform: 'translate(-50%, -50%)', color: 'white', textShadow: '0 0 3px black', fontSize: 24 }}>⊕</span>
        </div>
        <label>Horizontal focus <input aria-label="Horizontal crop focus" type="range" min={0} max={1} step={0.01} value={frame.focus.x} onChange={(event) => onChange({ ...frame, focus: { ...frame.focus, x: Number(event.target.value) } })} /></label>
        <label>Vertical focus <input aria-label="Vertical crop focus" type="range" min={0} max={1} step={0.01} value={frame.focus.y} onChange={(event) => onChange({ ...frame, focus: { ...frame.focus, y: Number(event.target.value) } })} /></label>
      </>}
    </fieldset>
  )
}
