import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from 'videobook-engine'
import {
  DOWNSTREAM_LEASE_WAIT_MS,
  withLocalLease,
} from '../../server/src/jobs/_lease.js'
import {
  isTransientStorageConflict,
  withTransientStorageRetry,
} from '../../server/src/jobs/_storage-retry.js'
import { registerProcessImageJob } from '../../server/src/jobs/process-image.js'
import {
  queue,
  registerJobHandler,
  setEngineRoot,
} from '../../server/src/queue.js'

describe('processing resilience', () => {
  let rootDir: string | undefined
  let engine: Engine | undefined

  afterEach(async () => {
    await queue.stop()
    engine?.close()
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('retries a transient Dolt branch conflict', async () => {
    let attempts = 0
    const result = await withTransientStorageRetry(async () => {
      attempts += 1
      if (attempts < 3) {
        throw new Error(
          'get: commit conflict: another connection committed to this branch. Please retry your transaction.',
        )
      }
      return 'ready'
    })

    expect(result).toBe('ready')
    expect(attempts).toBe(3)
  })

  it('does not retry a permanent processing error', async () => {
    let attempts = 0
    await expect(withTransientStorageRetry(async () => {
      attempts += 1
      throw new Error('ffprobe found no video stream')
    })).rejects.toThrow('ffprobe found no video stream')
    expect(attempts).toBe(1)
    expect(isTransientStorageConflict('unrelated')).toBe(false)
  })

  it('waits for parent local work before running a downstream job', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-processing-resilience-'))
    engine = createEngine({
      rootDir,
      initialBookName: 'processing-resilience',
    })
    await engine.ready
    await setEngineRoot(rootDir, engine)
    const artifact = await engine.artifacts.create('video', 'lease-order')
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    const bookId = engine.book.get().bookId
    let childRuns = 0

    registerJobHandler('lease_order_child', async (payload, context) =>
      withLocalLease(
        engine!,
        String(payload.assetId),
        context,
        'analyze',
        async () => {
          childRuns += 1
          return { ok: true }
        },
        { waitForActiveMs: DOWNSTREAM_LEASE_WAIT_MS },
      ))
    registerJobHandler('lease_order_parent', async (payload, context) =>
      withLocalLease(
        engine!,
        String(payload.assetId),
        context,
        'process',
        async () => {
          await queue.enqueue('lease-order-child', {
            type: 'lease_order_child',
            bookId,
            assetId: artifact.value.artifactId,
          })
          await new Promise((resolve) => setTimeout(resolve, 100))
          expect(childRuns).toBe(0)
          return { ok: true }
        },
      ))

    const parent = await queue.enqueue('lease-order-parent', {
      type: 'lease_order_parent',
      bookId,
      assetId: artifact.value.artifactId,
    })
    expect(parent.id).toBeGreaterThan(0)

    const startedAt = Date.now()
    while (Date.now() - startedAt < 5_000) {
      if ((await queue.getStatus('lease-order-child'))?.state === 'completed') {
        expect(childRuns).toBe(1)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('downstream job did not complete')
  })

  it('persists every processed image variant', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-processing-image-'))
    engine = createEngine({
      rootDir,
      initialBookName: 'processing-image',
    })
    await engine.ready
    await setEngineRoot(rootDir, engine)
    const artifact = await engine.artifacts.create('image', 'source-image')
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    const original = await engine.files.write(
      artifact.value.artifactId,
      'original.png',
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    )
    expect(original.ok).toBe(true)
    const bookId = engine.book.get().bookId
    registerProcessImageJob(engine)
    await queue.enqueue('process-image-variants', {
      type: 'process_image',
      bookId,
      assetId: artifact.value.artifactId,
      extension: '.png',
      provenance: { source: 'test' },
    })

    const startedAt = Date.now()
    while (Date.now() - startedAt < 5_000) {
      const status = await queue.getStatus('process-image-variants')
      if (status?.state === 'failed') {
        throw new Error(status.error?.message ?? 'image processing failed')
      }
      if (status?.state === 'completed') break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    const manifest = await engine.files.manifest(artifact.value.artifactId)
    expect(manifest.ok).toBe(true)
    if (!manifest.ok) return
    expect(manifest.value.files.map((file) => file.name)).toEqual(
      expect.arrayContaining([
        'landscape.jpg',
        'portrait.jpg',
        'square.jpg',
      ]),
    )
    const metadata = await engine.metadata.artifacts.read<{
      width: number
      height: number
    }>(artifact.value.artifactId, 'original')
    expect(metadata.ok && metadata.value).toMatchObject({
      width: 1,
      height: 1,
    })
  })
})
