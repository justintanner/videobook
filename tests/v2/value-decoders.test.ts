import { describe, expect, it } from 'vitest'
import {
  nonBlankStringValue,
  nonEmptyStringValue,
  recordValue,
} from '../../src/videobook/value-decoders'

describe('recordValue', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['array', []],
    ['string', 'value'],
    ['number', 7],
  ])('rejects %s values', (_label, value) => {
    expect(recordValue(value)).toBeNull()
  })

  it('preserves record values', () => {
    const value = { nested: true }
    expect(recordValue(value)).toBe(value)
  })
})

describe('nonBlankStringValue', () => {
  it.each([undefined, null, 7, '', ' ', '\n\t'])('rejects %j', (value) => {
    expect(nonBlankStringValue(value)).toBeNull()
  })

  it('preserves surrounding whitespace in a non-blank string', () => {
    expect(nonBlankStringValue('  value  ')).toBe('  value  ')
  })
})

describe('nonEmptyStringValue', () => {
  it.each([undefined, null, 7, ''])('rejects %j', (value) => {
    expect(nonEmptyStringValue(value)).toBeNull()
  })

  it('accepts whitespace-only strings without trimming them', () => {
    expect(nonEmptyStringValue('  ')).toBe('  ')
  })
})
