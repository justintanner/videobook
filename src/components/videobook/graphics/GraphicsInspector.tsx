import { useState } from 'react'
import { ScanFace } from 'lucide-react'
import type { GraphicsEdit } from '../../../../server/src/graphics/edits'
import type { GraphicsRect } from '../../../../server/src/graphics/layout'
import {
  GRAPHICS_ANCHOR_POINTS,
  GRAPHICS_ANCHORS,
  GRAPHICS_QR_LEVELS,
  GRAPHICS_QR_STYLES,
  GRAPHICS_SCRIM_EDGES,
  isGraphicsUrl,
  type GraphicsAnchor,
  type GraphicsDocument,
  type GraphicsFrame,
  type GraphicsImageLayer,
  type GraphicsLayer,
  type GraphicsQrLayer,
  type GraphicsScrimLayer,
  type GraphicsSpace,
} from '../../../../server/src/graphics/model'
import {
  GRAPHICS_ANCHOR_NAMES,
  graphicsCoverWarning,
  graphicsPercent,
  type GraphicsImageChoice,
  type GraphicsLayerPlacement,
  type GraphicsRead,
} from '@/videobook/graphics-model'
import type { GraphicsTemplateOutcome } from '@/videobook/useGraphicsEditor'
import { graphicsRepositionEdits } from '@/videobook/graphics-pointer'
import { CheckedText, Choice, Color, Range, Section, Select } from './GraphicsFields'
import { GraphicsTextInspector } from './GraphicsTextInspector'
import { GraphicsTimingSection } from './GraphicsTiming'

type Edit = (edits: GraphicsEdit[], coalesceKey?: string | null) => boolean

type InspectorProps = {
  document: GraphicsDocument
  layer: GraphicsLayer
  read: GraphicsRead
  imageChoices: readonly GraphicsImageChoice[]
  box: GraphicsRect | null
  placement: GraphicsLayerPlacement | null
  playhead: () => number
  disabled: boolean
  onEdit: Edit
  onFindClearSpot: () => Promise<GraphicsTemplateOutcome>
}

type PlacedLayer = Exclude<GraphicsLayer, GraphicsScrimLayer>
type QrPatch = Extract<GraphicsEdit, { op: 'set_qr' }>['qr']
type ScrimPatch = Extract<GraphicsEdit, { op: 'set_scrim' }>['scrim']

const ANCHOR_OPTIONS: ReadonlyArray<{ value: GraphicsAnchor; label: string }> = GRAPHICS_ANCHORS.map((anchor) => ({
  value: anchor,
  label: GRAPHICS_ANCHOR_NAMES[anchor].charAt(0).toUpperCase() + GRAPHICS_ANCHOR_NAMES[anchor].slice(1),
}))

const SPACE_OPTIONS: ReadonlyArray<{ value: GraphicsSpace; label: string }> = [
  { value: 'safe', label: 'Safe area' },
  { value: 'inset', label: 'Frame, inset 2%' },
  { value: 'frame', label: 'Whole frame' },
]

const KIND_TITLES: Record<GraphicsLayer['kind'], string> = { text: 'Text', image: 'Image', qr: 'QR code', scrim: 'Shade' }

function framesLabel(count: number): string {
  return count === 1 ? '1 frame' : `${count} frames`
}

function ClearSpot({ placement, disabled, onFind }: { placement: GraphicsLayerPlacement | null; disabled: boolean; onFind: () => Promise<GraphicsTemplateOutcome> }) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<GraphicsTemplateOutcome | null>(null)
  const warning = placement ? graphicsCoverWarning(placement.covers) : null
  const unchecked = placement?.unchecked ?? 0
  const find = async () => {
    setBusy(true)
    setNotice(null)
    try {
      setNotice(await onFind())
    } finally {
      setBusy(false)
    }
  }
  const paid = unchecked > 0 ? ` First finds faces and on-screen text in ${framesLabel(unchecked)} with one paid model call.` : ''
  return (
    <div className="graphics-clear-spot" role="group" aria-label="Clear spot">
      <button
        type="button"
        disabled={disabled || busy || !placement?.drawn}
        title={placement?.drawn ? `Move this layer to the anchor that covers the fewest faces and on-screen text.${paid}` : 'This layer draws nothing yet.'}
        onClick={() => void find()}
      >
        <ScanFace size={12} aria-hidden="true" />{busy ? 'Finding a clear spot…' : 'Find clear spot'}
      </button>
      {warning && <span className="graphics-clear-spot-warning">{warning} while it is shown.</span>}
      {unchecked > 0 && !busy && <span className="graphics-muted">Checks {framesLabel(unchecked)} for faces and on-screen text first, a paid model call.</span>}
      {notice && <p className="graphics-template-notice" role={notice.ok ? 'status' : 'alert'} data-tone={notice.ok ? 'info' : 'error'}>{notice.message}</p>}
    </div>
  )
}

