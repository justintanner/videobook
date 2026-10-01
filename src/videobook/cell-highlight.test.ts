import { describe, expect, it } from 'vitest'
import { addHighlight, expireHighlight, HIGHLIGHT_MS } from './cell-highlight'

describe('cell highlight', () => {
  it('adds cell ids to the highlighted set', () => {
    expect(addHighlight(new Set(), ['a', 'b'])).toEqual(new Set(['a', 'b']))
    expect(addHighlight(new Set(['a']), ['b'])).toEqual(new Set(['a', 'b']))
  })

  it('keeps the same set when nothing new is highlighted', () => {
    const current = new Set(['a'])
    expect(addHighlight(current, ['a'])).toBe(current)
    expect(addHighlight(current, [])).toBe(current)
  })

  it('re-highlighting an already highlighted cell keeps it once', () => {
    expect(addHighlight(new Set(['a']), ['a', 'b'])).toEqual(new Set(['a', 'b']))
  })

  it('expires cell ids from the highlighted set', () => {
    expect(expireHighlight(new Set(['a', 'b']), ['a'])).toEqual(new Set(['b']))
    expect(expireHighlight(new Set(['a']), ['a'])).toEqual(new Set())
  })

  it('keeps the same set when nothing highlighted expires', () => {
    const current = new Set(['a'])
    expect(expireHighlight(current, ['b'])).toBe(current)
    expect(expireHighlight(new Set(), ['a'])).toBeInstanceOf(Set)
    expect(expireHighlight(new Set(), ['a'])).toEqual(new Set())
  })

  it('highlights for a couple of seconds, longer than the arrival animation', () => {
    expect(HIGHLIGHT_MS).toBeGreaterThan(900)
    expect(HIGHLIGHT_MS).toBeLessThanOrEqual(3000)
  })
})
