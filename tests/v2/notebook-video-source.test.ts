import type { NotebookDocument } from 'videobook-engine'
import { describe, expect, it } from 'vitest'
import { resolveNotebookVideoSourceCell } from '../../src/videobook/notebook-video-source'

const videoCellId = '019f0000-0000-7000-8000-000000000031'
const videoArtifactId = '019f0000-0000-7000-8000-000000000032'
const imageArtifactId = '019f0000-0000-7000-8000-000000000033'

const document: NotebookDocument = {
  id: '019f0000-0000-7000-8000-000000000034',
  name: 'Video sources',
  createdAt: new Date(0).toISOString(),
  cells: [
    {
      id: videoCellId,
      type: 'video',
      label: 'Ready video',
      slot: { row: 0, column: 0 },
      outputArtifactId: videoArtifactId,
    },
    {
      id: '019f0000-0000-7000-8000-000000000035',
      type: 'image',
      label: 'Reference image',
      slot: { row: 0, column: 1 },
      outputArtifactId: imageArtifactId,
    },
    {
      id: '019f0000-0000-7000-8000-000000000036',
      type: 'video',
      label: 'Pending video',
      slot: { row: 0, column: 2 },
    },
  ],
  edges: [],
}

describe('notebook video source resolution', () => {
  it.each([
    ['grid address', 'A1'],
    ['artifact id', videoArtifactId],
  ])('resolves a ready video by %s', (_referenceKind, reference) => {
    expect(resolveNotebookVideoSourceCell(document, reference).id).toBe(videoCellId)
  })

  it.each([
    ['missing source', 'missing-video', 'Notebook cell @missing-video was not found'],
    ['wrong media kind', imageArtifactId, '@a2 is not a video-producing cell'],
    ['missing video output', 'a3', '@a3 does not have a video output yet'],
  ])('rejects %s', (_case, reference, message) => {
    expect(() => resolveNotebookVideoSourceCell(document, reference)).toThrow(message)
  })
})
