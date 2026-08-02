import type {
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
} from 'videobook-engine'
import {
  compatibleGenerationModes,
  generationActionForSelection,
  generationActionIsCompatible,
  generationActionsForCell,
  generationSelectionForAction,
  initialGenerationSelection,
  type GenerationCellType,
  type GenerationConnectedInput,
  type GenerationControlValue,
  type NotebookGenerationAction,
} from './notebook-generation-actions'
import { nextNotebookCellSlug } from './notebook-download'

export type NotebookChatGenerationCommand = {
  cellType: GenerationCellType
  mediaKind: 'audio' | 'image' | 'video'
  prompt: string
  sourceReferences: string[]
}

export type NotebookChatGenerationDraft = {
  action: NotebookGenerationAction
  cell: NotebookCell
  connections: Array<{
    sourceCellId: string
    targetInput: string
  }>
  sourceCellIds: string[]
  sourceSlugs: string[]
}

export type NotebookChatGenerationRun = {
  cellId: string
  cellSlug: string
  sourceCellIds: string[]
  sourceSlugs: string[]
}

type NotebookToolCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>

type GenerationSource = {
  cell: NotebookCell
  kind: GenerationConnectedInput['kind']
}

const generationKinds: Record<string, {
  cellType: GenerationCellType
  mediaKind: NotebookChatGenerationCommand['mediaKind']
}> = {
  audio: { cellType: 'generate_audio', mediaKind: 'audio' },
  music: { cellType: 'generate_audio', mediaKind: 'audio' },
  song: { cellType: 'generate_audio', mediaKind: 'audio' },
  soundtrack: { cellType: 'generate_audio', mediaKind: 'audio' },
  voiceover: { cellType: 'generate_audio', mediaKind: 'audio' },
  image: { cellType: 'generate_image', mediaKind: 'image' },
  photo: { cellType: 'generate_image', mediaKind: 'image' },
  picture: { cellType: 'generate_image', mediaKind: 'image' },
  clip: { cellType: 'generate_video', mediaKind: 'video' },
  vid: { cellType: 'generate_video', mediaKind: 'video' },
  video: { cellType: 'generate_video', mediaKind: 'video' },
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function uniqueReferences(input: string): string[] {
  const references = [...input.matchAll(
    /@([a-z0-9]+(?:-[a-z0-9]+)+)/giu,
  )].map((match) => match[1]!.toLowerCase())
  return [...new Set(references)]
}

function generationPrompt(
  tail: string,
  mediaKind: NotebookChatGenerationCommand['mediaKind'],
  referenceCount: number,
): string {
  const withoutReferences = tail
    .replace(
      /(?:\b(?:with|using|from|based\s+on)\s+)?@[a-z0-9]+(?:-[a-z0-9]+)+/giu,
      ' ',
    )
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^(?:of|showing|that\s+shows?)\s+/iu, '')
    .replace(/^(?:and|but)(?:\s+|$)/iu, '')
    .replace(/\s+(?:and|with|using|from|based\s+on)$/iu, '')
    .replace(/^[,;:\s]+|[,;:\s]+$/gu, '')
  if (withoutReferences) return withoutReferences
  if (referenceCount > 0) {
    return `Create new ${mediaKind} media based on the connected references.`
  }
  return `Create new ${mediaKind} media.`
}

