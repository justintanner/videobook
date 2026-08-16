import { notebookGridTag } from 'videobook-engine/notebook-grid'
import { nextNotebookHorizontalGenerationSlot } from './notebook-grid'
import type { NotebookDocument, NotebookGridSlot } from 'videobook-engine'
import { nonBlankStringValue, recordValue } from './value-decoders'

export type NotebookSpeakCommandRun = {
  cellId: string
  cellAddress: string
  outputCellId: string
}

type NotebookToolCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>

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
  const cell = recordValue(value)
  return nonBlankStringValue(cell?.id)
}

async function discoverSpeakOutputCellId(
  callTool: NotebookToolCall,
  bookId: string,
  notebookId: string,
  producerCellId: string,
): Promise<string | null> {
  const notebook = recordValue(await callTool('get_notebook', {
    book_id: bookId,
    notebook_id: notebookId,
  }).catch(() => null))
  if (!notebook) return null
  const cells = Array.isArray(notebook.cells) ? notebook.cells : []
  const edges = Array.isArray(notebook.edges) ? notebook.edges : []
  for (const entry of edges) {
    const edge = recordValue(entry)
    const source = nonBlankStringValue(edge?.source)
    const target = nonBlankStringValue(edge?.target)
    const targetInput = nonBlankStringValue(edge?.targetInput ?? edge?.target_input)
    if (source === producerCellId && targetInput === 'media' && target) {
      return target
    }
  }
  for (const entry of cells) {
    const cell = recordValue(entry)
    if (nonBlankStringValue(cell?.type) !== 'audio') continue
    const inputs = recordValue(cell?.inputs)
    // Only ever roll back the output that names THIS producer; matching on
    // mediaRole alone could target another speak pair's landed audio cell.
    if (nonBlankStringValue(inputs?.producerCellId) === producerCellId) {
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
  lastWorkSlot?: NotebookGridSlot | null
}): Promise<NotebookSpeakCommandRun> {
  const prompt = input.text.trim()
  const voiceId = input.voiceId.trim()
  if (!prompt) throw new Error('Speak text is required')
  if (!voiceId) throw new Error('Speak voice is required')
  const slot = nextNotebookHorizontalGenerationSlot(
    input.document.cells,
    [],
    input.lastWorkSlot ?? null,
  )
  let cellId: string | null = null
  let outputCellId: string | null = null
  try {
    const created = recordValue(await input.callTool('create_notebook_cell', {
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
    cellId = nonBlankStringValue(created?.id)
    outputCellId = nonBlankStringValue(recordValue(created?.output_cell)?.id)
    const cellAddress = nonBlankStringValue(created?.address) ?? notebookGridTag(slot)
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
