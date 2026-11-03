import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { placeChainGeneration } from '../../server/src/chain-generation.js'

describe('chain generation placement', () => {
  let rootDir: string | undefined
  let manager: BookManager | undefined

  afterEach(async () => {
    await manager?.close()
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  it('keeps the requested mode and settings on the placed producer cell', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-chain-placement-'))
    manager = new BookManager({ libraryDir: join(rootDir, 'books') })
    const book = await manager.create('chain-placement')
    if (!book.ok) throw new Error(book.error.message)
    const managed = manager.get(book.value.bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    const { engine } = managed.value
    const notebook = engine.notebooks.list()[0]!
    const artifact = await engine.artifacts.create('video', 'Chained clip')
    if (!artifact.ok) throw new Error(artifact.error.message)
    const placed = await placeChainGeneration({
      engine,
      notebookId: notebook.id,
      tool: 'generate_video',
      placement: 'generate_video',
      params: { prompt: 'Drift upward', model: 'kie:bytedance/seedance-2-5', mode: 'r2v', options: { duration: 6 } },
      artifactId: artifact.value.artifactId,
      runId: '019f0000-0000-7000-8000-000000000071',
      pins: [],
    })
    const document = engine.notebooks.read(notebook.id)
    if (!document.ok) throw new Error(document.error.message)
    const producer = document.value.cells.find((cell) => cell.id === placed.producerCellId)
    expect(producer?.inputs).toMatchObject({ generationMode: 'r2v', generationSettings: { duration: 6 } })
  })
})
