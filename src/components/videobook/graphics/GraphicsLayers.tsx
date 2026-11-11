import { useRef, useState, type KeyboardEvent } from 'react'
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

type Edit = (edits: GraphicsEdit[], coalesceKey?: string | null) => boolean

type LayersProps = {
  document: GraphicsDocument
  read: GraphicsRead
  imageChoices: readonly GraphicsImageChoice[]
  selectedLayerId: string | null
  warnings: Readonly<Record<string, string>>
  disabled: boolean
  onEdit: Edit
  onSelect: (layerId: string | null) => void
}

const KIND_ICONS: Record<GraphicsLayerKind, LucideIcon> = { text: Type, image: Image, qr: QrCode, scrim: Blend }
const ADD_LABELS: Record<GraphicsAddKind, string> = { text: 'Text', image: 'Image', qr: 'QR code', scrim: 'Shade' }
const ADD_NAMES: Record<GraphicsAddKind, string> = { text: 'Add text layer', image: 'Add image layer', qr: 'Add QR code layer', scrim: 'Add shade layer' }
const ADD_KINDS: readonly GraphicsAddKind[] = ['text', 'image', 'qr', 'scrim']

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

function LayerRow({ layer, index, props }: { layer: GraphicsLayer; index: number; props: LayersProps }) {
  const { document, read, imageChoices, selectedLayerId, warnings, disabled, onEdit, onSelect } = props
  const [renaming, setRenaming] = useState(false)
  const selected = layer.id === selectedLayerId
  const warning = warnings[layer.id]
  const Icon = KIND_ICONS[layer.kind]
  const toggle = () => onEdit([{ op: 'set_layer', layer_id: layer.id, layer: { visible: !layer.visible } }])
  return (
    <li className="graphics-layer-row" data-layer-id={layer.id} data-selected={selected ? 'true' : undefined} data-hidden={layer.visible ? undefined : 'true'}>
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

export function GraphicsLayers(props: LayersProps) {
  const { document, read, imageChoices, disabled, onEdit, onSelect } = props
  const [picking, setPicking] = useState(false)
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
        ? <p className="graphics-muted">No layers yet. Add one, or apply a starter.</p>
        : <ol className="graphics-layer-list">{rows.map(({ layer, index }) => <LayerRow key={layer.id} layer={layer} index={index} props={props} />)}</ol>}
    </section>
  )
}
