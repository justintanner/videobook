import type { ChangeEvent, ReactNode } from 'react'
import type { CaptionEdit } from '../../../../server/src/captions/edits'
import { DEFAULT_CAPTION_POSITIONS } from '../../../../server/src/captions/layout'
import {
  CAPTION_ASPECTS,
  CAPTION_FONT_SCALE_RANGE,
  CAPTION_MOTIONS,
  CAPTION_OUTLINE_RANGE,
  CAPTION_PRESETS,
  MAX_CAPTION_OFFSET_MS,
  type CaptionAspect,
  type CaptionDocument,
  type CaptionStyle,
} from '../../../../server/src/captions/model'
import { SUBTITLE_LANGUAGE_NAMES } from '../../../../server/src/subtitle-languages'
import type { SubtitlePositionTarget } from './SubtitlesPreview'

type Edit = (edits: CaptionEdit[], coalesce?: string | null) => boolean

type SubtitlesControlsProps = {
  document: CaptionDocument
  language: string
  regionsStatus: string | null
  selectedPhraseId: string | null
  positionTarget: SubtitlePositionTarget
  guides: boolean
  disabled: boolean
  onEdit: Edit
  onLanguage: (language: string) => void
  onPositionTarget: (target: SubtitlePositionTarget) => void
  onGuides: (guides: boolean) => void
  onAnalyzeRegions: () => void
}

const PRESET_LABELS: Record<CaptionStyle['preset'], string> = { karaoke: 'Karaoke', stack: 'Stack', punch: 'Punch' }
const MOTION_LABELS: Record<CaptionStyle['motion'], string> = { pop: 'Pop', slam: 'Slam', rise: 'Rise' }

function Segmented<T extends string>({ label, value, options, labels, disabled, onChange }: {
  label: string
  value: T
  options: readonly T[]
  labels: Record<T, string>
  disabled: boolean
  onChange: (value: T) => void
}) {
  return (
    <div className="subtitles-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option} type="button" aria-pressed={option === value} disabled={disabled} onClick={() => onChange(option)}>
          {labels[option]}
        </button>
      ))}
    </div>
  )
}

function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="subtitles-switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="subtitles-field">
      <span>{label}</span>
      {children}
    </label>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="subtitles-group" aria-label={title}>
      <span className="confirm-section-label">{title}</span>
      {children}
    </section>
  )
}

function positionValue(document: CaptionDocument, target: SubtitlePositionTarget, phraseId: string | null): { value: number; explicit: boolean } {
  const aspect = document.aspect
  const global = document.positions[aspect]
  if (target === 'phrase' && phraseId) {
    const own = document.phrases.find((phrase) => phrase.id === phraseId)?.positions[aspect]
    if (own !== undefined) return { value: own, explicit: true }
  }
  if (target === 'all' && global !== undefined) return { value: global, explicit: true }
  return { value: global ?? DEFAULT_CAPTION_POSITIONS[aspect], explicit: false }
}

