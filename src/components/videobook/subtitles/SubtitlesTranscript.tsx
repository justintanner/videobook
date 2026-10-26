import { memo, useMemo, useState, type KeyboardEvent } from 'react'
import { Eye, EyeOff, Merge, Plus, RotateCcw, Scissors } from 'lucide-react'
import type { CaptionEdit } from '../../../../server/src/captions/edits'
import type { CaptionDocument, CaptionWord } from '../../../../server/src/captions/model'
import { effectiveWordTiming } from '../../../../server/src/captions/timing'
import {
  formatCaptionTime,
  isCorrectedWord,
  subtitlePhraseRows,
  type SubtitlePhraseRow,
} from '@/videobook/subtitles-model'

type Edit = (edits: CaptionEdit[], coalesce?: string | null) => boolean

type SubtitlesTranscriptProps = {
  document: CaptionDocument
  activeWordId: string | null
  selectedWordId: string | null
  selectedPhraseId: string | null
  disabled: boolean
  onSeek: (seconds: number) => void
  onSelectWord: (wordId: string, phraseId: string) => void
  onSelectPhrase: (phraseId: string) => void
  onEdit: Edit
}

type PhraseRowProps = {
  row: SubtitlePhraseRow
  document: CaptionDocument
  activeWordId: string | null
  selectedWordId: string | null
  selected: boolean
  disabled: boolean
  onSeek: (seconds: number) => void
  onSelectWord: (wordId: string, phraseId: string) => void
  onSelectPhrase: (phraseId: string) => void
}

const PhraseRow = memo(function PhraseRow({ row, document, activeWordId, selectedWordId, selected, disabled, onSeek, onSelectWord, onSelectPhrase }: PhraseRowProps) {
  const override = document.phrases[row.index]?.positions[document.aspect]
  return (
    <li className="subtitles-phrase" data-selected={selected ? 'true' : undefined}>
      <button
        type="button"
        className="subtitles-phrase-head"
        aria-pressed={selected}
        disabled={disabled}
        onClick={() => {
          onSelectPhrase(row.id)
          onSeek(row.start)
        }}
      >
        <span>{row.index + 1}</span>
        <span>{formatCaptionTime(row.start)}</span>
        {override !== undefined && <span className="subtitles-phrase-pin" title="This phrase has its own position">{Math.round(override * 100)}%</span>}
      </button>
      <div className="subtitles-words">
        {row.words.map((word) => (
          <button
            key={word.id}
            type="button"
            className="subtitles-word"
            data-active={word.id === activeWordId ? 'true' : undefined}
            data-corrected={isCorrectedWord(word) ? 'true' : undefined}
            data-hidden={word.hidden ? 'true' : undefined}
            aria-pressed={word.id === selectedWordId}
            disabled={disabled}
            title={`${formatCaptionTime(effectiveWordTiming(word, document.style).start)} · click to play from here`}
            onClick={() => {
              onSelectWord(word.id, row.id)
              onSeek(effectiveWordTiming(word, document.style).start)
            }}
          >
            {word.text}
          </button>
        ))}
      </div>
    </li>
  )
})

function seconds(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : null
}

function consumeEnter(event: KeyboardEvent<HTMLInputElement>, commit: () => void, cancel: () => void) {
  if (event.key === 'Enter') {
    event.preventDefault()
    commit()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  }
}

type WordEditorProps = {
  document: CaptionDocument
  word: CaptionWord
  phraseId: string
  disabled: boolean
  onEdit: Edit
  onSeek: (seconds: number) => void
}

