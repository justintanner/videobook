import {
  notebookGridTag,
  parseNotebookGridAddress,
} from 'videobook-engine/notebook-grid'
import {
  normalizeNotebookReference,
  scanNotebookMentions,
} from 'videobook-engine/notebook-mentions'
import type {
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
} from 'videobook-engine'

export function notebookCellAtSlot(
  document: NotebookDocument,
  slot: NotebookGridSlot,
): NotebookCell | undefined {
  return document.cells.find((cell) =>
    cell.slot.row === slot.row && cell.slot.column === slot.column)
}

export function notebookCellTag(cell: NotebookCell): string {
  return notebookGridTag(cell.slot)
}

export function notebookReferences(input: string): string[] {
  const references = scanNotebookMentions(input)
    .map((mention) => mention.reference)
  return [...new Set(references)]
}

export function resolveNotebookCellReference(
  document: NotebookDocument,
  sourceReference: string,
): NotebookCell {
  const reference = normalizeNotebookReference(sourceReference)
  const slot = parseNotebookGridAddress(reference)
  if (slot) {
    const cell = notebookCellAtSlot(document, slot)
    if (!cell) throw new Error(`Notebook cell ${notebookGridTag(slot)} is empty`)
    return cell
  }
  const exact = document.cells.find((cell) =>
    cell.id.toLowerCase() === reference)
  const prefixMatches = exact
    ? []
    : document.cells.filter((cell) =>
        cell.id.toLowerCase().startsWith(reference))
  if (prefixMatches.length > 1) {
    throw new Error(`Cell reference @${reference} is ambiguous`)
  }
  const cell = exact ?? prefixMatches[0]
  if (!cell) throw new Error(`Notebook cell @${reference} was not found`)
  return cell
}
