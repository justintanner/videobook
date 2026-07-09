import { describe, expect, it } from 'vitest'
import { nameFromAsset, resolveSlugToAsset, seedSlotsFromCandidates } from './google-flow-character-slots'

describe('resolveSlugToAsset', () => {
  it('returns null for blank slug', () => {
    expect(resolveSlugToAsset('')).toBeNull()
    expect(resolveSlugToAsset('   ')).toBeNull()
  })

  it('prefers droppedAssets with thumbnail', () => {
    const dropped = new Map([
      ['@img-hero', {
        slug: '@img-hero',
        src: '/full.jpg',
        thumbnailSrc: '/thumb.jpg',
        type: 'image' as const,
      }],
    ])
    expect(resolveSlugToAsset('@img-hero', undefined, dropped)).toEqual({
      slug: '@img-hero',
      src: '/full.jpg',
      thumbnailSrc: '/thumb.jpg',
      type: 'image',
    })
  })

  it('matches resolvedAssets by bare or @slug', () => {
    const resolved = [{
      slug: '@img-a',
      src: '/a.jpg',
      thumbnailSrc: null,
      type: 'image' as const,
    }]
    expect(resolveSlugToAsset('img-a', resolved)?.slug).toBe('@img-a')
    expect(resolveSlugToAsset('@img-a', resolved)?.src).toBe('/a.jpg')
  })

  it('falls back to slug-only asset when unresolved', () => {
    expect(resolveSlugToAsset('img-x')).toEqual({
      slug: '@img-x',
      src: '',
      thumbnailSrc: null,
      type: 'image',
    })
  })
})

describe('seedSlotsFromCandidates', () => {
  it('fills primary then alt from candidates', () => {
    const seeded = seedSlotsFromCandidates(['@img-a', '@img-b'])
    expect(seeded.primary?.slug).toBe('@img-a')
    expect(seeded.alt?.slug).toBe('@img-b')
  })

  it('does not overwrite existing primary', () => {
    const existing = {
      primary: { slug: '@img-keep', src: '', thumbnailSrc: null, type: 'image' as const },
      alt: null,
    }
    const seeded = seedSlotsFromCandidates(['@img-a', '@img-b'], undefined, undefined, existing)
    expect(seeded.primary?.slug).toBe('@img-keep')
    expect(seeded.alt?.slug).toBe('@img-a')
  })

  it('skips duplicate alt matching primary', () => {
    const seeded = seedSlotsFromCandidates(['@img-a', '@img-a'])
    expect(seeded.primary?.slug).toBe('@img-a')
    expect(seeded.alt).toBeNull()
  })
})

describe('nameFromAsset', () => {
  it('strips @ and img- prefix from a descriptive slug', () => {
    expect(nameFromAsset({ slug: '@img-hero', src: '', type: 'image' as const })).toBe('hero')
    expect(nameFromAsset({ slug: '@img-hero-portrait', src: '', type: 'image' as const })).toBe('hero-portrait')
  })

  it('returns empty for degenerate slugs so they are never used as a name', () => {
    expect(nameFromAsset({ slug: '@img-n', src: '', type: 'image' as const })).toBe('')
    expect(nameFromAsset({ slug: '@img-j', src: '', type: 'image' as const })).toBe('')
    expect(nameFromAsset({ slug: '@img-ab', src: '', type: 'image' as const })).toBe('')
  })

  it('returns empty for null asset', () => {
    expect(nameFromAsset(null)).toBe('')
  })
})
