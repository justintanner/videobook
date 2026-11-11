import { MAX_GRAPHICS_FADE_SECONDS, type GraphicsDocument, type GraphicsLayerKind, type GraphicsTiming } from '../../server/src/graphics/model'
import { resolveLayerTiming, type ResolvedGraphicsTiming } from '../../server/src/graphics/timing'

export type GraphicsTimingMode = 'whole' | 'first' | 'last' | 'custom'
export type GraphicsTimingBound = 'start' | 'end'
export type GraphicsTimingRow = { layerId: string; name: string; kind: GraphicsLayerKind; visible: boolean; window: ResolvedGraphicsTiming | null }
export type GraphicsTimingBar = { left: number; width: number; fadeIn: number; fadeOut: number }

export const GRAPHICS_TIMING_MODES: readonly GraphicsTimingMode[] = ['whole', 'first', 'last', 'custom']

const DEFAULT_SPAN_SECONDS = 3
const MIN_SPAN_SECONDS = 0.1

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function seconds(value: number): number {
  return Math.round(value * 1000) / 1000
}

function label(value: number): string {
  return String(Number(value.toFixed(2)))
}

export function graphicsTimingMode(timing: GraphicsTiming): GraphicsTimingMode {
  if (timing.start !== null) return 'custom'
  if (timing.end !== null) return 'first'
  if (timing.tail !== null) return 'last'
  return 'whole'
}

export function graphicsTimingSpan(timing: GraphicsTiming): number | null {
  const mode = graphicsTimingMode(timing)
  if (mode === 'first') return timing.end
  if (mode === 'last') return timing.tail
  return null
}

function spanSeconds(value: number, duration: number): number {
  return seconds(clamp(value, MIN_SPAN_SECONDS, Math.max(MIN_SPAN_SECONDS, duration)))
}

function clipSeconds(value: number, duration: number): number {
  return seconds(clamp(value, 0, Math.max(0, duration)))
}

export function graphicsTimingPreset(mode: GraphicsTimingMode, input: { timing: GraphicsTiming; duration: number; playhead: number }): GraphicsTiming {
  const { timing, duration } = input
  const span = spanSeconds(graphicsTimingSpan(timing) ?? Math.min(DEFAULT_SPAN_SECONDS, duration), duration)
  if (mode === 'whole') return { ...timing, start: null, end: null, tail: null }
  if (mode === 'first') return { ...timing, start: null, end: span, tail: null }
  if (mode === 'last') return { ...timing, start: null, end: null, tail: span }
  const start = clipSeconds(input.playhead, duration)
  return { ...timing, start, end: timing.end !== null && timing.end > start ? timing.end : null, tail: null }
}

export function graphicsTimingWithSpan(timing: GraphicsTiming, value: number, duration: number): GraphicsTiming {
  const span = spanSeconds(value, duration)
  if (graphicsTimingMode(timing) === 'last') return { ...timing, start: null, end: null, tail: span }
  return { ...timing, start: null, end: span, tail: null }
}

export function graphicsTimingWithBound(timing: GraphicsTiming, bound: GraphicsTimingBound, value: number | null, duration: number): GraphicsTiming {
  const at = value === null ? null : clipSeconds(value, duration)
  if (bound === 'start') return { ...timing, start: at ?? 0, tail: null }
  return { ...timing, start: timing.start ?? 0, end: at, tail: null }
}

const TRIM_STEP_SECONDS = 0.01
const CLIP_END_SLACK_SECONDS = 0.005

function trimmed(value: number): number {
  return Math.round(value / TRIM_STEP_SECONDS) * TRIM_STEP_SECONDS
}

function trimmedStart(timing: GraphicsTiming, value: number, end: number, duration: number): GraphicsTiming {
  const start = seconds(trimmed(clamp(value, 0, Math.max(0, end - MIN_SPAN_SECONDS))))
  if (graphicsTimingMode(timing) === 'last') return { ...timing, start: null, end: null, tail: seconds(duration - start) }
  return { ...timing, start: start > 0 ? start : null, tail: null }
}

function trimmedEnd(timing: GraphicsTiming, value: number, start: number, duration: number): GraphicsTiming {
  const end = seconds(trimmed(clamp(value, Math.min(duration, start + MIN_SPAN_SECONDS), duration)))
  const clipEnd = end >= duration - CLIP_END_SLACK_SECONDS
  if (graphicsTimingMode(timing) !== 'last') return { ...timing, end: clipEnd ? null : end, tail: null }
  return clipEnd ? timing : { ...timing, start: seconds(start), end, tail: null }
}

function sameTiming(left: GraphicsTiming, right: GraphicsTiming): boolean {
  return left.start === right.start && left.end === right.end && left.tail === right.tail && left.fade === right.fade
}

export function graphicsTimingTrim(timing: GraphicsTiming, bound: GraphicsTimingBound, value: number, duration: number): GraphicsTiming {
  const window = resolveLayerTiming(timing, duration)
  if (!window || !Number.isFinite(value)) return timing
  const next = bound === 'start' ? trimmedStart(timing, value, window.end, duration) : trimmedEnd(timing, value, window.start, duration)
  return sameTiming(next, timing) ? timing : next
}

type GraphicsRulerMark = { seconds: number; at: number; label: string }
type GraphicsRuler = { tick: number; marks: GraphicsRulerMark[] }

const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
const RULER_MAX_MARKS = 8

function clock(value: number): string {
  const whole = Math.round(value)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function rulerTick(step: number): number {
  if (step >= 5) return step / 5
  return step === 1 ? 0.5 : 1
}

export function graphicsRuler(duration: number): GraphicsRuler {
  if (!Number.isFinite(duration) || duration <= 0) return { tick: 0, marks: [] }
  const step = RULER_STEPS.find((candidate) => duration / candidate <= RULER_MAX_MARKS) ?? Math.ceil(duration / RULER_MAX_MARKS / 600) * 600
  const count = Math.floor(duration / step + 1e-9)
  const marks = Array.from({ length: count + 1 }, (_unused, index) => ({ seconds: index * step, at: (index * step) / duration, label: clock(index * step) }))
  return { tick: rulerTick(step) / duration, marks }
}

export function graphicsFadeSeconds(value: number): number {
  return Math.round(clamp(value, 0, MAX_GRAPHICS_FADE_SECONDS) * 100) / 100
}

export function graphicsTimingRows(document: GraphicsDocument, duration: number): GraphicsTimingRow[] {
  return document.layers
    .map((layer) => ({ layerId: layer.id, name: layer.name, kind: layer.kind, visible: layer.visible, window: resolveLayerTiming(layer.timing, duration) }))
    .reverse()
}

export function graphicsTimingBar(window: ResolvedGraphicsTiming, duration: number): GraphicsTimingBar {
  const length = window.end - window.start
  if (!(duration > 0) || !(length > 0)) return { left: 0, width: 0, fadeIn: 0, fadeOut: 0 }
  return { left: window.start / duration, width: length / duration, fadeIn: window.fadeIn / length, fadeOut: window.fadeOut / length }
}

export function graphicsTimingSummary(timing: GraphicsTiming, duration: number): string {
  const window = resolveLayerTiming(timing, duration)
  if (!window) return 'Never shows: the window is empty.'
  const fades = [
    window.fadeIn > 0 ? `fades in ${label(window.fadeIn)} s` : null,
    window.fadeOut > 0 ? `fades out ${label(window.fadeOut)} s` : null,
  ].filter((part): part is string => part !== null)
  return [`Shows ${label(window.start)}–${label(window.end)} s of ${label(duration)} s`, ...fades].join(' · ')
}
