import type { NotebookCellType } from 'videobook-engine'
import { describe, expect, it } from 'vitest'
import {
  groupNotebookLaneSections,
  notebookLaneFamily,
  notebookLaneFamilyLabel,
  NOTEBOOK_LANE_FAMILY_LABELS,
  NOTEBOOK_LANE_FAMILY_ORDER,
  summarizeNotebookLaneRows,
  type NotebookLaneCell,
} from './notebook-lane-policy'

function cell(
  type: NotebookCellType,
  row: number,
  column = 0,
): NotebookLaneCell {
  return { type, slot: { row, column } }
}

describe('notebook lane family policy', () => {
  it('maps every catalog type onto the Arrange family names', () => {
    expect(NOTEBOOK_LANE_FAMILY_ORDER.map(notebookLaneFamilyLabel)).toEqual([
      'Images',
      'Gen',
      'Videos',
      'Audio',
      'Work',
    ])
    expect(notebookLaneFamily('image')).toBe('image')
    expect(notebookLaneFamily('prompt')).toBe('gen')
    expect(notebookLaneFamily('generate_audio')).toBe('gen')
    expect(notebookLaneFamily('generate_image')).toBe('gen')
    expect(notebookLaneFamily('generate_video')).toBe('gen')
    expect(notebookLaneFamily('video')).toBe('video')
    expect(notebookLaneFamily('concat')).toBe('video')
    expect(notebookLaneFamily('splice')).toBe('video')
    expect(notebookLaneFamily('split_video')).toBe('video')
    expect(notebookLaneFamily('audio')).toBe('audio')
    expect(notebookLaneFamily('extract_audio')).toBe('audio')
    expect(notebookLaneFamily('analyze')).toBe('work')
    expect(notebookLaneFamily('analysis')).toBe('work')
    expect(notebookLaneFamily('character')).toBe('work')
    expect(NOTEBOOK_LANE_FAMILY_LABELS[notebookLaneFamily('image')]).toBe('Images')
    expect(NOTEBOOK_LANE_FAMILY_LABELS[notebookLaneFamily('prompt')]).toBe('Gen')
    expect(NOTEBOOK_LANE_FAMILY_LABELS[notebookLaneFamily('video')]).toBe('Videos')
    expect(NOTEBOOK_LANE_FAMILY_LABELS[notebookLaneFamily('audio')]).toBe('Audio')
    expect(NOTEBOOK_LANE_FAMILY_LABELS[notebookLaneFamily('analyze')]).toBe('Work')
  })

  it('labels one Images/Gen/Videos row each as a/b/c without moving slots', () => {
    const cells = [
      cell('image', 0, 1),
      cell('generate_video', 1, 0),
      cell('prompt', 1, 2),
      cell('video', 2, 0),
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
        caption: 'Images',
        continuation: false,
        family: 'image',
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
        caption: 'Videos',
        continuation: false,
        family: 'video',
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
      caption: 'Images · Videos',
      continuation: false,
      families: ['image', 'video'],
      family: null,
      kind: 'mixed',
      row: 0,
    })
    expect(rows[0]?.caption).not.toBe('Images')
    expect(rows[1]?.kind).toBe('empty')
    expect(rows[2]?.kind).toBe('empty')
  })

  it('shows Images/Gen/Videos starter guides only on an entirely empty book', () => {
    const empty = summarizeNotebookLaneRows([], 4)
    expect(empty.map((row) => ({
      caption: row.caption,
      kind: row.kind,
      row: row.row,
    }))).toEqual([
      { caption: 'Images', kind: 'starter', row: 0 },
      { caption: 'Gen', kind: 'starter', row: 1 },
      { caption: 'Videos', kind: 'starter', row: 2 },
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
