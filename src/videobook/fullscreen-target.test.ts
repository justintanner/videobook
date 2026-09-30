import { describe, expect, it } from 'vitest'
import { resolveFullscreenTarget } from './fullscreen-target'

const cells = [
  { id: 'cell-image', slot: { row: 0, column: 6 }, outputArtifactId: 'img-1' },
  { id: 'cell-video', slot: { row: 1, column: 0 }, outputArtifactId: 'vid-1' },
  { id: 'cell-audio', slot: { row: 2, column: 0 }, outputArtifactId: 'aud-1' },
  { id: 'cell-pending', slot: { row: 3, column: 0 }, outputArtifactId: 'vid-2' },
  { id: 'cell-empty', slot: { row: 4, column: 0 } },
]
const assets = [
  { artifactId: 'img-1', type: 'image', mediaUrl: '/files/img-1/original.png', thumbnailUrl: null },
  { artifactId: 'vid-1', type: 'video', mediaUrl: null, thumbnailUrl: '/files/vid-1/thumb.jpg' },
  { artifactId: 'aud-1', type: 'audio', mediaUrl: '/files/aud-1/original.mp3', thumbnailUrl: null },
  { artifactId: 'vid-2', type: 'video', mediaUrl: null, thumbnailUrl: null },
]

describe('resolveFullscreenTarget', () => {
  it('opens the planned cell with its current media and grid address', () => {
    expect(resolveFullscreenTarget({ cell_id: 'cell-image', asset_id: 'img-1' }, cells, assets))
      .toEqual({ ok: true, cell: cells[0], asset: assets[0], address: '@a7' })
  })

  it('finds the cell by its media when the plan names no cell', () => {
    expect(resolveFullscreenTarget({ asset_id: 'vid-1' }, cells, assets))
      .toEqual({ ok: true, cell: cells[1], asset: assets[1], address: '@b1' })
  })

  it('follows the cell to the media it holds now, not the media the plan saw', () => {
    const result = resolveFullscreenTarget({ cell_id: 'cell-image', asset_id: 'replaced' }, cells, assets)
    expect(result).toMatchObject({ ok: true, asset: { artifactId: 'img-1' } })
  })

  it.each([
    [{ cell_id: 'gone', asset_id: 'gone' }, 'That cell is no longer in this notebook.'],
    [{ cell_id: 'cell-empty' }, '@e1 has no media yet.'],
    [{ cell_id: 'cell-audio' }, '@c1 holds audio; fullscreen shows images and video.'],
    [{ cell_id: 'cell-pending' }, '@d1 is still processing. Try again when it is ready.'],
    [{}, 'That cell is no longer in this notebook.'],
  ])('refuses %j with a reason the copilot can speak', (params, message) => {
    expect(resolveFullscreenTarget(params, cells, assets)).toEqual({ ok: false, message })
  })
})
