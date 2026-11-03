import type { NotebookCell } from 'videobook-engine'
import { generationInputRoles } from '../../server/src/generation-input-roles'
import {
  generationInputMentions,
  remapGenerationInputLayoutPrompt,
  type GenerationInputMentionCell,
} from '../../server/src/generation-input-mentions'
import {
  generationInputPort,
  generationInputTarget,
  isGenerationFieldPort,
  nextGenerationInputPort,
  sortByGenerationInputPort,
  type GenerationInputKind,
} from '../../server/src/generation-input-targets'
import { inputLimitCap, inputLimitViolations, type InputCounts } from '../../server/src/media/input-limits'
import { itemParamDefault } from '../../server/src/media/item-param-defaults'
import type { InputLimit, ItemParamSpec, RefRole } from '../../server/src/media/types'
import {
  notebookGenerationInputKind,
  type NotebookGenerationInputMode,
  type NotebookGenerationInputSpec,
} from '../../server/src/notebook-generation-contract'

export type SlotParams = Readonly<Record<string, number>>

export type SlotConnection = {
  sourceCellId: string
  targetInput: string
  params?: SlotParams
}

export type SlotItem = {
  sourceCellId: string
  kind: GenerationInputKind
  port: string | null
  params: SlotParams
}

export type SlotColumn = {
  spec: NotebookGenerationInputSpec
  items: SlotItem[]
}

export type SlotLayout = {
  slots: SlotColumn[]
  unplaced: SlotItem[]
}

export type SlotPosition = {
  target: string | null
  index: number
}

export type SlotEdit =
  | { kind: 'move'; from: SlotPosition; to: SlotPosition; copy: boolean }
  | { kind: 'add'; sourceCellId: string; to: SlotPosition }
  | { kind: 'remove'; from: SlotPosition }
  | { kind: 'params'; at: SlotPosition; name: string; value: number | undefined }

export type SlotLayoutContext = {
  mode: Pick<NotebookGenerationInputMode, 'inputs' | 'limits'>
  modeId: string | undefined
  kinds: ReadonlyMap<string, GenerationInputKind>
  settings: Readonly<Record<string, unknown>>
}

export type SlotLayoutChange = {
  connections: SlotConnection[]
  identity: ReadonlyMap<string, string>
}

function connectionKey(sourceCellId: string, port: string): string {
  return `${sourceCellId}:${port}`
}

