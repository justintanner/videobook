import type { VoiceOutcome, VoiceReviewCommand } from '../../server/src/voice-contract'
import type {
  GenerationControl,
  GenerationControlValue,
} from './notebook-generation-actions'

/** One selectable model in the review, with the settings it offers. */
export type ReviewAction = {
  id: string
  title: string
  controls: readonly GenerationControl[]
}

/** What the command UI has waiting, as far as a spoken decision is concerned. */
export type PendingReview =
  | { kind: 'none' }
  | { kind: 'other' }
  | { kind: 'generation'; action: ReviewAction; models: readonly ReviewAction[] }

export type VoiceReviewEdit =
  | { kind: 'model'; actionId: string }
  | { kind: 'prompt'; prompt: string }
  | { kind: 'setting'; name: string; value: GenerationControlValue | undefined }

export type VoiceReviewPlan =
  | { kind: 'revise'; edits: VoiceReviewEdit[] }
  | { kind: 'command'; input: string }
  | { kind: 'refused'; outcome: VoiceOutcome }

type EditOrError = VoiceReviewEdit | { error: string }

// A refusal that leaves the review on screen answers with 'review', not
// 'failed': nothing was spent, the sheet is untouched, and the speaker still
// has the same choices.
function refuse(
  status: VoiceOutcome['status'],
  message: string,
): VoiceReviewPlan {
  return { kind: 'refused', outcome: { status, message } }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim()
}

function names(values: readonly { title: string }[]): string {
  return values.map((value) => value.title).join(', ')
}

function labels(controls: readonly GenerationControl[]): string {
  return controls.length > 0
    ? controls.map((control) => control.label).join(', ')
    : 'no settings'
}

function options(control: GenerationControl): string {
  return control.options.map(String).join(', ')
}

// Spoken names arrive as the label a person would read off the screen
// ("aspect ratio") rather than the parameter name, so both are matched, then
// a containment pass catches "the ratio" and "audio".
function matchControl(
  name: string,
  controls: readonly GenerationControl[],
): GenerationControl | null {
  const needle = normalize(name)
  if (!needle) return null
  const exact = controls.find((control) =>
    normalize(control.name) === needle || normalize(control.label) === needle)
  if (exact) return exact
  const partial = controls.filter((control) =>
    normalize(control.label).includes(needle)
    || normalize(control.name).includes(needle))
  return partial.length === 1 ? partial[0]! : null
}

function booleanValue(value: string | number | boolean): boolean | null {
  if (typeof value === 'boolean') return value
  const text = normalize(String(value))
  if (['true', 'on', 'yes', 'enable', 'enabled'].includes(text)) return true
  if (['false', 'off', 'no', 'disable', 'disabled'].includes(text)) return false
  return null
}

function isDefaultValue(value: string | number | boolean): boolean {
  return typeof value === 'string'
    && ['default', 'auto', 'automatic'].includes(normalize(value))
}

function numberEdit(
  control: GenerationControl,
  value: string | number | boolean,
): EditOrError {
  const numeric = typeof value === 'number' ? value : Number(String(value).trim())
  if (typeof value === 'boolean' || !Number.isFinite(numeric)) {
    return { error: `${control.label} takes a number, not "${String(value)}".` }
  }
  if (control.minimum !== undefined && numeric < control.minimum) {
    return { error: `${control.label} does not go below ${control.minimum}.` }
  }
  if (control.maximum !== undefined && numeric > control.maximum) {
    return { error: `${control.label} does not go above ${control.maximum}.` }
  }
  if (control.options.length > 0 && !control.options.includes(numeric)) {
    return { error: `${control.label} does not take ${numeric}. It takes ${options(control)}.` }
  }
  return { kind: 'setting', name: control.name, value: numeric }
}

