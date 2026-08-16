import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'
import { materializeNotebookSpeakCommand } from '../../src/videobook/notebook-speak-command'

function resultJson(result: Awaited<ReturnType<ToolDef['handler']>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined()
  return JSON.parse(result.content[0]!.text) as unknown
}

describe('notebook speak commands', () => {
  let rootDir: string
  let books: BookManager

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-speak-command-'))
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

  it('materializes prompt and voice_id and returns the paired output cell', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'speak-materialize',
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
    const current = managed.value.engine.notebooks.read(notebookId)
    expect(current.ok).toBe(true)
    if (!current.ok) return
    const materialized = await materializeNotebookSpeakCommand({
      bookId: created.bookId,
      callTool: invoke,
      document: current.value,
      text: 'welcome back everyone',
      voiceId: 'EXAVITQu4vr4xnSDxMaL',
    })
    const notebook = managed.value.engine.notebooks.read(notebookId)
    expect(notebook.ok).toBe(true)
    if (!notebook.ok) return
    const tile = notebook.value.cells.find((cell) => cell.id === materialized.cellId)
    const output = notebook.value.cells.find((cell) =>
      cell.id === materialized.outputCellId)
    expect(tile).toMatchObject({
      type: 'generate_audio',
      label: 'Speak',
      prompt: 'welcome back everyone',
      inputs: {
        generationSettings: { voice_id: 'EXAVITQu4vr4xnSDxMaL' },
      },
    })
    expect(output).toMatchObject({
      id: materialized.outputCellId,
      type: 'audio',
      inputs: {
        mediaRole: 'generate-audio-output',
        producerCellId: materialized.cellId,
      },
    })
    expect(notebook.value.edges).toContainEqual(expect.objectContaining({
      source: materialized.cellId,
      target: materialized.outputCellId,
      targetInput: 'media',
    }))
  })

  it('rolls back both cells when materialize fails after create', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'speak-rollback',
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
    const current = managed.value.engine.notebooks.read(notebookId)
    expect(current.ok).toBe(true)
    if (!current.ok) return
    const beforeIds = new Set(current.value.cells.map((cell) => cell.id))
    await expect(materializeNotebookSpeakCommand({
      bookId: created.bookId,
      callTool: async (name, args) => {
        const result = await invoke(name, args)
        if (name === 'create_notebook_cell') {
          const createdCell = result as { id?: string; output_cell?: { id?: string } }
          expect(createdCell.id).toBeTruthy()
          expect(createdCell.output_cell?.id).toBeTruthy()
          return { ...createdCell, output_cell: undefined }
        }
        return result
      },
      document: current.value,
      text: 'this should roll back',
      voiceId: 'voice-rollback',
    })).rejects.toThrow('The server did not return the Speak output cell')
    const after = managed.value.engine.notebooks.read(notebookId)
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.value.cells.map((cell) => cell.id).sort()).toEqual(
      [...beforeIds].sort(),
    )
    expect(after.value.cells.some((cell) =>
      cell.type === 'generate_audio' || (
        cell.type === 'audio'
        && cell.inputs?.mediaRole === 'generate-audio-output'
      ))).toBe(false)
  })
})
