import { describe, expect, it } from 'vitest'
import {
  commandSuggestionCandidates,
  hasExactCommandSuggestion,
} from '../../src/videobook/command-suggestions'

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

  it('keeps download visible in the capped bare-slash menu', () => {
    const commands = Array.from({ length: 18 }, (_, index) => ({
      command: `/command-${index + 1}`,
    }))
    commands.push({ command: '/download' })

    const suggestions = commandSuggestionCandidates(commands, '')

    expect(suggestions).toHaveLength(12)
    expect(suggestions[0]?.command).toBe('/download')
  })

  it('preserves catalog order while filtering typed command text', () => {
    const commands = [
      { command: '/trim-video' },
      { command: '/download' },
      { command: '/download-audio' },
    ]

    expect(commandSuggestionCandidates(commands, 'down')).toEqual([
      { command: '/download' },
      { command: '/download-audio' },
    ])
  })
})
