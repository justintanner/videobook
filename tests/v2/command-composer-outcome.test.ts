import { describe, expect, it } from 'vitest'
import {
  composerInputAfterOutcome,
  parsePendingApplyCommand,
} from '../../src/videobook/command-composer-outcome'

describe('command composer outcome input', () => {
  it('prefills and selects an explicit apply confirmation', () => {
    expect(composerInputAfterOutcome({
      ok: true,
      nextInput: '/apply',
      selectInput: true,
    })).toEqual({ value: '/apply', select: true })
  })

  it('restores the prior apply option after a failed replacement preview', () => {
    expect(composerInputAfterOutcome({ ok: false }, '/apply'))
      .toEqual({ value: '/apply', select: true })
  })

  it('clears a prefilled apply command after a successful application', () => {
    expect(composerInputAfterOutcome({ ok: true }, '/apply ')).toBeNull()
  })

  it('keeps the cursor after an explicitly unselected retry input', () => {
    expect(composerInputAfterOutcome({
      ok: false,
      nextInput: '/apply cinematic blue hour',
      selectInput: false,
    })).toEqual({ value: '/apply cinematic blue hour', select: false })
  })

  it('parses an optional quick prompt after apply', () => {
    expect(parsePendingApplyCommand('/apply')).toEqual({ promptOverride: null })
    expect(parsePendingApplyCommand('/apply cinematic blue hour'))
      .toEqual({ promptOverride: 'cinematic blue hour' })
    expect(parsePendingApplyCommand('/apply-now')).toBeNull()
  })
})
