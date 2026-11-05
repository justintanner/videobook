import { describe, expect, it } from 'vitest'
import {
  inputFocusBackTarget,
  popInputFocus,
  pushInputFocus,
} from '../../src/videobook/input-focus-trail'

describe('input focus trail', () => {
  it('offers the cell an input was focused from', () => {
    const trail = pushInputFocus(null, 'output', 'input')
    expect(inputFocusBackTarget(trail, 'input')).toBe('output')
  })

  it('walks back through a chain of focused inputs', () => {
    const first = pushInputFocus(null, 'output', 'input')
    const second = pushInputFocus(first, 'input', 'source')
    expect(inputFocusBackTarget(second, 'source')).toBe('input')

    const back = popInputFocus(second)
    expect(inputFocusBackTarget(back, 'input')).toBe('output')
    expect(popInputFocus(back!)).toBeNull()
  })

  it('offers nothing once the selection moves anywhere else', () => {
    const trail = pushInputFocus(null, 'output', 'input')
    expect(inputFocusBackTarget(trail, 'elsewhere')).toBeNull()
    expect(inputFocusBackTarget(null, 'input')).toBeNull()
  })

  it('starts over when an input is focused from a cell off the trail', () => {
    const stale = pushInputFocus(null, 'output', 'input')
    const fresh = pushInputFocus(stale, 'elsewhere', 'other-input')
    expect(fresh.cellIds).toEqual(['elsewhere'])
    expect(inputFocusBackTarget(fresh, 'other-input')).toBe('elsewhere')
  })
})
