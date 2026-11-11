import { useState } from 'react'
import { Languages, Sparkles, X } from 'lucide-react'
import {
  GRAPHICS_SUGGEST_LANGUAGE_NAMES,
  GRAPHICS_SUGGEST_LANGUAGES,
  graphicsSuggestLanguage,
  type GraphicsSuggestKind,
  type GraphicsSuggestLanguage,
} from '../../../../server/src/graphics/slots'
import type { GraphicsSuggestionList } from '@/videobook/graphics-model'

type Suggest = (kind: GraphicsSuggestKind, language: GraphicsSuggestLanguage) => void

const PAID = 'Uses one paid model call; nothing changes until you pick an option.'

function HeadlineSuggest({ busy, disabled, onSuggest }: { busy: boolean; disabled: boolean; onSuggest: Suggest }) {
  const [language, setLanguage] = useState<GraphicsSuggestLanguage>(() => graphicsSuggestLanguage('headline', ''))
  return (
    <div className="graphics-assist-row">
      <div className="graphics-segmented" role="group" aria-label="Headline language">
        {GRAPHICS_SUGGEST_LANGUAGES.map((choice) => (
          <button key={choice} type="button" aria-pressed={choice === language} disabled={disabled || busy} onClick={() => setLanguage(choice)}>
            {GRAPHICS_SUGGEST_LANGUAGE_NAMES[choice]}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="graphics-assist"
        disabled={disabled || busy}
        title={`Write headline options from this video's analysis, transcript and download text. ${PAID}`}
        onClick={() => onSuggest('headline', language)}
      >
        <Sparkles size={12} aria-hidden="true" />
        {busy ? 'Suggesting…' : 'Suggest'}
      </button>
    </div>
  )
}

function TranslateHeadline({ headline, busy, disabled, onSuggest }: { headline: string; busy: boolean; disabled: boolean; onSuggest: Suggest }) {
  const target = graphicsSuggestLanguage('translate', headline)
  const empty = headline.trim() === ''
  return (
    <button
      type="button"
      className="graphics-assist"
      disabled={disabled || busy || empty}
      title={empty ? 'Type or pick a headline first.' : `Translate the headline for this line. ${PAID}`}
      onClick={() => onSuggest('translate', target)}
    >
      <Languages size={12} aria-hidden="true" />
      {busy ? 'Translating…' : `Translate to ${GRAPHICS_SUGGEST_LANGUAGE_NAMES[target]}`}
    </button>
  )
}

export function GraphicsSuggestControls({ kind, headline, busy, disabled, onSuggest }: {
  kind: GraphicsSuggestKind
  headline: string
  busy: boolean
  disabled: boolean
  onSuggest: Suggest
}) {
  return kind === 'translate'
    ? <TranslateHeadline headline={headline} busy={busy} disabled={disabled} onSuggest={onSuggest} />
    : <HeadlineSuggest busy={busy} disabled={disabled} onSuggest={onSuggest} />
}

function heading(list: GraphicsSuggestionList): string {
  const language = GRAPHICS_SUGGEST_LANGUAGE_NAMES[list.language]
  const translate = list.kind === 'translate'
  if (list.status === 'loading') return translate ? `Translating into ${language}…` : `Writing headlines in ${language}…`
  if (list.status === 'error') return translate ? 'No translation' : 'No headlines'
  return translate ? `Pick a line in ${language}` : `Pick a headline in ${language}`
}

export function GraphicsSuggestionPicker({ list, label, value, disabled, onPick, onDismiss }: {
  list: GraphicsSuggestionList
  label: string
  value: string | null
  disabled: boolean
  onPick: (option: string) => void
  onDismiss: () => void
}) {
  return (
    <div className="graphics-suggestions" role="group" aria-label={`${label} suggestions`} aria-busy={list.status === 'loading'}>
      <div className="graphics-suggestions-head">
        <span role="status">{heading(list)}</span>
        <button type="button" className="graphics-suggestions-close" aria-label={`Hide ${label.toLowerCase()} suggestions`} onClick={onDismiss}>
          <X size={12} aria-hidden="true" />
        </button>
      </div>
      {list.status === 'error' && <p className="graphics-suggestions-error" role="alert">{list.message}</p>}
      {list.status === 'ready' && (
        <ul className="graphics-suggestion-options">
          {list.options.map((option) => (
            <li key={option}>
              <button type="button" aria-pressed={option === value} disabled={disabled} onClick={() => onPick(option)}>{option}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
