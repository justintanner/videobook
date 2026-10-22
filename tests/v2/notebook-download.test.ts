import { describe, expect, it } from 'vitest'
import {
  downloadWatchStep,
  downloadVideoCellInput,
  mediaAssetWatchStep,
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
      result: null,
      state: 'running',
      type: 'download_video',
    }])).toEqual({ kind: 'continue' })
  })

  it('completes when the downloaded artifact is ready', () => {
    expect(downloadWatchStep('artifact-01', {
      artifactId: 'artifact-01',
      status: 'ready',
    }, [])).toEqual({ kind: 'completed' })
  })

  it('follows a successful download that was retyped to another artifact', () => {
    expect(downloadWatchStep('artifact-01', {
      artifactId: 'artifact-01',
      status: 'error',
    }, [{
      artifactId: 'artifact-01',
      error: null,
      result: {
        assetId: 'artifact-02',
        retyped: true,
        success: true,
      },
      state: 'done',
      type: 'download_video',
    }])).toEqual({
      kind: 'redirected',
      artifactId: 'artifact-02',
    })
  })

  it('surfaces the durable job failure', () => {
    expect(downloadWatchStep('artifact-01', {
      artifactId: 'artifact-01',
      status: 'error',
    }, [{
      artifactId: 'artifact-01',
      error: { message: 'Remote host returned 403' },
      result: null,
      state: 'failed',
      type: 'download_video',
    }])).toEqual({
      kind: 'failed',
      message: 'Remote host returned 403',
    })
  })

  it('keeps watching while process_image is still active', () => {
    expect(mediaAssetWatchStep('artifact-01', {
      artifactId: 'artifact-01',
      status: 'processing',
    }, [{
      artifactId: 'artifact-01',
      error: null,
      result: null,
      state: 'running',
      type: 'process_image',
    }])).toEqual({ kind: 'continue' })
  })

  it('completes when process_image finishes and the asset is ready', () => {
    expect(mediaAssetWatchStep('artifact-01', {
      artifactId: 'artifact-01',
      status: 'ready',
    }, [{
      artifactId: 'artifact-01',
      error: null,
      result: { success: true },
      state: 'done',
      type: 'process_image',
    }])).toEqual({ kind: 'completed' })
  })

  it('surfaces process_image failures on the board', () => {
    expect(mediaAssetWatchStep('artifact-01', {
      artifactId: 'artifact-01',
      status: 'error',
    }, [{
      artifactId: 'artifact-01',
      error: { message: 'Failed to read original' },
      result: null,
      state: 'failed',
      type: 'process_image',
    }])).toEqual({
      kind: 'failed',
      message: 'Failed to read original',
    })
  })

  it('surfaces a failed provider completion on the board', () => {
    expect(mediaAssetWatchStep('artifact-01', {
      artifactId: 'artifact-01',
      status: 'error',
    }, [{
      artifactId: 'artifact-01',
      error: { message: 'Unhandled provider task type: seedance2_video' },
      result: null,
      state: 'failed',
      type: 'complete_kie_task',
    }])).toEqual({
      kind: 'failed',
      message: 'Unhandled provider task type: seedance2_video',
    })
  })

  it('falls back to the cell\'s recorded error when no job explains the failure', () => {
    expect(mediaAssetWatchStep('artifact-01', {
      artifactId: 'artifact-01',
      status: 'error',
    }, [], 'Kie failed: provider rejected the request')).toEqual({
      kind: 'failed',
      message: 'Kie failed: provider rejected the request',
    })
  })

  it('reports the generic failure when nothing recorded a reason', () => {
    expect(mediaAssetWatchStep('artifact-01', {
      artifactId: 'artifact-01',
      status: 'error',
    }, [], null)).toEqual({
      kind: 'failed',
      message: 'Media processing failed',
    })
  })

  it('reports a failed subtitle render when the clip is already in error', () => {
    expect(mediaAssetWatchStep('artifact-01', {
      artifactId: 'artifact-01',
      status: 'error',
    }, [{
      artifactId: 'artifact-01',
      error: { message: 'Job lease expired' },
      result: null,
      state: 'failed',
      type: 'render_project',
    }])).toEqual({
      kind: 'failed',
      message: 'Job lease expired',
    })
  })

  it('does not fail an in-progress clip because an older subtitle render failed', () => {
    expect(mediaAssetWatchStep('artifact-01', {
      artifactId: 'artifact-01',
      status: 'render-queued-portrait',
    }, [{
      artifactId: 'artifact-01',
      error: { message: 'Asset is locked: workspace' },
      result: null,
      state: 'failed',
      type: 'render_project',
    }])).toEqual({ kind: 'continue' })
  })

  it('keeps a ready clip completed after a failed subtitle render', () => {
    expect(mediaAssetWatchStep('artifact-01', {
      artifactId: 'artifact-01',
      status: 'ready',
    }, [{
      artifactId: 'artifact-01',
      error: { message: 'Job lease expired' },
      result: null,
      state: 'failed',
      type: 'render_project',
    }])).toEqual({ kind: 'completed' })
  })

  it('ignores unrelated failed jobs while media is still processing', () => {
    expect(mediaAssetWatchStep('artifact-01', {
      artifactId: 'artifact-01',
      status: 'processing',
    }, [{
      artifactId: 'artifact-01',
      error: { message: 'semantic index boom' },
      result: null,
      state: 'failed',
      type: 'semantic_index',
    }])).toEqual({ kind: 'continue' })
  })
})
