import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Film, Plus, Trash2, X } from 'lucide-react'
import type { Sequence, SequenceClip, SequenceTrack } from 'videobook-engine'
import { notebookGrid } from '@/videobook/notebook-grid'
import { handleModalDialogKeyDown } from '@/videobook/modal-dialog-interactions'
import { restoreFocusElement } from '@/videobook/command-composer-focus'
import type { TimelineAsset, useTimelineAssembly } from '@/videobook/useTimelineAssembly'
import { clipWaveform, nearestBeat } from '../../../server/src/rhythm/timing'
import type { MusicAnalysis } from '../../../server/src/rhythm/model'
import { waveformEnvelopePath } from '@/videobook/waveform-path'
import './NotebookTimeline.css'

export interface NotebookTimelineProps {
  sequence: Sequence | null
  assets: readonly TimelineAsset[]
  assembly: ReturnType<typeof useTimelineAssembly>
  disabled: boolean
  frame: number
  address: string
  onSeek: (frame: number) => void
  onPreview?: () => void
  onExport: () => void
  onRemove?: () => void
  presentation?: 'canvas' | 'preview'
  toolbar?: ReactNode
  onSelectClip?: (clip: SequenceClip) => void
  onMoveClip?: (clip: SequenceClip, frame: number) => void
  onRemoveClip?: (clip: SequenceClip) => void
  /** Enables edge handles on the selected clip; frames stay inside `trimBounds`. */
  onTrimClip?: (clip: SequenceClip, edge: 'start' | 'end', startFrame: number, endFrame: number) => void
  trimBounds?: { min: number; max: number }
  rhythm?: {
    masterClipId: string | null
    markers: readonly { frame: number; bar: boolean; manual: boolean }[]
    analysis: MusicAnalysis | null
    snap: 'off' | 'beats' | 'bars'
  }
}

const width = notebookGrid.columnCount * notebookGrid.columnPitch - notebookGrid.gap
const labelWidth = 200
const laneHeight = 36
const endPadding = 120
const blockStyle = { width, height: notebookGrid.squareSize }

type TrimDrag = { clipId: string; edge: 'start' | 'end'; clientX: number; start: number; end: number; origin: number }

function trimmedRange(drag: TrimDrag, frame: number, bounds: { min: number; max: number }): { start: number; end: number } {
  if (drag.edge === 'start') return { start: Math.max(bounds.min, Math.min(drag.end - 1, frame)), end: drag.end }
  return { start: drag.start, end: Math.min(bounds.max, Math.max(drag.start + 1, frame)) }
}

function timeLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
}

function TimelinePicker({ assembly }: Pick<NotebookTimelineProps, 'assembly'>) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    const trigger = document.activeElement
    const element = dialog.current
    element?.showModal()
    element?.querySelector('input')?.focus()
    return () => {
      element?.close()
      restoreFocusElement(trigger instanceof HTMLElement ? trigger : null)
    }
  }, [])
  const picker = assembly.picker
  if (!picker) return null
  const items = picker.items.filter((asset) => asset.label.toLowerCase().includes(query.toLowerCase()))
  return createPortal(
    <dialog
      ref={dialog}
      className="timeline-source-picker"
      aria-label="Add a timeline clip"
      data-composer-focus="preserve"
      onCancel={(event) => { event.preventDefault(); assembly.closePicker() }}
      onKeyDown={(event) => {
        event.stopPropagation()
        handleModalDialogKeyDown(event, { busy: false, container: event.currentTarget, onClose: assembly.closePicker })
      }}
      onClick={(event) => { if (event.target === event.currentTarget) assembly.closePicker() }}
    >
      <header><strong>Add a clip</strong><button type="button" onClick={assembly.closePicker} aria-label="Close clip picker"><X size={16} /></button></header>
      <input autoFocus aria-label="Filter timeline sources" placeholder="Filter media by name" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="timeline-source-list">
        {items.map((asset) => (
          <button key={asset.artifactId} type="button" disabled={assembly.busy} onClick={() => void assembly.append(picker.trackId, asset.artifactId)}>
            {asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" loading="lazy" /> : <Film size={24} />}
            <span>{asset.label}</span><Plus size={16} />
          </button>
        ))}
        {items.length === 0 && <p>No matching media on this page.</p>}
      </div>
      {assembly.error && <p role="alert">{assembly.error}</p>}
      {picker.offset !== null && <button type="button" disabled={assembly.busy} onClick={() => void assembly.loadMore()}>Load more media</button>}
    </dialog>, document.body,
  )
}

