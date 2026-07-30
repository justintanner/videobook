import { describe, expect, it } from 'vitest'
import { hasExactCommandSuggestion } from '../../src/videobook/command-suggestions'

describe('command suggestions', () => {
  it('executes an exact command even when a substring match is ranked first', () => {
    const suggestions = [
      { label: '/notebooks' },
      { label: '/books' },
    ]

    expect(hasExactCommandSuggestion('/books', suggestions)).toBe(true)
    expect(hasExactCommandSuggestion('/books ', suggestions)).toBe(true)
    expect(hasExactCommandSuggestion('/book', suggestions)).toBe(false)
  })
})
