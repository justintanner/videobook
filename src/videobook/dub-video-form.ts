import { DUB_VIDEO_MAX_LANGUAGES, DUB_VIDEO_RATES_USD_PER_SECOND, type DubQuality } from '../../server/src/dub-video-contract'
import { dubLanguageEntries, normalizeSearch } from '../../server/src/dub-video-languages'
import type { WorkspaceAction } from '../../server/src/workspace-action-contract'
import { effectiveWorkspaceActionValues, workspaceActionChoices, type WorkspaceActionDraft, type WorkspaceActionReview } from './workspace-action-draft'
import type { ActionChoice, WorkspaceActionContext } from './workspace-actions'

export type DubFormDraft = {
  languages: string[]
  unknown: string[]
  quality: DubQuality
  lipSync: boolean
  speakers: number | null
  dynamicDuration: boolean
}

export type DubPrice =
  | { state: 'empty' }
  | { state: 'estimating' }
  | { state: 'quoted'; usd: number }
  | { state: 'unavailable' }

const ADDRESS = /^@[a-z]+\d+/u

export function isDubVideoAction(action: WorkspaceAction | null | undefined): boolean {
  return action?.handler.kind === 'tool' && action.handler.tool === 'dub_video'
}

function uniqueLanguages(entries: readonly { language: string | null }[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.language ? [entry.language] : []))]
}

export function dubFormDraft(values: Readonly<Record<string, unknown>>, catalog: readonly string[]): DubFormDraft {
  const raw = Array.isArray(values.language) ? values.language : [values.language]
  const texts = raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
  const entries = catalog.length ? dubLanguageEntries(texts, catalog) : texts.map((text) => ({ text, language: text }))
  return {
    languages: uniqueLanguages(entries),
    unknown: entries.flatMap((entry) => entry.language ? [] : [entry.text]),
    quality: values.quality === 'precision' ? 'precision' : 'speed',
    lipSync: values.lip_sync !== false,
    speakers: typeof values.speakers === 'number' ? values.speakers : null,
    dynamicDuration: values.dynamic_duration === true,
  }
}

export function toggleDubLanguage(languages: readonly string[], language: string): string[] {
  if (languages.includes(language)) return languages.filter((entry) => entry !== language)
  return languages.length >= DUB_VIDEO_MAX_LANGUAGES ? [...languages] : [...languages, language]
}

export function filterDubLanguages(catalog: readonly string[], query: string): string[] {
  const folded = normalizeSearch(query)
  return folded ? catalog.filter((language) => normalizeSearch(language).includes(folded)) : [...catalog]
}

export function dubMoney(usd: number): string {
  return `$${usd.toFixed(2)}`
}

export function dubClock(seconds: number): string {
  const whole = Math.ceil(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export function dubRate(quality: DubQuality): string {
  return `${dubMoney(DUB_VIDEO_RATES_USD_PER_SECOND[quality])}/s`
}

export function dubRunLabel(count: number): string {
  if (count === 0) return 'Dub video'
  return `Dub into ${count} language${count === 1 ? '' : 's'}`
}

function dubSourceAddress(choices: readonly ActionChoice[], assetId: unknown): string | null {
  const choice = choices.find((entry) => entry.value === assetId)
  return choice ? ADDRESS.exec(choice.label)?.[0] ?? null : null
}

export function dubSlashCommand(address: string | null, draft: DubFormDraft): string {
  return [
    '/dub',
    address ?? '@video',
    draft.languages.length ? draft.languages.join(', ') : '<languages>',
    draft.quality === 'precision' ? 'precision' : '',
    draft.lipSync ? '' : 'voice-only',
  ].filter(Boolean).join(' ')
}

export function dubValidation(draft: DubFormDraft): string | null {
  if (draft.unknown.length) return `Unknown language: ${draft.unknown.join(', ')}. Remove it and pick from the list.`
  if (!draft.languages.length) return 'Pick at least one language.'
  if (draft.languages.length > DUB_VIDEO_MAX_LANGUAGES) return `Pick at most ${DUB_VIDEO_MAX_LANGUAGES} languages.`
  return null
}

export function dubPrice(draft: DubFormDraft, reviewing: boolean, usd: number | null | undefined): DubPrice {
  if (!draft.languages.length) return { state: 'empty' }
  if (reviewing) return { state: 'estimating' }
  return typeof usd === 'number' && usd > 0 ? { state: 'quoted', usd } : { state: 'unavailable' }
}

export type DubSheetState = {
  draft: DubFormDraft
  assetId: string
  address: string | null
  catalog: string[]
  sources: readonly ActionChoice[]
  media: { url: string | null; duration?: number | null } | null
  price: DubPrice
  priceNote: string | null
}

const PRICE_CAVEAT = /this estimate is a lower bound|^no cost adapter registered for tool\b/u

export function dubSheetState(
  action: WorkspaceAction,
  context: WorkspaceActionContext,
  entryDraft: WorkspaceActionDraft,
  review: WorkspaceActionReview | null,
  reviewing: boolean,
): DubSheetState {
  const values = effectiveWorkspaceActionValues(action, entryDraft)
  const catalog = (context.choices.language ?? []).map((choice) => choice.value)
  const draft = dubFormDraft(values, catalog)
  const assetId = typeof values.asset_id === 'string' ? values.asset_id : ''
  const sources = workspaceActionChoices(action, context, values)[action.target.argument ?? 'asset_id'] ?? []
  return {
    draft,
    assetId,
    address: dubSourceAddress(sources, assetId),
    catalog,
    sources,
    media: context.media?.[assetId] ?? null,
    price: dubPrice(draft, reviewing, review?.usd),
    priceNote: review?.warnings?.find((warning) => !PRICE_CAVEAT.test(warning)) ?? null,
  }
}

export function dubSheetEffect(state: DubSheetState): { label: string; tone: 'default' | 'warning' } {
  const count = state.draft.languages.length
  if (state.price.state === 'quoted') {
    return { label: `At least ${dubMoney(state.price.usd)} · ${count} new video${count === 1 ? '' : 's'}`, tone: 'warning' }
  }
  if (state.price.state === 'estimating') return { label: 'Estimating price…', tone: 'default' }
  return { label: 'May incur provider charges', tone: 'warning' }
}
