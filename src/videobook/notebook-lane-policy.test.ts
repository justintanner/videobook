import type { NotebookCellType } from 'videobook-engine'
import { describe, expect, it } from 'vitest'
import {
  groupNotebookLaneSections,
  summarizeNotebookLaneRows,
} from './notebook-lane-policy'
import {
  NOTEBOOK_LANE_LABELS,
  NOTEBOOK_LANE_ORDER,
  notebookCellLane,
  notebookLaneLabel,
  notebookTypeLane,
  type NotebookLaneCell,
} from '../../server/src/notebook-lanes'

let nextId = 0

function cell(
  type: NotebookCellType,
  row: number,
  column = 0,
  inputs?: Record<string, unknown>,
): NotebookLaneCell {
  nextId += 1
  return {
    id: `cell-${String(nextId).padStart(3, '0')}`,
    type,
    slot: { row, column },
    ...(inputs ? { inputs } : {}),
  }
}

describe('notebook lane family policy', () => {
  it('orders Source videos, Gen, Images, Videos, Audio and Work', () => {
    expect(NOTEBOOK_LANE_ORDER.map(notebookLaneLabel)).toEqual([
      'Source videos',
      'Gen',
      'Images',
      'Videos',
      'Audio',
      'Work',
    ])
    expect(notebookTypeLane('video')).toBe('source')
    expect(notebookTypeLane('image')).toBe('image')
    expect(notebookTypeLane('prompt')).toBe('gen')
    expect(notebookTypeLane('generate_audio')).toBe('gen')
    expect(notebookTypeLane('generate_image')).toBe('gen')
    expect(notebookTypeLane('generate_video')).toBe('gen')
    expect(notebookTypeLane('goal')).toBe('gen')
    expect(notebookTypeLane('concat')).toBe('video')
    expect(notebookTypeLane('splice')).toBe('video')
    expect(notebookTypeLane('split_video')).toBe('video')
    expect(notebookTypeLane('audio')).toBe('audio')
    expect(notebookTypeLane('extract_audio')).toBe('audio')
    expect(notebookTypeLane('analyze')).toBe('work')
    expect(notebookTypeLane('analysis')).toBe('work')
    expect(notebookTypeLane('character')).toBe('work')
    expect(notebookTypeLane('post')).toBe('work')
    expect(NOTEBOOK_LANE_LABELS[notebookTypeLane('video')]).toBe('Source videos')
    expect(NOTEBOOK_LANE_LABELS[notebookTypeLane('prompt')]).toBe('Gen')
    expect(NOTEBOOK_LANE_LABELS[notebookTypeLane('image')]).toBe('Images')
  })

  it('keeps imported videos and their clips as sources and generated or edited videos as Videos', () => {
    const upload = cell('video', 0, 0)
    const download = cell('video', 0, 1, { sourceOperation: 'download_video' })
    const clip = cell('video', 0, 2, { mediaRole: 'cut-clip-output', sourceCellId: upload.id })
    const extracted = cell('video', 0, 3, { sourceOperation: 'extract_video_clip' })
    const generator = cell('generate_video', 1, 0)
    const generated = cell('video', 3, 0, { mediaRole: 'generate-video-output', producerCellId: generator.id })
    const generatedClip = cell('video', 3, 1, { mediaRole: 'cut-clip-output', sourceCellId: generated.id })
    const splice = cell('video', 3, 2, { sourceOperation: 'splice_video' })
    const captioned = cell('video', 3, 3, { sourceOperation: 'caption_video' })
    const coldOpen = cell('video', 3, 4, { sourceOperation: 'edit_cold_open' })
    const sourceCopy = cell('video', 0, 4, { sourceOperation: 'duplicate_asset', sourceArtifactId: 'download-art' })
    const orphanCopy = cell('video', 3, 5, { sourceOperation: 'duplicate_asset', sourceArtifactId: 'gone' })
    const cells = [
      upload,
      { ...download, outputArtifactId: 'download-art' },
      clip,
      extracted,
      generator,
      generated,
      generatedClip,
      splice,
      captioned,
      coldOpen,
      sourceCopy,
      orphanCopy,
    ]
    const lanes = Object.fromEntries(cells.map((item) => [item.slot.row * 8 + item.slot.column, notebookCellLane(item, cells)]))
    expect(lanes).toEqual({
      0: 'source',
      1: 'source',
      2: 'source',
      3: 'source',
      4: 'source',
      8: 'gen',
      24: 'video',
      25: 'video',
      26: 'video',
      27: 'video',
      28: 'video',
      29: 'video',
    })
  })

  it('labels one Source videos/Gen/Images row each as a/b/c without moving slots', () => {
    const cells = [
      cell('video', 0, 1),
      cell('generate_video', 1, 0),
      cell('prompt', 1, 2),
      cell('image', 2, 0),
    ]
    const rows = summarizeNotebookLaneRows(cells, 3)
    expect(rows.map((row) => ({
      caption: row.caption,
      continuation: row.continuation,
      family: row.family,
      kind: row.kind,
      row: row.row,
    }))).toEqual([
      {
        caption: 'Source videos',
        continuation: false,
        family: 'source',
        kind: 'homogeneous',
        row: 0,
      },
      {
        caption: 'Gen',
        continuation: false,
        family: 'gen',
        kind: 'homogeneous',
        row: 1,
      },
      {
        caption: 'Images',
        continuation: false,
        family: 'image',
        kind: 'homogeneous',
        row: 2,
      },
    ])
    expect(cells.map((item) => item.slot)).toEqual([
      { row: 0, column: 1 },
      { row: 1, column: 0 },
      { row: 1, column: 2 },
      { row: 2, column: 0 },
    ])
  })

  it('keeps mixed rows truthful instead of majority-relabeling them', () => {
    const rows = summarizeNotebookLaneRows([
      cell('image', 0, 0),
      cell('image', 0, 1),
      cell('image', 0, 2),
      cell('image', 0, 3),
      cell('image', 0, 4),
      cell('image', 0, 5),
      cell('image', 0, 6),
      cell('video', 0, 7),
    ], 3)
    expect(rows[0]).toMatchObject({
      caption: 'Source videos · Images',
      continuation: false,
      families: ['source', 'image'],
      family: null,
      kind: 'mixed',
      row: 0,
    })
    expect(rows[0]?.caption).not.toBe('Images')
    expect(rows[1]?.kind).toBe('empty')
    expect(rows[2]?.kind).toBe('empty')
  })

  it('shows Source videos/Gen/Images starter guides only on an entirely empty book', () => {
    const empty = summarizeNotebookLaneRows([], 4)
    expect(empty.map((row) => ({
      caption: row.caption,
      kind: row.kind,
      row: row.row,
    }))).toEqual([
      { caption: 'Source videos', kind: 'starter', row: 0 },
      { caption: 'Gen', kind: 'starter', row: 1 },
      { caption: 'Images', kind: 'starter', row: 2 },
      { caption: '', kind: 'empty', row: 3 },
    ])

    const populated = summarizeNotebookLaneRows([cell('audio', 4, 0)], 5)
    expect(populated.filter((row) => row.kind === 'starter')).toEqual([])
    expect(populated.slice(0, 4).every((row) => row.kind === 'empty')).toBe(true)
    expect(populated[4]).toMatchObject({
      caption: 'Audio',
      family: 'audio',
      kind: 'homogeneous',
      row: 4,
    })
  })

  it('marks homogeneous overflow rows as continuation of the same family', () => {
    const rows = summarizeNotebookLaneRows([
      ...Array.from({ length: 8 }, (_, column) => cell('image', 0, column)),
      cell('image', 1, 0),
      cell('generate_image', 2, 0),
    ], 4)
    expect(rows[0]).toMatchObject({
      caption: 'Images',
      continuation: false,
      family: 'image',
      kind: 'homogeneous',
    })
    expect(rows[1]).toMatchObject({
      caption: 'Images',
      continuation: true,
      family: 'image',
      kind: 'homogeneous',
    })
    expect(rows[2]).toMatchObject({
      caption: 'Gen',
      continuation: false,
      family: 'gen',
    })
    expect(groupNotebookLaneSections(rows)).toEqual([
      {
        caption: 'Images',
        families: ['image'],
        family: 'image',
        kind: 'homogeneous',
        rowCount: 2,
        startRow: 0,
      },
      {
        caption: 'Gen',
        families: ['gen'],
        family: 'gen',
        kind: 'homogeneous',
        rowCount: 1,
        startRow: 2,
      },
    ])
  })
})
