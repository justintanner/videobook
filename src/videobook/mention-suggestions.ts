import { notebookCellOccupiedSlots } from 'videobook-engine/notebook-grid'
import { formatMediaTime } from './notebook-cell-presentation'
import {
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_ROW_COUNT,
  notebookGridAddress,
  notebookGridTag,
} from 'videobook-engine/notebook-grid'
import {
  notebookMentionPrefixAtEnd,
  normalizeNotebookReference,
  replaceNotebookMentions,
} from 'videobook-engine/notebook-mentions'
import type { NotebookGridSlot } from 'videobook-engine'

export interface AssetMentionRecord {
  id: string
  artifactId: string
  type: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  width: number | null
  height: number | null
  duration: number | null
  status: string
}

export interface AssetMentionCandidate
  extends Omit<AssetMentionRecord, 'id'> {
  cellAddress: string
}

interface NotebookMentionCell {
  id?: string
  slot: NotebookGridSlot
  type: string
  outputArtifactId?: string
}

interface AssetMentionSuggestion {
  value: string
  label: string
  asset: AssetMentionCandidate
  type: 'asset'
}

interface NotebookAddressSuggestion {
  value: string
  label: string
  description: string
  cellType: string | null
  empty: boolean
  type: 'cell'
}

interface NotebookAddressCell {
  slot: NotebookGridSlot
  type: string
  label?: string
}

/** One line of the @mention menu: a poster frame, the slug, and what is known. */
export interface MentionMenuRow {
  value: string
  label: string
  description: string
  caption: string | null
  thumbnailUrl: string | null
  mediaKind: MentionMediaKind | null
  empty: boolean
}

export interface MentionMenuLimits {
  rows?: number
  empties?: number
}

function positiveFinite(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0
}

export function notebookMentionAssets(
  cells: readonly NotebookMentionCell[],
  assets: readonly AssetMentionRecord[],
): AssetMentionCandidate[] {
  const assetsByArtifactId = new Map(
    assets.map((asset) => [asset.artifactId, asset]),
  )
  const cellsByArtifactId = new Map<string, NotebookMentionCell>()
  for (const cell of cells) {
    const artifactId = cell.outputArtifactId
    if (!artifactId) continue
    const asset = assetsByArtifactId.get(artifactId)
    if (!asset) continue
    const current = cellsByArtifactId.get(artifactId)
    if (!current || (
      current.type !== asset.type
      && cell.type === asset.type
    )) {
      cellsByArtifactId.set(artifactId, cell)
    }
  }
  return [...cellsByArtifactId.entries()].map(([artifactId, cell]) => {
    const asset = assetsByArtifactId.get(artifactId)!
    const { id: _id, ...assetFields } = asset
    return {
      ...assetFields,
      cellAddress: notebookGridAddress(cell.slot),
    }
  })
}

export function resolveNotebookMentionAliases(
  input: string,
  assets: readonly AssetMentionCandidate[],
): string {
  return replaceNotebookMentions(input, assets.map((asset) => ({
    reference: asset.cellAddress,
    replacement: `@${asset.artifactId}`,
  })))
}