export function SubtitlesControls(props: SubtitlesControlsProps) {
  const { document, disabled, onEdit, selectedPhraseId, positionTarget } = props
  const style = document.style
  const setStyle = (patch: Partial<CaptionStyle>, coalesce: string | null = null) => onEdit([{ op: 'set_style', style: patch }], coalesce)
  const phraseTarget = positionTarget === 'phrase' && selectedPhraseId !== null
  const position = positionValue(document, phraseTarget ? 'phrase' : 'all', selectedPhraseId)
  const setPosition = (y: number | null, coalesce: string | null) => {
    const edit: CaptionEdit = phraseTarget
      ? { op: 'set_phrase_position', phrase_id: selectedPhraseId!, y }
      : { op: 'set_position', y }
    onEdit([edit], coalesce)
  }
  const percentChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value)
    if (Number.isFinite(value)) setPosition(Math.max(0, Math.min(100, value)) / 100, `position:${phraseTarget ? selectedPhraseId : 'all'}`)
  }
  const estimated = document.wordTiming === 'estimated'

  return (
    <div className="subtitles-controls">
      <Group title="Look">
        <Segmented label="Subtitle style" value={style.preset} options={CAPTION_PRESETS} labels={PRESET_LABELS} disabled={disabled} onChange={(preset) => setStyle({ preset })} />
        {style.preset !== 'karaoke' && (
          <Segmented label="Word entrance" value={style.motion} options={CAPTION_MOTIONS} labels={MOTION_LABELS} disabled={disabled} onChange={(motion) => setStyle({ motion })} />
        )}
        <Field label={`Size ${Math.round(style.fontScale * 100)}%`}>
          <input
            type="range"
            min={CAPTION_FONT_SCALE_RANGE.min}
            max={CAPTION_FONT_SCALE_RANGE.max}
            step={0.05}
            value={style.fontScale}
            disabled={disabled}
            aria-label="Subtitle size"
            onChange={(event) => setStyle({ fontScale: Number(event.target.value) }, 'font-scale')}
          />
        </Field>
        <div className="subtitles-colors">
          <Field label="Text"><input type="color" value={style.textColor.toLowerCase()} disabled={disabled} aria-label="Text color" onChange={(event) => setStyle({ textColor: event.target.value.toUpperCase() }, 'text-color')} /></Field>
          <Field label="Highlight"><input type="color" value={style.highlightColor.toLowerCase()} disabled={disabled} aria-label="Highlight color" onChange={(event) => setStyle({ highlightColor: event.target.value.toUpperCase() }, 'highlight-color')} /></Field>
          <Field label="Outline"><input type="color" value={style.outlineColor.toLowerCase()} disabled={disabled} aria-label="Outline color" onChange={(event) => setStyle({ outlineColor: event.target.value.toUpperCase() }, 'outline-color')} /></Field>
        </div>
        <Field label={`Outline ${style.outlineWidth}px`}>
          <input
            type="range"
            min={CAPTION_OUTLINE_RANGE.min}
            max={CAPTION_OUTLINE_RANGE.max}
            step={1}
            value={style.outlineWidth}
            disabled={disabled}
            aria-label="Outline width"
            onChange={(event) => setStyle({ outlineWidth: Number(event.target.value) }, 'outline-width')}
          />
        </Field>
        <Segmented label="Padding" value={style.background} options={['blur', 'black'] as const} labels={{ blur: 'Blurred fill', black: 'Black bars' }} disabled={disabled} onChange={(background) => setStyle({ background })} />
        <div className="subtitles-switches">
          <Switch label="Shadow" checked={style.shadow} disabled={disabled} onChange={(shadow) => setStyle({ shadow })} />
          <Switch label="Uppercase" checked={style.uppercase} disabled={disabled} onChange={(uppercase) => setStyle({ uppercase })} />
          {style.preset !== 'karaoke' && <Switch label="Size by vocal energy" checked={style.energySizing} disabled={disabled} onChange={(energySizing) => setStyle({ energySizing })} />}
        </div>
      </Group>

      <Group title="Position">
        <Segmented
          label="Position applies to"
          value={phraseTarget ? 'phrase' : 'all'}
          options={['all', 'phrase'] as const}
          labels={{ all: 'All phrases', phrase: 'Selected phrase' }}
          disabled={disabled}
          onChange={(target) => props.onPositionTarget(target)}
        />
        <div className="subtitles-position">
          <input
            type="range"
            min={0}
            max={100}
            step={0.5}
            value={Math.round(position.value * 1000) / 10}
            disabled={disabled || (positionTarget === 'phrase' && !selectedPhraseId)}
            aria-label={phraseTarget ? 'Selected phrase vertical position, percent from top' : 'Subtitle vertical position, percent from top'}
            onChange={percentChange}
          />
          <input
            type="number"
            min={0}
            max={100}
            step={0.5}
            value={Math.round(position.value * 1000) / 10}
            disabled={disabled || (positionTarget === 'phrase' && !selectedPhraseId)}
            aria-label="Vertical position in percent"
            onChange={percentChange}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault()
            }}
          />
          <button type="button" disabled={disabled || !position.explicit} onClick={() => setPosition(null, null)}>
            {phraseTarget ? 'Use all-phrase position' : 'Automatic'}
          </button>
        </div>
        {positionTarget === 'phrase' && !selectedPhraseId && <p className="subtitles-muted">Select a phrase in the transcript or drag one in the preview.</p>}
        <div className="subtitles-switches">
          <Switch label="Safe-area guides" checked={props.guides} disabled={false} onChange={props.onGuides} />
        </div>
        <Field label="Frame">
          <select value={document.aspect} disabled={disabled} aria-label="Output aspect ratio" onChange={(event) => onEdit([{ op: 'set_aspect', aspect: event.target.value as CaptionAspect }])}>
            {CAPTION_ASPECTS.map((aspect) => <option key={aspect} value={aspect}>{aspect}{aspect === '9:16' ? ' · TikTok' : ''}</option>)}
          </select>
        </Field>
      </Group>

      <Group title="Timing">
        <div className="subtitles-switches">
          <Switch label="Snap words to vocal onsets" checked={style.snapToOnsets} disabled={disabled || estimated} onChange={(snapToOnsets) => setStyle({ snapToOnsets })} />
        </div>
        <Field label={`Offset ${style.offsetMs > 0 ? '+' : ''}${style.offsetMs} ms`}>
          <input
            type="range"
            min={-MAX_CAPTION_OFFSET_MS}
            max={MAX_CAPTION_OFFSET_MS}
            step={10}
            value={style.offsetMs}
            disabled={disabled}
            aria-label="Subtitle timing offset in milliseconds"
            onChange={(event) => setStyle({ offsetMs: Number(event.target.value) }, 'offset')}
          />
        </Field>
        {estimated && <p className="subtitles-muted">Translated subtitles use estimated word timing, so words are not highlighted one by one.</p>}
      </Group>

      <Group title="Language">
        <select value={props.language} disabled={disabled} aria-label="Subtitle language" onChange={(event) => props.onLanguage(event.target.value)}>
          <option value="original">Original{document.sourceLanguage ? ` (${document.sourceLanguage})` : ''}</option>
          {Object.entries(SUBTITLE_LANGUAGE_NAMES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select>
      </Group>

      <Group title="Faces and on-screen text">
        <div className="subtitles-switches">
          <Switch label="Avoid faces" checked={style.avoidFaces} disabled={disabled} onChange={(avoidFaces) => setStyle({ avoidFaces })} />
          <Switch label="Avoid on-screen text" checked={style.avoidText} disabled={disabled} onChange={(avoidText) => setStyle({ avoidText })} />
        </div>
        {props.regionsStatus === 'unavailable' && <p className="subtitles-muted">Add OPENAI_API_KEY to detect faces and text; subtitles still work without it.</p>}
        {(props.regionsStatus === 'missing' || props.regionsStatus === 'failed') && (
          <button type="button" disabled={disabled} onClick={props.onAnalyzeRegions}>Check frames for faces and text (OpenAI)</button>
        )}
        {(props.regionsStatus === 'queued' || props.regionsStatus === 'running') && <p className="subtitles-muted" role="status">Checking frames for faces and text…</p>}
      </Group>
    </div>
  )
}