function WordEditor({ document, word, phraseId, disabled, onEdit, onSeek }: WordEditorProps) {
  const [text, setText] = useState(word.text)
  const [start, setStart] = useState(word.start.toFixed(2))
  const [end, setEnd] = useState(word.end.toFixed(2))
  const phrase = document.phrases.find((candidate) => candidate.id === phraseId)
  const isPhraseStart = phrase?.wordIds[0] === word.id
  const phraseIndex = document.phrases.findIndex((candidate) => candidate.id === phraseId)
  const hasNext = phraseIndex >= 0 && phraseIndex < document.phrases.length - 1

  const commitText = () => {
    if (text.trim() === word.text) return
    if (!onEdit([{ op: 'set_word_text', word_id: word.id, text }])) setText(word.text)
  }
  const commitTiming = (nextStart: number | null, nextEnd: number | null) => {
    if (nextStart === null || nextEnd === null) return
    if (nextStart === word.start && nextEnd === word.end) return
    if (onEdit([{ op: 'set_word_timing', word_id: word.id, start: nextStart, end: nextEnd }], `timing:${word.id}`)) {
      setStart(nextStart.toFixed(2))
      setEnd(nextEnd.toFixed(2))
      onSeek(nextStart)
    }
  }
  const nudge = (field: 'start' | 'end', delta: number) => {
    const nextStart = Math.max(0, Math.round((word.start + (field === 'start' ? delta : 0)) * 1000) / 1000)
    const nextEnd = Math.round((word.end + (field === 'end' ? delta : 0)) * 1000) / 1000
    commitTiming(nextStart, nextEnd)
  }
  const insertAfter = () => {
    const at = document.words.findIndex((candidate) => candidate.id === word.id)
    const next = document.words.slice(at + 1).find((candidate) => !candidate.hidden)
    const begin = Math.round(word.end * 1000) / 1000
    const finish = Math.round(Math.min(next ? next.start : word.end + 0.4, begin + 0.4) * 1000) / 1000
    onEdit([{ op: 'insert_word', after_word_id: word.id, text: 'new', start: begin, end: Math.max(finish, begin + 0.05) }])
  }

  return (
    <div className="subtitles-word-editor" aria-label={`Edit word ${word.text}`}>
      <label className="subtitles-field subtitles-field-wide">
        <span>Word</span>
        <input
          type="text"
          value={text}
          disabled={disabled}
          aria-label="Word text"
          onChange={(event) => setText(event.target.value)}
          onBlur={commitText}
          onKeyDown={(event) => consumeEnter(event, commitText, () => setText(word.text))}
        />
      </label>
      {(['start', 'end'] as const).map((field) => (
        <label className="subtitles-field" key={field}>
          <span>{field === 'start' ? 'Start' : 'End'}</span>
          <span className="subtitles-nudge">
            <button type="button" disabled={disabled} aria-label={`${field} 50 ms earlier`} onClick={() => nudge(field, -0.05)}>−</button>
            <input
              type="number"
              step={0.01}
              min={0}
              disabled={disabled}
              aria-label={`Word ${field} in seconds`}
              value={field === 'start' ? start : end}
              onChange={(event) => (field === 'start' ? setStart(event.target.value) : setEnd(event.target.value))}
              onBlur={() => commitTiming(seconds(start), seconds(end))}
              onKeyDown={(event) => consumeEnter(event, () => commitTiming(seconds(start), seconds(end)), () => {
                setStart(word.start.toFixed(2))
                setEnd(word.end.toFixed(2))
              })}
            />
            <button type="button" disabled={disabled} aria-label={`${field} 50 ms later`} onClick={() => nudge(field, 0.05)}>+</button>
          </span>
        </label>
      ))}
      <div className="subtitles-word-actions">
        <button type="button" disabled={disabled} onClick={() => onEdit([{ op: 'hide_word', word_id: word.id, hidden: !word.hidden }])}>
          {word.hidden ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}
          {word.hidden ? 'Show' : 'Hide'}
        </button>
        <button type="button" disabled={disabled || !word.analysed || !isCorrectedWord(word)} onClick={() => onEdit([{ op: 'reset_word', word_id: word.id }])}>
          <RotateCcw size={13} aria-hidden="true" />Reset
        </button>
        <button type="button" disabled={disabled || isPhraseStart} onClick={() => onEdit([{ op: 'split_phrase', word_id: word.id }])}>
          <Scissors size={13} aria-hidden="true" />New phrase here
        </button>
        <button type="button" disabled={disabled || !hasNext} onClick={() => onEdit([{ op: 'merge_phrase', phrase_id: phraseId }])}>
          <Merge size={13} aria-hidden="true" />Join next phrase
        </button>
        <button type="button" disabled={disabled} onClick={insertAfter}>
          <Plus size={13} aria-hidden="true" />Add word after
        </button>
      </div>
    </div>
  )
}

export function SubtitlesTranscript(props: SubtitlesTranscriptProps) {
  const { document, activeWordId, selectedWordId, selectedPhraseId, disabled } = props
  const rows = useMemo(() => subtitlePhraseRows(document), [document])
  const selectedWord = selectedWordId ? document.words.find((word) => word.id === selectedWordId) ?? null : null
  const phraseOfSelected = selectedWord ? rows.find((row) => row.words.some((word) => word.id === selectedWord.id))?.id ?? null : null
  return (
    <section className="subtitles-transcript" aria-label="Transcript">
      <div className="subtitles-section-head">
        <span className="confirm-section-label">Transcript</span>
        <span className="subtitles-muted">{rows.length} {rows.length === 1 ? 'phrase' : 'phrases'} · click a word to play from it</span>
      </div>
      {selectedWord && phraseOfSelected && (
        <WordEditor
          key={`${selectedWord.id}:${selectedWord.text}:${selectedWord.start}:${selectedWord.end}`}
          document={document}
          word={selectedWord}
          phraseId={phraseOfSelected}
          disabled={disabled}
          onEdit={props.onEdit}
          onSeek={props.onSeek}
        />
      )}
      <ol className="subtitles-phrases">
        {rows.map((row) => {
          const contains = (id: string | null) => (id && row.words.some((word) => word.id === id) ? id : null)
          return (
            <PhraseRow
              key={row.id}
              row={row}
              document={document}
              activeWordId={contains(activeWordId)}
              selectedWordId={contains(selectedWordId)}
              selected={row.id === selectedPhraseId}
              disabled={disabled}
              onSeek={props.onSeek}
              onSelectWord={props.onSelectWord}
              onSelectPhrase={props.onSelectPhrase}
            />
          )
        })}
      </ol>
    </section>
  )
}
