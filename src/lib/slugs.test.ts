import { describe, expect, it } from 'vitest'
import { stripAssetTagsFromText, stripSlugPrefix } from './slugs'

describe('stripSlugPrefix', () => {
  it('removes a leading at sign', () => {
    expect(stripSlugPrefix('@img-justin')).toBe('img-justin')
  })

  it('leaves plain slugs unchanged', () => {
    expect(stripSlugPrefix('img-justin')).toBe('img-justin')
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
