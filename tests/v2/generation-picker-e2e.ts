import type { Locator } from 'playwright'
import { listNotebookActions } from '../../server/src/notebook-action-catalog.js'

type PickerEntry = { familyId: string; row: string }

const entryByAction = new Map(listNotebookActions({ includeHiddenGeneration: true })
  .flatMap(action => {
    if (!action.family) return []
    const entry = { familyId: action.family.id, row: `${action.provider ?? ''}\u0000${action.variant ?? ''}` }
    return [
      [action.id, entry] as const,
      ...action.tool === 'edit_image_subjects' && action.model ? [[action.model, entry] as const] : [],
    ]
  }))

function pickerEntry(actionId: string): PickerEntry {
  const entry = entryByAction.get(actionId)
    ?? entryByAction.get(actionId.startsWith('generation.') ? actionId : `generation.${actionId}`)
  if (!entry) throw new Error(`No model family for ${actionId}`)
  return entry
}

async function providerRowValue(provider: Locator, row: string): Promise<string> {
  const values = await provider.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))
  const value = values.find(candidate => entryByAction.get(candidate)?.row === row)
  if (!value) throw new Error(`No provider row for ${row.replace('\u0000', ' ')}`)
  return value
}

export async function selectGenerationAction(editor: Locator, actionId: string): Promise<void> {
  const entry = pickerEntry(actionId)
  await editor.getByLabel('Generation model', { exact: true }).selectOption(entry.familyId)
  const provider = editor.getByLabel('Generation provider', { exact: true })
  await provider.locator('option').first().waitFor({ state: 'attached' })
  const rowValue = await provider.locator(`option[value="${actionId}"]`).count()
    ? actionId
    : await providerRowValue(provider, entry.row)
  if (await provider.inputValue() !== rowValue) await provider.selectOption(rowValue)
  if (rowValue === actionId) return
  const type = editor.getByLabel('Generation type', { exact: true })
  const option = type.locator(`option[data-action="${actionId}"]`).first()
  await option.waitFor({ state: 'attached' })
  await type.selectOption(await option.getAttribute('value') ?? '')
}
