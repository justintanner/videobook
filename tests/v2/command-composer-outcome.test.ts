import { describe, expect, it } from 'vitest'
import {
  composerInputAfterOutcome,
  parsePendingApplyCommand,
  pendingCommandVoiceOutcome,
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

  it('keeps a /voices prefill in the composer so the speak preview can open', () => {
    expect(composerInputAfterOutcome({
      ok: true,
      nextInput: '/speak ',
      selectInput: false,
    })).toEqual({ value: '/speak ', select: false })
  })

  it('parses an optional quick prompt after apply', () => {
    expect(parsePendingApplyCommand('/apply')).toEqual({ promptOverride: null })
    expect(parsePendingApplyCommand('/apply cinematic blue hour'))
      .toEqual({ promptOverride: 'cinematic blue hour' })
    expect(parsePendingApplyCommand('/apply-now')).toBeNull()
  })
})

describe('pendingCommandVoiceOutcome', () => {
  it('keeps the spoken lock when applying puts the next step on screen', () => {
    expect(pendingCommandVoiceOutcome('/apply', {
      ok: true,
      message: 'Step 2 of 3: generate video, about 38 cents.',
      nextInput: '/apply',
    })).toEqual({
      status: 'review',
      message: 'Step 2 of 3: generate video, about 38 cents.',
    })
  })

  it('reports a finished chain as completed, not as another review', () => {
    expect(pendingCommandVoiceOutcome('/apply', {
      ok: true,
      message: 'Chain complete',
    })).toEqual({ status: 'completed', message: 'Chain complete' })
  })

  it('still reports a cancel and a failed apply as before', () => {
    expect(pendingCommandVoiceOutcome('/cancel', {
      ok: true,
      message: 'Chain cancelled',
    }).status).toBe('cancelled')
    expect(pendingCommandVoiceOutcome('/apply', {
      ok: false,
      message: 'Pinned target @c4 changed since planning',
    }).status).toBe('review')
  })
})
