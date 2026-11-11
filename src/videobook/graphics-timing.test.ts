import { describe, expect, it } from 'vitest'
import { applyGraphicsEdits } from '../../server/src/graphics/edits'
import { graphicsDocumentFromLayers, type GraphicsTiming } from '../../server/src/graphics/model'
import { graphicsStillGroups } from '../../server/src/graphics/stills'
import { layerOpacityAt, resolveLayerTiming } from '../../server/src/graphics/timing'
import {
  graphicsFadeSeconds,
  graphicsRuler,
  graphicsTimingBar,
  graphicsTimingMode,
  graphicsTimingPreset,
  graphicsTimingRows,
  graphicsTimingSpan,
  graphicsTimingSummary,
  graphicsTimingTrim,
  graphicsTimingWithBound,
  graphicsTimingWithSpan,
} from './graphics-timing'

const WHOLE: GraphicsTiming = { start: null, end: null, tail: null, fade: 0 }

function preset(mode: Parameters<typeof graphicsTimingPreset>[0], timing: GraphicsTiming = WHOLE, duration = 8, playhead = 2.5) {
  return graphicsTimingPreset(mode, { timing, duration, playhead })
}

describe('graphicsTimingMode', () => {
  it('reads the preset a timing follows', () => {
    expect(graphicsTimingMode(WHOLE)).toBe('whole')
    expect(graphicsTimingMode({ ...WHOLE, end: 3 })).toBe('first')
    expect(graphicsTimingMode({ ...WHOLE, tail: 3 })).toBe('last')
    expect(graphicsTimingMode({ ...WHOLE, start: 1 })).toBe('custom')
    expect(graphicsTimingMode({ ...WHOLE, start: 1, end: 4, tail: 2 })).toBe('custom')
    expect(graphicsTimingMode({ ...WHOLE, end: 5, tail: 2 })).toBe('first')
    expect(graphicsTimingSpan({ ...WHOLE, end: 5, tail: 2 })).toBe(5)
    expect(graphicsTimingSpan({ ...WHOLE, tail: 2 })).toBe(2)
    expect(graphicsTimingSpan({ ...WHOLE, start: 1 })).toBeNull()
  })
})

describe('graphicsTimingPreset', () => {
  it('sets each preset with every other window field cleared and the fade kept', () => {
    const faded = { ...WHOLE, start: 1, end: 6, fade: 0.4 }
    expect(preset('whole', faded)).toEqual({ ...WHOLE, fade: 0.4 })
    expect(preset('first')).toEqual({ ...WHOLE, end: 3 })
    expect(preset('last')).toEqual({ ...WHOLE, tail: 3 })
    expect(preset('last', { ...WHOLE, end: 5 })).toEqual({ ...WHOLE, tail: 5 })
    expect(preset('first', WHOLE, 2)).toEqual({ ...WHOLE, end: 2 })
  })

  it('starts a custom window at the playhead and keeps a later end', () => {
    expect(preset('custom', WHOLE, 8, 2.5004)).toEqual({ ...WHOLE, start: 2.5 })
    expect(preset('custom', { ...WHOLE, end: 6 }, 8, 2.5)).toEqual({ ...WHOLE, start: 2.5, end: 6 })
    expect(preset('custom', { ...WHOLE, end: 2 }, 8, 2.5)).toEqual({ ...WHOLE, start: 2.5 })
    expect(preset('custom', WHOLE, 8, 12)).toEqual({ ...WHOLE, start: 8 })
  })

  it('shows a layer limited to the last 3 seconds only then, in the preview and in the stills that render it', () => {
    const timing = preset('last', WHOLE, 6)
    const window = resolveLayerTiming(timing, 6)
    expect(window).toEqual({ start: 3, end: 6, fadeIn: 0, fadeOut: 0 })
    expect(layerOpacityAt(window, 1)).toBe(0)
    expect(layerOpacityAt(window, 2.9)).toBe(0)
    expect(layerOpacityAt(window, 3.5)).toBe(1)
    const base = graphicsDocumentFromLayers([{ kind: 'text', name: 'Title', items: [{ text: 'Late title' }] }])
    const edited = applyGraphicsEdits(base, [{ op: 'set_timing', layer_id: 'l1', timing }])
    if (!edited.ok) throw new Error(edited.error.message)
    expect(graphicsStillGroups(edited.document, 6)).toEqual([{ layerIds: ['l1'], timing: { start: 3, end: 6, fadeIn: 0, fadeOut: 0 } }])
  })
})

