import { describe, expect, it } from 'vitest'
import { pendingCommandVoiceOutcome } from '@/videobook/command-composer-outcome'
import {
  planVoiceReviewCommand,
  type PendingReview,
  type ReviewAction,
} from '@/videobook/voice-review-command'
import type { GenerationControl } from '@/videobook/notebook-generation-actions'

function select(
  name: string,
  label: string,
  options: string[],
  defaultValue?: string,
): GenerationControl {
  return {
    name,
    label,
    kind: 'select',
    valueType: 'string',
    required: false,
    options,
    description: '',
    ...(defaultValue === undefined ? {} : { defaultValue }),
  }
}

function toggle(name: string, label: string): GenerationControl {
  return {
    name,
    label,
    kind: 'boolean',
    valueType: 'boolean',
    required: false,
    options: [],
    description: '',
  }
}

const seedance: ReviewAction = {
  id: 'kie-seedance',
  title: 'Seedance 2.5 · Kie',
  controls: [
    toggle('return_last_frame', 'Return last frame'),
    toggle('generate_audio', 'Generate audio'),
    select('resolution', 'Resolution', ['720p', '1080p'], '720p'),
    select('aspect_ratio', 'Aspect ratio', ['16:9', '9:16', '1:1']),
    select('duration', 'Duration', ['5', '10'], '5'),
  ],
}

const kling: ReviewAction = {
  id: 'kling-video',
  title: 'Kling 2.5',
  controls: [
    select('duration', 'Duration', ['5', '10', '20'], '5'),
    {
      name: 'cfg_scale',
      label: 'Guidance',
      kind: 'number',
      valueType: 'number',
      required: false,
      options: [],
      minimum: 0,
      maximum: 1,
      description: '',
    },
  ],
}

const review: PendingReview = {
  kind: 'generation',
  action: seedance,
  models: [seedance, kling],
}

function refusal(command: Parameters<typeof planVoiceReviewCommand>[0]): string {
  const plan = planVoiceReviewCommand(command, review)
  if (plan.kind !== 'refused') throw new Error(`expected a refusal, got ${plan.kind}`)
  expect(plan.outcome.status).toBe('review')
  return plan.outcome.message
}

