import { formatMediaAspectRatio, formatMediaTime } from '@/videobook/notebook-cell-presentation'

export type MediaLibraryTileSource = {
  type: string
  width: number | null
  height: number | null
  duration: number | null
}

export type MediaSize = { width: number; height: number }

export type MediaLibraryTileBadge = {
  kind: 'video' | 'image' | 'audio'
  text: string | null
}

const defaultTileRatio = 16 / 9
const narrowestTileRatio = 9 / 21
const widestTileRatio = 21 / 9

function validSize(width: number | null, height: number | null): MediaSize | null {
  if (width === null || height === null) return null
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

export function mediaLibraryTileSize(
  asset: MediaLibraryTileSource,
  measured: MediaSize | null,
): MediaSize | null {
  return validSize(asset.width, asset.height) ?? measured
}

export function mediaLibraryTileRatio(size: MediaSize | null): number {
  if (!size) return defaultTileRatio
  const ratio = size.width / size.height
  return Math.min(widestTileRatio, Math.max(narrowestTileRatio, ratio))
}

export function mediaLibraryTileAspectLabel(size: MediaSize | null): string | null {
  if (!size) return null
  return formatMediaAspectRatio(size.width, size.height)
}

function tileKind(type: string): MediaLibraryTileBadge['kind'] {
  if (type === 'audio') return 'audio'
  if (type === 'image') return 'image'
  return 'video'
}

export function mediaLibraryTileBadge(
  asset: MediaLibraryTileSource,
  size: MediaSize | null,
): MediaLibraryTileBadge {
  const kind = tileKind(asset.type)
  if (kind === 'image') {
    return { kind, text: size ? `${Math.round(size.width)}×${Math.round(size.height)}` : null }
  }
  const duration = asset.duration !== null && Number.isFinite(asset.duration) && asset.duration > 0
    ? formatMediaTime(Math.round(asset.duration))
    : null
  return { kind, text: duration }
}
