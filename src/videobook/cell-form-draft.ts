import type { GenerationControlValue } from './notebook-generation-actions'

export type CellFormDraft = {
  prompt: string
  provider: string
  model: string
  operation: string
  tool: string
  startSeconds: string
  endSeconds: string
  overlap: string
  frameMode: 'first' | 'time' | 'last'
  timestampSeconds: string
  generationMode: string
  generationSettings: Record<string, GenerationControlValue>
}

export type CellFormSync = {
  stored: CellFormDraft
  draft: CellFormDraft
}

export const cellFormDraftFields = [
  'prompt',
  'provider',
  'model',
  'operation',
  'tool',
  'startSeconds',
  'endSeconds',
  'overlap',
  'frameMode',
  'timestampSeconds',
  'generationMode',
] as const satisfies readonly (keyof CellFormDraft)[]

const cellFormSyncFields = [
  ...cellFormDraftFields,
  'generationSettings',
] as const satisfies readonly (keyof CellFormDraft)[]

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function copyField<Field extends keyof CellFormDraft>(
  target: CellFormDraft,
  source: CellFormDraft,
  field: Field,
): void {
  target[field] = source[field]
}

export function sameCellFormDraft(left: CellFormDraft, right: CellFormDraft): boolean {
  return cellFormSyncFields.every((field) => sameValue(left[field], right[field]))
}

export function rebaseCellFormDraft(
  draft: CellFormDraft,
  before: CellFormSync,
  after: CellFormSync,
): CellFormDraft {
  const next = { ...draft }
  for (const field of cellFormSyncFields) {
    const storeChanged = !sameValue(before.stored[field], after.stored[field])
    const userChanged = !sameValue(draft[field], before.draft[field])
    if (storeChanged && !userChanged) copyField(next, after.draft, field)
  }
  return next
}
