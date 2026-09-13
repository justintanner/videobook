import { useRef } from 'react'
import type { WorkspaceActionContext } from '@/videobook/workspace-actions'
import { workspaceCropPreset } from '@/videobook/workspace-actions'

type Media = NonNullable<WorkspaceActionContext['media']>[string]

export function WorkspaceCropPreview({ media, values, disabled, onChange }: {
  media: Media
  values: Record<string, unknown>
  disabled: boolean
  onChange: (patch: Record<string, unknown>) => void
}) {
  const drag = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null)
  const sourceRatio = media.width && media.height ? media.width / media.height : 16 / 9
  const x = typeof values.x === 'number' ? values.x : 0
  const y = typeof values.y === 'number' ? values.y : 0
  const w = typeof values.w === 'number' ? values.w : 1
  const h = typeof values.h === 'number' ? values.h : 1
  const frameStyle = { aspectRatio: sourceRatio }
  const cropStyle = { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }
  const preset = (ratio: string) => {
    if (!disabled) onChange(workspaceCropPreset(ratio, media.width, media.height))
  }
  if (!media.url) return <p>Preview unavailable for this media.</p>

  return <section className="workspace-crop-preview" aria-label="Crop preview">
    <div className="workspace-crop-ratios" role="group" aria-label="Crop aspect ratio">
      <button type="button" disabled={disabled} aria-pressed={values.ratio === '16:9'} onClick={() => preset('16:9')}>Landscape 16:9</button>
      <button type="button" disabled={disabled} aria-pressed={values.ratio === '9:16'} onClick={() => preset('9:16')}>Portrait 9:16</button>
      <button type="button" disabled={disabled} aria-pressed={values.ratio === '1:1'} onClick={() => preset('1:1')}>Square 1:1</button>
    </div>
    <div className="workspace-crop-frame" style={frameStyle}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: x, originY: y }
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (disabled || !current || event.pointerId !== current.pointerId) return
        const bounds = event.currentTarget.getBoundingClientRect()
        onChange({ x: Math.max(0, Math.min(1 - w, current.originX + (event.clientX - current.x) / bounds.width)), y: Math.max(0, Math.min(1 - h, current.originY + (event.clientY - current.y) / bounds.height)) })
      }}
      onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
      {media.type === 'image' ? <img src={media.url} alt="Source crop preview" draggable={false} /> : <video src={media.url} muted playsInline preload="metadata" />}
      <div className="workspace-crop-region" style={cropStyle} />
    </div>
    <p>Choose an aspect ratio, then drag the crop to position it. The numeric fields below also control its position and size.</p>
  </section>
}
