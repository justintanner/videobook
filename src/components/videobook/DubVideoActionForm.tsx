import { useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from 'react'
import { ArrowLeft, ChevronDown, Languages, LoaderCircle, Search, TriangleAlert, X } from 'lucide-react'
import { DUB_VIDEO_MAX_LANGUAGES, type DubQuality } from '../../../server/src/dub-video-contract'
import {
  dubClock,
  dubMoney,
  dubRate,
  dubSlashCommand,
  filterDubLanguages,
  toggleDubLanguage,
  type DubFormDraft,
  type DubPrice,
} from '@/videobook/dub-video-form'
import type { ActionChoice } from '@/videobook/workspace-actions'
import './DubVideoActionForm.css'

type DubSourceMedia = { url: string | null; duration?: number | null }
type DubChange = (name: string, value: unknown) => void
type MenuPlacement = { top?: number; bottom?: number; left: number; width: number; height: number }

export type DubVideoActionFormProps = {
  draft: DubFormDraft
  assetId: string
  address: string | null
  catalog: readonly string[]
  sources: readonly ActionChoice[]
  media: DubSourceMedia | null
  price: DubPrice
  priceNote: string | null
  busy: boolean
  onChange: DubChange
  onBack: () => void
}

const SPEAKER_COUNTS = Array.from({ length: 10 }, (_, index) => index + 1)
const MENU_GAP = 4
const MENU_EDGE = 12
const MENU_MAX_HEIGHT = 340
const MENU_MIN_WIDTH = 360

function writeLanguages(onChange: DubChange, languages: readonly string[], unknown: readonly string[]) {
  onChange('language', [...languages, ...unknown])
}

function sourceDuration(media: DubSourceMedia | null): number | null {
  return typeof media?.duration === 'number' && media.duration > 0 ? media.duration : null
}

function menuPlacement(trigger: HTMLElement): MenuPlacement {
  const rect = trigger.getBoundingClientRect()
  const width = Math.min(Math.max(rect.width, MENU_MIN_WIDTH), window.innerWidth - MENU_EDGE * 2)
  const left = Math.max(MENU_EDGE, Math.min(rect.left, window.innerWidth - width - MENU_EDGE))
  const below = window.innerHeight - rect.bottom - MENU_GAP - MENU_EDGE
  const above = rect.top - MENU_GAP - MENU_EDGE
  if (below >= 240 || below >= above) return { top: rect.bottom + MENU_GAP, left, width, height: Math.min(MENU_MAX_HEIGHT, below) }
  return { bottom: window.innerHeight - rect.top + MENU_GAP, left, width, height: Math.min(MENU_MAX_HEIGHT, above) }
}

function showMenu(node: HTMLDivElement | null) {
  if (!node || typeof node.showPopover !== 'function' || node.matches(':popover-open')) return
  node.showPopover()
  node.querySelector('input')?.focus({ preventScroll: true })
}

function breakdown(draft: DubFormDraft, duration: number | null): string {
  return [String(draft.languages.length), duration ? dubClock(duration) : null, dubRate(draft.quality)].filter(Boolean).join(' × ')
}

function DubPriceStatus({ draft, price, priceNote, duration }: { draft: DubFormDraft; price: DubPrice; priceNote: string | null; duration: number | null }) {
  if (price.state === 'empty') return <span className="dub-form-price">Pick a language to see the price</span>
  if (price.state === 'estimating') {
    return <span className="dub-form-price" role="status"><LoaderCircle size={13} className="dub-form-spin" aria-hidden="true" />Estimating price…</span>
  }
  if (price.state === 'unavailable') {
    const note = priceNote ?? 'The dub price is unavailable.'
    return <span className="dub-form-price dub-form-price-error" role="alert" title={note}><TriangleAlert size={13} aria-hidden="true" /><span>{note}</span></span>
  }
  return <span className="dub-form-price" role="status" title="HeyGen bills by output length, so the final price can be higher.">
    <span>{breakdown(draft, duration)}</span><small>at least</small><strong>{dubMoney(price.usd)}</strong>
  </span>
}

function DubHeading({ address, draft, price, priceNote, duration, busy, onBack }: {
  address: string | null
  draft: DubFormDraft
  price: DubPrice
  priceNote: string | null
  duration: number | null
  busy: boolean
  onBack: () => void
}) {
  return <div className="dub-form-heading">
    <button type="button" className="dub-form-back" disabled={busy} onClick={onBack}><ArrowLeft size={13} aria-hidden="true" />All actions</button>
    <span className="dub-form-command"><small>Same as</small><code>{dubSlashCommand(address, draft)}</code></span>
    <DubPriceStatus draft={draft} price={price} priceNote={priceNote} duration={duration} />
  </div>
}

function DubSource({ assetId, address, sources, media, busy, onChange }: {
  assetId: string
  address: string | null
  sources: readonly ActionChoice[]
  media: DubSourceMedia | null
  busy: boolean
  onChange: DubChange
}) {
  const duration = sourceDuration(media)
  return <div className="dub-form-source">
    <div className="dub-form-label-row">
      <label className="dub-form-label" htmlFor="dub-form-source">Source</label>
      {duration && <span>{dubClock(duration)}</span>}
    </div>
    <div className="dub-form-preview" title="The source stays as it is. Each language becomes a new video beside it.">
      {media?.url
        ? <video src={media.url} preload="metadata" muted playsInline controls aria-label={`Preview ${address ?? 'source video'}`} />
        : <span>No preview</span>}
    </div>
    <select id="dub-form-source" value={assetId} disabled={busy} onChange={(event) => onChange('asset_id', event.target.value)}>
      {!sources.some((choice) => choice.value === assetId) && <option value={assetId}>{assetId || 'Choose a video'}</option>}
      {sources.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
    </select>
  </div>
}

function DubLanguageMenu({ catalog, draft, placement, onToggle, onClose }: {
  catalog: readonly string[]
  draft: DubFormDraft
  placement: MenuPlacement
  onToggle: (language: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const matches = filterDubLanguages(catalog, query)
  const full = draft.languages.length >= DUB_VIDEO_MAX_LANGUAGES
  const style: CSSProperties = { top: placement.top, bottom: placement.bottom, left: placement.left, width: placement.width, height: placement.height }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement) || event.target.type !== 'search') return
    event.preventDefault()
    event.stopPropagation()
    if (matches[0]) onToggle(matches[0])
  }
  return <div ref={showMenu} popover="manual" className="dub-form-menu" role="group" aria-label="Choose languages" tabIndex={-1}
    style={style} onKeyDown={onKeyDown}>
    <label className="dub-form-search"><Search size={13} aria-hidden="true" />
      <input type="search" aria-label="Search languages" placeholder={`Search ${catalog.length} languages`} value={query}
        autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
    </label>
    <div className="dub-form-options">
      {matches.map((language) => {
        const checked = draft.languages.includes(language)
        return <label key={language} className="dub-form-option" title={language}>
          <input type="checkbox" checked={checked} disabled={!checked && full} onChange={() => onToggle(language)} />
          <span>{language}</span>
        </label>
      })}
      {!matches.length && <p>No language matches “{query}”.</p>}
    </div>
    <div className="dub-form-menu-foot">
      <span>{draft.languages.length} / {DUB_VIDEO_MAX_LANGUAGES} picked · up to {DUB_VIDEO_MAX_LANGUAGES} per dub</span>
      <button type="button" onClick={onClose}>Done</button>
    </div>
  </div>
}

function rowPrice(price: DubPrice, count: number): string {
  if (price.state === 'estimating') return '…'
  return price.state === 'quoted' && count > 0 ? dubMoney(price.usd / count) : ''
}

function DubLanguageRows({ draft, price, busy, onChange }: { draft: DubFormDraft; price: DubPrice; busy: boolean; onChange: DubChange }) {
  const each = rowPrice(price, draft.languages.length)
  if (!draft.languages.length && !draft.unknown.length) {
    return <p className="dub-form-rows dub-form-empty">No languages yet. Open the dropdown and pick up to {DUB_VIDEO_MAX_LANGUAGES}. Each one becomes its own video.</p>
  }
  return <ol className="dub-form-rows" aria-label="Languages to dub">
    {draft.languages.map((language, index) => <li key={language}>
      <span className="dub-form-row-index">{index + 1}</span>
      <span className="dub-form-row-name">{language}</span>
      <small>new video</small>
      <span className="dub-form-row-price">{each}</span>
      <button type="button" aria-label={`Remove ${language}`} disabled={busy}
        onClick={() => writeLanguages(onChange, draft.languages.filter((entry) => entry !== language), draft.unknown)}><X size={13} /></button>
    </li>)}
    {draft.unknown.map((text) => <li key={`unknown:${text}`} className="dub-form-row-unknown">
      <TriangleAlert size={13} aria-hidden="true" />
      <span className="dub-form-row-name">{text}</span>
      <small>not a HeyGen language</small>
      <button type="button" aria-label={`Remove ${text}`} disabled={busy}
        onClick={() => writeLanguages(onChange, draft.languages, draft.unknown.filter((entry) => entry !== text))}><X size={13} /></button>
    </li>)}
  </ol>
}

function comboText(count: number): string {
  if (count >= DUB_VIDEO_MAX_LANGUAGES) return `${DUB_VIDEO_MAX_LANGUAGES} of ${DUB_VIDEO_MAX_LANGUAGES} picked · remove one to add another`
  return count ? 'Add another language' : 'Choose languages'
}

function DubLanguages({ draft, catalog, price, busy, onChange }: {
  draft: DubFormDraft
  catalog: readonly string[]
  price: DubPrice
  busy: boolean
  onChange: DubChange
}) {
  const [placement, setPlacement] = useState<MenuPlacement | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const count = draft.languages.length
  const close = (refocus: boolean) => {
    setPlacement(null)
    if (refocus) trigger.current?.focus({ preventScroll: true })
  }
  const toggle = () => {
    if (placement || !trigger.current) setPlacement(null)
    else setPlacement(menuPlacement(trigger.current))
  }
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (placement && !event.currentTarget.contains(event.relatedTarget as Node | null)) close(false)
  }
  return <div className="dub-form-languages" onBlur={onBlur}>
    <div className="dub-form-label-row">
      <span className="dub-form-label" id="dub-form-languages-label">Languages</span>
      <span>{count} / {DUB_VIDEO_MAX_LANGUAGES}</span>
      {(count > 0 || draft.unknown.length > 0) && <button type="button" className="dub-form-link" disabled={busy}
        onClick={() => onChange('language', [])}>Clear all</button>}
    </div>
    <button ref={trigger} type="button" className="dub-form-combo" aria-haspopup="true" aria-expanded={placement !== null}
      aria-labelledby="dub-form-languages-label" disabled={busy || !catalog.length} onClick={toggle}>
      <Languages size={14} aria-hidden="true" />
      <span>{catalog.length ? comboText(count) : 'Loading languages…'}</span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {placement && <DubLanguageMenu catalog={catalog} draft={draft} placement={placement} onClose={() => close(true)}
      onToggle={(language) => writeLanguages(onChange, toggleDubLanguage(draft.languages, language), draft.unknown)} />}
    <DubLanguageRows draft={draft} price={price} busy={busy} onChange={onChange} />
  </div>
}

