export type NotebookCellUpdate = (
  patch: Record<string, unknown>,
) => Promise<boolean | void>

export async function persistAndRunNotebookCell(input: {
  cellId: string
  dirty: boolean
  valid: boolean
  patch: Record<string, unknown>
  onUpdate: NotebookCellUpdate
  onRun: (cellId: string) => Promise<void>
}): Promise<boolean> {
  if (!input.valid) return false
  if (input.dirty) {
    const saved = await input.onUpdate(input.patch)
    if (saved === false) return false
  }
  await input.onRun(input.cellId)
  return true
}
