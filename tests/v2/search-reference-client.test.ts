import { describe, expect, it } from 'vitest'
import {
  asSearchReferenceDescriptor,
  compatibleReferenceFile,
  searchReferenceRange,
} from '../../src/videobook/search-reference.js'

describe('reverse search reference client helpers', () => {
  it.each(['reference.HEIC', 'reference.heif'])('accepts %s without MIME metadata', (name) => {
    const file = new File(['image'], name, { type: '' })
    expect(compatibleReferenceFile(file, 'image')).toBe(true)
    expect(compatibleReferenceFile(file, 'video')).toBe(false)
  })

  it('prefers the decoded server preview over the original media URL', () => {
    const referenceId = '019bf918-1e85-7dda-a5c2-c760b8b11367'
    expect(asSearchReferenceDescriptor({
      reference_id: referenceId,
      kind: 'image',
      name: 'reference.heic',
      expires_at: 20_000,
      preview_url: `/api/search-references/${referenceId}/preview`,
    }, '/original.heic')).toMatchObject({
      previewUrl: `/api/search-references/${referenceId}/preview`,
    })
  })

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
