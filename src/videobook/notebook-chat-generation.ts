import type {
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
} from 'videobook-engine'
import { resolveNotebookCellArtifactId } from 'videobook-engine/notebook-media-artifact'
import { notebookGridAddress } from 'videobook-engine/notebook-grid'
import { replaceNotebookMentions } from 'videobook-engine/notebook-mentions'
import { generationInputMentions } from '../../server/src/generation-input-mentions'
import { frameAspectRatio } from '../../server/src/media/frame-options'
import {
  nextNotebookHorizontalGenerationSlot,
  nextNotebookVideoGenerationSlot,
} from './notebook-grid'
import {
  compatibleGenerationModes,
  generationActionForSelection,
  generationActionIsCompatible,
  generationActionsForCell,
  generationSelectionForAction,
  initialGenerationSelection,
  type GenerationConnectedInput,
  type GenerationControlValue,
  type NotebookGenerationAction,
} from './notebook-generation-actions'
import type { NotebookGenerationCellType } from './notebook-cell-types'
import {
  notebookCellTag,
  notebookReferences,
  resolveNotebookCellReference,
} from './notebook-addressing'
import { nonBlankStringValue, recordValue } from './value-decoders'
import { notebookConnectionEdges } from './notebook-graph'

export type NotebookChatGenerationCommand = {
  cellType: NotebookGenerationCellType
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
  sourceAddresses: string[]
}

type NotebookChatGenerationRun = {
  cellId: string
  cellAddress: string
  sourceCellIds: string[]
  sourceAddresses: string[]
}

type NotebookToolCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>

type NotebookChatGenerationSource = {
  cell: NotebookCell
  kind: GenerationConnectedInput['kind']
}

function uniqueReferences(input: string): string[] {
  return notebookReferences(input)
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

function connectedInputCandidates(
  sources: readonly NotebookChatGenerationSource[],
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
  cellType: NotebookGenerationCellType
  connectedInputs: readonly GenerationConnectedInput[]
  preferredModel?: string
}): NotebookGenerationAction | null {
  const preferred = input.preferredModel
    ? generationActionsForCell(input.actions, input.cellType).find((action) =>
        action.model === input.preferredModel)
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
  const options = params.options && typeof params.options === 'object' && !Array.isArray(params.options)
    ? params.options as Record<string, unknown>
    : {}
  return Object.fromEntries(action.controls.flatMap((control) => {
    const value = options[control.name] ?? params[control.name]
    return typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
      ? [[control.name, value]]
      : []
  }))
}

