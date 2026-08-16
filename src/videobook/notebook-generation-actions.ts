import type {
  NotebookCell,
  NotebookEdge,
} from 'videobook-engine'

export type GenerationCellType =
  | 'generate_audio'
  | 'generate_image'
  | 'generate_video'

export type GenerationSelection = {
  provider: string
  model: string
  operation: string
  tool: string
}

export type GenerationPreviewDraft = GenerationSelection & {
  prompt: string
  inputs: Record<string, unknown>
}

export type GenerationInputKind = 'image' | 'video' | 'audio'

export type GenerationInputSlot = {
  field: string
  kind: GenerationInputKind
  targets: string[]
  min: number
  max: number | null
}

export type GenerationInputMode = {
  id: string
  slots: GenerationInputSlot[]
  requiredGroups: string[][]
}

export type GenerationInputContract = {
  modes: GenerationInputMode[]
}

export type GenerationConnectedInput = {
  kind: GenerationInputKind
  target: string
}

export type GenerationInputAttachment = {
  sourceCellId: string
  targetInput: string
  target: string
  kind: GenerationInputKind
}

export type GenerationControlValue = string | number | boolean

export type GenerationControl = {
  name: string
  label: string
  kind: 'select' | 'boolean' | 'number' | 'text'
  valueType: 'string' | 'number' | 'boolean'
  required: boolean
  defaultValue?: GenerationControlValue
  options: GenerationControlValue[]
  minimum?: number
  maximum?: number
  description: string
}

export type NotebookGenerationAction = {
  id: string
  cellTypes: GenerationCellType[]
  provider: string
  providerLabel: string
  model: string
  operation: string
  tool: string
  title: string
  isDefault: boolean
  defaultPriority: number | null
  inputContract: GenerationInputContract
  controls: GenerationControl[]
}

export function effectiveGenerationControlValue(
  control: GenerationControl,
  settings: Record<string, GenerationControlValue>,
): GenerationControlValue | undefined {
  return settings[control.name] ?? control.defaultValue
}

export function effectiveGenerationSettings(
  controls: readonly GenerationControl[],
  settings: Record<string, GenerationControlValue>,
): Record<string, GenerationControlValue> {
  return Object.fromEntries(controls.flatMap((control) => {
    const value = effectiveGenerationControlValue(control, settings)
    return value === undefined ? [] : [[control.name, value]]
  }))
}

