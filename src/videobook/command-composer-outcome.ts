import type { VoiceOutcome } from '../../server/src/voice-contract'

type ComposerInputOutcome = {
  ok: boolean
  nextInput?: string
  selectInput?: boolean
}

type ComposerInputDecision = {
  value: string
  select: boolean
}

type PendingApplyCommand = {
  promptOverride: string | null
}

export function parsePendingApplyCommand(input: string): PendingApplyCommand | null {
  const match = input.match(/^\s*\/apply(?:\s+([\s\S]*?))?\s*$/iu)
  if (!match) return null
  const promptOverride = match[1]?.trim() ?? ''
  return { promptOverride: promptOverride || null }
}

export function composerInputAfterOutcome(
  outcome: ComposerInputOutcome,
  pendingInput?: string,
): ComposerInputDecision | null {
  const value = outcome.nextInput
    ?? (!outcome.ok ? pendingInput : undefined)
  if (value === undefined) return null
  return {
    value,
    select: outcome.selectInput ?? !outcome.ok,
  }
}

/**
 * How a pending action's outcome reads to the voice session. A failed apply
 * leaves the review on screen, so it stays a review rather than a failure;
 * work the server describes as started is queued, not finished.
 */
export function pendingCommandVoiceOutcome(
  input: string,
  outcome: { ok: boolean; message: string },
): VoiceOutcome {
  if (!outcome.ok) return { status: 'review', message: outcome.message }
  if (input.trim().toLowerCase() === '/cancel') {
    return { status: 'cancelled', message: outcome.message }
  }
  return {
    status: /queued|started|running|processing/i.test(outcome.message)
      ? 'queued'
      : 'completed',
    message: outcome.message,
  }
}
