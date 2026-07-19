import { describe, expect, it } from 'vitest'
import { getClearSlotCommand, getRemoveSlotCommand } from './slot-actions'

describe('getClearSlotCommand', () => {
  it('returns the unassign command for a filled slot', () => {
    expect(getClearSlotCommand('@s02', true, true)).toBe('/unassign @s02')
  })

  it('hides clearing for empty slots and slots without a menu dispatcher', () => {
    expect(getClearSlotCommand('@s02', false, true)).toBeNull()
    expect(getClearSlotCommand('@s02', true, false)).toBeNull()
  })
})

describe('getRemoveSlotCommand', () => {
  it('returns the removal command for a stored slot', () => {
    expect(getRemoveSlotCommand('@s02', true, true)).toBe('/remove-slot @s02')
  })

  it('hides removal for virtual slots and slots without a menu dispatcher', () => {
    expect(getRemoveSlotCommand('@s02', false, true)).toBeNull()
    expect(getRemoveSlotCommand('@s02', true, false)).toBeNull()
  })
})