const generationCellTypes = new Set<string>([
  'generate_audio',
  'generate_image',
  'generate_video',
])

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function inputKind(value: unknown): GenerationInputKind | null {
  return value === 'image' || value === 'video' || value === 'audio'
    ? value
    : null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function controlValue(value: unknown): GenerationControlValue | undefined {
  return typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    ? value
    : undefined
}

function generationControl(value: unknown): GenerationControl | null {
  const control = record(value)
  const name = stringValue(control?.name)
  const label = stringValue(control?.label)
  const description = stringValue(control?.description)
  const kind = control?.kind
  const valueType = control?.valueType
  if (
    !name
    || !label
    || !description
    || (kind !== 'select'
      && kind !== 'boolean'
      && kind !== 'number'
      && kind !== 'text')
    || (valueType !== 'string'
      && valueType !== 'number'
      && valueType !== 'boolean')
  ) return null
  const defaultValue = controlValue(control?.defaultValue)
  const options = Array.isArray(control?.options)
    ? control.options.flatMap((entry) => {
        const parsed = controlValue(entry)
        return parsed === undefined ? [] : [parsed]
      })
    : []
  const minimum = finiteNumber(control?.minimum)
  const maximum = finiteNumber(control?.maximum)
  return {
    name,
    label,
    kind,
    valueType,
    required: control?.required === true,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    options,
    ...(minimum === null ? {} : { minimum }),
    ...(maximum === null ? {} : { maximum }),
    description,
  }
}

function inputSlot(value: unknown): GenerationInputSlot | null {
  const slot = record(value)
  const field = stringValue(slot?.field)
  const kind = inputKind(slot?.kind)
  const targets = stringList(slot?.targets)
  const min = finiteNumber(slot?.min)
  const rawMax = slot?.max
  const max = rawMax === null ? null : finiteNumber(rawMax)
  if (!field || !kind || targets.length === 0 || min === null) return null
  if (rawMax !== null && max === null) return null
  return { field, kind, targets, min, max }
}

function inputMode(value: unknown): GenerationInputMode | null {
  const candidate = record(value)
  const id = stringValue(candidate?.id)
  if (!id || !Array.isArray(candidate?.slots)) return null
  const slots = candidate.slots
    .map(inputSlot)
    .filter((slot): slot is GenerationInputSlot => slot !== null)
  const requiredGroups = Array.isArray(candidate.requiredGroups)
    ? candidate.requiredGroups.map(stringList).filter((group) => group.length > 0)
    : []
  return { id, slots, requiredGroups }
}

function inputContract(value: unknown): GenerationInputContract | null {
  const contract = record(value)
  if (!Array.isArray(contract?.modes)) return null
  const modes = contract.modes
    .map(inputMode)
    .filter((mode): mode is GenerationInputMode => mode !== null)
  return modes.length > 0 ? { modes } : null
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
    const contract = inputContract(action.inputContract)
    const controls = Array.isArray(action.controls)
      ? action.controls
          .map(generationControl)
          .filter((control): control is GenerationControl => control !== null)
      : []
    const cellTypes = Array.isArray(action.cellTypes)
      ? action.cellTypes.filter((type): type is GenerationCellType =>
          typeof type === 'string' && isGenerationCellType(type))
      : []
    if (
      !provider
      || !model
      || !operation
      || !tool
      || !contract
      || cellTypes.length === 0
    ) {
      return []
    }
    const priority = finiteNumber(action.defaultPriority)
    return [{
      id: stringValue(action.id) ?? `generation.${tool}`,
      cellTypes,
      provider,
      providerLabel: stringValue(action.providerLabel) ?? provider,
      model,
      operation,
      tool,
      title: title ?? tool,
      isDefault: action.isDefault === true,
      defaultPriority: priority,
      inputContract: contract,
      controls,
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
  return (['provider', 'model', 'operation', 'tool'] as const).reduce(
    (score, field) =>
      selection[field] && action[field] === selection[field]
        ? score + 1
        : score,
    0,
  )
}

export function generationActionForSelection(
  actions: readonly NotebookGenerationAction[],
  type: GenerationCellType,
  selection: GenerationSelection,
): NotebookGenerationAction | null {
  const available = generationActionsForCell(actions, type)
  const toolMatch = selection.tool
    ? available.find((action) => action.tool === selection.tool)
    : undefined
  if (toolMatch) return toolMatch
  const legacyToolMatch = selection.model
    ? available.find((action) => action.tool === selection.model)
    : undefined
  if (legacyToolMatch) return legacyToolMatch
  const candidates = selection.model
    ? available.filter((action) => action.model === selection.model)
    : selection.operation
      ? available.filter((action) => action.operation === selection.operation)
      : selection.provider
        ? available.filter((action) => action.provider === selection.provider)
        : []
  return candidates.reduce<NotebookGenerationAction | null>(
    (best, action) =>
      !best || selectionScore(action, selection) > selectionScore(best, selection)
        ? action
        : best,
    null,
  )
}

export function generationInputKind(
  cell: NotebookCell,
): GenerationInputKind | null {
  if (
    cell.type === 'image'
    || cell.type === 'generate_image'
    || cell.type === 'extract_frame'
  ) return 'image'
  if (
    cell.type === 'video'
    || cell.type === 'split_video'
    || cell.type === 'generate_video'
    || cell.type === 'concat'
    || cell.type === 'splice'
  ) return 'video'
  if (
    cell.type === 'audio'
    || cell.type === 'extract_audio'
    || cell.type === 'generate_audio'
  ) return 'audio'
  return null
}

function normalizedInputTarget(
  kind: GenerationInputKind,
  targetInput: string,
): string {
  if (targetInput === 'first_frame' || targetInput === 'last_frame') {
    return targetInput
  }
  if (kind === 'audio' && targetInput === 'replace_audio') {
    return targetInput
  }
  return kind
}

export function generationConnectedInputs(
  cellId: string,
  cells: readonly NotebookCell[],
  edges: readonly NotebookEdge[],
): GenerationConnectedInput[] {
  const cellsById = new Map(cells.map((cell) => [cell.id, cell]))
  return edges.flatMap((edge) => {
    if (edge.target !== cellId) return []
    const source = cellsById.get(edge.source)
    const kind = source ? generationInputKind(source) : null
    return kind
      ? [{ kind, target: normalizedInputTarget(kind, edge.targetInput) }]
      : []
  })
}

function nextGenerationTargetInput(
  target: string,
  usedTargetInputs: ReadonlySet<string>,
): string {
  if (!usedTargetInputs.has(target)) return target
  let index = 2
  while (usedTargetInputs.has(`${target}_${index}`)) index += 1
  return `${target}_${index}`
}

export function generationInputAttachments(
  action: NotebookGenerationAction,
  modeId: string,
  cellId: string,
  cells: readonly NotebookCell[],
  edges: readonly NotebookEdge[],
): GenerationInputAttachment[] {
  const mode = action.inputContract.modes.find((candidate) =>
    candidate.id === modeId)
  if (!mode) return []

  const cellsById = new Map(cells.map((cell) => [cell.id, cell]))
  const targetEdges = edges.filter((edge) => edge.target === cellId)
  const connected = targetEdges.flatMap((edge) => {
    const source = cellsById.get(edge.source)
    const kind = source ? generationInputKind(source) : null
    return kind
      ? [{
          sourceCellId: edge.source,
          targetInput: edge.targetInput,
          target: normalizedInputTarget(kind, edge.targetInput),
          kind,
        }]
      : []
  })
  const connectedSources = new Set(targetEdges.map((edge) => edge.source))
  const usedTargetInputs = new Set(targetEdges.map((edge) => edge.targetInput))
  const options: GenerationInputAttachment[] = []
  const seen = new Set<string>()

  for (const source of cells
    .filter((candidate) => candidate.id !== cellId)
    .sort((left, right) =>
      left.slot.row - right.slot.row
      || left.slot.column - right.slot.column)) {
    if (connectedSources.has(source.id)) continue
    const kind = generationInputKind(source)
    if (!kind) continue
    for (const slot of mode.slots) {
      if (slot.kind !== kind) continue
      const count = connected.filter((input) =>
        input.kind === slot.kind && slot.targets.includes(input.target)).length
      if (slot.max !== null && count >= slot.max) continue
      for (const target of slot.targets) {
        const key = `${source.id}:${target}`
        if (seen.has(key)) continue
        seen.add(key)
        options.push({
          sourceCellId: source.id,
          targetInput: nextGenerationTargetInput(target, usedTargetInputs),
          target,
          kind,
        })
      }
    }
  }
  return options
}

function inputModeMatches(
  mode: GenerationInputMode,
  inputs: readonly GenerationConnectedInput[],
): boolean {
  const counts = new Map(mode.slots.map((slot) => [slot.field, 0]))
  const sortedInputs = [...inputs].sort((left, right) => {
    const leftSpecific = left.target === left.kind ? 0 : 1
    const rightSpecific = right.target === right.kind ? 0 : 1
    return rightSpecific - leftSpecific
  })
  for (const input of sortedInputs) {
    const candidates = mode.slots
      .filter((slot) => {
        if (slot.kind !== input.kind || !slot.targets.includes(input.target)) {
          return false
        }
        const count = counts.get(slot.field) ?? 0
        return slot.max === null || count < slot.max
      })
      .sort((left, right) => {
        const leftCount = counts.get(left.field) ?? 0
        const rightCount = counts.get(right.field) ?? 0
        const leftRequired = leftCount < left.min ? 1 : 0
        const rightRequired = rightCount < right.min ? 1 : 0
        if (leftRequired !== rightRequired) return rightRequired - leftRequired
        return left.targets.length - right.targets.length
      })
    const slot = candidates[0]
    if (!slot) return false
    counts.set(slot.field, (counts.get(slot.field) ?? 0) + 1)
  }
  if (mode.slots.some((slot) => (counts.get(slot.field) ?? 0) < slot.min)) {
    return false
  }
  return mode.requiredGroups.every((group) =>
    group.some((field) => (counts.get(field) ?? 0) > 0))
}

export function compatibleGenerationModes(
  action: NotebookGenerationAction,
  inputs: readonly GenerationConnectedInput[],
): GenerationInputMode[] {
  return action.inputContract.modes.filter((mode) =>
    inputModeMatches(mode, inputs))
}

export function generationModeIsCompatible(
  action: NotebookGenerationAction,
  modeId: string,
  inputs: readonly GenerationConnectedInput[],
): boolean {
  const mode = action.inputContract.modes.find((candidate) =>
    candidate.id === modeId)
  return Boolean(mode && inputModeMatches(mode, inputs))
}

export function initialGenerationMode(
  action: NotebookGenerationAction,
  inputs: readonly GenerationConnectedInput[],
  configured = '',
): string {
  if (
    configured
    && action.inputContract.modes.some((mode) => mode.id === configured)
  ) return configured
  return compatibleGenerationModes(action, inputs)[0]?.id
    ?? action.inputContract.modes[0]?.id
    ?? ''
}

export function generationModeLabel(modeId: string): string {
  const labels: Record<string, string> = {
    t2v: 'T2V · Text to video',
    i2v: 'I2V · Image to video',
    r2v: 'R2V · Reference to video',
    v2v: 'V2V · Video to video',
    t2i: 'T2I · Text to image',
    i2i: 'I2I · Image to image',
    t2a: 'T2A · Text to audio',
  }
  return labels[modeId]
    ?? modeId.replaceAll('-', ' ').replace(/^./, (character) =>
      character.toUpperCase())
}

export function generationActionIsCompatible(
  action: NotebookGenerationAction,
  inputs: readonly GenerationConnectedInput[],
): boolean {
  return action.inputContract.modes.some((mode) =>
    inputModeMatches(mode, inputs))
}

function compareGenerationActions(
  left: NotebookGenerationAction,
  right: NotebookGenerationAction,
): number {
  const leftPriority = left.defaultPriority ?? Number.POSITIVE_INFINITY
  const rightPriority = right.defaultPriority ?? Number.POSITIVE_INFINITY
  if (leftPriority !== rightPriority) return leftPriority - rightPriority
  const title = left.title.localeCompare(right.title)
  if (title !== 0) return title
  const provider = left.providerLabel.localeCompare(right.providerLabel)
  return provider !== 0 ? provider : left.tool.localeCompare(right.tool)
}

export function compatibleGenerationActions(
  actions: readonly NotebookGenerationAction[],
  type: GenerationCellType,
  inputs: readonly GenerationConnectedInput[],
): NotebookGenerationAction[] {
  return generationActionsForCell(actions, type)
    .filter((action) => generationActionIsCompatible(action, inputs))
    .sort(compareGenerationActions)
}

export function initialGenerationSelection(
  cell: Pick<
    NotebookCell,
    'type' | 'provider' | 'model' | 'operation' | 'tool'
  >,
  actions: readonly NotebookGenerationAction[],
  inputs: readonly GenerationConnectedInput[] = [],
): GenerationSelection | null {
  if (!isGenerationCellType(cell.type)) return null
  const current = currentSelection(cell)
  const configured = generationActionForSelection(actions, cell.type, current)
  if (configured) return actionSelection(configured)
  if (Object.values(current).every(Boolean)) return current
  const fallback = compatibleGenerationActions(actions, cell.type, inputs)[0]
  return fallback ? actionSelection(fallback) : null
}

export function generationSelectionForAction(
  action: NotebookGenerationAction,
): GenerationSelection {
  return actionSelection(action)
}

export function generationActionLabel(
  action: NotebookGenerationAction,
): string {
  return `${action.title} · ${action.providerLabel}`
}

/** "Reference to Video" -> "R2V", "Text to Image" -> "T2I", etc. */
export function abbreviateGenerationPhrases(title: string): string {
  return title.replace(
    /\b(image|text|reference|video|audio|frame)[\s-]+to[\s-]+(video|image|audio|text)\b/gi,
    (_match, from: string, to: string) =>
      `${from[0]}2${to[0]}`.toUpperCase(),
  )
}
