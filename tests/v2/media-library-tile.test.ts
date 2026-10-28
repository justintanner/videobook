import { describe, expect, it } from 'vitest'
import {
  mediaLibraryTileAspectLabel,
  mediaLibraryTileBadge,
  mediaLibraryTileRatio,
  mediaLibraryTileSize,
} from '../../src/videobook/media-library-tile'

const portraitVideo = { type: 'video', width: 1080, height: 1920, duration: 6.04 }
const landscapeVideo = { type: 'final', width: 1920, height: 1080, duration: 12 }

describe('media library tiles', () => {
  it('sizes portrait and landscape tiles by their real shape', () => {
    expect(mediaLibraryTileRatio(mediaLibraryTileSize(portraitVideo, null))).toBeCloseTo(9 / 16)
    expect(mediaLibraryTileRatio(mediaLibraryTileSize(landscapeVideo, null))).toBeCloseTo(16 / 9)
    expect(mediaLibraryTileAspectLabel(mediaLibraryTileSize(portraitVideo, null))).toBe('9:16')
    expect(mediaLibraryTileAspectLabel(mediaLibraryTileSize(landscapeVideo, null))).toBe('16:9')
  })

  it('falls back to the measured preview, then to 16:9', () => {
    const unknown = { type: 'image', width: null, height: null, duration: null }
    expect(mediaLibraryTileSize(unknown, { width: 800, height: 800 })).toEqual({ width: 800, height: 800 })
    expect(mediaLibraryTileRatio(null)).toBeCloseTo(16 / 9)
    expect(mediaLibraryTileAspectLabel(null)).toBeNull()
  })

  it('keeps extreme panoramas and strips inside a usable range', () => {
    expect(mediaLibraryTileRatio({ width: 6000, height: 500 })).toBeCloseTo(21 / 9)
    expect(mediaLibraryTileRatio({ width: 300, height: 4000 })).toBeCloseTo(9 / 21)
  })

  it('labels videos by length and images by pixel size', () => {
    expect(mediaLibraryTileBadge(portraitVideo, null)).toEqual({ kind: 'video', text: '0:06' })
    expect(mediaLibraryTileBadge(
      { type: 'image', width: 1024, height: 1024, duration: null },
      { width: 1024, height: 1024 },
    )).toEqual({ kind: 'image', text: '1024×1024' })
    expect(mediaLibraryTileBadge({ type: 'audio', width: null, height: null, duration: 0 }, null))
      .toEqual({ kind: 'audio', text: null })
  })
})
