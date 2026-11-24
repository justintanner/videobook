import { useId, useState } from 'react'
import { Plus } from 'lucide-react'
import type { GraphicsEdit } from '../../../../server/src/graphics/edits'
import { GRAPHICS_ICON_PATHS, GRAPHICS_ICON_VIEWBOX } from '../../../../server/src/graphics/icons'
import { MAX_GRAPHICS_TEXT_LENGTH, type GraphicsDocument, type GraphicsTextSlot } from '../../../../server/src/graphics/model'
import type { GraphicsSuggestKind, GraphicsSuggestLanguage } from '../../../../server/src/graphics/slots'
import { GRAPHICS_BLOCK_SLOTS, type GraphicsBlockSlot } from '../../../../server/src/graphics/starters'
import {
  graphicsFillSuggestion,
  graphicsQuickFields,
  graphicsSlotAddEdits,
  graphicsSlotHolder,
  graphicsSlotText,
  graphicsSuggestKind,
  type GraphicsQuickField,
  type GraphicsRead,
  type GraphicsSuggestionLists,
} from '@/videobook/graphics-model'
import { GraphicsSuggestControls } from './GraphicsSuggestions'

type QuickFieldsProps = {
  document: GraphicsDocument
  read: GraphicsRead
  disabled: boolean
  suggestions: GraphicsSuggestionLists
  onEdit: (edits: GraphicsEdit[], coalesceKey?: string | null) => boolean
  onSuggest: (kind: GraphicsSuggestKind, language: GraphicsSuggestLanguage) => void
  onFocusSlot?: (slot: GraphicsTextSlot | null) => void
}

function isBlockSlot(slot: GraphicsTextSlot): slot is GraphicsBlockSlot {
  return (GRAPHICS_BLOCK_SLOTS as readonly string[]).includes(slot)
}

function EmptySlot({ field, document, disabled, onAdd }: { field: GraphicsQuickField; document: GraphicsDocument; disabled: boolean; onAdd: (edits: GraphicsEdit[]) => void }) {
  const edits = isBlockSlot(field.slot) ? graphicsSlotAddEdits(document, field.slot) : []
  return (
    <div className="graphics-field graphics-field-empty" data-slot={field.slot}>
      <span className="graphics-field-empty-text">
        <span className="graphics-section-label">{field.label}</span>
        <span className="graphics-muted">Not in this look</span>
      </span>
      {edits.length > 0 && (
        <button type="button" aria-label={`Add a ${field.label.toLowerCase()} to this look`} disabled={disabled} onClick={() => onAdd(edits)}>
          <Plus size={12} aria-hidden="true" />Add
        </button>
      )}
    </div>
  )
}

function QuickField({ field, document, read, disabled, suggestions, onEdit, onSuggest, onFocusSlot, focus }: QuickFieldsProps & { field: GraphicsQuickField; focus: boolean }) {
  const { slot, label, placeholder, lines } = field
  const id = useId()
  const holder = graphicsSlotHolder(document, slot)
  const value = holder?.text ?? ''
  const suggestion = graphicsFillSuggestion(read, slot)
  const kind = graphicsSuggestKind(slot)
  const setText = (text: string, coalesce: string | null) => onEdit([{ op: 'set_slot_text', slot, text }], coalesce)
  const common = {
    id,
    value,
    placeholder,
    disabled,
    autoFocus: focus,
    maxLength: MAX_GRAPHICS_TEXT_LENGTH,
    'data-slot': slot,
    onFocus: () => onFocusSlot?.(slot),
    onBlur: () => onFocusSlot?.(null),
  }
  return (
    <div className="graphics-field">
      <div className="graphics-field-head">
        <label htmlFor={id}>{label}</label>
        {kind && (
          <GraphicsSuggestControls
            kind={kind}
            headline={graphicsSlotText(document, 'headline') ?? ''}
            busy={suggestions[slot]?.status === 'loading'}
            disabled={disabled}
            onSuggest={onSuggest}
          />
        )}
        {suggestion && suggestion !== value && (
          <button type="button" className="graphics-suggestion" disabled={disabled} onClick={() => setText(suggestion, null)}>Use {suggestion}</button>
        )}
      </div>
      <div className="graphics-field-input" data-icon={holder?.icon ? 'true' : undefined}>
        {holder?.icon && (
          <svg className="graphics-field-icon" viewBox={`0 0 ${GRAPHICS_ICON_VIEWBOX} ${GRAPHICS_ICON_VIEWBOX}`} aria-hidden="true">
            <path d={GRAPHICS_ICON_PATHS[holder.icon]} />
          </svg>
        )}
        {lines > 1
          ? <textarea {...common} rows={lines} onChange={(event) => setText(event.target.value, `slot:${slot}`)} />
          : <input {...common} type="text" onChange={(event) => setText(event.target.value, `slot:${slot}`)} />}
      </div>
    </div>
  )
}

export function GraphicsQuickFields(props: QuickFieldsProps) {
  const [added, setAdded] = useState<GraphicsTextSlot | null>(null)
  const add = (slot: GraphicsTextSlot, edits: GraphicsEdit[]) => {
    if (props.onEdit(edits)) setAdded(slot)
  }
  return (
    <div className="graphics-quick" role="group" aria-label="Quick text">
      {graphicsQuickFields(props.document).map((field) => (graphicsSlotHolder(props.document, field.slot)
        ? <QuickField key={field.slot} {...props} field={field} focus={added === field.slot} />
        : <EmptySlot key={field.slot} field={field} document={props.document} disabled={props.disabled} onAdd={(edits) => add(field.slot, edits)} />))}
    </div>
  )
}

export function GraphicsWarnings({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null
  return (
    <ul className="graphics-warnings" aria-label="Layout warnings">
      {warnings.map((warning) => <li key={warning}>{warning}</li>)}
    </ul>
  )
}
