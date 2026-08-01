import type {
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
} from 'videobook-engine'
import {
  initialGenerationSelection,
  type NotebookGenerationAction,
} from './notebook-generation-actions'
import { nextNotebookCellSlug } from './notebook-download'

export type NotebookImageGenerationCommand = {
  prompt: string
  sourceReferences: string[]
}

export type NotebookImageGenerationCommandRun = {
  cellId: string
  cellSlug: string
  sourceCellIds: string[]
  sourceSlugs: string[]
}

type NotebookToolCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>

const imageSourceTypes = new Set<NotebookCell['type']>([
  'image',
  'generate_image',
])

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function uniqueReferences(input: string): string[] {
  const references = [...input.matchAll(
    /@([a-z0-9]+(?:-[a-z0-9]+)+)/giu,
  )].map((match) => match[1]!.toLowerCase())
  return [...new Set(references)]
}

function imagePrompt(tail: string, referenceCount: number): string {
  const withoutReferences = tail
    .replace(
      /(?:\b(?:with|using|from|based\s+on)\s+)?@[a-z0-9]+(?:-[a-z0-9]+)+/giu,
      ' ',
    )
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^(?:of|showing)\s+/iu, '')
    .replace(/^(?:and|but)\s+/iu, '')
    .replace(/\s+(?:and|with|using|from|based\s+on)$/iu, '')
    .replace(/^[,;:\s]+|[,;:\s]+$/gu, '')
  if (withoutReferences) return withoutReferences
  return referenceCount > 0
    ? 'Create a new image based on the connected reference image.'
    : 'Create a new image.'
}

function firstEmptyRowBelow(
  cells: readonly NotebookCell[],
  source: NotebookGridSlot,
): NotebookGridSlot {
  const occupied = new Set(cells.map((cell) =>
    `${cell.slot.row}:${cell.slot.column}`))
  for (let row = source.row + 1; ; row += 1) {
    if (!occupied.has(`${row}:${source.column}`)) {
      return { row, column: source.column }
    }
  }
}

export function parseNotebookImageGenerationCommand(
  input: string,
): NotebookImageGenerationCommand | null {
  const match = input.trim().match(
    /^(?:please\s+)?(?:generate|create|make)\s+(?:me\s+)?(?:an?\s+)?(?:image|photo|picture)\b([\s\S]*?)(?:\s+please)?[.!]?$/iu,
  )
  if (!match) return null
  const sourceReferences = uniqueReferences(match[1] ?? '')
  return {
    prompt: imagePrompt(match[1] ?? '', sourceReferences.length),
    sourceReferences,
  }
}

export function resolveNotebookImageGenerationSources(
  document: NotebookDocument,
  sourceReferences: readonly string[],
): NotebookCell[] {
  return sourceReferences.map((sourceReference) => {
    const reference = sourceReference.replace(/^@/u, '').toLowerCase()
    const exact = document.cells.find((cell) =>
      cell.slug.toLowerCase() === reference
      || cell.id.toLowerCase() === reference)
    const prefixMatches = exact
      ? []
      : document.cells.filter((cell) =>
          cell.id.toLowerCase().startsWith(reference))
    if (prefixMatches.length > 1) {
      throw new Error(`Cell reference @${reference} is ambiguous`)
    }
    const source = exact ?? prefixMatches[0]
    if (!source) throw new Error(`Image cell @${reference} was not found in this notebook`)
    if (!imageSourceTypes.has(source.type)) {
      throw new Error(`@${source.slug} is not an image-producing cell`)
    }
    if (!source.outputArtifactId) {
      throw new Error(`@${source.slug} does not have an image output yet`)
    }
    return source
  })
}

export async function materializeNotebookImageGenerationCommand(input: {
  actions: readonly NotebookGenerationAction[]
  bookId: string
  callTool: NotebookToolCall
  command: NotebookImageGenerationCommand
  document: NotebookDocument
  fallbackSlot: NotebookGridSlot
}): Promise<NotebookImageGenerationCommandRun> {
  const sources = resolveNotebookImageGenerationSources(
    input.document,
    input.command.sourceReferences,
  )
  const selection = initialGenerationSelection(
    { type: 'generate_image' },
    input.actions,
    sources.map(() => ({ kind: 'image', target: 'image' })),
  )
  if (!selection) {
    throw new Error('No available image generation action accepts these references')
  }
  const slug = nextNotebookCellSlug('generate_image', input.document.cells)
  const slot = sources[0]
    ? firstEmptyRowBelow(input.document.cells, sources[0].slot)
    : input.fallbackSlot
  let cellId: string | null = null
  try {
    const created = objectValue(await input.callTool('create_notebook_cell', {
      book_id: input.bookId,
      notebook_id: input.document.id,
      cell: {
        type: 'generate_image',
        slug,
        slot,
        prompt: input.command.prompt,
        ...selection,
      },
    }))
    cellId = stringValue(created?.id)
    const cellSlug = stringValue(created?.slug) ?? slug
    if (!cellId) {
      throw new Error('The server did not return the Generate Image cell')
    }
    for (const [index, source] of sources.entries()) {
      await input.callTool('connect_notebook_cells', {
        book_id: input.bookId,
        notebook_id: input.document.id,
        source_cell_id: source.id,
        target_cell_id: cellId,
        target_input: index === 0 ? 'image' : `image_${index + 1}`,
      })
    }
    return {
      cellId,
      cellSlug,
      sourceCellIds: sources.map((source) => source.id),
      sourceSlugs: sources.map((source) => source.slug),
    }
  } catch (error) {
    if (cellId) {
      await input.callTool('delete_notebook_cell', {
        book_id: input.bookId,
        notebook_id: input.document.id,
        cell_id: cellId,
      }).catch(() => undefined)
    }
    throw error
  }
}