function Segmented<Value extends string>({ id, label, value, options, busy, onPick }: {
  id: string
  label: string
  value: Value
  options: readonly { value: Value; label: string; detail?: string; hint: string }[]
  busy: boolean
  onPick: (value: Value) => void
}) {
  return <div className="dub-form-setting" role="group" aria-labelledby={id}>
    <span className="dub-form-label" id={id}>{label}</span>
    <div className="dub-form-segmented">
      {options.map((option) => <button key={option.value} type="button" aria-pressed={option.value === value} disabled={busy}
        title={option.hint} onClick={() => onPick(option.value)}>{option.label}{option.detail && <small>{option.detail}</small>}</button>)}
    </div>
  </div>
}

const QUALITY_OPTIONS: readonly { value: DubQuality; label: string; detail: string; hint: string }[] = [
  { value: 'speed', label: 'Speed', detail: dubRate('speed'), hint: 'Default tier.' },
  { value: 'precision', label: 'Precision', detail: dubRate('precision'), hint: 'Better lip sync at twice the rate.' },
]

const LIP_OPTIONS = [
  { value: 'sync', label: 'Lip sync', hint: 'Re-syncs mouths to the new speech.' },
  { value: 'voice', label: 'Voice only', hint: 'Swaps the voice. Lips stay as filmed.' },
] as const