describe('timing fields', () => {
  it('changes the span of a first or last window within the clip', () => {
    expect(graphicsTimingWithSpan({ ...WHOLE, end: 3 }, 4.25, 8)).toEqual({ ...WHOLE, end: 4.25 })
    expect(graphicsTimingWithSpan({ ...WHOLE, tail: 3 }, 20, 8)).toEqual({ ...WHOLE, tail: 8 })
    expect(graphicsTimingWithSpan({ ...WHOLE, tail: 3 }, 0, 8)).toEqual({ ...WHOLE, tail: 0.1 })
  })

  it('sets a custom start or end inside the clip, an empty end meaning the clip end', () => {
    expect(graphicsTimingWithBound({ ...WHOLE, start: 1 }, 'end', 5.5, 8)).toEqual({ ...WHOLE, start: 1, end: 5.5 })
    expect(graphicsTimingWithBound({ ...WHOLE, start: 1, end: 5 }, 'end', null, 8)).toEqual({ ...WHOLE, start: 1 })
    expect(graphicsTimingWithBound({ ...WHOLE, start: 1, end: 5 }, 'start', 9, 8)).toEqual({ ...WHOLE, start: 8, end: 5 })
    expect(graphicsTimingWithBound({ ...WHOLE, start: 1 }, 'start', null, 8)).toEqual({ ...WHOLE, start: 0 })
    expect(graphicsTimingWithBound({ ...WHOLE, tail: 3 }, 'end', 4, 8)).toEqual({ ...WHOLE, start: 0, end: 4 })
  })

  it('keeps the fade between 0 and 2 seconds', () => {
    expect(graphicsFadeSeconds(0.333)).toBe(0.33)
    expect(graphicsFadeSeconds(5)).toBe(2)
    expect(graphicsFadeSeconds(-1)).toBe(0)
  })
})

describe('timing strip', () => {
  it('lists layers top first with their resolved windows', () => {
    const document = graphicsDocumentFromLayers([
      { kind: 'scrim', name: 'Shade' },
      { kind: 'text', name: 'Title', timing: { tail: 3, fade: 0.5 }, items: [{ text: 'Late' }] },
      { kind: 'text', name: 'Gone', visible: false, timing: { start: 5, end: 4 }, items: [{ text: 'Never' }] },
    ])
    expect(graphicsTimingRows(document, 8)).toEqual([
      { layerId: document.layers[2]!.id, name: 'Gone', kind: 'text', visible: false, window: null },
      { layerId: document.layers[1]!.id, name: 'Title', kind: 'text', visible: true, window: { start: 5, end: 8, fadeIn: 0.5, fadeOut: 0 } },
      { layerId: document.layers[0]!.id, name: 'Shade', kind: 'scrim', visible: true, window: { start: 0, end: 8, fadeIn: 0, fadeOut: 0 } },
    ])
  })

  it('places each bar and its fades as fractions', () => {
    expect(graphicsTimingBar({ start: 2, end: 6, fadeIn: 1, fadeOut: 0.5 }, 8)).toEqual({ left: 0.25, width: 0.5, fadeIn: 0.25, fadeOut: 0.125 })
    expect(graphicsTimingBar({ start: 0, end: 0, fadeIn: 0, fadeOut: 0 }, 8)).toEqual({ left: 0, width: 0, fadeIn: 0, fadeOut: 0 })
  })

  it('summarises the window a layer shows in', () => {
    expect(graphicsTimingSummary(WHOLE, 8)).toBe('Shows 0–8 s of 8 s')
    expect(graphicsTimingSummary({ ...WHOLE, start: 1.25, end: 5, fade: 0.3 }, 8)).toBe('Shows 1.25–5 s of 8 s · fades in 0.3 s · fades out 0.3 s')
    expect(graphicsTimingSummary({ ...WHOLE, start: 6, end: 3 }, 8)).toBe('Never shows: the window is empty.')
  })
})