function settingEdit(
  name: string,
  value: string | number | boolean,
  controls: readonly GenerationControl[],
): EditOrError {
  const control = matchControl(name, controls)
  if (!control) {
    return { error: `This review has no "${name}" setting. It has ${labels(controls)}.` }
  }
  if (isDefaultValue(value)) {
    if (control.required) {
      return { error: `${control.label} has no default. It takes ${options(control)}.` }
    }
    return { kind: 'setting', name: control.name, value: undefined }
  }
  if (control.valueType === 'boolean') {
    const flag = booleanValue(value)
    if (flag === null) {
      return { error: `${control.label} is on or off, not "${String(value)}".` }
    }
    return { kind: 'setting', name: control.name, value: flag }
  }
  if (control.valueType === 'number') return numberEdit(control, value)
  const text = String(value).trim()
  const option = control.options.find((candidate) =>
    normalize(String(candidate)) === normalize(text))
  if (control.options.length > 0 && option === undefined) {
    return { error: `${control.label} does not take "${text}". It takes ${options(control)}.` }
  }
  return { kind: 'setting', name: control.name, value: option ?? text }
}

function modelEdit(
  name: string,
  models: readonly ReviewAction[],
): EditOrError {
  const needle = normalize(name)
  const match = models.find((model) => normalize(model.id) === needle)
    ?? models.find((model) => normalize(model.title) === needle)
    ?? models.find((model) => normalize(model.title).includes(needle))
  if (!match) {
    return { error: `This review has no "${name}" model. It offers ${names(models)}.` }
  }
  return { kind: 'model', actionId: match.id }
}

/**
 * Turn a spoken decision about the on-screen review into the composer command
 * the sheet's own buttons run, so voice and the buttons cannot drift apart.
 * Revising is the exception: it edits the draft and leaves the review open,
 * which is what lets someone shape a generation before paying for it.
 *
 * A setting the review does not have, or a value it will not take, is refused
 * with what it does offer. That refusal is the only way the speaker learns the
 * model's real limits, so it names them rather than just saying no.
 */
export function planVoiceReviewCommand(
  command: VoiceReviewCommand,
  pending: PendingReview,
): VoiceReviewPlan {
  if (pending.kind === 'none') {
    return refuse('failed', 'There is no review on screen to act on.')
  }
  if (command.decision === 'cancel') return { kind: 'command', input: '/cancel' }
  const prompt = command.prompt?.trim()
  const settings = Object.entries(command.settings ?? {})
  const model = command.model?.trim()
  if (command.decision === 'apply') {
    if (model || settings.length > 0) {
      return refuse('review', 'Revise the model and settings first, then apply. Apply only takes a new prompt.')
    }
    if (prompt && pending.kind !== 'generation') {
      return refuse('review', 'Only a generation review takes a new prompt. Apply this one as it stands, or cancel it.')
    }
    return { kind: 'command', input: prompt ? `/apply ${prompt}` : '/apply' }
  }
  if (pending.kind !== 'generation') {
    return refuse('review', 'Only a generation review has a prompt, a model and settings to revise.')
  }
  if (!prompt && !model && settings.length === 0) {
    return refuse('review', `Say what to change: the prompt, the model, or one of ${labels(pending.action.controls)}.`)
  }
  const edits: VoiceReviewEdit[] = []
  if (model) {
    const edit = modelEdit(model, pending.models)
    if ('error' in edit) return refuse('review', edit.error)
    edits.push(edit)
  }
  if (prompt) edits.push({ kind: 'prompt', prompt })
  // Settings belong to whichever model the review will be on once this call
  // lands, so a model change in the same breath decides what is valid.
  const target = edits.find((edit) => edit.kind === 'model')
  const controls = target
    ? pending.models.find((option) => option.id === target.actionId)?.controls ?? []
    : pending.action.controls
  for (const [name, value] of settings) {
    const edit = settingEdit(name, value, controls)
    if ('error' in edit) return refuse('review', edit.error)
    edits.push(edit)
  }
  return { kind: 'revise', edits }
}