export function notebookChatGenerationReferences(input: string): string[] {
  return uniqueReferences(input)
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

export function notebookChatGenerationParameterReferences(
  params: Record<string, unknown>,
): string[] {
  const refs = params.refs && typeof params.refs === 'object' && !Array.isArray(params.refs)
    ? Object.values(params.refs as Record<string, unknown>).flatMap(stringValues)
    : []
  const values = [...refs, ...Object.entries(params).flatMap(([name, value]) =>
    /(?:^|_)(?:ref|refs)$/u.test(name) ? stringValues(value) : [])]
  return uniqueReferences(values.map((value) => (
    value.startsWith('@') ? value : `@${value}`
  )).join(' '))
}

export function generationCellTypeForRoutedTool(
  tool: string,
  routedTool: string,
  actions: readonly NotebookGenerationAction[],
): NotebookGenerationCellType {
  const action = actions.find((candidate) => candidate.tool === tool)
  if (action?.cellTypes[0]) return action.cellTypes[0]
  const name = `${routedTool} ${tool}`.toLowerCase()
  if (/audio|music|speech|t2a|voice/iu.test(name)) return 'generate_audio'
  if (/image|photo|picture|qart|qr/iu.test(name)) return 'generate_image'
  return 'generate_video'
}

function notebookChatGenerationSource(
  document: NotebookDocument,
  cell: NotebookCell,
): NotebookChatGenerationSource {
  const kind = mediaInputKind(cell)
  if (!kind) throw new Error(`${notebookCellTag(cell)} is not a media-producing cell`)
  if (!resolveNotebookCellArtifactId(document, cell)) {
    throw new Error(`${notebookCellTag(cell)} does not have media output yet`)
  }
  return { cell, kind }
}

function resolveNotebookChatGenerationSources(
  document: NotebookDocument,
  sourceReferences: readonly string[],
): NotebookChatGenerationSource[] {
  return sourceReferences.map((sourceReference) =>
    notebookChatGenerationSource(
      document,
      resolveNotebookCellReference(document, sourceReference),
    ))
}

export function notebookChatGenerationSourceOptions(
  document: NotebookDocument,
  excludeCellIds: readonly string[] = [],
  targetCellId?: string,
): NotebookChatGenerationSource[] {
  const excluded = new Set(excludeCellIds)
  return document.cells.flatMap((cell) => {
    if (excluded.has(cell.id)) return []
    if (
      targetCellId
      && notebookConnectionEdges(document.cells, document.edges, cell.id, targetCellId) === null
    ) return []
    const kind = mediaInputKind(cell)
    if (!kind || !resolveNotebookCellArtifactId(document, cell)) return []
    return [{ cell, kind }]
  })
}

export function planNotebookChatGeneration(input: {
  actions: readonly NotebookGenerationAction[]
  cellId: string
  command: NotebookChatGenerationCommand
  document: NotebookDocument
  fallbackSlot: NotebookGridSlot
  lastWorkSlot?: NotebookGridSlot | null
  preferredModel?: string
  routedParams?: Record<string, unknown>
}): NotebookChatGenerationDraft {
  const sources = resolveNotebookChatGenerationSources(
    input.document,
    input.command.sourceReferences,
  )
  const cyclicSource = sources.find((source) =>
    notebookConnectionEdges(
      input.document.cells,
      input.document.edges,
      source.cell.id,
      input.cellId,
    ) === null)
  if (cyclicSource) {
    throw new Error(
      `Connecting ${notebookCellTag(cyclicSource.cell)} would create a cycle`,
    )
  }
  let action: NotebookGenerationAction | null = null
  let connectedInputs: GenerationConnectedInput[] = []
  for (const candidate of connectedInputCandidates(sources)) {
    const selected = selectGenerationAction({
      actions: input.actions,
      cellType: input.command.cellType,
      connectedInputs: candidate,
      ...(input.preferredModel ? { preferredModel: input.preferredModel } : {}),
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
  const sourceSlots = sources.map((source) => source.cell.slot)
  const lastWorkSlot = input.lastWorkSlot ?? null
  const slot = input.command.cellType === 'generate_video'
    ? nextNotebookVideoGenerationSlot(
      input.document.cells,
      sourceSlots,
      lastWorkSlot,
    )
    : input.command.cellType === 'generate_image'
      || input.command.cellType === 'generate_audio'
      ? nextNotebookHorizontalGenerationSlot(
        input.document.cells,
        sourceSlots,
        lastWorkSlot,
      )
      : input.fallbackSlot
  const cell: NotebookCell = {
    id: input.cellId,
    type: input.command.cellType,
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
    sourceAddresses: sources.map((source) => notebookCellTag(source.cell)),
  }
}

export function validateNotebookChatGenerationPromptSources(
  draft: NotebookChatGenerationDraft,
  document: NotebookDocument,
): void {
  const sourceCellIds = new Set(draft.sourceCellIds)
  for (const reference of notebookReferences(draft.cell.prompt ?? '')) {
    const cell = resolveNotebookCellReference(document, reference)
    if (!sourceCellIds.has(cell.id)) {
      throw new Error(`@${reference} is referenced but not connected`)
    }
  }
}

/**
 * The prompt the generation cell stores. Chat review speaks grid addresses
 * ("the image at @a1"), but a generation cell names its media by input slot
 * ("@image1") so moving cells never rewrites the prompt.
 */
export function notebookChatGenerationCellPrompt(
  draft: NotebookChatGenerationDraft,
  document: NotebookDocument,
): string {
  const edges = draft.connections.map((connection) => ({
    source: connection.sourceCellId,
    target: draft.cell.id,
    targetInput: connection.targetInput,
  }))
  const tokens = new Map(
    generationInputMentions(draft.cell.id, document.cells, edges,
      nonBlankStringValue(draft.cell.inputs?.generationMode) ?? undefined)
      .map((mention) => [mention.sourceCellId, mention.token]),
  )
  return replaceNotebookMentions(
    draft.cell.prompt ?? '',
    document.cells.flatMap((cell) => {
      const token = tokens.get(cell.id)
      return token
        ? [{ reference: notebookGridAddress(cell.slot), replacement: `@${token}` }]
        : []
    }),
  )
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
  const inputs = recordValue(draft.cell.inputs)
  const settings = recordValue(inputs?.generationSettings)
  const values = Object.fromEntries(Object.entries(settings ?? {}).flatMap(([name, value]) =>
    typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
      ? [[name, value]]
      : []))
  const aspectRatio = frameAspectRatio(draft.action.model, inputs ?? {})
  return aspectRatio ? { ...values, aspect_ratio: aspectRatio } : values
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
    !action.cellTypes.includes(draft.cell.type as NotebookGenerationCellType)
    || !generationActionIsCompatible(action, connectedInputs)
  ) {
    throw new Error('The selected generation model does not accept these inputs')
  }
  const compatibleModes = compatibleGenerationModes(action, connectedInputs)
  const currentInputs = recordValue(draft.cell.inputs) ?? {}
  const currentMode = nonBlankStringValue(currentInputs.generationMode)
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
        ...(recordValue(draft.cell.inputs) ?? {}),
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
        ...(recordValue(draft.cell.inputs) ?? {}),
        generationSettings: settings,
      },
    },
  }
}