function settingNumber(settings: Readonly<Record<string, unknown>>, name: string): number | undefined {
  const raw = settings[name]
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function effectiveParams(
  specs: readonly ItemParamSpec[],
  stored: SlotParams | undefined,
  settings: Readonly<Record<string, unknown>>,
  index: number,
): SlotParams {
  const legacy = specs.flatMap((spec) => {
    const option = spec.legacyOptions?.[index]
    const value = option ? settingNumber(settings, option) : undefined
    return value === undefined ? [] : [[spec.name, value] as const]
  })
  return { ...Object.fromEntries(legacy), ...(stored ?? {}) }
}

function connectionItems(
  connections: readonly SlotConnection[],
  kinds: ReadonlyMap<string, GenerationInputKind>,
): Array<SlotItem & { targetInput: string }> {
  return connections.flatMap((connection) => {
    const kind = kinds.get(connection.sourceCellId)
    return kind
      ? [{ sourceCellId: connection.sourceCellId, kind, port: connection.targetInput, targetInput: connection.targetInput, params: connection.params ?? {} }]
      : []
  })
}

function columnItems(
  spec: NotebookGenerationInputSpec,
  items: ReadonlyArray<SlotItem & { targetInput: string }>,
  roles: Partial<Record<RefRole, Array<SlotItem & { targetInput: string }>>>,
): Array<SlotItem & { targetInput: string }> {
  if (isGenerationFieldPort(spec.target)) {
    return sortByGenerationInputPort(items.filter((item) =>
      item.kind === spec.kind && generationInputTarget(item.kind, item.targetInput) === spec.target), spec.target)
  }
  return spec.sent
    ? roles[spec.target as RefRole] ?? []
    : items.filter((item) => item.targetInput === spec.target && item.kind === spec.kind)
}

export function slotLayout(connections: readonly SlotConnection[], context: SlotLayoutContext): SlotLayout {
  const items = connectionItems(connections, context.kinds)
  const sentRoles = new Set(context.mode.inputs.filter((spec) => spec.sent).map((spec) => spec.target as RefRole))
  const roles = generationInputRoles(items, sentRoles, context.modeId)
  const placed = new Set<SlotItem>()
  const slots = context.mode.inputs.map((spec) => {
    const list = columnItems(spec, items, roles)
    list.forEach((item) => placed.add(item))
    return {
      spec,
      items: list.map(({ targetInput: _port, ...item }, index) => ({
        ...item,
        params: effectiveParams(spec.itemParams, item.params, context.settings, index),
      })),
    }
  })
  return {
    slots,
    unplaced: items.filter((item) => !placed.has(item)).map(({ targetInput: _port, ...item }) => item),
  }
}

function portBase(port: string): string {
  const match = (isGenerationFieldPort(port) ? /^(.*?)(?:#\d+)?$/u : /^(.*?)(?:_\d+)?$/u).exec(port)
  return match?.[1] || port
}

type PlannedConnection = SlotConnection & { from: string | null }

function columnSignature(items: readonly SlotItem[]): string {
  return JSON.stringify(items.map((item) => [item.sourceCellId, item.port]))
}

function keptColumnConnections(column: SlotColumn, previous: SlotLayout | undefined): PlannedConnection[] | null {
  const before = previous?.slots.find((candidate) => candidate.spec.target === column.spec.target)
  if (!before || columnSignature(before.items) !== columnSignature(column.items)) return null
  if (column.items.some((item) => !item.port)) return null
  return column.items.map((item) => ({ sourceCellId: item.sourceCellId, targetInput: item.port!, params: item.params, from: item.port }))
}

function renumberedColumnConnections(column: SlotColumn, used: Set<string>): PlannedConnection[] {
  let position = 1
  return column.items.map((item) => {
    while (used.has(generationInputPort(column.spec.target, position))) position += 1
    const targetInput = generationInputPort(column.spec.target, position)
    used.add(targetInput)
    position += 1
    return { sourceCellId: item.sourceCellId, targetInput, params: item.params, from: item.port }
  })
}

function unplacedConnections(items: readonly SlotItem[], used: Set<string>): PlannedConnection[] {
  return items.flatMap((item) => {
    if (!item.port) return []
    const targetInput = used.has(item.port) ? nextGenerationInputPort(portBase(item.port), used) : item.port
    used.add(targetInput)
    return [{ sourceCellId: item.sourceCellId, targetInput, params: item.params, from: item.port }]
  })
}

export function slotLayoutConnections(layout: SlotLayout, previous?: SlotLayout): SlotLayoutChange {
  const kept = new Map(layout.slots.flatMap((column) => {
    const connections = keptColumnConnections(column, previous)
    return connections ? [[column.spec.target, connections] as const] : []
  }))
  const used = new Set([...kept.values()].flat().map((connection) => connection.targetInput))
  const placed = layout.slots.flatMap((column) => kept.get(column.spec.target) ?? renumberedColumnConnections(column, used))
  const all = [...placed, ...unplacedConnections(layout.unplaced, used)]
  const identity = new Map(all.flatMap((connection) => connection.from
    ? [[connectionKey(connection.sourceCellId, connection.from), connection.targetInput] as const]
    : []))
  return {
    connections: all.map(({ from: _from, params, ...connection }) =>
      params && Object.keys(params).length > 0 ? { ...connection, params } : connection),
    identity,
  }
}

function listAt(layout: SlotLayout, target: string | null): SlotItem[] | null {
  if (target === null) return layout.unplaced
  return layout.slots.find((column) => column.spec.target === target)?.items ?? null
}

function withList(layout: SlotLayout, target: string | null, items: SlotItem[]): SlotLayout {
  if (target === null) return { ...layout, unplaced: items }
  return {
    ...layout,
    slots: layout.slots.map((column) => column.spec.target === target ? { ...column, items } : column),
  }
}

function inserted(items: readonly SlotItem[], index: number, item: SlotItem): SlotItem[] {
  const at = Math.max(0, Math.min(index, items.length))
  return [...items.slice(0, at), item, ...items.slice(at)]
}

function moved(layout: SlotLayout, edit: Extract<SlotEdit, { kind: 'move' }>): SlotLayout {
  const source = listAt(layout, edit.from.target)
  const item = source?.[edit.from.index]
  if (!source || !item || !listAt(layout, edit.to.target)) return layout
  const copy = edit.copy ? { ...item, port: null, params: {} } : item
  const removed = edit.copy ? layout : withList(layout, edit.from.target, source.filter((_, index) => index !== edit.from.index))
  const sameList = edit.from.target === edit.to.target
  const index = sameList && !edit.copy && edit.from.index < edit.to.index ? edit.to.index - 1 : edit.to.index
  return withList(removed, edit.to.target, inserted(listAt(removed, edit.to.target)!, index, copy))
}

function withParam(layout: SlotLayout, edit: Extract<SlotEdit, { kind: 'params' }>): SlotLayout {
  const items = listAt(layout, edit.at.target)
  const item = items?.[edit.at.index]
  if (!items || !item) return layout
  const { [edit.name]: _previous, ...rest } = item.params
  const params = edit.value === undefined || !Number.isFinite(edit.value) ? rest : { ...rest, [edit.name]: edit.value }
  return withList(layout, edit.at.target, items.map((candidate, index) => index === edit.at.index ? { ...candidate, params } : candidate))
}

export function applySlotEdit(
  layout: SlotLayout,
  edit: SlotEdit,
  kinds: ReadonlyMap<string, GenerationInputKind>,
): SlotLayout {
  if (edit.kind === 'move') return moved(layout, edit)
  if (edit.kind === 'params') return withParam(layout, edit)
  if (edit.kind === 'remove') {
    const items = listAt(layout, edit.from.target)
    return items ? withList(layout, edit.from.target, items.filter((_, index) => index !== edit.from.index)) : layout
  }
  const kind = kinds.get(edit.sourceCellId)
  const items = listAt(layout, edit.to.target)
  if (!kind || !items || edit.to.target === null) return layout
  return withList(layout, edit.to.target, inserted(items, edit.to.index, { sourceCellId: edit.sourceCellId, kind, port: null, params: {} }))
}

function slotCounts(layout: SlotLayout): InputCounts {
  return Object.fromEntries(layout.slots
    .filter((column) => column.spec.sent && !isGenerationFieldPort(column.spec.target) && column.items.length > 0)
    .map((column) => [column.spec.target, column.items.length]))
}

export function slotLayoutLimitMessages(layout: SlotLayout, context: Pick<SlotLayoutContext, 'mode' | 'settings'>): string[] {
  return inputLimitViolations(context.mode.limits, slotCounts(layout), context.settings)
}

export function slotCapacity(
  spec: NotebookGenerationInputSpec,
  limits: readonly InputLimit[],
  settings: Readonly<Record<string, unknown>>,
): number | null {
  const caps = limits.flatMap((limit) => {
    if (limit.kind !== 'max' || limit.roles.length !== 1 || limit.roles[0]!.role !== spec.target) return []
    const cap = inputLimitCap(limit, settings)
    return cap === null ? [] : [Math.floor(cap / (limit.roles[0]!.weight ?? 1))]
  })
  return [spec.max, ...caps].reduce<number | null>((least, cap) =>
    cap === null ? least : least === null ? cap : Math.min(least, cap), null)
}

function kindLabel(kind: GenerationInputKind): string {
  return kind === 'audio' ? 'audio' : `${kind}s`
}

function introducedLimit(layout: SlotLayout, next: SlotLayout, context: SlotLayoutContext): string | null {
  const before = new Set(slotLayoutLimitMessages(layout, context))
  const after = new Set(slotLayoutLimitMessages(next, context))
  return context.mode.limits.find((limit) =>
    limit.kind === 'max' && after.has(limit.message) && !before.has(limit.message))?.message ?? null
}

export function slotDropError(
  layout: SlotLayout,
  edit: Extract<SlotEdit, { kind: 'move' | 'add' }>,
  context: SlotLayoutContext,
): string | null {
  const target = layout.slots.find((column) => column.spec.target === edit.to.target)
  if (!target) return 'Drop onto a slot'
  const kind = edit.kind === 'add' ? context.kinds.get(edit.sourceCellId) : listAt(layout, edit.from.target)?.[edit.from.index]?.kind
  if (!kind) return 'Only media cells can be inputs'
  if (kind !== target.spec.kind) return `${target.spec.label}: ${kindLabel(target.spec.kind)} only`
  const sameSlot = edit.kind === 'move' && !edit.copy && edit.from.target === edit.to.target
  if (!sameSlot && target.spec.max !== null && target.items.length >= target.spec.max) {
    return `${target.spec.label}: full at ${target.spec.max}`
  }
  return introducedLimit(layout, applySlotEdit(layout, edit, context.kinds), context)
}

export function slotItemTokens(
  cellId: string,
  cells: readonly GenerationInputMentionCell[],
  connections: readonly SlotConnection[],
  modeId: string | undefined,
): ReadonlyMap<string, string> {
  const edges = connections.map((connection) => ({ source: connection.sourceCellId, target: cellId, targetInput: connection.targetInput }))
  return new Map(generationInputMentions(cellId, cells, edges, modeId)
    .map((mention) => [connectionKey(mention.sourceCellId, mention.targetInput), mention.token]))
}

export function slotItemPlaceholder(
  spec: ItemParamSpec,
  column: SlotColumn,
  index: number,
  settings: Readonly<Record<string, unknown>>,
): number | undefined {
  return itemParamDefault(spec, settingNumber(settings, 'duration') ?? 0, column.items.length, index)
}

export function remapSlotPrompt(
  prompt: string,
  cellId: string,
  cells: readonly GenerationInputMentionCell[],
  previous: readonly SlotConnection[],
  change: SlotLayoutChange,
): string {
  const edges = (connections: readonly SlotConnection[]) => connections.map((connection) => ({
    source: connection.sourceCellId,
    target: cellId,
    targetInput: connection.targetInput,
  }))
  return remapGenerationInputLayoutPrompt(prompt, cellId, cells, edges(previous), edges(change.connections), change.identity)
}

export function slotEffectiveConnections(
  connections: readonly SlotConnection[],
  context: SlotLayoutContext,
): SlotConnection[] {
  const layout = slotLayout(connections, context)
  const params = new Map([...layout.slots.flatMap((column) => column.items), ...layout.unplaced]
    .flatMap((item) => item.port ? [[connectionKey(item.sourceCellId, item.port), item.params] as const] : []))
  return connections.map(({ sourceCellId, targetInput, params: own }) => {
    const effective = params.get(connectionKey(sourceCellId, targetInput)) ?? own ?? {}
    return Object.keys(effective).length > 0 ? { sourceCellId, targetInput, params: effective } : { sourceCellId, targetInput }
  })
}

export function slotInputParams(connections: readonly SlotConnection[]): Record<string, Record<string, number>> {
  return Object.fromEntries(connections.flatMap((connection) =>
    connection.params && Object.keys(connection.params).length > 0 ? [[connection.targetInput, { ...connection.params }]] : []))
}

export type SlotInputArgument = {
  source_cell_id: string
  target_input: string
  params: SlotParams
}

export function slotInputsArgument(connections: readonly SlotConnection[]): SlotInputArgument[] {
  return connections.map((connection) => ({
    source_cell_id: connection.sourceCellId,
    target_input: connection.targetInput,
    params: connection.params ?? {},
  }))
}

export function slotLegacySettingNames(mode: Pick<NotebookGenerationInputMode, 'inputs'>): ReadonlySet<string> {
  return new Set(mode.inputs.flatMap((spec) => spec.itemParams.flatMap((param) => param.legacyOptions ?? [])))
}

export function slotSourceKinds(cells: ReadonlyArray<Pick<NotebookCell, 'id' | 'type'>>): ReadonlyMap<string, GenerationInputKind> {
  return new Map(cells.flatMap((cell) => {
    const kind = notebookGenerationInputKind(cell)
    return kind ? [[cell.id, kind] as const] : []
  }))
}

function connectionsKey(connections: readonly SlotConnection[]): string {
  return JSON.stringify(connections
    .map((connection) => [connection.sourceCellId, connection.targetInput, Object.entries(connection.params ?? {}).sort()])
    .sort())
}

export function slotConnectionsEqual(left: readonly SlotConnection[], right: readonly SlotConnection[]): boolean {
  return connectionsKey(left) === connectionsKey(right)
}
