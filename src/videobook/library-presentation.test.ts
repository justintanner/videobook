import { describe, expect, it } from 'vitest'
import {
  formatLibraryAssetDate,
  libraryAssetTitle,
  libraryEmptyCopy,
  libraryLoadingCopy,
} from './library-presentation'

describe('libraryAssetTitle', () => {
  it('prefers a nonempty human label over the artifact id', () => {
    expect(libraryAssetTitle({
      id: '0193abcd-1234-7000-8000-000000000001',
      label: 'Kitchen still',
      type: 'image',
    })).toBe('Kitchen still')
  })

  it('does not use a truncated UUID as the title', () => {
    const id = '0193abcd-1234-7000-8000-000000000001'
    expect(libraryAssetTitle({ id, label: id, type: 'video' })).toBe('Video · 00000001')
    expect(libraryAssetTitle({ id, label: '', type: 'video' })).toBe('Video · 00000001')
    expect(libraryAssetTitle({ id: id.slice(0, -1) + '2', label: '', type: 'video' }))
      .toBe('Video · 00000002')
    expect(libraryAssetTitle({ id, label: id, type: 'video' })).not.toBe(id)
    expect(libraryAssetTitle({ id, label: id, type: 'video' })).not.toBe(id.slice(0, 12))
  })
})

describe('formatLibraryAssetDate', () => {
  it('formats a short localized date instead of a raw ISO truncation', () => {
    const iso = '2026-09-13T15:04:05.000Z'
    const formatted = formatLibraryAssetDate(iso, 'en-GB')
    expect(formatted).toMatch(/13/)
    expect(formatted).toMatch(/2026/)
    expect(formatted).not.toBe(iso)
    expect(formatted).not.toBe(iso.slice(0, 10))
    expect(formatted).not.toBe(iso.slice(0, 16))
    expect(formatted.includes('T')).toBe(false)
  })

  it('returns an empty string for missing timestamps', () => {
    expect(formatLibraryAssetDate('')).toBe('')
    expect(formatLibraryAssetDate('not-a-date')).toBe('')
  })
})

describe('library empty and loading copy', () => {
  it('does not reuse the Ready empty message for other statuses', () => {
    expect(libraryEmptyCopy('ready').title).toBe('No ready media')
    expect(libraryEmptyCopy('error').title).toBe('No errors')
    expect(libraryEmptyCopy('processing').title).toBe('Nothing is processing')
    expect(libraryLoadingCopy('ready', 'library', false)).toContain('ready')
    expect(libraryLoadingCopy('ready', 'library', false)).not.toBe(libraryEmptyCopy('ready').title)
  })
})
