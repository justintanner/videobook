import { notebookGridTag } from 'videobook-engine/notebook-grid'
import { nextNotebookHorizontalGenerationSlot } from './notebook-grid'
import type { NotebookDocument } from 'videobook-engine'

export type NotebookSpeakCommandRun = {
  cellId: string
  cellAddress: string
  outputCellId: string
}

type NotebookToolCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

async function deleteNotebookCell(
  callTool: NotebookToolCall,
  bookId: string,
  notebookId: string,
  cellId: string,
): Promise<void> {
  await callTool('delete_notebook_cell', {
    book_id: bookId,
    notebook_id: notebookId,
    cell_id: cellId,
  }).catch(() => undefined)
}

function cellIdFromUnknown(value: unknown): string | null {
  const cell = objectValue(value)
  return stringValue(cell?.id)
}

async function discoverSpeakOutputCellId(
  callTool: NotebookToolCall,
  bookId: string,
  notebookId: string,
  producerCellId: string,
): Promise<string | null> {
  const notebook = objectValue(await callTool('get_notebook', {
    book_id: bookId,
    notebook_id: notebookId,
  }).catch(() => null))
  if (!notebook) return null
  const cells = Array.isArray(notebook.cells) ? notebook.cells : []
  const edges = Array.isArray(notebook.edges) ? notebook.edges : []
  for (const entry of edges) {
    const edge = objectValue(entry)
    const source = stringValue(edge?.source)
    const target = stringValue(edge?.target)
    const targetInput = stringValue(edge?.targetInput ?? edge?.target_input)
    if (source === producerCellId && targetInput === 'media' && target) {
      return target
    }
  }
  for (const entry of cells) {
    const cell = objectValue(entry)
    if (stringValue(cell?.type) !== 'audio') continue
    const inputs = objectValue(cell?.inputs)
    // Only ever roll back the output that names THIS producer; matching on
    // mediaRole alone could target another speak pair's landed audio cell.
    if (stringValue(inputs?.producerCellId) === producerCellId) {
      return cellIdFromUnknown(cell)
    }
  }
  return null
}

export async function materializeNotebookSpeakCommand(input: {
  bookId: string
  callTool: NotebookToolCall
  document: NotebookDocument
  text: string
  voiceId: string
  expectedRevision?: string
}): Promise<NotebookSpeakCommandRun> {
  const prompt = input.text.trim()
  const voiceId = input.voiceId.trim()
  if (!prompt) throw new Error('Speak text is required')
  if (!voiceId) throw new Error('Speak voice is required')
  const slot = nextNotebookHorizontalGenerationSlot(input.document.cells)
  let cellId: string | null = null
  let outputCellId: string | null = null
  try {
    const created = objectValue(await input.callTool('create_notebook_cell', {
      book_id: input.bookId,
      notebook_id: input.document.id,
      ...(input.expectedRevision
        ? { expected_revision: input.expectedRevision }
        : {}),
      cell: {
        type: 'generate_audio',
        label: 'Speak',
        slot,
        prompt,
        inputs: {
          generationSettings: { voice_id: voiceId },
        },
      },
    }))
    cellId = stringValue(created?.id)
    outputCellId = stringValue(objectValue(created?.output_cell)?.id)
    const cellAddress = stringValue(created?.address) ?? notebookGridTag(slot)
    if (!cellId) {
      throw new Error('The server did not return the Speak cell')
    }
    if (!outputCellId) {
      throw new Error('The server did not return the Speak output cell')
    }
    return { cellId, cellAddress, outputCellId }
  } catch (error) {
    let rollbackOutputId = outputCellId
    if (cellId && !rollbackOutputId) {
      rollbackOutputId = await discoverSpeakOutputCellId(
        input.callTool,
        input.bookId,
        input.document.id,
        cellId,
      )
    }
    if (rollbackOutputId) {
      await deleteNotebookCell(
        input.callTool,
        input.bookId,
        input.document.id,
        rollbackOutputId,
      )
    }
    if (cellId) {
      await deleteNotebookCell(
        input.callTool,
        input.bookId,
        input.document.id,
        cellId,
      )
    }
    throw error
  }
}
