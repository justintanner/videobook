import { describe, expect, it } from 'vitest'
import { notebookMediaWorkState } from '../../src/videobook/notebook-media-work'

const startedAt = Date.parse('2026-08-01T04:00:00.000Z')
const activeJob = {
  artifactId: 'artifact-01',
  enqueuedAt: startedAt - 1_000,
  error: null,
  startedAt,
  state: 'running',
}
const asset = {
  artifactId: 'artifact-01',
  createdAt: '2026-08-01T03:59:59.000Z',
  status: 'downloading',
}

describe('notebookMediaWorkState', () => {
  it('presents active media work from the attached artifact and job', () => {
    expect(notebookMediaWorkState('video', asset, [activeJob], {
      status: 'completed',
    })).toEqual({
      status: 'downloading',
      startedAt: '2026-08-01T04:00:00.000Z',
    })

    expect(notebookMediaWorkState('video', {
      ...asset,
      status: 'processing',
    }, [activeJob], {
      status: 'completed',
    })).toEqual({
      status: 'processing',
      startedAt: '2026-08-01T04:00:00.000Z',
    })
  })

  it('presents ready media as completed', () => {
    expect(notebookMediaWorkState('video', {
      ...asset,
      status: 'ready',
    }, [activeJob], {
      status: 'ready',
    })).toEqual({ status: 'completed' })
  })

  it('presents the durable media job error', () => {
    expect(notebookMediaWorkState('video', {
      ...asset,
    }, [{
      ...activeJob,
      error: { message: 'Remote host returned 403' },
      state: 'failed',
    }], {
      status: 'completed',
    })).toEqual({
      status: 'error',
      error: 'Remote host returned 403',
    })
  })

  it('preserves fallback state for empty media and generation cells', () => {
    const fallback = {
      status: 'ready',
      startedAt: '2026-08-01T03:00:00.000Z',
    }
    expect(notebookMediaWorkState('video', undefined, [], fallback)).toBe(fallback)
    expect(notebookMediaWorkState(
      'generate_video',
      asset,
      [activeJob],
      fallback,
    )).toBe(fallback)
  })
})
