import { describe, expect, it } from 'vitest'
import { withTimeout } from '@/lib/async-timeout'
import { SyncRequestGate } from '@/hooks/useSync'

describe('SyncRequestGate', () => {
  it('allows a later poll after an unresolved request times out', async () => {
    const gate = new SyncRequestGate()

    expect(gate.start()).toBe(true)
    expect(gate.start()).toBe(false)

    const request = withTimeout(
      new Promise<never>(() => undefined),
      10,
      'Sync request',
    ).finally(() => gate.finish())

    await expect(request).rejects.toThrow('Sync request timed out after 10ms')

    expect(gate.start()).toBe(true)
  })
})
