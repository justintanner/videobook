import { describe, expect, it } from 'vitest'
import {
  filterNotebookCellAddItems,
  isNotebookCellAddType,
} from './notebook-cell-add-menu'

describe('notebook cell add menu', () => {
  it('filters cell types by label, stored type, and group', () => {
    expect(filterNotebookCellAddItems('frame').map((item) => item.type))
      .toEqual(['extract_frame'])
    expect(filterNotebookCellAddItems('generate_audio').map((item) => item.type))
      .toEqual(['generate_audio'])
    expect(filterNotebookCellAddItems('media').map((item) => item.type))
      .toEqual(['audio', 'image', 'video', 'character'])
  })

  it('returns every option for a blank search and none for an unknown search', () => {
    expect(filterNotebookCellAddItems('')).toHaveLength(14)
    expect(filterNotebookCellAddItems('missing cell type')).toEqual([])
  })

  it('recognizes only cell types exposed by the add menu', () => {
    expect(isNotebookCellAddType('prompt')).toBe(true)
    expect(isNotebookCellAddType('analysis')).toBe(false)
  })
})
