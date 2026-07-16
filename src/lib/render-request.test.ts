import { describe, expect, it } from 'vitest'
import { runOptimisticRenderRequest } from '@/lib/render-request'

describe('runOptimisticRenderRequest', () => {
  it('keeps the optimistic status until a post-enqueue snapshot arrives', async () => {
    const statuses: Array<string | null> = []
    const events: string[] = []

    const result = await runOptimisticRenderRequest({
      optimisticStatus: 'render-queued-landscape',
      enqueue: async () => {
        events.push('enqueued')
        return { ok: true }
      },
      refresh: async () => {
        events.push('refreshed')
        return [{ status: 'rendering-landscape' }]
      },
      setOverride: (status) => {
        statuses.push(status)
        events.push(status === null ? 'cleared' : 'overridden')
      },
    })

    expect(result.reconciliation).toBe('refreshed')
    expect(statuses).toEqual(['render-queued-landscape', null])
    expect(events).toEqual(['overridden', 'enqueued', 'refreshed', 'cleared'])
  })

  it('clears the optimistic status immediately when enqueue fails', async () => {
    const statuses: Array<string | null> = []
    let refreshCalls = 0

    const result = await runOptimisticRenderRequest({
      optimisticStatus: 'render-queued-portrait',
      enqueue: async () => ({ ok: false, error: 'render failed' }),
      refresh: async () => {
        refreshCalls += 1
        return []
      },
      setOverride: (status) => statuses.push(status),
    })

    expect(result).toEqual({ ok: false, error: 'render failed', reconciliation: 'not-needed' })
    expect(statuses).toEqual(['render-queued-portrait', null])
    expect(refreshCalls).toBe(0)
  })

  it('shows an authoritative ready state when rendering completes before refresh', async () => {
    let override: string | null = null
    let authoritative = 'rendering-square'

    await runOptimisticRenderRequest({
      optimisticStatus: 'render-queued-square',
      enqueue: async () => ({ ok: true }),
      refresh: async () => {
        authoritative = 'ready'
        return [{ status: authoritative }]
      },
      setOverride: (status) => {
        override = status
      },
    })

    expect(override ?? authoritative).toBe('ready')
  })

  it('retires the optimistic status when the snapshot request does not settle', async () => {
    const statuses: Array<string | null> = []

    const request = runOptimisticRenderRequest({
      optimisticStatus: 'render-queued-landscape',
      enqueue: async () => ({ ok: true }),
      refresh: () => new Promise(() => undefined),
      setOverride: (status) => statuses.push(status),
      timeoutMs: 10,
    })

    const result = await request

    expect(result.reconciliation).toBe('timed-out')
    expect(statuses).toEqual(['render-queued-landscape', null])
  })

  it('retires the optimistic status when enqueue does not settle', async () => {
    const statuses: Array<string | null> = []

    const result = await runOptimisticRenderRequest({
      optimisticStatus: 'render-queued-landscape',
      enqueue: () => new Promise(() => undefined),
      refresh: async () => [],
      setOverride: (status) => statuses.push(status),
      enqueueTimeoutMs: 10,
    })

    expect(result).toEqual({
      ok: false,
      error: 'Render enqueue timed out after 10ms',
      reconciliation: 'not-needed',
    })
    expect(statuses).toEqual(['render-queued-landscape', null])
  })
})
