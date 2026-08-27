import { describe, expect, it } from 'vitest'
import {
  detectSearchSubmitIntent,
  downloadWatchStep,
  searchReferenceKindForFile,
  watchDownloadJob,
} from '../../src/videobook/import-then-search'

describe('detectSearchSubmitIntent', () => {
  it('detects lone http and https URLs', () => {
    expect(detectSearchSubmitIntent('https://youtube.com/watch?v=abc'))
      .toEqual({ kind: 'url', url: 'https://youtube.com/watch?v=abc' })
    expect(detectSearchSubmitIntent('  http://example.com/clip.mp4  '))
      .toEqual({ kind: 'url', url: 'http://example.com/clip.mp4' })
  })

  it('treats descriptions as text, even when they mention a URL', () => {
    expect(detectSearchSubmitIntent('the red van at sunset'))
      .toEqual({ kind: 'text', text: 'the red van at sunset' })
    expect(detectSearchSubmitIntent('find https://youtube.com/watch?v=abc'))
      .toEqual({ kind: 'text', text: 'find https://youtube.com/watch?v=abc' })
    expect(detectSearchSubmitIntent('ftp://example.com/file'))
      .toEqual({ kind: 'text', text: 'ftp://example.com/file' })
  })

  it('treats empty and whitespace input as empty', () => {
    expect(detectSearchSubmitIntent('')).toEqual({ kind: 'empty' })
    expect(detectSearchSubmitIntent('   ')).toEqual({ kind: 'empty' })
  })
})

describe('downloadWatchStep', () => {
  const artifactId = '0198f2a0-0000-7000-8000-000000000001'
  const job = (patch: Record<string, unknown>) => ({
    id: 1,
    operationId: 'op-1',
    type: 'download_video',
    state: 'running',
    artifactId,
    ...patch,
  })

  it('reports ready when the download job is done', () => {
    expect(downloadWatchStep([job({ state: 'done' })], artifactId))
      .toEqual({ kind: 'ready' })
  })

  it('reports failure with the job error message', () => {
    expect(downloadWatchStep(
      [job({ state: 'failed', error: { message: 'yt-dlp exited 1', code: null } })],
      artifactId,
    )).toEqual({ kind: 'failed', message: 'yt-dlp exited 1' })
    expect(downloadWatchStep([job({ state: 'aborted', error: null })], artifactId))
      .toEqual({ kind: 'failed', message: 'Import failed' })
  })

  it('continues while the job is queued or running', () => {
    expect(downloadWatchStep([job({ state: 'queued' })], artifactId))
      .toEqual({ kind: 'continue' })
    expect(downloadWatchStep([job({ state: 'running' })], artifactId))
      .toEqual({ kind: 'continue' })
    expect(downloadWatchStep([job({ state: 'completing' })], artifactId))
      .toEqual({ kind: 'continue' })
  })

  it('continues when the job is not visible yet or belongs elsewhere', () => {
    expect(downloadWatchStep([], artifactId)).toEqual({ kind: 'continue' })
    expect(downloadWatchStep(
      [job({ artifactId: 'another-artifact', state: 'done' })],
      artifactId,
    )).toEqual({ kind: 'continue' })
    expect(downloadWatchStep(
      [job({ type: 'process_video', state: 'failed' })],
      artifactId,
    )).toEqual({ kind: 'continue' })
    expect(downloadWatchStep({ not: 'an array' }, artifactId))
      .toEqual({ kind: 'continue' })
  })

  it('accepts snake_case artifact ids', () => {
    expect(downloadWatchStep(
      [{ type: 'download_video', state: 'done', artifact_id: artifactId }],
      artifactId,
    )).toEqual({ kind: 'ready' })
  })
})

describe('watchDownloadJob', () => {
  const artifactId = '0198f2a0-0000-7000-8000-000000000002'
  const job = (state: string) => [{ type: 'download_video', state, artifactId }]

  it('polls until the job settles', async () => {
    const states = [job('queued'), job('running'), job('done')]
    let calls = 0
    const outcome = await watchDownloadJob({
      artifactId,
      listJobs: () => Promise.resolve(states[Math.min(calls++, states.length - 1)]),
      isCancelled: () => false,
      intervalMs: 1,
    })
    expect(outcome).toEqual({ kind: 'ready' })
    expect(calls).toBe(3)
  })

  it('surfaces a failed download', async () => {
    const outcome = await watchDownloadJob({
      artifactId,
      listJobs: () => Promise.resolve([{
        type: 'download_video',
        state: 'failed',
        artifactId,
        error: { message: 'no formats found' },
      }]),
      isCancelled: () => false,
      intervalMs: 1,
    })
    expect(outcome).toEqual({ kind: 'failed', message: 'no formats found' })
  })

  it('stops when cancelled', async () => {
    let calls = 0
    const outcome = await watchDownloadJob({
      artifactId,
      listJobs: () => {
        calls += 1
        return Promise.resolve(job('running'))
      },
      isCancelled: () => calls >= 2,
      intervalMs: 1,
    })
    expect(outcome).toEqual({ kind: 'cancelled' })
  })

  it('times out while the job keeps running', async () => {
    const outcome = await watchDownloadJob({
      artifactId,
      listJobs: () => Promise.resolve(job('running')),
      isCancelled: () => false,
      intervalMs: 1,
      timeoutMs: 10,
    })
    expect(outcome).toEqual({ kind: 'timeout' })
  })
})

describe('searchReferenceKindForFile', () => {
  it('classifies by mime type', () => {
    expect(searchReferenceKindForFile(new File([''], 'a', { type: 'image/png' })))
      .toBe('image')
    expect(searchReferenceKindForFile(new File([''], 'a', { type: 'video/mp4' })))
      .toBe('video')
  })

  it('falls back to the file extension', () => {
    expect(searchReferenceKindForFile(new File([''], 'still.webp'))).toBe('image')
    expect(searchReferenceKindForFile(new File([''], 'clip.mkv'))).toBe('video')
  })

  it('returns null for unsupported files', () => {
    expect(searchReferenceKindForFile(new File([''], 'voice.mp3', { type: 'audio/mpeg' })))
      .toBeNull()
    expect(searchReferenceKindForFile(new File([''], 'notes.txt'))).toBeNull()
  })
})
