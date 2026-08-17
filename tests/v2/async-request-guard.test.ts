import { describe, expect, it } from 'vitest'
import { guardedAsyncResult } from '../../src/videobook/async-request-guard'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('guardedAsyncResult', () => {
  it('discards a response that resolves after its request is invalidated', async () => {
    const pending = deferred<string>()
    let requestId = 1
    const result = guardedAsyncResult(
      async () => await pending.promise,
      () => requestId === 1,
    )

    requestId = 2
    pending.resolve('stale subject map')

    await expect(result).resolves.toEqual({ kind: 'stale' })
  })

  it('discards a rejection that arrives after its request is invalidated', async () => {
    const pending = deferred<string>()
    let requestId = 1
    const result = guardedAsyncResult(
      async () => await pending.promise,
      () => requestId === 1,
    )

    requestId = 2
    pending.reject(new Error('stale failure'))

    await expect(result).resolves.toEqual({ kind: 'stale' })
  })

  it('discards an edit response after its session or workspace changes', async () => {
    const pending = deferred<string>()
    let sessionId = 4
    let workspace = 'book-a:notebook-a'
    const result = guardedAsyncResult(
      async () => await pending.promise,
      () => sessionId === 4 && workspace === 'book-a:notebook-a',
    )

    sessionId = 5
    workspace = 'book-b:notebook-b'
    pending.resolve('old edit accepted')

    await expect(result).resolves.toEqual({ kind: 'stale' })
  })

  it('allows only the latest workspace refresh to apply', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    let requestId = 1
    const firstResult = guardedAsyncResult(
      async () => await first.promise,
      () => requestId === 1,
    )

    requestId = 2
    const secondResult = guardedAsyncResult(
      async () => await second.promise,
      () => requestId === 2,
    )
    second.resolve('book-b')
    first.resolve('book-a')

    await expect(secondResult).resolves.toEqual({
      kind: 'current',
      value: 'book-b',
    })
    await expect(firstResult).resolves.toEqual({ kind: 'stale' })
  })
})
