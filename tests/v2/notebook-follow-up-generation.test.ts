import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Engine } from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import { PROVIDER_ENV_KEYS } from '../../server/src/media/adapters/index.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import { generationPayloadDef } from '../../server/src/tools/generation-payload.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'
import { asNotebookGenerationActions } from '../../src/videobook/notebook-generation-actions'
import {
  notebookFollowUpModels,
  planNotebookFollowUp,
  readNotebookFollowUpSourceTask,
  type NotebookFollowUp,
} from '../../src/videobook/notebook-follow-up-generation'
import type { NotebookChatGenerationDraft } from '../../src/videobook/notebook-chat-generation'

const PROVIDERS = ['fal', 'kie', 'machgen'] as const
const GEMINI_OMNI = 'kie:google/gemini-omni-flash-1-2'
const GEMINI_EXTEND = 'kie:google/gemini-omni-flash-1-2-extend'

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
    const definitions = [...videobookDomainDefs(scopedBookEngine, books), generationPayloadDef(engine)]
    const byName = new Map(definitions.map((definition) => [definition.name, definition]))
    const call = async (name: string, args: Record<string, unknown>) => {
      const definition = byName.get(name)
      if (!definition) throw new Error(`Missing ${name}`)
      return await withBookContext({ bookId, engine }, () => definition.handler({ book_id: bookId, ...args }))
    }
    const invoke = async (name: string, args: Record<string, unknown>) => resultJson(await call(name, args))
    const mediaCell = async (
      kind: 'video' | 'image',
      column: number,
      cell: Record<string, unknown>,
      metadata: Record<string, unknown> = {},
    ) => {
      const artifact = await engine.artifacts.create(kind, `${kind} source`)
      if (!artifact.ok) throw new Error(artifact.error.message)
      const written = await engine.files.write(artifact.value.artifactId, kind === 'video' ? 'original.mp4' : 'original.png', Buffer.from(kind))
      if (!written.ok) throw new Error(written.error.message)
      for (const [key, value] of Object.entries(metadata)) {
        const stored = await engine.metadata.artifacts.write(artifact.value.artifactId, key, value)
        if (!stored.ok) throw new Error(stored.error.message)
      }
      return await invoke('create_notebook_cell', {
        notebook_id: notebookId,
        cell: { slot: { row: 0, column }, output_artifact_id: artifact.value.artifactId, ...cell },
      }) as { id: string }
    }
    const document = () => {
      const read = engine.notebooks.read(notebookId)
      if (!read.ok) throw new Error(read.error.message)
      return read.value
    }
    const plan = async (followUp: NotebookFollowUp, sourceCellId: string, sourceTaskId?: string | null) => {
      const actions = asNotebookGenerationActions(await invoke('list_notebook_actions', { cell_type: 'generate_video' }))
      return planNotebookFollowUp({
        actions,
        cellId: '01900000-0000-7000-8000-0000000000f1',
        document: document(),
        followUp,
        sourceCellId,
        ...(sourceTaskId !== undefined ? { sourceTaskId } : {}),
      })
    }
    const sourceTask = async (followUp: NotebookFollowUp, sourceCellId: string) => await readNotebookFollowUpSourceTask({
      bookId,
      callTool: invoke,
      document: document(),
      followUp,
      sourceCellId,
    })
    const planFollowUp = async (followUp: NotebookFollowUp, sourceCellId: string) =>
      await plan(followUp, sourceCellId, await sourceTask(followUp, sourceCellId))
    const preview = async (draft: NotebookChatGenerationDraft, prompt: string) => await call('preview_notebook_generation', {
      notebook_id: notebookId,
      cell_id: draft.cell.id,
      draft: {
        type: draft.cell.type,
        slot: draft.cell.slot,
        prompt,
        provider: draft.cell.provider,
        model: draft.cell.model,
        operation: draft.cell.operation,
        tool: draft.cell.tool,
        inputs: draft.cell.inputs,
      },
    })
    const actions = async () => asNotebookGenerationActions(await invoke('list_notebook_actions', { cell_type: 'generate_video' }))
    return { mediaCell, plan, planFollowUp, sourceTask, preview, actions }
  }

  function omniCell(model: string, taskId: string | null, input: Record<string, unknown>, original?: Record<string, unknown>) {
    return {
      cell: { type: 'generate_video', provider: 'kie', model, tool: 'generate_video', operation: model === GEMINI_EXTEND ? 'extend_video' : 'text_to_video', prompt: 'a fox' },
      metadata: {
        ...(taskId ? { 'kie-task-id': { taskId } } : {}),
        'generation-payload': { model: model.slice('kie:'.length), input: { prompt: 'a fox', ...input } },
        ...(original ? { original } : {}),
      },
    }
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
    expect((await book.plan('upscale_video', video.id))?.action.model).toBe('fal:topaz/upscale/video/precision')
    const seedance = await book.mediaCell('video', 4, { type: 'video', provider: 'machgen', model: 'machgen:Seedance-2.5' })
    expect((await book.plan('upscale_video', seedance.id))?.action.model).toBe('machgen:Topaz-Video-Precision')
    delete process.env[PROVIDER_ENV_KEYS.machgen]
    expect((await book.plan('upscale_video', video.id))?.action.model).toBe('fal:topaz/upscale/video/precision')
  })

  it('offers every upscale model the catalog lists, with configured providers first', async () => {
    const book = await openBook()
    delete process.env[PROVIDER_ENV_KEYS.kie]
    const models = notebookFollowUpModels(await book.actions(), 'upscale_video', undefined)
    expect(models.slice(0, 2)).toEqual(['fal:topaz/upscale/video/precision', 'machgen:Topaz-Video-Precision'])
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

  it('extends a 360p or 720p KIE Gemini Omni 1.2 Flash cell natively with its Kie task id and a priced estimate', async () => {
    const book = await openBook()
    const source = omniCell(GEMINI_OMNI, 'kie-omni-1', { resolution: '720p', duration: 8 })
    const omni = await book.mediaCell('video', 0, source.cell, source.metadata)
    expect((await book.plan('extend_video', omni.id))?.action.model).toBe(GEMINI_EXTEND)
    expect(await book.sourceTask('extend_video', omni.id)).toBe('kie-omni-1')
    expect(await book.sourceTask('upscale_video', omni.id)).toBeUndefined()
    const draft = await book.planFollowUp('extend_video', omni.id)
    expect(draft?.action.model).toBe(GEMINI_EXTEND)
    expect(draft?.cell).toMatchObject({
      type: 'generate_video',
      provider: 'kie',
      model: GEMINI_EXTEND,
      operation: 'extend_video',
      inputs: { generationSettings: { task_id: 'kie-omni-1' } },
    })
    expect(draft?.connections).toEqual([])
    const previewed = resultJson(await book.preview(draft!, 'the fox runs on')) as {
      payload: { model: string; input: Record<string, unknown> }
      estimate: { usd: number; warnings: string[] }
    }
    expect(previewed.payload).toMatchObject({ model: 'google/gemini-omni-flash-1-2-extend', input: { task_id: 'kie-omni-1', prompt: 'the fox runs on' } })
    expect(previewed.estimate.usd).toBeGreaterThan(0)
    expect(previewed.estimate.warnings).toEqual([])

    const extended = omniCell(GEMINI_EXTEND, 'kie-omni-2', { task_id: 'kie-omni-1', duration: 5 }, { duration: 13.02 })
    const again = await book.mediaCell('video', 2, extended.cell, {
      ...extended.metadata,
      'generation-cost-hints': { inputResolution: '720p' },
    })
    const next = await book.planFollowUp('extend_video', again.id)
    expect(next?.cell).toMatchObject({ model: GEMINI_EXTEND, inputs: { generationSettings: { task_id: 'kie-omni-2' } } })
    expect((resultJson(await book.preview(next!, 'and jumps')) as { estimate: { usd: number } }).estimate.usd).toBeGreaterThan(0)
  })

  it('refuses a 1080p, 4k or over-15 s Gemini Omni source before any Kie work', async () => {
    const book = await openBook()
    const sources = [
      { column: 0, taskId: 'kie-omni-1080', input: { resolution: '1080p', duration: 8 }, refusal: 'kie-omni-1080 is 1080p' },
      { column: 2, taskId: 'kie-omni-4k', input: { resolution: '4k', duration: 8 }, refusal: 'kie-omni-4k is 4k' },
      { column: 4, taskId: 'kie-omni-long', input: { resolution: '360p' }, original: { duration: 16.1 }, refusal: 'kie-omni-long is 16 s long' },
    ]
    for (const entry of sources) {
      const source = omniCell(GEMINI_OMNI, entry.taskId, entry.input, entry.original)
      const cell = await book.mediaCell('video', entry.column, source.cell, source.metadata)
      const draft = await book.planFollowUp('extend_video', cell.id)
      expect(draft?.cell).toMatchObject({ model: GEMINI_EXTEND, inputs: { generationSettings: { task_id: entry.taskId } } })
      const refused = await book.preview(draft!, 'the fox runs on')
      expect(refused.isError).toBe(true)
      expect(refused.content[0]!.text).toContain(entry.refusal)
    }
  })

  it('extends an Omni cell with no Kie task through a model that takes its video', async () => {
    const book = await openBook()
    const source = omniCell(GEMINI_OMNI, null, { resolution: '720p', duration: 8 })
    const omni = await book.mediaCell('video', 0, source.cell, source.metadata)
    expect(await book.sourceTask('extend_video', omni.id)).toBeNull()
    const draft = await book.planFollowUp('extend_video', omni.id)
    expect(draft?.action.model).toBe('fal:minimax/h3-max-turbo/extend-video')
    expect(draft?.connections).toEqual([{ sourceCellId: omni.id, targetInput: 'video' }])
  })

  it('offers no extend or upscale for an image cell', async () => {
    const book = await openBook()
    const image = await book.mediaCell('image', 0, { type: 'image', label: 'Still' })
    expect(await book.plan('extend_video', image.id)).toBeNull()
    expect(await book.plan('upscale_video', image.id)).toBeNull()
  })
})