function DubSettings({ draft, busy, onChange }: { draft: DubFormDraft; busy: boolean; onChange: DubChange }) {
  return <div className="dub-form-settings">
    <Segmented id="dub-form-quality" label="Quality" value={draft.quality} options={QUALITY_OPTIONS} busy={busy}
      onPick={(quality) => onChange('quality', quality)} />
    <Segmented id="dub-form-lips" label="Lips" value={draft.lipSync ? 'sync' : 'voice'} options={LIP_OPTIONS} busy={busy}
      onPick={(lips) => onChange('lip_sync', lips === 'sync')} />
    <div className="dub-form-pair">
      <label className="dub-form-label" htmlFor="dub-form-speakers">Speakers</label>
      <span className="dub-form-label">Length</span>
      <select id="dub-form-speakers" value={draft.speakers ?? ''} disabled={busy}
        onChange={(event) => onChange('speakers', event.target.value ? Number(event.target.value) : undefined)}>
        <option value="">Auto</option>
        {SPEAKER_COUNTS.map((count) => <option key={count} value={count}>{count}</option>)}
      </select>
      <label className="dub-form-check" title="HeyGen may stretch or shorten the video to fit the translated speech. You pay for the output length.">
        <input type="checkbox" checked={draft.dynamicDuration} disabled={busy}
          onChange={(event) => onChange('dynamic_duration', event.target.checked ? true : undefined)} />
        Fit to speech
      </label>
    </div>
  </div>
}

export function DubVideoActionForm({ draft, assetId, address, catalog, sources, media, price, priceNote, busy, onChange, onBack }: DubVideoActionFormProps) {
  return <>
    <DubHeading address={address} draft={draft} price={price} priceNote={priceNote} duration={sourceDuration(media)} busy={busy} onBack={onBack} />
    <div className="dub-form-columns">
      <DubSource assetId={assetId} address={address} sources={sources} media={media} busy={busy} onChange={onChange} />
      <DubLanguages draft={draft} catalog={catalog} price={price} busy={busy} onChange={onChange} />
      <DubSettings draft={draft} busy={busy} onChange={onChange} />
    </div>
  </>
}
