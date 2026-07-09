import { describe, expect, it } from 'vitest'
import { extractRichTokens, parseRichSegments } from './richPromptTokens'

function charRefTokens(text: string, assetSlugs: string[] = []) {
  const segs = parseRichSegments(text, extractRichTokens(text, assetSlugs))
  return segs
    .filter((s): s is typeof s & { token: { kind: 'character-ref'; n: number } } =>
      s.type === 'token' && s.token?.kind === 'character-ref')
    .map((s) => s.token)
}

describe('extractRichTokens — character-ref', () => {
  it('parses @character_N', () => {
    expect(charRefTokens('@character_1 walks in')).toEqual([{ kind: 'character-ref', n: 1 }])
  })

  it('parses [Character N]', () => {
    expect(charRefTokens('then [Character 2] arrives')).toEqual([{ kind: 'character-ref', n: 2 }])
  })

  it('parses bare "character N"', () => {
    expect(charRefTokens('the hero meets character 3 here')).toEqual([{ kind: 'character-ref', n: 3 }])
  })

  it('is case-insensitive', () => {
    expect(charRefTokens('@CHARACTER_2')).toEqual([{ kind: 'character-ref', n: 2 }])
  })

  it('ignores @character with no digit', () => {
    expect(charRefTokens('@character walks')).toEqual([])
  })

  it('extracts multiple refs in order', () => {
    expect(charRefTokens('@character_1 and @character_2')).toEqual([
      { kind: 'character-ref', n: 1 },
      { kind: 'character-ref', n: 2 },
    ])
  })

  it('does not collide with a slug literally named character_1', () => {
    const segs = parseRichSegments('@character_1', extractRichTokens('@character_1', ['character_1']))
    const tokens = segs.filter((s) => s.type === 'token').map((s) => s.token!.kind)
    expect(tokens).toEqual(['character-ref'])
    expect(tokens).not.toContain('slug')
  })

  it('keeps image-ref tokens working alongside character refs', () => {
    const segs = parseRichSegments(
      '[Image 1] and @character_1',
      extractRichTokens('[Image 1] and @character_1', []),
    )
    const kinds = segs.filter((s) => s.type === 'token').map((s) => s.token!.kind)
    expect(kinds).toEqual(['image-ref', 'character-ref'])
  })
})