function Place({ layer, frame, box, placement, disabled, onEdit, onFindClearSpot }: {
  layer: PlacedLayer
  frame: GraphicsFrame
  box: GraphicsRect | null
  placement: GraphicsLayerPlacement | null
  disabled: boolean
  onEdit: Edit
  onFindClearSpot: () => Promise<GraphicsTemplateOutcome>
}) {
  const { position } = layer
  const place = (anchor: GraphicsAnchor) => {
    const point = GRAPHICS_ANCHOR_POINTS[anchor]
    onEdit([{ op: 'set_position', layer_id: layer.id, position: { anchor, x: point.x, y: point.y } }])
  }
  return (
    <Section title="Place">
      <div className="graphics-place-row">
        <div className="graphics-place" role="group" aria-label="Place the layer">
          {GRAPHICS_ANCHORS.map((anchor) => {
            const point = GRAPHICS_ANCHOR_POINTS[anchor]
            const active = position.anchor === anchor && position.x === point.x && position.y === point.y
            return (
              <button
                key={anchor}
                type="button"
                aria-label={`Place ${GRAPHICS_ANCHOR_NAMES[anchor]}`}
                title={`Place ${GRAPHICS_ANCHOR_NAMES[anchor]}`}
                aria-pressed={active}
                disabled={disabled}
                onClick={() => place(anchor)}
              />
            )
          })}
        </div>
        <div className="graphics-place-fields">
          <Select label="Anchor" value={position.anchor} options={ANCHOR_OPTIONS} disabled={disabled}
            onChange={(anchor) => onEdit(graphicsRepositionEdits(frame, layer, box, { anchor }))} />
          <Select label="Within" value={position.space} options={SPACE_OPTIONS} disabled={disabled}
            onChange={(space) => onEdit(graphicsRepositionEdits(frame, layer, box, { space }))} />
        </div>
      </div>
      <p className="graphics-muted">Drag the layer in the preview, or nudge it with the arrow keys. The anchor stays put when the layer grows.</p>
      <ClearSpot placement={placement} disabled={disabled} onFind={onFindClearSpot} />
    </Section>
  )
}

function ImageFields({ layer, read, imageChoices, disabled, onEdit }: Pick<InspectorProps, 'read' | 'imageChoices' | 'disabled' | 'onEdit'> & { layer: GraphicsImageLayer }) {
  const listed = imageChoices.some((choice) => choice.artifactId === layer.artifactId)
  const options = [
    ...(listed ? [] : [{ value: layer.artifactId, label: read.images[layer.artifactId]?.label ?? 'Current image' }]),
    ...imageChoices.map((choice) => ({ value: choice.artifactId, label: `@${choice.address} · ${choice.label}` })),
  ]
  return (
    <Section title="Image">
      <Select label="Image" value={layer.artifactId} options={options} disabled={disabled}
        onChange={(artifactId) => onEdit([{ op: 'set_image', layer_id: layer.id, image: { artifactId } }])} />
      <Range label="Width" value={layer.size} min={0.02} max={1} step={0.005} format={graphicsPercent} disabled={disabled}
        onChange={(size) => onEdit([{ op: 'set_image', layer_id: layer.id, image: { size } }], `${layer.id}:size`)} />
    </Section>
  )
}

