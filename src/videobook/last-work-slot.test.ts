import { describe, expect, it } from 'vitest'
import {
  lastWorkScopeKey,
  lastWorkSlotForScope,
  withLastWorkSlot,
} from './last-work-slot'

describe('last-work slot tracking', () => {
  it('scopes last-work per book and notebook and starts empty', () => {
    expect(lastWorkScopeKey(null, 'nb-1')).toBeNull()
    expect(lastWorkScopeKey('book-1', null)).toBeNull()
    expect(lastWorkScopeKey('book-1', 'nb-1')).toBe('book-1:nb-1')
    expect(lastWorkSlotForScope({}, 'book-1:nb-1')).toBeNull()
  })

  it('remembers a slot per notebook and does not leak across notebooks', () => {
    const first = withLastWorkSlot({}, 'book-1:nb-1', { row: 4, column: 2 })
    const second = withLastWorkSlot(first, 'book-1:nb-2', { row: 8, column: 6 })
    expect(lastWorkSlotForScope(second, 'book-1:nb-1')).toEqual({
      row: 4,
      column: 2,
    })
    expect(lastWorkSlotForScope(second, 'book-1:nb-2')).toEqual({
      row: 8,
      column: 6,
    })
    expect(lastWorkSlotForScope(second, 'book-2:nb-1')).toBeNull()
  })

  it('overwrites the current notebook slot and ignores a missing scope', () => {
    const remembered = withLastWorkSlot(
      { 'book-1:nb-1': { row: 1, column: 1 } },
      'book-1:nb-1',
      { row: 2, column: 3 },
    )
    expect(lastWorkSlotForScope(remembered, 'book-1:nb-1')).toEqual({
      row: 2,
      column: 3,
    })
    expect(withLastWorkSlot(remembered, null, { row: 0, column: 0 }))
      .toEqual(remembered)
  })
})
