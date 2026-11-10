import { useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import type { GraphicsEdit } from '../../../../server/src/graphics/edits'
import {
  GRAPHICS_ACCENTS,
  GRAPHICS_ALIGNS,
  GRAPHICS_CASES,
  GRAPHICS_FONT_PRESETS,
  GRAPHICS_ICONS,
  GRAPHICS_TEXT_SLOTS,
  MAX_GRAPHICS_ITEMS,
  MAX_GRAPHICS_TEXT_LENGTH,
  nextGraphicsId,
  type GraphicsDocument,
  type GraphicsIcon,
  type GraphicsTextItem,
  type GraphicsTextItemInput,
  type GraphicsTextLayer,
  type GraphicsTextSlot,
} from '../../../../server/src/graphics/model'
import { GRAPHICS_SLOT_LABELS, graphicsPercent } from '@/videobook/graphics-model'
import { Choice, Color, Range, Section, Select, Toggle } from './GraphicsFields'

type Edit = (edits: GraphicsEdit[], coalesceKey?: string | null) => boolean
type BlockPatch = Extract<GraphicsEdit, { op: 'set_text_block' }>['block']
type PlatePatch = NonNullable<BlockPatch['plate']>

const ICON_NAMES: Record<GraphicsIcon, string> = { camera: 'Camera', link: 'Link', music: 'Music', pin: 'Pin', tiktok: 'TikTok', x: 'X' }
const ICON_OPTIONS: ReadonlyArray<{ value: GraphicsIcon | 'none'; label: string }> = [
  { value: 'none', label: 'No icon' },
  ...GRAPHICS_ICONS.map((icon) => ({ value: icon, label: ICON_NAMES[icon] })),
]
const SLOT_OPTIONS: ReadonlyArray<{ value: GraphicsTextSlot | 'none'; label: string }> = [
  { value: 'none', label: 'None' },
  ...GRAPHICS_TEXT_SLOTS.map((slot) => ({ value: slot, label: GRAPHICS_SLOT_LABELS[slot] })),
]
const LINE_OPTIONS = ['1', '2', '3', '4', '5', '6'].map((value) => ({ value, label: value }))

function Block({ layer, disabled, onEdit }: { layer: GraphicsTextLayer; disabled: boolean; onEdit: Edit }) {
  const setBlock = (block: BlockPatch, coalesce: string | null = null) => onEdit([{ op: 'set_text_block', layer_id: layer.id, block }], coalesce)
  const setPlate = (plate: PlatePatch, field: string) => setBlock({ plate }, `${layer.id}:plate-${field}`)
  const { plate } = layer
  return (
    <Section title="Block">
      <Range label="Width" value={layer.width} min={0.1} max={1} step={0.01} format={graphicsPercent} disabled={disabled}
        onChange={(width) => setBlock({ width }, `${layer.id}:width`)} />
      <Choice label="Align" value={layer.align} options={GRAPHICS_ALIGNS} labels={{ left: 'Left', center: 'Center', right: 'Right' }} disabled={disabled}
        onChange={(align) => setBlock({ align })} />
      <Range label="Gap" value={layer.gap} min={0} max={0.1} step={0.001} format={graphicsPercent} disabled={disabled}
        onChange={(gap) => setBlock({ gap }, `${layer.id}:gap`)} />
      <Toggle label="Backing plate" checked={plate !== null} disabled={disabled} onChange={(on) => setBlock({ plate: on ? {} : null })} />
      {plate && (
        <div className="graphics-subfields">
          <div className="graphics-colors">
            <Color label="Plate color" value={plate.color} disabled={disabled} onChange={(color) => setPlate({ color }, 'color')} />
          </div>
          <Range label="Plate opacity" value={plate.opacity} min={0} max={1} step={0.01} format={graphicsPercent} disabled={disabled}
            onChange={(opacity) => setPlate({ opacity }, 'opacity')} />
          <Range label="Padding across" value={plate.paddingX} min={0} max={0.2} step={0.001} format={graphicsPercent} disabled={disabled}
            onChange={(paddingX) => setPlate({ paddingX }, 'padding-x')} />
          <Range label="Padding down" value={plate.paddingY} min={0} max={0.2} step={0.001} format={graphicsPercent} disabled={disabled}
            onChange={(paddingY) => setPlate({ paddingY }, 'padding-y')} />
          <Range label="Corner rounding" value={plate.radius} min={0} max={1} step={0.01} format={graphicsPercent} disabled={disabled}
            onChange={(radius) => setPlate({ radius }, 'radius')} />
          <Toggle label="Plate border" checked={plate.border} disabled={disabled} onChange={(border) => setPlate({ border }, 'border')} />
        </div>
      )}
    </Section>
  )
}

function ItemFields({ layer, item, disabled, onEdit }: { layer: GraphicsTextLayer; item: GraphicsTextItem; disabled: boolean; onEdit: Edit }) {
  const set = (patch: GraphicsTextItemInput, field: string | null = null) => {
    onEdit([{ op: 'set_item', layer_id: layer.id, item_id: item.id, item: patch }], field ? `${layer.id}:${item.id}:${field}` : null)
  }
  return (
    <div className="graphics-item-fields" data-item-id={item.id}>
      <label className="graphics-field">
        <span>Text</span>
        <textarea aria-label="Item text" rows={2} value={item.text} maxLength={MAX_GRAPHICS_TEXT_LENGTH} disabled={disabled}
          onChange={(event) => set({ text: event.target.value }, 'text')} />
      </label>
      <div className="graphics-pair">
        <Select label="Slot" value={item.slot ?? 'none'} options={SLOT_OPTIONS} disabled={disabled} onChange={(slot) => set({ slot: slot === 'none' ? null : slot })} />
        <Select label="Icon" value={item.icon ?? 'none'} options={ICON_OPTIONS} disabled={disabled} onChange={(icon) => set({ icon: icon === 'none' ? null : icon })} />
      </div>
      <Choice label="Font" value={item.font} options={GRAPHICS_FONT_PRESETS} labels={{ heavy: 'Heavy', display: 'Display', text: 'Text' }} disabled={disabled}
        onChange={(font) => set({ font })} />
      <Range label="Text size" value={item.size} min={0.01} max={0.3} step={0.001} format={graphicsPercent} disabled={disabled}
        onChange={(size) => set({ size }, 'size')} />
      <div className="graphics-pair">
        <Color label="Text color" value={item.color} disabled={disabled} onChange={(color) => set({ color }, 'color')} />
        <Select label="Max lines" value={String(item.maxLines)} options={LINE_OPTIONS} disabled={disabled} onChange={(lines) => set({ maxLines: Number(lines) })} />
      </div>
      <Choice label="Case" value={item.case} options={GRAPHICS_CASES} labels={{ none: 'As typed', upper: 'UPPERCASE' }} disabled={disabled}
        onChange={(value) => set({ case: value })} />
      <Choice label="Accent" value={item.accent} options={GRAPHICS_ACCENTS} labels={{ none: 'No accent', underline: 'Underline', brush: 'Brush' }} disabled={disabled}
        onChange={(accent) => set({ accent })} />
      <div className="graphics-switches">
        <Toggle label="Outline" checked={item.outline} disabled={disabled} onChange={(outline) => set({ outline })} />
        <Toggle label="Shadow" checked={item.shadow} disabled={disabled} onChange={(shadow) => set({ shadow })} />
      </div>
    </div>
  )
}

function itemName(item: GraphicsTextItem): string {
  return item.slot ? GRAPHICS_SLOT_LABELS[item.slot] : 'Text'
}

function Items({ document, layer, disabled, onEdit }: { document: GraphicsDocument; layer: GraphicsTextLayer; disabled: boolean; onEdit: Edit }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const item = layer.items.find((entry) => entry.id === selectedId) ?? layer.items[0]
  const index = layer.items.indexOf(item)
  const add = () => {
    const itemId = nextGraphicsId(document.nextId, 't').id
    if (onEdit([{ op: 'add_item', layer_id: layer.id, item: { text: 'Text', size: item.size, font: item.font, color: item.color }, index: index + 1 }])) setSelectedId(itemId)
  }
  const move = (to: number) => onEdit([{ op: 'move_item', layer_id: layer.id, item_id: item.id, index: to }])
  const remove = () => {
    const next = layer.items[index + 1] ?? layer.items[index - 1]
    if (onEdit([{ op: 'remove_item', layer_id: layer.id, item_id: item.id }])) setSelectedId(next?.id ?? null)
  }
  return (
    <Section title={`Text items ${layer.items.length}/${MAX_GRAPHICS_ITEMS}`}>
      <ol className="graphics-item-list">
        {layer.items.map((entry, at) => (
          <li key={entry.id}>
            <button type="button" className="graphics-item-name" aria-pressed={entry.id === item.id} aria-label={`Edit item ${at + 1}, ${itemName(entry)}`}
              onClick={() => setSelectedId(entry.id)}>
              <span className="graphics-item-index">{at + 1}</span>
              <span className="graphics-layer-title">{itemName(entry)}</span>
              <span className="graphics-layer-summary">{entry.text.replace(/\s+/gu, ' ').trim() || 'Empty'}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="graphics-item-actions">
        <button type="button" aria-label="Add text item" disabled={disabled || layer.items.length >= MAX_GRAPHICS_ITEMS} onClick={add}><Plus size={12} aria-hidden="true" />Item</button>
        <button type="button" className="graphics-icon-button" aria-label="Move item up" title="Move up" disabled={disabled || index === 0} onClick={() => move(index - 1)}>
          <ArrowUp size={13} aria-hidden="true" />
        </button>
        <button type="button" className="graphics-icon-button" aria-label="Move item down" title="Move down" disabled={disabled || index === layer.items.length - 1} onClick={() => move(index + 1)}>
          <ArrowDown size={13} aria-hidden="true" />
        </button>
        <button type="button" className="graphics-icon-button" aria-label="Remove item" title="Remove item" disabled={disabled || layer.items.length === 1} onClick={remove}>
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
      <ItemFields layer={layer} item={item} disabled={disabled} onEdit={onEdit} />
    </Section>
  )
}

export function GraphicsTextInspector({ document, layer, disabled, onEdit }: { document: GraphicsDocument; layer: GraphicsTextLayer; disabled: boolean; onEdit: Edit }) {
  return (
    <>
      <Block layer={layer} disabled={disabled} onEdit={onEdit} />
      <Items key={layer.id} document={document} layer={layer} disabled={disabled} onEdit={onEdit} />
    </>
  )
}
