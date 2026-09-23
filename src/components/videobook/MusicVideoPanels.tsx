import { ChevronLeft, ChevronRight, Play, SkipBack, SkipForward } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { formatTimecode, parseTimecode } from '@/videobook/timecode'

export type SegmentedOption<T extends string> = {
  value: T
  label: string
  disabled?: boolean
  title?: string
}

type SegmentedControlProps<T extends string> = {
  label: string
  options: readonly SegmentedOption<T>[]
  value: T | null
  disabled?: boolean
  stretch?: boolean
  onChange: (value: T) => void
}

export function SegmentedControl<T extends string>({ label, options, value, disabled = false, stretch = false, onChange }: SegmentedControlProps<T>) {
  return (
    <div className={stretch ? 'mv-segmented stretch' : 'mv-segmented'} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          title={option.title}
          disabled={disabled || option.disabled}
          onClick={() => { if (option.value !== value) onChange(option.value) }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

type TimecodeFieldProps = {
  label: string
  frame: number
  fps: number
  min: number
  max: number
  disabled: boolean
  onCommit: (frame: number) => void
}

/** A time input that commits on Enter or blur; the parent keys it by frame so outside changes reset the text. */
export function TimecodeField({ label, frame, fps, min, max, disabled, onCommit }: TimecodeFieldProps) {
  const [text, setText] = useState(() => formatTimecode(frame, fps))
  const [invalid, setInvalid] = useState(false)
  const commit = () => {
    const parsed = parseTimecode(text, fps)
    if (parsed === null) {
      setInvalid(true)
      return
    }
    const clamped = Math.max(min, Math.min(max, parsed))
    setInvalid(false)
    setText(formatTimecode(clamped, fps))
    if (clamped !== frame) onCommit(clamped)
  }
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit()
    if (event.key === 'Escape') {
      event.stopPropagation()
      setText(formatTimecode(frame, fps))
      setInvalid(false)
    }
  }
  return (
    <label className="mv-field">
      <span>{label}</span>
      <input
        value={text}
        disabled={disabled}
        aria-invalid={invalid}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={keyDown}
      />
    </label>
  )
}

type TransportProps = {
  frame: number
  durationFrames: number
  fps: number
  previousBeat: number | null
  nextBeat: number | null
  onTogglePlay: () => void
  onSeek: (frame: number) => void
}

export function MusicVideoTransport({ frame, durationFrames, fps, previousBeat, nextBeat, onTogglePlay, onSeek }: TransportProps) {
  return (
    <div className="mv-transport" role="toolbar" aria-label="Transport">
      <span className="mv-timecode"><strong>{formatTimecode(frame, fps)}</strong> / {formatTimecode(durationFrames, fps)}</span>
      <div className="mv-transport-buttons">
        <button type="button" className="mv-icon" aria-label="Go to start" onClick={() => onSeek(0)}><SkipBack size={17} /></button>
        <button type="button" className="mv-icon" aria-label="Previous beat" title="Previous beat" disabled={previousBeat === null} onClick={() => { if (previousBeat !== null) onSeek(previousBeat) }}><ChevronLeft size={18} /></button>
        <button type="button" className="mv-play" aria-label="Play or pause" title="Play or pause (Space)" onClick={onTogglePlay}><Play size={17} /></button>
        <button type="button" className="mv-icon" aria-label="Next beat" title="Next beat" disabled={nextBeat === null} onClick={() => { if (nextBeat !== null) onSeek(nextBeat) }}><ChevronRight size={18} /></button>
        <button type="button" className="mv-icon" aria-label="Go to end" onClick={() => onSeek(durationFrames - 1)}><SkipForward size={17} /></button>
      </div>
      <span className="mv-transport-spacer" />
    </div>
  )
}