describe('graphicsTimingTrim', () => {
  it('pulls the end of a whole-clip layer in and lets it go back to the clip end', () => {
    expect(graphicsTimingTrim(WHOLE, 'end', 3.004, 8)).toEqual({ ...WHOLE, end: 3 })
    expect(graphicsTimingMode(graphicsTimingTrim(WHOLE, 'end', 3, 8))).toBe('first')
    expect(graphicsTimingTrim({ ...WHOLE, end: 3 }, 'end', 7.999, 8)).toEqual(WHOLE)
    expect(graphicsTimingTrim({ ...WHOLE, end: 3 }, 'end', 12, 8)).toEqual(WHOLE)
  })

  it('pushes the start in as a custom window and lets it go back to the clip start', () => {
    expect(graphicsTimingTrim(WHOLE, 'start', 2.5, 8)).toEqual({ ...WHOLE, start: 2.5 })
    expect(graphicsTimingTrim({ ...WHOLE, end: 6 }, 'start', 1.237, 8)).toEqual({ ...WHOLE, start: 1.24, end: 6 })
    expect(graphicsTimingTrim({ ...WHOLE, start: 2.5, end: 6 }, 'start', -1, 8)).toEqual({ ...WHOLE, end: 6 })
    expect(graphicsTimingMode(graphicsTimingTrim({ ...WHOLE, start: 2.5 }, 'start', 0, 8))).toBe('whole')
  })

  it('keeps a last-seconds layer counted from the clip end while its start moves', () => {
    const last = { ...WHOLE, tail: 3, fade: 0.3 }
    expect(graphicsTimingTrim(last, 'start', 6, 8)).toEqual({ ...last, tail: 2 })
    expect(graphicsTimingTrim(last, 'start', 0, 8)).toEqual({ ...last, tail: 8 })
    expect(graphicsTimingTrim(last, 'end', 8, 8)).toBe(last)
    expect(graphicsTimingTrim(last, 'end', 7, 8)).toEqual({ ...WHOLE, start: 5, end: 7, fade: 0.3 })
  })

  it('never lets the two ends cross or leave the clip', () => {
    const window = { ...WHOLE, start: 2, end: 4 }
    expect(graphicsTimingTrim(window, 'start', 7, 8)).toEqual({ ...WHOLE, start: 3.9, end: 4 })
    expect(graphicsTimingTrim(window, 'end', 0, 8)).toEqual({ ...WHOLE, start: 2, end: 2.1 })
    expect(resolveLayerTiming(graphicsTimingTrim(window, 'end', 0, 8), 8)).toMatchObject({ start: 2, end: 2.1 })
  })

  it('hands back the same timing while the pointer has not moved an edge', () => {
    const first = { ...WHOLE, end: 3 }
    expect(graphicsTimingTrim(first, 'end', 3.002, 8)).toBe(first)
    expect(graphicsTimingTrim(first, 'start', 0, 8)).toBe(first)
    expect(graphicsTimingTrim(WHOLE, 'end', 8, 8)).toBe(WHOLE)
    const window = { ...WHOLE, start: 2, end: 4 }
    expect(graphicsTimingTrim(window, 'start', 2.004, 8)).toBe(window)
  })

  it('leaves a layer that never shows, or a pointer that is nowhere, alone', () => {
    const never = { ...WHOLE, start: 9 }
    expect(graphicsTimingTrim(never, 'end', 3, 8)).toBe(never)
    expect(graphicsTimingTrim(WHOLE, 'end', Number.NaN, 8)).toBe(WHOLE)
    expect(graphicsTimingTrim(WHOLE, 'end', 3, 0)).toBe(WHOLE)
  })
})

describe('graphicsRuler', () => {
  it('labels at most eight marks and ticks between them', () => {
    const short = graphicsRuler(3)
    expect(short.marks.map((mark) => mark.label)).toEqual(['0:00', '0:01', '0:02', '0:03'])
    expect(short.marks.map((mark) => mark.at)).toEqual([0, 1 / 3, 2 / 3, 1])
    expect(short.tick).toBeCloseTo(0.5 / 3)
    const clip = graphicsRuler(15.08)
    expect(clip.marks.map((mark) => mark.seconds)).toEqual([0, 2, 4, 6, 8, 10, 12, 14])
    expect(clip.tick).toBeCloseTo(1 / 15.08)
    expect(clip.marks.at(-1)?.at).toBeCloseTo(14 / 15.08)
  })

  it('widens the step for long clips and reads minutes', () => {
    const long = graphicsRuler(150)
    expect(long.marks.map((mark) => mark.label)).toEqual(['0:00', '0:30', '1:00', '1:30', '2:00', '2:30'])
    expect(long.tick).toBeCloseTo(6 / 150)
    expect(graphicsRuler(7200).marks.length).toBeLessThanOrEqual(9)
  })

  it('draws nothing for a clip without a duration', () => {
    expect(graphicsRuler(0)).toEqual({ tick: 0, marks: [] })
    expect(graphicsRuler(Number.NaN)).toEqual({ tick: 0, marks: [] })
  })
})
