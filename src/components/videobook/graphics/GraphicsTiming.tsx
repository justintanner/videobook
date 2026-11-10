import { useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { GraphicsEdit } from '../../../../server/src/graphics/edits'
import { MAX_GRAPHICS_FADE_SECONDS, type GraphicsDocument, type GraphicsLayer, type GraphicsTiming } from '../../../../server/src/graphics/model'
import {
  GRAPHICS_TIMING_MODES,
  graphicsFadeSeconds,
  graphicsTimingBar,
  graphicsTimingMode,
  graphicsTimingPreset,
  graphicsTimingRows,
  graphicsTimingSpan,
  graphicsTimingSummary,
  graphicsTimingWithBound,
  graphicsTimingWithSpan,
  type GraphicsTimingMode,
} from '@/videobook/graphics-timing'
import { Choice, Range, Section } from './GraphicsFields'

type Edit = (edits: GraphicsEdit[], coalesceKey?: string | null) => boolean

const MODE_LABELS: Record<GraphicsTimingMode, string> = { whole: 'Whole clip', first: 'First', last: 'Last', custom: 'From playhead' }
const SPAN_LABELS: Partial<Record<GraphicsTimingMode, string>> = { first: 'First seconds', last: 'Last seconds' }

function percent(value: number): string {
  return `${(value * 100).toFixed(3)}%`
}

function secondsText(value: number | null): string {
  return value === null ? '' : String(Number(value.toFixed(3)))
}

function parsedSeconds(text: string): number | null {
  const value = Number(text.trim())
  return text.trim() !== '' && Number.isFinite(value) && value >= 0 ? value : null
}

function SecondsField({ label, value, empty, disabled, onChange }: {
  label: string
  value: number | null
  empty?: string
  disabled: boolean
  onChange: (value: number | null) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const change = (text: string) => {
    setDraft(text)
    if (text.trim() === '') {
      if (empty) onChange(null)
      return
    }
    const parsed = parsedSeconds(text)
    if (parsed !== null) onChange(parsed)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    setDraft(null)
  }
  const invalid = draft !== null && draft.trim() !== '' && parsedSeconds(draft) === null
  return (
    <label className="graphics-seconds">
      <span>{label}</span>
      <span className="graphics-seconds-input">
        <input
          type="text"
          inputMode="decimal"
          aria-label={label}
          aria-invalid={invalid}
          value={draft ?? secondsText(value)}
          placeholder={empty}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => change(event.target.value)}
          onBlur={() => setDraft(null)}
          onKeyDown={onKeyDown}
        />
        <span aria-hidden="true">s</span>
      </span>
    </label>
  )
}

export function GraphicsTimingSection({ layer, durationSeconds, playhead, disabled, onEdit }: {
  layer: GraphicsLayer
  durationSeconds: number
  playhead: () => number
  disabled: boolean
  onEdit: Edit
}) {
  const { timing } = layer
  const mode = graphicsTimingMode(timing)
  const span = SPAN_LABELS[mode]
  const set = (next: GraphicsTiming, coalesce: string | null = null) => onEdit([{ op: 'set_timing', layer_id: layer.id, timing: next }], coalesce)
  const choose = (next: GraphicsTimingMode) => {
    if (next === mode && next !== 'custom') return
    set(graphicsTimingPreset(next, { timing, duration: durationSeconds, playhead: playhead() }))
  }
  const bound = (which: 'start' | 'end', value: number | null, coalesce: string | null) => set(graphicsTimingWithBound(timing, which, value, durationSeconds), coalesce)
  return (
    <Section title="Timing">
      <Choice label="Show" value={mode} options={GRAPHICS_TIMING_MODES} labels={MODE_LABELS} disabled={disabled} onChange={choose} />
      {span && (
        <SecondsField key={mode} label={span} value={graphicsTimingSpan(timing)} disabled={disabled}
          onChange={(value) => value !== null && set(graphicsTimingWithSpan(timing, value, durationSeconds), `${layer.id}:timing-span`)} />
      )}
      {mode === 'custom' && (
        <div className="graphics-timing-bounds">
          <SecondsField label="Start" value={timing.start} disabled={disabled} onChange={(value) => bound('start', value, `${layer.id}:timing-start`)} />
          <button type="button" disabled={disabled} onClick={() => bound('start', playhead(), null)}>Start at playhead</button>
          <SecondsField label="End" value={timing.end} empty="Clip end" disabled={disabled} onChange={(value) => bound('end', value, `${layer.id}:timing-end`)} />
          <button type="button" disabled={disabled} onClick={() => bound('end', playhead(), null)}>End at playhead</button>
        </div>
      )}
      <Range label="Fade" value={timing.fade} min={0} max={MAX_GRAPHICS_FADE_SECONDS} step={0.1} format={(value) => `${value.toFixed(1)} s`} disabled={disabled}
        onChange={(fade) => set({ ...timing, fade: graphicsFadeSeconds(fade) }, `${layer.id}:fade`)} />
      <p className="graphics-muted graphics-timing-summary">{graphicsTimingSummary(timing, durationSeconds)}</p>
    </Section>
  )
}

export const GRAPHICS_TIMING_ROW_PX = 8
export const GRAPHICS_TIMING_MAX_ROWS = 6

export function GraphicsTimingStrip({ document, durationSeconds, seconds, selectedLayerId, onSelectLayer }: {
  document: GraphicsDocument
  durationSeconds: number
  seconds: number
  selectedLayerId: string | null
  onSelectLayer: (layerId: string) => void
}) {
  const rows = graphicsTimingRows(document, durationSeconds)
  if (rows.length === 0) return null
  const playhead = durationSeconds > 0 ? Math.min(1, Math.max(0, seconds / durationSeconds)) : 0
  return (
    <div className="graphics-timing-strip" role="group" aria-label="Layer timing" style={{ maxHeight: GRAPHICS_TIMING_MAX_ROWS * GRAPHICS_TIMING_ROW_PX }}>
      {rows.map((row) => {
        const bar = row.window ? graphicsTimingBar(row.window, durationSeconds) : null
        const style = bar ? ({ left: percent(bar.left), width: percent(bar.width), '--fade-in': percent(bar.fadeIn), '--fade-out': percent(1 - bar.fadeOut) } as CSSProperties) : undefined
        const layer = document.layers.find((candidate) => candidate.id === row.layerId)
        const summary = layer ? graphicsTimingSummary(layer.timing, durationSeconds) : ''
        return (
          <button
            key={row.layerId}
            type="button"
            className="graphics-timing-row"
            data-layer-id={row.layerId}
            data-selected={row.layerId === selectedLayerId ? 'true' : undefined}
            data-hidden={row.visible ? undefined : 'true'}
            data-window={row.window ? `${row.window.start},${row.window.end}` : 'none'}
            aria-label={`${row.name}: ${summary}`}
            title={`${row.name}: ${summary}`}
            aria-pressed={row.layerId === selectedLayerId}
            onClick={() => onSelectLayer(row.layerId)}
          >
            {bar && <span className="graphics-timing-bar" style={style} />}
          </button>
        )
      })}
      <span className="graphics-timing-playhead" aria-hidden="true" style={{ left: percent(playhead) }} />
    </div>
  )
}
