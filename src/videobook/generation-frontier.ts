import type { ModelFrontierRanking } from '../../server/src/media/frontier'
import type { ActionChoice } from './workspace-actions'

const frontierTypes = ['t2i', 'i2i', 't2v', 'i2v', 'r2v', 'v2v'] as const

type FrontierType = typeof frontierTypes[number]

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
  if (inputs.some(input => input.targetInput === 'first_frame' || input.targetInput === 'last_frame')) return 'i2v'
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

export function generationModelChoices(
  choices: readonly ActionChoice[],
  media: string,
  values: Record<string, unknown>,
): ActionChoice[] {
  const refs = values.refs && typeof values.refs === 'object' ? values.refs : {}
  const inputs = Object.entries(refs).filter(([, value]) => Boolean(value) && (!Array.isArray(value) || value.length > 0))
    .map(([role]) => ({ type: role === 'first_frame' || role === 'last_frame' ? 'image' : role, targetInput: role }))
  const operation = typeof values.operation === 'string' ? values.operation : media === 'image' ? 'text_to_image' : 'text_to_video'
  const type = generationFrontierType(`generate_${media}`, typeof values.mode === 'string' ? values.mode : '', operation, inputs)
  return frontierPickerGroups(choices, type).flatMap(group => group.rows.map(({ action, ranking }) => ({
    ...action,
    group: group.label,
    label: `${ranking ? `#${ranking.rank} · ` : ''}${action.label}`,
    detail: [action.detail, ranking ? `Elo ${ranking.elo} · ${ranking.priceLabel}` : '', action.available === false ? 'unavailable' : ''].filter(Boolean).join(' · '),
  })))
}