describe('spoken decisions about the review on screen', () => {
  it('runs the same composer commands the sheet buttons run', () => {
    expect(planVoiceReviewCommand({ decision: 'apply' }, review))
      .toEqual({ kind: 'command', input: '/apply' })
    expect(planVoiceReviewCommand({ decision: 'cancel' }, review))
      .toEqual({ kind: 'command', input: '/cancel' })
    expect(planVoiceReviewCommand({ decision: 'apply' }, { kind: 'other' }))
      .toEqual({ kind: 'command', input: '/apply' })
    expect(planVoiceReviewCommand(
      { decision: 'apply', prompt: '  Animate @a1, slow push in  ' },
      review,
    )).toEqual({ kind: 'command', input: '/apply Animate @a1, slow push in' })
  })

  it('changes a setting rather than writing it into the prompt', () => {
    expect(planVoiceReviewCommand(
      { decision: 'revise', settings: { duration: '10' } },
      review,
    )).toEqual({ kind: 'revise', edits: [{ kind: 'setting', name: 'duration', value: '10' }] })
  })

  it('takes the label a speaker reads off the screen', () => {
    expect(planVoiceReviewCommand(
      { decision: 'revise', settings: { 'Aspect ratio': '16:9', 'generate audio': 'off' } },
      review,
    )).toEqual({
      kind: 'revise',
      edits: [
        { kind: 'setting', name: 'aspect_ratio', value: '16:9' },
        { kind: 'setting', name: 'generate_audio', value: false },
      ],
    })
    expect(planVoiceReviewCommand(
      { decision: 'revise', settings: { resolution: 'default' } },
      review,
    )).toEqual({ kind: 'revise', edits: [{ kind: 'setting', name: 'resolution', value: undefined }] })
  })

  it('names what the model really offers instead of accepting a value it will not take', () => {
    // The case from the screenshot: "set the duration to 22 seconds" against a
    // model that only offers 5 or 10.
    expect(refusal({ decision: 'revise', settings: { duration: 22 } }))
      .toBe('Duration does not take "22". It takes 5, 10.')
    expect(refusal({ decision: 'revise', settings: { frame_rate: 60 } }))
      .toBe('This review has no "frame_rate" setting. It has Return last frame, Generate audio, Resolution, Aspect ratio, Duration.')
    expect(refusal({ decision: 'revise', settings: { 'generate audio': 'loud' } }))
      .toBe('Generate audio is on or off, not "loud".')
    expect(refusal({ decision: 'revise', model: 'Veo 3' }))
      .toBe('This review has no "Veo 3" model. It offers Seedance 2.5 · Kie, Kling 2.5.')
  })

  it('validates settings against the model the review will be on', () => {
    expect(planVoiceReviewCommand(
      { decision: 'revise', model: 'Kling', settings: { duration: '20' } },
      review,
    )).toEqual({
      kind: 'revise',
      edits: [
        { kind: 'model', actionId: 'kling-video' },
        { kind: 'setting', name: 'duration', value: '20' },
      ],
    })
    // The same value is not on offer without the model change.
    expect(refusal({ decision: 'revise', settings: { duration: '20' } }))
      .toBe('Duration does not take "20". It takes 5, 10.')
  })

  it('bounds a numeric setting by its own range', () => {
    expect(planVoiceReviewCommand(
      { decision: 'revise', model: 'Kling', settings: { guidance: 0.5 } },
      review,
    )).toMatchObject({ edits: [{ kind: 'model' }, { kind: 'setting', name: 'cfg_scale', value: 0.5 }] })
    expect(refusal({ decision: 'revise', model: 'Kling', settings: { guidance: 4 } }))
      .toBe('Guidance does not go above 1.')
  })

  it('spends nothing when the decision cannot be carried out', () => {
    expect(refusal({ decision: 'revise' }))
      .toBe('Say what to change: the prompt, the model, or one of Return last frame, Generate audio, Resolution, Aspect ratio, Duration.')
    expect(refusal({ decision: 'apply', settings: { duration: '10' } }))
      .toBe('Revise the model and settings first, then apply. Apply only takes a new prompt.')
    expect(planVoiceReviewCommand({ decision: 'revise', prompt: 'new words' }, { kind: 'other' }))
      .toMatchObject({ kind: 'refused', outcome: { status: 'review' } })
    expect(planVoiceReviewCommand({ decision: 'apply', prompt: 'new words' }, { kind: 'other' }))
      .toMatchObject({ kind: 'refused', outcome: { status: 'review' } })
    for (const decision of ['apply', 'cancel', 'revise'] as const) {
      expect(planVoiceReviewCommand({ decision, prompt: 'anything' }, { kind: 'none' }))
        .toMatchObject({ kind: 'refused', outcome: { status: 'failed' } })
    }
  })

  it('lets a chain step be applied or cancelled, but never revised', () => {
    expect(planVoiceReviewCommand({ decision: 'apply' }, { kind: 'chain-step' }))
      .toEqual({ kind: 'command', input: '/apply' })
    expect(planVoiceReviewCommand({ decision: 'cancel' }, { kind: 'chain-step' }))
      .toEqual({ kind: 'command', input: '/cancel' })
    const revised = planVoiceReviewCommand(
      { decision: 'revise', prompt: 'make it longer' },
      { kind: 'chain-step' },
    )
    expect(revised).toMatchObject({ kind: 'refused', outcome: { status: 'review' } })
    if (revised.kind === 'refused') {
      expect(revised.outcome.message).toContain('cancel to stop the whole chain')
    }
    const rewritten = planVoiceReviewCommand(
      { decision: 'apply', prompt: 'different words' },
      { kind: 'chain-step' },
    )
    expect(rewritten).toMatchObject({ kind: 'refused', outcome: { status: 'review' } })
    if (rewritten.kind === 'refused') {
      expect(rewritten.outcome.message).toContain("can't be rewritten")
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
