import { describe, expect, it } from 'vitest'
import type { NotebookCell } from 'videobook-engine'
import {
  downloadVideoCellInput,
  nextNotebookCellSlug,
} from '../../src/videobook/notebook-download'

const cells = [
  { slug: 'vid-01' },
  { slug: 'vid-03' },
] as NotebookCell[]

describe('notebook download placement', () => {
  it('builds a video cell for the downloaded artifact in the first free slot', () => {
    expect(downloadVideoCellInput({
      artifact_id: '019fabcd-1234-7000-8000-000000000001',
      job_id: 'download-vid-example-123',
    }, 'https://example.com/video', { row: 2, column: -1 }, cells)).toEqual({
      type: 'video',
      slug: 'vid-02',
      slot: { row: 2, column: -1 },
      inputs: {
        sourceOperation: 'download_video',
        sourceUrl: 'https://example.com/video',
        jobId: 'download-vid-example-123',
      },
      output_artifact_id: '019fabcd-1234-7000-8000-000000000001',
    })
  })

  it('rejects a response that cannot be attached to the board', () => {
    expect(() => downloadVideoCellInput(
      { assetId: 'vid-example' },
      'https://example.com/video',
      { row: 0, column: 0 },
      [],
    )).toThrow('did not return an artifact')
  })

  it('uses the first unoccupied slug for any cell type', () => {
    expect(nextNotebookCellSlug('video', cells)).toBe('vid-02')
  })
})
