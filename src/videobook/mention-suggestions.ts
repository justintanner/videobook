import { formatMediaTime } from './notebook-cell-presentation'

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
  cellSlug: string
  assetSlug: string
}

interface NotebookMentionCell {
  id?: string
  slug: string
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
      cellSlug: cell.slug,
      assetSlug,
    }
  })
}

export function resolveNotebookMentionAliases(
  input: string,
  assets: readonly AssetMentionCandidate[],
): string {
  const assetSlugsByCellSlug = new Map(
    assets.map((asset) => [asset.cellSlug.toLowerCase(), asset.assetSlug]),
  )
  return input.replace(/@([\w-]+)/gu, (mention, value: string) => {
    const assetSlug = assetSlugsByCellSlug.get(value.toLowerCase())
    return assetSlug ? `@${assetSlug}` : mention
  })
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
  const requested = assetId.trim().replace(/^@/u, '').toLowerCase()
  const candidate = assets.find((asset) =>
    asset.cellSlug.toLowerCase() === requested
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
  const match = input.match(/@([\w-]*)$/)
  if (!match) return []
  const filter = match[1].toLowerCase()
  const context = input.slice(0, match.index ?? input.length).trim()
  const requiredType = /\b(?:generate|create|make)\s+(?:an?\s+)?(?:image|photo|picture)s?(?:\s+(?:of|from|using|with))?$/iu.test(context)
    ? 'image'
    : null
  return assets
    .filter((asset) => (
      (!requiredType || asset.type.toLowerCase() === requiredType)
      && asset.cellSlug.toLowerCase().includes(filter)
    ))
    .slice(0, 12)
    .map((asset) => ({
      value: `@${asset.cellSlug}`,
      label: `@${asset.cellSlug}`,
      asset,
      type: 'asset',
    }))
}
