import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'
import { asNotebookGenerationActions } from '../../src/videobook/notebook-generation-actions'
import {
  notebookMentionAssets,
  restoreNotebookMentionAliases,
  restoreSelectedNotebookMentionAliases,
  type AssetMentionRecord,
} from '../../src/videobook/mention-suggestions'
import {
  materializeNotebookChatGeneration,
  notebookChatGenerationConnectedInputs,
  notebookChatGenerationReferences,
  notebookChatGenerationSettings,
  notebookChatGenerationSourceOptions,
  planNotebookChatGeneration,
  reviseNotebookChatGenerationAction,
  reviseNotebookChatGenerationMode,
  reviseNotebookChatGenerationPrompt,
  reviseNotebookChatGenerationSetting,
  reviseNotebookChatGenerationSources,
  validateNotebookChatGenerationPromptSources,
  type NotebookChatGenerationCommand,
} from '../../src/videobook/notebook-chat-generation'

function resultJson(result: Awaited<ReturnType<ToolDef['handler']>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined()
  return JSON.parse(result.content[0]!.text) as unknown
}

describe('notebook chat generation', () => {
  let rootDir: string
  let books: BookManager

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-chat-generation-'))
    books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    await books.ready()
  })

  afterEach(async () => {
    await books.close()
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('creates a configured book cell, connects its image source, and produces a canonical plan', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'connected-image-generation',
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
        label: 'Reference image',
        slot: { row: 0, column: 2 },
        output_artifact_id: artifact.value.artifactId,
      },
    }) as { id: string }
    await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'prompt',
        label: 'Occupied note',
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
    const command = {
      cellType: 'generate_image',
      mediaKind: 'image',
      prompt: 'neon rain',
      sourceReferences: ['a3'],
    } satisfies NotebookChatGenerationCommand
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
        slot: { row: 0, column: 3 },
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
        input: { cell_id: string; generation_input: { image_refs: string[] } }
        tool: string
      }>
    }
    expect(plan.stages[0]).toMatchObject({
      tool: 'run_notebook_cell',
      input: {
        cell_id: materialized.cellId,
        generation_input: {
          image_refs: [`@${artifact.value.artifactId}`],
        },
      },
    })
  })

  it('translates cell aliases and persists distinct multi-reference inputs', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'aliased-image-generation',
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
    const generatedSource = await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_image',
        label: 'Shared generated image',
        slot: { row: 1, column: 0 },
        output_artifact_id: firstArtifact.value.artifactId,
      },
    }) as { id: string }
    const firstSource = await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'image',
        label: 'img ff',
        slot: { row: 0, column: 1 },
        output_artifact_id: firstArtifact.value.artifactId,
      },
    }) as { id: string }
    const secondSource = await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'image',
        label: 'img jamie',
        slot: { row: 0, column: 2 },
        output_artifact_id: secondArtifact.value.artifactId,
      },
    }) as { id: string }
    const current = managed.value.engine.notebooks.read(notebookId)
    expect(current.ok).toBe(true)
    if (!current.ok) return
    const actions = asNotebookGenerationActions(
      await invoke('list_notebook_actions', { cell_type: 'generate_image' }),
    )
    const mentionRecords: AssetMentionRecord[] = [
      firstArtifact.value,
      secondArtifact.value,
    ].map((artifact) => ({
      id: artifact.artifactId,
      artifactId: artifact.artifactId,
      type: 'image',
      mediaUrl: null,
      thumbnailUrl: null,
      width: null,
      height: null,
      duration: null,
      status: 'ready',
    }))
    const mentionAssets = notebookMentionAssets(
      current.value.cells,
      mentionRecords,
    )
    const routedPrompt = `scene @${firstArtifact.value.artifactId}, character @${secondArtifact.value.artifactId}, fluffy kitten standing`
    const restoredPrompt = restoreNotebookMentionAliases(
      routedPrompt,
      mentionAssets,
    )
    const command = {
      cellType: 'generate_image',
      mediaKind: 'image',
      prompt: routedPrompt,
      sourceReferences: notebookChatGenerationReferences(restoredPrompt),
    } satisfies NotebookChatGenerationCommand
    let draft = planNotebookChatGeneration({
      actions,
      cellId: '01900000-0000-7000-8000-000000000020',
      command,
      document: current.value,
      fallbackSlot: { row: 1, column: 0 },
      preferredTool: 'generate_google_flow_nano_banana_pro_image',
    })
    const selectedCells = draft.sourceCellIds.flatMap((cellId) => {
      const cell = current.value.cells.find((candidate) => candidate.id === cellId)
      return cell ? [cell] : []
    })
    draft = reviseNotebookChatGenerationPrompt(
      draft,
      restoreSelectedNotebookMentionAliases(
        draft.cell.prompt ?? '',
        mentionAssets,
        selectedCells,
      ),
    )
    expect(draft.cell.prompt).toBe(
      'scene @a2, character @a3, fluffy kitten standing',
    )
    expect(draft.sourceCellIds).not.toContain(generatedSource.id)
    expect(draft.connections).toEqual([
      { sourceCellId: firstSource.id, targetInput: 'image' },
      { sourceCellId: secondSource.id, targetInput: 'image_2' },
    ])
    expect(notebookChatGenerationConnectedInputs(draft, current.value)).toEqual([
      { kind: 'image', target: 'image' },
      { kind: 'image', target: 'image' },
    ])
    expect(() => validateNotebookChatGenerationPromptSources(
      draft,
      current.value,
    )).not.toThrow()
    expect(() => validateNotebookChatGenerationPromptSources({
      ...draft,
      cell: { ...draft.cell, prompt: 'use @a3' },
      sourceCellIds: [firstSource.id],
    }, current.value)).toThrow('@a3 is referenced but not connected')
    expect(() => validateNotebookChatGenerationPromptSources({
      ...draft,
      cell: { ...draft.cell, prompt: 'use @z13' },
    }, current.value)).toThrow('Notebook cell @z13 is empty')
    expect(() => validateNotebookChatGenerationPromptSources({
      ...draft,
      cell: { ...draft.cell, prompt: 'use @missing-cell' },
    }, current.value)).not.toThrow()
    const preview = await invoke('preview_notebook_generation', {
      notebook_id: notebookId,
      cell_id: draft.cell.id,
      draft: {
        type: draft.cell.type,
        label: draft.cell.label,
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
      prompt: 'scene @reference_1, character @reference_2, fluffy kitten standing',
      reference_1: `@${firstArtifact.value.artifactId}`,
      reference_2: `@${secondArtifact.value.artifactId}`,
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
    expect(connected.value.cells.find((cell) =>
      cell.id === materialized.cellId)?.prompt).toBe(
      'scene @a2, character @a3, fluffy kitten standing',
    )
  })

  it('revises generation sources, reselecting actions and rejecting stale inputs', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'revise-generation-sources',
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
      'img one',
    )
    const secondArtifact = await managed.value.engine.artifacts.create(
      'image',
      'img two',
    )
    expect(firstArtifact.ok && secondArtifact.ok).toBe(true)
    if (!firstArtifact.ok || !secondArtifact.ok) return
    const firstSource = await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'image',
        label: 'img one',
        slot: { row: 0, column: 1 },
        output_artifact_id: firstArtifact.value.artifactId,
      },
    }) as { id: string }
    const secondSource = await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'image',
        label: 'img two',
        slot: { row: 0, column: 2 },
        output_artifact_id: secondArtifact.value.artifactId,
      },
    }) as { id: string }
    const noteCell = await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'prompt',
        label: 'note',
        slot: { row: 1, column: 1 },
        prompt: 'not media',
      },
    }) as { id: string }
    const pendingImageCell = await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'image',
        label: 'pending image',
        slot: { row: 1, column: 2 },
      },
    }) as { id: string }
    const current = managed.value.engine.notebooks.read(notebookId)
    expect(current.ok).toBe(true)
    if (!current.ok) return
    const actions = asNotebookGenerationActions(
      await invoke('list_notebook_actions', { cell_type: 'generate_image' }),
    )
    const draft = planNotebookChatGeneration({
      actions,
      cellId: '01900000-0000-7000-8000-000000000030',
      command: {
        cellType: 'generate_image',
        mediaKind: 'image',
        prompt: 'swap me',
        sourceReferences: ['a2'],
      },
      document: current.value,
      fallbackSlot: { row: 0, column: 0 },
      preferredTool: 'generate_google_flow_nano_banana_pro_image',
    })
    expect(draft.sourceCellIds).toEqual([firstSource.id])

    const options = notebookChatGenerationSourceOptions(
      current.value,
      draft.sourceCellIds,
    )
    expect(options.map((option) => option.cell.id)).toEqual([secondSource.id])
    expect(
      notebookChatGenerationSourceOptions(current.value)
        .map((option) => option.cell.id)
        .sort(),
    ).toEqual([firstSource.id, secondSource.id].sort())

    const expanded = reviseNotebookChatGenerationSources({
      actions,
      draft,
      document: current.value,
      sourceCellIds: [firstSource.id, secondSource.id],
    })
    expect(expanded.action.id).toBe(draft.action.id)
    expect(expanded.sourceCellIds).toEqual([firstSource.id, secondSource.id])
    expect(expanded.sourceAddresses).toEqual(['@a2', '@a3'])
    expect(expanded.connections).toEqual([
      { sourceCellId: firstSource.id, targetInput: 'image' },
      { sourceCellId: secondSource.id, targetInput: 'image_2' },
    ])
    expect(expanded.cell.slot).toEqual(draft.cell.slot)
    expect(expanded.cell.prompt).toBe('swap me')
    expect(notebookChatGenerationConnectedInputs(expanded, current.value))
      .toEqual([
        { kind: 'image', target: 'image' },
        { kind: 'image', target: 'image' },
      ])

    const deduped = reviseNotebookChatGenerationSources({
      actions,
      draft,
      document: current.value,
      sourceCellIds: [firstSource.id, firstSource.id],
    })
    expect(deduped.connections).toEqual([
      { sourceCellId: firstSource.id, targetInput: 'image' },
    ])

    const staleDraft = {
      ...draft,
      action: {
        ...draft.action,
        id: 'generation.stale-test',
        tool: 'generate_stale_image',
        inputContract: { modes: [] },
      },
    }
    const reselected = reviseNotebookChatGenerationSources({
      actions,
      draft: staleDraft,
      document: current.value,
      sourceCellIds: [firstSource.id],
    })
    expect(reselected.action.id).not.toBe('generation.stale-test')
    expect(reselected.cell.tool).toBe(reselected.action.tool)

    const textOnlyAction = {
      ...draft.action,
      id: 'generation.text-only-test',
      tool: 'generate_text_only_image',
      inputContract: { modes: [{ id: 't2i', slots: [], requiredGroups: [] }] },
    }
    const cleared = reviseNotebookChatGenerationSources({
      actions: [textOnlyAction],
      draft: { ...draft, action: textOnlyAction },
      document: current.value,
      sourceCellIds: [],
    })
    expect(cleared.sourceCellIds).toEqual([])
    expect(cleared.sourceAddresses).toEqual([])
    expect(cleared.connections).toEqual([])
    expect(cleared.cell.inputs?.generationMode).toBe('t2i')

    expect(() => reviseNotebookChatGenerationSources({
      actions,
      draft,
      document: current.value,
      sourceCellIds: ['missing-cell-id'],
    })).toThrow('The selected source cell is no longer available')
    expect(() => reviseNotebookChatGenerationSources({
      actions,
      draft,
      document: current.value,
      sourceCellIds: [noteCell.id],
    })).toThrow('is not a media-producing cell')
    expect(() => reviseNotebookChatGenerationSources({
      actions,
      draft,
      document: current.value,
      sourceCellIds: [pendingImageCell.id],
    })).toThrow('does not have media output yet')
    expect(() => reviseNotebookChatGenerationSources({
      actions: [],
      draft: staleDraft,
      document: current.value,
      sourceCellIds: [firstSource.id],
    })).toThrow('No available image generation action accepts these references')
  })
})
