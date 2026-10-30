import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Engine } from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import { PROVIDER_ENV_KEYS } from '../../server/src/media/adapters/index.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'
import { asNotebookGenerationActions } from '../../src/videobook/notebook-generation-actions'
import {
  notebookFollowUpModels,
  planNotebookFollowUp,
  type NotebookFollowUp,
} from '../../src/videobook/notebook-follow-up-generation'

const PROVIDERS = ['fal', 'kie', 'machgen'] as const

function resultJson(result: Awaited<ReturnType<ToolDef['handler']>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined()
  return JSON.parse(result.content[0]!.text) as unknown
}

describe('notebook follow-up generation', () => {
  let rootDir: string
  let books: BookManager
  let saved: Record<string, string | undefined>

  beforeEach(async () => {
    saved = Object.fromEntries(PROVIDERS.map((provider) => [PROVIDER_ENV_KEYS[provider], process.env[PROVIDER_ENV_KEYS[provider]]]))
    for (const provider of PROVIDERS) process.env[PROVIDER_ENV_KEYS[provider]] = `local-${provider}-key`
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-follow-up-'))
    books = new BookManager({ libraryDir: join(rootDir, 'books'), objectPrefix: 'test-objects' })
    await books.ready()
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await books.close()
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  async function openBook() {
    const created = await books.create('follow-up-book')
    if (!created.ok) throw new Error(created.error.message)
    const managed = books.get(created.value.bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    const { bookId } = created.value
    const engine: Engine = managed.value.engine
    const notebookId = engine.notebooks.list()[0]!.id
    const byName = new Map(videobookDomainDefs(scopedBookEngine, books).map((definition) => [definition.name, definition]))
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const definition = byName.get(name)
      if (!definition) throw new Error(`Missing ${name}`)
      return resultJson(await withBookContext({ bookId, engine }, () => definition.handler({ book_id: bookId, ...args })))
    }
    const mediaCell = async (kind: 'video' | 'image', column: number, cell: Record<string, unknown>) => {
      const artifact = await engine.artifacts.create(kind, `${kind} source`)
      if (!artifact.ok) throw new Error(artifact.error.message)
      const written = await engine.files.write(artifact.value.artifactId, kind === 'video' ? 'original.mp4' : 'original.png', Buffer.from(kind))
      if (!written.ok) throw new Error(written.error.message)
      return await invoke('create_notebook_cell', {
        notebook_id: notebookId,
        cell: { slot: { row: 0, column }, output_artifact_id: artifact.value.artifactId, ...cell },
      }) as { id: string }
    }
    const plan = async (followUp: NotebookFollowUp, sourceCellId: string) => {
      const document = engine.notebooks.read(notebookId)
      if (!document.ok) throw new Error(document.error.message)
      const actions = asNotebookGenerationActions(await invoke('list_notebook_actions', { cell_type: 'generate_video' }))
      return planNotebookFollowUp({
        actions,
        cellId: '01900000-0000-7000-8000-0000000000f1',
        document: document.value,
        followUp,
        lastWorkSlot: null,
        sourceCellId,
      })
    }
    const actions = async () => asNotebookGenerationActions(await invoke('list_notebook_actions', { cell_type: 'generate_video' }))
    return { mediaCell, plan, actions }
  }

  it('extends a video cell with the fal H3 Max Turbo extend model connected to its video', async () => {
    const book = await openBook()
    const video = await book.mediaCell('video', 0, { type: 'video', label: 'Clip' })
    const draft = await book.plan('extend_video', video.id)
    expect(draft?.action.model).toBe('fal:minimax/h3-max-turbo/extend-video')
    expect(draft?.cell).toMatchObject({ type: 'generate_video', model: 'fal:minimax/h3-max-turbo/extend-video', operation: 'extend_video' })
    expect(draft?.connections).toEqual([{ sourceCellId: video.id, targetInput: 'video' }])
  })

  it('upscales a MachGen MiniMax H3 cell natively and any other video with Topaz', async () => {
    const book = await openBook()
    const video = await book.mediaCell('video', 0, { type: 'video', label: 'Clip' })
    const h3 = await book.mediaCell('video', 2, {
      type: 'generate_video', provider: 'machgen', model: 'machgen:MiniMax-H3', tool: 'generate_video', operation: 'reference_to_video', prompt: 'a red boat',
    })
    expect((await book.plan('upscale_video', h3.id))?.action.model).toBe('machgen:MiniMax-H3/upscale')
    expect((await book.plan('upscale_video', video.id))?.action.model).toBe('machgen:Topaz-Video-Precision')
    delete process.env[PROVIDER_ENV_KEYS.machgen]
    expect((await book.plan('upscale_video', video.id))?.action.model).toBe('fal:topaz/upscale/video/precision')
  })

  it('offers every upscale model the catalog lists, with configured providers first', async () => {
    const book = await openBook()
    delete process.env[PROVIDER_ENV_KEYS.kie]
    const models = notebookFollowUpModels(await book.actions(), 'upscale_video', undefined)
    expect(models.slice(0, 2)).toEqual(['machgen:Topaz-Video-Precision', 'fal:topaz/upscale/video/precision'])
    expect(models).toEqual(expect.arrayContaining([
      'machgen:MiniMax-H3/upscale',
      'machgen:Topaz-Video-Precision-Animation',
      'machgen:Topaz-Video-Generative',
      'machgen:Topaz-Video-Generative-Fast',
      'fal:blackforestlabs/flux-video-upscale',
      'fal:fal-ai/kandinsky6-vsr',
      'kie:topaz/video-upscale',
    ]))
    expect(models.indexOf('kie:topaz/video-upscale')).toBeGreaterThan(models.indexOf('fal:fal-ai/kandinsky6-vsr'))
  })

  it('offers no extend or upscale for an image cell', async () => {
    const book = await openBook()
    const image = await book.mediaCell('image', 0, { type: 'image', label: 'Still' })
    expect(await book.plan('extend_video', image.id)).toBeNull()
    expect(await book.plan('upscale_video', image.id)).toBeNull()
  })
})
