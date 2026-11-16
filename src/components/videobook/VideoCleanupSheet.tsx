import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { cleanupPixelBox, validateCleanupRegions, type CleanupRegion } from '../../../server/src/video-cleanup/model'
import type { VideoCleanupEditor } from '@/videobook/useVideoCleanup'
import { ConfirmSheet } from './confirm/ConfirmSheet'
import './VideoCleanupSheet.css'

type Point = { x: number; y: number }
type Drag = { start: Point; region: CleanupRegion; mode: 'draw' | 'move' | 'resize' }
const unit = (n: number) => Math.max(0, Math.min(1, n))

function blocker(editor: VideoCleanupEditor): string | null {
  const { read, regions, method, busy } = editor.state
  if (busy) return busy
  if (!read) return 'Load a video first.'
  if (method === 'lama' && !read.models.lama) return 'Download the local models or choose Fast fill.'
  try { validateCleanupRegions(regions, read.source.duration_seconds); return null } catch (error) {
    return error instanceof Error && error.name !== 'ZodError' ? error.message : 'Keep regions inside the picture, with an end time after the start.'
  }
}

function RegionFields({ region, disabled, duration, onChange }: { region: CleanupRegion; disabled: boolean; duration: number; onChange: (patch: Partial<CleanupRegion>) => void }) {
  return <div className="cleanup-fields">
    {(['x', 'y', 'width', 'height'] as const).map((name) => <label key={name}>{name === 'x' ? 'Left' : name === 'y' ? 'Top' : name === 'width' ? 'Width' : 'Height'} (%)
      <input type="number" min={0} max={100} step={0.1} value={Number((region[name] * 100).toFixed(2))} disabled={disabled}
        onChange={(event) => onChange({ [name]: Number(event.target.value) / 100 })} />
    </label>)}
    <label>From (s)<input type="number" min={0} max={duration} step={0.05} value={Number(region.start.toFixed(3))} disabled={disabled} onChange={(event) => onChange({ start: Number(event.target.value) })} /></label>
    <label>Until (s)<input type="number" min={0} max={duration} step={0.05} value={Number(region.end.toFixed(3))} disabled={disabled} onChange={(event) => onChange({ end: Number(event.target.value) })} /></label>
  </div>
}

type CleanupSource = { width: number; height: number; fps: number; duration_seconds: number }

