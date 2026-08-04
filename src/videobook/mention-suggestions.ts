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
  cellSlug: string
  assetSlug: string
}

interface NotebookMentionCell {
  id?: string
  slug: string
  slot?: NotebookGridSlot
  type: string
  outputArtifactId?: string
}

export interface NotebookCellRenamePlan {
  cellId: string
  previousSlug: string
  nextSlug: string
  conflict: boolean
}

export interface AssetMentionSuggestion {
  value: string
  label: string
  asset: AssetMentionCandidate
  type: 'asset'
}

export interface NotebookAddressSuggestion {
  value: string
  label: string
  description: string
  type: 'cell'
}

export interface NotebookAddressCell {
  slot: NotebookGridSlot
  type: string
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
    const { id: assetSlug, ...assetFields } = asset
    return {
      ...assetFields,
      cellAddress: cell.slot
        ? notebookGridAddress(cell.slot)
        : cell.slug,
      cellSlug: cell.slug,
      assetSlug,
    }
  })
}

export function resolveNotebookMentionAliases(
  input: string,
  assets: readonly AssetMentionCandidate[],
): string {
  return replaceNotebookMentions(input, assets.flatMap((asset) => [
    { reference: asset.cellAddress, replacement: `@${asset.assetSlug}` },
    { reference: asset.cellSlug, replacement: `@${asset.assetSlug}` },
  ]))
}

export function restoreNotebookMentionAliases(
  input: string,
  assets: readonly AssetMentionCandidate[],
): string {
  return replaceNotebookMentions(input, assets.map((asset) => ({
    reference: asset.assetSlug,
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
  return replaceNotebookMentions(input, assets.flatMap((asset) => {
    const cell = cellsByArtifactId.get(asset.artifactId)
    if (!cell) return []
    return [{
      reference: asset.assetSlug,
      replacement: `@${cell.slot ? notebookGridAddress(cell.slot) : cell.slug}`,
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

export function notebookCellRenamePlan(
  assetId: unknown,
  result: unknown,
  cells: readonly NotebookMentionCell[],
  assets: readonly AssetMentionCandidate[],
): NotebookCellRenamePlan | null {
  if (typeof assetId !== 'string' || !assetId.trim()) return null
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const value = result as Record<string, unknown>
  const oldAssetId = value.old_asset_id
  const newAssetId = value.new_asset_id
  if (typeof oldAssetId !== 'string' || typeof newAssetId !== 'string') return null
  const requested = normalizeNotebookReference(assetId)
  const candidate = assets.find((asset) =>
    (asset.cellAddress.toLowerCase() === requested
      || asset.cellSlug.toLowerCase() === requested)
    && asset.assetSlug === oldAssetId)
  if (!candidate) return null
  const cell = cells.find((item) =>
    item.id
    && item.slug.toLowerCase() === candidate.cellSlug.toLowerCase()
    && item.outputArtifactId === candidate.artifactId)
  if (!cell?.id) return null
  return {
    cellId: cell.id,
    previousSlug: cell.slug,
    nextSlug: newAssetId,
    conflict: cells.some((item) =>
      item.id !== cell.id
      && item.slug.toLowerCase() === newAssetId.toLowerCase()),
  }
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

export function assetMentionSuggestions(
  assets: readonly AssetMentionCandidate[],
  input: string,
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
): NotebookAddressSuggestion[] {
  const filter = notebookMentionPrefixAtEnd(input)
  if (filter === undefined) return []
  const occupied = new Map(
    cells.map((cell) => [`${cell.slot.row}:${cell.slot.column}`, cell]),
  )
  const suggestions: NotebookAddressSuggestion[] = []
  for (let row = 0; row < NOTEBOOK_GRID_ROW_COUNT; row += 1) {
    for (let column = 0; column < NOTEBOOK_GRID_COLUMN_COUNT; column += 1) {
      const tag = notebookGridTag({ row, column })
      if (!tag.slice(1).includes(filter)) continue
      const cell = occupied.get(`${row}:${column}`)
      suggestions.push({
        value: tag,
        label: tag,
        description: cell
          ? `${cell.type.replaceAll('_', ' ').toUpperCase()} cell`
          : 'Empty grid square',
        type: 'cell',
      })
      if (suggestions.length === 12) return suggestions
    }
  }
  return suggestions
}
