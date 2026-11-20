import type { ModelFrontierRanking } from '../../server/src/media/frontier'
import { generationInputTarget } from '../../server/src/generation-input-targets'
import {
  actionForFamily,
  generationFamilyGroups,
  generationProviderOptions,
  type FamilyPickerAction,
} from './generation-provider-picker'
import type { ActionChoice } from './workspace-actions'

const frontierTypes = ['t2i', 'i2i', 't2v', 'i2v', 'r2v', 'v2v'] as const

export type FrontierType = typeof frontierTypes[number]

const frameTargets = new Set(['first_frame', 'last_frame', 'loop', 'keyframe'])

function isFrameTarget(targetInput: string | undefined): boolean {
  return targetInput !== undefined && frameTargets.has(generationInputTarget('image', targetInput))
}

export function parseFrontierRankings(value: unknown): ModelFrontierRanking[] {
  if (!Array.isArray(value)) return []
  return value.filter((row): row is ModelFrontierRanking => {
    if (!row || typeof row !== 'object') return false
    const ranking = row as Record<string, unknown>
    return frontierTypes.some(type => type === ranking.type)
      && typeof ranking.rank === 'number' && Number.isFinite(ranking.rank) && ranking.rank > 0
      && typeof ranking.elo === 'number' && Number.isFinite(ranking.elo)
      && typeof ranking.priceLabel === 'string'
      && typeof ranking.sourceUrl === 'string'
      && typeof ranking.capturedOn === 'string'
  })
}

export function generationFrontierType(
  media: string,
  mode: string,
  operation: string,
  inputs: readonly { type: string; targetInput?: string }[],
): FrontierType | null {
  const direct = frontierTypes.find(type => type === mode)
  if (direct) return direct
  if (mode === 'v2v_refs') return 'v2v'
  if (media === 'generate_image') {
    if (operation === 'layer_image') return null
    const hasImage = inputs.some(input => input.type === 'image' || input.type === 'generate_image')
    return hasImage || operation === 'edit_image' || operation === 'image_to_image' ? 'i2i' : 't2i'
  }
  if (media !== 'generate_video') return null
  const byOperation: Record<string, FrontierType> = {
    text_to_video: 't2v', image_to_video: 'i2v', reference_to_video: 'r2v', edit_video: 'v2v',
  }
  if (!byOperation[operation]) return null
  if (operation !== 'text_to_video') return byOperation[operation]
  if (inputs.some(input => isFrameTarget(input.targetInput))) return 'i2v'
  if (inputs.some(input => input.type === 'video' || input.type === 'generate_video')) return 'v2v'
  if (inputs.some(input => input.type === 'image' || input.type === 'generate_image')) {
    return 'r2v'
  }
  return byOperation[operation]
}

export function frontierPickerGroups<T extends { available?: boolean; frontier?: readonly ModelFrontierRanking[] }>(actions: readonly T[], type: FrontierType | null) {
  const rows = actions.map(action => ({
    action,
    ranking: type ? action.frontier?.find(ranking => ranking.type === type) : undefined,
  }))
  const ranked = rows.filter(row => row.ranking && row.action.available !== false)
    .sort((left, right) => left.ranking!.rank - right.ranking!.rank)
  const remaining = rows.filter(row => !row.ranking && row.action.available !== false)
  const unavailable = rows.filter(row => row.action.available === false)
  return [
    { label: 'Frontier models', rows: ranked },
    { label: ranked.length ? 'Other models' : 'Models', rows: remaining },
    { label: 'Unavailable · provider not configured', rows: unavailable },
  ].filter(group => group.rows.length > 0)
}

const operationFrontierTypes: Readonly<Record<string, FrontierType>> = {
  text_to_image: 't2i',
  edit_image: 'i2i',
  image_to_image: 'i2i',
  text_to_video: 't2v',
  image_to_video: 'i2v',
  reference_to_video: 'r2v',
  edit_video: 'v2v',
}

