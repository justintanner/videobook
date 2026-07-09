import { describe, expect, it } from 'vitest'
import {
  characterHandle,
  extractRichTokens,
  parseRichSegments,
  renumberReferenceImageMarkers,
  rewriteCharacterMentions,
  stripOrphanedReferenceMarkers,
} from './richPromptTokens'

function charRefTokens(text: string, handles: string[] = []) {
  const segs = parseRichSegments(text, extractRichTokens(text, [], handles))
  return segs
    .filter((s): s is typeof s & { token: { kind: 'character-ref'; handle: string } } =>
      s.type === 'token' && s.token?.kind === 'character-ref')
    .map((s) => s.token)
}

function tokenKinds(text: string, slugs: string[] = [], handles: string[] = []) {
  return parseRichSegments(text, extractRichTokens(text, slugs, handles))
    .filter((s) => s.type === 'token')
    .map((s) => s.token!)
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

describe('extractRichTokens — positional @-mention markers', () => {
  it('tokenizes @referenceImage_N', () => {
    const tokens = tokenKinds('@referenceImage_1 in the scene')
    expect(tokens).toEqual([{ kind: 'reference-image-slot', n: 1 }])
  })

  it('tokenizes multiple @referenceImage markers', () => {
    const tokens = tokenKinds('@referenceImage_1 and @referenceImage_2 side by side')
    expect(tokens).toEqual([
      { kind: 'reference-image-slot', n: 1 },
      { kind: 'reference-image-slot', n: 2 },
    ])
  })

  it('tokenizes @referenceImage up to 7', () => {
    const tokens = tokenKinds('@referenceImage_7')
    expect(tokens).toEqual([{ kind: 'reference-image-slot', n: 7 }])
  })

  it('is case-insensitive for @referenceImage', () => {
    expect(tokenKinds('@ReferenceImage_3')).toEqual([{ kind: 'reference-image-slot', n: 3 }])
    expect(tokenKinds('@REFERENCEIMAGE_5')).toEqual([{ kind: 'reference-image-slot', n: 5 }])
  })

  it('tokenizes @referenceAudio_N', () => {
    const tokens = tokenKinds('@referenceAudio_1 narrates')
    expect(tokens).toEqual([{ kind: 'reference-audio-slot', n: 1 }])
  })

  it('tokenizes @referenceAudio up to 5', () => {
    const tokens = tokenKinds('@referenceAudio_5')
    expect(tokens).toEqual([{ kind: 'reference-audio-slot', n: 5 }])
  })

  it('is case-insensitive for @referenceAudio', () => {
    expect(tokenKinds('@ReferenceAudio_2')).toEqual([{ kind: 'reference-audio-slot', n: 2 }])
  })

  it('tokenizes literal @character_N', () => {
    const tokens = tokenKinds('@character_1 and @character_3')
    expect(tokens).toEqual([
      { kind: 'character-slot', n: 1 },
      { kind: 'character-slot', n: 3 },
    ])
  })

  it('is case-insensitive for @character_N', () => {
    expect(tokenKinds('@Character_2')).toEqual([{ kind: 'character-slot', n: 2 }])
  })

  it('respects word boundary — no partial match', () => {
    expect(tokenKinds('@referenceImage_1ing')).toEqual([])
    expect(tokenKinds('@referenceAudio_2ing')).toEqual([])
    expect(tokenKinds('@character_1ing')).toEqual([])
  })

  it('does not match @referenceImage_0 (resolver handles validity)', () => {
    const tokens = tokenKinds('@referenceImage_0')
    expect(tokens).toEqual([{ kind: 'reference-image-slot', n: 0 }])
  })

  it('coexists with @<handle> character mentions', () => {
    const tokens = tokenKinds('@jane and @character_2', [], ['jane'])
    expect(tokens).toEqual([
      { kind: 'character-ref', handle: 'jane' },
      { kind: 'character-slot', n: 2 },
    ])
  })

  it('coexists with [Image N] tokens', () => {
    const tokens = tokenKinds('[Image 1] and @referenceImage_2')
    expect(tokens).toEqual([
      { kind: 'image-ref', n: 1 },
      { kind: 'reference-image-slot', n: 2 },
    ])
  })

  it('coexists with @slug mentions', () => {
    const tokens = tokenKinds('@vid-intro and @referenceImage_1', ['vid-intro'])
    expect(tokens).toEqual([
      { kind: 'slug', slug: 'vid-intro' },
      { kind: 'reference-image-slot', n: 1 },
    ])
  })

  it('does not split @character_1 via handle regex', () => {
    const tokens = tokenKinds('@character_1', [], ['character'])
    expect(tokens).toEqual([{ kind: 'character-slot', n: 1 }])
  })
})

describe('stripOrphanedReferenceMarkers', () => {
  it('strips @character_N beyond count', () => {
    expect(
      stripOrphanedReferenceMarkers('@character_1 @character_2 @character_3', {
        character: 2,
        referenceImage: 0,
        referenceAudio: 0,
      }),
    ).toBe('@character_1 @character_2 ')
  })

  it('strips @referenceImage_N beyond count', () => {
    expect(
      stripOrphanedReferenceMarkers('@referenceImage_1 @referenceImage_4', {
        character: 0,
        referenceImage: 3,
        referenceAudio: 0,
      }),
    ).toBe('@referenceImage_1 ')
  })

  it('strips @referenceAudio_N beyond count', () => {
    expect(
      stripOrphanedReferenceMarkers('@referenceAudio_1 @referenceAudio_6', {
        character: 0,
        referenceImage: 0,
        referenceAudio: 5,
      }),
    ).toBe('@referenceAudio_1 ')
  })

  it('strips @character_0 and negative N', () => {
    expect(
      stripOrphanedReferenceMarkers('@character_0', {
        character: 3,
        referenceImage: 0,
        referenceAudio: 0,
      }),
    ).toBe('')
  })

  it('preserves valid markers', () => {
    expect(
      stripOrphanedReferenceMarkers('@character_1 @referenceImage_2 @referenceAudio_3', {
        character: 3,
        referenceImage: 3,
        referenceAudio: 5,
      }),
    ).toBe('@character_1 @referenceImage_2 @referenceAudio_3')
  })

  it('is case-insensitive', () => {
    expect(
      stripOrphanedReferenceMarkers('@Character_1 @REFERENCEIMAGE_5', {
        character: 0,
        referenceImage: 3,
        referenceAudio: 0,
      }),
    ).toBe(' ')
  })

  it('leaves non-marker text intact', () => {
    expect(
      stripOrphanedReferenceMarkers('A scene with @referenceImage_5 in background', {
        character: 0,
        referenceImage: 2,
        referenceAudio: 0,
      }),
    ).toBe('A scene with  in background')
  })

  it('is a no-op when all counts are zero', () => {
    expect(
      stripOrphanedReferenceMarkers('@character_1 @referenceImage_1 @referenceAudio_1', {
        character: 0,
        referenceImage: 0,
        referenceAudio: 0,
      }),
    ).toBe('  ')
  })

  it('handles empty text', () => {
    expect(
      stripOrphanedReferenceMarkers('', { character: 5, referenceImage: 5, referenceAudio: 5 }),
    ).toBe('')
  })
})

describe('renumberReferenceImageMarkers', () => {
  it('deletes the removed marker', () => {
    expect(renumberReferenceImageMarkers('@referenceImage_2', 2)).toBe('')
  })

  it('decrements markers greater than removedN', () => {
    expect(
      renumberReferenceImageMarkers('@referenceImage_1 @referenceImage_3 @referenceImage_4', 2),
    ).toBe('@referenceImage_1 @referenceImage_2 @referenceImage_3')
  })

  it('leaves lower markers untouched', () => {
    expect(renumberReferenceImageMarkers('@referenceImage_1 @referenceImage_2', 2)).toBe('@referenceImage_1 ')
  })

  it('leaves other @-mention kinds untouched', () => {
    expect(
      renumberReferenceImageMarkers('@character_1 @referenceImage_2 @referenceAudio_1', 2),
    ).toBe('@character_1  @referenceAudio_1')
  })

  it('is case-insensitive and normalizes to lowercase', () => {
    expect(renumberReferenceImageMarkers('@ReferenceImage_3', 1)).toBe('@referenceImage_2')
  })

  it('is a no-op when the removed marker is absent', () => {
    expect(renumberReferenceImageMarkers('@referenceImage_1 @referenceImage_2', 5)).toBe('@referenceImage_1 @referenceImage_2')
  })

  it('handles empty text', () => {
    expect(renumberReferenceImageMarkers('', 1)).toBe('')
  })
})
