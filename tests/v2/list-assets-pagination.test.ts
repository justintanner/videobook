import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine } from 'videobook-engine'
import { listAssetsDef } from '../../server/src/tools/list-assets.js'

describe('bounded asset listing', () => {
  let rootDir: string | undefined

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true })
  })

  it('returns page metadata and never sends the full catalog by default', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-asset-page-'))
    const engine = createEngine({ rootDir, initialBookName: 'asset-page' })
    await engine.ready
    for (const label of ['one', 'two', 'three', 'four']) {
      const artifact = await engine.artifacts.create('image', label)
      expect(artifact.ok).toBe(true)
      if (!artifact.ok) return
      expect((await engine.files.write(
        artifact.value.artifactId,
        'original.png',
        Buffer.from(label),
      )).ok).toBe(true)
    }
    const result = await listAssetsDef(engine).handler({
      book_id: engine.book.get().bookId,
      sort: 'newest',
      limit: 2,
      offset: 1,
    })
    expect(result.isError, result.content[0]?.text).toBeUndefined()
    const payload = JSON.parse(result.content[0]!.text) as {
      assets: unknown[]
      page: {
        offset: number
        limit: number
        total: number
        hasMore: boolean
      }
    }
    expect(payload.assets).toHaveLength(2)
    expect(payload.page).toMatchObject({
      offset: 1,
      limit: 2,
      hasMore: true,
    })
    expect(payload.page.total).toBeGreaterThan(payload.assets.length)
    engine.close()
  })
})
