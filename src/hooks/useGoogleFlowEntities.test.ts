import { describe, expect, it } from 'vitest'
import {
  mergeVoiceLists,
  normalizeGoogleFlowEntities,
  pickImageSlugCandidates,
} from './useGoogleFlowEntities'
import { GOOGLE_FLOW_VOICE_PRESETS } from '@/lib/google-flow-voice-presets'

describe('normalizeGoogleFlowEntities', () => {
  it('reads list_google_flow_voices envelope', () => {
    const text = JSON.stringify({
      email: 'a@b.com',
      count: 2,
      voices: [
        { ref: 'user:1-email:x-voice:aaa', display_name: 'Warm' },
        { voice: 'user:1-email:x-voice:bbb', displayName: 'Cool' },
      ],
    })
    expect(normalizeGoogleFlowEntities(text, 'voice', 'user')).toEqual([
      { ref: 'user:1-email:x-voice:aaa', displayName: 'Warm', source: 'user' },
      { ref: 'user:1-email:x-voice:bbb', displayName: 'Cool', source: 'user' },
    ])
  })

  it('reads list_google_flow_characters envelope and string items', () => {
    const text = JSON.stringify({
      characters: [
        { ref: 'user:1-character:ccc', name: 'Hero', thumbnail_url: 'https://example.com/t.jpg' },
        'user:1-character:ddd',
      ],
    })
    expect(normalizeGoogleFlowEntities(text, 'character')).toEqual([
      {
        ref: 'user:1-character:ccc',
        displayName: 'Hero',
        thumbnailUrl: 'https://example.com/t.jpg',
        image_count: null,
      },
      {
        ref: 'user:1-character:ddd',
        displayName: 'user:1-character:ddd',
      },
    ])
  })

  it('skips items without a ref', () => {
    const text = JSON.stringify({ voices: [{ display_name: 'orphan' }, { ref: 'ok' }] })
    expect(normalizeGoogleFlowEntities(text, 'voice')).toEqual([
      { ref: 'ok', displayName: 'ok' },
    ])
  })

  it('uses baseVoice as system ref when voice field is missing', () => {
    const text = JSON.stringify({
      voices: [{ baseVoice: 'Kore', displayName: 'Kore preset', source: 'system' }],
    })
    expect(normalizeGoogleFlowEntities(text, 'voice', 'system')).toEqual([
      { ref: 'Kore', displayName: 'Kore preset', source: 'system' },
    ])
  })
})

describe('mergeVoiceLists', () => {
  it('falls back to the Apicity presets when the system list is empty', () => {
    const merged = mergeVoiceLists([], [])
    expect(merged.filter((e) => e.source === 'system')).toHaveLength(GOOGLE_FLOW_VOICE_PRESETS.length)
    expect(merged.map((e) => e.ref)).toContain('Kore')
    expect(merged.map((e) => e.ref)).toContain('Puck')
  })

  it('keeps live system voices and prepends custom users', () => {
    const merged = mergeVoiceLists(
      [{ ref: 'Kore', displayName: 'Kore', source: 'system' }],
      [{ ref: 'user:1-voice:aaa', displayName: 'Mine', source: 'user' }],
    )
    expect(merged[0]).toMatchObject({ ref: 'user:1-voice:aaa', source: 'user' })
    expect(merged.some((e) => e.ref === 'Kore' && e.source === 'system')).toBe(true)
    // Live system list non-empty → no full 30-preset expansion
    expect(merged.filter((e) => e.source === 'system')).toHaveLength(1)
  })
})

describe('pickImageSlugCandidates', () => {
  it('prefers image_slugs then first_frame_slug, max 2 unique', () => {
    expect(pickImageSlugCandidates({
      image_slugs: ['@img-a', '@img-b', '@img-c'],
      first_frame_slug: '@img-start',
    })).toEqual(['@img-a', '@img-b'])
    expect(pickImageSlugCandidates({
      image_slugs: [],
      first_frame_slug: '@img-start',
    })).toEqual(['@img-start'])
    expect(pickImageSlugCandidates({
      image_slugs: ['@img-a'],
      first_frame_slug: '@img-a',
    })).toEqual(['@img-a'])
  })
})
