import { X } from 'lucide-react'
import type { CaptionEdit, CaptionTranslationLineInput } from '../../../../server/src/captions/edits'
import {
  captionDisplayLanguage,
  CAPTION_TRANSLATION_SCALE_RANGE,
  MAX_CAPTION_TRANSLATIONS,
  type CaptionDocument,
  type CaptionTranslationLine,
} from '../../../../server/src/captions/model'
import { SUBTITLE_LANGUAGE_NAMES, subtitleLanguageName } from '../../../../server/src/subtitle-languages'
import type { SubtitleLineProgress } from '@/videobook/subtitles-model'

type Edit = (edits: CaptionEdit[], coalesce?: string | null) => boolean

type SubtitlesTranslationLinesProps = {
  document: CaptionDocument
  progress: SubtitleLineProgress[]
  disabled: boolean
  busy: boolean
  onEdit: Edit
  onTranslate: (again: boolean) => void
}

const PREFERRED_LANGUAGE = 'en'

function lineInputs(lines: readonly CaptionTranslationLine[]): CaptionTranslationLineInput[] {
  return lines.map(({ language, color, scale }) => ({ language, color, scale }))
}

function choosableLanguages(document: CaptionDocument, keep: string | null): string[] {
  const own = captionDisplayLanguage(document)
  const taken = new Set((document.translations ?? []).map((line) => line.language).filter((language) => language !== keep))
  return Object.keys(SUBTITLE_LANGUAGE_NAMES).filter((code) => code !== own && !taken.has(code))
}

function lineStatus(progress: SubtitleLineProgress | undefined): { text: string; tone: 'muted' | 'error' } | null {
  if (!progress) return null
  if (progress.status === 'queued' || progress.status === 'running') return { text: 'Translating…', tone: 'muted' }
  if (progress.missing === 0) return { text: 'Every phrase has a line.', tone: 'muted' }
  if (progress.status === 'failed' || progress.status === 'unavailable') return { text: progress.error ?? 'Translating these lines failed.', tone: 'error' }
  return { text: `${progress.missing} ${progress.missing === 1 ? 'line needs' : 'lines need'} a translation.`, tone: 'muted' }
}

function translatableCount(progress: readonly SubtitleLineProgress[]): number {
  return progress.reduce((sum, line) => sum + (line.available ? line.missing : 0), 0)
}

function translatedAgain(progress: readonly SubtitleLineProgress[]): boolean {
  return progress.length > 0 && progress.every((line) => line.available && line.missing === 0)
}

export function SubtitlesTranslationLines({ document, progress, disabled, busy, onEdit, onTranslate }: SubtitlesTranslationLinesProps) {
  const lines = document.translations ?? []
  const setLines = (next: CaptionTranslationLineInput[], coalesce: string | null = null) => onEdit([{ op: 'set_translations', translations: next }], coalesce)
  const update = (index: number, patch: Partial<CaptionTranslationLineInput>, coalesce: string | null = null) => {
    setLines(lineInputs(lines).map((line, at) => (at === index ? { ...line, ...patch } : line)), coalesce)
  }
  const addable = choosableLanguages(document, null)
  const add = () => {
    const language = addable.includes(PREFERRED_LANGUAGE) ? PREFERRED_LANGUAGE : addable[0]
    if (language) setLines([...lineInputs(lines), { language }])
  }
  const missing = translatableCount(progress)
  const translating = progress.some((line) => line.status === 'queued' || line.status === 'running')

  return (
    <section className="subtitles-group" aria-label="Translated lines">
      <span className="confirm-section-label">Translated lines</span>
      {lines.length === 0 && <p className="subtitles-muted">Show a translation under each phrase, without word highlighting.</p>}
      {lines.map((line, index) => {
        const name = subtitleLanguageName(line.language)
        const status = lineStatus(progress.find((candidate) => candidate.language === line.language))
        return (
          <div className="subtitles-translation-line" key={line.language}>
            <div className="subtitles-translation-row">
              <select value={line.language} disabled={disabled} aria-label={`Language of translated line ${index + 1}`} onChange={(event) => update(index, { language: event.target.value })}>
                {choosableLanguages(document, line.language).map((code) => <option key={code} value={code}>{subtitleLanguageName(code)}</option>)}
              </select>
              <input type="color" value={line.color.toLowerCase()} disabled={disabled} aria-label={`${name} line color`} onChange={(event) => update(index, { color: event.target.value.toUpperCase() }, `translation-color:${index}`)} />
              <button type="button" className="subtitles-icon-button" disabled={disabled} aria-label={`Remove the ${name} line`} title={`Remove the ${name} line`} onClick={() => setLines(lineInputs(lines).filter((_, at) => at !== index))}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            <label className="subtitles-field">
              <span>{`Size ${Math.round(line.scale * 100)}%`}</span>
              <input
                type="range"
                min={CAPTION_TRANSLATION_SCALE_RANGE.min}
                max={CAPTION_TRANSLATION_SCALE_RANGE.max}
                step={0.05}
                value={line.scale}
                disabled={disabled}
                aria-label={`${name} line size`}
                onChange={(event) => update(index, { scale: Number(event.target.value) }, `translation-scale:${index}`)}
              />
            </label>
            {status && <p className={status.tone === 'error' ? 'subtitles-error' : 'subtitles-muted'} role={translating ? 'status' : undefined}>{status.text}</p>}
          </div>
        )
      })}
      <div className="subtitles-translation-actions">
        {lines.length < MAX_CAPTION_TRANSLATIONS && addable.length > 0 && (
          <button type="button" disabled={disabled} onClick={add}>Add a translated line</button>
        )}
        {missing > 0 && !translating && (
          <button type="button" className="subtitles-primary" disabled={disabled || busy} onClick={() => onTranslate(false)}>
            {`Translate ${missing} ${missing === 1 ? 'line' : 'lines'} (OpenAI)`}
          </button>
        )}
        {translatedAgain(progress) && !translating && (
          <button type="button" disabled={disabled || busy} onClick={() => onTranslate(true)}>Translate all again (OpenAI)</button>
        )}
      </div>
    </section>
  )
}
