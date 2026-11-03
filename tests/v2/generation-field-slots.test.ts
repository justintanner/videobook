import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Engine, NotebookCell } from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import { MODEL_ENTRIES } from '../../server/src/media/catalog.js'
import { resolveEntry, resolveModel } from '../../server/src/media/descriptor.js'
import { previewGeneration } from '../../server/src/media/preview.js'
import { controlsForModel } from '../../server/src/notebook-generation-controls.js'
import { notebookGenerationInputContract } from '../../server/src/notebook-generation-contract.js'
import { mediaGenerationArgs } from '../../server/src/jobs/run-notebook.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'
import { slotLayout, slotSourceKinds } from '../../src/videobook/generation-slot-layout.js'

const INVENTORY = [
  'fal:bria/fibo-2/edit slot:mask_url image 1',
  'fal:fal-ai/gpt-image-1.5/edit slot:mask_image_url image 1',
  'fal:ideogram/v4.5/edit slot:mask_url image 1',
  'fal:minimax/h3-max-turbo/image-to-video slot:target_audio_url audio 1',
  'fal:minimax/h3-max-turbo/text-to-video slot:target_audio_url audio 1',
  'fal:minimax/h3-max/image-to-video slot:target_audio_url audio 1',
  'fal:minimax/h3-max/reference-to-video slot:middle_image_url image 1',
  'fal:minimax/h3-max/text-to-video slot:target_audio_url audio 1',
  'fal:minimax/h3/image-to-video/lora slot:target_audio_url audio 1',
  'fal:minimax/h3/text-to-video/lora slot:target_audio_url audio 1',
  'fal:openai/gpt-image-2/edit slot:mask_url image 1',
  'kie:omnihuman-1-5 slot:mask_url image 5',
  'kie:qwen2-1/image-to-image slot:mask_url image 1',
]

describe('field slots for request fields without a role', () => {
  it('turns exactly the reviewed media fields into upload slots', () => {
    const inventory = MODEL_ENTRIES.flatMap((entry) => resolveEntry(entry).fieldSlots
      .map((slot) => `${entry.id} ${slot.target} ${slot.kind} ${slot.max}`)).sort()
    expect(inventory).toEqual(INVENTORY)
  })

  it('offers the slot in every mode, keeps the literal option hidden and places uploads at the field', () => {
    const model = resolveModel('fal:openai/gpt-image-2/edit')
    for (const mode of notebookGenerationInputContract(model).modes) {
      expect(mode.inputs.find((input) => input.target === 'slot:mask_url')).toMatchObject({ label: 'Mask', kind: 'image', token: null })
      expect(mode.slots.find((slot) => slot.field === 'slot:mask_url')?.targets).toEqual(['slot:mask_url'])
    }
    expect(controlsForModel(model).find((control) => control.name === 'mask_url')?.hidden).toBe(true)
    const preview = previewGeneration({ model: model.id, prompt: 'Swap the sky', refs: { image: ['art-photo'] }, field_refs: { mask_url: ['art-mask'] } })
    if (!preview.ok) throw new Error(preview.error)
    expect((preview.preview.payload as { input: { mask_url: string } }).input.mask_url).toBe('http://url.resolved.later.for/art-mask')
    const unknown = previewGeneration({ model: model.id, prompt: 'Swap the sky', refs: { image: ['art-photo'] }, field_refs: { target_audio_url: ['art-voice'] } })
    expect(unknown.ok ? null : unknown.error).toContain('has no target_audio_url input')
  })
})

describe('field slots in notebooks', () => {
  let rootDir: string | undefined
  let books: BookManager | undefined

  afterEach(async () => {
    await books?.close()
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  it('connects a cell to a field slot, sends it as field_refs and shows it in its slot', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-field-slots-'))
    books = new BookManager({ libraryDir: join(rootDir, 'books'), objectPrefix: 'test-objects' })
    await books.ready()
    const byName = new Map(videobookDomainDefs(scopedBookEngine, books).map((def) => [def.name, def] as [string, ToolDef]))
    const bookId = (JSON.parse((await byName.get('create_book')!.handler({ name: 'field-slots' })).content[0]!.text) as { bookId: string }).bookId
    const managed = books.get(bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    const engine: Engine = managed.value.engine
    const notebookId = engine.notebooks.list()[0]!.id
    const call = async (name: string, args: Record<string, unknown>) => withBookContext({ bookId, engine },
      () => byName.get(name)!.handler({ book_id: bookId, notebook_id: notebookId, ...args }))
    const json = async <T,>(name: string, args: Record<string, unknown>) => {
      const result = await call(name, args)
      expect(result.isError, result.content[0]?.text).toBeUndefined()
      return JSON.parse(result.content[0]!.text) as T
    }
    const media = async (kind: 'image' | 'audio', column: number) => {
      const artifact = await engine.artifacts.create(kind, `${kind} ${column}`)
      if (!artifact.ok) throw new Error(artifact.error.message)
      const cell = await json<NotebookCell>('create_notebook_cell', { cell: { type: kind, slot: { row: 0, column }, output_artifact_id: artifact.value.artifactId } })
      return { id: cell.id, artifactId: artifact.value.artifactId }
    }
    const photo = await media('image', 0)
    const mask = await media('image', 1)
    const voice = await media('audio', 2)
    const edit = await json<NotebookCell>('create_notebook_cell', {
      cell: { type: 'generate_image', slot: { row: 1, column: 0 }, provider: 'fal', model: 'fal:openai/gpt-image-2/edit', operation: 'edit_image', tool: 'generate_image', prompt: 'Swap the sky' },
    })
    await json('set_notebook_cell_inputs', {
      cell_id: edit.id,
      inputs: [{ source_cell_id: photo.id, target_input: 'image' }, { source_cell_id: mask.id, target_input: 'slot:mask_url' }],
    })
    const refused = await call('set_notebook_cell_inputs', { cell_id: edit.id, inputs: [{ source_cell_id: voice.id, target_input: 'slot:mask_url' }] })
    expect(refused.content[0]!.text).toBe('Mask takes images')
    const missing = await call('set_notebook_cell_inputs', { cell_id: edit.id, inputs: [{ source_cell_id: mask.id, target_input: 'slot:target_audio_url' }] })
    expect(missing.content[0]!.text).toContain('has no target_audio_url input')

    const document = engine.notebooks.read(notebookId)
    if (!document.ok) throw new Error(document.error.message)
    const cell = document.value.cells.find((candidate) => candidate.id === edit.id)!
    const { input } = mediaGenerationArgs(resolveModel('fal:openai/gpt-image-2/edit'), document.value, cell, bookId)
    expect(input.field_refs).toEqual({ mask_url: [mask.artifactId] })
    expect(input.refs).toEqual({ image: [photo.artifactId] })

    const mode = notebookGenerationInputContract(resolveModel('fal:openai/gpt-image-2/edit')).modes[0]!
    const layout = slotLayout(
      document.value.edges.filter((edge) => edge.target === edit.id).map((edge) => ({ sourceCellId: edge.source, targetInput: edge.targetInput })),
      { mode, modeId: mode.id, kinds: slotSourceKinds(document.value.cells), settings: {} },
    )
    expect(layout.slots.find((column) => column.spec.target === 'slot:mask_url')?.items.map((item) => item.sourceCellId)).toEqual([mask.id])
    expect(layout.unplaced).toEqual([])
  })
})
