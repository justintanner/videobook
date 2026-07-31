import type { NotebookCell } from 'videobook-engine'

export type GenerationCellType =
  | 'generate_audio'
  | 'generate_image'
  | 'generate_video'

export type GenerationActionField =
  | 'provider'
  | 'model'
  | 'operation'
  | 'tool'

export type GenerationSelection = Record<GenerationActionField, string>

export type NotebookGenerationAction = {
  cellTypes: GenerationCellType[]
  provider: string
  model: string
  operation: string
  tool: string
  title: string
  isDefault: boolean
}

const generationCellTypes = new Set<string>([
  'generate_audio',
  'generate_image',
  'generate_video',
])

const generationActionFields: GenerationActionField[] = [
  'provider',
  'model',
  'operation',
  'tool',
]

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function isGenerationCellType(
  type: string,
): type is GenerationCellType {
  return generationCellTypes.has(type)
}

export function asNotebookGenerationActions(
  value: unknown,
): NotebookGenerationAction[] {
  const catalog = record(value)
  const actions = catalog?.actions
  if (!Array.isArray(actions)) return []
  return actions.flatMap((value) => {
    const action = record(value)
    if (!action || action.kind !== 'generation') return []
    const provider = stringValue(action.provider)
    const model = stringValue(action.model)
    const operation = stringValue(action.operation)
    const tool = stringValue(action.tool)
    const title = stringValue(action.title)
    const cellTypes = Array.isArray(action.cellTypes)
      ? action.cellTypes.filter((type): type is GenerationCellType =>
          typeof type === 'string' && isGenerationCellType(type))
      : []
    if (
      !provider
      || !model
      || !operation
      || !tool
      || cellTypes.length === 0
    ) {
      return []
    }
    return [{
      cellTypes,
      provider,
      model,
      operation,
      tool,
      title: title ?? tool,
      isDefault: action.isDefault === true,
    }]
  })
}

export function generationActionsForCell(
  actions: readonly NotebookGenerationAction[],
  type: GenerationCellType,
): NotebookGenerationAction[] {
  return actions.filter((action) => action.cellTypes.includes(type))
}

function actionSelection(
  action: NotebookGenerationAction,
): GenerationSelection {
  return {
    provider: action.provider,
    model: action.model,
    operation: action.operation,
    tool: action.tool,
  }
}

function currentSelection(
  cell: Pick<NotebookCell, 'provider' | 'model' | 'operation' | 'tool'>,
): GenerationSelection {
  return {
    provider: cell.provider?.trim() ?? '',
    model: cell.model?.trim() ?? '',
    operation: cell.operation?.trim() ?? '',
    tool: cell.tool?.trim() ?? '',
  }
}

function selectionScore(
  action: NotebookGenerationAction,
  selection: GenerationSelection,
): number {
  return generationActionFields.reduce(
    (score, field) =>
      selection[field] && action[field] === selection[field]
        ? score + 1
        : score,
    0,
  )
}

function bestMatchingAction(
  actions: readonly NotebookGenerationAction[],
  selection: GenerationSelection,
): NotebookGenerationAction | undefined {
  const toolMatch = selection.tool
    ? actions.find((action) => action.tool === selection.tool)
    : undefined
  if (toolMatch) return toolMatch
  const legacyToolMatch = selection.model
    ? actions.find((action) => action.tool === selection.model)
    : undefined
  if (legacyToolMatch) return legacyToolMatch
  const candidates = selection.model
    ? actions.filter((action) => action.model === selection.model)
    : selection.operation
      ? actions.filter((action) => action.operation === selection.operation)
      : selection.provider
        ? actions.filter((action) => action.provider === selection.provider)
        : []
  return candidates.reduce<NotebookGenerationAction | undefined>(
    (best, action) =>
      !best || selectionScore(action, selection) > selectionScore(best, selection)
        ? action
        : best,
    undefined,
  )
}

const imageInputOperations = new Set(['image_to_image', 'edit_image'])

export function initialGenerationSelection(
  cell: Pick<
    NotebookCell,
    'type' | 'provider' | 'model' | 'operation' | 'tool'
  >,
  actions: readonly NotebookGenerationAction[],
  options?: { hasImageInput?: boolean },
): GenerationSelection | null {
  if (!isGenerationCellType(cell.type)) return null
  const available = generationActionsForCell(actions, cell.type)
  const current = currentSelection(cell)
  const configured = bestMatchingAction(available, current)
  if (configured) return actionSelection(configured)
  if (generationActionFields.every((field) => current[field])) return current
  // An unconfigured generate_image cell with an image wired in should default
  // to an action that can actually consume that image — a text_to_image
  // fallback would silently drop the input at generation time.
  const pool = options?.hasImageInput
    ? available.filter((action) => imageInputOperations.has(action.operation))
    : []
  const candidates = pool.length > 0 ? pool : available
  const fallback = candidates.find((action) => action.isDefault) ?? candidates[0]
  return fallback ? actionSelection(fallback) : null
}

export function generationActionFieldOptions(
  actions: readonly NotebookGenerationAction[],
  type: GenerationCellType,
  selection: GenerationSelection,
  field: GenerationActionField,
): string[] {
  const fieldIndex = generationActionFields.indexOf(field)
  const candidates = generationActionFields
    .slice(0, fieldIndex)
    .reduce(
      (current, upstream) =>
        current.filter((action) => action[upstream] === selection[upstream]),
      generationActionsForCell(actions, type),
    )
  const options = new Set(candidates.map((action) => action[field]))
  if (selection[field]) options.add(selection[field])
  return [...options].sort((left, right) => left.localeCompare(right))
}

export function changeGenerationSelection(
  actions: readonly NotebookGenerationAction[],
  type: GenerationCellType,
  selection: GenerationSelection,
  field: GenerationActionField,
  value: string,
): GenerationSelection {
  const fieldIndex = generationActionFields.indexOf(field)
  const candidates = generationActionFields
    .slice(0, fieldIndex)
    .reduce(
      (current, upstream) =>
        current.filter((action) => action[upstream] === selection[upstream]),
      generationActionsForCell(actions, type),
    )
    .filter((action) => action[field] === value)
  const selected = candidates.find((action) => action.tool === selection.tool)
    ?? candidates.find((action) => action.isDefault)
    ?? candidates[0]
  return selected
    ? actionSelection(selected)
    : { ...selection, [field]: value }
}
