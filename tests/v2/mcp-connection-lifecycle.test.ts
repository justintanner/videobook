import { describe, expect, it } from 'vitest'
import {
  createMcpConnectionLifecycle,
  type McpConnectionLifecycleSnapshot,
} from '../../src/videobook/mcp-connection-lifecycle'

type FakeClient = {
  closeCalls: number
  id: string
  onclose?: () => void
  close: () => Promise<void>
}

function fakeClient(id: string): FakeClient {
  const client: FakeClient = {
    id,
    closeCalls: 0,
    close: async () => {
      client.closeCalls += 1
    },
  }
  return client
}

function fakeClock() {
  let nextId = 1
  const callbacks = new Map<number, () => void>()
  return {
    cancel: (id: number) => callbacks.delete(id),
    pending: () => callbacks.size,
    runNext: () => {
      const next = callbacks.entries().next().value as [number, () => void] | undefined
      if (!next) throw new Error('No timer is pending')
      callbacks.delete(next[0])
      next[1]()
    },
    schedule: (callback: () => void) => {
      const id = nextId
      nextId += 1
      callbacks.set(id, callback)
      return id
    },
  }
}

function deferred<Value>() {
  let resolvePromise: (value: Value) => void = () => undefined
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('MCP connection lifecycle', () => {
  it('retries an initial connection failure and becomes ready', async () => {
    const clock = fakeClock()
    const connected = fakeClient('connected')
    const snapshots: McpConnectionLifecycleSnapshot[] = []
    let attempts = 0
    const lifecycle = createMcpConnectionLifecycle({
      connect: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('offline')
        return connected
      },
      callTool: async () => 'ok',
      reconnectDelayMs: 25,
      scheduleTimer: clock.schedule,
      cancelTimer: clock.cancel,
      onStateChange: (snapshot) => snapshots.push(snapshot),
    })

    lifecycle.start()
    await settle()
    expect(snapshots.at(-1)).toMatchObject({ state: 'failed' })
    expect(clock.pending()).toBe(1)

    clock.runNext()
    await settle()
    expect(attempts).toBe(2)
    expect(snapshots.at(-1)).toEqual({ state: 'ready', error: null })
  })

  it('recovers when a ready client reports that it closed', async () => {
    const clock = fakeClock()
    const first = fakeClient('first')
    const second = fakeClient('second')
    const clients = [first, second]
    const snapshots: McpConnectionLifecycleSnapshot[] = []
    const lifecycle = createMcpConnectionLifecycle({
      connect: async () => clients.shift()!,
      callTool: async (client) => client.id,
      reconnectDelayMs: 25,
      scheduleTimer: clock.schedule,
      cancelTimer: clock.cancel,
      onStateChange: (snapshot) => snapshots.push(snapshot),
    })

    lifecycle.start()
    await settle()
    first.onclose?.()
    expect(snapshots.at(-1)).toMatchObject({ state: 'failed' })
    expect(clock.pending()).toBe(1)

    clock.runNext()
    await settle()
    expect(snapshots.at(-1)).toEqual({ state: 'ready', error: null })
    await expect(lifecycle.callTool('status', {})).resolves.toBe('second')
  })

  it('closes a failed client and recovers after a tool-call failure', async () => {
    const clock = fakeClock()
    const first = fakeClient('first')
    const second = fakeClient('second')
    const clients = [first, second]
    const snapshots: McpConnectionLifecycleSnapshot[] = []
    const lifecycle = createMcpConnectionLifecycle({
      connect: async () => clients.shift()!,
      callTool: async (client) => {
        if (client === first) throw new Error('connection lost')
        return client.id
      },
      reconnectDelayMs: 25,
      scheduleTimer: clock.schedule,
      cancelTimer: clock.cancel,
      onStateChange: (snapshot) => snapshots.push(snapshot),
    })

    lifecycle.start()
    await settle()
    await expect(lifecycle.callTool('status', {})).rejects.toThrow('connection lost')
    await settle()
    expect(first.closeCalls).toBe(1)
    expect(snapshots.at(-1)).toMatchObject({ state: 'failed' })

    clock.runNext()
    await settle()
    await expect(lifecycle.callTool('status', {})).resolves.toBe('second')
  })

  it('cancels a pending retry when stopped', async () => {
    const clock = fakeClock()
    let attempts = 0
    const lifecycle = createMcpConnectionLifecycle({
      connect: async () => {
        attempts += 1
        throw new Error('offline')
      },
      callTool: async () => 'ok',
      reconnectDelayMs: 25,
      scheduleTimer: clock.schedule,
      cancelTimer: clock.cancel,
      onStateChange: () => undefined,
    })

    lifecycle.start()
    await settle()
    expect(clock.pending()).toBe(1)

    lifecycle.stop()
    expect(clock.pending()).toBe(0)
    expect(attempts).toBe(1)
  })

  it('closes the ready client without reconnecting when stopped', async () => {
    const clock = fakeClock()
    const connected = fakeClient('connected')
    const snapshots: McpConnectionLifecycleSnapshot[] = []
    const lifecycle = createMcpConnectionLifecycle({
      connect: async () => connected,
      callTool: async () => 'ok',
      reconnectDelayMs: 25,
      scheduleTimer: clock.schedule,
      cancelTimer: clock.cancel,
      onStateChange: (snapshot) => snapshots.push(snapshot),
    })

    lifecycle.start()
    await settle()
    lifecycle.stop()
    await settle()

    expect(connected.closeCalls).toBe(1)
    expect(clock.pending()).toBe(0)
    expect(snapshots.at(-1)).toEqual({ state: 'ready', error: null })
  })

  it('closes a superseded connection without disturbing the current client', async () => {
    const clock = fakeClock()
    const firstAttempt = deferred<FakeClient>()
    const secondAttempt = deferred<FakeClient>()
    const attempts = [firstAttempt, secondAttempt]
    const stale = fakeClient('stale')
    const current = fakeClient('current')
    const lifecycle = createMcpConnectionLifecycle({
      connect: () => attempts.shift()!.promise,
      callTool: async (client) => client.id,
      reconnectDelayMs: 25,
      scheduleTimer: clock.schedule,
      cancelTimer: clock.cancel,
      onStateChange: () => undefined,
    })

    lifecycle.start()
    lifecycle.stop()
    lifecycle.start()
    secondAttempt.resolve(current)
    await settle()
    firstAttempt.resolve(stale)
    await settle()

    expect(stale.closeCalls).toBe(1)
    expect(current.closeCalls).toBe(0)
    await expect(lifecycle.callTool('status', {})).resolves.toBe('current')
  })
})
