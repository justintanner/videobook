import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookDocument } from 'videobook-engine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'
import { asNotebookGenerationActions } from '../../src/videobook/notebook-generation-actions'
import {
  parseNotebookImageGenerationCommand,
  resolveNotebookImageGenerationSources,
} from '../../src/videobook/notebook-image-generation-command'
import {
  materializeNotebookChatGeneration,
  notebookChatGenerationConnectedInputs,
  notebookChatGenerationSettings,
  parseNotebookChatGenerationCommand,
  planNotebookChatGeneration,
  reviseNotebookChatGenerationAction,
  reviseNotebookChatGenerationMode,
  reviseNotebookChatGenerationPrompt,
  reviseNotebookChatGenerationSetting,
  type NotebookChatGenerationCommand,
} from '../../src/videobook/notebook-chat-generation'

function resultJson(result: Awaited<ReturnType<ToolDef['handler']>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined()
  return JSON.parse(result.content[0]!.text) as unknown
}

describe('notebook image generation commands', () => {
  let rootDir: string
  let books: BookManager

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-image-command-'))
    books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    await books.ready()
  })

  afterEach(async () => {
    await books.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  it('parses natural image requests without consuming configured-cell commands', () => {
    expect(parseNotebookImageGenerationCommand(
      'generate an image with @img-01',
    )).toEqual({
      prompt: 'Create a new image based on the connected reference image.',
      sourceReferences: ['img-01'],
    })
    expect(parseNotebookImageGenerationCommand(
      'Please make a picture of a moonlit garden using @img-01 and @img-02.',
    )).toEqual({
      prompt: 'a moonlit garden',
      sourceReferences: ['img-01', 'img-02'],
    })
    expect(parseNotebookImageGenerationCommand(
      'create an image of a sunset',
    )).toEqual({
      prompt: 'a sunset',
      sourceReferences: [],
    })
    expect(parseNotebookImageGenerationCommand(
      'generate cell @generate-image-01',
    )).toBeNull()
    expect(parseNotebookChatGenerationCommand(
      'create a video of falling stars',
    )).toMatchObject({
      cellType: 'generate_video',
      mediaKind: 'video',
      prompt: 'falling stars',
    })
    expect(parseNotebookChatGenerationCommand(
      'make a soundtrack of distant thunder',
    )).toMatchObject({
      cellType: 'generate_audio',
      mediaKind: 'audio',
      prompt: 'distant thunder',
    })
    expect(parseNotebookChatGenerationCommand(
      'gen vid with @vid-dance and @generate-image-01',
    )).toEqual({
      cellType: 'generate_video',
      mediaKind: 'video',
      prompt: 'Create new video media based on the connected references.',
      sourceReferences: ['vid-dance', 'generate-image-01'],
    })
  })

  it('rejects non-image and unfinished sources before materialization', () => {
    const image = {
      id: '01900000-0000-7000-8000-000000000001',
      type: 'image' as const,
      slug: 'img-ready',
      slot: { row: 0, column: 0 },
      outputArtifactId: '01900000-0000-7000-8000-000000000002',
    }
    const video = {
      id: '01900000-0000-7000-8000-000000000003',
      type: 'video' as const,
      slug: 'vid-source',
      slot: { row: 0, column: 1 },
      outputArtifactId: '01900000-0000-7000-8000-000000000004',
    }
    const pending = {
      id: '01900000-0000-7000-8000-000000000005',
      type: 'image' as const,
      slug: 'img-pending',
      slot: { row: 0, column: 2 },
    }
    const document = {
      id: '01900000-0000-7000-8000-000000000006',
      name: 'Sources',
      cells: [image, video, pending],
      edges: [],
      createdAt: new Date(0).toISOString(),
    } satisfies NotebookDocument

    expect(resolveNotebookImageGenerationSources(document, ['img-ready']))
      .toEqual([image])
    expect(() => resolveNotebookImageGenerationSources(document, ['vid-source']))
      .toThrow('@vid-source is not an image-producing cell')
    expect(() => resolveNotebookImageGenerationSources(document, ['img-pending']))
      .toThrow('@img-pending does not have an image output yet')
    expect(() => resolveNotebookImageGenerationSources(document, ['img-other']))
      .toThrow('@img-other was not found in this notebook')
  })

  it('creates a configured book cell, connects its image source, and produces a canonical plan', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      slug: 'connected-image-generation',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const notebookId = managed.value.engine.notebooks.list()[0]!.id
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const definition = byName.get(name)
      if (!definition) throw new Error(`Missing ${name}`)
      return resultJson(await withBookContext(
        { bookId: created.bookId, engine: managed.value.engine },
        () => definition.handler({ book_id: created.bookId, ...args }),
      ))
    }
    const artifact = await managed.value.engine.artifacts.create(
      'image',
      'Reference image',
    )
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    const written = await managed.value.engine.files.write(
      artifact.value.artifactId,
      'original.png',
      Buffer.from('reference image'),
    )
    expect(written.ok).toBe(true)
    if (!written.ok) return
    const source = await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'image',
        slug: 'img-01',
        slot: { row: 0, column: 2 },
        output_artifact_id: artifact.value.artifactId,
      },
    }) as { id: string }
    await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'prompt',
        slug: 'prompt-occupied',
        slot: { row: 1, column: 2 },
        prompt: 'Occupied',
      },
    })
    const current = managed.value.engine.notebooks.read(notebookId)
    expect(current.ok).toBe(true)
    if (!current.ok) return
    const actions = asNotebookGenerationActions(
      await invoke('list_notebook_actions', { cell_type: 'generate_image' }),
    )
    const command = parseNotebookChatGenerationCommand(
      'generate an image of neon rain with @img-01',
    )
    expect(command).not.toBeNull()
    if (!command) return
    const plannedCellId = '01900000-0000-7000-8000-000000000010'
    const draft = planNotebookChatGeneration({
      actions,
      cellId: plannedCellId,
      command,
      document: current.value,
      fallbackSlot: { row: 0, column: 0 },
    })
    expect(managed.value.engine.notebooks.read(notebookId)).toMatchObject({
      ok: true,
      value: {
        cells: expect.not.arrayContaining([
          expect.objectContaining({ id: plannedCellId }),
        ]),
      },
    })
    const connectedInputs = notebookChatGenerationConnectedInputs(draft, current.value)
    const configurableAction = {
      ...draft.action,
      id: 'generation.configurable-test',
      model: 'ConfigurableImageModel',
      tool: 'generate_configurable_image',
      controls: [{
        name: 'quality',
        label: 'Quality',
        kind: 'select' as const,
        valueType: 'string' as const,
        required: false,
        defaultValue: 'standard',
        options: ['standard', 'high'],
        description: 'Output quality',
      }],
    }
    const revisedAction = reviseNotebookChatGenerationAction(
      draft,
      configurableAction,
      connectedInputs,
    )
    const revisedMode = reviseNotebookChatGenerationMode(
      revisedAction,
      String(revisedAction.cell.inputs?.generationMode),
      connectedInputs,
    )
    const revisedSetting = reviseNotebookChatGenerationSetting(
      revisedMode,
      'quality',
      'high',
    )
    const revisedPrompt = reviseNotebookChatGenerationPrompt(
      revisedSetting,
      'cinematic neon rain',
    )
    expect(revisedPrompt).toMatchObject({
      action: { id: 'generation.configurable-test' },
      cell: {
        model: 'ConfigurableImageModel',
        prompt: 'cinematic neon rain',
        tool: 'generate_configurable_image',
      },
    })
    expect(notebookChatGenerationSettings(revisedPrompt)).toEqual({ quality: 'high' })
    const materialized = await materializeNotebookChatGeneration({
      bookId: created.bookId,
      callTool: invoke,
      document: current.value,
      draft,
    })
    expect(materialized.cellId).toBe(plannedCellId)
    const connected = managed.value.engine.notebooks.read(notebookId)
    expect(connected.ok).toBe(true)
    if (!connected.ok) return
    expect(connected.value.cells.find((cell) => cell.id === materialized.cellId))
      .toMatchObject({
        type: 'generate_image',
        slug: 'generate-image-01',
        slot: { row: 2, column: 2 },
        prompt: 'neon rain',
        provider: 'kie',
        model: 'NanoBananaProRequestSchema',
        operation: 'text_to_image',
        tool: 'generate_kie_nano_banana_pro_text_to_image',
      })
    expect(connected.value.edges).toContainEqual(expect.objectContaining({
      source: source.id,
      target: materialized.cellId,
      targetInput: 'image',
    }))

    const plan = await invoke('plan_notebook_generation', {
      notebook_id: notebookId,
      cell_id: materialized.cellId,
      source_surface: 'chat',
      actor: 'videobook-user',
      timeline_start_frame: 0,
    }) as {
      stages: Array<{
        input: { cell_id: string; generation_input: { image_slugs: string[] } }
        tool: string
      }>
    }
    expect(plan.stages[0]).toMatchObject({
      tool: 'run_notebook_cell',
      input: {
        cell_id: materialized.cellId,
        generation_input: { image_slugs: [`@${artifact.value.slug}`] },
      },
    })
  })

  it('translates cell aliases and persists distinct multi-reference inputs', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      slug: 'aliased-image-generation',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const notebookId = managed.value.engine.notebooks.list()[0]!.id
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const definition = byName.get(name)
      if (!definition) throw new Error(`Missing ${name}`)
      return resultJson(await withBookContext(
        { bookId: created.bookId, engine: managed.value.engine },
        () => definition.handler({ book_id: created.bookId, ...args }),
      ))
    }
    const firstArtifact = await managed.value.engine.artifacts.create(
      'image',
      'img ff',
    )
    const secondArtifact = await managed.value.engine.artifacts.create(
      'image',
      'img jamie',
    )
    expect(firstArtifact.ok && secondArtifact.ok).toBe(true)
    if (!firstArtifact.ok || !secondArtifact.ok) return
    const firstSource = await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'image',
        slug: 'img-ff2',
        slot: { row: 0, column: 0 },
        output_artifact_id: firstArtifact.value.artifactId,
      },
    }) as { id: string }
    const secondSource = await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'image',
        slug: 'img-jamie',
        slot: { row: 0, column: 1 },
        output_artifact_id: secondArtifact.value.artifactId,
      },
    }) as { id: string }
    const current = managed.value.engine.notebooks.read(notebookId)
    expect(current.ok).toBe(true)
    if (!current.ok) return
    const actions = asNotebookGenerationActions(
      await invoke('list_notebook_actions', { cell_type: 'generate_image' }),
    )
    const command = {
      cellType: 'generate_image',
      mediaKind: 'image',
      prompt: 'exactly frame as @img-ff2 but the man in the red hat is on the piano @img-jamie',
      sourceReferences: ['img-ff2', 'img-jamie'],
    } satisfies NotebookChatGenerationCommand
    const draft = planNotebookChatGeneration({
      actions,
      cellId: '01900000-0000-7000-8000-000000000020',
      command,
      document: current.value,
      fallbackSlot: { row: 1, column: 0 },
      preferredTool: 'generate_google_flow_nano_banana_pro_image',
    })
    expect(draft.connections).toEqual([
      { sourceCellId: firstSource.id, targetInput: 'image' },
      { sourceCellId: secondSource.id, targetInput: 'image_2' },
    ])
    expect(notebookChatGenerationConnectedInputs(draft, current.value)).toEqual([
      { kind: 'image', target: 'image' },
      { kind: 'image', target: 'image' },
    ])
    const preview = await invoke('preview_notebook_generation', {
      notebook_id: notebookId,
      cell_id: draft.cell.id,
      draft: {
        type: draft.cell.type,
        slug: draft.cell.slug,
        slot: draft.cell.slot,
        prompt: draft.cell.prompt,
        provider: draft.cell.provider,
        model: draft.cell.model,
        operation: draft.cell.operation,
        tool: draft.cell.tool,
        inputs: draft.cell.inputs,
      },
      connections: draft.connections.map((connection) => ({
        source_cell_id: connection.sourceCellId,
        target_input: connection.targetInput,
      })),
    }) as {
      payload: {
        prompt: string
        reference_1: string
        reference_2: string
      }
    }
    expect(preview.payload).toMatchObject({
      prompt: 'exactly frame as @reference_1 but the man in the red hat is on the piano @reference_2',
      reference_1: `@${firstArtifact.value.slug}`,
      reference_2: `@${secondArtifact.value.slug}`,
    })
    const materialized = await materializeNotebookChatGeneration({
      bookId: created.bookId,
      callTool: invoke,
      document: current.value,
      draft,
    })
    const connected = managed.value.engine.notebooks.read(notebookId)
    expect(connected.ok).toBe(true)
    if (!connected.ok) return
    expect(connected.value.edges.filter((edge) =>
      edge.target === materialized.cellId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: firstSource.id,
        targetInput: 'image',
      }),
      expect.objectContaining({
        source: secondSource.id,
        targetInput: 'image_2',
      }),
    ]))
  })
})
