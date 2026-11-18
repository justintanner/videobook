import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import type { GraphicsDocument } from '../../server/src/graphics/model.js'
import { createEngineForTest } from '../../server/src/engine.js'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { registerMediaProbe } from '../../server/src/notebook-media-ops.js'
import { createTestClient } from '../../server/src/test-client.js'
import { testBudget } from '../../server/src/test-budget.js'
import { createGraphicsDraftKeeper, graphicsTargetArgs } from '../../src/videobook/graphics-drafts'
import { parseGraphicsRead, type GraphicsTarget } from '../../src/videobook/graphics-model'

function target(artifactId: string, label: string): GraphicsTarget {
  return { artifactId, kind: 'video', label, mediaUrl: '', address: null, notebookId: null, image: null, text: null, watermark: null }
}

function withHeadline(document: GraphicsDocument, text: string): GraphicsDocument {
  return {
    ...document,
    layers: document.layers.map((layer) => layer.kind !== 'text' ? layer : {
      ...layer,
      items: layer.items.map((item) => item.slot === 'headline' ? { ...item, text } : item),
    }),
  }
}

function headline(document: GraphicsDocument): string | undefined {
  return document.layers.flatMap((layer) => layer.kind === 'text' ? layer.items : []).find((item) => item.slot === 'headline')?.text
}

it('saves a switched-away draft to its own video and keeps a conflicted or failed draft for recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'videobook-graphics-drafts-'))
  const client = await createTestClient(root)
  try {
    const engine = createEngineForTest(root)
    const bookId = engine.book.get().bookId
    const path = join(root, 'fixture.mp4')
    await promisify(execFile)(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=c=gray:s=72x128:r=24:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', path], { timeout: testBudget(30_000) })
    const ids: string[] = []
    for (const label of ['First take', 'Second take']) {
      const video = await engine.artifacts.create('video', label)
      if (!video.ok) throw new Error(video.error.message)
      const written = await engine.files.write(video.value.artifactId, 'original.mp4', await readFile(path))
      if (!written.ok) throw new Error(written.error.message)
      await registerMediaProbe(engine, video.value.artifactId, 'original.mp4', await probeVideo(path))
      ids.push(video.value.artifactId)
    }
    const [first, second] = ids as [string, string]
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const response = await client.callTool({ name, arguments: args })
      const text = (response.content as Array<{ text: string }>)[0]!.text
      if (response.isError) throw new Error(text)
      return JSON.parse(text) as unknown
    }
    const firstArgs = graphicsTargetArgs(bookId, target(first, 'First take'))
    const secondArgs = graphicsTargetArgs(bookId, target(second, 'Second take'))
    const read = async (args: Record<string, unknown>) => parseGraphicsRead(await call('video_graphics', args))
    const keeper = createGraphicsDraftKeeper()

    const opened = await read(firstArgs)
    void keeper.keep(call, firstArgs, async () => ({ document: withHeadline(opened.document, 'Final first-take headline'), frame: opened.frame, revision: opened.revision }))
    await keeper.settled(firstArgs)
    const saved = await read(firstArgs)
    expect(headline(saved.document)).toBe('Final first-take headline')
    expect(saved.revision).not.toBe(opened.revision)
    expect(headline((await read(secondArgs)).document)).toBe('')
    expect(keeper.take(firstArgs)).toBeNull()

    await keeper.keep(call, firstArgs, async () => ({ document: withHeadline(opened.document, 'Edited on a stale copy'), frame: opened.frame, revision: opened.revision }))
    expect(keeper.take(firstArgs)).toMatchObject({
      save: 'conflict', revision: opened.revision, conflictRevision: saved.revision,
      document: withHeadline(opened.document, 'Edited on a stale copy'),
    })
    expect(headline((await read(firstArgs)).document)).toBe('Final first-take headline')
    expect(keeper.take(firstArgs)).toBeNull()

    const destination = await read(secondArgs)
    const broken = { ...destination.document, layers: [{ kind: 'unknown-layer' }] } as unknown as GraphicsDocument
    await keeper.keep(call, secondArgs, async () => ({ document: broken, frame: destination.frame, revision: destination.revision }))
    expect(keeper.take(secondArgs)).toMatchObject({ save: 'error', saveError: expect.any(String), conflictRevision: null, document: broken })
    expect((await read(secondArgs)).revision).toBe(destination.revision)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}, testBudget(60_000))
