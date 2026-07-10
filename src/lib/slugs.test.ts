import { describe, expect, it } from 'vitest'
import {
  findByAssetSlug,
  sameAssetSlug,
  stripAssetTagsFromText,
  stripSlugPrefix,
} from './slugs'

describe('stripSlugPrefix', () => {
  it('removes a leading at sign', () => {
    expect(stripSlugPrefix('@img-justin')).toBe('img-justin')
  })

  it('leaves plain slugs unchanged', () => {
    expect(stripSlugPrefix('img-justin')).toBe('img-justin')
  })
})

describe('sameAssetSlug / findByAssetSlug', () => {
  it('equates bare and @-prefixed slugs', () => {
    expect(sameAssetSlug('@img-mmm-buttons', 'img-mmm-buttons')).toBe(true)
    expect(sameAssetSlug('img-a', 'img-b')).toBe(false)
  })

  it('finds assets regardless of @ prefix', () => {
    const assets = [
      { slug: '@img-poster-table', filePath: '/a.jpg' },
      { slug: 'img-mmm-buttons', filePath: '/b.jpg' },
    ]
    expect(findByAssetSlug('@img-mmm-buttons', assets)?.filePath).toBe('/b.jpg')
    expect(findByAssetSlug('img-poster-table', assets)?.filePath).toBe('/a.jpg')
    expect(findByAssetSlug('@img-gone', assets)).toBeUndefined()
  })
})

describe('stripAssetTagsFromText', () => {
  it('removes a standalone asset tag', () => {
    expect(stripAssetTagsFromText('@img-justin')).toBe('')
  })

  it('keeps prompt text around asset tags', () => {
    expect(stripAssetTagsFromText('@img-justin walking through a lobby')).toBe('walking through a lobby')
    expect(stripAssetTagsFromText('animate @img-justin into a confident walk')).toBe('animate into a confident walk')
  })

  it('removes slot references', () => {
    expect(stripAssetTagsFromText('@s01 camera pushes in')).toBe('camera pushes in')
  })

  it('does not remove non-asset mentions', () => {
    expect(stripAssetTagsFromText('@justin-tanner walking through a lobby')).toBe('@justin-tanner walking through a lobby')
  })
})