export function reviseNotebookChatGenerationSources(input: {
  actions: readonly NotebookGenerationAction[]
  draft: NotebookChatGenerationDraft
  document: NotebookDocument
  sourceCellIds: readonly string[]
}): NotebookChatGenerationDraft {
  const cellType = input.draft.cell.type as NotebookGenerationCellType
  const sources = [...new Set(input.sourceCellIds)].map((cellId) => {
    const cell = input.document.cells.find((candidate) => candidate.id === cellId)
    if (!cell) throw new Error('The selected source cell is no longer available')
    if (notebookConnectionEdges(
      input.document.cells,
      input.document.edges,
      cell.id,
      input.draft.cell.id,
    ) === null) {
      throw new Error(
        `Connecting ${notebookCellTag(cell)} to ${notebookCellTag(input.draft.cell)} would create a cycle`,
      )
    }
    return notebookChatGenerationSource(input.document, cell)
  })
  const candidates = connectedInputCandidates(sources)
  let action: NotebookGenerationAction | null = null
  let connectedInputs: GenerationConnectedInput[] = []
  for (const candidate of candidates) {
    if (!generationActionIsCompatible(input.draft.action, candidate)) continue
    action = input.draft.action
    connectedInputs = candidate
    break
  }
  if (!action) {
    for (const candidate of candidates) {
      const selected = selectGenerationAction({
        actions: input.actions,
        cellType,
        connectedInputs: candidate,
      })
      if (!selected) continue
      action = selected
      connectedInputs = candidate
      break
    }
  }
  if (!action) {
    const mediaKind = cellType === 'generate_audio' ? 'audio'
      : cellType === 'generate_image' ? 'image'
      : 'video'
    throw new Error(
      `No available ${mediaKind} generation action accepts these references`,
    )
  }
  const compatibleModes = compatibleGenerationModes(action, connectedInputs)
  const currentInputs = recordValue(input.draft.cell.inputs) ?? {}
  const currentMode = nonBlankStringValue(currentInputs.generationMode)
  const mode = compatibleModes.find((candidate) => candidate.id === currentMode)
    ?? compatibleModes[0]
  if (!mode) {
    throw new Error('The selected generation model does not have a compatible mode')
  }
  const currentSettings = notebookChatGenerationSettings(input.draft)
  const nextSettings = Object.fromEntries(action.controls.flatMap((control) => {
    const value = currentSettings[control.name]
    return value === undefined ? [] : [[control.name, value]]
  }))
  const targetInputs = uniqueConnectionTargets(connectedInputs)
  return {
    action,
    cell: {
      ...input.draft.cell,
      ...generationSelectionForAction(action),
      inputs: {
        ...currentInputs,
        generationMode: mode.id,
        generationSettings: nextSettings,
      },
    },
    connections: sources.map((source, index) => ({
      sourceCellId: source.cell.id,
      targetInput: targetInputs[index] ?? source.kind,
    })),
    sourceCellIds: sources.map((source) => source.cell.id),
    sourceAddresses: sources.map((source) => notebookCellTag(source.cell)),
  }
}

export async function materializeNotebookChatGeneration(input: {
  bookId: string
  callTool: NotebookToolCall
  document: NotebookDocument
  draft: NotebookChatGenerationDraft
  expectedRevision?: string
}): Promise<NotebookChatGenerationRun> {
  let created = false
  try {
    const value = recordValue(await input.callTool('create_notebook_cell', {
      book_id: input.bookId,
      notebook_id: input.document.id,
      ...(input.expectedRevision
        ? { expected_revision: input.expectedRevision }
        : {}),
      cell: {
        id: input.draft.cell.id,
        type: input.draft.cell.type,
        slot: input.draft.cell.slot,
        prompt: notebookChatGenerationCellPrompt(input.draft, input.document),
        provider: input.draft.cell.provider,
        model: input.draft.cell.model,
        operation: input.draft.cell.operation,
        tool: input.draft.cell.tool,
        inputs: input.draft.cell.inputs,
      },
    }))
    const cellId = nonBlankStringValue(value?.id)
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
      cellAddress: nonBlankStringValue(value?.address)
        ?? notebookCellTag(input.draft.cell),
      sourceCellIds: input.draft.sourceCellIds,
      sourceAddresses: input.draft.sourceAddresses,
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
