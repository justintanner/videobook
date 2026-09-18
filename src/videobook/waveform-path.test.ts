import { describe, expect, it } from 'vitest'
import {
  waveformBarsPath,
  waveformEnvelopePath,
  waveformSkeletonPath,
  type WaveformBarsOptions,
} from './waveform-path'

const cellBox: WaveformBarsOptions = {
  width: 240,
  height: 156,
  pitch: 4,
  minimumBarHeight: 4,
}

function barCommands(path: string): string[] {
  return path.split('M').filter(Boolean).map((command) => `M${command}`)
}

function barHeight(command: string): number {
  const [top, bottom] = command.slice(1).split('V')
  return Number(bottom) - Number(top!.split(' ')[1])
}

describe('waveformBarsPath', () => {
  it('draws one bar per pitch across the box', () => {
    const path = waveformBarsPath(Array.from({ length: 500 }, () => 0.5), cellBox)

    expect(barCommands(path)).toHaveLength(60)
  })

  it('centres the first bar half a pitch in from the left edge', () => {
    const path = waveformBarsPath([1, 1, 1, 1], cellBox)

    expect(path.startsWith('M2.00 ')).toBe(true)
  })

  it('mirrors every bar around the midline', () => {
    const path = waveformBarsPath([0.2, 0.9, 0.4, 1], cellBox)

    for (const command of barCommands(path)) {
      const [top, bottom] = command.slice(1).split('V')
      const above = 78 - Number(top!.split(' ')[1])
      const below = Number(bottom) - 78
      expect(above).toBeCloseTo(below, 2)
    }
  })

  it('scales the loudest peak to the full height and keeps quiet ones visible', () => {
    const peaks = Array.from({ length: 60 }, (_unused, index) => (index === 30 ? 1 : 0))
    const heights = barCommands(waveformBarsPath(peaks, cellBox)).map(barHeight)

    expect(Math.max(...heights)).toBeCloseTo(cellBox.height - cellBox.minimumBarHeight, 2)
    expect(Math.min(...heights)).toBeCloseTo(cellBox.minimumBarHeight, 2)
  })

  it('reads a negative peak at its magnitude', () => {
    const negative = waveformBarsPath([-1, -1, -1, -1], cellBox)
    const positive = waveformBarsPath([1, 1, 1, 1], cellBox)

    expect(negative).toBe(positive)
  })

  it('gives silence a flat run rather than nothing', () => {
    const heights = barCommands(waveformBarsPath(Array.from({ length: 120 }, () => 0), cellBox))
      .map(barHeight)

    expect(heights).toHaveLength(60)
    expect(new Set(heights.map((height) => height.toFixed(2)))).toEqual(new Set(['4.00']))
  })

  it('has no path for no peaks or a frame narrower than one bar', () => {
    expect(waveformBarsPath([], cellBox)).toBe('')
    expect(waveformBarsPath([1], { ...cellBox, width: 2 })).toBe('')
  })
})

describe('waveformSkeletonPath', () => {
  it('draws the same bar count at rest', () => {
    const skeleton = barCommands(waveformSkeletonPath(cellBox))
    const bars = barCommands(waveformBarsPath(Array.from({ length: 200 }, () => 0.5), cellBox))

    expect(skeleton).toHaveLength(bars.length)
    expect(skeleton.map(barHeight)).toEqual(bars.map(() => cellBox.minimumBarHeight))
  })
})

describe('waveformEnvelopePath', () => {
  it('spreads peaks edge to edge of the 0-100 box', () => {
    const commands = barCommands(waveformEnvelopePath([1, 0.5, 1]))

    expect(commands[0]!.startsWith('M0.000 ')).toBe(true)
    expect(commands.at(-1)!.startsWith('M100.000 ')).toBe(true)
  })

  it('parks a single peak in the middle', () => {
    expect(waveformEnvelopePath([1]).startsWith('M50.000 ')).toBe(true)
  })

  it('has no path for no peaks', () => {
    expect(waveformEnvelopePath([])).toBe('')
  })
})