export function NotebookTimeline({ sequence, assets, assembly, disabled, frame, address, onSeek, onPreview, onExport, onRemove, presentation = 'canvas', toolbar, onSelectClip, onMoveClip, onRemoveClip, onTrimClip, trimBounds, rhythm }: NotebookTimelineProps) {
  const [zoom, setZoom] = useState<number | 'fit'>(presentation === 'preview' ? 'fit' : 48)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const selectedClip = assembly.selectedClipId
  const [drag, setDrag] = useState<{ clipId: string; clientX: number; start: number; frame: number } | null>(null)
  const dragged = useRef(false)
  const [trim, setTrim] = useState<TrimDrag | null>(null)
  const audioViewport = useRef<HTMLDivElement>(null)
  const horizontalViewport = useRef<HTMLDivElement>(null)
  const [audioHeight, setAudioHeight] = useState(120)
  const [laneWidth, setLaneWidth] = useState(width - labelWidth)
  const fps = sequence ? sequence.frameRate.numerator / sequence.frameRate.denominator : 30
  const clipEndFrame = sequence?.clips.reduce((end, clip) => Math.max(end, clip.timelineStartFrame + clip.durationFrames), 0) ?? 0
  const endFrame = sequence?.captions.reduce((end, cue) => Math.max(end, cue.timelineStartFrame + cue.durationFrames), clipEndFrame) ?? clipEndFrame
  const duration = endFrame / fps
  const trailingSpace = presentation === 'preview' ? Math.min(endPadding, laneWidth / 10) : endPadding
  const fittedZoom = Math.max(1, laneWidth - trailingSpace) / Math.max(1, duration)
  const pixelsPerSecond = Math.min(zoom === 'fit' ? fittedZoom : zoom, 8_000_000 / Math.max(1, duration))
  const contentWidth = zoom === 'fit' ? laneWidth : Math.max(laneWidth, duration * pixelsPerSecond + trailingSpace)
  const boundedLeft = Math.min(scrollLeft, contentWidth - laneWidth)
  const mainVideo = sequence?.tracks.reduce<SequenceTrack | undefined>((main, track) =>
    track.kind === 'video' && (!main || track.ordinal < main.ordinal) ? track : main, undefined)
  const tracks = useMemo(() => sequence?.tracks.filter((track) => track.kind === 'audio'
    || track.kind === 'video' && track.trackId !== mainVideo?.trackId
      && sequence.clips.some((clip) => clip.trackId === track.trackId)) ?? [], [mainVideo?.trackId, sequence])
  const clipsByTrack = useMemo(() => {
    const map = new Map<string, SequenceClip[]>()
    for (const clip of sequence?.clips ?? []) {
      const clips = map.get(clip.trackId) ?? []
      clips.push(clip)
      map.set(clip.trackId, clips)
    }
    return map
  }, [sequence])
  const assetsById = useMemo(() => new Map(assets.map((asset) => [asset.artifactId, asset])), [assets])
  useEffect(() => {
    const element = audioViewport.current
    const horizontal = horizontalViewport.current
    if (!element || !horizontal) return
    const observer = new ResizeObserver(() => {
      setAudioHeight(element.clientHeight)
      const measuredLabelWidth = Number.parseFloat(getComputedStyle(horizontal).marginLeft) || labelWidth
      setLaneWidth(Math.max(1, Math.min(horizontal.clientWidth, element.clientWidth - measuredLabelWidth)))
    })
    observer.observe(element)
    observer.observe(horizontal)
    return () => observer.disconnect()
  }, [])
  const trackHeight = presentation === 'preview' ? 64 : laneHeight
  const firstTrack = Math.max(0, Math.min(Math.floor(scrollTop / trackHeight), tracks.length - 1) - 1)
  const visibleTracks = tracks.slice(firstTrack, firstTrack + Math.ceil(audioHeight / trackHeight) + 3)
  const busy = disabled || assembly.busy
  const selected = sequence?.clips.find((clip) => clip.clipId === selectedClip)
  const selectedTrack = sequence?.tracks.find((track) => track.trackId === selected?.trackId)
  const canRemove = selected && !selectedTrack?.locked
    && (selectedTrack?.kind === 'audio' || selectedTrack?.trackId === mainVideo?.trackId)
  const tickSeconds = Math.max(1, 2 ** Math.ceil(Math.log2(100 / pixelsPerSecond)))
  const firstTick = Math.floor(boundedLeft / pixelsPerSecond / tickSeconds)
  const ticks = Array.from({ length: Math.ceil(laneWidth / pixelsPerSecond / tickSeconds) + 2 }, (_, index) => (firstTick + index) * tickSeconds)
  const visibleMarkers = useMemo(() => {
    const visible: NonNullable<NotebookTimelineProps['rhythm']>['markers'][number][] = []
    for (const marker of rhythm?.markers ?? []) {
      const x = marker.frame / fps * pixelsPerSecond - boundedLeft
      const previous = visible[visible.length - 1]
      const previousX = previous ? previous.frame / fps * pixelsPerSecond - boundedLeft : -Infinity
      if (x < 0 || x > laneWidth) continue
      if (x - previousX < (marker.bar ? 8 : 14)) {
        if (marker.bar && previous && !previous.bar) visible[visible.length - 1] = marker
        continue
      }
      visible.push(marker)
    }
    return visible
  }, [rhythm?.markers, fps, pixelsPerSecond, boundedLeft, laneWidth])

  function seekAt(clientX: number, element: HTMLElement) {
    const rect = element.getBoundingClientRect()
    const x = (clientX - rect.left) * element.clientWidth / rect.width
    onSeek(Math.max(0, Math.min(endFrame - 1, Math.round((x + boundedLeft) / pixelsPerSecond * fps))))
  }

  function lane(track: SequenceTrack, style?: CSSProperties) {
    const clips = clipsByTrack.get(track.trackId) ?? []
    const readOnly = track.kind === 'video' && track.trackId !== mainVideo?.trackId
    const visibleClips = clips.filter((clip) => {
      const start = clip.timelineStartFrame / fps * pixelsPerSecond
      return start + clip.durationFrames / fps * pixelsPerSecond >= boundedLeft - 100 && start <= boundedLeft + laneWidth + 100
    })
    return (
      <div className={`timeline-track timeline-track-${track.kind}`} key={track.trackId} data-track-id={track.trackId} style={style}>
        <div className="timeline-track-label">
          <span title={track.name}>{readOnly ? `${track.name} · read only` : track.name}</span>
          {!readOnly && <button type="button" disabled={busy || track.locked} onClick={() => void assembly.openPicker(track.trackId)} aria-label={`Add clip to ${track.name}`}><Plus size={14} /></button>}
          {track.kind === 'audio' && clips.length === 0 && tracks.filter((entry) => entry.kind === 'audio').length > 1
            && <button type="button" disabled={busy || track.locked} onClick={() => void assembly.removeTrack(track.trackId)} aria-label={`Remove ${track.name}`}><X size={12} /></button>}
        </div>
        <div className="timeline-track-lane" onClick={(event) => seekAt(event.clientX, event.currentTarget)}>
          {visibleClips.map((clip) => {
            const asset = assetsById.get(clip.source.artifactId)
            const trimming = trim?.clipId === clip.clipId ? trim : null
            const startFrame = trimming ? trimming.start : drag?.clipId === clip.clipId ? drag.frame : clip.timelineStartFrame
            const left = startFrame / fps * pixelsPerSecond - boundedLeft
            const clipWidth = (trimming ? trimming.end - trimming.start : clip.durationFrames) / fps * pixelsPerSecond
            const trimmable = Boolean(onTrimClip && trimBounds && selectedClip === clip.clipId && track.kind === 'video' && !readOnly && !track.locked && !busy)
            const analysis = rhythm?.analysis?.artifactId === clip.source.artifactId ? rhythm.analysis : null
            const peaks = track.kind === 'audio' ? clipWaveform(clip, analysis?.waveform ?? asset?.waveform ?? [], analysis?.durationSeconds ?? asset?.duration ?? 0, fps, Math.min(2048, Math.max(32, Math.ceil(clipWidth / 2)))) : []
            const waveform = waveformEnvelopePath(peaks)
            return (
              <button
                className={`timeline-clip${selectedClip === clip.clipId ? ' selected' : ''}${rhythm?.masterClipId === clip.clipId ? ' timeline-master' : ''}`}
                type="button"
                key={clip.clipId}
                data-clip-id={clip.clipId}
                aria-pressed={selectedClip === clip.clipId}
                title={`${asset?.label ?? 'Clip'} · ${(clip.durationFrames / fps).toFixed(2)}s`}
                style={{ left, width: Math.max(2, clipWidth) }}
                onPointerDown={(event) => {
                  if (!onMoveClip || readOnly || track.kind !== 'video' || track.locked || busy || event.button !== 0) return
                  dragged.current = false
                  event.currentTarget.setPointerCapture(event.pointerId)
                  setDrag({ clipId: clip.clipId, clientX: event.clientX, start: clip.timelineStartFrame, frame: clip.timelineStartFrame })
                }}
                onPointerMove={(event) => {
                  if (!drag || drag.clipId !== clip.clipId) return
                  if (Math.abs(event.clientX - drag.clientX) > 4) dragged.current = true
                  const raw = Math.max(0, drag.start + (event.clientX - drag.clientX) / pixelsPerSecond * fps)
                  const target = event.altKey ? Math.round(raw) : nearestBeat(raw, rhythm?.markers ?? [], rhythm?.snap ?? 'off', 12 / pixelsPerSecond * fps)
                  setDrag({ ...drag, frame: target })
                }}
                onPointerUp={() => {
                  if (drag?.clipId === clip.clipId && dragged.current && drag.frame !== clip.timelineStartFrame) onMoveClip?.(clip, drag.frame)
                  setDrag(null)
                }}
                onPointerCancel={() => { dragged.current = false; setDrag(null) }}
                onKeyDown={(event) => { if (event.key === 'Escape' && drag) { event.stopPropagation(); dragged.current = false; setDrag(null) } }}
                onClick={(event) => { event.stopPropagation(); if (dragged.current) { dragged.current = false; return } assembly.selectClip(clip.clipId); onSelectClip?.(clip); onSeek(clip.timelineStartFrame) }}
              >
                {waveform && <svg className="timeline-waveform" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d={waveform} /></svg>}
                {asset?.thumbnailUrl && track.kind === 'video' && clipWidth > 55 && <img src={asset.thumbnailUrl} alt="" loading="lazy" />}
                <span>{asset?.label ?? 'Clip'}</span>
                {trimmable && (['start', 'end'] as const).map((edge) => (
                  <i
                    key={edge}
                    className={`timeline-trim-handle ${edge}`}
                    title={`Drag to trim the ${edge === 'start' ? 'in' : 'out'} point`}
                    aria-hidden="true"
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return
                      event.stopPropagation()
                      event.currentTarget.setPointerCapture(event.pointerId)
                      const end = clip.timelineStartFrame + clip.durationFrames
                      setTrim({ clipId: clip.clipId, edge, clientX: event.clientX, start: clip.timelineStartFrame, end, origin: edge === 'start' ? clip.timelineStartFrame : end })
                    }}
                    onPointerMove={(event) => {
                      if (!trim || trim.clipId !== clip.clipId || trim.edge !== edge || !trimBounds) return
                      const raw = trim.origin + (event.clientX - trim.clientX) / pixelsPerSecond * fps
                      const target = event.altKey ? Math.round(raw) : nearestBeat(raw, rhythm?.markers ?? [], rhythm?.snap ?? 'off', 12 / pixelsPerSecond * fps)
                      setTrim({ ...trim, ...trimmedRange(trim, target, trimBounds) })
                    }}
                    onPointerUp={(event) => {
                      event.stopPropagation()
                      const final = trim
                      setTrim(null)
                      if (!final || final.clipId !== clip.clipId) return
                      if (final.start === clip.timelineStartFrame && final.end === clip.timelineStartFrame + clip.durationFrames) return
                      onTrimClip?.(clip, edge, final.start, final.end)
                    }}
                    onPointerCancel={() => setTrim(null)}
                  />
                ))}
              </button>
            )
          })}
          {clips.length === 0 && <span className="timeline-empty-lane">Add {track.kind} to begin</span>}
          {visibleMarkers.map((marker) => <i key={marker.frame} className={`timeline-beat${marker.bar ? ' bar' : ''}${marker.manual ? ' manual' : ''}`} style={{ left: marker.frame / fps * pixelsPerSecond - boundedLeft }} aria-hidden="true" />)}
          <i className="timeline-playhead" style={{ left: frame / fps * pixelsPerSecond - boundedLeft }} />
        </div>
      </div>
    )
  }

  return (
    <section className={`notebook-timeline${presentation === 'preview' ? ' notebook-timeline-preview' : ''}`} style={presentation === 'canvas' ? blockStyle : undefined} aria-label={`Timeline ${address}`} data-composer-focus="preserve">
      <header className="notebook-timeline-header">
        <Film size={15} /><strong>Timeline</strong><code>{address}</code><span>{timeLabel(duration)}</span>
        <div className="timeline-toolbar nodrag nopan nowheel">
          <button type="button" disabled={busy || !sequence} onClick={() => void assembly.addTrack()}>+ Audio track</button>
          {onPreview && <button type="button" disabled={!sequence || endFrame === 0} onClick={onPreview}>Preview</button>}
          <button type="button" disabled={busy || endFrame === 0} onClick={onExport}>Export</button>
          <button type="button" disabled={busy || !canRemove} onClick={() => { if (selected) { if (onRemoveClip) onRemoveClip(selected); else void assembly.removeClip(selected.clipId) } }}>Remove clip</button>
          <button type="button" aria-label="Zoom timeline out" onClick={() => setZoom(Math.max(Math.min(0.25, fittedZoom), pixelsPerSecond / 2))}>−</button>
          <button type="button" aria-label="Zoom timeline in" onClick={() => setZoom(Math.min(Math.max(768, fittedZoom), pixelsPerSecond * 2))}>+</button>
          <button type="button" aria-pressed={zoom === 'fit'} onClick={() => { setZoom('fit'); setScrollLeft(0); horizontalViewport.current?.scrollTo({ left: 0 }) }}>Fit</button>
          {onRemove && <button type="button" disabled={busy} aria-label="Remove Timeline element" onClick={onRemove}><Trash2 size={14} /></button>}
        </div>
      </header>
      {toolbar && <div className="timeline-music-toolbar">{toolbar}</div>}
      <div className="timeline-assembly nodrag nopan nowheel">
        {assembly.error && !assembly.picker && <div role="alert" className="timeline-error">{assembly.error}</div>}
        <div className="timeline-ruler-row">
          <span>{timeLabel(frame / fps)}</span>
          <div className="timeline-ruler" aria-label="Timeline ruler" onClick={(event) => seekAt(event.clientX, event.currentTarget)}>
            {ticks.map((seconds) => <span key={seconds} style={{ left: seconds * pixelsPerSecond - boundedLeft }}>{timeLabel(seconds)}</span>)}
          </div>
        </div>
        {mainVideo && lane(mainVideo)}
        <div className="timeline-audio-viewport" ref={audioViewport} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
          <div className="timeline-audio-content" style={{ height: tracks.length * trackHeight }}>
            {visibleTracks.map((track, index) => lane(track, { position: 'absolute', top: (firstTrack + index) * trackHeight, height: trackHeight, width: '100%' }))}
          </div>
        </div>
        <div className="timeline-horizontal" ref={horizontalViewport} onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}>
          <div style={{ width: contentWidth, height: 1 }} />
        </div>
      </div>
      {assembly.picker && <TimelinePicker assembly={assembly} />}
    </section>
  )
}
