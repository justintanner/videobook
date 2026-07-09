import { describe, expect, it } from 'vitest'
import {
  characterHandle,
  extractRichTokens,
  parseRichSegments,
  rewriteCharacterMentions,
} from './richPromptTokens'

function charRefTokens(text: string, handles: string[] = []) {
  const segs = parseRichSegments(text, extractRichTokens(text, [], handles))
  return segs
    .filter((s): s is typeof s & { token: { kind: 'character-ref'; handle: string } } =>
      s.type === 'token' && s.token?.kind === 'character-ref')
    .map((s) => s.token)
}

describe('characterHandle', () => {
  it('slugifies display names', () => {
    expect(characterHandle('Jane')).toBe('jane')
    expect(characterHandle('Jane Doe')).toBe('jane-doe')
    expect(characterHandle('j')).toBe('j')
  })

  it('returns empty for symbol-only names', () => {
    expect(characterHandle('!!!')).toBe('')
    expect(characterHandle('   ')).toBe('')
  })
})

describe('extractRichTokens — character handles', () => {
  it('matches @handle for known handles', () => {
    expect(charRefTokens('@jane walks', ['jane'])).toEqual([{ kind: 'character-ref', handle: 'jane' }])
  })

  it('does not match unknown handles', () => {
    expect(charRefTokens('@bob walks', ['jane'])).toEqual([])
  })

  it('respects word boundaries', () => {
    expect(charRefTokens('@janet walks', ['jane'])).toEqual([])
  })

  it('extracts multiple handles in order', () => {
    expect(charRefTokens('@jane and @bob', ['jane', 'bob'])).toEqual([
      { kind: 'character-ref', handle: 'jane' },
      { kind: 'character-ref', handle: 'bob' },
    ])
  })

  it('does not collide with a same-named slug', () => {
    const segs = parseRichSegments('@jane', extractRichTokens('@jane', ['jane'], ['jane']))
    const tokens = segs.filter((s) => s.type === 'token').map((s) => s.token!.kind)
    expect(tokens).toEqual(['character-ref'])
    expect(tokens).not.toContain('slug')
  })

  it('keeps image-ref tokens working alongside character handles', () => {
    const segs = parseRichSegments(
      '[Image 1] and @jane',
      extractRichTokens('[Image 1] and @jane', [], ['jane']),
    )
    const kinds = segs.filter((s) => s.type === 'token').map((s) => s.token!.kind)
    expect(kinds).toEqual(['image-ref', 'character-ref'])
  })
})

describe('rewriteCharacterMentions', () => {
  it('rewrites @handle to @character_N in refs order', () => {
    expect(
      rewriteCharacterMentions('@jane meets @bob', [
        { handle: 'jane', n: 1 },
        { handle: 'bob', n: 2 },
      ]),
    ).toBe('@character_1 meets @character_2')
  })

  it('leaves unknown handles untouched', () => {
    expect(rewriteCharacterMentions('@jane and @zzz', [{ handle: 'jane', n: 1 }])).toBe(
      '@character_1 and @zzz',
    )
  })

  it('respects boundaries (no partial match)', () => {
    expect(rewriteCharacterMentions('@janet', [{ handle: 'jane', n: 1 }])).toBe('@janet')
  })

  it('is a no-op with no refs', () => {
    expect(rewriteCharacterMentions('@jane alone', [])).toBe('@jane alone')
  })
})
