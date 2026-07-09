import { describe, expect, it } from 'vitest'
import { normalizeGoogleFlowEntities } from './useGoogleFlowEntities'

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
    expect(normalizeGoogleFlowEntities(text, 'voice')).toEqual([
      { ref: 'user:1-email:x-voice:aaa', displayName: 'Warm' },
      { ref: 'user:1-email:x-voice:bbb', displayName: 'Cool' },
    ])
  })

  it('reads list_google_flow_characters envelope and string items', () => {
    const text = JSON.stringify({
      characters: [
        { ref: 'user:1-character:ccc', name: 'Hero' },
        'user:1-character:ddd',
      ],
    })
    expect(normalizeGoogleFlowEntities(text, 'character')).toEqual([
      { ref: 'user:1-character:ccc', displayName: 'Hero' },
      { ref: 'user:1-character:ddd', displayName: 'user:1-character:ddd' },
    ])
  })

  it('skips items without a ref', () => {
    const text = JSON.stringify({ voices: [{ display_name: 'orphan' }, { ref: 'ok' }] })
    expect(normalizeGoogleFlowEntities(text, 'voice')).toEqual([
      { ref: 'ok', displayName: 'ok' },
    ])
  })
})