function choiceFrontierType(media: string, values: Record<string, unknown>): FrontierType | null {
  const refs = values.refs && typeof values.refs === 'object' ? values.refs : {}
  const inputs = Object.entries(refs).filter(([, value]) => Boolean(value) && (!Array.isArray(value) || value.length > 0))
    .map(([role]) => ({ type: isFrameTarget(role) ? 'image' : role, targetInput: role }))
  const operation = typeof values.operation === 'string' ? values.operation : media === 'image' ? 'text_to_image' : 'text_to_video'
  return generationFrontierType(`generate_${media}`, typeof values.mode === 'string' ? values.mode : '', operation, inputs)
}

function pickerActions(choices: readonly ActionChoice[]): FamilyPickerAction[] {
  return choices.flatMap((choice) => {
    const provider = choice.provider
    const family = choice.family
    const operations = choice.operations ?? []
    if (!provider || !family || operations.length === 0) return []
    return operations.map((operation) => ({
      id: choice.value,
      provider,
      providerLabel: choice.providerLabel || provider,
      operation,
      family,
      ...(choice.variant ? { variant: choice.variant } : {}),
      ...(choice.available !== undefined ? { available: choice.available } : {}),
      ...(choice.frontier ? { frontier: choice.frontier } : {}),
      ...(choice.modes && choice.modes.length > 0 ? { inputContract: { modes: choice.modes } } : {}),
    }))
  })
}

function endpointFits(action: FamilyPickerAction, type: FrontierType | null): boolean {
  if (type === null) return true
  return operationFrontierTypes[action.operation] === type
    || Boolean(action.inputContract?.modes.some(mode => mode.id === type))
}

function rankedModelChoices(choices: readonly ActionChoice[], type: FrontierType | null): ActionChoice[] {
  return frontierPickerGroups(choices, type).flatMap(group => group.rows.map(({ action, ranking }) => ({
    ...action,
    group: group.label,
    label: `${ranking ? `#${ranking.rank} · ` : ''}${action.label}`,
    detail: [action.detail, ranking ? `Elo ${ranking.elo} · ${ranking.priceLabel}` : '', action.available === false ? 'unavailable' : ''].filter(Boolean).join(' · '),
  })))
}

export function generationModelsSplit(choices: readonly ActionChoice[]): boolean {
  return pickerActions(choices).length > 0
}

export function generationModelChoices(
  choices: readonly ActionChoice[],
  media: string,
  values: Record<string, unknown>,
): ActionChoice[] {
  const type = choiceFrontierType(media, values)
  const actions = pickerActions(choices)
  if (actions.length === 0) return rankedModelChoices(choices, type)
  return generationFamilyGroups(actions, type).flatMap(group => group.rows.map(row => ({
    value: row.family.id,
    label: row.ranking ? `#${row.ranking.rank} · ${row.family.title} · Elo ${row.ranking.elo}` : row.family.title,
    group: group.label,
    available: row.available,
  })))
}

export function generationProviderChoices(
  choices: readonly ActionChoice[],
  familyId: string,
  media: string,
  values: Record<string, unknown>,
): ActionChoice[] {
  const type = choiceFrontierType(media, values)
  const currentId = typeof values.model === 'string' ? values.model : ''
  return generationProviderOptions(pickerActions(choices), familyId, {
    frontierType: type,
    compatible: (action) => endpointFits(action, type),
    ...(currentId ? { selectedId: currentId } : {}),
    alternatives: true,
  }).map(option => ({
    value: option.action.id,
    label: [option.label, option.priceLabel ?? '', option.available ? '' : 'not configured', option.compatible ? '' : 'incompatible'].filter(Boolean).join(' · '),
    available: option.available,
    provider: option.action.provider,
  }))
}

export function generationModelIdForChange(
  choices: readonly ActionChoice[],
  media: string,
  values: Record<string, unknown>,
  change: { familyId?: string; modelId?: string },
): string | undefined {
  if ('modelId' in change) return change.modelId || undefined
  const familyId = change.familyId ?? ''
  if (!familyId) return undefined
  const type = choiceFrontierType(media, values)
  const actions = pickerActions(choices)
  const currentId = typeof values.model === 'string' ? values.model : ''
  const current = actions.find(action => action.id === currentId)
  return actionForFamily(actions, familyId, {
    frontierType: type,
    compatible: (action) => endpointFits(action, type),
    ...(current ? { currentProvider: current.provider } : {}),
  })?.id ?? undefined
}
