/**
 * What a media cell's dock says about its output.
 *
 * Image, video and audio all lay out across the dock row the same way: a
 * preview sized from the asset's own shape, a rail of versions beside it, and
 * a facts list naming what the preview cannot. Only the shape and the facts
 * vary by kind, so both are derived here and the inspector stays
 * presentational — the same split `cell-preview` makes for the grid tile.
 */

import {
  formatMediaAspectRatio,
  formatMediaTime,
  notebookAudioPresentation,
} from './notebook-cell-presentation'
import type { NotebookAudioInfo } from './notebook-cell-presentation'

/** The cell types that draw a media dock. Everything else gets a form. */
export type MediaDockKind = 'image' | 'video' | 'audio'

/** `address` facts read as a handle, so they draw in the mono address chip. */
export type MediaDockFactEmphasis = 'plain' | 'address'

export type MediaDockFact = {
  key: string
  term: string
  value: string
  emphasis: MediaDockFactEmphasis
}

export type MediaDockAsset = {
  width: number | null
  height: number | null
  duration: number | null
  audioInfo: NotebookAudioInfo | null
}

/**
 * Preview aspect when the asset carries no frame of its own: portrait for a
 * picture, because takes are usually 9:16, and wide for anything with a
 * timeline, because a video frame and a waveform both read along their length.
 */
const defaultAspect: Record<MediaDockKind, number> = {
  image: 9 / 16,
  video: 16 / 9,
  audio: 16 / 9,
}

const kindLabel: Record<MediaDockKind, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
}

function positive(value: number | null | undefined): value is number {
  return value !== undefined
    && value !== null
    && Number.isFinite(value)
    && value > 0
}

/** The cell types that own a dock preview; null for cells that do not. */
export function mediaDockKind(cellType: string): MediaDockKind | null {
  if (cellType === 'image' || cellType === 'video' || cellType === 'audio') {
    return cellType
  }
  return null
}

/** How a kind names itself in version labels and group captions. */
export function mediaDockKindLabel(kind: MediaDockKind): string {
  return kindLabel[kind]
}

/**
 * Width over height for the preview column. Audio has no frame to measure, so
 * it always takes the default; a picture or a clip takes its own.
 */
export function mediaDockAspect(
  kind: MediaDockKind,
  asset: MediaDockAsset | null,
): number {
  if (
    kind !== 'audio'
    && asset
    && positive(asset.width)
    && positive(asset.height)
  ) {
    return asset.width / asset.height
  }
  return defaultAspect[kind]
}

function fact(
  key: string,
  term: string,
  value: string | null,
  emphasis: MediaDockFactEmphasis = 'plain',
): MediaDockFact | null {
  return value === null ? null : { key, term, value, emphasis }
}

function dimensionsValue(asset: MediaDockAsset): string | null {
  return positive(asset.width) && positive(asset.height)
    ? `${asset.width} × ${asset.height}`
    : null
}

function durationValue(seconds: number | null): string | null {
  return positive(seconds) ? formatMediaTime(seconds) : null
}

/**
 * The facts column: everything the preview shows without saying, plus the
 * address, which is the only handle a cell has.
 *
 * Audio reads its role from the cell's own inputs, the same source the grid
 * tile's badge reads, so a cell does not call itself two different things in
 * two places.
 */
export function mediaDockFacts(
  kind: MediaDockKind,
  address: string,
  asset: MediaDockAsset,
  inputs: Record<string, unknown> | undefined,
): MediaDockFact[] {
  const addressFact = fact('address', 'Address', `@${address}`, 'address')
  if (kind === 'audio') {
    const presentation = notebookAudioPresentation({
      audioInfo: asset.audioInfo,
      durationSeconds: asset.duration,
      hasOutput: true,
      inputs,
    })
    return [
      addressFact,
      fact('role', 'Role', presentation.role),
      fact('duration', 'Duration', presentation.duration),
      fact(
        'format',
        'Format',
        presentation.details.length > 0
          ? presentation.details.join(' · ')
          : null,
      ),
    ].filter((entry): entry is MediaDockFact => entry !== null)
  }
  return [
    addressFact,
    fact('dimensions', 'Dimensions', dimensionsValue(asset)),
    fact('aspect', 'Aspect', formatMediaAspectRatio(asset.width, asset.height)),
    kind === 'video'
      ? fact('duration', 'Duration', durationValue(asset.duration))
      : null,
  ].filter((entry): entry is MediaDockFact => entry !== null)
}
