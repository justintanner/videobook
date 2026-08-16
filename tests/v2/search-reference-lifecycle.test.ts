import { describe, expect, it } from 'vitest'
import {
  prepareExistingSearchReference,
  type SearchReferenceDescriptor,
} from '../../src/videobook/search-reference'
import {
  createSearchReferenceLifecycle,
  type SearchReferenceLifecycleState,
} from '../../src/videobook/search-reference-lifecycle'

function reference(
  referenceId: string,
  kind: 'image' | 'video' = 'image',
): SearchReferenceDescriptor {
  return {
    referenceId,
    kind,
    name: `${referenceId}.${kind === 'image' ? 'png' : 'mp4'}`,
    expiresAt: 10_000,
    previewUrl: `blob:${referenceId}`,
    localPreview: true,
  }
}

function deferred<Value>() {
  let resolvePromise: (value: Value) => void = () => undefined
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function lifecycleHarness() {
  const released: SearchReferenceDescriptor[] = []
  const states: SearchReferenceLifecycleState[] = []
  const lifecycle = createSearchReferenceLifecycle({
    onStateChange: (state) => states.push(state),
    release: (value) => {
      released.push(value)
    },
  })
  return { lifecycle, released, states }
}

describe('search reference lifecycle', () => {
  it('releases each local preview when references are replaced and cleared', async () => {
    const { lifecycle, released } = lifecycleHarness()
    const first = reference('first')
    const second = reference('second')

    await lifecycle.prepare('image-reverse', async () => first)
    await lifecycle.prepare('image-reverse', async () => second)
    lifecycle.clearReference()

    expect(released.map((value) => value.previewUrl)).toEqual([
      'blob:first',
      'blob:second',
    ])
    expect(lifecycle.getState().reference).toBeNull()
  })

  it('releases a stale completion without replacing the current mode', async () => {
    const { lifecycle, released } = lifecycleHarness()
    const pending = deferred<SearchReferenceDescriptor>()
    const preparation = lifecycle.prepare('video-reverse', () => pending.promise)

    lifecycle.changeMode('text')
    pending.resolve(reference('stale', 'video'))

    await expect(preparation).resolves.toEqual({ status: 'stale' })
    expect(lifecycle.getState()).toMatchObject({
      mode: 'text',
      reference: null,
      preparing: false,
    })
    expect(released.map((value) => value.referenceId)).toEqual(['stale'])
  })

  it.each([
    'text',
    'image-reverse',
    'video-reverse',
  ] as const)('resets ownership and range when switching to %s', async (mode) => {
    const { lifecycle, released } = lifecycleHarness()
    const current = reference('current', 'video')
    await lifecycle.prepare('video-reverse', async () => current)
    lifecycle.setStartSeconds('3')
    lifecycle.setDurationSeconds('4')
    lifecycle.changeMode(mode)

    expect(lifecycle.getState()).toEqual({
      mode,
      reference: null,
      startSeconds: '0',
      durationSeconds: '',
      preparing: false,
      error: null,
    })
    expect(released).toEqual([current])
  })

  it('resets invalid range values and preserves the validation error', () => {
    const { lifecycle } = lifecycleHarness()
    lifecycle.changeMode('video-reverse')
    lifecycle.setStartSeconds('-2')
    lifecycle.setDurationSeconds('invalid')

    expect(lifecycle.resetInvalidRange(
      new Error('Reference start must be a non-negative number'),
    )).toBe('Reference start must be a non-negative number')
    expect(lifecycle.getState()).toMatchObject({
      startSeconds: '0',
      durationSeconds: '',
      error: 'Reference start must be a non-negative number',
    })
  })

  it('cleans up the owner and suppresses its pending preparation', async () => {
    const { lifecycle, released } = lifecycleHarness()
    const current = reference('current')
    await lifecycle.prepare('image-reverse', async () => current)
    const pending = deferred<SearchReferenceDescriptor>()
    const preparation = lifecycle.prepare('image-reverse', () => pending.promise)

    lifecycle.close()
    pending.resolve(reference('after-close'))

    await expect(preparation).resolves.toEqual({ status: 'stale' })
    expect(lifecycle.getState()).toEqual({
      mode: 'text',
      reference: null,
      startSeconds: '0',
      durationSeconds: '',
      preparing: false,
      error: null,
    })
    expect(released.map((value) => value.referenceId)).toEqual([
      'current',
      'after-close',
    ])
  })

  it('tracks preparation loading and errors', async () => {
    const { lifecycle, states } = lifecycleHarness()
    const pending = deferred<SearchReferenceDescriptor>()
    const preparation = lifecycle.prepare('image-reverse', () => pending.promise)

    expect(states.at(-1)).toMatchObject({ preparing: true, error: null })
    pending.resolve(reference('ready'))
    await preparation
    expect(states.at(-1)).toMatchObject({ preparing: false, error: null })

    await expect(lifecycle.prepare('image-reverse', async () => {
      throw new Error('upload failed')
    })).resolves.toEqual({ status: 'error', error: 'upload failed' })
    expect(states.at(-1)).toMatchObject({
      preparing: false,
      error: 'upload failed',
    })
  })

  it('prepares an existing reference through the shared client contract', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    const prepared = await prepareExistingSearchReference(
      async (tool, args) => {
        calls.push({ tool, args })
        return {
          reference_id: 'existing',
          kind: 'video',
          name: 'source.mp4',
          duration_ms: 8_000,
          expires_at: 10_000,
        }
      },
      {
        sourceBookId: 'book-a',
        sourceArtifactId: 'artifact-a',
        mode: 'video-reverse',
        previewUrl: '/media/source.mp4',
        sourceRange: { startSeconds: 2, durationSeconds: 3 },
      },
    )

    expect(calls).toEqual([{
      tool: 'prepare_search_reference',
      args: {
        source_book_id: 'book-a',
        source_artifact_id: 'artifact-a',
        kind: 'video',
        source_start_seconds: 2,
        source_duration_seconds: 3,
      },
    }])
    expect(prepared).toMatchObject({
      referenceId: 'existing',
      previewUrl: '/media/source.mp4',
    })
  })
})
