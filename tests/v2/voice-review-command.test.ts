import { describe, expect, it } from 'vitest'
import { pendingCommandVoiceOutcome } from '@/videobook/command-composer-outcome'
import { planVoiceReviewCommand } from '@/videobook/voice-review-command'

describe('spoken decisions about the review on screen', () => {
  it('runs the same composer commands the sheet buttons run', () => {
    expect(planVoiceReviewCommand({ decision: 'apply' }, 'generation'))
      .toEqual({ kind: 'command', input: '/apply' })
    expect(planVoiceReviewCommand({ decision: 'cancel' }, 'generation'))
      .toEqual({ kind: 'command', input: '/cancel' })
    expect(planVoiceReviewCommand({ decision: 'apply' }, 'other'))
      .toEqual({ kind: 'command', input: '/apply' })
  })

  it('revises and applies in one step when the speaker supplies a prompt', () => {
    expect(planVoiceReviewCommand(
      { decision: 'apply', prompt: '  Animate @a1, slow push in  ' },
      'generation',
    )).toEqual({ kind: 'command', input: '/apply Animate @a1, slow push in' })
  })

  it('leaves the review open when only the prompt changes', () => {
    expect(planVoiceReviewCommand(
      { decision: 'revise', prompt: 'Animate @a1, kitten jumps' },
      'generation',
    )).toEqual({ kind: 'revise', prompt: 'Animate @a1, kitten jumps' })
  })

  it('spends nothing when the decision cannot be carried out', () => {
    // Every refusal below leaves the sheet exactly as it was, so the speaker
    // still has all three choices -- hence 'review' rather than 'failed'.
    expect(planVoiceReviewCommand({ decision: 'revise' }, 'generation'))
      .toMatchObject({ kind: 'refused', outcome: { status: 'review' } })
    expect(planVoiceReviewCommand({ decision: 'revise', prompt: '   ' }, 'generation'))
      .toMatchObject({ kind: 'refused', outcome: { status: 'review' } })
    expect(planVoiceReviewCommand({ decision: 'revise', prompt: 'new words' }, 'other'))
      .toMatchObject({ kind: 'refused', outcome: { status: 'review' } })
    expect(planVoiceReviewCommand({ decision: 'apply', prompt: 'new words' }, 'other'))
      .toMatchObject({ kind: 'refused', outcome: { status: 'review' } })
    for (const decision of ['apply', 'cancel', 'revise'] as const) {
      expect(planVoiceReviewCommand({ decision, prompt: 'anything' }, 'none'))
        .toMatchObject({ kind: 'refused', outcome: { status: 'failed' } })
    }
  })

  it('reads a failed apply as a review that is still waiting', () => {
    expect(pendingCommandVoiceOutcome('/apply', { ok: false, message: 'Write a prompt before applying.' }))
      .toEqual({ status: 'review', message: 'Write a prompt before applying.' })
    expect(pendingCommandVoiceOutcome('/apply', { ok: true, message: 'Generation queued as @c6' }))
      .toEqual({ status: 'queued', message: 'Generation queued as @c6' })
    expect(pendingCommandVoiceOutcome('/apply Animate @a1', { ok: true, message: 'Applied' }))
      .toEqual({ status: 'completed', message: 'Applied' })
    expect(pendingCommandVoiceOutcome(' /CANCEL ', { ok: true, message: 'Pending action cancelled' }))
      .toEqual({ status: 'cancelled', message: 'Pending action cancelled' })
  })
})
