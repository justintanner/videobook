import { describe, expect, it } from 'vitest'
import {
  cellRefDragHotspot,
  cellRefTrailEnd,
  cellRefTrailPath,
  cellRefTrailStart,
} from '../../src/videobook/cell-ref-drag'

describe('the address drag trail', () => {
  it('holds the lifted token near its right end, where the design puts the pointer', () => {
    expect(cellRefDragHotspot(58, 26)).toEqual({ x: 46, y: 20 })
    expect(cellRefDragHotspot(8, 26)).toEqual({ x: 0, y: 20 })
  })

  it('draws the design trail from just above the address to the left edge of the token', () => {
    const address = { left: 16, top: 173.25, width: 25.2, height: 17.5 }
    const image = { hotspot: cellRefDragHotspot(58, 26), width: 58, height: 26 }
    const start = cellRefTrailStart(address)
    const end = cellRefTrailEnd({ x: 158, y: 120 }, image)

    expect(end).toEqual({ x: 112, y: 118 })
    expect(cellRefTrailPath(start, end)).toBe('M32 172 C 44 146, 76 124, 112 118')
  })
})
