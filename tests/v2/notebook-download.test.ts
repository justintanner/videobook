import { describe, expect, it } from 'vitest'
import type { NotebookCell } from 'videobook-engine'
import {
  downloadWatchStep,
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
    }, 'https://example.com/video', { row: 2, column: 1 }, cells)).toEqual({
      type: 'video',
      slug: 'vid-02',
      slot: { row: 2, column: 1 },
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

  it('keeps watching while the downloaded artifact is active', () => {
    expect(downloadWatchStep('artifact-01', {
      artifactId: 'artifact-01',
      status: 'downloading',
    }, [{
      artifactId: 'artifact-01',
      error: null,
      state: 'running',
    }])).toEqual({ kind: 'continue' })
  })

  it('completes when the downloaded artifact is ready', () => {
    expect(downloadWatchStep('artifact-01', {
      artifactId: 'artifact-01',
      status: 'ready',
    }, [])).toEqual({ kind: 'completed' })
  })

  it('surfaces the durable job failure', () => {
    expect(downloadWatchStep('artifact-01', {
      artifactId: 'artifact-01',
      status: 'error',
    }, [{
      artifactId: 'artifact-01',
      error: { message: 'Remote host returned 403' },
      state: 'failed',
    }])).toEqual({
      kind: 'failed',
      message: 'Remote host returned 403',
    })
  })
})
