import { describe, expect, it } from 'vitest'
import {
  characterNameStem,
  parseCharacterMetadataObject,
  resolveDisplayName,
  extractManagedFields,
  mergeManagedFields,
} from './character-name'

describe('characterNameStem', () => {
  it('strips prefixes', () => {
    expect(characterNameStem('img-french-head')).toBe('french-head')
    expect(characterNameStem('char-img-french-head')).toBe('french-head')
    expect(characterNameStem('char-the-guy')).toBe('the-guy')
  })

  it('rejects short stems', () => {
    expect(characterNameStem('img-n')).toBe('')
  })
})

describe('resolveDisplayName', () => {
  it('prefers saved display_name', () => {
    expect(resolveDisplayName({ display_name: 'the-guy' }, 'char-img-french-head')).toBe('the-guy')
    expect(resolveDisplayName('{"display_name":"Ada"}', 'char-x')).toBe('Ada')
  })

  it('falls back to stem from asset id', () => {
    expect(resolveDisplayName({}, 'char-img-french-head')).toBe('french-head')
    expect(resolveDisplayName(undefined, 'char-french-head')).toBe('french-head')
  })
})

describe('parseCharacterMetadataObject', () => {
  it('parses JSON and plain notes', () => {
    expect(parseCharacterMetadataObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseCharacterMetadataObject('hello')).toEqual({ notes: 'hello' })
  })
})

describe('extractManagedFields', () => {
  it('extracts display name and canonical/legacy notes', () => {
    expect(extractManagedFields('{"display_name":"Ada"}')).toEqual({ displayName: 'Ada', personalityNotes: undefined })
    expect(extractManagedFields('{"personality_notes":"Notes A"}')).toEqual({ displayName: undefined, personalityNotes: 'Notes A' })
    expect(extractManagedFields('{"personalityNotes":"Notes B"}')).toEqual({ displayName: undefined, personalityNotes: 'Notes B' })
    expect(extractManagedFields('Plain old note')).toEqual({ displayName: undefined, personalityNotes: 'Plain old note' })
  })
})

describe('mergeManagedFields', () => {
  it('adds managed fields and preserves others', () => {
    expect(mergeManagedFields('{"other": 1}', { displayName: 'Ada', personalityNotes: 'Notes' }))
      .toEqual({ other: 1, display_name: 'Ada', personality_notes: 'Notes' })
  })

  it('removes legacy aliases and canonical keys when blank', () => {
    expect(mergeManagedFields('{"personalityNotes":"Notes B", "notes": "C", "display_name": "Ada"}', { displayName: '', personalityNotes: '' }))
      .toEqual({})
  })
})
