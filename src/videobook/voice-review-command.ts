import type { VoiceOutcome, VoiceReviewCommand } from '../../server/src/voice-contract'

/** What the command UI has waiting, as far as a spoken decision is concerned. */
export type PendingReviewKind = 'generation' | 'other' | 'none'

export type VoiceReviewPlan =
  | { kind: 'revise'; prompt: string }
  | { kind: 'command'; input: string }
  | { kind: 'refused'; outcome: VoiceOutcome }

// A refusal that leaves the review on screen answers with 'review', not
// 'failed': nothing was spent, the sheet is untouched, and the speaker still
// has the same three choices.
function refuse(
  status: VoiceOutcome['status'],
  message: string,
): VoiceReviewPlan {
  return { kind: 'refused', outcome: { status, message } }
}

/**
 * Turn a spoken decision about the on-screen review into the composer command
 * the sheet's own buttons run, so voice and the buttons cannot drift apart.
 * Revising is the exception: it edits the draft and leaves the review open.
 */
export function planVoiceReviewCommand(
  command: VoiceReviewCommand,
  pending: PendingReviewKind,
): VoiceReviewPlan {
  if (pending === 'none') {
    return refuse('failed', 'There is no review on screen to act on.')
  }
  if (command.decision === 'cancel') return { kind: 'command', input: '/cancel' }
  const prompt = command.prompt?.trim()
  if (command.decision === 'revise') {
    if (!prompt) {
      return refuse('review', 'Say the whole replacement prompt to revise this review.')
    }
    if (pending !== 'generation') {
      return refuse('review', 'Only a generation review has a prompt to revise.')
    }
    return { kind: 'revise', prompt }
  }
  if (prompt && pending !== 'generation') {
    return refuse('review', 'Only a generation review takes a new prompt. Apply this one as it stands, or cancel it.')
  }
  return { kind: 'command', input: prompt ? `/apply ${prompt}` : '/apply' }
}
