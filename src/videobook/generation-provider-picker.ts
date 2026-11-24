import type { ModelFrontierRanking } from '../../server/src/media/frontier'
import { frontierPickerGroups, type FrontierType } from './generation-frontier'
import type { GenerationFamily } from './notebook-generation-actions'

export type FamilyPickerAction = {
  id: string
  provider: string
  providerLabel: string
  operation: string
  family: GenerationFamily
  variant?: string
  available?: boolean
  frontier?: readonly ModelFrontierRanking[]
  inputContract?: { modes: readonly { id: string }[] }
}

export type GenerationFamilyRow<T extends FamilyPickerAction> = {
  family: GenerationFamily
  actions: T[]
  ranking?: ModelFrontierRanking
  available: boolean
}

export type GenerationProviderOption<T extends FamilyPickerAction> = {
  action: T
  label: string
  ranking?: ModelFrontierRanking
  available: boolean
  compatible: boolean
}

export type GenerationTypeOption<T extends FamilyPickerAction> = {
  value: string
  action: T
  modeId: string
}

type ProviderPickerOptions<T extends FamilyPickerAction> = {
  frontierType: FrontierType | null
  compatible?: (action: T) => boolean
  selectedId?: string
}

const typeOrder: readonly string[] = ['t2i', 'i2i', 't2v', 'i2v', 'r2v', 'v2v']

const operationFrontierTypes: Readonly<Record<string, FrontierType>> = {
  text_to_image: 't2i',
  edit_image: 'i2i',
  image_to_image: 'i2i',
  text_to_video: 't2v',
  image_to_video: 'i2v',
  reference_to_video: 'r2v',
  edit_video: 'v2v',
}

function frontierRanking(action: FamilyPickerAction, type: FrontierType | null): ModelFrontierRanking | undefined {
  return type ? action.frontier?.find(ranking => ranking.type === type) : undefined
}

function bestRanking(actions: readonly FamilyPickerAction[], type: FrontierType | null): ModelFrontierRanking | undefined {
  return actions.flatMap(action => frontierRanking(action, type) ?? [])
    .sort((left, right) => left.rank - right.rank)[0]
}

function familyRows<T extends FamilyPickerAction>(actions: readonly T[], type: FrontierType | null): GenerationFamilyRow<T>[] {
  const members = new Map<string, T[]>()
  for (const action of actions) members.set(action.family.id, [...members.get(action.family.id) ?? [], action])
  return [...members.values()].map((endpoints) => {
    const available = endpoints.filter(action => action.available !== false)
    const ranking = bestRanking(available.length > 0 ? available : endpoints, type)
    return { family: endpoints[0]!.family, actions: endpoints, ...(ranking ? { ranking } : {}), available: available.length > 0 }
  })
}

export function generationFamilyGroups<T extends FamilyPickerAction>(actions: readonly T[], frontierType: FrontierType | null) {
  const rows = familyRows(actions, frontierType).map(row => ({
    row,
    available: row.available,
    frontier: row.ranking ? [row.ranking] : [],
  }))
  return frontierPickerGroups(rows, frontierType)
    .map(group => ({ label: group.label, rows: group.rows.map(({ action }) => action.row) }))
}

function servesType(action: FamilyPickerAction, type: FrontierType | null): boolean {
  return type !== null && (operationFrontierTypes[action.operation] === type
    || Boolean(action.inputContract?.modes.some(mode => mode.id === type)))
}

function endpointScore<T extends FamilyPickerAction>(action: T, options: ProviderPickerOptions<T>): number {
  return (frontierRanking(action, options.frontierType) ? 4 : 0)
    + (isCompatible(action, options) ? 2 : 0)
    + (servesType(action, options.frontierType) ? 1 : 0)
}

function requestEndpoint<T extends FamilyPickerAction>(endpoints: readonly T[], options: ProviderPickerOptions<T>): T {
  return endpoints.reduce((best, action) =>
    endpointScore(action, options) > endpointScore(best, options) ? action : best)
}

function isCompatible<T extends FamilyPickerAction>(action: T, options: ProviderPickerOptions<T>): boolean {
  return options.compatible?.(action) ?? true
}

function providerRow(action: FamilyPickerAction): string {
  return `${action.family.id}\u0000${action.provider}\u0000${action.variant ?? ''}`
}

function rowEndpoint<T extends FamilyPickerAction>(candidates: readonly T[], options: ProviderPickerOptions<T>): T {
  const selected = candidates.filter(action => action.id === options.selectedId)
  return selected.find(action => isCompatible(action, options)) ?? selected[0] ?? requestEndpoint(candidates, options)
}

function providerOption<T extends FamilyPickerAction>(action: T, options: ProviderPickerOptions<T>): GenerationProviderOption<T> {
  const ranking = frontierRanking(action, options.frontierType)
  return {
    action,
    label: [action.providerLabel, action.variant].filter(Boolean).join(' · '),
    ...(ranking ? { ranking } : {}),
    available: action.available !== false,
    compatible: isCompatible(action, options),
  }
}

export function generationProviderOptions<T extends FamilyPickerAction>(
  actions: readonly T[],
  familyId: string,
  options: ProviderPickerOptions<T>,
): GenerationProviderOption<T>[] {
  const rows = new Map<string, T[]>()
  for (const action of actions) {
    if (action.family.id !== familyId) continue
    rows.set(providerRow(action), [...rows.get(providerRow(action)) ?? [], action])
  }
  return [...rows.values()].map(candidates => providerOption(rowEndpoint(candidates, options), options))
}

function generationTypeValue(action: FamilyPickerAction, modeId: string): string {
  if (modeId !== 'default') return modeId
  return operationFrontierTypes[action.operation] ?? action.operation.replaceAll('_', '-')
}

function typeRank(value: string): number {
  const rank = typeOrder.indexOf(value)
  return rank === -1 ? typeOrder.length : rank
}

export function generationTypeOptions<T extends FamilyPickerAction>(
  actions: readonly T[],
  current: T,
  modesOf: (action: T) => readonly { id: string }[],
): GenerationTypeOption<T>[] {
  const siblings = actions.filter(action => action.id !== current.id && providerRow(action) === providerRow(current))
  const options = [current, ...siblings].flatMap(action => modesOf(action)
    .map(mode => ({ value: generationTypeValue(action, mode.id), action, modeId: mode.id })))
  return options.filter((option, index) => options.findIndex(other => other.value === option.value) === index)
    .sort((left, right) => typeRank(left.value) - typeRank(right.value))
}

export function actionForFamily<T extends FamilyPickerAction>(
  actions: readonly T[],
  familyId: string,
  options: ProviderPickerOptions<T> & { currentProvider?: string; rememberedProvider?: string },
): T | null {
  const providers = generationProviderOptions(actions, familyId, options)
  const usable = providers.filter(option => option.available && option.compatible)
  const ranked = usable.filter(option => option.ranking)
    .sort((left, right) => left.ranking!.rank - right.ranking!.rank)
  return (usable.find(option => option.action.provider === options.rememberedProvider)
    ?? usable.find(option => option.action.provider === options.currentProvider)
    ?? ranked[0]
    ?? usable[0]
    ?? providers[0])?.action ?? null
}
