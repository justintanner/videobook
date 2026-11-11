import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import type { PlayerRef } from '@remotion/player'
import { ArrowDown, ArrowUp, Blend, Copy, Eye, EyeOff, Image, Pencil, Plus, QrCode, Trash2, TriangleAlert, Type, type LucideIcon } from 'lucide-react'
import type { GraphicsEdit } from '../../../../server/src/graphics/edits'
import { MAX_GRAPHICS_LAYERS, MAX_GRAPHICS_NAME_LENGTH, type GraphicsDocument, type GraphicsLayer, type GraphicsLayerKind } from '../../../../server/src/graphics/model'
import {
  graphicsAddLayer,
  graphicsLayerSummary,
  graphicsNextLayerId,
  graphicsSelectionAfterRemove,
  type GraphicsAddKind,
  type GraphicsImageChoice,
  type GraphicsRead,
} from '@/videobook/graphics-model'
import {
  graphicsRuler,
  graphicsTimingBar,
  graphicsTimingRows,
  graphicsTimingSummary,
  graphicsTimingTrim,
  type GraphicsTimingBound,
  type GraphicsTimingRow,
} from '@/videobook/graphics-timing'
import { usePlayerFrame } from '../preview-stage'

type Edit = (edits: GraphicsEdit[], coalesceKey?: string | null) => boolean

type LayersProps = {
  document: GraphicsDocument
  drawn: GraphicsDocument
  read: GraphicsRead
  imageChoices: readonly GraphicsImageChoice[]
  selectedLayerId: string | null
  warnings: Readonly<Record<string, string>>
  disabled: boolean
  playerRef: RefObject<PlayerRef | null>
  onEdit: Edit
  onSelect: (layerId: string | null) => void
}

type TimelineClock = { durationSeconds: number; fps: number; playerRef: RefObject<PlayerRef | null> }

const KIND_ICONS: Record<GraphicsLayerKind, LucideIcon> = { text: Type, image: Image, qr: QrCode, scrim: Blend }
const ADD_LABELS: Record<GraphicsAddKind, string> = { text: 'Text', image: 'Image', qr: 'QR code', scrim: 'Shade' }
const ADD_NAMES: Record<GraphicsAddKind, string> = { text: 'Add text layer', image: 'Add image layer', qr: 'Add QR code layer', scrim: 'Add shade layer' }
const ADD_KINDS: readonly GraphicsAddKind[] = ['text', 'image', 'qr', 'scrim']
const TRIM_TITLES: Record<GraphicsTimingBound, string> = { start: 'Drag to change when the layer appears', end: 'Drag to change when the layer leaves' }
const TRIM_BOUNDS: readonly GraphicsTimingBound[] = ['start', 'end']
const RULER_END = 0.9
const RULER_LAST = 0.995
const NO_FRAME_CHANGE = () => undefined

function percent(value: number): string {
  return `${(value * 100).toFixed(3)}%`
}

function NameEditor({ layer, onRename, onDone }: { layer: GraphicsLayer; onRename: (name: string) => void; onDone: () => void }) {
  const [draft, setDraft] = useState(layer.name)
  const settled = useRef(false)
  const finish = (save: boolean) => {
    if (settled.current) return
    settled.current = true
    const name = draft.trim()
    if (save && name && name !== layer.name) onRename(name)
    onDone()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      finish(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finish(false)
    }
  }
  return (
    <input
      className="graphics-layer-rename"
      aria-label={`Name of ${layer.name}`}
      value={draft}
      maxLength={MAX_GRAPHICS_NAME_LENGTH}
      autoFocus
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={onKeyDown}
    />
  )
}

