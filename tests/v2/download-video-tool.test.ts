import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from 'videobook-engine'
import {
  queue,
  registerJobHandler,
  setEngineRoot,
} from '../../server/src/queue.js'
import { downloadVideoDef } from '../../server/src/tools/download-video.js'

describe('download video tool response', () => {
  let rootDir: string
  let engine: Engine

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-download-tool-'))
    engine = createEngine({
      rootDir,
      initialBookSlug: 'download-tool',
    })
    await engine.ready
    await setEngineRoot(rootDir, engine)
    registerJobHandler('download_video', async () => ({ ok: true }))
  })

  afterEach(async () => {
    await queue.stop()
    engine.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  it('returns the artifact UUID needed to attach the queued asset to a cell', async () => {
    const result = await downloadVideoDef(engine).handler({
      url: 'https://example.com/video',
      book_id: engine.book.get().bookId,
    })

    expect(result.isError, result.content[0]?.text).toBeUndefined()
    const value = JSON.parse(result.content[0]!.text) as {
      artifact_id: string
      assetId: string
      job_id: string
      status: string
    }
    expect(value.artifact_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(value.assetId).toMatch(/^vid-/)
    expect(value.job_id).toMatch(/^download-/)
    expect(value.status).toBe('enqueued')
    expect(engine.artifacts.get(value.artifact_id)).toMatchObject({
      ok: true,
      value: { slug: value.assetId },
    })
  })
})
