import { describe, expect, it } from 'vitest'
import {
  downloadWatchStep,
  downloadVideoCellInput,
} from '../../src/videobook/notebook-download'

describe('notebook download placement', () => {
  it('builds a video cell for the downloaded artifact in the requested slot', () => {
    expect(downloadVideoCellInput({
      artifact_id: '019fabcd-1234-7000-8000-000000000001',
      job_id: 'download-vid-example-123',
    }, 'https://example.com/video', { row: 2, column: 1 })).toEqual({
      type: 'video',
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
    )).toThrow('did not return an artifact')
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