function QrFields({ layer, read, disabled, onEdit }: Pick<InspectorProps, 'read' | 'disabled' | 'onEdit'> & { layer: GraphicsQrLayer }) {
  const set = (qr: QrPatch, coalesce: string | null = null) => onEdit([{ op: 'set_qr', layer_id: layer.id, qr }], coalesce)
  const profileUrl = read.fill.profile_url
  const useLink = (source: 'profile' | 'custom') => set(source === 'profile' ? { slot: 'profile', ...(profileUrl ? { url: profileUrl } : {}) } : { slot: null })
  const setUrl = (value: string) => {
    const url = value.trim()
    set({ url, slot: url === profileUrl ? 'profile' : null }, `${layer.id}:url`)
  }
  return (
    <Section title="QR code">
      <Choice label="QR link" value={layer.slot === 'profile' ? 'profile' : 'custom'} options={['profile', 'custom'] as const}
        labels={{ profile: 'Profile link', custom: 'Custom link' }} disabled={disabled || (layer.slot === 'profile' && layer.url === '')} onChange={useLink} />
      <CheckedText label="QR URL" value={layer.url} placeholder="https://" disabled={disabled} hint="Use a full http:// or https:// link."
        accepts={(value) => isGraphicsUrl(value.trim())} onChange={setUrl} />
      {layer.url === '' && <p className="graphics-muted">Save a profile link in the watermark settings, or type a link, to draw this code.</p>}
      <Choice label="QR style" value={layer.style} options={GRAPHICS_QR_STYLES} labels={{ plain: 'Plain', tile: 'White tile' }} disabled={disabled} onChange={(style) => set({ style })} />
      <div className="graphics-colors">
        <Color label="Dark color" value={layer.dark} disabled={disabled} onChange={(dark) => set({ dark }, `${layer.id}:dark`)} />
        <Color label="Light color" value={layer.light} disabled={disabled} onChange={(light) => set({ light }, `${layer.id}:light`)} />
      </div>
      <Choice label="Error correction" value={layer.level} options={GRAPHICS_QR_LEVELS} labels={{ L: 'L 7%', M: 'M 15%', Q: 'Q 25%', H: 'H 30%' }} disabled={disabled} onChange={(level) => set({ level })} />
      <Range label="Size" value={layer.size} min={0.05} max={0.6} step={0.005} format={graphicsPercent} disabled={disabled} onChange={(size) => set({ size }, `${layer.id}:size`)} />
    </Section>
  )
}

function ScrimFields({ layer, disabled, onEdit }: { layer: GraphicsScrimLayer; disabled: boolean; onEdit: Edit }) {
  const set = (scrim: ScrimPatch, coalesce: string | null = null) => onEdit([{ op: 'set_scrim', layer_id: layer.id, scrim }], coalesce)
  return (
    <Section title="Shade">
      <Choice label="Shade edge" value={layer.edge} options={GRAPHICS_SCRIM_EDGES} labels={{ top: 'Top', bottom: 'Bottom' }} disabled={disabled} onChange={(edge) => set({ edge })} />
      <Range label="Height" value={layer.height} min={0.05} max={1} step={0.01} format={graphicsPercent} disabled={disabled} onChange={(height) => set({ height }, `${layer.id}:height`)} />
      <Range label="Strength" value={layer.strength} min={0} max={1} step={0.01} format={graphicsPercent} disabled={disabled} onChange={(strength) => set({ strength }, `${layer.id}:strength`)} />
      <Color label="Shade color" value={layer.color} disabled={disabled} onChange={(color) => set({ color }, `${layer.id}:color`)} />
    </Section>
  )
}

function KindFields(props: InspectorProps) {
  const { layer, disabled, onEdit } = props
  if (layer.kind === 'text') return <GraphicsTextInspector document={props.document} layer={layer} disabled={disabled} onEdit={onEdit} />
  if (layer.kind === 'image') return <ImageFields read={props.read} imageChoices={props.imageChoices} disabled={disabled} onEdit={onEdit} layer={layer} />
  if (layer.kind === 'qr') return <QrFields read={props.read} layer={layer} disabled={disabled} onEdit={onEdit} />
  return <ScrimFields layer={layer} disabled={disabled} onEdit={onEdit} />
}

export function GraphicsInspector(props: InspectorProps) {
  const { layer, disabled, onEdit } = props
  return (
    <div className="graphics-inspector" role="group" aria-label={`${KIND_TITLES[layer.kind]} layer ${layer.name}`} data-layer-id={layer.id}>
      <Section title={`${KIND_TITLES[layer.kind]} · ${layer.name || 'Untitled'}`}>
        <Range label="Opacity" value={layer.opacity} min={0.05} max={1} step={0.01} format={graphicsPercent} disabled={disabled}
          onChange={(opacity) => onEdit([{ op: 'set_layer', layer_id: layer.id, layer: { opacity } }], `${layer.id}:opacity`)} />
        {!layer.visible && <p className="graphics-muted">This layer is hidden, so it is not drawn or rendered.</p>}
      </Section>
      {layer.kind !== 'scrim' && (
        <Place
          layer={layer}
          frame={props.read.source}
          box={props.box}
          placement={props.placement}
          disabled={disabled}
          onEdit={onEdit}
          onFindClearSpot={props.onFindClearSpot}
        />
      )}
      <KindFields {...props} />
      <GraphicsTimingSection layer={layer} durationSeconds={props.read.source.duration_seconds} playhead={props.playhead} disabled={disabled} onEdit={onEdit} />
    </div>
  )
}
