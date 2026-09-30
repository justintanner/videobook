import { notebookGridTag } from 'videobook-engine/notebook-grid'

interface FullscreenTargetCell {
  id: string
  slot: { row: number; column: number }
  outputArtifactId?: string
}

interface FullscreenTargetAsset {
  artifactId: string
  type: string
  mediaUrl: string | null
  thumbnailUrl: string | null
}

type FullscreenTargetResult<Cell, Asset> =
  | { ok: true; cell: Cell; asset: Asset; address: string }
  | { ok: false; message: string }

/**
 * The cell and media a routed show_media_fullscreen plan points at, checked
 * against what the notebook holds right now: the plan was resolved on the
 * server a moment ago, and only media the viewer can draw may open it.
 */
export function resolveFullscreenTarget<
  Cell extends FullscreenTargetCell,
  Asset extends FullscreenTargetAsset,
>(
  params: Record<string, unknown>,
  cells: readonly Cell[],
  assets: readonly Asset[],
): FullscreenTargetResult<Cell, Asset> {
  const cell = cells.find((candidate) => candidate.id === params.cell_id)
    ?? cells.find((candidate) => candidate.outputArtifactId !== undefined
      && candidate.outputArtifactId === params.asset_id)
  if (!cell) return { ok: false, message: 'That cell is no longer in this notebook.' }
  const address = notebookGridTag(cell.slot)
  const asset = assets.find((candidate) => candidate.artifactId === cell.outputArtifactId)
  if (!asset) return { ok: false, message: `${address} has no media yet.` }
  if (asset.type === 'audio') {
    return { ok: false, message: `${address} holds audio; fullscreen shows images and video.` }
  }
  if (!asset.mediaUrl && !asset.thumbnailUrl) {
    return { ok: false, message: `${address} is still processing. Try again when it is ready.` }
  }
  return { ok: true, cell, asset, address }
}