export function CleanupRegionEditor({ source, mediaUrl, regions, disabled, onChange, controls }: {
  source: CleanupSource | null
  mediaUrl: string | null
  regions: CleanupRegion[]
  disabled: boolean
  onChange: (regions: CleanupRegion[]) => void
  controls?: ReactNode
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const drag = useRef<Drag | null>(null)
  const region = regions.find((r) => r.id === selected) ?? regions[0]
  const duration = source?.duration_seconds ?? 0
  const seek = (at: number) => { if (video.current) video.current.currentTime = at; setTime(at) }
  const choose = (r: CleanupRegion) => { setSelected(r.id); video.current?.pause(); seek(r.start) }
  const replace = (next: CleanupRegion) => onChange(regions.some((r) => r.id === next.id) ? regions.map((r) => r.id === next.id ? next : r) : [...regions, next])
  const point = (event: PointerEvent<SVGSVGElement>): Point => {
    const box = event.currentTarget.getBoundingClientRect()
    return { x: unit((event.clientX - box.left) / box.width), y: unit((event.clientY - box.top) / box.height) }
  }
  const pointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (disabled || !duration || event.button !== 0) return
    const start = point(event)
    const element = event.target instanceof Element ? event.target.closest('[data-region]') : null
    const found = regions.find((r) => r.id === element?.getAttribute('data-region'))
    if (!found && regions.length >= 80) return
    video.current?.pause()
    const next = found ?? { id: crypto.randomUUID(), ...start, width: 0.001, height: 0.001, start: 0, end: duration }
    drag.current = { start, region: next, mode: found ? element?.getAttribute('data-resize') ? 'resize' : 'move' : 'draw' }
    setSelected(next.id)
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const pointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const current = drag.current
    if (!current) return
    const at = point(event), original = current.region
    if (current.mode === 'draw') replace({ ...original, x: Math.min(at.x, current.start.x), y: Math.min(at.y, current.start.y), width: Math.max(0.001, Math.abs(at.x - current.start.x)), height: Math.max(0.001, Math.abs(at.y - current.start.y)) })
    else if (current.mode === 'resize') replace({ ...original, width: Math.max(0.001, at.x - original.x), height: Math.max(0.001, at.y - original.y) })
    else replace({ ...original, x: Math.max(0, Math.min(1 - original.width, original.x + at.x - current.start.x)), y: Math.max(0, Math.min(1 - original.height, original.y + at.y - current.start.y)) })
  }
  const finishDrag = (event: PointerEvent<SVGSVGElement>) => {
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return <div className="video-cleanup-body">
    <div className="cleanup-preview">
      <div className="cleanup-stage" style={{ aspectRatio: source ? `${source.width}/${source.height}` : '16/9', '--cleanup-ratio': source ? source.width / source.height : 16 / 9 } as CSSProperties}>
        <video ref={video} src={mediaUrl ?? undefined} playsInline preload="metadata"
          onTimeUpdate={() => setTime(video.current?.currentTime ?? 0)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
        <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="Draw removal regions" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={finishDrag} onPointerCancel={finishDrag}>
          {regions.map((r, index) => time >= r.start && time < r.end && <g key={r.id} data-region={r.id} data-selected={r.id === region?.id}>
            <rect x={r.x * 1000} y={r.y * 1000} width={r.width * 1000} height={r.height * 1000} />
            <text x={r.x * 1000 + 6} y={r.y * 1000 + 28}>{index + 1}</text>
            {r.id === region?.id && <rect className="cleanup-handle" data-region={r.id} data-resize="true" x={(r.x + r.width) * 1000 - 15} y={(r.y + r.height) * 1000 - 15} width={30} height={30} />}
          </g>)}
        </svg>
      </div>
      <div className="cleanup-transport">
        <button type="button" disabled={!source} onClick={() => { if (video.current?.paused) void video.current.play().catch(() => {}); else video.current?.pause() }}>{playing ? 'Pause' : 'Play'}</button>
        <input aria-label="Playback position" type="range" min={0} max={duration || 1} step={source ? 1 / source.fps : 0.01} value={Math.min(time, duration)} onChange={(event) => seek(Number(event.target.value))} />
        <output>{time.toFixed(2)} / {duration.toFixed(2)}s</output>
      </div>
      <p>Drag to draw a region. Drag a box to move it or its corner to resize. Review the whole clip before removing.</p>
    </div>
    <div className="cleanup-controls">
      {controls}
      <div className="cleanup-toolbar">
        <button type="button" disabled={disabled || !source || regions.length >= 80} onClick={() => {
          const next = { id: crypto.randomUUID(), x: 0.25, y: 0.4, width: 0.5, height: 0.15, start: 0, end: duration }
          replace(next); choose(next)
        }}>Add region</button>
      </div>
      <div className="cleanup-regions" aria-label="Removal regions">
        {regions.map((r, index) => <button key={r.id} type="button" aria-pressed={r.id === region?.id} disabled={disabled} onClick={() => choose(r)}>Region {index + 1} <span>{r.start.toFixed(2)}–{r.end.toFixed(2)}s</span></button>)}
      </div>
      {region && <section aria-label="Selected removal region">
        <RegionFields region={region} disabled={disabled} duration={duration} onChange={(patch) => replace({ ...region, ...patch })} />
        <div className="cleanup-toolbar">
          <button type="button" disabled={disabled} onClick={() => replace({ ...region, start: time })}>Start at playhead</button>
          <button type="button" disabled={disabled} onClick={() => replace({ ...region, end: time })}>End at playhead</button>
          <button type="button" disabled={disabled} onClick={() => onChange(regions.filter((r) => r.id !== region.id))}>Delete region</button>
        </div>
        {source && <small>{cleanupPixelBox(region, source.width, source.height).width} × {cleanupPixelBox(region, source.width, source.height).height} pixels</small>}
      </section>}
    </div>
  </div>
}

function CleanupBody({ editor }: { editor: VideoCleanupEditor }) {
  const { read, target, regions, busy, error, method, jobId } = editor.state
  const disabled = Boolean(busy)
  return <CleanupRegionEditor source={read?.source ?? null} mediaUrl={target?.mediaUrl ?? null} regions={regions} disabled={disabled} onChange={editor.setRegions} controls={<>
    <div className="cleanup-toolbar">
      <button type="button" disabled={disabled || !read?.models.detector} onClick={editor.detect}>{regions.length ? 'Replace regions with detection' : 'Detect text'}</button>
      {jobId && <button type="button" onClick={() => void editor.cancel()}>Stop</button>}
    </div>
    {read && (!read.models.detector || !read.models.lama) && <div className="cleanup-models">
      <p>Download local models once ({Math.ceil(read.models.download_bytes / 1_000_000)} MB). Your video stays on this computer.</p>
      <button type="button" disabled={disabled} onClick={() => void editor.install()}>Download models</button>
    </div>}
    <label className="cleanup-method">Removal method<select value={method} disabled={disabled} onChange={event => editor.setMethod(event.target.value === 'fill' ? 'fill' : 'lama')}>
      <option value="lama">Local AI · LaMa</option><option value="fill">Fast fill · simple backgrounds</option>
    </select></label>
    <p>{method === 'lama' ? 'AI fills each frame. Moving or detailed backgrounds can flicker; large covered objects cannot be recovered exactly.' : 'Fills from surrounding pixels. Best for small overlays on plain backgrounds.'}</p>
    {read && <p>Text sampled every {read.interval.toFixed(2)}s. Short titles may be missed. Keep scene text you want; add non-text graphics manually.</p>}
    {busy && <p role="status">{busy}</p>}
    {error && <p role="alert">{error}</p>}
    {error && read?.models.detector && read.models.lama && <button type="button" disabled={disabled} onClick={() => void editor.install()}>Repair local models</button>}
  </>} />
}

export function VideoCleanupSheet({ editor, applyFormId, onClose }: { editor: VideoCleanupEditor; applyFormId: string; onClose: () => void }) {
  return <ConfirmSheet kind="video-cleanup" ariaLabel="Video graphics remover" tag="REMOVE GRAPHICS"
    title={`Remove graphics · ${editor.state.target?.label ?? 'video'}`} address={editor.state.target?.address ? `@${editor.state.target.address}` : null}
    applyLabel="Remove into copy" cancelLabel="Close" busy={Boolean(editor.state.busy)} busyLabel={editor.state.busy ?? undefined}
    effect={{ label: 'Cleaned copy · original kept', tone: 'default' }} validation={{ blocking: blocker(editor), notice: null }} applyFormId={applyFormId} onCancel={onClose}>
    <CleanupBody key={editor.state.target?.artifactId} editor={editor} />
  </ConfirmSheet>
}
