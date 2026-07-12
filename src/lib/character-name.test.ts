import { describe, expect, it } from 'vitest'
import {
  characterNameStem,
  parseCharacterMetadataObject,
  resolveDisplayName,
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
