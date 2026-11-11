import { useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import type { GraphicsEdit } from '../../../../server/src/graphics/edits'
import { graphicsSpaceRect, type GraphicsLayerLayout, type GraphicsRect } from '../../../../server/src/graphics/layout'
import { GRAPHICS_ANCHOR_POINTS, type GraphicsDocument, type GraphicsFrame, type GraphicsLayer, type GraphicsTextSlot } from '../../../../server/src/graphics/model'
import { layerOpacityAt, resolveLayerTiming } from '../../../../server/src/graphics/timing'
import {
  graphicsLayerHandles,
  graphicsMoveLayer,
  graphicsResizeEdits,
  graphicsSizeCorner,
  graphicsSnapLines,
  graphicsTextWidthDrag,
  type GraphicsGuide,
  type GraphicsHandle,
  type GraphicsHandlePoint,
  type GraphicsSnapLines,
} from '@/videobook/graphics-pointer'

type StageSource = GraphicsFrame & { durationSeconds: number }
type GestureHandle = GraphicsHandle | 'move'
type StageEntry = { entry: GraphicsLayerLayout; layer: GraphicsLayer; selected: boolean }
type ActiveGesture = { layerId: string; box: GraphicsRect | null; column: GraphicsRect | null; guides: GraphicsGuide[] }

type Gesture = {
  pointerId: number
  handle: GestureHandle
  layer: GraphicsLayer
  box: GraphicsRect
  startX: number
  startY: number
  scale: number
  key: string
  lines: GraphicsSnapLines
  moved: boolean
}

type StageLayersProps = {
  document: GraphicsDocument
  layout: GraphicsLayerLayout[]
  source: StageSource
  seconds: number
  selectedLayerId: string | null
  activeSlot: GraphicsTextSlot | null
  editable: boolean
  snapping: boolean
  guides: boolean
  onSelectLayer: (layerId: string) => void
  onEdit: (edits: GraphicsEdit[], coalesceKey: string) => boolean
}

const DRAG_START_PX = 3
const SNAP_PX = 6
const HANDLE_TITLES: Record<GraphicsHandle, string> = {
  size: 'Drag to resize',
  'width-start': 'Drag to change the text width',
  'width-end': 'Drag to change the text width',
  height: 'Drag to change the shade height',
}

function percent(value: number): string {
  return `${(value * 100).toFixed(3)}%`
}

function stageBoxStyle(box: GraphicsRect, frame: GraphicsFrame): CSSProperties {
  return {
    left: percent(box.x / frame.width),
    top: percent(box.y / frame.height),
    width: percent(box.width / frame.width),
    height: percent(box.height / frame.height),
  }
}

function boxData(box: GraphicsRect): string {
  return [box.x, box.y, box.width, box.height].map((value) => Math.round(value)).join(',')
}

function shownAt(layer: GraphicsLayer, seconds: number, durationSeconds: number): boolean {
  return layerOpacityAt(resolveLayerTiming(layer.timing, durationSeconds), seconds) > 0
}

function handleCursor(layer: GraphicsLayer, handle: GraphicsHandle): CSSProperties['cursor'] {
  if (handle === 'height') return 'ns-resize'
  if (handle !== 'size' || layer.kind === 'scrim') return 'ew-resize'
  const corner = graphicsSizeCorner(layer.position.anchor)
  return corner.x === corner.y ? 'nwse-resize' : 'nesw-resize'
}

function stageEntries(props: StageLayersProps): StageEntry[] {
  const layers = new Map(props.document.layers.map((layer) => [layer.id, layer]))
  return props.layout.flatMap((entry) => {
    const layer = layers.get(entry.layerId)
    if (!layer) return []
    const selected = entry.layerId === props.selectedLayerId
    if (!selected && (entry.kind === 'scrim' || !shownAt(layer, props.seconds, props.source.durationSeconds))) return []
    return [{ entry, layer, selected }]
  })
}

function ItemBoxes({ entry, layer, activeSlot }: { entry: GraphicsLayerLayout; layer: GraphicsLayer; activeSlot: GraphicsTextSlot | null }) {
  if (entry.kind !== 'text' || layer.kind !== 'text') return null
  return entry.items.map((item) => {
    const slot = layer.items.find((candidate) => candidate.id === item.itemId)?.slot ?? undefined
    const relative = { x: item.box.x - entry.box.x, y: item.box.y - entry.box.y, width: item.box.width, height: item.box.height }
    return (
      <span
        key={item.itemId}
        className="graphics-item-box"
        data-item-id={item.itemId}
        data-slot={slot}
        data-active={slot && slot === activeSlot ? 'true' : undefined}
        data-box={boxData(item.box)}
        data-overflow={item.overflow ? 'true' : undefined}
        style={stageBoxStyle(relative, { width: entry.box.width, height: entry.box.height })}
      />
    )
  })
}

function SelectionChrome({ entry, layer, box, column, source, editable, handlers }: {
  entry: GraphicsLayerLayout
  layer: GraphicsLayer
  box: GraphicsRect
  column: GraphicsRect | null
  source: StageSource
  editable: boolean
  handlers: (layer: GraphicsLayer, box: GraphicsRect, handle: GestureHandle) => PointerHandlers
}) {
  const handles: GraphicsHandlePoint[] = editable ? graphicsLayerHandles(layer, box) : []
  const anchor = layer.kind === 'scrim' ? null : GRAPHICS_ANCHOR_POINTS[layer.position.anchor]
  return (
    <>
      {layer.kind === 'scrim' && <span className="graphics-scrim-box" data-layer-id={layer.id} data-box={boxData(entry.box)} style={stageBoxStyle(box, source)} />}
      {column && <span className="graphics-text-column" style={stageBoxStyle(column, source)} />}
      {anchor && box.width > 0 && (
        <span
          className="graphics-anchor-mark"
          data-anchor={layer.kind === 'scrim' ? undefined : layer.position.anchor}
          style={{ left: percent((box.x + anchor.x * box.width) / source.width), top: percent((box.y + anchor.y * box.height) / source.height) }}
        />
      )}
      {handles.map((point) => (
        <span
          key={point.handle}
          className="graphics-handle"
          data-handle={point.handle}
          data-layer-id={layer.id}
          title={HANDLE_TITLES[point.handle]}
          style={{ left: percent(point.x / source.width), top: percent(point.y / source.height), cursor: handleCursor(layer, point.handle) }}
          {...handlers(layer, entry.box, point.handle)}
        />
      ))}
    </>
  )
}

type PointerHandlers = {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void
  onPointerMove: (event: PointerEvent<HTMLElement>) => void
  onPointerUp: (event: PointerEvent<HTMLElement>) => void
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void
}

export function GraphicsStageLayers(props: StageLayersProps) {
  const { source, editable, snapping, onEdit, onSelectLayer } = props
  const gesture = useRef<Gesture | null>(null)
  const [active, setActive] = useState<ActiveGesture | null>(null)
  const entries = stageEntries(props)
  const selected = entries.find((candidate) => candidate.selected) ?? null

  const begin = (event: PointerEvent<HTMLElement>, layer: GraphicsLayer, box: GraphicsRect, handle: GestureHandle) => {
    if (event.button !== 0) return
    onSelectLayer(layer.id)
    if (!editable) return
    const width = event.currentTarget.closest('.graphics-overlay')?.getBoundingClientRect().width ?? 0
    if (!(width > 0)) return
    if (handle === 'move') event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    const others = entries.filter(({ entry }) => entry.layerId !== layer.id && entry.kind !== 'scrim').map(({ entry }) => entry.box)
    gesture.current = {
      pointerId: event.pointerId,
      handle,
      layer,
      box,
      startX: event.clientX,
      startY: event.clientY,
      scale: source.width / width,
      key: `${handle}:${layer.id}:${crypto.randomUUID()}`,
      lines: graphicsSnapLines(source, others),
      moved: false,
    }
  }

  const update = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    const dx = event.clientX - current.startX
    const dy = event.clientY - current.startY
    if (!current.moved && Math.hypot(dx, dy) < DRAG_START_PX) return
    current.moved = true
    const delta = { x: dx * current.scale, y: dy * current.scale }
    if (current.handle !== 'move') {
      const edits = graphicsResizeEdits({ frame: source, layer: current.layer, box: current.box, handle: current.handle, delta })
      const widthDrag = current.layer.kind === 'text' && (current.handle === 'width-start' || current.handle === 'width-end')
        ? graphicsTextWidthDrag(source, current.layer, current.box, current.handle, delta)
        : null
      if (widthDrag) setActive({ layerId: current.layer.id, box: null, column: widthDrag.column, guides: [] })
      if (edits.length > 0) onEdit(edits, current.key)
      return
    }
    if (current.layer.kind === 'scrim') return
    const free = !snapping || event.altKey || event.metaKey || event.ctrlKey
    const move = graphicsMoveLayer({
      frame: source,
      position: current.layer.position,
      box: current.box,
      delta,
      snap: free ? null : { lines: current.lines, threshold: SNAP_PX * current.scale },
    })
    setActive({ layerId: current.layer.id, box: move.box, column: null, guides: move.guides })
    onEdit([{ op: 'set_position', layer_id: current.layer.id, position: move.position }], current.key)
  }

  const finish = (event: PointerEvent<HTMLElement>, apply: boolean) => {
    if (gesture.current?.pointerId !== event.pointerId) return
    if (apply) update(event)
    gesture.current = null
    setActive(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const handlers = (layer: GraphicsLayer, box: GraphicsRect, handle: GestureHandle): PointerHandlers => ({
    onPointerDown: (event) => begin(event, layer, box, handle),
    onPointerMove: update,
    onPointerUp: (event) => finish(event, true),
    onPointerCancel: (event) => finish(event, false),
  })

  const displayed = (entry: GraphicsLayerLayout) => (active?.layerId === entry.layerId && active.box ? active.box : entry.box)

  return (
    <>
      {props.guides && <div className="graphics-guide-safe" style={stageBoxStyle(graphicsSpaceRect(source, 'safe'), source)} />}
      {entries.filter(({ entry }) => entry.kind !== 'scrim').map(({ entry, layer, selected: isSelected }) => (
        <button
          key={entry.layerId}
          type="button"
          className="graphics-layer-box"
          data-layer-id={entry.layerId}
          data-box={boxData(entry.box)}
          data-selected={isSelected ? 'true' : undefined}
          data-draggable={editable ? 'true' : undefined}
          aria-label={`Select ${layer.name}`}
          aria-pressed={isSelected}
          style={stageBoxStyle(displayed(entry), source)}
          onClick={() => onSelectLayer(entry.layerId)}
          {...handlers(layer, entry.box, 'move')}
        >
          <ItemBoxes entry={entry} layer={layer} activeSlot={props.activeSlot} />
        </button>
      ))}
      {selected && (
        <SelectionChrome
          entry={selected.entry}
          layer={selected.layer}
          box={displayed(selected.entry)}
          column={active?.layerId === selected.entry.layerId ? active.column : null}
          source={source}
          editable={editable}
          handlers={handlers}
        />
      )}
      {active?.guides.map((guide) => (
        <span
          key={`${guide.axis}:${guide.at}`}
          className="graphics-snap-guide"
          data-axis={guide.axis}
          data-at={guide.at}
          style={guide.axis === 'x' ? { left: percent(guide.at / source.width) } : { top: percent(guide.at / source.height) }}
        />
      ))}
    </>
  )
}