function escapeMentionToken(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceMentionTokens(
  input: string,
  replacements: ReadonlyArray<{ token: string; replacement: string }>,
): string {
  let output = input
  for (const { token, replacement } of replacements) {
    const bare = normalizeNotebookReference(token)
    if (!bare) continue
    output = output.replace(
      new RegExp(`(?<![\\w./-])@?${escapeMentionToken(bare)}(?![\\w-])`, 'giu'),
      replacement,
    )
  }
  return output
}

export function restoreNotebookMentionAliases(
  input: string,
  assets: readonly AssetMentionCandidate[],
): string {
  return replaceMentionTokens(input, assets.map((asset) => ({
    token: asset.artifactId,
    replacement: `@${asset.cellAddress}`,
  })))
}

export function restoreSelectedNotebookMentionAliases(
  input: string,
  assets: readonly AssetMentionCandidate[],
  cells: readonly NotebookMentionCell[],
): string {
  const cellsByArtifactId = new Map(
    cells.flatMap((cell) => cell.outputArtifactId
      ? [[cell.outputArtifactId, cell] as const]
      : []),
  )
  return replaceMentionTokens(input, assets.flatMap((asset) => {
    const cell = cellsByArtifactId.get(asset.artifactId)
    if (!cell) return []
    return [{
      token: asset.artifactId,
      replacement: `@${notebookGridAddress(cell.slot)}`,
    }]
  }))
}

export function applyNotebookMentionSuggestion(
  input: string,
  suggestion: string,
): string {
  const prefix = notebookMentionPrefixAtEnd(input)
  if (prefix === undefined) return input
  const start = input.length - prefix.length - 1
  return `${input.slice(0, start)}@${normalizeNotebookReference(suggestion)}`
}

export function assetMentionMetadata(
  asset: AssetMentionCandidate,
): string[] {
  const metadata = [asset.type.toUpperCase()]
  if (positiveFinite(asset.width) && positiveFinite(asset.height)) {
    metadata.push(`${asset.width}×${asset.height}`)
  }
  if (positiveFinite(asset.duration)) {
    metadata.push(formatMediaTime(asset.duration))
  }
  const status = asset.status.trim().toLowerCase()
  if (status && status !== 'ready') {
    metadata.push(status.replaceAll('_', ' ').toUpperCase())
  }
  return metadata
}

export type MentionMediaKind = 'audio' | 'image' | 'video' | 'other'

/** The poster frame for a mention row: a real thumbnail, or the image itself. */
export function mentionThumbnailUrl(
  asset: Pick<AssetMentionRecord, 'type' | 'thumbnailUrl' | 'mediaUrl'>,
): string | null {
  return asset.thumbnailUrl ?? (asset.type === 'image' ? asset.mediaUrl : null)
}

/** Collapses an asset type or a cell type onto the glyph shown without a poster. */
export function mentionMediaKind(kind: string): MentionMediaKind {
  const normalized = kind.toLowerCase()
  if (normalized.includes('audio')) return 'audio'
  if (normalized.includes('image')) return 'image'
  if (
    normalized.includes('video')
    || normalized === 'final'
    || normalized === 'concat'
    || normalized === 'splice'
  ) return 'video'
  return 'other'
}

export function assetMentionSuggestions(
  assets: readonly AssetMentionCandidate[],
  input: string,
  excludeValues: ReadonlySet<string> = new Set(),
): AssetMentionSuggestion[] {
  const filter = notebookMentionPrefixAtEnd(input)
  if (filter === undefined) return []
  const context = input.slice(0, input.lastIndexOf('@')).trim()
  const requiredType = /\b(?:generate|create|make)\s+(?:an?\s+)?(?:image|photo|picture)s?(?:\s+(?:of|from|using|with))?$/iu.test(context)
    ? 'image'
    : null
  return assets
    .filter((asset) => (
      (!requiredType || asset.type.toLowerCase() === requiredType)
      && asset.cellAddress.toLowerCase().includes(filter)
      && !excludeValues.has(`@${asset.cellAddress}`)
    ))
    .slice(0, 12)
    .map((asset) => ({
      value: `@${asset.cellAddress}`,
      label: `@${asset.cellAddress}`,
      asset,
      type: 'asset',
    }))
}

export function notebookAddressSuggestions(
  cells: readonly NotebookAddressCell[],
  input: string,
  excludeValues: ReadonlySet<string> = new Set(),
): NotebookAddressSuggestion[] {
  const filter = notebookMentionPrefixAtEnd(input)
  if (filter === undefined) return []
  const occupied = new Map(
    cells.flatMap((cell) => notebookCellOccupiedSlots(cell).map((slot) => [`${slot.row}:${slot.column}`, cell] as const)),
  )
  const suggestions: NotebookAddressSuggestion[] = []
  for (let row = 0; row < NOTEBOOK_GRID_ROW_COUNT; row += 1) {
    for (let column = 0; column < NOTEBOOK_GRID_COLUMN_COUNT; column += 1) {
      const tag = notebookGridTag({ row, column })
      if (!tag.slice(1).includes(filter) || excludeValues.has(tag)) continue
      const cell = occupied.get(`${row}:${column}`)
      if (cell?.type === 'timeline' && column !== cell.slot.column) continue
      suggestions.push({
        value: tag,
        label: tag,
        description: cell
          ? `${cell.type.replaceAll('_', ' ').toUpperCase()} cell`
          : 'Empty grid square',
        cellType: cell?.type ?? null,
        empty: !cell,
        type: 'cell',
      })
      if (suggestions.length === 12) return suggestions
    }
  }
  return suggestions
}

const MENTION_MENU_ROW_LIMIT = 8
const MENTION_MENU_EMPTY_LIMIT = 16

/**
 * The @mention menu in grid-address order, squares holding media first.
 *
 * Empty squares are interchangeable — one line each would repeat the same
 * sentence down the whole menu — so they trail the rows that carry media and
 * the caller renders them as one strip of chips.
 */
export function mentionMenuRows(
  assets: readonly AssetMentionCandidate[],
  cells: readonly NotebookAddressCell[],
  input: string,
  excludeValues: ReadonlySet<string> = new Set(),
  limits: MentionMenuLimits = {},
): MentionMenuRow[] {
  const captions = new Map(cells.map((cell) =>
    [notebookGridTag(cell.slot), cell.label?.trim() || null]))
  const seen = new Set<string>()
  const matches: MentionMenuRow[] = []
  for (const suggestion of assetMentionSuggestions(assets, input, excludeValues)) {
    if (seen.has(suggestion.value)) continue
    seen.add(suggestion.value)
    matches.push({
      value: suggestion.value,
      label: suggestion.label,
      description: assetMentionMetadata(suggestion.asset).join(' · '),
      caption: captions.get(suggestion.value) ?? null,
      thumbnailUrl: mentionThumbnailUrl(suggestion.asset),
      mediaKind: mentionMediaKind(suggestion.asset.type),
      empty: false,
    })
  }
  for (const suggestion of notebookAddressSuggestions(cells, input, excludeValues)) {
    if (seen.has(suggestion.value)) continue
    seen.add(suggestion.value)
    matches.push({
      value: suggestion.value,
      label: suggestion.label,
      description: suggestion.description,
      caption: captions.get(suggestion.value) ?? null,
      thumbnailUrl: null,
      mediaKind: suggestion.cellType ? mentionMediaKind(suggestion.cellType) : null,
      empty: suggestion.empty,
    })
  }
  return [
    ...matches.filter((row) => !row.empty)
      .slice(0, limits.rows ?? MENTION_MENU_ROW_LIMIT),
    ...matches.filter((row) => row.empty)
      .slice(0, limits.empties ?? MENTION_MENU_EMPTY_LIMIT),
  ]
}