function LayerActions({ layer, index, document, disabled, onEdit, onSelect, onRename }: {
  layer: GraphicsLayer
  index: number
  document: GraphicsDocument
  disabled: boolean
  onEdit: Edit
  onSelect: (layerId: string | null) => void
  onRename: () => void
}) {
  const last = document.layers.length - 1
  const move = (to: number) => onEdit([{ op: 'move_layer', layer_id: layer.id, index: to }])
  const duplicate = () => {
    const copyId = graphicsNextLayerId(document)
    if (onEdit([{ op: 'duplicate_layer', layer_id: layer.id }])) onSelect(copyId)
  }
  const remove = () => {
    const next = graphicsSelectionAfterRemove(document, layer.id)
    if (onEdit([{ op: 'remove_layer', layer_id: layer.id }])) onSelect(next)
  }
  return (
    <div className="graphics-layer-actions">
      <button type="button" className="graphics-icon-button" aria-label={`Rename ${layer.name}`} title="Rename" disabled={disabled} onClick={onRename}><Pencil size={13} aria-hidden="true" /></button>
      <button type="button" className="graphics-icon-button" aria-label={`Move ${layer.name} up`} title="Bring forward" disabled={disabled || index === last} onClick={() => move(index + 1)}><ArrowUp size={13} aria-hidden="true" /></button>
      <button type="button" className="graphics-icon-button" aria-label={`Move ${layer.name} down`} title="Send backward" disabled={disabled || index === 0} onClick={() => move(index - 1)}><ArrowDown size={13} aria-hidden="true" /></button>
      <button type="button" className="graphics-icon-button" aria-label={`Duplicate ${layer.name}`} title="Duplicate" disabled={disabled || document.layers.length >= MAX_GRAPHICS_LAYERS} onClick={duplicate}><Copy size={13} aria-hidden="true" /></button>
      <button type="button" className="graphics-icon-button" aria-label={`Delete ${layer.name}`} title="Delete" disabled={disabled} onClick={remove}><Trash2 size={13} aria-hidden="true" /></button>
    </div>
  )
}

function TrackBar({ row, layer, durationSeconds, selected, onSelect }: {
  row: GraphicsTimingRow
  layer: GraphicsLayer
  durationSeconds: number
  selected: boolean
  onSelect: (layerId: string) => void
}) {
  const bar = row.window ? graphicsTimingBar(row.window, durationSeconds) : null
  const style = bar ? ({ left: percent(bar.left), width: percent(bar.width), '--fade-in': percent(bar.fadeIn), '--fade-out': percent(1 - bar.fadeOut) } as CSSProperties) : undefined
  const summary = graphicsTimingSummary(layer.timing, durationSeconds)
  return (
    <button
      type="button"
      className="graphics-timing-row"
      data-layer-id={row.layerId}
      data-selected={selected ? 'true' : undefined}
      data-hidden={row.visible ? undefined : 'true'}
      data-window={row.window ? `${row.window.start},${row.window.end}` : 'none'}
      aria-label={`${row.name}: ${summary}`}
      title={`${row.name}: ${summary}`}
      aria-pressed={selected}
      onClick={() => onSelect(row.layerId)}
    >
      {bar && <span className="graphics-timing-bar" style={style} />}
    </button>
  )
}

