import type { Locator } from 'playwright'
import { listNotebookActions } from '../../server/src/notebook-action-catalog.js'

const familyByAction = new Map(listNotebookActions({ includeHiddenGeneration: true })
  .flatMap(action => action.family ? [[action.id, action.family.id] as const] : []))

function generationFamilyId(actionId: string): string {
  const familyId = familyByAction.get(actionId)
    ?? familyByAction.get(actionId.startsWith('generation.') ? actionId : `generation.${actionId}`)
  if (!familyId) throw new Error(`No model family for ${actionId}`)
  return familyId
}

export async function selectGenerationAction(editor: Locator, actionId: string): Promise<void> {
  await editor.getByLabel('Generation model', { exact: true }).selectOption(generationFamilyId(actionId))
  const provider = editor.getByLabel('Generation provider', { exact: true })
  await provider.locator(`option[value="${actionId}"]`).waitFor({ state: 'attached' })
  if (await provider.inputValue() !== actionId) await provider.selectOption(actionId)
}
