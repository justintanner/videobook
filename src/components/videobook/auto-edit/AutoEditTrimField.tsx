import { useId, useState, type KeyboardEvent } from 'react'
import type { AutoEditTrimEdge } from '@/videobook/auto-edit-review'

interface AutoEditTrimFieldProps {
  edge: AutoEditTrimEdge
  clip: string
  fps: number
  disabled: boolean
  onTrim: (edge: AutoEditTrimEdge, seconds: number) => void
  onSetToPlayhead: (edge: AutoEditTrimEdge) => void
}

export function AutoEditTrimField({ edge, clip, fps, disabled, onTrim, onSetToPlayhead }: AutoEditTrimFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const hintId = useId()
  const label = edge.side === 'start' ? 'Start' : 'End'
  const precision = Math.max(2, Math.ceil(Math.log10(fps)))
  const bounds = `${edge.min.toFixed(precision)}–${edge.max.toFixed(precision)} s`

  const commit = () => {
    if (draft === null) return
    const seconds = Number(draft)
    if (draft.trim() && Number.isFinite(seconds)) onTrim(edge, seconds)
    setDraft(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      commit()
      if (!event.metaKey && !event.ctrlKey) event.preventDefault()
    } else if (event.key === 'Escape' && draft !== null) {
      event.preventDefault()
      setDraft(null)
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      const value = event.currentTarget.valueAsNumber
      const seconds = Number.isFinite(value) ? value : edge.seconds
      const step = (event.shiftKey ? 10 : 1) / fps
      onTrim(edge, seconds + (event.key === 'ArrowUp' ? step : -step))
      setDraft(null)
    }
  }

  return (
    <div className="auto-edit-trim-field" data-side={edge.side}>
      <div className="auto-edit-trim-field-row">
        <label>
          {label}
          <span className="auto-edit-trim-time">
            <input
              type="number"
              inputMode="decimal"
              aria-label={`${clip} ${edge.side} in seconds`}
              aria-describedby={hintId}
              min={edge.min.toFixed(precision)}
              max={edge.max.toFixed(precision)}
              step="any"
              value={draft ?? edge.seconds.toFixed(precision)}
              disabled={disabled}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onBlur={commit}
              onKeyDown={onKeyDown}
            />
            <span aria-hidden="true">s</span>
          </span>
        </label>
        <button
          type="button"
          aria-label={`Set ${clip} ${edge.side} to playhead`}
          title={`Set ${label.toLowerCase()} at the current source frame`}
          disabled={disabled}
          onClick={() => onSetToPlayhead(edge)}
        >
          Use playhead
        </button>
      </div>
      <small id={hintId}>
        <span className="auto-edit-trim-bounds">{bounds}</span>
        {edge.linked.length > 0 && <span>Shared with {edge.linked.join(', ')}</span>}
      </small>
    </div>
  )
}