function mediaInputKind(cell: NotebookCell): GenerationConnectedInput['kind'] | null {
  if (cell.type === 'image' || cell.type === 'generate_image') return 'image'
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

function normalizedConnectionTarget(
  kind: GenerationConnectedInput['kind'],
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

function uniqueConnectionTargets(
  inputs: readonly GenerationConnectedInput[],
): string[] {
  const counts = new Map<string, number>()
  return inputs.map((input) => {
    const count = (counts.get(input.target) ?? 0) + 1
    counts.set(input.target, count)
    return count === 1 ? input.target : `${input.target}_${count}`
  })
}

function firstEmptyRowBelow(
  cells: readonly NotebookCell[],
  source: NotebookGridSlot,
): NotebookGridSlot {
  const occupied = new Set(cells.map((cell) =>
    `${cell.slot.row}:${cell.slot.column}`))
  for (let row = source.row + 1; ; row += 1) {
    if (!occupied.has(`${row}:${source.column}`)) {
      return { row, column: source.column }
    }
  }
}

function connectedInputCandidates(
  sources: readonly GenerationSource[],
): GenerationConnectedInput[][] {
  const generic = sources.map((source) => ({
    kind: source.kind,
    target: source.kind,
  }))
  const frameTargets = ['first_frame', 'last_frame']
  const framed = sources.map((source, index) => ({
    kind: source.kind,
    target: source.kind === 'image'
      ? frameTargets[index] ?? 'image'
      : source.kind,
  }))
  const replacedAudio = sources.map((source) => ({
    kind: source.kind,
    target: source.kind === 'audio' ? 'replace_audio' : source.kind,
  }))
  const candidates = [generic, framed, replacedAudio]
  return candidates.filter((candidate, index) =>
    candidates.findIndex((other) => JSON.stringify(other) === JSON.stringify(candidate))
      === index)
}

function selectGenerationAction(input: {
  actions: readonly NotebookGenerationAction[]
  cellType: GenerationCellType
  connectedInputs: readonly GenerationConnectedInput[]
  preferredTool?: string
}): NotebookGenerationAction | null {
  const preferred = input.preferredTool
    ? generationActionsForCell(input.actions, input.cellType).find((action) =>
        action.tool === input.preferredTool)
    : undefined
  if (preferred && generationActionIsCompatible(preferred, input.connectedInputs)) {
    return preferred
  }
  const selection = initialGenerationSelection(
    { type: input.cellType },
    input.actions,
    input.connectedInputs,
  )
  return selection
    ? generationActionForSelection(input.actions, input.cellType, selection)
    : null
}

function generationSettings(
  action: NotebookGenerationAction,
  params: Record<string, unknown> | undefined,
): Record<string, GenerationControlValue> {
  if (!params) return {}
  return Object.fromEntries(action.controls.flatMap((control) => {
    const value = params[control.name]
    return typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
      ? [[control.name, value]]
      : []
  }))
}

export function parseNotebookChatGenerationCommand(
  input: string,
): NotebookChatGenerationCommand | null {
  const match = input.trim().match(
    /^(?:please\s+)?(?:generate|gen|create|make)\s+(?:me\s+)?(?:an?\s+)?(?:new\s+)?(image|photo|picture|video|vid|clip|audio|music|song|soundtrack|voice[\s-]?over)\b([\s\S]*?)(?:\s+please)?[.!]?$/iu,
  )
  if (!match) return null
  const key = match[1]!.toLowerCase().replace(/[\s-]/gu, '')
  const kind = generationKinds[key]
  if (!kind) return null
  const sourceReferences = uniqueReferences(match[2] ?? '')
  return {
    ...kind,
    prompt: generationPrompt(match[2] ?? '', kind.mediaKind, sourceReferences.length),
    sourceReferences,
  }
}

export function notebookChatGenerationReferences(input: string): string[] {
  return uniqueReferences(input)
}

export function generationCellTypeForRoutedTool(
  tool: string,
  routedTool: string,
  actions: readonly NotebookGenerationAction[],
): GenerationCellType {
  const action = actions.find((candidate) => candidate.tool === tool)
  if (action?.cellTypes[0]) return action.cellTypes[0]
  const name = `${routedTool} ${tool}`.toLowerCase()
  if (/audio|music|speech|t2a|voice/iu.test(name)) return 'generate_audio'
  if (/image|photo|picture|qart|qr/iu.test(name)) return 'generate_image'
  return 'generate_video'
}

export function resolveNotebookChatGenerationSources(
  document: NotebookDocument,
  sourceReferences: readonly string[],
): GenerationSource[] {
  return sourceReferences.map((sourceReference) => {
    const reference = sourceReference.replace(/^@/u, '').toLowerCase()
    const exact = document.cells.find((cell) =>
      cell.slug.toLowerCase() === reference
      || cell.id.toLowerCase() === reference)
    const prefixMatches = exact
      ? []
      : document.cells.filter((cell) =>
          cell.id.toLowerCase().startsWith(reference))
    if (prefixMatches.length > 1) {
      throw new Error(`Cell reference @${reference} is ambiguous`)
    }
    const cell = exact ?? prefixMatches[0]
    if (!cell) throw new Error(`Media cell @${reference} was not found in this notebook`)
    const kind = mediaInputKind(cell)
    if (!kind) throw new Error(`@${cell.slug} is not a media-producing cell`)
    if (!cell.outputArtifactId) {
      throw new Error(`@${cell.slug} does not have media output yet`)
    }
    return { cell, kind }
  })
}

export function planNotebookChatGeneration(input: {
  actions: readonly NotebookGenerationAction[]
  cellId: string
  command: NotebookChatGenerationCommand
  document: NotebookDocument
  fallbackSlot: NotebookGridSlot
  preferredTool?: string
  routedParams?: Record<string, unknown>
}): NotebookChatGenerationDraft {
  const sources = resolveNotebookChatGenerationSources(
    input.document,
    input.command.sourceReferences,
  )
  let action: NotebookGenerationAction | null = null
  let connectedInputs: GenerationConnectedInput[] = []
  for (const candidate of connectedInputCandidates(sources)) {
    const selected = selectGenerationAction({
      actions: input.actions,
      cellType: input.command.cellType,
      connectedInputs: candidate,
      ...(input.preferredTool ? { preferredTool: input.preferredTool } : {}),
    })
    if (!selected) continue
    action = selected
    connectedInputs = candidate
    break
  }
  if (!action) {
    throw new Error(
      `No available ${input.command.mediaKind} generation action accepts these references`,
    )
  }
  const selection = generationSelectionForAction(action)
  const mode = compatibleGenerationModes(action, connectedInputs)[0]
  const settings = generationSettings(action, input.routedParams)
  const cellInputs = {
    ...(mode ? { generationMode: mode.id } : {}),
    ...(Object.keys(settings).length > 0 ? { generationSettings: settings } : {}),
  }
  const slot = sources[0]
    ? firstEmptyRowBelow(input.document.cells, sources[0].cell.slot)
    : input.fallbackSlot
  const cell: NotebookCell = {
    id: input.cellId,
    type: input.command.cellType,
    slug: nextNotebookCellSlug(input.command.cellType, input.document.cells),
    slot,
    prompt: input.command.prompt,
    ...selection,
    ...(Object.keys(cellInputs).length > 0 ? { inputs: cellInputs } : {}),
  }
  const targetInputs = uniqueConnectionTargets(connectedInputs)
  return {
    action,
    cell,
    connections: sources.map((source, index) => ({
      sourceCellId: source.cell.id,
      targetInput: targetInputs[index] ?? source.kind,
    })),
    sourceCellIds: sources.map((source) => source.cell.id),
    sourceSlugs: sources.map((source) => source.cell.slug),
  }
}

export function notebookChatGenerationConnectedInputs(
  draft: NotebookChatGenerationDraft,
  document: NotebookDocument,
): GenerationConnectedInput[] {
  return draft.connections.flatMap((connection) => {
    const source = document.cells.find((cell) => cell.id === connection.sourceCellId)
    const kind = source ? mediaInputKind(source) : null
    return kind
      ? [{ kind, target: normalizedConnectionTarget(kind, connection.targetInput) }]
      : []
  })
}

export function notebookChatGenerationSettings(
  draft: NotebookChatGenerationDraft,
): Record<string, GenerationControlValue> {
  const inputs = objectValue(draft.cell.inputs)
  const settings = objectValue(inputs?.generationSettings)
  if (!settings) return {}
  return Object.fromEntries(Object.entries(settings).flatMap(([name, value]) =>
    typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
      ? [[name, value]]
      : []))
}

export function reviseNotebookChatGenerationPrompt(
  draft: NotebookChatGenerationDraft,
  prompt: string,
): NotebookChatGenerationDraft {
  return {
    ...draft,
    cell: { ...draft.cell, prompt },
  }
}

export function reviseNotebookChatGenerationAction(
  draft: NotebookChatGenerationDraft,
  action: NotebookGenerationAction,
  connectedInputs: readonly GenerationConnectedInput[],
): NotebookChatGenerationDraft {
  if (
    !action.cellTypes.includes(draft.cell.type as GenerationCellType)
    || !generationActionIsCompatible(action, connectedInputs)
  ) {
    throw new Error('The selected generation model does not accept these inputs')
  }
  const compatibleModes = compatibleGenerationModes(action, connectedInputs)
  const currentInputs = objectValue(draft.cell.inputs) ?? {}
  const currentMode = stringValue(currentInputs.generationMode)
  const mode = compatibleModes.find((candidate) => candidate.id === currentMode)
    ?? compatibleModes[0]
  if (!mode) {
    throw new Error('The selected generation model does not have a compatible mode')
  }
  const currentSettings = notebookChatGenerationSettings(draft)
  const nextSettings = Object.fromEntries(action.controls.flatMap((control) => {
    const value = currentSettings[control.name]
    return value === undefined ? [] : [[control.name, value]]
  }))
  return {
    ...draft,
    action,
    cell: {
      ...draft.cell,
      ...generationSelectionForAction(action),
      inputs: {
        ...currentInputs,
        generationMode: mode.id,
        generationSettings: nextSettings,
      },
    },
  }
}

export function reviseNotebookChatGenerationMode(
  draft: NotebookChatGenerationDraft,
  modeId: string,
  connectedInputs: readonly GenerationConnectedInput[],
): NotebookChatGenerationDraft {
  const mode = compatibleGenerationModes(draft.action, connectedInputs)
    .find((candidate) => candidate.id === modeId)
  if (!mode) throw new Error('The selected generation type does not accept these inputs')
  return {
    ...draft,
    cell: {
      ...draft.cell,
      inputs: {
        ...(objectValue(draft.cell.inputs) ?? {}),
        generationMode: mode.id,
      },
    },
  }
}

export function reviseNotebookChatGenerationSetting(
  draft: NotebookChatGenerationDraft,
  name: string,
  value: GenerationControlValue | undefined,
): NotebookChatGenerationDraft {
  if (!draft.action.controls.some((control) => control.name === name)) {
    throw new Error(`The selected generation model does not support ${name}`)
  }
  const settings = notebookChatGenerationSettings(draft)
  if (value === undefined) delete settings[name]
  else settings[name] = value
  return {
    ...draft,
    cell: {
      ...draft.cell,
      inputs: {
        ...(objectValue(draft.cell.inputs) ?? {}),
        generationSettings: settings,
      },
    },
  }
}

export async function materializeNotebookChatGeneration(input: {
  bookId: string
  callTool: NotebookToolCall
  document: NotebookDocument
  draft: NotebookChatGenerationDraft
}): Promise<NotebookChatGenerationRun> {
  let created = false
  try {
    const value = objectValue(await input.callTool('create_notebook_cell', {
      book_id: input.bookId,
      notebook_id: input.document.id,
      cell: {
        id: input.draft.cell.id,
        type: input.draft.cell.type,
        slug: input.draft.cell.slug,
        slot: input.draft.cell.slot,
        prompt: input.draft.cell.prompt,
        provider: input.draft.cell.provider,
        model: input.draft.cell.model,
        operation: input.draft.cell.operation,
        tool: input.draft.cell.tool,
        inputs: input.draft.cell.inputs,
      },
    }))
    const cellId = stringValue(value?.id)
    if (!cellId || cellId !== input.draft.cell.id) {
      throw new Error('The server did not preserve the planned generation cell')
    }
    created = true
    for (const connection of input.draft.connections) {
      await input.callTool('connect_notebook_cells', {
        book_id: input.bookId,
        notebook_id: input.document.id,
        source_cell_id: connection.sourceCellId,
        target_cell_id: cellId,
        target_input: connection.targetInput,
      })
    }
    return {
      cellId,
      cellSlug: stringValue(value?.slug) ?? input.draft.cell.slug,
      sourceCellIds: input.draft.sourceCellIds,
      sourceSlugs: input.draft.sourceSlugs,
    }
  } catch (error) {
    if (created) {
      await input.callTool('delete_notebook_cell', {
        book_id: input.bookId,
        notebook_id: input.document.id,
        cell_id: input.draft.cell.id,
      }).catch(() => undefined)
    }
    throw error
  }
}
