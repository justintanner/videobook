export type NotebookCellUpdate = (
  patch: Record<string, unknown>,
) => Promise<boolean | void>

export async function startNotebookCellRun<Result>(input: {
  start: () => Promise<Result>
  onStarting?: () => void
  onAccepted?: () => void
  onRejected?: () => void
}): Promise<Result> {
  input.onStarting?.()
  try {
    const result = await input.start()
    input.onAccepted?.()
    return result
  } catch (error) {
    input.onRejected?.()
    throw error
  }
}

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

export async function startPlannedNotebookGeneration<Plan, Result>(input: {
  createPlan: () => Promise<Plan>
  start: (plan: Plan) => Promise<Result>
  onStarting?: () => void
  onAccepted?: () => void
  onRejected?: () => void
}): Promise<Result> {
  const plan = await input.createPlan()
  return await startNotebookCellRun({
    start: () => input.start(plan),
    onStarting: input.onStarting,
    onAccepted: input.onAccepted,
    onRejected: input.onRejected,
  })
}
