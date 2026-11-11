import { useId } from 'react'
import type { GraphicsEdit } from '../../../../server/src/graphics/edits'
import { GRAPHICS_ICON_PATHS, GRAPHICS_ICON_VIEWBOX } from '../../../../server/src/graphics/icons'
import { MAX_GRAPHICS_TEXT_LENGTH, type GraphicsDocument, type GraphicsTextSlot } from '../../../../server/src/graphics/model'
import type { GraphicsSuggestKind, GraphicsSuggestLanguage } from '../../../../server/src/graphics/slots'
import {
  graphicsFillSuggestion,
  graphicsQuickFields,
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

function QuickField({ field, document, read, disabled, suggestions, onEdit, onSuggest, onFocusSlot }: QuickFieldsProps & { field: GraphicsQuickField }) {
  const { slot, label, placeholder, lines } = field
  const id = useId()
  const holder = graphicsSlotHolder(document, slot)
  const value = holder?.text ?? null
  const suggestion = graphicsFillSuggestion(read, slot)
  const kind = graphicsSuggestKind(slot)
  const setText = (text: string, coalesce: string | null) => onEdit([{ op: 'set_slot_text', slot, text }], coalesce)
  const common = {
    id,
    value: value ?? '',
    placeholder: value === null ? `No ${label.toLowerCase()} in this look` : placeholder,
    disabled: disabled || value === null,
    maxLength: MAX_GRAPHICS_TEXT_LENGTH,
    'data-slot': slot,
    onFocus: () => onFocusSlot?.(slot),
    onBlur: () => onFocusSlot?.(null),
  }
  return (
    <div className="graphics-field">
      <div className="graphics-field-head">
        <label htmlFor={id}>{label}</label>
        {kind && value !== null && (
          <GraphicsSuggestControls
            kind={kind}
            headline={graphicsSlotText(document, 'headline') ?? ''}
            busy={suggestions[slot]?.status === 'loading'}
            disabled={disabled}
            onSuggest={onSuggest}
          />
        )}
        {value !== null && suggestion && suggestion !== value && (
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
      {value === null && <span className="graphics-field-hint">Apply a template with a {label.toLowerCase()} to add one.</span>}
    </div>
  )
}

export function GraphicsQuickFields(props: QuickFieldsProps) {
  return (
    <div className="graphics-quick" role="group" aria-label="Quick text">
      {graphicsQuickFields(props.document).map((field) => <QuickField key={field.slot} {...props} field={field} />)}
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
