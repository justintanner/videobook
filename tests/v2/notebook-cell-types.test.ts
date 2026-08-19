import type { NotebookCellType } from 'videobook-engine'
import { describe, expect, it } from 'vitest'
import {
  isNotebookExtractMediaCellType,
  isNotebookGenerationCellType,
  isNotebookMediaPresentationCellType,
  isNotebookMediaWorkCellType,
} from '../../src/videobook/notebook-cell-types'

const cellTypeCases = [
  ['analysis', false, false, false, false],
  ['analyze', false, false, false, false],
  ['audio', false, false, true, true],
  ['character', false, false, true, false],
  ['concat', false, false, false, false],
  ['extract_audio', false, true, false, false],
  ['generate_audio', true, false, false, false],
  ['generate_image', true, false, false, false],
  ['generate_video', true, false, false, false],
  ['image', false, false, true, true],
  ['prompt', false, false, false, false],
  ['splice', false, false, false, false],
  ['split_video', false, false, false, false],
  ['video', false, false, true, true],
] satisfies Array<[
  NotebookCellType,
  boolean,
  boolean,
  boolean,
  boolean,
]>

describe('notebook cell type semantics', () => {
  it.each(cellTypeCases)(
    'classifies %s generation eligibility',
    (type, generation, _extractedMedia, _mediaPresentation, _mediaWork) => {
      expect(isNotebookGenerationCellType(type)).toBe(generation)
    },
  )

  it.each(cellTypeCases)(
    'classifies %s extracted-media output',
    (type, _generation, extractedMedia, _mediaPresentation, _mediaWork) => {
      expect(isNotebookExtractMediaCellType(type)).toBe(extractedMedia)
    },
  )

  it.each(cellTypeCases)(
    'classifies %s passive media presentation',
    (type, _generation, _extractedMedia, mediaPresentation, _mediaWork) => {
      expect(isNotebookMediaPresentationCellType(type)).toBe(mediaPresentation)
    },
  )

  it.each(cellTypeCases)(
    'classifies %s runnable media work',
    (
      type,
      _generation,
      _extractedMedia,
      _mediaPresentation,
      mediaWork,
    ) => {
      expect(isNotebookMediaWorkCellType(type)).toBe(mediaWork)
    },
  )

  it('rejects unknown catalog values', () => {
    expect(isNotebookGenerationCellType('unknown')).toBe(false)
    expect(isNotebookExtractMediaCellType('unknown')).toBe(false)
    expect(isNotebookMediaPresentationCellType('unknown')).toBe(false)
    expect(isNotebookMediaWorkCellType('unknown')).toBe(false)
  })
})
