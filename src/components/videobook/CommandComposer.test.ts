import { describe, expect, it } from 'vitest'
import { assetMentionSuggestions } from '@/videobook/mention-suggestions'

describe('assetMentionSuggestions', () => {
  it('completes canonical book slugs after an at-sign', () => {
    expect(assetMentionSuggestions(
      ['prm-dancing-cat', 'char-dancer', 'img-neon-studio'],
      'animate @char-d',
    )).toEqual([{
      value: '@char-dancer',
      label: '@char-dancer',
      description: 'project asset',
      type: 'asset',
    }])
  })

  it('does not suggest assets without an active mention', () => {
    expect(assetMentionSuggestions(['img-cat'], 'animate img')).toEqual([])
  })
})
