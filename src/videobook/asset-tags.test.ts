import { describe, expect, it } from 'vitest'
import {
  EMPTY_ASSET_TAGS,
  orderedTags,
  parseAssetTags,
  type AssetTag,
} from './asset-tags'

function tag(facet: AssetTag['facet'], label: string, key = label.toLowerCase()) {
  return { facet, key, label, origin: 'manual', entity_id: null }
}

describe('parseAssetTags', () => {
  it('reads the payload the server sends', () => {
    const parsed = parseAssetTags({
      effective: [tag('places', 'Kitchen'), tag('editing', 'Wide shot')],
      manual: [tag('places', 'Kitchen')],
      automatic: [
        { ...tag('editing', 'Wide shot'), origin: 'automatic' },
      ],
      dismissed: [{ facet: 'people', key: 'crowd', label: 'Crowd' }],
      analysis: {
        source_hash: 'a'.repeat(64),
        generator: 'analyze_video',
        model: null,
        extractor_version: 'tags-v1',
        tag_count: 1,
        generation: 2,
        analyzed_at: 1700,
        stale: false,
      },
      fingerprint: 'abc123',
    })
    expect(parsed?.effective.map((entry) => entry.key)).toEqual([
      'kitchen',
      'wide shot',
    ])
    expect(parsed?.automatic[0]?.origin).toBe('automatic')
    expect(parsed?.dismissed).toEqual([
      { facet: 'people', key: 'crowd', label: 'Crowd' },
    ])
    expect(parsed?.analysis).toMatchObject({
      generator: 'analyze_video',
      extractorVersion: 'tags-v1',
      tagCount: 1,
      stale: false,
    })
    expect(parsed?.fingerprint).toBe('abc123')
  })

  it('returns null for rows that carry no tag state', () => {
    expect(parseAssetTags(null)).toBeNull()
    expect(parseAssetTags(undefined)).toBeNull()
    expect(parseAssetTags('kitchen')).toBeNull()
  })

  it('drops entries an older or malformed payload cannot describe', () => {
    const parsed = parseAssetTags({
      effective: [
        tag('places', 'Kitchen'),
        { facet: 'vibes', key: 'cozy', label: 'Cozy' },
        { facet: 'places', label: 'No key' },
        'nonsense',
      ],
    })
    expect(parsed?.effective.map((entry) => entry.label)).toEqual(['Kitchen'])
    expect(parsed?.manual).toEqual([])
    expect(parsed?.analysis).toBeNull()
    expect(parsed?.fingerprint).toBe('')
  })

  it('orders chips by facet then label so they never jump', () => {
    const ordered = orderedTags([
      { facet: 'custom', key: 'b roll', label: 'B roll', origin: 'manual', entityId: null },
      { facet: 'editing', key: 'wide shot', label: 'Wide shot', origin: 'automatic', entityId: null },
      { facet: 'people', key: 'crowd', label: 'Crowd', origin: 'automatic', entityId: null },
      { facet: 'editing', key: 'close up', label: 'Close up', origin: 'manual', entityId: null },
    ])
    expect(ordered.map((entry) => entry.label)).toEqual([
      'Crowd',
      'Close up',
      'Wide shot',
      'B roll',
    ])
  })

  it('exposes an empty value with the same shape', () => {
    expect(EMPTY_ASSET_TAGS.effective).toEqual([])
    expect(EMPTY_ASSET_TAGS.fingerprint).toBe('')
  })
})
