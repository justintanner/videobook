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
  slug: string
  outputArtifactId?: string
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
  const seen = new Set<string>()
  return cells.flatMap((cell) => {
    const artifactId = cell.outputArtifactId
    if (!artifactId || seen.has(artifactId)) return []
    const asset = assetsByArtifactId.get(artifactId)
    if (!asset) return []
    seen.add(artifactId)
    const { id: assetSlug, ...assetFields } = asset
    return [{
      ...assetFields,
      cellSlug: cell.slug,
      assetSlug,
    }]
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
  return assets
    .filter((asset) => asset.cellSlug.toLowerCase().includes(filter))
    .slice(0, 12)
    .map((asset) => ({
      value: `@${asset.cellSlug}`,
      label: `@${asset.cellSlug}`,
      asset,
      type: 'asset',
    }))
}
