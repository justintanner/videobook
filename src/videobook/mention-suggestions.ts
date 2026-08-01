import { formatMediaTime } from './notebook-cell-presentation'

export interface AssetMentionCandidate {
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

interface NotebookMentionCell {
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
  assets: readonly AssetMentionCandidate[],
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
    return [asset]
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
    .filter((asset) => asset.id.toLowerCase().includes(filter))
    .slice(0, 12)
    .map((asset) => ({
      value: `@${asset.id}`,
      label: `@${asset.id}`,
      asset,
      type: 'asset',
    }))
}
