// Pure validators behind every confirm sheet. The footer status line and the
// Apply button read the same value, so a disabled Apply always comes with the
// reason next to it.
import {
  notebookSplitCellBudget,
  type NotebookSplitOutputMode,
} from './notebook-split-command'
import { splitSegments } from './video-split-segments'
import { xPostDraftError, type XPostDraft } from './x-post-review'

export interface ConfirmValidation {
  // Apply is disabled while this is set; the footer shows it in red.
  blocking: string | null
  // Apply stays enabled; the footer shows it in amber.
  notice: string | null
}

export const VALID_CONFIRMATION: ConfirmValidation = { blocking: null, notice: null }

function blocking(message: string): ConfirmValidation {
  return { blocking: message, notice: null }
}

function notice(message: string | null): ConfirmValidation {
  return { blocking: null, notice: message }
}

// ---- generation ----

interface GenerationValidationInput {
  prompt: string | null | undefined
  promptRequired?: boolean
  previewLoading: boolean
  previewError: string | null
  settingsError?: string | null
  previewStale: boolean
  promptLeaks: readonly { token: string; message: string }[]
  estimateUnknown: boolean
}

export function generationValidation(input: GenerationValidationInput): ConfirmValidation {
  if (input.promptRequired !== false && !input.prompt?.trim()) {
    return blocking('Write a prompt before applying.')
  }
  if (input.settingsError) return blocking(input.settingsError)
  if (input.previewStale) {
    return VALID_CONFIRMATION
  }
  if (input.previewLoading) {
    return blocking('Waiting for the server preview.')
  }
  if (input.previewError !== null) {
    return blocking(`Preview failed — ${input.previewError}`)
  }
  const [firstLeak, ...moreLeaks] = input.promptLeaks
  if (firstLeak) {
    const more = moreLeaks.length > 0 ? ` (+${moreLeaks.length} more)` : ''
    return blocking(`${firstLeak.message}${more}. Add it with Add input, or remove the mention.`)
  }
  return notice(input.estimateUnknown ? 'No cost estimate is available for this model.' : null)
}

// ---- split ----

interface SplitValidationInput {
  availableEmptyCells: number
  cutPointsSeconds: readonly number[]
  outputMode: NotebookSplitOutputMode
  sourceDurationSeconds: number
}

export function splitValidation(input: SplitValidationInput): ConfirmValidation {
  const pieces = splitSegments({
    cutPointsSeconds: input.cutPointsSeconds,
    sourceDurationSeconds: input.sourceDurationSeconds,
  })
  if (pieces.length === 0) {
    return blocking('Nothing to split yet — add a cut point.')
  }
  if (input.outputMode === 'remove' && pieces.length < 2) {
    return blocking('Removing a piece needs at least two pieces. Add a cut first.')
  }
  const needed = notebookSplitCellBudget(input.outputMode, pieces.length)
  if (input.availableEmptyCells < needed) {
    return blocking(`This split needs ${needed} empty notebook cells; ${input.availableEmptyCells} available.`)
  }
  return VALID_CONFIRMATION
}

// ---- command plan ----

interface CommandPlanValidationInput {
  suggestions: readonly { included: boolean }[] | undefined
  previews: readonly {
    valid: boolean
    warnings: readonly { message: string }[]
    conflicts: readonly { message: string }[]
  }[]
}

export function commandPlanValidation(input: CommandPlanValidationInput): ConfirmValidation {
  if (input.suggestions && input.suggestions.every((suggestion) => !suggestion.included)) {
    return blocking('Include at least one suggestion, or cancel.')
  }
  const conflict = input.previews.flatMap((preview) => preview.conflicts)[0]
  if (conflict) return blocking(conflict.message)
  if (input.previews.some((preview) => !preview.valid)) {
    return blocking('A planned edit no longer fits the current sequence. Prepare it again.')
  }
  const warnings = input.previews.flatMap((preview) => preview.warnings)
  const [firstWarning, ...moreWarnings] = warnings
  if (!firstWarning) return VALID_CONFIRMATION
  const more = moreWarnings.length > 0 ? ` (+${moreWarnings.length} more)` : ''
  return notice(`${firstWarning.message}${more}`)
}

// ---- post to X ----

export function xPostValidation(
  draft: XPostDraft,
  nowMs?: number,
  maxCharacters?: number,
): ConfirmValidation {
  const error = xPostDraftError(draft, nowMs, maxCharacters)
  return error ? blocking(error) : VALID_CONFIRMATION
}

// ---- footer status ----

type ConfirmSheetStatusState =
  | 'ready'
  | 'info'
  | 'notice'
  | 'blocking'
  | 'failed'
  | 'busy'

export interface ConfirmSheetStatus {
  state: ConfirmSheetStatusState
  message: string | null
  // A failed or info line came from the composer outcome and can be dismissed.
  dismissible: boolean
}

interface ConfirmSheetStatusInput {
  busy: boolean
  busyLabel: string
  validation: ConfirmValidation
  outcome: { ok: boolean; message: string } | null
  notice: { message: string; tone: 'error' | 'info' } | null
}

// Precedence: busy > blocking > failed > notice > info > ready. A blocking
// validation outranks an old failure because the user has to fix it first.
export function confirmSheetStatus(input: ConfirmSheetStatusInput): ConfirmSheetStatus {
  if (input.busy) return { state: 'busy', message: input.busyLabel, dismissible: false }
  if (input.validation.blocking !== null) {
    return { state: 'blocking', message: input.validation.blocking, dismissible: false }
  }
  if (input.outcome && !input.outcome.ok) {
    return { state: 'failed', message: input.outcome.message, dismissible: true }
  }
  if (input.notice?.tone === 'error') {
    return { state: 'failed', message: input.notice.message, dismissible: true }
  }
  if (input.validation.notice !== null) {
    return { state: 'notice', message: input.validation.notice, dismissible: false }
  }
  if (input.outcome?.ok) {
    return { state: 'info', message: input.outcome.message, dismissible: true }
  }
  if (input.notice) {
    return { state: 'info', message: input.notice.message, dismissible: true }
  }
  return { state: 'ready', message: null, dismissible: false }
}
