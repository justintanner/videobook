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

// ---- watermark ----

export function watermarkTimingValid(
  startSeconds: number,
  endSeconds: number | null,
  durationSeconds: number,
): boolean {
  return endSeconds !== null
    ? endSeconds > startSeconds
    : durationSeconds <= 0 || startSeconds < durationSeconds
}

export interface WatermarkValidationInput {
  includeHandle: boolean
  includeQr: boolean
  handle: string
  url: string
  durationSeconds: number | null
  qrStartSeconds: number
  qrEndSeconds: number | null
  handleStartSeconds: number
  handleEndSeconds: number | null
}

export function watermarkHandleValue(handle: string): string {
  return handle.trim().replace(/^@/, '').trim()
}

export function watermarkValidation(input: WatermarkValidationInput): ConfirmValidation {
  const handle = watermarkHandleValue(input.handle)
  const url = input.url.trim()
  const duration = input.durationSeconds ?? 0
  if (!input.includeHandle && !input.includeQr) {
    return blocking('Include a handle, a QR code, or both.')
  }
  if (input.includeHandle && !handle) {
    return blocking('Include handle is on but no handle is set. Type a handle, or turn Include handle off.')
  }
  if (input.includeQr && !url && !handle) {
    return blocking('Include QR code is on but there is nothing to link. Enter a QR link, or a handle it can point to.')
  }
  if (
    input.includeQr
    && !watermarkTimingValid(input.qrStartSeconds, input.qrEndSeconds, duration)
  ) {
    return blocking('QR end time must be after its start time.')
  }
  if (
    input.includeHandle
    && !watermarkTimingValid(input.handleStartSeconds, input.handleEndSeconds, duration)
  ) {
    return blocking('Handle end time must be after its start time.')
  }
  return VALID_CONFIRMATION
}

// ---- generation ----

interface GenerationValidationInput {
  prompt: string | null | undefined
  previewLoading: boolean
  previewError: string | null
  settingsError?: string | null
  previewStale: boolean
  promptLeaks: readonly { token: string; message: string }[]
  estimateUnknown: boolean
}

export function generationValidation(input: GenerationValidationInput): ConfirmValidation {
  if (!input.prompt?.trim()) {
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
