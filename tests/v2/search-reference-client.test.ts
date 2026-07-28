import { describe, expect, it } from 'vitest'
import {
  asSearchReferenceDescriptor,
  compatibleReferenceFile,
  searchReferenceRange,
} from '../../src/videobook/search-reference.js'

describe('reverse search reference client helpers', () => {
  it('recognizes compatible clipboard files and validates video trims', () => {
    expect(compatibleReferenceFile(
      new File(['image'], 'reference.PNG', { type: '' }),
      'image',
    )).toBe(true)
    expect(compatibleReferenceFile(
      new File(['video'], 'reference.mp4', { type: 'video/mp4' }),
      'video',
    )).toBe(true)
    expect(compatibleReferenceFile(
      new File(['audio'], 'reference.wav', { type: 'audio/wav' }),
      'video',
    )).toBe(false)

    const reference = asSearchReferenceDescriptor({
      reference_id: '019bf918-1e85-7dda-a5c2-c760b8b11367',
      kind: 'video',
      name: 'reference.mp4',
      duration_ms: 12_000,
      expires_at: 20_000,
    })
    expect(searchReferenceRange('0', '', reference)).toBeUndefined()
    expect(searchReferenceRange('2', '4.5', reference)).toEqual({
      start_seconds: 2,
      duration_seconds: 4.5,
    })
    expect(() => searchReferenceRange('10', '3', reference))
      .toThrow('extends past the end')
  })
})
