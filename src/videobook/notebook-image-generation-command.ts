import {
  firstEmptyNotebookGridSlot,
  notebookGridTag,
} from 'videobook-engine/notebook-grid'
import type {
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
} from 'videobook-engine'
import {
  initialGenerationSelection,
  type NotebookGenerationAction,
} from './notebook-generation-actions'
import {
  notebookCellTag,
  notebookReferences,
  resolveNotebookCellReference,
} from './notebook-addressing'

// Accepts a grid address (@a3) or a cell id / id prefix.
const NOTEBOOK_IMAGE_REFERENCE_SOURCE = '[a-z0-9][a-z0-9-]*'

export type NotebookImageGenerationCommand = {
  prompt: string
  sourceReferences: string[]
}

export type NotebookImageGenerationCommandRun = {
  cellId: string
  cellAddress: string
  sourceCellIds: string[]
  sourceAddresses: string[]
}

type NotebookToolCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>

const imageSourceTypes = new Set<NotebookCell['type']>([
  'image',
  'generate_image',
])

const IMAGE_PROMPT_REFERENCE_PATTERN = new RegExp(
  `(?:\\b(?:with|using|from|based\\s+on)\\s+)?@${NOTEBOOK_IMAGE_REFERENCE_SOURCE}(?![\\w-])`,
  'giu',
)

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function uniqueReferences(input: string): string[] {
  return notebookReferences(input)
}

function imagePrompt(tail: string, referenceCount: number): string {
  const withoutReferences = tail
    .replace(IMAGE_PROMPT_REFERENCE_PATTERN, ' ')
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
    const source = resolveNotebookCellReference(document, sourceReference)
    if (!imageSourceTypes.has(source.type)) {
      throw new Error(`${notebookCellTag(source)} is not an image-producing cell`)
    }
    if (!source.outputArtifactId) {
      throw new Error(`${notebookCellTag(source)} does not have an image output yet`)
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
  expectedRevision?: string
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
  const slot = sources[0]
    ? firstEmptyNotebookGridSlot(input.document.cells.map((cell) => cell.slot))
    : input.fallbackSlot
  let cellId: string | null = null
  try {
    const created = objectValue(await input.callTool('create_notebook_cell', {
      book_id: input.bookId,
      notebook_id: input.document.id,
      ...(input.expectedRevision
        ? { expected_revision: input.expectedRevision }
        : {}),
      cell: {
        type: 'generate_image',
        slot,
        prompt: input.command.prompt,
        ...selection,
      },
    }))
    cellId = stringValue(created?.id)
    const cellAddress = stringValue(created?.address) ?? notebookGridTag(slot)
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
      cellAddress,
      sourceCellIds: sources.map((source) => source.id),
      sourceAddresses: sources.map((source) => notebookGridTag(source.slot)),
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
