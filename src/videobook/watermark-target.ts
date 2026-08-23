interface WatermarkTargetAsset {
  artifactId: string
  type: string
}

interface WatermarkTargetCell {
  outputArtifactId?: string
}

type WatermarkTargetResult =
  | { ok: true; artifactId: string; label: string }
  | { ok: false; message: string }

export function resolveWatermarkTarget(
  assetRef: string | undefined,
  selectedCell: WatermarkTargetCell | null,
  assets: readonly WatermarkTargetAsset[],
  cellAddressByArtifactId: ReadonlyMap<string, string>,
): WatermarkTargetResult {
  const artifactId = assetRef?.trim() || selectedCell?.outputArtifactId
  if (!artifactId) {
    return { ok: false, message: 'Select a video cell or pass a target: /watermark @a1' }
  }
  const asset = assets.find((candidate) => candidate.artifactId === artifactId)
  if (!asset) {
    return { ok: false, message: `No asset found for ${artifactId}` }
  }
  if (asset.type !== 'video') {
    return { ok: false, message: `Watermark applies to video assets; ${cellAddressByArtifactId.get(artifactId) ?? artifactId} is ${asset.type}` }
  }
  const address = cellAddressByArtifactId.get(artifactId)
  return { ok: true, artifactId, label: address ? `@${address}` : artifactId }
}