function TrimHandles({ row, layer, durationSeconds, onEdit }: { row: GraphicsTimingRow; layer: GraphicsLayer; durationSeconds: number; onEdit: Edit }) {
  const gesture = useRef<{ pointerId: number; bound: GraphicsTimingBound; key: string; grip: number } | null>(null)
  const window = row.window
  if (!window) return null
  const edges: Record<GraphicsTimingBound, number> = { start: window.start / durationSeconds, end: window.end / durationSeconds }
  const begin = (event: PointerEvent<HTMLSpanElement>, bound: GraphicsTimingBound) => {
    const track = event.currentTarget.parentElement?.getBoundingClientRect()
    if (event.button !== 0 || !track) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const grip = event.clientX - (track.left + edges[bound] * track.width)
    gesture.current = { pointerId: event.pointerId, bound, key: `trim:${layer.id}:${bound}:${crypto.randomUUID()}`, grip }
  }
  const update = (event: PointerEvent<HTMLSpanElement>) => {
    const current = gesture.current
    const track = event.currentTarget.parentElement?.getBoundingClientRect()
    if (!current || current.pointerId !== event.pointerId || !track || !(track.width > 0)) return
    const at = Math.min(1, Math.max(0, (event.clientX - current.grip - track.left) / track.width)) * durationSeconds
    const timing = graphicsTimingTrim(layer.timing, current.bound, at, durationSeconds)
    if (timing !== layer.timing) onEdit([{ op: 'set_timing', layer_id: layer.id, timing }], current.key)
  }
  const finish = (event: PointerEvent<HTMLSpanElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return
    gesture.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return TRIM_BOUNDS.map((bound) => (
    <span
      key={bound}
      className="graphics-trim-handle"
      data-bound={bound}
      data-layer-id={layer.id}
      title={TRIM_TITLES[bound]}
      style={{ left: percent(edges[bound]) }}
      onPointerDown={(event) => begin(event, bound)}
      onPointerMove={update}
      onPointerUp={finish}
      onPointerCancel={finish}
    />
  ))
}

function LayerRow({ layer, index, row, durationSeconds, props }: { layer: GraphicsLayer; index: number; row: GraphicsTimingRow | null; durationSeconds: number; props: LayersProps }) {
  const { document, read, imageChoices, selectedLayerId, warnings, disabled, onEdit, onSelect } = props
  const [renaming, setRenaming] = useState(false)
  const selected = layer.id === selectedLayerId
  const warning = warnings[layer.id]
  const Icon = KIND_ICONS[layer.kind]
  const toggle = () => onEdit([{ op: 'set_layer', layer_id: layer.id, layer: { visible: !layer.visible } }])
  return (
    <li className="graphics-layer-row" data-layer-id={layer.id} data-selected={selected ? 'true' : undefined} data-hidden={layer.visible ? undefined : 'true'}>
      <div className="graphics-layer-label">
        <button
          type="button"
          className="graphics-icon-button"
          aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`}
          title={layer.visible ? 'Hide' : 'Show'}
          disabled={disabled}
          onClick={toggle}
        >
          {layer.visible ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}
        </button>
        {renaming ? (
          <NameEditor layer={layer} onRename={(name) => onEdit([{ op: 'set_layer', layer_id: layer.id, layer: { name } }])} onDone={() => setRenaming(false)} />
        ) : (
          <button
            type="button"
            className="graphics-layer-name"
            aria-pressed={selected}
            aria-label={`Select layer ${layer.name}`}
            onClick={() => onSelect(layer.id)}
            onDoubleClick={() => !disabled && setRenaming(true)}
          >
            <Icon size={13} aria-hidden="true" />
            <span className="graphics-layer-title">{layer.name || 'Untitled'}</span>
            <span className="graphics-layer-summary">{graphicsLayerSummary(layer, read.images, imageChoices)}</span>
          </button>
        )}
        {selected && !renaming && (
          <LayerActions layer={layer} index={index} document={document} disabled={disabled} onEdit={onEdit} onSelect={onSelect} onRename={() => setRenaming(true)} />
        )}
      </div>
      <div className="graphics-layer-track">
        {row && <TrackBar row={row} layer={layer} durationSeconds={durationSeconds} selected={selected} onSelect={onSelect} />}
        {row && selected && !disabled && <TrimHandles row={row} layer={layer} durationSeconds={durationSeconds} onEdit={onEdit} />}
      </div>
      {warning && (
        <span className="graphics-layer-warning" role="note" aria-label={`${layer.name}: ${warning}`}>
          <TriangleAlert size={12} aria-hidden="true" />{warning}
        </span>
      )}
    </li>
  )
}

function ImagePicker({ choices, disabled, onPick, onCancel }: {
  choices: readonly GraphicsImageChoice[]
  disabled: boolean
  onPick: (choice: GraphicsImageChoice) => void
  onCancel: () => void
}) {
  return (
    <div className="graphics-image-picker" role="group" aria-label="Choose an image">
      {choices.map((choice) => (
        <button key={choice.artifactId} type="button" disabled={disabled} onClick={() => onPick(choice)}>
          <code>@{choice.address}</code> {choice.label}
        </button>
      ))}
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  )
}

function playheadAt(frame: number, clock: TimelineClock): number {
  if (!(clock.durationSeconds > 0) || !(clock.fps > 0)) return 0
  return Math.min(1, Math.max(0, frame / clock.fps / clock.durationSeconds))
}

function Ruler({ clock }: { clock: TimelineClock }) {
  const { frame } = usePlayerFrame(clock.playerRef, NO_FRAME_CHANGE)
  const ruler = useMemo(() => graphicsRuler(clock.durationSeconds), [clock.durationSeconds])
  const last = Math.max(0, Math.round(clock.durationSeconds * clock.fps) - 1)
  const seek = (target: number) => clock.playerRef.current?.seekTo(Math.max(0, Math.min(last, Math.round(target))))
  return (
    <div className="graphics-ruler" style={ruler.tick > 0 ? ({ '--ruler-tick': percent(ruler.tick) } as CSSProperties) : undefined}>
      {ruler.marks.map((mark) => (
        <span key={mark.seconds} className="graphics-ruler-mark" data-end={mark.at > RULER_END ? 'true' : undefined} style={{ left: percent(mark.at) }}>
          {mark.at < RULER_LAST && mark.label}
        </span>
      ))}
      <span className="graphics-ruler-playhead" aria-hidden="true" style={{ left: percent(playheadAt(frame, clock)) }} />
      <input
        type="range"
        className="graphics-seek"
        aria-label="Playback position"
        min={0}
        max={last}
        step={1}
        value={Math.min(frame, last)}
        onChange={(event) => seek(Number(event.target.value))}
      />
    </div>
  )
}

function Playhead({ clock }: { clock: TimelineClock }) {
  const { frame } = usePlayerFrame(clock.playerRef, NO_FRAME_CHANGE)
  return <span className="graphics-timing-playhead" aria-hidden="true" style={{ '--playhead': playheadAt(frame, clock) } as CSSProperties} />
}

export function GraphicsLayers(props: LayersProps) {
  const { document, drawn, read, imageChoices, disabled, playerRef, onEdit, onSelect } = props
  const [picking, setPicking] = useState(false)
  const durationSeconds = read.source.duration_seconds
  const clock = useMemo<TimelineClock>(() => ({ durationSeconds, fps: read.source.fps, playerRef }), [durationSeconds, playerRef, read.source.fps])
  const timing = useMemo(() => new Map(graphicsTimingRows(drawn, durationSeconds).map((row) => [row.layerId, row])), [drawn, durationSeconds])
  const full = document.layers.length >= MAX_GRAPHICS_LAYERS
  const add = (kind: GraphicsAddKind, image?: GraphicsImageChoice) => {
    const added = graphicsAddLayer(document, kind, { image, profileUrl: read.fill.profile_url, qr: read.watermark?.qr ?? null })
    if (added && onEdit([added.edit])) onSelect(added.layerId)
  }
  const choose = (kind: GraphicsAddKind) => {
    if (kind === 'image') setPicking((current) => !current)
    else add(kind)
  }
  const rows = document.layers.map((layer, index) => ({ layer, index })).reverse()
  return (
    <section className="graphics-layers" aria-label="Layers">
      <div className="graphics-timeline-head">
        <div className="graphics-layers-head">
          <span className="graphics-section-label">Layers {document.layers.length}/{MAX_GRAPHICS_LAYERS}</span>
          <div className="graphics-add" role="group" aria-label="Add layer">
            {ADD_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                aria-label={ADD_NAMES[kind]}
                aria-expanded={kind === 'image' ? picking : undefined}
                title={kind === 'image' && imageChoices.length === 0 ? 'Add an image cell to the book first.' : undefined}
                disabled={disabled || full || (kind === 'image' && imageChoices.length === 0)}
                onClick={() => choose(kind)}
              >
                <Plus size={12} aria-hidden="true" />{ADD_LABELS[kind]}
              </button>
            ))}
          </div>
        </div>
        <Ruler clock={clock} />
      </div>
      {picking && (
        <ImagePicker
          choices={imageChoices}
          disabled={disabled || full}
          onPick={(choice) => {
            setPicking(false)
            add('image', choice)
          }}
          onCancel={() => setPicking(false)}
        />
      )}
      {rows.length === 0
        ? <p className="graphics-muted graphics-layers-empty">No layers yet. Add one, or apply a starter.</p>
        : (
          <div className="graphics-timeline-rows">
            <ol className="graphics-layer-list">
              {rows.map(({ layer, index }) => (
                <LayerRow key={layer.id} layer={layer} index={index} row={timing.get(layer.id) ?? null} durationSeconds={durationSeconds} props={props} />
              ))}
            </ol>
            <Playhead clock={clock} />
          </div>
        )}
    </section>
  )
}
