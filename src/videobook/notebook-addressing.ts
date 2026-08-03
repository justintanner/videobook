import {
  notebookGridTag,
  parseNotebookGridAddress,
} from 'videobook-engine/notebook-grid'
import type {
  NotebookCell,
  NotebookDocument,
  NotebookGridSlot,
} from 'videobook-engine'

const NOTEBOOK_REFERENCE_PATTERN =
  /@([a-z](?:1[0-3]|[1-9])|[a-z0-9]+(?:-[a-z0-9]+)+)/giu

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
  const references = [...input.matchAll(NOTEBOOK_REFERENCE_PATTERN)]
    .map((match) => match[1]!.toLowerCase())
  return [...new Set(references)]
}

export function resolveNotebookCellReference(
  document: NotebookDocument,
  sourceReference: string,
): NotebookCell {
  const reference = sourceReference.replace(/^@/u, '').toLowerCase()
  const slot = parseNotebookGridAddress(reference)
  if (slot) {
    const cell = notebookCellAtSlot(document, slot)
    if (!cell) throw new Error(`Notebook cell ${notebookGridTag(slot)} is empty`)
    return cell
  }
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
  const cell = exact ?? prefixMatches[0]
  if (!cell) throw new Error(`Notebook cell @${reference} was not found`)
  return cell
}
