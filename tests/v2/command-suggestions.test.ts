import { describe, expect, it } from 'vitest'
import {
  commandSuggestionCandidates,
  hasExactCommandSuggestion,
  isSpeakCommandPreview,
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

  it('opens the speak preview for bare /speak and /speak with text', () => {
    expect(isSpeakCommandPreview('/speak')).toBe(true)
    expect(isSpeakCommandPreview('/speak ')).toBe(true)
    expect(isSpeakCommandPreview('/speak welcome back')).toBe(true)
  })

  it('does not treat neighboring commands as the speak preview', () => {
    expect(isSpeakCommandPreview('/spe')).toBe(false)
    expect(isSpeakCommandPreview('/speaking')).toBe(false)
    expect(isSpeakCommandPreview('/say hello')).toBe(false)
    expect(isSpeakCommandPreview('/voices')).toBe(false)
    expect(isSpeakCommandPreview('speak now')).toBe(false)
  })
})
