import { describe, expect, it } from 'vitest'
import {
  watermarkAppliedMessage,
  watermarkBurnWatchStep,
  watermarkQueuedMessage,
} from './watermark-burn'

type WatchJob = Parameters<typeof watermarkBurnWatchStep>[3][number]

function job(overrides: Partial<WatchJob> & { id: number }): WatchJob {
  return {
    artifactId: 'vid-1',
    state: 'done',
    error: null,
    result: null,
    ...overrides,
  }
}

const ready = { status: 'ready' }
const working = { status: 'working' }

describe('watermarkBurnWatchStep', () => {
  it('reports a job the listing has not surfaced yet', () => {
    expect(watermarkBurnWatchStep('vid-1', 7, ready, [])).toEqual({ kind: 'missing' })
  })

  it('keeps waiting while the burn is queued or running, even if the asset reads ready', () => {
    expect(watermarkBurnWatchStep('vid-1', 7, ready, [job({ id: 7, state: 'queued' })]))
      .toEqual({ kind: 'continue' })
    expect(watermarkBurnWatchStep('vid-1', 7, working, [job({ id: 7, state: 'running' })]))
      .toEqual({ kind: 'continue' })
  })

  it('keeps waiting while the reprocess the burn queued is active', () => {
    const jobs = [
      job({ id: 7, result: { corner: 'top-left' } }),
      job({ id: 8, state: 'running' }),
    ]
    expect(watermarkBurnWatchStep('vid-1', 7, working, jobs)).toEqual({ kind: 'continue' })
    expect(watermarkBurnWatchStep('vid-1', 7, ready, jobs)).toEqual({ kind: 'continue' })
  })

  it('completes with the burn result once the asset settles back to ready', () => {
    const jobs = [
      job({ id: 7, result: { corner: 'top-left', placementSource: 'vision' } }),
      job({ id: 8 }),
    ]
    expect(watermarkBurnWatchStep('vid-1', 7, working, jobs)).toEqual({ kind: 'continue' })
    expect(watermarkBurnWatchStep('vid-1', 7, ready, jobs)).toEqual({
      kind: 'completed',
      result: { corner: 'top-left', placementSource: 'vision' },
    })
  })

  it('fails on a failed burn, a failed reprocess, or an errored asset', () => {
    expect(watermarkBurnWatchStep('vid-1', 7, ready, [
      job({ id: 7, state: 'failed', error: { message: 'ffmpeg exploded' } }),
    ])).toEqual({ kind: 'failed', message: 'ffmpeg exploded' })
    expect(watermarkBurnWatchStep('vid-1', 7, working, [
      job({ id: 7 }),
      job({ id: 8, state: 'aborted', error: null }),
    ])).toEqual({ kind: 'failed', message: 'Post-watermark processing failed' })
    expect(watermarkBurnWatchStep('vid-1', 7, { status: 'error' }, [job({ id: 7 })]))
      .toEqual({ kind: 'failed', message: 'Post-watermark processing failed' })
  })

  it('ignores earlier jobs and other assets', () => {
    const jobs = [
      job({ id: 5, state: 'failed', error: { message: 'old failure' } }),
      job({ id: 7 }),
      job({ id: 9, artifactId: 'vid-2', state: 'running' }),
    ]
    expect(watermarkBurnWatchStep('vid-1', 7, ready, jobs)).toEqual({
      kind: 'completed',
      result: null,
    })
  })
})

describe('watermark notices', () => {
  const applied = {
    includeQr: true,
    includeHandle: true,
    handle: 'someone',
    handlePlacement: 'center' as const,
    handleVerticalPercent: 33,
    handleOpacity: 0.7,
    qrOpacity: 0.35,
    requestedPosition: 'auto' as const,
    corner: 'bottom-left',
    placementSource: 'vision',
  }

  it('describes a frame-aware QR plus handle burn', () => {
    expect(watermarkAppliedMessage(applied)).toBe(
      'QR + @someone watermarks burned in — QR bottom-left (frame-aware) · QR 35% · handle 33% from top at 70%.',
    )
  })

  it('falls back to the requested position and names attached handles', () => {
    expect(watermarkAppliedMessage({
      ...applied,
      includeHandle: false,
      corner: null,
      placementSource: 'pending',
    })).toBe('QR watermark burned in — auto · QR 35%.')
    expect(watermarkAppliedMessage({
      ...applied,
      includeQr: false,
      handlePlacement: 'below-qr',
      corner: null,
      placementSource: 'fixed',
    })).toBe('@someone watermark burned in · handle below qr at 70%.')
  })

  it('announces the queued burn with its target', () => {
    expect(watermarkQueuedMessage(true, true, 'someone', '@a1'))
      .toBe('Burning QR + @someone watermarks into @a1…')
    expect(watermarkQueuedMessage(true, false, '', '@a1'))
      .toBe('Burning QR watermark into @a1…')
    expect(watermarkQueuedMessage(false, true, 'someone', 'vid-1'))
      .toBe('Burning @someone watermark into vid-1…')
  })
})
