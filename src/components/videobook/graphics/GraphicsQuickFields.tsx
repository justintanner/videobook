import { useId } from 'react'
import type { GraphicsEdit } from '../../../../server/src/graphics/edits'
import { MAX_GRAPHICS_TEXT_LENGTH, type GraphicsDocument, type GraphicsTextSlot } from '../../../../server/src/graphics/model'
import type { GraphicsSuggestKind, GraphicsSuggestLanguage } from '../../../../server/src/graphics/slots'
import {
  GRAPHICS_QUICK_FIELDS,
  graphicsFillSuggestion,
  graphicsSlotText,
  graphicsSuggestKind,
  type GraphicsRead,
  type GraphicsSuggestionLists,
} from '@/videobook/graphics-model'
import { GraphicsSuggestControls, GraphicsSuggestionPicker } from './GraphicsSuggestions'

type QuickFieldsProps = {
  document: GraphicsDocument
  read: GraphicsRead
  disabled: boolean
  suggestions: GraphicsSuggestionLists
  onEdit: (edits: GraphicsEdit[], coalesceKey?: string | null) => boolean
  onSuggest: (kind: GraphicsSuggestKind, language: GraphicsSuggestLanguage) => void
  onDismissSuggestions: (slot: GraphicsTextSlot) => void
}

function QuickField({ slot, label, placeholder, lines, document, read, disabled, suggestions, onEdit, onSuggest, onDismissSuggestions }: QuickFieldsProps & { slot: GraphicsTextSlot; label: string; placeholder: string; lines: number }) {
  const id = useId()
  const value = graphicsSlotText(document, slot)
  const suggestion = graphicsFillSuggestion(read, slot)
  const kind = graphicsSuggestKind(slot)
  const list = suggestions[slot]
  const setText = (text: string, coalesce: string | null) => onEdit([{ op: 'set_slot_text', slot, text }], coalesce)
  const common = {
    id,
    value: value ?? '',
    placeholder: value === null ? `No ${label.toLowerCase()} in this look` : placeholder,
    disabled: disabled || value === null,
    maxLength: MAX_GRAPHICS_TEXT_LENGTH,
    'data-slot': slot,
  }
  return (
    <div className="graphics-field">
      <div className="graphics-field-head">
        <label htmlFor={id}>{label}</label>
        {kind && value !== null && (
          <GraphicsSuggestControls
            kind={kind}
            headline={graphicsSlotText(document, 'headline') ?? ''}
            busy={list?.status === 'loading'}
            disabled={disabled}
            onSuggest={onSuggest}
          />
        )}
      </div>
      {lines > 1
        ? <textarea {...common} rows={lines} onChange={(event) => setText(event.target.value, `slot:${slot}`)} />
        : <input {...common} type="text" onChange={(event) => setText(event.target.value, `slot:${slot}`)} />}
      {value === null && <span className="graphics-field-hint">Apply a template with a {label.toLowerCase()} to add one.</span>}
      {value !== null && suggestion && suggestion !== value && (
        <button type="button" className="graphics-suggestion" disabled={disabled} onClick={() => setText(suggestion, null)}>Use {suggestion}</button>
      )}
      {list && (
        <GraphicsSuggestionPicker
          list={list}
          label={label}
          value={value}
          disabled={disabled || value === null}
          onPick={(option) => setText(option, null)}
          onDismiss={() => onDismissSuggestions(slot)}
        />
      )}
    </div>
  )
}

export function GraphicsQuickFields(props: QuickFieldsProps) {
  return (
    <div className="graphics-quick" role="group" aria-label="Quick text">
      {GRAPHICS_QUICK_FIELDS.map((field) => <QuickField key={field.slot} {...props} {...field} />)}
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
